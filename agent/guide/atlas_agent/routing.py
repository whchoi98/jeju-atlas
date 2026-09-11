"""Rule-based model router: a "fast" route for ordinary turns and a "deep" route for itinerary/schedule intents.
Defaults are Seoul Global CRIS Sol/Astra (operator decision 2026-09-10).
Env ATLAS_MODEL_FAST/DEEP may override.

The rule-based router does not make another model call to select a model.

`classify` is a cheap regex gate, not an LLM call: a wrong route only costs one extra model round trip
(deep is a superset of fast's capability), so a conservative, explainable ruleset beats a second model
call whose whole purpose is to save latency.
"""
from __future__ import annotations

import logging
import re
from typing import Literal

log = logging.getLogger(__name__)

MODEL_FAST_DEFAULT = "global.openai.gpt-5.6-sol"
MODEL_DEEP_DEFAULT = "global.openai.gpt-6-astra"
ROUTING_MODES = ("auto", "fast", "deep")

Route = Literal["fast", "deep"]

# Korean itinerary/schedule vocabulary + a few English equivalents. Case-insensitive so "Plan a day trip"
# and "PLAN A DAY TRIP" classify the same way.
DEEP_INTENT = re.compile(
    r"(일정|코스(?!모|\s*(?:요리|메뉴))|동선|스케줄|하루\s*계획|이틀|[1-9]\s*일\s*(여행|코스|일정)|여행\s*계획|짜\s*줘|짜줘|계획해|"
    r"itinerary|plan\s+(my|a|the)\s+(day|trip)|schedule|"
    r"\b(?:plan|create|build|make|design|organize|arrange)\b.{0,64}\b(?:day\s*trip|itinerary|schedule|tour|trip|route|visits?)\b)",
    re.IGNORECASE,
)

REFERENCE_CONTEXT = re.compile(
    r"\n\s*\n(?:사용자가 가리킨 탐색 맥락:|Browsing context explicitly referenced by the user:|"
    r"\[서비스 카탈로그 조회 자료\]|\[Service catalog reference data\])",
    re.IGNORECASE,
)


def classify(prompt: str) -> Route:
    """"deep" when the prompt reads as an itinerary/schedule request, else "fast"."""
    # Saved-trip labels and catalog JSON are reference data, not the user's
    # requested task. They must not turn a nearby-cafe question into a deep turn.
    question = REFERENCE_CONTEXT.split(prompt or "", maxsplit=1)[0]
    return "deep" if DEEP_INTENT.search(question) else "fast"


def routing_mode(raw: str | None) -> str:
    """Whitelist ATLAS_MODEL_ROUTING — an unrecognised value falls back to "auto" (with a warning)
    instead of silently reaching select_model_id as a mode neither "fast" nor "deep" ever matches."""
    mode = (raw or "auto").strip().lower()
    if mode in ROUTING_MODES:
        return mode
    log.warning("invalid ATLAS_MODEL_ROUTING — using 'auto'")
    return "auto"


def select_model_id(
    prompt: str,
    *,
    mode: str = "auto",
    fast: str = MODEL_FAST_DEFAULT,
    deep: str = MODEL_DEEP_DEFAULT,
) -> tuple[Route, str]:
    """Pick (route, model_id) for one turn. mode="fast"/"deep" pin the route; "auto" classifies the prompt."""
    if mode == "fast":
        return "fast", fast
    if mode == "deep":
        return "deep", deep
    route = classify(prompt)
    return route, (deep if route == "deep" else fast)
