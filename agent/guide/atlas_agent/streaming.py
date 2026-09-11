"""Streaming core for JejuAtlasGuide — strands events → agent SSE events (token/status/heartbeat/map/error/done).

Modes (env ATLAS_STRUCTURED_MODE; "derive" is the default since perf-routing plan 08 Task 3):
- "derive":    agent.stream_async(prompt) for prose only; the map is assembled from the turn's own tool
               results by `derive.derive_map` (zero extra model round trips — the structured-output tool
               call measured ~5.1 s of the turn). Coordinates still come only from tool results.
- "single":    agent.stream_async(prompt, structured_output_model=MapResponseV2). strands streams the prose turn as
               `data` deltas, then forces the structured-output tool (named after the model) and yields
               {"structured_output": MapResponseV2}. One model session, memory sees one turn.
- "two_stage": agent.stream_async(prompt) for prose, then a separate tool-less formatter agent turns
               (prose + raw tool result texts) into MapResponseV2 — used only if the spike shows the single mode
               starves the token stream (model calls the structured tool without writing prose).
Exactly one `map` event is emitted per turn, always followed by `done`; failures become `error` + fallback map.

`run_turn(..., prefetched=[...])` (plan 10) seeds tool calls the server already ran before the model was
asked: the prompt becomes a `Messages` list (user question → assistant toolUse → user toolResult) so the
model writes the answer in ONE call instead of first deciding which tool to use. See `seeded_messages`,
`seed_state` and the R7 guard in `atlas_agent.prefetch`. `prefetched` may also be the un-awaited
awaitable (`main.invoke` hands over `_prefetch(...)` itself): it is awaited AFTER the turn's first
`status thinking` event, so the typing indicator is never delayed by the prefetch — see
`resolve_prefetched`.
"""
from __future__ import annotations

import asyncio
import contextlib
import inspect
import json
import logging
import threading
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel

from atlas_agent.derive import derive_map
from atlas_agent.prefetch import PrefetchResult, gateway_tool_name, seedable
from atlas_agent.privacy import safe_tool_name
from atlas_contracts import MapResponseV2, parse_map_response_v2

log = logging.getLogger(__name__)
TURN_TIMEOUT_S = 85.0       # BFF cuts the turn at 90 s; finish (map + done) before that
HEARTBEAT_S = 10.0          # CloudFront idle wall is 60 s; BFF also heartbeats
STRIP_PREFIX = "jejuatlastools_"
FORMATTER_SYSTEM = (
    "You convert a Jeju travel assistant's final answer plus the raw tool results into MapResponseV2. "
    "Copy coordinates ONLY from tool results; never invent lat/lng. `answer` must be the assistant text verbatim. "
    "markers ≤ 12, coordinates as {lat, lng} objects inside Jeju (lat 33.10–33.60, lng 126.15–126.98)."
)
MAX_FORMATTER_CHARS = 60_000
MAX_FORMATTER_TOOL_TEXT = 2_000   # per tool result, before whole tool texts start being dropped
QUEUE_MAXSIZE = 512               # backpressure: a slow consumer must not let the pump buffer without bound
PUMP_CLEANUP_S = 1.0              # bound on awaiting the cancelled pump task
Mode = Literal["derive", "single", "two_stage"]
Formatter = Callable[[str, list[dict]], Awaitable[BaseModel | None]]


class _TurnTimeoutError(TimeoutError):
    """The turn deadline elapsed.

    Raised from inside a generator's own pull loop (never via `asyncio.timeout`'s task-level cancellation),
    so it can only surface at a point where that generator is actually executing — it can never be delivered
    while a consumer is suspended in its own await *between* two events this module yielded (fix round 1:
    `asyncio.timeout` wraps the current task, so a deadline firing while the consumer — not this generator —
    is running throws CancelledError into the consumer's frame instead of ours). Subclasses `TimeoutError` so
    existing `except TimeoutError:` handling below keeps working unchanged.
    """


@dataclass
class TurnState:
    text: list[str] = field(default_factory=list)
    tool_results: list[dict] = field(default_factory=list)
    structured: BaseModel | None = None
    announced: set[str] = field(default_factory=set)
    tool_names: dict[str, str] = field(default_factory=dict)   # toolUseId → short tool name, for derive mode

    def joined_text(self) -> str:
        return "".join(self.text).strip()


def map_event(ev: dict, state: TurnState, structured_tool_name: str) -> list[dict]:
    """Translate one strands stream event into zero or more agent SSE events, updating `state`."""
    if not isinstance(ev, dict):
        return []
    if isinstance(ev.get("data"), str):
        state.text.append(ev["data"])
        return [{"type": "token", "text": ev["data"]}]
    kind = ev.get("type")
    if kind == "tool_use_stream":
        tu = ev.get("current_tool_use") or {}
        tid, name = tu.get("toolUseId"), tu.get("name")
        if tid and name and tid not in state.announced:
            state.announced.add(tid)
            if name != structured_tool_name:
                short = name[len(STRIP_PREFIX):] if name.startswith(STRIP_PREFIX) else name
                # derive mode reads the map out of the tool results, and a result carries only its
                # toolUseId — this is the one event that says which tool that id belongs to.
                state.tool_names[tid] = short
                return [{"type": "status", "stage": "tool", "tool": short}]
        return []
    if kind == "tool_result" and isinstance(ev.get("tool_result"), dict):
        # strands' internal ToolResultEvent shape — never surfaced by stream_async in 1.54, kept for
        # forward compatibility only. The production carrier is the `message` event below.
        state.tool_results.append(ev["tool_result"])
        return []
    message = ev.get("message")
    if isinstance(message, dict):
        # ToolResultMessageEvent (strands 1.54 types/_events.py): after the tools run, the event loop appends a
        # user message whose content blocks are {"toolResult": {toolUseId, status, content}} and yields it as
        # {"message": ...}. This is the ONLY event that carries tool results to a stream_async consumer, and
        # derive mode reads the map out of them (plan 08 final review: without this branch every derive turn
        # produced an empty map in production while the unit tests, fed a fake shape, stayed green).
        for block in message.get("content") or []:
            if isinstance(block, dict) and isinstance(block.get("toolResult"), dict):
                state.tool_results.append(block["toolResult"])
        return []
    if isinstance(ev.get("structured_output"), BaseModel):
        state.structured = ev["structured_output"]
        return []
    return []


async def with_heartbeat(
    source: AsyncIterator[dict], interval_s: float = HEARTBEAT_S, *, deadline: float | None = None
) -> AsyncIterator[dict]:
    """Yield source events; when the source is silent for `interval_s`, yield {"type": "heartbeat"}.

    The source is pumped by a background task into a queue so a heartbeat timeout never cancels the generator
    mid-await (asyncio.wait_for on `__anext__` would close it).

    `deadline` (an absolute `time.monotonic()` timestamp), when given, bounds the whole stream: once it
    elapses this raises `_TurnTimeoutError` from *inside* this pull loop — i.e. only while this generator is
    the thing actually running, right after its own `asyncio.wait_for(queue.get(), ...)` completes and before
    it yields anything. That is deliberate (fix round 1): the deadline must never be enforced by cancelling
    the current *task* (as `asyncio.timeout()` does), because a plain async generator shares its consumer's
    task — a task-level cancel fired while the consumer is suspended in its own await between two of our
    yielded events lands in the consumer's frame, not here, and escapes as a bare CancelledError instead of
    the turn_timeout error+fallback-map this module promises.
    """
    queue: asyncio.Queue[Any] = asyncio.Queue(maxsize=QUEUE_MAXSIZE)
    sentinel = object()

    async def pump() -> None:
        try:
            async for item in source:
                await queue.put(item)          # bounded: applies backpressure to the source when the consumer lags
        except asyncio.CancelledError:
            raise                              # our own cancellation is cleanup, not a stream event
        except BaseException as exc:  # noqa: BLE001 — propagate source failures to the consumer
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(exc)
        finally:
            # Never `await` here: cancellation arriving while the queue is full would block cleanup
            # forever and deadlock the `await` in the consumer's own finally below.
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(sentinel)

    task = asyncio.create_task(pump())
    try:
        while True:
            wait_s = interval_s
            if deadline is not None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise _TurnTimeoutError
                wait_s = min(interval_s, remaining)
            try:
                item = await asyncio.wait_for(queue.get(), timeout=wait_s)
            except asyncio.TimeoutError:
                if deadline is not None and time.monotonic() >= deadline:
                    raise _TurnTimeoutError from None
                yield {"type": "heartbeat"}
                continue
            if item is sentinel:
                return
            if isinstance(item, BaseException):
                raise item
            yield item
    finally:
        if not task.done():
            task.cancel()
        # Await the cancelled pump so the source generator is closed here and asyncio does not report
        # "Task was destroyed but it is pending". Bounded, and asyncio.wait never re-raises the task's
        # own exception, so cleanup cannot fail or hang.
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.wait({task}, timeout=PUMP_CLEANUP_S)


# ---- prefetch seeding (plan 10 Task 2) -------------------------------------------------------------------
# What `run_turn(prefetched=...)` accepts: the results, something that produces them when the turn asks
# (a zero-argument callable — what `main.invoke` hands over — or a bare awaitable), or nothing at all.
Prefetched = list[PrefetchResult] | Awaitable[list[PrefetchResult]] | Callable[[], Awaitable[list[PrefetchResult]]] | None


async def resolve_prefetched(prefetched: Prefetched) -> list[PrefetchResult]:
    """The pre-fetched results, starting the prefetch here when the caller only handed over a way to.

    `main.invoke` deliberately does NOT await its `_prefetch(...)`: awaiting it there ran the whole
    prefetch (up to `prefetch.DEFAULT_TIMEOUT_S`, ~1 s typically) before this generator existed, so the
    turn's first SSE event — `status thinking`, the client's typing indicator — arrived that much later on
    exactly the prompts plan 10 is optimising. Starting it one line after that event costs nothing: the
    tools are still answered before the model is called, so TTM is unchanged.

    A CALLABLE rather than a coroutine is what `invoke` passes, because a turn whose events are never
    consumed (the caller drops the generator) would leave a coroutine unawaited — a RuntimeWarning in the
    Runtime log for something that is not an error. A callable that is never called is simply not called.

    Never raises (Ruling R1). `main._prefetch` already swallows its own failures, but a caller may hand
    over anything, and a prefetch that fails is simply no prefetch — never a user-visible error.
    """
    if prefetched is None:
        return []
    if isinstance(prefetched, list):
        return prefetched
    try:
        value: Any = prefetched() if callable(prefetched) else prefetched
        if inspect.isawaitable(value):
            value = await value
    except asyncio.CancelledError:   # the turn itself is being cancelled — never swallow it
        raise
    except Exception as exc:         # noqa: BLE001 — a prefetch failure is never user visible (R1)
        log.warning("prefetch failed type=%s — running the normal tool loop", type(exc).__name__)
        return []
    if value is None:
        return []
    if not isinstance(value, list):
        log.warning("prefetched resolved to %s, not a list of results — running the normal tool loop", type(value).__name__)
        return []
    return value


def keep_seedable(prefetched: list[PrefetchResult] | None, prompt: str) -> list[PrefetchResult]:
    """The pre-fetched results the R7 guard accepts; the rest are dropped with the reason logged at INFO."""
    kept: list[PrefetchResult] = []
    for result in prefetched or []:
        ok, _ = seedable(result, prompt)
        if ok:
            kept.append(result)
        else:
            log.info("prefetch %s not seeded", safe_tool_name(getattr(getattr(result, "call", None), "tool", None)))
    return kept


def seeded_messages(prompt: str, prefetched: list[PrefetchResult]) -> list[dict]:
    """The turn as a strands `Messages` list with the pre-fetched calls already made and answered.

    Three messages — the user's question, ONE assistant message carrying every `toolUse` block, ONE user
    message carrying every matching `toolResult` block — which is the shape a Bedrock conversation has
    after a parallel tool cycle, so the model's next output is the answer itself: one model call instead of
    two (plan 10). strands 1.54 accepts this as a prompt (`Agent._convert_prompt_to_messages`,
    agent.py:1717-1759: a list whose items all carry Message's required keys is used as Messages) and
    appends every one of them through `_append_messages` (agent.py:1495), i.e. through the session
    manager's MessageAddedEvent hook — so Memory redaction applies exactly as it does to a normal turn.

    The tool NAME carries the Gateway prefix (Ruling R4) because that is the name the model was given; the
    MCP call that produced the result used the bare name.
    """
    return [
        {"role": "user", "content": [{"text": prompt}]},
        {"role": "assistant", "content": [
            {"toolUse": {"toolUseId": r.tool_use_id, "name": gateway_tool_name(r.call.tool), "input": dict(r.call.arguments)}}
            for r in prefetched
        ]},
        {"role": "user", "content": [
            {"toolResult": {"toolUseId": r.tool_use_id, "status": r.status, "content": [{"text": r.text}]}}
            for r in prefetched
        ]},
    ]


def seed_state(state: TurnState, prefetched: list[PrefetchResult]) -> None:
    """Pre-fill the turn state with the pre-fetched results (Ruling R3).

    A pre-seeded tool result never travels through strands' `message` stream event — the tools ran before
    the Agent was called — so `map_event` will never see it and `derive` would build its map from the
    model's *later* calls alone. Writing both halves here keeps the derived map identical to a turn where
    the model called the tools itself: the results in `tool_results`, and toolUseId → short tool name in
    `tool_names` (the same short form `map_event` records). The ids also go into `announced` so nothing can
    announce them a second time.
    """
    for r in prefetched:
        state.tool_results.append({"toolUseId": r.tool_use_id, "status": r.status, "content": [{"text": r.text}]})
        state.tool_names[r.tool_use_id] = r.call.tool
        state.announced.add(r.tool_use_id)


def finalize_map(state: TurnState, model: type[MapResponseV2] = MapResponseV2) -> MapResponseV2:
    if isinstance(state.structured, model):
        return state.structured
    if isinstance(state.structured, BaseModel):  # a different model type sneaked in — re-validate leniently
        return parse_map_response_v2(state.structured.model_dump(mode="json"))
    return parse_map_response_v2(state.joined_text())


def _fallback_map(model: type[MapResponseV2], answer: str, warning: str) -> MapResponseV2:
    return model(version="2", answer=answer, warnings=[warning])


async def run_turn(agent: Any, prompt: str, *, model: type[MapResponseV2] = MapResponseV2, mode: Mode = "derive",
                   formatter: Formatter | None = None, timeout_s: float = TURN_TIMEOUT_S, heartbeat_s: float = HEARTBEAT_S,
                   prefetched: Prefetched = None) -> AsyncIterator[dict]:
    started = time.monotonic()
    deadline = started + timeout_s
    state = TurnState()
    cancel = threading.Event()
    structured_tool_name = model.__name__
    yield {"type": "status", "stage": "thinking"}

    # Prefetch (plan 10): the obvious tool calls already ran, so hand the model the conversation as it
    # would look after that tool cycle and let it write the answer straight away — one model call.
    # Whatever the R7 guard rejects is dropped here; with nothing left this is the ordinary turn.
    # Awaited AFTER the `thinking` event above (never before it) so the typing indicator stays at t≈0;
    # the prefetch runs inside the turn's own deadline, which is 85 s against a 3 s prefetch timeout.
    seeded = keep_seedable(await resolve_prefetched(prefetched), prompt)
    model_input: Any = prompt
    if seeded:
        model_input = seeded_messages(prompt, seeded)
        seed_state(state, seeded)
        log.info("seeded %d prefetched tool result(s): %s", len(seeded), [safe_tool_name(r.call.tool) for r in seeded])
        for result in seeded:
            # The UI shows the same "<tool> 실행 중" line it shows for a model-driven call: map_event can
            # never emit it for these, because the tool ran before the stream existed (Ruling R3).
            yield {"type": "status", "stage": "tool", "tool": result.call.tool}

    async def events() -> AsyncIterator[dict]:
        kwargs: dict[str, Any] = {"cancel_signal": cancel}
        if mode == "single":
            kwargs["structured_output_model"] = model
        async for ev in agent.stream_async(model_input, **kwargs):
            yield ev

    resp: MapResponseV2
    try:
        # Deadline is enforced inside with_heartbeat's own pull loop (see _TurnTimeoutError), never via
        # asyncio.timeout()/task cancellation — that would fire against whatever this shared task happens to
        # be awaiting, including a consumer's own await between two of the events we yield below (fix round 1).
        async for ev in with_heartbeat(events(), heartbeat_s, deadline=deadline):
            if ev.get("type") == "heartbeat":
                yield ev
                continue
            for out in map_event(ev, state, structured_tool_name):
                yield out
        if mode == "two_stage" and state.structured is None and formatter is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise _TurnTimeoutError
            # bounds only this single plain await (no yield inside it), so this wait_for cancels its own
            # inner formatter-call future on timeout — it never touches the current task, unlike asyncio.timeout.
            state.structured = await asyncio.wait_for(formatter(state.joined_text(), state.tool_results), timeout=remaining)
        # derive: no model round trip at all — the map is projected from this turn's own tool results.
        resp = (
            derive_map(state.joined_text(), state.tool_results, tool_names=state.tool_names, model=model)
            if mode == "derive"
            else finalize_map(state, model)
        )
    except TimeoutError:
        cancel.set()
        log.warning("turn timeout after %.1fs (tokens=%d)", timeout_s, len(state.text))
        yield {"type": "error", "code": "turn_timeout", "message": f"응답 생성이 {int(timeout_s)}초를 넘어 중단했습니다. 질문을 나눠서 다시 시도해 주세요."}
        resp = _fallback_map(model, state.joined_text() or "죄송합니다. 시간이 초과되어 답변을 완성하지 못했습니다.", "turn_timeout")
    except Exception as exc:  # noqa: BLE001 — the SSE contract must still end with map + done
        cancel.set()
        log.error("turn failed type=%s", type(exc).__name__)
        yield {"type": "error", "code": "agent_error", "message": f"요청을 처리하는 중 문제가 생겼습니다({type(exc).__name__}). 잠시 후 다시 시도해 주세요."}
        resp = _fallback_map(model, state.joined_text() or "죄송합니다. 요청을 처리하는 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.", f"agent_error:{type(exc).__name__}")
    if resp.warnings:
        log.warning("map warnings count=%d", len(resp.warnings))
    yield {"type": "map", **resp.model_dump(mode="json")}
    yield {"type": "done", "latency_ms": int((time.monotonic() - started) * 1000)}


def _tool_texts(tool_results: list[dict]) -> list[str]:
    texts: list[str] = []
    for tr in tool_results:
        for block in (tr.get("content") or []) if isinstance(tr, dict) else []:
            if isinstance(block, dict) and isinstance(block.get("text"), str):
                texts.append(block["text"])
    return texts


def formatter_payload(text: str, tool_texts: list[str], limit: int = MAX_FORMATTER_CHARS) -> str:
    """Serialize the stage-2 prompt so it fits `limit` and is ALWAYS valid JSON.

    Slicing `json.dumps(...)[:limit]` (the previous shape) cuts the document mid-token and hands the
    formatter model broken JSON, which is exactly the input least likely to produce a valid
    MapResponseV2. Shrink the *inputs* instead: trim the longest tool text, then drop whole tool texts,
    and only as a last resort trim the assistant answer.
    """
    texts = list(tool_texts)
    while True:
        payload = json.dumps({"assistant_answer": text, "tool_results": texts}, ensure_ascii=False)
        if len(payload) <= limit or not texts:
            break
        longest = max(range(len(texts)), key=lambda i: len(texts[i]))
        if len(texts[longest]) > MAX_FORMATTER_TOOL_TEXT:
            texts[longest] = texts[longest][:MAX_FORMATTER_TOOL_TEXT]
        else:
            texts.pop(longest)
    if len(payload) > limit:  # the answer alone overflows: keep the JSON valid by trimming the answer
        payload = json.dumps({"assistant_answer": text[: max(0, limit - 200)], "tool_results": []}, ensure_ascii=False)
    return payload


def make_formatter(model_loader: Callable[[], Any], contract_model: type[BaseModel], *, agent_cls: Any = None) -> Formatter:
    """Stage-2 formatter for two_stage mode: a fresh, tool-less, memory-less agent that only emits the contract model.

    A separate agent keeps the "format this" turn out of the user's conversation history and AgentCore Memory.
    `agent_cls` is injectable for tests; production uses strands.Agent.
    """
    if agent_cls is None:
        from strands import Agent
        from strands.agent.conversation_manager.null_conversation_manager import NullConversationManager

        def _make():
            return Agent(model=model_loader(), system_prompt=FORMATTER_SYSTEM, tools=[], conversation_manager=NullConversationManager(), callback_handler=None)
    else:
        def _make():
            return agent_cls(model=model_loader(), system_prompt=FORMATTER_SYSTEM, tools=[], callback_handler=None)

    async def _format(text: str, tool_results: list[dict]) -> BaseModel | None:
        payload = formatter_payload(text, _tool_texts(tool_results)[:20])
        result = await _make().invoke_async(payload, structured_output_model=contract_model)
        so = getattr(result, "structured_output", None)
        return so if isinstance(so, contract_model) else None

    return _format
