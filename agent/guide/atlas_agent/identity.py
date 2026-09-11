"""Resolve actor (memory user), session (conversation) and locale for one invocation.

Facts (PLAN.md 8장 #19, bedrock-agentcore 1.22): RequestContext has `session_id` and `request_headers` but no user
id, and the runtime forwards no user-id header — the BFF puts `user_id` (= actor_id, sha256(...)[:32]) and
`conversation_id` (= runtimeSessionId, UUID4) in the payload. `agentcore invoke --user-id X` also sends `user_id`.
"""
from __future__ import annotations

import hashlib
import re
import uuid
from typing import Any, Literal

ANON_PREFIX = "anon-"
MAX_ACTOR_LEN = 128
# Every payload key that can name the actor. One tuple, read by both resolve_actor_id and has_actor_id, so
# "is an actor known?" and "which actor is it?" can never disagree (final review #5: parse_warm_payload asked
# about `user_id` alone and answered "agent": false for a payload that carried `actorId`).
ACTOR_KEYS = ("user_id", "actor_id", "userId", "actorId")
_HEX32 = re.compile(r"^[0-9a-f]{32}$")
_UNSAFE = re.compile(r"[^A-Za-z0-9._@:+-]")
_UUID36 = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

Locale = Literal["ko", "en"]


def anon_actor_for_session(session_id: str | None) -> str:
    """Per-conversation anonymous actor id — deliberately NOT one shared literal.

    Memory namespaces are per-actor (`/users/{actorId}/facts`, `/users/{actorId}/preferences`), so a
    literal default (the plan's `"anonymous"`) puts every caller that arrives without a `user_id` into
    ONE namespace: `agentcore invoke`, the W3 spike and deploy smokes would write there, and another
    caller's facts/preferences would be retrieved as if they were the current user's. Deriving the
    fallback from the session keeps a multi-turn anonymous conversation coherent (same actor across its
    own turns) while never mixing two conversations. No session → a single-use id.
    """
    seed = str(session_id or uuid.uuid4())
    return f"{ANON_PREFIX}{hashlib.sha256(seed.encode('utf-8')).hexdigest()[:32]}"


def has_actor_id(payload: Any) -> bool:
    """True when the payload names an actor under any key `resolve_actor_id` accepts (ACTOR_KEYS).

    The pre-warm path needs this distinction: with no actor it must build no Agent at all rather than seed a
    throwaway anonymous Memory namespace, so it asks "is an actor known?" before asking "which one?".
    """
    if not isinstance(payload, dict):
        return False
    return any(isinstance(payload.get(key), str) and payload[key].strip() for key in ACTOR_KEYS)


def resolve_actor_id(payload: Any, *, default: str | None = None) -> str:
    """Actor (Memory user) from the payload; `default` (else a per-call anonymous id) when absent."""
    fallback = default or anon_actor_for_session(None)
    if not isinstance(payload, dict):
        return fallback
    for key in ACTOR_KEYS:
        v = payload.get(key)
        if isinstance(v, str) and v.strip():
            v = v.strip()
            if _HEX32.match(v):
                return v
            return _UNSAFE.sub("_", v)[:MAX_ACTOR_LEN] or fallback
    return fallback


def resolve_session_id(context: Any, payload: Any) -> str:
    sid = getattr(context, "session_id", None) if context is not None else None
    if sid:
        return str(sid)
    conv = payload.get("conversation_id") if isinstance(payload, dict) else None
    if isinstance(conv, str) and _UUID36.match(conv):
        return conv
    return str(uuid.uuid4())


def resolve_locale(payload: Any) -> Locale:
    loc = payload.get("locale") if isinstance(payload, dict) else None
    return "en" if isinstance(loc, str) and loc.strip().lower() == "en" else "ko"


def short_actor(actor_id: str) -> str:
    """Log-safe prefix: never log the full actor id (spec §9 #4)."""
    return actor_id[:8]
