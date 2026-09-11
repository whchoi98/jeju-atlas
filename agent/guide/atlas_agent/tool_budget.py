"""Per-turn tool-call budget for JejuAtlasGuide — a strands HookProvider.

Why this exists: the deployed W3 spike (PLAN.md 8장 #28) measured up to **27 `find_places` calls in one
turn**. A catalog-only `find_places` (no Kakao REST key) used to answer an empty search with a bare
`{"items": [], "total": 0}`, which reads to the model like "try again, differently" — so it kept widening
`radius_m` and retrying until `ATLAS_TURN_TIMEOUT_S=85` cut the turn. That storm, not the
single/two_stage choice, is what blows the spec 1장 gates (첫 토큰 ≤2.5s, TTM p50 6s/p95 12s).

Two independent guards fix it, and this module is the second one:
1. `atlas_tools.places.find_places` now returns `exhaustive: true` (or `suggest_radius_m`) so widening
   is answered with data instead of a guess — it depends on the model reading the field.
2. this hook — a hard per-turn ceiling that holds even when the model ignores every hint. Also caps
   spend against the Kakao route/local quotas the spec's 8장 risk list wants bounded per session.

How the stop is delivered: a `BeforeToolCallEvent` over budget gets `cancel_tool=<message>`, so strands
skips the tool and hands the model an *error tool result* carrying that message (see
`strands/tools/executors/_executor.py` — cancel_tool → ToolResult(status="error")). The turn continues and
can still produce MapResponseV2. That is why this is a hook and not `Limits(turns=…)`: a turns limit stops
the loop with `stop_reason="limit_turns"` *before* structured output is forced, so the turn ends with no map.

Counters are per invocation (reset on `BeforeInvocationEvent`, which strands fires once per
`stream_async`/`invoke_async` call), so one `ToolBudget` instance belongs to one cached Agent — i.e. one
conversation, whose turns are already serialized by main.py's `_inflight` claim.

The structured-output tool (named after the Pydantic model, e.g. `MapResponseV2`) must never be blocked:
pass it in `exempt=`.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any

from strands.hooks import BeforeInvocationEvent, BeforeToolCallEvent, HookProvider, HookRegistry

from .privacy import safe_tool_name

log = logging.getLogger(__name__)

STRIP_PREFIX = "jejuatlastools_"   # Gateway prefixes every MCP tool name; messages show the short name
DEFAULT_PER_TOOL = 3              # perf-agent plan 06 Task 2: find_places now needs exactly 1 call
                                  # (near= resolves the anchor and widens server-side); 3 leaves room
                                  # for one legitimate suggest_radius_m retry plus slack for other tools.
                                  # A turn that must resolve 4+ separately named places legitimately needs
                                  # more: raise ATLAS_TOOL_BUDGET_PER_TOOL (env, no code change) —
                                  # test_tool_budget_cancels_a_fourth_legitimately_distinct_call covers both.
DEFAULT_TOTAL = 12                # 8 tools × ~1.5 calls; the observed storm was 27 calls of one tool
LIMIT_RANGE = (1, 200)

# Mode-neutral wording: in `derive` mode (default since perf-routing plan 08) the model never produces
# MapResponseV2 itself — the server derives the map from these tool results — so these messages only ever
# ask for the answer body. The structured-output modes keep working: their own prompt asks for the map.
PER_TOOL_MESSAGE = (
    "도구 예산 초과: `{tool}` 은 한 턴에 {limit}회까지만 호출할 수 있습니다. 더 호출하지 말고 지금까지 받은 "
    "도구 결과만으로 답변 본문을 쓰세요. 결과가 부족하면 그 사실을 답변에 적으세요."
)
TOTAL_MESSAGE = (
    "도구 예산 초과: 이 턴의 도구 호출 상한 {limit}회를 모두 썼습니다. 더 호출하지 말고 지금까지 받은 도구 "
    "결과만으로 답변 본문을 쓰세요."
)
DUPLICATE_MESSAGE = (
    "중복 호출: `{tool}` 을 같은 인자로 이미 호출했습니다. 결과는 위 도구 결과와 동일하므로 그것을 그대로 "
    "쓰세요. 인자를 바꾸지 않은 재호출은 다시 실행되지 않습니다."
)


def _limit(raw: str | None, default: int) -> int:
    """Parse a budget env var defensively — a typo must not remove the ceiling or crash the container."""
    if raw is None or not str(raw).strip():
        return default
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        log.warning("invalid tool budget — using %d", default)
        return default
    low, high = LIMIT_RANGE
    if not low <= value <= high:
        log.warning("tool budget outside allowed range — using %d", default)
        return default
    return value


def short_name(name: str) -> str:
    return name[len(STRIP_PREFIX):] if name.startswith(STRIP_PREFIX) else name


def dedupe_key(name: str, tool_input: Any) -> str:
    """Canonical (tool, arguments) identity. Argument order must not make a repeat look new."""
    try:
        args = json.dumps(tool_input, sort_keys=True, ensure_ascii=False, default=str)
    except (TypeError, ValueError):  # pragma: no cover — json.dumps(default=str) is total in practice
        args = repr(tool_input)
    return f"{name}\x1f{args}"


class ToolBudget(HookProvider):
    """Cap tool calls per turn: `per_tool` per tool name, `total` overall, and no identical repeat.

    Every non-exempt attempt is counted, including one this hook cancels — otherwise a model that only
    ever repeats a blocked call would loop forever without the totals ever moving.
    """

    def __init__(self, *, per_tool: int | None = None, total: int | None = None, exempt: Any = ()) -> None:
        self.per_tool = per_tool if per_tool is not None else _limit(os.environ.get("ATLAS_TOOL_BUDGET_PER_TOOL"), DEFAULT_PER_TOOL)
        self.total = total if total is not None else _limit(os.environ.get("ATLAS_TOOL_BUDGET_TOTAL"), DEFAULT_TOTAL)
        self.exempt = frozenset(exempt)
        self.attempts = 0
        self.calls: dict[str, int] = {}
        self.seen: dict[str, int] = {}

    # ---- strands wiring ----
    def register_hooks(self, registry: HookRegistry, **_: Any) -> None:
        registry.add_callback(BeforeInvocationEvent, self._on_invocation_start)
        registry.add_callback(BeforeToolCallEvent, self.check)

    def _on_invocation_start(self, _event: BeforeInvocationEvent) -> None:
        self.reset()

    def reset(self) -> None:
        self.attempts = 0
        self.calls = {}
        self.seen = {}

    # ---- enforcement ----
    def check(self, event: BeforeToolCallEvent) -> None:
        tool_use = event.tool_use or {}
        name = str(tool_use.get("name") or "")
        if not name or name in self.exempt or short_name(name) in self.exempt:
            return
        self.attempts += 1
        per = self.calls.get(name, 0) + 1
        self.calls[name] = per
        key = dedupe_key(name, tool_use.get("input"))
        repeats = self.seen.get(key, 0)
        self.seen[key] = repeats + 1
        short = short_name(name)
        if self.attempts > self.total:
            event.cancel_tool = TOTAL_MESSAGE.format(limit=self.total)
        elif per > self.per_tool:
            event.cancel_tool = PER_TOOL_MESSAGE.format(tool=short, limit=self.per_tool)
        elif repeats:
            event.cancel_tool = DUPLICATE_MESSAGE.format(tool=short)
        else:
            return
        log.warning("tool budget cancelled %s (attempt %d/%d, %s call %d/%d, repeat %d)",
                    safe_tool_name(short), self.attempts, self.total, safe_tool_name(short), per, self.per_tool, repeats)
