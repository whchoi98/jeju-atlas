"""Derive MapResponseV2 from the turn's tool results — the `derive` streaming mode (perf-routing plan 08).

Why: in `single` mode the model must call the MapResponseV2 structured-output tool after it has already
written the answer, and that extra model round trip measured ~5.1 s of the turn (plan 08 기준선 table).
Every coordinate in that map came from a tool result this process already holds, so the server assembles
the map itself: the model streams prose only and the map costs zero model round trips.

What this module does NOT do:
- it never invents coordinates — every lat/lng is copied verbatim from a tool result;
- it never filters by bbox. Rejecting out-of-Jeju coordinates (and reporting them in `warnings`) is
  MapResponseV2's single responsibility, so the assembled dict is handed to `parse_map_response_v2` as is.

Field types ARE normalised (a `summary: null` from one tool must not make the whole map fall back to the
contract's lenient path and pick up a `lenient_parse` warning), and every hard size cap the contract would
otherwise trigger on — markers, route points and warnings — is applied here for the same reason. The
contract *rejects* an over-long `warnings` list (`Field(max_length=MAX_WARNINGS)`) rather than truncating
it, and `lenient_parse` is rendered to the user as a degradation notice
(the Atlas guide UI), so a single chatty tool must not be able to label a
server-assembled map as malformed. The trim leaves MAX_WARNINGS - MAX_DERIVED_WARNINGS slots for the
warnings the contract itself appends after validation (bbox rejections), which are the actionable ones.
"""
from __future__ import annotations

import json
import logging
import math
import unicodedata
from datetime import datetime
from typing import Any

from pydantic import ValidationError

from atlas_contracts import (
    MAX_ANSWER_CHARS,
    MAX_MARKERS_V2,
    MAX_ROUTE_POINTS,
    MAX_WARNINGS,
    MapResponseV2,
    parse_map_response_v2,
)

log = logging.getLogger(__name__)

STRIP_PREFIX = "jejuatlastools_"   # Gateway prefixes every MCP tool name
UNKNOWN_TOOL = "tool"
UNKNOWN_PROVIDER = "unknown"
DEFAULT_CATEGORY = "장소"
EMPTY_ANSWER = "죄송합니다. 답변을 생성하지 못했습니다."
EMPTY_ANSWER_WARNING = "empty_answer"
MIN_MENTION_CHARS = 2             # a 1-char place name matches almost any sentence — never treat it as a mention
MARKER_KEYS = ("id", "name", "lat", "lng", "category", "summary", "source", "observed_at", "url", "phone", "hours", "distance_m")
OPTIONAL_TEXT_KEYS = ("source", "observed_at", "url", "phone", "hours")
# Marker candidates in priority order: when more than MAX_MARKERS_V2 survive, the search results the user
# asked for must outrank a background layer's charger/parking pins.
MARKER_TOOLS = ("find_places", "place_detail", "festivals", "layer")
ZOOM_ONE_MARKER = 15
ZOOM_ISLAND = 10                  # Jeju as a whole
ZOOM_LADDER = ((0.04, 14), (0.12, 13), (0.35, 12))   # (max bbox span in degrees, zoom)
BBOX_WARNING_RESERVE = 4          # slots left for the bbox rejections MapResponseV2 appends after validation
MAX_DERIVED_WARNINGS = MAX_WARNINGS - BBOX_WARNING_RESERVE

Response = tuple[str, dict[str, Any]]   # (tool name, one JSON object the tool returned)


def _norm(text: str) -> str:
    """NFC + casefold + whitespace removed — how a place name is matched against the answer's prose."""
    return "".join(unicodedata.normalize("NFC", text or "").split()).casefold()


def short_name(name: str) -> str:
    return name[len(STRIP_PREFIX):] if name.startswith(STRIP_PREFIX) else name


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _coord(raw: Any) -> tuple[float, float] | None:
    if not isinstance(raw, dict):
        return None
    lat, lng = _number(raw.get("lat")), _number(raw.get("lng"))
    return None if lat is None or lng is None else (lat, lng)


def _latlng(lat: float, lng: float) -> dict[str, float]:
    return {"lat": lat, "lng": lng}


def payload_dicts(tool_result: Any) -> list[dict[str, Any]]:
    """Every JSON object one strands tool_result carries — `{"text": "<json>"}` or `{"json": {...}}` blocks."""
    out: list[dict[str, Any]] = []
    if not isinstance(tool_result, dict):
        return out
    for block in tool_result.get("content") or []:
        if not isinstance(block, dict):
            continue
        if isinstance(block.get("json"), dict):
            out.append(block["json"])
            continue
        raw = block.get("text")
        if not isinstance(raw, str):
            continue
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, TypeError, ValueError):
            continue
        if isinstance(data, dict):
            out.append(data)
    return out


def infer_tool(payload: dict[str, Any]) -> str:
    """Name the tool a response came from by its keys — the fallback when no toolUseId→name was recorded."""
    items = payload.get("items")
    has_items = isinstance(items, list)
    if has_items and "anchor" in payload:
        return "find_places"
    if has_items and "layer" in payload:
        return "layer"
    if "polyline" in payload:
        return "route"
    if "itinerary" in payload:
        return "plan_day"
    if "hourly" in payload or "now" in payload:
        return "weather"
    if "sunrise" in payload:
        return "sun_times"
    if "deeplinks" in payload:
        return "place_detail"
    if has_items and any(isinstance(i, dict) and "start" in i for i in items):
        return "festivals"
    return UNKNOWN_TOOL


def responses(tool_results: list[dict] | None, tool_names: dict[str, str] | None = None) -> list[Response]:
    """Pair every tool payload with its tool name (recorded toolUseId→name first, key inference second)."""
    names = {tid: short_name(name) for tid, name in (tool_names or {}).items() if isinstance(name, str) and name}
    out: list[Response] = []
    for tr in tool_results or []:
        tid = tr.get("toolUseId") if isinstance(tr, dict) else None
        if isinstance(tr, dict) and tr.get("status") == "error":
            # An MCP isError result (or strands' tool-budget/cancel error) may still carry a JSON body; it must
            # never seed markers/center. Keep only a warning (adversarial review of d8ec287, "should guard").
            out.append((names.get(tid) or UNKNOWN_TOOL, {"error": "error", "message": _error_text(tr), "fallback": True}))
            continue
        for payload in payload_dicts(tr):
            out.append((names.get(tid) or infer_tool(payload), payload))
    return out


def _error_text(tool_result: dict[str, Any], limit: int = 200) -> str:
    texts = [b["text"] for b in tool_result.get("content") or [] if isinstance(b, dict) and isinstance(b.get("text"), str)]
    return " ".join(texts).strip()[:limit]


def _iso8601(value: Any) -> str | None:
    """Return the stripped `value` when it parses as ISO 8601 (the contract's `_iso8601_or_none` rule), else None.

    The contract validator does NOT strip, so a padded timestamp that passes here must be stored stripped —
    returning the raw value would let MarkerV2/Source raise and push the whole map through lenient_parse
    (adversarial review of d8ec287, majors #1/#2)."""
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    try:
        datetime.fromisoformat(stripped.replace("Z", "+00:00"))
    except ValueError:
        return None
    return stripped or None


def _marker(raw: Any, *, category: str | None = None, summary: str | None = None) -> dict[str, Any] | None:
    """Project one tool row onto the MarkerV2 key set. None when it cannot be a marker (no id/name/coords)."""
    coord = _coord(raw)
    if coord is None:
        return None
    pid, name = str(raw.get("id") or "").strip(), str(raw.get("name") or "").strip()
    if not pid or not name:
        return None
    marker: dict[str, Any] = {"id": pid, "name": name, "lat": coord[0], "lng": coord[1]}
    cat = category if category is not None else raw.get("category")
    marker["category"] = cat.strip() if isinstance(cat, str) and cat.strip() else DEFAULT_CATEGORY
    text = summary if summary is not None else raw.get("summary")
    marker["summary"] = text if isinstance(text, str) else ""
    for key in OPTIONAL_TEXT_KEYS:
        value = raw.get(key)
        if isinstance(value, str) and value.strip():
            if key == "observed_at":
                iso = _iso8601(value)
                if iso is None:
                    continue  # MarkerV2 *rejects* a non-ISO timestamp; dropping the field keeps the marker
                value = iso
            marker[key] = value
    distance = raw.get("distance_m")
    if isinstance(distance, (int, float)) and not isinstance(distance, bool) and math.isfinite(distance) and distance >= 0:
        marker["distance_m"] = int(distance)  # json.loads accepts Infinity/NaN; int(inf) raises OverflowError
    return marker


def _marker_candidates(items: list[Response]) -> list[dict[str, Any]]:
    """Candidates grouped by MARKER_TOOLS priority; inside one group, tool order then row order."""
    by_tool: dict[str, list[dict[str, Any]]] = {tool: [] for tool in MARKER_TOOLS}
    for tool, payload in items:
        if tool not in by_tool:
            continue
        if tool == "place_detail":
            candidate = _marker(payload)
            if candidate is not None:
                by_tool[tool].append(candidate)
            continue
        layer_name = str(payload.get("layer") or "").strip() if tool == "layer" else ""
        for row in payload.get("items") or []:
            if not isinstance(row, dict):
                continue
            if tool == "layer":   # a layer row has no category/summary of its own
                candidate = _marker(row, category=layer_name or DEFAULT_CATEGORY, summary=str(row.get("status") or ""))
            else:
                candidate = _marker(row)
            if candidate is not None:
                by_tool[tool].append(candidate)
    return [c for tool in MARKER_TOOLS for c in by_tool[tool]]


def _order_by_answer(candidates: list[dict[str, Any]], answer: str) -> list[dict[str, Any]]:
    """Places the answer names come first, in the order the answer names them; the rest keep tool order.

    A 15-row find_places result must be trimmed to the 12 places the user is reading about, not to the
    first 12 rows — a marker the answer mentions and the map omits is the worst outcome for the renderer.
    """
    haystack = _norm(answer)
    mentioned: list[tuple[int, int, dict[str, Any]]] = []
    rest: list[dict[str, Any]] = []
    for i, candidate in enumerate(candidates):
        needle = _norm(candidate["name"])
        at = haystack.find(needle) if len(needle) >= MIN_MENTION_CHARS else -1
        if at >= 0:
            mentioned.append((at, i, candidate))
        else:
            rest.append(candidate)
    mentioned.sort(key=lambda m: (m[0], m[1]))
    return [c for _at, _i, c in mentioned] + rest


def _dedupe_markers(markers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for marker in markers:
        if marker["id"] in seen:
            continue
        seen.add(marker["id"])
        out.append(marker)
    return out


def _latlngs(raw: Any) -> list[dict[str, float]]:
    points: list[dict[str, float]] = []
    for item in raw if isinstance(raw, list) else []:
        coord = _coord(item)
        if coord is not None:
            points.append(_latlng(*coord))
    return points[:MAX_ROUTE_POINTS]


def _route_meta(payload: dict[str, Any]) -> dict[str, Any] | None:
    meta = payload.get("route_meta")
    if isinstance(meta, dict):
        return meta
    built = {k: payload[k] for k in ("mode", "distance_m", "duration_s", "provider") if payload.get(k) is not None}
    return built or None


def _route(items: list[Response]) -> tuple[list[dict[str, float]], dict[str, Any] | None]:
    """`route`'s polyline wins; a plan_day itinerary's own overview route is the fallback."""
    for tool in ("route", "plan_day"):
        for name, payload in items:
            if name != tool:
                continue
            points = _latlngs(payload.get("polyline") if tool == "route" else payload.get("route"))
            if points:
                return points, _route_meta(payload)
    return [], None


def _itinerary(items: list[Response]) -> dict[str, Any] | None:
    for tool, payload in items:
        if tool == "plan_day" and isinstance(payload.get("itinerary"), dict):
            return payload["itinerary"]
    return None


def _center(items: list[Response], markers: list[dict[str, Any]], route: list[dict[str, float]]) -> dict[str, float] | None:
    """find_places anchor → find_places center → first marker → first route point → None."""
    for key in ("anchor", "center"):
        for tool, payload in items:
            if tool != "find_places":
                continue
            coord = _coord(payload.get(key))
            if coord is not None:
                return _latlng(*coord)
    if markers:
        return _latlng(markers[0]["lat"], markers[0]["lng"])
    if route:
        return _latlng(route[0]["lat"], route[0]["lng"])
    return None


def _zoom(markers: list[dict[str, Any]], route: list[dict[str, float]]) -> int:
    points = [(m["lat"], m["lng"]) for m in markers] + [(p["lat"], p["lng"]) for p in route]
    if not points:
        return ZOOM_ISLAND
    if len(markers) == 1 and not route:
        return ZOOM_ONE_MARKER
    lats, lngs = [p[0] for p in points], [p[1] for p in points]
    span = max(max(lats) - min(lats), max(lngs) - min(lngs))
    for limit, zoom in ZOOM_LADDER:
        if span <= limit:
            return zoom
    return ZOOM_ISLAND


def _sources(items: list[Response]) -> list[dict[str, Any]]:
    """find_places `sources` entries plus one entry per response that names a `source`; deduped."""
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str | None]] = set()

    def add(provider: Any, label: Any, observed_at: Any) -> None:
        if not isinstance(label, str) or not label.strip():
            return
        entry = {
            "provider": provider.strip() if isinstance(provider, str) and provider.strip() else UNKNOWN_PROVIDER,
            "label": label,
            "observed_at": _iso8601(observed_at),  # Source runs the same ISO validator as MarkerV2
        }
        key = (entry["provider"], entry["label"], entry["observed_at"])
        if key in seen:
            return
        seen.add(key)
        out.append(entry)

    for _tool, payload in items:
        for entry in payload.get("sources") or []:
            if isinstance(entry, dict):
                add(entry.get("provider"), entry.get("label"), entry.get("observed_at"))
        add(payload.get("provider"), payload.get("source"), payload.get("observed_at"))
    return out


def _warnings(items: list[Response]) -> list[str]:
    """Each response's own warnings, plus one line per fallback / stale / error — prefixed with the tool."""
    out: list[str] = []
    seen: set[str] = set()

    def add(warning: str) -> None:
        if warning and warning not in seen:
            seen.add(warning)
            out.append(warning)

    for tool, payload in items:
        for warning in payload.get("warnings") or []:
            if isinstance(warning, str):
                add(warning)
        if payload.get("fallback") is True:
            detail = payload.get("message") or payload.get("error")
            add(f"{tool}: fallback — {detail}" if isinstance(detail, str) and detail.strip() else f"{tool}: fallback")
        if payload.get("stale") is True:
            add(f"{tool}: stale")
        error = payload.get("error")
        if isinstance(error, str) and error.strip():
            add(f"{tool}: {error}")
    return out


def _validate(data: dict[str, Any], model: type[MapResponseV2]) -> MapResponseV2:
    if model is MapResponseV2:
        return parse_map_response_v2(data)
    try:                                  # a subclass (a test double / future contract variant) keeps its type
        return model.model_validate(data)
    except ValidationError:
        return parse_map_response_v2(data)


def derive_map(text: str, tool_results: list[dict], *, tool_names: dict[str, str] | None = None,
               model: type[MapResponseV2] = MapResponseV2) -> MapResponseV2:
    """Build one MapResponseV2 from the streamed answer `text` and the turn's raw strands tool results.

    `tool_names` maps toolUseId → tool name (recorded by streaming.map_event from `tool_use_stream`
    events); tools missing from it are identified by the keys of their response.
    """
    items = responses(tool_results, tool_names)
    answer = (text or "").strip()
    # Trimmed here, not passed through: over-length warnings FAIL strict validation and the lenient
    # fallback stamps `lenient_parse` on a map this server built itself (see module docstring). The
    # tool-supplied warnings are what can run long, so the trim lands on them and this module's own
    # signals below always survive it.
    warnings = _warnings(items)[:MAX_DERIVED_WARNINGS]
    if not answer:
        answer = EMPTY_ANSWER
        warnings = [*warnings, EMPTY_ANSWER_WARNING]
    answer = answer[:MAX_ANSWER_CHARS]
    markers = _dedupe_markers(_order_by_answer(_marker_candidates(items), answer))[:MAX_MARKERS_V2]
    route, route_meta = _route(items)
    data = {
        "version": "2",
        "answer": answer,
        "center": _center(items, markers, route),
        "zoom": _zoom(markers, route),
        "markers": markers,
        "route": route,
        "route_meta": route_meta,
        "itinerary": _itinerary(items),
        "sources": _sources(items),
        "warnings": warnings,
    }
    log.debug("derived map from %d tool payloads: %d markers, %d route points", len(items), len(markers), len(route))
    return _validate(data, model)
