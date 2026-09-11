"""route — Kakao Mobility car directions first (origin + ≤5 waypoints + destination in ONE call), walk/transit
pairwise, straight-line fallback whenever the key is missing or Kakao fails. Never raises.

Quota note (spec §8): car directions are 10,000/day (first activated app); walk/transit 1,000/day → pairwise calls
are capped at MAX_PAIRWISE_LEGS, beyond which we return straight legs with a warning.
"""
from __future__ import annotations

from typing import Any

from . import geo
from .external import kakao_local, keys

MODES = ("car", "walk", "transit", "straight")
MAX_STOPS = 12
MAX_KAKAO_STOPS = 7          # origin + 5 waypoints + destination per Kakao car request
MAX_PAIRWISE_LEGS = 4        # walk/transit: at most 4 Kakao calls per route() invocation
POLYLINE_JOIN_M = 30         # chunk/leg boundaries repeat the shared stop; drop the duplicate within this radius
STRAIGHT_SOURCE = "직선 거리(하버사인) 계산"
KAKAO_CAR_SOURCE = kakao_local.SOURCE_MOBILITY
KAKAO_DAPI_SOURCE = kakao_local.SOURCE_LOCAL


def _parse_stops(stops: Any) -> list[dict[str, float]] | None:
    if not isinstance(stops, list) or not 2 <= len(stops) <= MAX_STOPS:
        return None
    out: list[dict[str, float]] = []
    for s in stops:
        if not isinstance(s, dict):
            return None
        try:
            out.append(geo.latlng(float(s["lat"]), float(s["lng"])))
        except (KeyError, TypeError, ValueError):
            return None
    return out


def _straight(pts: list[dict[str, float]]) -> dict[str, Any]:
    legs = []
    for i in range(len(pts) - 1):
        d = geo.haversine_m(pts[i]["lat"], pts[i]["lng"], pts[i + 1]["lat"], pts[i + 1]["lng"])
        legs.append({"from_index": i, "to_index": i + 1, "distance_m": d, "duration_s": None, "mode": "straight"})
    total = sum(l["distance_m"] for l in legs)
    return {"mode": "straight", "distance_m": total, "duration_s": None, "polyline": [dict(p) for p in pts], "legs": legs,
            "route_meta": {"mode": "straight", "distance_m": total, "duration_s": None, "provider": "straight"},
            "source": STRAIGHT_SOURCE, "provider": "straight"}


def _legs_from_sections(sections: list[dict[str, Any]], pts: list[dict[str, float]], offset: int, total_d: int | None, total_t: int | None) -> list[dict[str, Any]]:
    n = len(pts) - 1
    if len(sections) == n and all(s.get("distance_m") is not None for s in sections):
        return [{"from_index": offset + i, "to_index": offset + i + 1, "distance_m": int(s["distance_m"]), "duration_s": s.get("duration_s"), "mode": "car"} for i, s in enumerate(sections)]
    # proportional estimate when Kakao returns fewer sections than legs
    straight = [geo.haversine_m(pts[i]["lat"], pts[i]["lng"], pts[i + 1]["lat"], pts[i + 1]["lng"]) for i in range(n)]
    denom = sum(straight) or 1
    legs = []
    for i, sd in enumerate(straight):
        share = sd / denom
        legs.append({"from_index": offset + i, "to_index": offset + i + 1,
                     "distance_m": int(round((total_d or 0) * share)),
                     "duration_s": int(round(total_t * share)) if total_t is not None else None, "mode": "car"})
    return legs


def _extend_polyline(polyline: list[dict[str, float]], points: list[dict[str, float]]) -> None:
    """Append `points`, dropping a leading vertex that repeats the last one already in `polyline`.

    Consecutive car chunks share their boundary stop and consecutive walk/transit legs share their
    junction, so a plain `extend` stores that coordinate twice — a duplicate vertex the client draws
    as a zero-length segment and `MapResponseV2.route` carries as noise.
    """
    if not points:
        return
    if polyline:
        last = polyline[-1]
        if geo.haversine_m(last["lat"], last["lng"], points[0]["lat"], points[0]["lng"]) <= POLYLINE_JOIN_M:
            points = points[1:]
    polyline.extend(points)


def _car(pts: list[dict[str, float]]) -> tuple[dict[str, Any] | None, str | None]:
    """Chunk stops into ≤7-point Kakao requests; concatenate. Returns (result, error_code)."""
    polyline: list[dict[str, float]] = []
    legs: list[dict[str, Any]] = []
    total_d = 0
    total_t: int | None = 0
    start = 0
    while start < len(pts) - 1:
        chunk = pts[start:start + MAX_KAKAO_STOPS]
        res = kakao_local.kakao_route(chunk[0]["lat"], chunk[0]["lng"], chunk[-1]["lat"], chunk[-1]["lng"], mode="car", waypoints=chunk[1:-1] or None)
        if res.get("error"):
            return None, str(res["error"])
        d, t = res.get("distance_m"), res.get("duration_s")
        if d is None:
            return None, "no_distance"
        _extend_polyline(polyline, list(res.get("polyline") or chunk))
        legs.extend(_legs_from_sections(res.get("sections") or [], chunk, start, d, t))
        total_d += int(d)
        total_t = (total_t + int(t)) if (total_t is not None and t is not None) else None
        start += MAX_KAKAO_STOPS - 1
    return {"mode": "car", "distance_m": total_d, "duration_s": total_t, "polyline": polyline, "legs": legs,
            "route_meta": {"mode": "car", "distance_m": total_d, "duration_s": total_t, "provider": "kakao"},
            "source": KAKAO_CAR_SOURCE, "provider": "kakao"}, None


def _pairwise(pts: list[dict[str, float]], mode: str) -> tuple[dict[str, Any] | None, str | None]:
    if len(pts) - 1 > MAX_PAIRWISE_LEGS:
        return None, "too_many_legs"
    polyline: list[dict[str, float]] = []
    legs: list[dict[str, Any]] = []
    total_d = 0
    total_t: int | None = 0
    for i in range(len(pts) - 1):
        res = kakao_local.kakao_route(pts[i]["lat"], pts[i]["lng"], pts[i + 1]["lat"], pts[i + 1]["lng"], mode=mode)
        if res.get("error"):
            return None, str(res["error"])
        d, t = res.get("distance_m"), res.get("duration_s")
        if d is None:
            return None, "no_distance"
        _extend_polyline(polyline, list(res.get("polyline") or [pts[i], pts[i + 1]]))
        legs.append({"from_index": i, "to_index": i + 1, "distance_m": int(d), "duration_s": t, "mode": mode})
        total_d += int(d)
        total_t = (total_t + int(t)) if (total_t is not None and t is not None) else None
    return {"mode": mode, "distance_m": total_d, "duration_s": total_t, "polyline": polyline, "legs": legs,
            "route_meta": {"mode": mode, "distance_m": total_d, "duration_s": total_t, "provider": "kakao"},
            "source": KAKAO_DAPI_SOURCE, "provider": "kakao"}, None


def route(stops: list[dict], mode: str = "car") -> dict[str, Any]:
    """여러 지점을 순서대로 잇는 이동 경로(거리·소요 시간·경로 좌표)를 계산합니다.

    "A에서 B까지 얼마나 걸려", "OO 경유해서 C까지 가는 길 알려줘"처럼 두 지점 이상 사이의 이동 경로를
    물을 때 사용합니다. Kakao Mobility(자동차) 또는 Kakao 로컬(도보/대중교통) API를 먼저 시도하고, API
    키가 없거나 호출이 실패하면 경고를 남긴 채 직선 거리(하버사인)로 자동 대체합니다(never raises).

    Args:
        stops: 방문 순서대로 나열한 {"lat": float, "lng": float} 객체 2~12개. 첫 원소가 출발지,
            마지막 원소가 목적지이고 그 사이는 경유지입니다.
        mode: 이동 수단. "car"(자동차, 기본값) | "walk"(도보) | "transit"(대중교통) | "straight"
            (Kakao 호출 없이 항상 직선 거리만 계산).
    """
    pts = _parse_stops(stops)
    if pts is None:
        return {"error": "invalid_stops", "message": f"stops 는 {{lat, lng}} 객체 2~{MAX_STOPS}개의 배열이어야 합니다.", "fallback": True, "provider": "straight"}
    m = str(mode or "car").strip().lower()
    if m not in MODES:
        return {"error": "invalid_mode", "message": f"mode 는 {', '.join(MODES)} 중 하나여야 합니다: {m!r}", "fallback": True, "provider": "straight"}
    warnings: list[str] = []
    if m != "straight":
        if not keys.has_provider("kakao"):
            warnings.append("kakao: missing_api_key")
        else:
            try:
                result, err = _car(pts) if m == "car" else _pairwise(pts, m)
            except Exception as exc:  # noqa: BLE001 — never raise out of a tool
                result, err = None, f"unexpected_error:{type(exc).__name__}"
            if result is not None:
                return {**result, "fallback": False, "warnings": warnings}
            warnings.append(f"kakao: {err}")
    return {**_straight(pts), "fallback": m != "straight", "warnings": warnings}
