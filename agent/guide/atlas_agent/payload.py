"""Invocation payload contract (BFF → agent): {"prompt", "user_id", "conversation_id", "locale", "stream"}.

`parse_payload(payload, context)` is the SINGLE place that resolves identity for a turn: main.py used to
re-run `resolve_actor_id`/`resolve_session_id` on the raw payload after parsing, so the same values were
computed twice and `TurnRequest.conversation_id` was never read. Now `TurnRequest.conversation_id` IS the
resolved runtime session id (header → payload conversation_id → uuid4) and `actor_id` already carries the
per-conversation anonymous fallback.

A second payload shape (perf-agent plan 09 Task 1) pre-warms a conversation without a model call:
{"warm": true, "user_id", "conversation_id"} — no `prompt`. `is_warm_payload`/`parse_warm_payload` are
the equivalent entry points for that shape, reusing `resolve_session_id`/`resolve_actor_id` so a warm
ping and the turn that follows it land on the identical runtime session / Memory actor.
"""
from __future__ import annotations

from dataclasses import dataclass
from copy import deepcopy
from datetime import datetime
import json
import math
import re
from typing import Any

from .identity import Locale, anon_actor_for_session, has_actor_id, resolve_actor_id, resolve_locale, resolve_session_id

MAX_PROMPT_CHARS = 2000
MAX_GROUNDING_BYTES = 16 * 1024


def parse_grounding(value: Any) -> dict | None:
    """Accept only the BFF's bounded, token-free current-place reference shape."""
    if value is None:
        return None

    def invalid():
        raise ValueError("invalid service grounding")

    def text(item, limit, empty=False):
        return isinstance(item, str) and len(item) <= limit and (empty or bool(item.strip())) \
            and not re.search(r"[\x00-\x1f\x7f]", item)

    def point(item):
        return isinstance(item, dict) and all(type(item.get(key)) in (int, float) and math.isfinite(item[key])
            for key in ("lat", "lng")) and 33.1 <= item["lat"] <= 33.6 and 126.15 <= item["lng"] <= 126.98

    def timestamp(item):
        if not text(item, 40):
            return False
        try:
            return datetime.fromisoformat(item.replace("Z", "+00:00")).tzinfo is not None
        except ValueError:
            return False

    def facts(item, depth=0):
        if depth > 10:
            return False
        if item is None or type(item) is bool:
            return True
        if type(item) in (int, float):
            return math.isfinite(item)
        if isinstance(item, str):
            return len(item) <= 2048
        if isinstance(item, list):
            return len(item) <= 64 and all(facts(child, depth + 1) for child in item)
        if isinstance(item, dict):
            return len(item) <= 64 and all(text(key, 160)
                and not re.search(r"token|secret|password|authorization|credential", key, re.I)
                and key not in {"__proto__", "constructor", "prototype"}
                and facts(child, depth + 1) for key, child in item.items())
        return False

    allowed = {"version", "kind", "status", "source", "category", "query", "items", "anchor", "queried_at", "message"}
    if not isinstance(value, dict) or set(value) != allowed:
        invalid()
    try:
        if len(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()) > MAX_GROUNDING_BYTES:
            invalid()
    except (ValueError, TypeError, UnicodeError):
        invalid()
    if type(value["version"]) is not int or value["version"] != 1 or value["source"] != "Kakao Local" \
            or not isinstance(value["kind"], str) or value["kind"] not in {"selection", "search"} \
            or not isinstance(value["status"], str) or value["status"] not in {"ready", "empty", "unavailable", "anchor_required"} \
            or not text(value["category"], 80, True) or not text(value["query"], 200, True) \
            or not text(value["message"], 500):
        invalid()
    items = value["items"]
    if not isinstance(items, list) or len(items) > 3 or bool(items) != (value["status"] == "ready"):
        invalid()
    if value["kind"] == "selection" and len(items) != 1:
        invalid()
    if items and not timestamp(value["queried_at"]) or not items and value["queried_at"] is not None:
        invalid()
    seen = set()
    fields = {"id", "name", "category", "lat", "lng", "source", "observed_at", "address", "phone", "url"}
    for item in items:
        if not isinstance(item, dict) or set(item) - fields - {"details"} or fields - set(item):
            invalid()
        pid = item["id"]
        if not isinstance(pid, str) or not re.fullmatch(r"kakao:[1-9]\d{0,19}", pid) or pid in seen \
                or not point(item) or not text(item["name"], 160) or not text(item["category"], 80) \
                or not text(item["address"], 320, True) or not text(item["phone"], 100, True) \
                or item["url"] != f"https://place.map.kakao.com/{pid[6:]}" \
                or item["source"] != "Kakao Local" or item["observed_at"] != value["queried_at"]:
            invalid()
        if "details" in item and (not isinstance(item["details"], dict) or not facts(item["details"])):
            invalid()
        seen.add(pid)
    anchor = value["anchor"]
    if anchor is not None and (not point(anchor) or set(anchor) != {"id", "name", "lat", "lng"}
            or not text(anchor["id"], 256) or not text(anchor["name"], 160)):
        invalid()
    return deepcopy(value)


@dataclass(frozen=True)
class TurnRequest:
    prompt: str
    actor_id: str
    conversation_id: str      # resolved runtimeSessionId — Memory session + agent-cache key
    locale: Locale
    stream: bool
    grounding: dict | None = None


def parse_payload(payload: Any, context: Any = None) -> TurnRequest:
    if not isinstance(payload, dict):
        raise ValueError("payload must be a JSON object")
    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("prompt must be a non-empty string")
    prompt = prompt.strip()
    if len(prompt) > MAX_PROMPT_CHARS:
        raise ValueError(f"prompt exceeds {MAX_PROMPT_CHARS} characters")
    if "selection_token" in payload:
        raise ValueError("invalid service grounding")
    grounding = parse_grounding(payload.get("grounding"))
    session_id = resolve_session_id(context, payload)
    return TurnRequest(
        prompt=prompt,
        actor_id=resolve_actor_id(payload, default=anon_actor_for_session(session_id)),
        conversation_id=session_id,
        locale=resolve_locale(payload),
        stream=bool(payload.get("stream", False)),
        grounding=grounding,
    )


def prompt_for_locale(prompt: str, locale: Locale) -> str:
    return f"[locale: en] {prompt}" if locale == "en" else prompt


@dataclass(frozen=True)
class WarmRequest:
    # None when the payload named no actor under any of identity.ACTOR_KEYS: the caller must build no Agent —
    # an anonymous per-call actor would otherwise seed a throwaway Memory namespace for a conversation nobody
    # owns.
    actor_id: str | None
    conversation_id: str      # resolved runtimeSessionId — same rule as TurnRequest.conversation_id


def is_warm_payload(payload: Any) -> bool:
    """True for the pre-warm shape {"warm": true, ...} — checked BEFORE parse_payload, which would
    otherwise reject it for missing `prompt`."""
    return isinstance(payload, dict) and bool(payload.get("warm", False))


def parse_warm_payload(payload: Any, context: Any = None) -> WarmRequest:
    """Resolve session/actor for a warm payload. Reuses resolve_session_id/resolve_actor_id — the same
    rules parse_payload uses — so a warm ping and the real turn that follows it agree on both."""
    session_id = resolve_session_id(context, payload)
    # has_actor_id and resolve_actor_id read the same ACTOR_KEYS tuple, so any payload whose actor
    # parse_payload would accept builds an Agent here too — never "actor known, but agent: false".
    actor_id = resolve_actor_id(payload, default=anon_actor_for_session(session_id)) if has_actor_id(payload) else None
    return WarmRequest(actor_id=actor_id, conversation_id=session_id)
