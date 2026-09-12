"""JejuAtlasGuide — Strands agent on AgentCore Runtime with SSE streaming and MapResponseV2 structured output.

Payload: {"prompt", "user_id"(actor), "conversation_id"(= runtimeSessionId), "locale", "stream"}.
stream=true → SSE events (status/token/heartbeat/map/error/done, see atlas_agent.streaming);
stream absent/false → MapResponseV2 JSON (keeps `agentcore invoke --json` working).
Every failure path keeps the shape the caller asked for: a `stream=true` request always gets
error → map → done SSE events, never a bare error dict the BFF's SSE parser cannot read.

For the common intents the turn starts with a prefetch (plan 10): `_prefetch` runs the obvious tool calls
on the shared Gateway session BEFORE the model is asked (awaited inside `run_turn`, right after the turn's
first status event, so the typing indicator is not delayed) and `run_turn` seeds the results into the
conversation, so the model is called once (write the answer) instead of twice (choose a tool, then write).
`ATLAS_PREFETCH=off` disables it; every failure degrades to the ordinary tool loop.

A second payload shape pre-warms a conversation with no model call (perf-agent plan 09 Task 1):
{"warm": true, "user_id", "conversation_id"} → builds the session's cached Agent (Memory session
manager included) and returns {"warmed": true, "tools": int, "ms": int} (stream=true: a single SSE
`done` event). See atlas_agent.payload.parse_warm_payload for the no-`user_id` fallback.
"""
import logging
import os
import time
from collections import OrderedDict
from collections.abc import AsyncIterator
from functools import partial

from atlas_agent.privacy import configure_privacy, safe_tool_name

configure_privacy()

from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent
from strands.agent.conversation_manager import SlidingWindowConversationManager

from mcp_client.client import get_all_gateway_mcp_clients, warm_tools
from memory.session import get_memory_session_manager, redact_transient_lookup_message
from model.load import load_model
from atlas_agent import routing
from atlas_agent.payload import MAX_PROMPT_CHARS, is_warm_payload, parse_payload, parse_warm_payload, prompt_for_locale
from atlas_agent.prefetch import (
    PREFETCH_ENV, PrefetchResult, execute_prefetch, plan_prefetch, prefetch_enabled,
    grounding_prefetch, covered_discovery_call, GuideGroundingPolicy,
)
from atlas_agent.prompts import load_system_prompt
from atlas_agent.streaming import TURN_TIMEOUT_S, Prefetched, make_formatter, run_turn
from atlas_agent.tool_budget import ToolBudget
from atlas_contracts import MapResponseV2

app = BedrockAgentCoreApp()
configure_privacy()  # Also protects providers initialized by the runtime SDK.
log = logging.getLogger("atlas_agent.runtime")
log.setLevel(app.logger.level)
log.propagate = app.logger.propagate
for handler in app.logger.handlers:
    if handler not in log.handlers:
        log.addHandler(handler)

# All tools come from Atlas Gateway (JejuAtlasTools MCP runtime target); no inline function tools.
tools = [c for c in get_all_gateway_mcp_clients() if c]
# Warm the shared Gateway MCP session(s) NOW, before any Agent exists, with a permanent consumer so no
# Agent's __del__/LRU eviction can ever close it (perf-routing plan 08 Task 5 — see warm_tools docstring).
# A client whose warm fails is handed back unpinned, so the first real Agent retries it from scratch.
# Every cached Agent below shares this same `tools` list, so warming happens exactly once per process.
WARM = warm_tools(tools)
log.info("warmed Gateway MCP session(s) at boot: %s", WARM)
STRUCTURED_MODES = ("derive", "single", "two_stage")  # env-selectable; "derive" is the measured default
MAX_CACHED_AGENTS = 32
TIMEOUT_RANGE_S = (1.0, 300.0)
BUSY_GRACE_S = 5.0
BUSY_CODE = "conversation_busy"
BUSY_MESSAGE = "같은 대화의 이전 요청이 아직 처리 중입니다. 잠시 후 다시 시도해 주세요."
PUBLIC_PAYLOAD_REASONS = frozenset({
    "payload must be a JSON object", "prompt must be a non-empty string",
    f"prompt exceeds {MAX_PROMPT_CHARS} characters",
})


def _structured_mode(raw: str | None) -> str:
    """Whitelist ATLAS_STRUCTURED_MODE — a typo must not silently disable the map.

    Default "derive" (perf-routing plan 08 Task 3): the map is derived from the turn's tool results, which
    removes the structured-output model round trip ("single") measured at ~5.1 s of the turn.
    An unrecognised value used to flow into run_turn unchecked: none of the mode branches would fire, so
    EVERY turn degraded to parsing the streamed prose — markers/route almost always empty, with no
    warning anywhere. This value is set by hand for the latency spikes, which makes a typo the likely case.
    """
    mode = (raw or "derive").strip()
    if mode in STRUCTURED_MODES:
        return mode
    log.warning("invalid ATLAS_STRUCTURED_MODE — using 'derive'")
    return "derive"


def _turn_timeout(raw: str | None, default: float = TURN_TIMEOUT_S) -> float:
    """Parse ATLAS_TURN_TIMEOUT_S defensively — a bad value must not crash the container at import.

    `float(os.environ[...])` at module scope turns one typo in the runtime env into a boot crash loop
    whose logs carry no hint about which variable is at fault.
    """
    if raw is None or not str(raw).strip():
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        log.warning("invalid ATLAS_TURN_TIMEOUT_S — using %.1fs", default)
        return default
    low, high = TIMEOUT_RANGE_S
    if not low <= value <= high:  # also rejects nan/inf, whose comparisons are all False
        log.warning("ATLAS_TURN_TIMEOUT_S outside allowed range — using %.1fs", default)
        return default
    return value


STRUCTURED_MODE = _structured_mode(os.environ.get("ATLAS_STRUCTURED_MODE"))
# Mode-aware: the "derive" prompt never tells the model to build MapResponseV2 itself (see
# atlas_agent.prompts) — it must be loaded AFTER STRUCTURED_MODE is known, not at module import time.
SYSTEM_PROMPT = load_system_prompt(STRUCTURED_MODE)
TURN_TIMEOUT = _turn_timeout(os.environ.get("ATLAS_TURN_TIMEOUT_S"))
FORMATTER = make_formatter(load_model, MapResponseV2) if STRUCTURED_MODE == "two_stage" else None

# Model router (PLAN.md 8장 #8 / perf-routing plan 08): "auto" classifies each prompt (routing.classify),
# "fast"/"deep" pin every turn to one model regardless of content — an operator escape hatch, e.g. to force
# deep everywhere while validating the router itself.
ROUTING_MODE = routing.routing_mode(os.environ.get("ATLAS_MODEL_ROUTING"))
MODEL_FAST = os.environ.get("ATLAS_MODEL_FAST") or routing.MODEL_FAST_DEFAULT
MODEL_DEEP = os.environ.get("ATLAS_MODEL_DEEP") or routing.MODEL_DEEP_DEFAULT
# Extended thinking for itinerary/plan intents only (routing.classify == "deep" — the intent classifier, independent of
# ATLAS_MODEL_ROUTING which the operator pins to Sonnet 5 for every turn). Ordinary turns keep ATLAS_THINKING
# (disabled) for latency; plan turns get ATLAS_THINKING_DEEP (default adaptive:medium) because without it Sonnet
# skipped `plan_day` in about a third of live E2E runs (2026-09-07) and answered with a prose timetable instead.
# The old default (budget:2048) is a live regression fixed 2026-09-07: Sonnet 5 on Bedrock rejects
# `{"thinking": {"type": "enabled", "budget_tokens": ...}}` outright (ValidationException naming
# "thinking.type.enabled" as unsupported), so every itinerary/plan turn failed. adaptive:medium restores
# plan_day reliability through model/load.thinking_fields's adaptive+output_config.effort path at a bounded
# (not maximal) reasoning cost.
THINKING_DEEP = os.environ.get("ATLAS_THINKING_DEEP") or "adaptive:medium"


def thinking_for_prompt(prompt: str) -> str | None:
    """Raw thinking setting for this turn: THINKING_DEEP for itinerary intents, None (= process default) otherwise."""
    return THINKING_DEEP if routing.classify(prompt) == "deep" else None

# Intent prefetch (plan 10): for the common intents the server runs the obvious tool calls BEFORE the model
# is asked and seeds the results into the turn, so Sonnet 5 is called once (write the answer) instead of
# twice (choose a tool, then write the answer — 2.5~3 s of the measured turn). On by default; ATLAS_PREFETCH
# is the operator's off switch, and everything about it degrades to the ordinary tool loop (Ruling R1).
PREFETCH = prefetch_enabled(os.environ.get(PREFETCH_ENV))


def _make_conversation_manager():
    # 20 messages ≈ 10 turns in the model context; long-term facts/preferences come back through Memory retrieval.
    return SlidingWindowConversationManager(window_size=20, should_truncate_results=True)


def agent_factory():
    cache: OrderedDict[str, Agent] = OrderedDict()

    def get_or_create_agent(session_id: str, actor_id: str) -> Agent:
        key = f"{session_id}/{actor_id}"
        if key in cache:
            cache.move_to_end(key)
            return cache[key]
        memory_manager = get_memory_session_manager(session_id, actor_id)
        grounding_policy = GuideGroundingPolicy()
        agent = Agent(
            # Every new conversation starts on the fast model: the first prompt is classified inside
            # invoke() below, same as every later turn — a fresh Agent must not pay the deep model's
            # latency on its very first turn just because it happened to be the deep route.
            model=load_model(MODEL_FAST),
            session_manager=memory_manager,
            conversation_manager=_make_conversation_manager(),
            system_prompt=SYSTEM_PROMPT,
            tools=tools,
            callback_handler=None,
            # One budget per cached Agent = one conversation (counters reset per turn, see tool_budget).
            # Without it the model widened `radius_m` and re-called find_places up to 27× in a single turn
            # (PLAN.md 8장 #28), which is what breaks the spec 1장 first-token/TTM gates.
            hooks=[ToolBudget(exempt={MapResponseV2.__name__}), grounding_policy],
        )
        agent._atlas_memory_manager = memory_manager
        agent._atlas_grounding_policy = grounding_policy
        cache[key] = agent
        while len(cache) > MAX_CACHED_AGENTS:
            cache.popitem(last=False)
        return agent

    return get_or_create_agent


get_or_create_agent = agent_factory()

# One turn at a time per conversation. A cached Agent keeps its message history as instance state, so
# two interleaved turns on the same session/actor corrupt it (mixed history, a toolUse orphaned from its
# toolResult). The contract is one request per conversation, but a user retry, a duplicate tab or a BFF
# resend all break it in practice. Claims expire on their own after the turn deadline + grace, so a
# stream the runtime never drained cannot wedge a conversation for the life of the container.
_inflight: dict[str, float] = {}


def _begin_turn(key: str, now: float | None = None) -> bool:
    """Claim `key` for one turn. False when a turn for the same key is still in flight."""
    now = time.monotonic() if now is None else now
    ttl = TURN_TIMEOUT + BUSY_GRACE_S
    for k, started in list(_inflight.items()):  # prune expired claims; keeps the dict bounded
        if now - started >= ttl:
            del _inflight[k]
    if key in _inflight:
        return False
    _inflight[key] = now
    return True


def _end_turn(key: str) -> None:
    _inflight.pop(key, None)


def _fallback_map(answer: str, warning: str) -> dict:
    return MapResponseV2(version="2", answer=answer, warnings=[warning]).model_dump(mode="json")


async def _error_stream(code: str, message: str) -> AsyncIterator[dict]:
    """error → map → done: the SSE shape the BFF parses (interfaces §48) for failures that happen
    BEFORE run_turn exists. Returning a bare dict to a `stream=true` caller instead would hand the
    BFF's SSE parser nothing to read, and the user an error with no cause."""
    yield {"type": "error", "code": code, "message": message}
    yield {"type": "map", **_fallback_map(message, code)}
    yield {"type": "done", "latency_ms": 0}


async def _guarded_stream(key: str, source: AsyncIterator[dict]) -> AsyncIterator[dict]:
    """Hold the conversation claim for as long as the turn's events are being produced."""
    try:
        async for ev in source:
            yield ev
    finally:
        try:
            await source.aclose()
        finally:
            _end_turn(key)


async def _warm_done_stream(latency_ms: int) -> AsyncIterator[dict]:
    """SSE reply for a warm ping with stream=true: one `done` event carrying `warmed=True` so a caller
    that streams it can tell this apart from a real turn's done event (interfaces spec, warm payload)."""
    yield {"type": "done", "latency_ms": latency_ms, "warmed": True}


def _handle_warm(payload: dict, context, wants_stream: bool):
    """Handle {"warm": true}: build (or, with no known actor, deliberately skip) the per-conversation
    Agent — no prompt, no model call, and no `_begin_turn` claim. Building a cached Agent is idempotent
    (agent_factory's cache dict), unlike a real turn's message-history mutation, so a warm ping can
    never corrupt a conversation the way two concurrent real turns would — it needs no busy claim."""
    t0 = time.monotonic()
    warm = parse_warm_payload(payload, context)
    result: dict = {"warmed": True, "tools": len(tools)}
    if warm.actor_id is not None:
        get_or_create_agent(warm.conversation_id, warm.actor_id)
        log.info("warm agent_built=true")
    else:
        result["agent"] = False
        log.info("warm agent_built=false")
    result["ms"] = int((time.monotonic() - t0) * 1000)
    return _warm_done_stream(result["ms"]) if wants_stream else result


async def _prefetch(prompt: str, grounding: dict | None = None) -> list[PrefetchResult]:
    """Run the tool calls this prompt obviously needs, before the model is called (plan 10).

    Gated on the env switch AND on there being a Gateway MCP client to call: `tools[0]` is the shared
    session warmed at boot (`warm_tools`), so these calls reuse it and cost no handshake. Runs inside the
    turn, before the model, in parallel with a hard timeout in `execute_prefetch`.

    Never raises and never yields a user-visible error (Ruling R1): a parser bug, a Gateway failure or a
    timeout all end here as `[]`, which is exactly the ordinary tool loop the model has always run.
    """
    seeded = grounding_prefetch(grounding)
    if not PREFETCH or not tools:
        return seeded
    t0 = time.monotonic()
    try:
        calls = [call for call in plan_prefetch(prompt)
                 if not covered_discovery_call(call.tool, call.arguments, grounding)]
        if not calls:
            return seeded
        results = await execute_prefetch(calls, tools[0])
    except Exception as exc:  # noqa: BLE001 — a cancelled turn still cancels
        log.warning("prefetch failed type=%s — running the normal tool loop", type(exc).__name__)
        return seeded
    log.info("prefetch tools=%s ms=%d", [safe_tool_name(r.call.tool) for r in results], int((time.monotonic() - t0) * 1000))
    return seeded + results


async def _grounded_turn(agent: Agent, prompt: str, prefetched: Prefetched, grounding: dict | None):
    """Scope transient reference handling to this serialized conversation turn."""
    policy = getattr(agent, "_atlas_grounding_policy", None)
    manager = getattr(agent, "_atlas_memory_manager", None)
    if policy is not None:
        policy.grounding = grounding
    if manager is not None:
        manager.omit_lookup_content = grounding is not None
    # Keep identities, not an index: SlidingWindowConversationManager removes
    # old entries in place while the turn is running.
    previous = list(getattr(agent, "messages", []))
    source = run_turn(agent, prompt, model=MapResponseV2, mode=STRUCTURED_MODE,
                      formatter=FORMATTER, timeout_s=TURN_TIMEOUT, prefetched=prefetched)
    try:
        if grounding is not None:
            yield {"type": "grounding", "version": 1}
        async for event in source:
            yield event
    finally:
        try:
            await source.aclose()
        finally:
            if grounding is not None and isinstance(getattr(agent, "messages", None), list):
                agent.messages[:] = [
                    message if any(message is old for old in previous) else redact_transient_lookup_message(message)
                    for message in agent.messages
                ]
            if manager is not None:
                manager.omit_lookup_content = False
            if policy is not None:
                policy.grounding = None


async def _collect_map(agent: Agent, prompt: str, prefetched: Prefetched = None, grounding: dict | None = None) -> dict:
    """Non-streaming path: run the same turn, return only the map payload (MapResponseV2 as a dict)."""
    last_map: dict | None = None
    async for ev in _grounded_turn(agent, prompt, prefetched, grounding):
        if ev.get("type") == "map":
            last_map = {k: v for k, v in ev.items() if k != "type"}
    return last_map or MapResponseV2(version="2", answer="죄송합니다. 답변을 생성하지 못했습니다.").model_dump(mode="json")


@app.entrypoint
async def invoke(payload, context):
    """Return an async generator (→ SSE) for stream=true, else a MapResponseV2 dict (→ JSON)."""
    wants_stream = isinstance(payload, dict) and bool(payload.get("stream", False))
    if is_warm_payload(payload):
        return _handle_warm(payload, context, wants_stream)
    try:
        req = parse_payload(payload, context)  # single source of truth for prompt/actor/session/locale
    except ValueError as exc:
        log.warning("bad payload code=bad_request")
        # Only the parser's fixed public reasons may reach the response. Never
        # format str(exception): validation libraries can include original input.
        reason = exc.args[0] if len(exc.args) == 1 and type(exc.args[0]) is str else None
        message = f"요청 형식이 올바르지 않습니다: {reason}" if reason in PUBLIC_PAYLOAD_REASONS else "요청 형식이 올바르지 않습니다."
        if wants_stream:
            return _error_stream("bad_request", message)
        return {"error": "bad_request", "message": message}
    session_id, actor_id = req.conversation_id, req.actor_id
    log.info("turn locale=%s stream=%s mode=%s", req.locale, req.stream, STRUCTURED_MODE)
    key = f"{session_id}/{actor_id}"
    if not _begin_turn(key):
        log.warning("conversation busy code=conversation_busy")
        return _error_stream(BUSY_CODE, BUSY_MESSAGE) if req.stream else {"error": BUSY_CODE, "message": BUSY_MESSAGE}
    try:
        agent = get_or_create_agent(session_id, actor_id)
        prompt = prompt_for_locale(req.prompt, req.locale)
        route, model_id = routing.select_model_id(req.prompt, mode=ROUTING_MODE, fast=MODEL_FAST, deep=MODEL_DEEP)
        thinking = thinking_for_prompt(req.prompt)
        model = load_model(model_id, thinking=thinking)
        if agent.model is not model:
            agent.model = model
        log.info("turn route=%s model=%s thinking=%s", route, model_id, thinking or "default")
        # Planned from the USER's prompt (the locale prefix `prompt` may carry is an instruction to the
        # model, not part of the question). NOT run here: `run_turn` starts it one line after the turn's
        # first `status thinking` event, so the client's typing indicator is not delayed by the prefetch,
        # while the tools are still answered before the model is called (the latency win).
        # Handed over as a callable, not as a coroutine: a turn whose events are never consumed would
        # leave a coroutine unawaited (a RuntimeWarning for something that is not an error).
        prefetching = partial(_prefetch, req.prompt, req.grounding)
        if not req.stream:
            try:
                return await _collect_map(agent, prompt, prefetching, req.grounding)
            finally:
                _end_turn(key)
        # The generator owns the claim from here on (released in _guarded_stream's finally).
        return _guarded_stream(key, _grounded_turn(agent, prompt, prefetching, req.grounding))
    except BaseException:
        _end_turn(key)  # releasing twice is a no-op; never leave a claim behind on a failure
        raise


if __name__ == "__main__":
    app.run()
