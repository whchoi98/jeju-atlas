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
from typing import Any

from .identity import Locale, anon_actor_for_session, has_actor_id, resolve_actor_id, resolve_locale, resolve_session_id

MAX_PROMPT_CHARS = 2000


@dataclass(frozen=True)
class TurnRequest:
    prompt: str
    actor_id: str
    conversation_id: str      # resolved runtimeSessionId — Memory session + agent-cache key
    locale: Locale
    stream: bool


def parse_payload(payload: Any, context: Any = None) -> TurnRequest:
    if not isinstance(payload, dict):
        raise ValueError("payload must be a JSON object")
    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("prompt must be a non-empty string")
    prompt = prompt.strip()
    if len(prompt) > MAX_PROMPT_CHARS:
        raise ValueError(f"prompt exceeds {MAX_PROMPT_CHARS} characters")
    session_id = resolve_session_id(context, payload)
    return TurnRequest(
        prompt=prompt,
        actor_id=resolve_actor_id(payload, default=anon_actor_for_session(session_id)),
        conversation_id=session_id,
        locale=resolve_locale(payload),
        stream=bool(payload.get("stream", False)),
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
