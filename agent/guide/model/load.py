import json
import logging
import os
from typing import Any

from strands.models.bedrock import BedrockModel, CacheConfig

log = logging.getLogger(__name__)

# Operator decision 2026-09-10: Seoul Global CRIS; Sol for ordinary questions,
# Astra for itinerary/route planning. Keep this aligned with routing.py.
MODEL_ID = "global.openai.gpt-6-astra"
BEDROCK_REGION = "ap-northeast-2"

_MODEL_CACHE: dict[tuple[str, str], BedrockModel] = {}   # (model_id, thinking fields as JSON) → client

THINKING_ENV = "ATLAS_THINKING"
THINKING_DEEP_ENV = "ATLAS_THINKING_DEEP"   # itinerary/plan intents (see main.thinking_for_prompt)
THINKING_DISABLED: dict[str, Any] = {"thinking": {"type": "disabled"}}
THINKING_EFFORTS = ("low", "medium", "high", "xhigh", "max")


def _adaptive_effort(effort: str) -> dict[str, Any]:
    return {"thinking": {"type": "adaptive"}, "output_config": {"effort": effort}}


def thinking_fields(raw: str | None) -> dict[str, Any] | None:
    """Bedrock `additionalModelRequestFields` for Claude's extended thinking, from ATLAS_THINKING.

    Sonnet 5 on Bedrock runs *adaptive* thinking unless told otherwise. Measured 2026-09-07 on this agent's
    tool-decision call: default → 300~1,700 reasoning tokens and 4.2~21 s per call; `{"thinking": {"type":
    "disabled"}}` → 123~158 output tokens and 2.5~2.8 s with the same, correct parallel tool choice. Those
    reasoning tokens were the single largest share of the turn (PLAN.md 8장 #28), so the default is off.

    Sonnet 5 (and Opus 5 / 4.7+) removed the old `{"thinking": {"type": "enabled", "budget_tokens": ...}}`
    shape entirely — Bedrock rejects it with `ValidationException: "thinking.type.enabled" is not supported
    for this model. Use "thinking.type.adaptive" and "output_config.effort"` (hit live on itinerary/plan turns,
    2026-09-07). The on-mode is now adaptive thinking plus a separate `output_config.effort` depth knob:
      disabled (default)   → {"thinking": {"type": "disabled"}}
      adaptive              → None (send nothing; the model's own default)
      adaptive:<effort>     → {"thinking": {"type": "adaptive"}, "output_config": {"effort": <effort>}}
                              effort ∈ low | medium | high | xhigh | max
      budget:<int>          → compatibility alias for old ATLAS_THINKING(_DEEP) values (never sent to
                              Bedrock as-is): logs a warning and maps to adaptive:<effort> by size —
                              <4096 → low, <16384 → medium, else high.
    Anything else (including an unknown adaptive:<effort>) logs a warning and falls back to disabled —
    a typo must not silently re-enable a 20-second cost, and no path here may ever emit `type: "enabled"`.
    """
    value = (raw or "disabled").strip().lower()
    if value == "disabled":
        return dict(THINKING_DISABLED)
    if value == "adaptive":
        return None
    if value.startswith("adaptive:"):
        effort = value.split(":", 1)[1]
        if effort in THINKING_EFFORTS:
            return _adaptive_effort(effort)
    elif value.startswith("budget:"):
        try:
            budget = int(value.split(":", 1)[1])
        except ValueError:
            budget = None
        if budget is not None and budget >= 1024:
            effort = "low" if budget < 4096 else "medium" if budget < 16384 else "high"
            log.warning(
                "%s: budget_tokens is not supported on Sonnet 5 (Bedrock ValidationException) — "
                "mapping to adaptive + effort=%s",
                THINKING_ENV,
                effort,
            )
            return _adaptive_effort(effort)
    log.warning("invalid %s — using disabled", THINKING_ENV)
    return dict(THINKING_DISABLED)


def openai_reasoning_fields(model_id: str, raw: str | None) -> dict[str, Any]:
    """Converse forwards Responses-style `reasoning.effort` for OpenAI CRIS.

    Verified on both Global profiles on 2026-09-10. The Chat Completions spelling
    `reasoning_effort` is rejected on this API. Astra's minimum is low; Sol can
    disable reasoning for ordinary questions. Preserve the existing operator
    env syntax while keeping Claude-only fields out of OpenAI requests.
    """
    minimum = "low" if "gpt-6-astra" in model_id else "none"
    value = (raw or "disabled").strip().lower()
    if value in ("disabled", "none"):
        effort = minimum
    elif value in THINKING_EFFORTS:
        effort = value
    elif value.startswith("adaptive:") and value.split(":", 1)[1] in THINKING_EFFORTS:
        effort = value.split(":", 1)[1]
    elif value == "adaptive":
        effort = "medium"
    elif value.startswith("budget:"):
        fields = thinking_fields(value)
        effort = (fields or {}).get("output_config", {}).get("effort", minimum)
    else:
        log.warning("Invalid reasoning setting for OpenAI model; using %s", minimum)
        effort = minimum
    return {"reasoning": {"effort": effort}}


def load_model(model_id: str | None = None, *, thinking: str | None = None) -> BedrockModel:
    """Get a cached Bedrock model client using IAM credentials.

    model_id defaults to MODEL_ID (deep, Global Astra) when omitted. The same model_id always returns the
    SAME BedrockModel instance — and so the same boto3 client — so main.py's per-turn model swap between
    the fast and deep routes reuses both cached clients instead of constructing a fresh one every turn.

    Claude's explicit cache points are retained only for explicitly selected
    Anthropic models. OpenAI profiles use their provider's automatic caching.
    """
    resolved_id = model_id or MODEL_ID
    # `thinking` (a raw ATLAS_THINKING-style value) overrides the process default for this client: itinerary
    # turns re-enable extended thinking (plan_day was skipped in ~1/3 of E2E runs without it, 2026-09-07) while
    # ordinary turns keep it off for latency. One cached client per (model, thinking) pair.
    raw_thinking = thinking if thinking is not None else os.environ.get(THINKING_ENV)
    is_openai = resolved_id.startswith(("global.openai.", "us.openai.", "openai."))
    fields = openai_reasoning_fields(resolved_id, raw_thinking) if is_openai else thinking_fields(raw_thinking)
    key = (resolved_id, json.dumps(fields, sort_keys=True) if fields else "")
    if key not in _MODEL_CACHE:
        kwargs: dict[str, Any] = {"model_id": resolved_id, "region_name": BEDROCK_REGION, "max_tokens": 4096}
        if not is_openai:
            kwargs.update(cache_config=CacheConfig(strategy="auto"), cache_tools="default")
        if fields:
            kwargs["additional_request_fields"] = fields
        _MODEL_CACHE[key] = BedrockModel(**kwargs)
    return _MODEL_CACHE[key]
