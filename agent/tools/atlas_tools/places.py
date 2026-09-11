"""find_places / place_detail — catalog (plan 5 FTS5 or bundled fallback) enriched with Kakao Local (display-only).

Kakao items are never persisted by this module (they are returned to the agent only); ids are prefixed `kakao:`.
Deep links follow the Kakao Maps URL scheme (apis.map.kakao.com/web/guide → "URL로 지도 보기"):
  https://map.kakao.com/link/map/<name>,<lat>,<lng>   https://map.kakao.com/link/to/<name>,<lat>,<lng>
"""
from __future__ import annotations

import re
import logging
import unicodedata
from typing import Any
from urllib.parse import quote

from . import catalog_client, geo
from .external import kakao_local, keys

log = logging.getLogger(__name__)

MAX_LIMIT = 12
ANCHOR_SEARCH_LIMIT = 50
DEDUPE_RADIUS_M = 100
MAX_SUGGEST_RADIUS_M = 20_000   # Kakao Local's own radius ceiling (PLAN.md 8장 #26)
CATALOG_LABEL = "오마이제주 카탈로그"
KAKAO_SOURCE = "카카오맵 REST API"
# perf-agent plan 06 Task 1: server-side auto radius widening for `near=`/lat+lng calls that omit
# radius_m — the model used to pick 3000 → 10000 → 20000 itself across several find_places calls
# (PLAN.md 8장 #28: up to 27 calls in one turn). Only applies when the caller passes no radius_m
# (Ruling R2); an explicit radius_m stays a hard bound and keeps the pre-existing suggest_radius_m
# behaviour below untouched.
WIDEN_RADII_M: tuple[int, ...] = (3000, 5000, 10000)
# Empty-result signals. A bare {"items": [], "total": 0} reads to the model as "try again, differently":
# the deployed spike measured up to 27 find_places calls in one turn as it widened radius_m and retried
# (PLAN.md 8장 #28). So an empty answer now says whether widening can possibly help, with data behind it.
EXHAUSTIVE_MESSAGE = ("카탈로그에 이 조건으로 일치하는 장소가 없습니다. radius_m 을 넓히거나 같은 검색어로 다시 호출해도 "
                      "결과는 같습니다(exhaustive). 검색어·카테고리를 바꾸거나 결과가 없다고 답하세요.")
# Final review finding #3 — this used to say "lat/lng 를 직접 지정해 다시 호출하세요", which the single-call
# prompt forbids (it tells the model never to pre-look-up coordinates). The only recovery the model can
# actually perform is a name search, so that is what the message now asks for.
NO_ANCHOR_MESSAGE = ("'{near}' 이름이 완전 일치하는 기준 장소를 확인하지 못했습니다(exhaustive). "
                     "near 없이 그 장소 이름을 query 로 넣어 한 번만 다시 검색하세요.")
AMBIGUOUS_ANCHOR_MESSAGE = ("'{near}' 이름이 완전 일치하는 장소가 여러 개라 기준점을 정하지 않았습니다. "
                            "더 구체적인 장소 이름으로 query 검색해 주세요.")
WIDEN_EXHAUSTED_MESSAGE = ("기준 위치에서 반경을 10km 까지 넓히고 반경 제한 없이 카탈로그 전체까지 확인했지만 조건에 맞는 결과가 "
                           "없습니다(exhaustive). 검색어·카테고리를 바꾸거나 결과가 없다고 답하세요.")
# Final review finding #1 (critical) — the widen ladder used to swallow every match beyond 10 km: before
# this plan, `radius_m=None` reached the catalog untouched and its documented policy ("non-empty q + center
# → the center only ORDERS the results", agent/tools/catalog.py) answered "카페 near 한라산" with the
# nearest café 13 km away. The ladder turned that into `items: []` + `exhaustive: true`. So when the ladder
# ends empty we redo the search with no radius at all — the pre-plan behaviour, in the SAME tool call.
UNBOUNDED_RESCUE_MESSAGE = ("반경 10km 안에는 없어 반경 제한 없이 가까운 순으로 찾은 결과입니다(가장 가까운 곳이 약 {nearest}m). "
                            "거리가 멀다는 사실을 답변에 밝히고, 반경을 바꿔 다시 호출하지 마세요.")
# Final review finding #7 — "limit 보다 적다" is NOT "카탈로그가 소진됐다". The shortfall gets its own field
# and is measured on the FINAL items (so Kakao filling the limit no longer trips it); `exhaustive` stays
# reserved for "재호출·확대로 더 얻을 것이 없다", which the unbounded rescue above can now actually prove.
FEWER_THAN_LIMIT_MESSAGE = ("반경 {radius}m 까지 넓혀 찾은 결과가 요청한 개수보다 적습니다. 이 기준 위치 근처에는 더 없으니 "
                            "반경을 바꿔 다시 호출하지 말고 지금 결과로 답하세요.")
# Final review finding #2 (high) — the first catalog hit for `near=` was trusted blindly, so near="제주공항"
# silently anchored on 용두암 (~5 km away) and the response `center` moved with it.
ANCHOR_MISMATCH_WARNING = "anchor: '{near}' → '{name}' — 이름이 정확히 일치하지 않는 기준 장소입니다"
NEAR_IGNORED_WARNING = "near: lat/lng 가 함께 주어져 near='{near}' 를 무시하고 그 좌표를 기준으로 검색했습니다"
# perf-routing Task 1 — shared by weather/sun_times/layer's `near=` support (anchor_for() below); the
# recovery this asks for is the only one those tools' callers can actually perform without lat/lng.
UNRESOLVABLE_NEAR_MESSAGE = "'{near}' 을(를) 카탈로그에서 찾을 수 없습니다. find_places 로 장소를 먼저 찾아 lat/lng 를 넘기세요."
# our categories → kakao_local.CATEGORY keys (None = no Kakao category filter)
KAKAO_CATEGORY: dict[str, str | None] = {"카페": "카페", "맛집": "음식점", "관광지": "관광명소", "박물관": "문화시설", "주차장": "주차장",
                                         "오름": None, "해변": None, "올레길": None, "시장": None}


def _norm(text: str) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFC", text or "")).casefold()


# Name equivalence only: coordinates always come from the selected catalog row.
# Arbitrary region prefixes and nearby business names are not aliases.
_ANCHOR_ALIASES = {
    _norm(alias): name
    for name, aliases in (
        ("성산일출봉", ("성산", "Seongsan", "Seongsan Ilchulbong", "Seongsan Ilchulbong Peak")),
        ("한라산국립공원", ("한라산", "Hallasan", "Hallasan National Park", "Halla mountain National Park")),
        ("협재해수욕장", ("협재", "Hyupjae", "Hyeopjae", "Hyupjae Beach", "Hyeopjae Beach")),
        ("제주국제공항", ("제주공항", "Jeju airport", "Jeju International Airport")),
    )
    for alias in aliases
}
_ANCHOR_CATEGORIES = {
    _norm("성산일출봉"): {"관광지", "오름"},
    _norm("한라산국립공원"): {"관광지"},
    _norm("협재해수욕장"): {"해변"},
    _norm("제주국제공항"): {"관광지", "공항", "교통시설"},
}
# Existing service identities, not inferred same-name/nearby merges. A preferred
# ID is usable only if its name and category pass the same exact checks.
_ANCHOR_SERVICE_IDS = {_norm("성산일출봉"): "poi_0008", _norm("협재해수욕장"): "poi_0057"}


def _clamp_limit(limit: Any) -> int:
    try:
        return max(1, min(int(limit), MAX_LIMIT))
    except (TypeError, ValueError):
        return 10


def _to_float(value: Any) -> float | None:
    """Best-effort numeric coercion — never raises (mirrors external.geo.parse_float)."""
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _marker(item: dict[str, Any]) -> dict[str, Any] | None:
    """Project a catalog item onto the MarkerV2 key set (extra keys are kept for place_detail).

    Returns None — never raises — when the row lacks a usable id/name/lat/lng (Global Constraint:
    an exception must never escape a tool; a malformed catalog row is dropped, not fatal).
    """
    if not isinstance(item, dict):
        return None
    pid, name = item.get("id"), item.get("name")
    lat, lng = _to_float(item.get("lat")), _to_float(item.get("lng"))
    if pid is None or not name or lat is None or lng is None:
        return None
    return {
        "id": str(pid), "name": str(name), "lat": lat, "lng": lng,
        "category": str(item.get("category") or "장소"), "summary": str(item.get("summary") or item.get("address") or ""),
        "source": item.get("source") or CATALOG_LABEL, "observed_at": item.get("observed_at"),
        "url": item.get("url"), "phone": item.get("phone"), "hours": item.get("hours"),
        "distance_m": item.get("distance_m"),
    }


def _kakao_marker(doc: dict[str, Any], observed_at: str) -> dict[str, Any] | None:
    if doc.get("lat") is None or doc.get("lng") is None or not doc.get("name"):
        return None
    category = str(doc.get("category") or "").split(">")[-1].strip() or "장소"
    return {
        "id": f"kakao:{doc.get('id')}", "name": str(doc["name"]), "lat": float(doc["lat"]), "lng": float(doc["lng"]),
        "category": category, "summary": str(doc.get("address") or ""),
        "source": KAKAO_SOURCE, "observed_at": observed_at, "url": doc.get("url"), "phone": doc.get("phone"),
        "hours": None, "distance_m": doc.get("distance_m"),
    }


def _is_duplicate(candidate: dict[str, Any], accepted: list[dict[str, Any]]) -> bool:
    cname = _norm(candidate["name"])
    for a in accepted:
        if _norm(a["name"]) == cname and geo.haversine_m(a["lat"], a["lng"], candidate["lat"], candidate["lng"]) <= DEDUPE_RADIUS_M:
            return True
    return False


def _warn(warnings: list[str], message: str) -> None:
    """Append a warning at most once — the catalog top-up below re-reads rows we already warned about."""
    if message not in warnings:
        warnings.append(message)


def _accept(raw_items: list[dict[str, Any]], accepted: list[dict[str, Any]], warnings: list[str], *,
            marker: Any, label: str) -> int:
    """Project, bbox-filter and dedupe candidates into `accepted`. Returns how many were added."""
    added = 0
    for raw in raw_items:
        m = marker(raw)
        if m is None:
            if label == "catalog":
                bad_id = raw.get("id") if isinstance(raw, dict) else None
                _warn(warnings, f"catalog: dropped malformed item {bad_id!r}")
            continue
        if not geo.in_jeju(m["lat"], m["lng"]):
            _warn(warnings, f"bbox: dropped {m['id']} ({m['lat']}, {m['lng']})")
            continue
        if not _is_duplicate(m, accepted):
            accepted.append(m)
            added += 1
    return added


def _add_catalog(q: str, lat: float | None, lng: float | None, radius_m: int | None, category: str | None,
                 budget: int, accepted: list[dict[str, Any]], warnings: list[str]) -> None:
    try:
        items = catalog_client.search(q, lat, lng, radius_m, category, budget)
    except Exception as exc:  # noqa: BLE001 — tool contract: never raise
        _warn(warnings, f"catalog: {type(exc).__name__}")
        return
    _accept(items, accepted, warnings, marker=_marker, label="catalog")


def _empty_result_signal(q: str, lat: float | None, lng: float | None, radius_m: int | None, category: str | None,
                         budget: int, *, has_center: bool, kakao_error: str | None) -> dict[str, Any]:
    """Explain an empty `items` so the model stops guessing: is widening the radius pointless, or the fix?

    - Kakao failed → never claim exhaustion; one identical retry may succeed.
    - a radius was given and the same query DOES match outside it → hand back the distance and the radius
      to use, so one more call lands instead of a geometric climb (3000 → 10000 → 20000 → …).
    - otherwise (no radius, or nothing matches at any distance) → `exhaustive: true`.
    """
    if kakao_error is not None:
        return {"exhaustive": False,
                "message": f"카카오 검색이 실패했고(오류 {kakao_error}) 카탈로그에도 결과가 없습니다. 잠시 후 같은 인자로 한 번만 다시 호출해 보세요."}
    if has_center and radius_m is not None:
        try:
            probe = list(catalog_client.search(q, lat, lng, None, category, budget))
        except Exception as exc:  # noqa: BLE001 — tool contract: never raise
            return {"exhaustive": False, "message": f"카탈로그 확인 중 오류가 발생했습니다({type(exc).__name__})."}
        distances = sorted(int(d) for p in probe if (d := _to_float(p.get("distance_m"))) is not None)
        if distances:
            nearest = distances[0]
            common = {"exhaustive": False, "found_outside_radius": len(distances), "nearest_m": nearest}
            if nearest >= MAX_SUGGEST_RADIUS_M:
                # Suggesting the 20 km ceiling when the match sits 29 km away would send the model on
                # another round trip that also returns nothing. Drop the radius instead.
                return {**common, "message": f"반경 {int(radius_m)}m 안에는 없고, 가장 가까운 결과도 약 {nearest}m 로 반경 검색 상한"
                                             f"({MAX_SUGGEST_RADIUS_M}m)을 넘습니다. radius_m 없이 이름으로 한 번만 다시 검색하세요."}
            suggest = min(MAX_SUGGEST_RADIUS_M, (nearest // 1000 + 1) * 1000)
            return {**common, "suggest_radius_m": suggest,
                    "message": f"반경 {int(radius_m)}m 안에는 없지만 약 {nearest}m 거리에 {len(distances)}건 있습니다. "
                               f"radius_m={suggest} 로 한 번만 다시 호출하세요."}
    return {"exhaustive": True, "message": EXHAUSTIVE_MESSAGE}


def _anchor_english_names(hits: list[dict[str, Any]]) -> dict[str, str]:
    """Recover name_en omitted by legacy projections, for the bounded hits only.

    Search already loaded the backend. Reuse its existing read-only catalog or
    bundled data; never discover another data source.
    """
    backend = getattr(catalog_client, "_backend", None)
    if backend is None:
        return {}
    try:
        if callable(getattr(backend, "get_catalog", None)):
            getter = backend.get_catalog().get
        elif callable(getattr(backend, "load_pois", None)):
            by_id = {item["id"]: item for item in backend.load_pois()}
            getter = by_id.get
        else:
            return {}
        names = {}
        for hit in hits:
            if not isinstance(hit, dict) or "name_en" in hit or hit.get("id") is None:
                continue
            raw = getter(hit["id"])
            if isinstance(raw, dict) and raw.get("name") == hit.get("name") and isinstance(raw.get("name_en"), str):
                names[str(hit["id"])] = raw["name_en"]
        return names
    except Exception:  # noqa: BLE001
        return {}


def _exact_catalog_matches(query: str, hits: list[dict[str, Any]]) -> dict[str, dict[str, Any]] | None:
    """Validate full-name identities shared by nearby anchors and named searches."""
    target = _norm(query)
    english = _anchor_english_names(hits) if re.search(r"[A-Za-z]", query) else {}
    matches: dict[str, dict[str, Any]] = {}
    for hit in hits:
        if not isinstance(hit, dict) or hit.get("id") is None or not isinstance(hit.get("name"), str):
            continue
        pid = str(hit["id"])
        if not pid.strip() or not hit["name"].strip():
            continue
        name_en = hit.get("name_en") or english.get(pid)
        labels = [hit["name"], name_en] if isinstance(name_en, str) else [hit["name"]]
        if not any(_norm(label) == target for label in labels):
            continue
        allowed = _ANCHOR_CATEGORIES.get(target)
        if allowed is not None and hit.get("category") not in allowed:
            continue
        lat, lng = _to_float(hit.get("lat")), _to_float(hit.get("lng"))
        if lat is None or lng is None or not geo.in_jeju(lat, lng):
            continue
        anchor = {"id": pid, "name": hit["name"], "lat": lat, "lng": lng}
        if pid in matches and matches[pid] != anchor:
            return None
        matches[pid] = anchor
    return matches


def _prioritize_name_rows(query: str, rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Keep exact identities ahead of text-ranked businesses without changing rows."""
    rows = rows[:ANCHOR_SEARCH_LIMIT]
    matches = _exact_catalog_matches(query, rows) if query and len(query) <= 200 else {}
    preferred = _ANCHOR_SERVICE_IDS.get(_norm(query))
    ranks = {pid: 0 if pid == preferred else 1 for pid in (matches or {})}
    ordered = sorted(rows, key=lambda row: ranks.get(str(row.get("id")), 2) if isinstance(row, dict) else 2)
    return ordered, ranks


def _resolve_anchor_result(near: str) -> tuple[dict[str, Any] | None, str]:
    name = str(near or "").strip()
    if not name or len(name) > 200:
        return None, "not_found"
    query = _ANCHOR_ALIASES.get(_norm(name), name)
    target = _norm(query)
    try:
        hits = catalog_client.search(query, None, None, None, None, ANCHOR_SEARCH_LIMIT)[:ANCHOR_SEARCH_LIMIT]
    except Exception:  # noqa: BLE001 — tools return an error envelope, never raise
        return None, "unavailable"
    matches = _exact_catalog_matches(query, hits)
    if matches is None:
        return None, "ambiguous"
    preferred = _ANCHOR_SERVICE_IDS.get(target)
    if preferred in matches:
        return matches[preferred], "exact"
    if len(matches) == 1:
        return next(iter(matches.values())), "exact"
    return None, "ambiguous" if matches else "fuzzy" if hits else "not_found"


def resolve_anchor(near: str) -> dict[str, Any] | None:
    """Resolve a reliable full name/name_en match or declared landmark alias.

    Rank is not identity. Partial, unrelated and ambiguous hits produce no
    anchor. Preserve the public `{id, name, lat, lng}` shape and stored values.
    """
    return _resolve_anchor_result(near)[0]


# perf-routing Task 1: pre-existing name kept as a public alias — this module's own `find_places` used
# it before `near=` support existed elsewhere, and nothing outside this file imported the underscored
# name, but the plan's "기존 이름은 alias 유지" ruling keeps it callable either way.
_resolve_anchor = resolve_anchor


def _anchor_match(near: str, name: str) -> str:
    """Exact full name, declared alias, or confirmed full name_en equivalence.

    The legacy anchor shape lacks name_en. An unregistered English name needs
    one additional bounded lookup to confirm its already selected Korean name.
    """
    a, b = _norm(near), _norm(name)
    canonical = _norm(_ANCHOR_ALIASES.get(a, near))
    if canonical and b and canonical == b:
        return "exact"
    if a not in _ANCHOR_ALIASES and re.search(r"[A-Za-z]", near):
        anchor = resolve_anchor(near)
        if anchor is not None and _norm(anchor["name"]) == b:
            return "exact"
    return "fuzzy"


def anchor_for(near: str, *, provider: str) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Resolve `near=` for weather/sun_times/layer — the same catalog lookup `find_places` uses for its
    own `near=` anchor, shared here so those three tools do not each re-implement it (perf-routing plan
    Task 1). `provider` is the CALLING tool's own fallback provider label (e.g. "kma", "astral",
    "snapshot") so an unresolvable name still errors in that tool's usual shape.

    Returns `(anchor, None)` — `anchor` is the plain `{id, name, lat, lng}` shape, WITHOUT `anchor_match`;
    callers compute that themselves via `_anchor_match(near, anchor["name"])` because it is only needed
    on the success path, never on the error one. Returns `(None, error_response)` when `near` has no
    catalog match at all (including a blank/whitespace name). Never raises (tool contract)."""
    name = str(near or "").strip()
    anchor, resolution = _resolve_anchor_result(name)
    if anchor is None:
        message = AMBIGUOUS_ANCHOR_MESSAGE if resolution == "ambiguous" else UNRESOLVABLE_NEAR_MESSAGE
        return None, {"error": "unresolvable_near", "message": message.format(near=name),
                      "fallback": True, "provider": provider}
    return anchor, None


def _is_anchor(item: dict[str, Any], anchor: dict[str, Any]) -> bool:
    """True when `item` (a catalog row or an already-projected marker) IS the anchor place itself —
    same name+location dedupe rule as `_is_duplicate` (100 m), so a Kakao duplicate of the anchor is
    excluded too, not just the catalog row that shares its id."""
    ilat, ilng = _to_float(item.get("lat")), _to_float(item.get("lng"))
    if ilat is None or ilng is None:
        return False
    return _norm(str(item.get("name") or "")) == _norm(anchor["name"]) and geo.haversine_m(ilat, ilng, anchor["lat"], anchor["lng"]) <= DEDUPE_RADIUS_M


def _anchor_fetch_budget(n: int, anchor: dict[str, Any] | None) -> int:
    """Fix round 1 (finding #1) — anchor exclusion happens AFTER a catalog fetch already capped at
    some row budget, so when the anchor place itself matches the query/category it can consume one
    of those rows (it always sorts first: distance 0 from its own coordinates), leaving one fewer
    genuine row than requested once it is filtered out. Asking for one extra row whenever an anchor
    is present absorbs exactly that slot, for both the widen probe and the real catalog fetch below."""
    return n + 1 if anchor is not None else n


def _accepted_count_excluding_anchor(accepted: list[dict[str, Any]], anchor: dict[str, Any] | None) -> int:
    """Fix round 2 (finding #1) — the Kakao top-up gate below decides "is `accepted` already full?"
    by `len(accepted)`, but the anchor place itself can be sitting in `accepted` at that point (it
    always sorts first, distance 0 from its own coordinates, so a query/category it matches lets it
    occupy one of the first catalog fetch's rows) and is always removed from the final response later.
    Counting it here would make an `accepted` that is really one short of `lim` look already full,
    silently skipping the top-up (and the paired `kakao: no_results` warning). At most one row in
    `accepted` can be the anchor (it is a single catalog row; `_is_duplicate` already prevents a
    second one being added under the same name+location), so subtracting 0/1 is exact, not a bound."""
    if anchor is None:
        return len(accepted)
    return len(accepted) - (1 if any(_is_anchor(m, anchor) for m in accepted) else 0)


def _rows_within_radius(q: str, lat: float | None, lng: float | None, radius_m: int | None, category: str | None, budget: int,
                        warnings: list[str]) -> list[dict[str, Any]]:
    """Catalog-only fetch used by the auto-widen loop below — never queries Kakao (Ruling R5: widening
    re-queries the catalog only, so Kakao is called at most once per find_places invocation).

    Final review finding #5 — the loop used to throw these rows away and end with one more catalog query
    carrying byte-identical arguments to its last probe (measured: 5 catalog queries per find_places).
    Returning the rows lets `find_places` hand the winning radius' rows straight to `_accept`. Slicing
    them to a smaller budget is exactly what a smaller-budget fetch would have returned: both backends
    sort deterministically (FTS5: rank, distance, name / bundled: distance, name) and then cut."""
    try:
        return list(catalog_client.search(q, lat, lng, radius_m, category, budget))
    except Exception as exc:  # noqa: BLE001 — tool contract: never raise
        _warn(warnings, f"catalog: {type(exc).__name__}")
        return []


def _count_excluding_anchor(rows: list[dict[str, Any]], anchor: dict[str, Any] | None) -> int:
    if anchor is None:
        return len(rows)
    return len([r for r in rows if not _is_anchor(r, anchor)])


def find_places(query: str, lat: float | None = None, lng: float | None = None, radius_m: int | None = None,
                category: str | None = None, limit: int = 10, near: str | None = None) -> dict[str, Any]:
    """장소를 이름·카테고리·주변 검색어로 찾아 카탈로그와 카카오맵 결과를 합쳐 반환합니다. 지도에 표시할 후보 장소가 필요할 때 사용하세요.

    query 는 검색어(비워도 lat/lng·near 로 주변 검색 가능), category 는 한글 카테고리, limit 은 최대 12.
    near 에 장소 이름(예: '성산일출봉')을 주면 카탈로그에서 그 장소를 찾아 기준점(anchor)으로 삼습니다 — lat/lng 를
    직접 계산할 필요가 없습니다. radius_m 을 생략하면(near 든 lat/lng 든) 3000 → 5000 → 10000m 순으로 서버가 직접
    반경을 넓히고, 10km 안에 하나도 없으면 반경 제한 없이 한 번 더 찾으므로 근처 검색은 near 하나의 호출로
    끝납니다: 반경을 바꿔 재호출하지 마세요.
    radius_m 을 직접 주면 그 값이 상한이며 서버는 넓히지 않습니다(기존 동작 유지).
    카카오 API 키(KAKAO_REST_API_KEY)가 있으면 결과를 병합·중복 제거하고, 제주 밖 결과는 제거하며 warnings 에 기록합니다.
    응답의 anchor(근처 검색의 기준 장소), anchor_match(exact|fuzzy — fuzzy 면 기준 장소가 다를 수 있으니 답변에 밝히세요),
    radius_used_m(실제 사용한 반경, null 이면 반경 제한 없이 찾은 먼 결과), widened(반경을 넓혔는지)를 참고하세요.
    `exhaustive: true`(더 넓혀도 결과 없음) 또는 `fewer_than_limit: true`(근처에 그만큼 없음)가 있으면 재호출하지 말고
    지금 결과로 답하세요. radius_m 을 직접 준 상태에서 0건이면 `suggest_radius_m`(그 값으로 한 번만 재호출)이 옵니다.
    """
    q = str(query or "").strip()
    caller_gave_radius = radius_m is not None
    caller_has_center = lat is not None and lng is not None

    warnings: list[str] = []
    anchor: dict[str, Any] | None = None
    anchor_match: str | None = None
    eff_lat, eff_lng = lat, lng
    if near is not None:
        # Fix round 1 (finding #2) — a blank/whitespace `near` (e.g. near="" or near="   ") must be
        # treated exactly like omitting `near` altogether, not like an unresolvable place name: only
        # short-circuit when an actual name was given and failed to resolve (`near_name` truthy).
        near_name = str(near).strip()
        if near_name and caller_has_center:
            # Final review finding #14 — `near` used to be dropped silently here (and with it the
            # anchor exclusion, so the base place itself came back among its own "근처" results).
            _warn(warnings, NEAR_IGNORED_WARNING.format(near=near_name))
        elif near_name:
            anchor, resolution = _resolve_anchor_result(near_name)
            if anchor is None:
                # The base place itself could not be resolved — there is nothing to search "near", so
                # this must NOT fall through to the plain catalog search below: with no center, a
                # non-empty query (e.g. "카페") would otherwise match anywhere on the island.
                return {
                    "items": [], "total": 0, "query": q, "center": None,
                    "sources": [{"provider": "catalog", "label": CATALOG_LABEL, "observed_at": None}],
                    "warnings": warnings, "provider": "catalog", "anchor": None,
                    "radius_used_m": None, "widened": False, "exhaustive": True,
                    "message": (AMBIGUOUS_ANCHOR_MESSAGE if resolution == "ambiguous" else NO_ANCHOR_MESSAGE).format(near=near_name),
                }
            eff_lat, eff_lng = anchor["lat"], anchor["lng"]
            anchor_match = _anchor_match(near_name, anchor["name"])
            if anchor_match != "exact":
                _warn(warnings, ANCHOR_MISMATCH_WARNING.format(near=near_name, name=anchor["name"]))

    has_center = eff_lat is not None and eff_lng is not None
    if not q and not has_center:
        return {"error": "empty_query", "message": "검색어(query) 또는 기준 좌표(lat, lng)가 필요합니다.", "fallback": True, "provider": "catalog"}
    lim = _clamp_limit(limit)
    named_query = bool(q) and anchor is None
    catalog_query = _ANCHOR_ALIASES.get(_norm(q), q) if named_query else q

    radius_used_m: int | None = None
    widened = False
    widen_rows: list[dict[str, Any]] | None = None   # the winning radius' catalog rows, reused below
    if has_center:
        if caller_gave_radius:
            radius_used_m = radius_m
        else:
            for r in WIDEN_RADII_M:
                radius_used_m = r
                budget = ANCHOR_SEARCH_LIMIT if named_query else _anchor_fetch_budget(lim, anchor)
                widen_rows = _rows_within_radius(catalog_query, eff_lat, eff_lng, r, category, budget, warnings)
                if _count_excluding_anchor(widen_rows, anchor) >= lim:
                    break
            widened = radius_used_m != WIDEN_RADII_M[0]

    query_rows: list[dict[str, Any]] | None = None
    exact_ranks: dict[str, int] = {}
    if named_query:
        # The same category/radius filters apply before identity selection. Reuse
        # this bounded window for both the initial page and any Kakao top-up.
        rows = widen_rows if widen_rows is not None else _rows_within_radius(
            catalog_query, eff_lat, eff_lng, radius_used_m, category, ANCHOR_SEARCH_LIMIT, warnings)
        query_rows, exact_ranks = _prioritize_name_rows(catalog_query, rows)

    accepted: list[dict[str, Any]] = []
    want_kakao = bool(q) and keys.has_provider("kakao")
    # Reserve half the budget for Kakao when we are going to query it — otherwise a full page of
    # catalog matches alone can fill `lim` and silently crowd out every Kakao addition once the
    # final list is sliced to `lim` below. The reservation is given back further down whenever
    # Kakao adds nothing, so a Kakao outage never halves the number of results.
    catalog_limit = max(1, (lim + 1) // 2) if want_kakao else lim
    catalog_limit = max(catalog_limit, min(lim, len(exact_ranks)))
    # Fix round 1 (finding #1) — bump the row budget, not `catalog_limit` itself: the Kakao
    # reservation bookkeeping below (`catalog_limit < lim`) must keep comparing against the
    # logical half-budget, not the anchor-inflated fetch size.
    if query_rows is not None:
        _accept(query_rows[:catalog_limit], accepted, warnings, marker=_marker, label="catalog")
    elif widen_rows is not None:  # already fetched at `radius_used_m` with the full `lim` row budget
        _accept(widen_rows[:_anchor_fetch_budget(catalog_limit, anchor)], accepted, warnings, marker=_marker, label="catalog")
    else:
        _add_catalog(q, eff_lat, eff_lng, radius_used_m, category, _anchor_fetch_budget(catalog_limit, anchor), accepted, warnings)

    kakao_observed_at: str | None = None
    kakao_added, kakao_error = 0, None
    if want_kakao:
        kakao_cat = KAKAO_CATEGORY.get(category) if category else None
        # At most one Kakao call per invocation (Ruling R5), at the radius already resolved above.
        res = kakao_local.kakao_place_search(q, eff_lat, eff_lng, radius_used_m, category=kakao_cat, limit=lim)
        if res.get("error"):
            kakao_error = str(res["error"])
            warnings.append(f"kakao: {kakao_error}")
        else:
            kakao_observed_at = geo.now_iso()
            kakao_added = _accept(list(res.get("items") or []), accepted, warnings,
                                  marker=lambda doc: _kakao_marker(doc, kakao_observed_at or ""), label="kakao")
    # Give the reserved half back when Kakao could not use it (HTTP error, empty page, or every
    # document deduped/out of bbox). Without this the caller silently receives ~lim/2 results — and
    # in the empty-page case not even a warning. Rows already accepted are dropped by the same
    # name+100 m dedupe used for merging, so this only appends what the halved budget cut off.
    if _accepted_count_excluding_anchor(accepted, anchor) < lim and catalog_limit < lim:
        if kakao_added == 0 and kakao_error is None:
            _warn(warnings, "kakao: no_results — 카탈로그 결과로만 채웠습니다.")
        if query_rows is not None:
            _accept(query_rows[:lim], accepted, warnings, marker=_marker, label="catalog")
        elif widen_rows is not None:  # the reserved half is exactly the rows we already hold
            _accept(widen_rows, accepted, warnings, marker=_marker, label="catalog")
        else:
            _add_catalog(q, eff_lat, eff_lng, radius_used_m, category, _anchor_fetch_budget(lim, anchor), accepted, warnings)

    if anchor is not None:  # the anchor place itself is never one of "near"'s own results
        accepted = [m for m in accepted if not _is_anchor(m, anchor)]

    # Final review finding #1 (critical): the ladder found nothing within 10 km, so search with no
    # radius at all before claiming exhaustion — "카페 near 한라산" really does have matches (13 km),
    # and answering "없습니다" to a query that has results is the worst failure this tool can produce.
    # Kakao failures are excluded: `_empty_result_signal` must keep them retryable instead.
    rescue_nearest_m: int | None = None
    if not accepted and widen_rows is not None and kakao_error is None:
        rescue: list[dict[str, Any]] = []
        if named_query:
            rows = _rows_within_radius(catalog_query, eff_lat, eff_lng, None, category, ANCHOR_SEARCH_LIMIT, warnings)
            rows, exact_ranks = _prioritize_name_rows(catalog_query, rows)
            _accept(rows[:lim], rescue, warnings, marker=_marker, label="catalog")
        else:
            _add_catalog(q, eff_lat, eff_lng, None, category, _anchor_fetch_budget(lim, anchor), rescue, warnings)
        if anchor is not None:
            rescue = [m for m in rescue if not _is_anchor(m, anchor)]
        if rescue:
            accepted = rescue
            radius_used_m, widened = None, True   # null radius = "no radius bound was applied"
            far = [int(d) for m in rescue if (d := _to_float(m.get("distance_m"))) is not None]
            rescue_nearest_m = min(far) if far else 0

    if has_center:
        accepted.sort(key=lambda m: (exact_ranks.get(m["id"], 2),
                                    m["distance_m"] if m.get("distance_m") is not None else 10**9, m["name"]))
    elif exact_ranks:
        accepted.sort(key=lambda m: exact_ranks.get(m["id"], 2))
    items = accepted[:lim]
    # provider/sources reflect what is actually returned in `items`, not merely whether the Kakao
    # call succeeded — an addition that got truncated by the slice above or deduped away must never
    # be cited as a source the agent can quote (it is not present in the response).
    has_kakao_item = any(i["id"].startswith("kakao:") for i in items)
    sources: list[dict[str, Any]] = [{"provider": "catalog", "label": CATALOG_LABEL, "observed_at": None}]
    if has_kakao_item:
        sources.append({"provider": "kakao", "label": KAKAO_SOURCE, "observed_at": kakao_observed_at})
    result = {
        "items": items, "total": len(items), "query": q,
        "center": geo.latlng(eff_lat, eff_lng) if has_center else None,  # type: ignore[arg-type]
        "sources": sources, "warnings": warnings, "provider": "catalog+kakao" if has_kakao_item else "catalog",
        "anchor": anchor, "radius_used_m": radius_used_m, "widened": widened,
    }
    if anchor is not None:
        result["anchor_match"] = anchor_match
    if not items:  # tell the model whether widening/retrying can help at all
        if kakao_error is None and widen_rows is not None:
            # The ladder AND the unbounded rescue above both came back empty, so nothing matches at any
            # distance: this is exhaustion we have actually verified, not "nothing within 10 km". A Kakao
            # failure is the one exception even here: a retry can still succeed, so that case falls
            # through to _empty_result_signal below exactly as it does outside the widen path.
            result.update({"exhaustive": True, "message": WIDEN_EXHAUSTED_MESSAGE})
        else:
            result.update(_empty_result_signal(catalog_query, eff_lat, eff_lng, radius_used_m, category, lim, has_center=has_center, kakao_error=kakao_error))
    elif rescue_nearest_m is not None:  # answered from the unbounded rescue — the results are far away
        result["message"] = UNBOUNDED_RESCUE_MESSAGE.format(nearest=rescue_nearest_m)
        if len(items) < lim:
            # An unbounded catalog search returned fewer rows than asked for — that IS exhaustion.
            result["exhaustive"] = True
    elif widen_rows is not None and len(items) < lim:
        # Short of `limit` at the radius we settled on. Measured on the final items, so a Kakao page
        # that filled the request no longer trips it (final review finding #7a).
        result.update({"fewer_than_limit": True, "message": FEWER_THAN_LIMIT_MESSAGE.format(radius=radius_used_m)})
    return result


def _deeplinks(name: str, lat: float, lng: float) -> dict[str, str]:
    n = quote(name, safe="")
    return {"kakao_map": f"https://map.kakao.com/link/map/{n},{lat},{lng}", "kakao_navi": f"https://map.kakao.com/link/to/{n},{lat},{lng}"}


def place_detail(id: str) -> dict[str, Any]:  # noqa: A002
    """장소 id로 상세 정보(주소·태그·카카오맵 딥링크)를 조회합니다. find_places 결과의 특정 장소를 더 자세히 보여줄 때 사용하세요.

    카카오 결과(id가 `kakao:`로 시작)는 상세 조회를 지원하지 않아 error="detail_unavailable" + 카카오맵 페이지 링크를 돌려줍니다.
    """
    pid = str(id or "").strip()
    if pid.startswith("kakao:"):
        num = pid.split(":", 1)[1]
        # An ERROR envelope, never a marker-shaped dict: MarkerV2 requires name/category (min_length 1)
        # and lat/lng, so returning {"name": None, "lat": None, ...} invites the model to copy a row into
        # `markers` that fails structured-output validation and costs the whole turn (fix round 2).
        return {"error": "detail_unavailable", "message": "카카오맵 장소는 상세 정보를 제공하지 않습니다. 이름·좌표는 find_places 결과를 쓰고, 상세는 카카오맵 페이지 링크로 안내하세요.",
                "fallback": True, "id": pid, "kakao_place_url": f"https://place.map.kakao.com/{num}",
                "source": "카카오맵", "detail_available": False, "provider": "kakao"}
    try:
        item = catalog_client.get(pid)
    except Exception as exc:  # noqa: BLE001
        return {"error": "catalog_error", "message": f"카탈로그 조회 중 오류({type(exc).__name__})", "fallback": True, "provider": "catalog"}
    if item is None:
        return {"error": "not_found", "message": f"해당 id의 장소를 찾을 수 없습니다: {pid}", "fallback": True, "provider": "catalog"}
    m = _marker(item)
    if m is None:
        return {"error": "catalog_error", "message": f"카탈로그 항목 데이터가 손상되었습니다: {pid}", "fallback": True, "provider": "catalog"}
    result = {**m, "address": item.get("address"), "tags": list(item.get("tags") or []), "avg_stay_min": item.get("avg_stay_min"),
              "kakao_place_url": None, "deeplinks": _deeplinks(m["name"], m["lat"], m["lng"]), "detail_available": True, "provider": "catalog"}
    # The base catalog deliberately preserves the original seed. Supplemental
    # provider fields remain separate instead of silently changing its identity.
    try:
        from . import official_details
        result.update(official_details.for_place(pid))
    except Exception as error:  # noqa: BLE001
        log.warning("official_details_projection_failed type=%s", type(error).__name__)
    return result
