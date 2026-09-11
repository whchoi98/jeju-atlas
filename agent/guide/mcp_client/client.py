import os
import time
import asyncio
import logging
from mcp.client.streamable_http import streamablehttp_client
from strands.tools.mcp.mcp_client import MCPClient

logger = logging.getLogger(__name__)

from mcp_proxy_for_aws.client import aws_iam_streamablehttp_client

# The Atlas Gateway is an HTTP gateway (no protocolType) with an *AgentCore Runtime target*
# (agentcore 0.28.1 `add gateway-target --type http-runtime`). Such gateways forward traffic per target with
# path-based routing — <gateway>/<targetName>/invocations — and do NOT aggregate tools at /mcp (0 tools there).
# See infra/agentcore.yaml and the HTTP Runtime target contract:
# https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-http-runtime.html
GATEWAY_URL_ENV = "AGENTCORE_GATEWAY_JEJUATLASTOOLS_URL"
GATEWAY_RUNTIME_TARGETS: dict[str, str] = {"JejuAtlasTools": "jejuatlastools"}  # target name -> tool-name prefix


def gateway_target_url(target_name: str) -> str | None:
    """Build the MCP endpoint of an AgentCore Runtime target from the injected gateway URL.

    Strip trailing slashes BEFORE looking for the `/mcp` suffix: `https://gw/mcp/` does not end with
    `/mcp`, so the old order kept the whole base and produced `https://gw/mcp/<target>/invocations`.
    The injected form is fixed today, but the symptom of getting it wrong ("the model has no tools at
    all") is expensive to diagnose.
    """
    url = os.environ.get(GATEWAY_URL_ENV)
    if not url:
        return None
    base = url.strip().rstrip("/")
    if base.endswith("/mcp"):
        base = base[: -len("/mcp")]
    return f"{base.rstrip('/')}/{target_name}/invocations"


def get_atlas_gateway_mcp_client(target_name: str = "JejuAtlasTools", prefix: str = "jejuatlastools") -> MCPClient | None:
    """Returns an MCP Client (SigV4) connected to the Atlas Gateway Runtime target."""
    url = gateway_target_url(target_name)
    if not url:
        logger.warning("%s not set — Atlas Gateway tools unavailable", GATEWAY_URL_ENV)
        return None
    region = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION"))
    return MCPClient(lambda: aws_iam_streamablehttp_client(url, aws_service="bedrock-agentcore", aws_region=region), prefix=prefix)


def get_all_gateway_mcp_clients() -> list[MCPClient]:
    """Returns MCP clients for all configured gateway runtime targets."""
    clients = []
    for target_name, prefix in GATEWAY_RUNTIME_TARGETS.items():
        client = get_atlas_gateway_mcp_client(target_name, prefix)
        if client:
            clients.append(client)
    return clients


WARM_CONSUMER_ID = "jeju-atlas-process"


def warm_tools(clients: list[MCPClient], *, consumer_id: str = WARM_CONSUMER_ID) -> dict[str, int]:
    """Open each client's Gateway MCP session and load its tool list right now, at process boot,
    instead of lazily on the first Agent's first turn — that first-ever session bootstrap measured
    ~3.5s (PLAN.md 08 기준선).

    `consumer_id` is pinned PERMANENTLY on every client that warms SUCCESSFULLY (never paired with a
    matching `remove_consumer`): a cached Agent's `__del__` (LRU eviction or process shutdown) calls
    `remove_consumer` for its own per-Agent consumer id, and `MCPClient.remove_consumer` only tears the
    session down once the consumer *set* becomes empty. With this extra consumer always present, that
    set never reaches zero, so the shared session set up here survives every individual Agent's
    lifecycle and the next Agent to build tools reuses it instead of paying the bootstrap again.

    A FAILED warm gives the pin back (`remove_consumer`), because that same "the set never reaches
    zero" property would otherwise make one transient failure permanent: `MCPClient.load_tools()` sets
    `_loaded_tools = []` *before* paging `tools/list`, so a failure there (JejuAtlasTools' own cold start
    racing this container's boot) leaves an EMPTY tool list cached behind an already-open session, and
    only teardown — which needs the consumer set to empty out — clears it. Holding the pin through that
    failure would freeze the whole container at "0 tools" for its lifetime; releasing it resets the
    client (`stop()` → `_loaded_tools = None`) so the first real Agent retries the session and the tool
    list exactly as it would have without any warming. The pin is deliberately NOT re-added afterwards:
    a re-added pin would recreate the same trap one Agent later (that Agent's own consumer leaves on
    `__del__`, the pin stays, nothing resets), and losing the warm-session optimization is the cheaper
    failure — the next successful `load_tools()` still serves every Agent alive at that moment.

    Best-effort: warming is a startup optimization, not a correctness requirement. Any exception
    (a client mid-add_consumer, a `load_tools()` connection failure, a `remove_consumer` whose teardown
    raises) is swallowed and logged as a warning per client so one bad client cannot stop the others
    from warming, and — more importantly — cannot block or crash module import; the first real Agent
    still boots and loads tools normally, just without the head start.

    Must not be called from inside a running event loop: `asyncio.run()` raises if one is already
    active, and at module-import time (where this is meant to run) there never is one. Defensively,
    if a loop IS already running, `add_consumer` still runs (it is synchronous and loop-independent —
    the permanent pin should not depend on timing), but the eager `load_tools()` call is skipped with
    a warning; the client is left to warm lazily on first real use instead.

    Returns `{"<prefix>": n_tools}` for every client warmed successfully (silently omits clients that
    failed or were skipped).
    """
    warmed: dict[str, int] = {}
    if not clients:
        return warmed

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        loop_already_running = False
    else:
        loop_already_running = True
        logger.warning(
            "warm_tools: called from inside a running event loop — pinning %d consumer(s) but "
            "skipping eager load_tools() (session(s) will warm lazily on first real use)",
            len(clients),
        )

    start = time.monotonic()
    for i, client in enumerate(clients):
        prefix = getattr(client, "_prefix", None) or f"client_{i}"
        try:
            client.add_consumer(consumer_id)
        except Exception as exc:
            logger.warning("warm_tools: add_consumer failed for %s type=%s — not warming it", prefix, type(exc).__name__)
            continue
        if loop_already_running:
            continue
        try:
            tools = asyncio.run(client.load_tools())
        except Exception as exc:
            logger.warning(
                "warm_tools: load_tools failed for %s type=%s — releasing the pin so the next Agent retries",
                prefix, type(exc).__name__,
            )
            try:
                client.remove_consumer(consumer_id)   # last consumer -> stop() -> _loaded_tools = None
            except Exception as exc:
                logger.warning("warm_tools: releasing the pin failed for %s type=%s", prefix, type(exc).__name__)
            continue
        warmed[prefix] = len(tools)
    elapsed_ms = (time.monotonic() - start) * 1000
    logger.info("warm_tools: warmed %s in %.0fms", warmed, elapsed_ms)
    return warmed
