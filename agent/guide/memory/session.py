"""AgentCore Memory session manager + the Kakao storage guard.

Spec §4: Kakao responses (Local/Mobility) are **display-only — storage prohibited**, and §8 rates one
terms-of-service breach as an account-level risk. AgentCore Memory persists conversation events for
`eventExpiryDuration` (30 days) and its SEMANTIC/EPISODIC strategies extract facts out of them, so an
un-guarded `find_places` toolResult would put `kakao:<id>` + coordinates into durable storage.
`should_truncate_results=True` only shrinks the model context; it does not stop the write. The guard
therefore lives at the single write funnel: `KakaoRedactingSessionManager` below redacts a COPY of each
message on its way to AgentCore (the live in-memory turn keeps the full data the model needs).
"""
import json
import os
import re
import uuid
from dataclasses import replace
from typing import Any, Optional

from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig, RetrievalConfig
from bedrock_agentcore.memory.integrations.strands.session_manager import AgentCoreMemorySessionManager

MEMORY_ENV = "ATLAS_MEMORY_ID"  # injected from the dedicated Memory in infra/agentcore.yaml
REGION = os.getenv("AWS_REGION")

KAKAO_ID_PREFIX = "kakao:"
REDACTED_ID = "kakao:redacted"
KAKAO_PROVIDER = "kakao"
COORD_KEYS = ("lat", "lng")
KAKAO_URL_KEYS = ("url", "kakao_place_url", "kakao_map", "kakao_navi")
GEOMETRY_KEYS = ("polyline", "route")
_KAKAO_ID_RE = re.compile(r"kakao:\d+")


def retrieval_namespaces(actor_id: str, session_id: str) -> dict[str, RetrievalConfig]:
    """facts/preferences at 0.3 so dietary/companion/transport preferences surface for loosely related asks (8장 #19).

    The dedicated SUMMARIZATION strategy stores under `/summaries/{actorId}/{sessionId}` (see
    infra/agentcore.yaml), and the deploy-time IAM policy grants
    `RetrieveMemoryRecords` on `/summaries/*/*` to match that template. Retrieval must therefore use the
    same session-scoped path: confirmed via Task 16 deploy smoke that `/summaries/{actor_id}` alone (no
    session segment) does not match `/summaries/*/*` and every retrieval call is denied with
    `AccessDeniedException` — see CloudWatch `/aws/bedrock-agentcore/runtimes/...` for the failing calls.
    """
    return {
        f"/users/{actor_id}/facts": RetrievalConfig(top_k=5, relevance_score=0.3),
        f"/users/{actor_id}/preferences": RetrievalConfig(top_k=5, relevance_score=0.3),
        f"/episodes/{actor_id}/{session_id}": RetrievalConfig(top_k=5, relevance_score=0.5),
        f"/summaries/{actor_id}/{session_id}": RetrievalConfig(top_k=3, relevance_score=0.5),
    }


def _is_kakao_item(value: dict[str, Any]) -> bool:
    return isinstance(value.get("id"), str) and value["id"].startswith(KAKAO_ID_PREFIX)


def redact_kakao(value: Any) -> Any:
    """Recursively remove Kakao ids, coordinates and geometry from a decoded tool payload.

    Kept: names, categories, addresses, distances and durations — facts the assistant may recall.
    Removed: `kakao:<id>` (→ `kakao:redacted`) anywhere, including inside free-text strings; the item's
    lat/lng; Kakao URLs carrying the id; and the coordinate geometry of a Kakao-provided route.

    Known limit: a bare `{"lat": …, "lng": …}` the model copied out of a Kakao result into a tool argument
    is indistinguishable from catalog coordinates, so coordinates are nulled only on a dict that carries a
    `kakao:` id. Ids, URLs and geometry — what the terms actually name — are always removed.
    """
    if isinstance(value, str):
        # Strings reach here from tool ARGUMENTS too (`place_detail(id="kakao:12345")`, a query echoing an
        # id). Measured on the deployed runtime before this branch existed: the literal id survived inside a
        # `toolUse.input` Memory event even though every text block was already masked (fix round 2 smoke A).
        return _KAKAO_ID_RE.sub(REDACTED_ID, value)
    if isinstance(value, list):
        return [redact_kakao(v) for v in value]
    if not isinstance(value, dict):
        return value
    out = {k: redact_kakao(v) for k, v in value.items()}
    if _is_kakao_item(out):
        out["id"] = REDACTED_ID
        for key in COORD_KEYS:
            if key in out:
                out[key] = None
        for key in KAKAO_URL_KEYS:
            if isinstance(out.get(key), str):
                out[key] = None
    if out.get("provider") == KAKAO_PROVIDER:
        for key in GEOMETRY_KEYS:
            if isinstance(out.get(key), list):
                out[key] = []
    return out


def redact_kakao_text(text: str) -> str:
    """Redact a tool-result text block. JSON payloads are decoded, redacted and re-serialised;
    anything else only has literal `kakao:<digits>` ids masked (never a partial JSON rewrite)."""
    stripped = text.strip()
    if stripped[:1] in ("{", "["):
        try:
            data = json.loads(stripped)
        except ValueError:
            data = None
        if isinstance(data, (dict, list)):
            return json.dumps(redact_kakao(data), ensure_ascii=False)
    return _KAKAO_ID_RE.sub(REDACTED_ID, text)


def _redact_block(block: Any) -> Any:
    if not isinstance(block, dict):
        return block
    tool_result = block.get("toolResult")
    if isinstance(tool_result, dict) and isinstance(tool_result.get("content"), list):
        return {**block, "toolResult": {**tool_result, "content": [_redact_block(b) for b in tool_result["content"]]}}
    tool_use = block.get("toolUse")
    if isinstance(tool_use, dict) and "input" in tool_use:
        # The model's own tool ARGUMENTS are persisted next to the results. A `place_detail(id="kakao:12345")`
        # call therefore wrote the raw id into Memory until this branch existed — found by the deployed smoke
        # the final review asked for, not by the unit tests (which only fed toolResult/text blocks).
        return {**block, "toolUse": {**tool_use, "input": redact_kakao(tool_use["input"])}}
    if isinstance(block.get("text"), str):
        return {**block, "text": redact_kakao_text(block["text"])}
    if isinstance(block.get("json"), (dict, list)):
        return {**block, "json": redact_kakao(block["json"])}
    return block


def redact_kakao_message(message: Any) -> Any:
    """Return a redacted COPY of a strands Message; the original (the live turn) is untouched."""
    if not isinstance(message, dict) or not isinstance(message.get("content"), list):
        return message
    return {**message, "content": [_redact_block(b) for b in message["content"]]}


def redact_transient_lookup_message(message: Any) -> Any:
    """Keep the user's question/preferences, omit a grounded turn's retrieved/derived data.

    Applies to copies used by Memory and by post-turn conversation cleanup.
    Live model input and the response being streamed remain untouched.
    """
    if not isinstance(message, dict) or not isinstance(message.get("content"), list):
        return message
    content = []
    for block in message["content"]:
        if not isinstance(block, dict):
            continue
        if isinstance(block.get("toolResult"), dict):
            content.append({"toolResult": {
                **block["toolResult"],
                "content": [{"text": "Transient place lookup results are not retained. Request current information again when needed."}],
            }})
        elif isinstance(block.get("toolUse"), dict):
            content.append({"toolUse": {**block["toolUse"], "input": {}}})
        elif message.get("role") == "assistant":
            content.append({"text": "The answer used transient place information that is not retained."})
        elif isinstance(block.get("text"), str):
            content.append(_redact_block(block))
        else:
            content.append({"text": "Transient reference data omitted."})
    return {**message, "content": content}


class KakaoRedactingSessionManager(AgentCoreMemorySessionManager):
    """AgentCoreMemorySessionManager that never persists Kakao ids/coordinates (spec §4)."""
    omit_lookup_content = False

    def append_message(self, message: Any, agent: Any, **kwargs: Any) -> None:
        # Redacting here (not only in create_message) also keeps the manager's `_latest_agent_message`
        # bookkeeping — which later update calls re-send — free of Kakao data.
        redact = redact_transient_lookup_message if self.omit_lookup_content else redact_kakao_message
        super().append_message(redact(message), agent, **kwargs)

    def create_message(self, session_id: str, agent_id: str, session_message: Any, **kwargs: Any) -> Optional[dict[str, Any]]:
        # Defence in depth: every write path (append_message, buffered flush, offload) funnels here.
        redact = redact_transient_lookup_message if self.omit_lookup_content else redact_kakao_message
        redacted = replace(session_message, message=redact(session_message.message))
        return super().create_message(session_id, agent_id, redacted, **kwargs)


def get_memory_session_manager(session_id: Optional[str], actor_id: str) -> Optional[AgentCoreMemorySessionManager]:
    memory_id = os.getenv(MEMORY_ENV)
    if not memory_id:
        return None

    # AgentCoreMemoryConfig rejects None; OAuth/CUSTOM_JWT callers can reach us
    # without a runtime session header, so synthesize one when absent.
    session_id = session_id or uuid.uuid4().hex

    return KakaoRedactingSessionManager(
        AgentCoreMemoryConfig(
            memory_id=memory_id,
            session_id=session_id,
            actor_id=actor_id,
            retrieval_config=retrieval_namespaces(actor_id, session_id),
        ),
        REGION,
    )
