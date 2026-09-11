"""plan_day — turn a list of stops into an Itinerary (order, stay, real/estimated travel time). Never raises.

Order: nearest-neighbour from the first stop unless constraints.keep_order. Stay: stop.stay_min → catalog
avg_stay_min → constraints.default_stay_min. Travel: routing.route(mode) legs; when a leg has no duration
(straight fallback) we estimate distance × DETOUR_FACTOR / ESTIMATE_MPS[mode] and say so in `warnings`.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import Any

from . import catalog_client, geo, routing

MAX_STOPS = 12
DETOUR_FACTOR = 1.3
# Rough Jeju averages used ONLY when a leg has no provider duration. transit is listed here (and in
# routing.MODES / the RouteMode contract) so `constraints.mode="transit"` is no longer silently
# recomputed as a car timetable: ~25 km/h door-to-door including waits.
ESTIMATE_MPS = {"car": 11.1, "walk": 1.25, "transit": 6.9, "straight": 11.1}
DEFAULT_CONSTRAINTS = {"keep_order": False, "mode": "car", "date": None, "end_time": None, "default_stay_min": 60}
ESTIMATED_LEGS_WARNING = "legs: estimated durations (no Kakao route)"
# Same shape as atlas_contracts.mapresponse_v2._DATE_RE — ItineraryDay.date raises ValidationError
# on anything else, so an out-of-range constraints.date must never reach the itinerary unvalidated.
_DATE_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$")


def _hhmm(value: Any) -> datetime | None:
    try:
        return datetime.strptime(str(value).strip(), "%H:%M")
    except ValueError:
        return None


def _parse_stops(stops: Any) -> list[dict[str, Any]] | None:
    if not isinstance(stops, list) or not 2 <= len(stops) <= MAX_STOPS:
        return None
    out = []
    for i, s in enumerate(stops):
        if not isinstance(s, dict):
            return None
        try:
            lat, lng = float(s["lat"]), float(s["lng"])
        except (KeyError, TypeError, ValueError):
            return None
        stay = s.get("stay_min")
        out.append({"id": str(s.get("id") or f"stop_{i + 1}"), "name": str(s.get("name") or f"장소 {i + 1}"), "lat": lat, "lng": lng,
                    "stay_min": int(stay) if isinstance(stay, (int, float)) and stay > 0 else None, "note": s.get("note")})
    return out


def _order(stops: list[dict[str, Any]], keep_order: bool) -> list[dict[str, Any]]:
    if keep_order:
        return list(stops)
    remaining = list(stops[1:])
    ordered = [stops[0]]
    while remaining:
        cur = ordered[-1]
        nxt = min(remaining, key=lambda s: geo.haversine_m(cur["lat"], cur["lng"], s["lat"], s["lng"]))
        remaining.remove(nxt)
        ordered.append(nxt)
    return ordered


def _stay_min(stop: dict[str, Any], default: int) -> int:
    if stop["stay_min"]:
        return stop["stay_min"]
    try:
        item = catalog_client.get(stop["id"])
    except Exception:  # noqa: BLE001 — catalog failure must not break planning
        item = None
    avg = (item or {}).get("avg_stay_min")
    return int(avg) if isinstance(avg, (int, float)) and avg > 0 else default


def plan_day(stops: list[dict], start_time: str = "09:00", constraints: dict | None = None) -> dict[str, Any]:
    """방문할 장소 목록을 하루 일정(방문 순서·도착 시간·체류 시간·이동 정보)으로 변환합니다.

    "이 장소들로 하루 일정 짜줘", "몇 시에 출발하면 다 돌아볼 수 있어?"처럼 여러 장소를 하루 안에
    도는 순서와 시간표를 물을 때 사용합니다. 순서를 지정하지 않으면 첫 장소부터 최근접 이웃으로
    자동 정렬하고, `routing.route()`로 실제(또는 추정) 이동 시간을 더해 도착·종료 시각을 계산합니다.

    Args:
        stops: 방문할 장소 {"id", "name", "lat", "lng", "stay_min"(선택), "note"(선택)} 객체 2~12개.
        start_time: 출발 시각 "HH:MM".
        constraints: "keep_order"(bool, 입력 순서 유지), "mode"("car"|"walk"|"transit"|"straight",
            그 밖의 값은 car 로 계산하고 warnings 에 남깁니다),
            "date"("YYYY-MM-DD", 형식이 아니면 무시하고 경고), "end_time"("HH:MM", 초과 시 경고),
            "default_stay_min"(int) 선택.
    """
    parsed = _parse_stops(stops)
    if parsed is None:
        return {"error": "invalid_stops", "message": f"stops 는 {{name, lat, lng}} 객체 2~{MAX_STOPS}개여야 합니다.", "fallback": True, "provider": "planner"}
    start = _hhmm(start_time)
    if start is None:
        return {"error": "invalid_time", "message": "start_time 은 HH:MM 형식이어야 합니다.", "fallback": True, "provider": "planner"}
    c = {**DEFAULT_CONSTRAINTS, **(constraints or {})}
    end_limit = _hhmm(c["end_time"]) if c.get("end_time") else None
    warnings: list[str] = []
    requested_mode = str(c.get("mode") or "car").lower()
    mode = requested_mode if requested_mode in ESTIMATE_MPS else "car"
    if mode != requested_mode:
        # Silently swapping the mode used to hand a car timetable to someone who asked for something else.
        warnings.append(f"mode: '{requested_mode}' 는 지원하지 않아 car 기준으로 계산했습니다({', '.join(sorted(ESTIMATE_MPS))} 지원).")
    date_raw = c.get("date")
    date = str(date_raw) if date_raw is not None else None
    if date is not None and not _DATE_RE.match(date):
        warnings.append(f"date: '{date_raw}' 은 YYYY-MM-DD 형식이 아니어서 무시했습니다.")
        date = None

    ordered = _order(parsed, bool(c.get("keep_order")))
    r = routing.route([{"lat": s["lat"], "lng": s["lng"]} for s in ordered], mode)
    if r.get("error"):
        return {**r, "provider": "planner"}
    warnings.extend(r.get("warnings") or [])
    legs_in = r.get("legs") or []
    day_legs = []
    for i in range(len(ordered) - 1):
        raw = legs_in[i] if i < len(legs_in) else {"distance_m": geo.haversine_m(ordered[i]["lat"], ordered[i]["lng"], ordered[i + 1]["lat"], ordered[i + 1]["lng"]), "duration_s": None, "mode": "straight"}
        duration = raw.get("duration_s")
        if duration is None:
            duration = int(round(raw["distance_m"] * DETOUR_FACTOR / ESTIMATE_MPS[mode]))
            if ESTIMATED_LEGS_WARNING not in warnings:
                warnings.append(ESTIMATED_LEGS_WARNING)
        day_legs.append({"from_id": ordered[i]["id"], "to_id": ordered[i + 1]["id"], "distance_m": int(raw["distance_m"]), "duration_s": int(duration), "mode": raw.get("mode") or mode})

    t = start
    day_stops = []
    for i, s in enumerate(ordered):
        stay = _stay_min(s, int(c.get("default_stay_min") or 60))
        day_stops.append({"id": s["id"], "name": s["name"], "lat": s["lat"], "lng": s["lng"], "arrive": t.strftime("%H:%M"), "stay_min": stay, "note": s.get("note")})
        t = t + timedelta(minutes=stay)
        if i < len(day_legs):
            t = t + timedelta(seconds=day_legs[i]["duration_s"])
    end_time = t.strftime("%H:%M")
    if end_limit is not None and t > end_limit:
        warnings.append(f"end_time: 일정이 {c['end_time']} 를 넘겨 {end_time} 에 끝납니다. 체류 시간을 줄이거나 장소를 빼세요.")

    sources = [{"provider": "catalog", "label": "오마이제주 카탈로그(체류 시간)", "observed_at": None},
               {"provider": r.get("provider", "straight"), "label": r.get("source", ""), "observed_at": geo.now_iso() if r.get("provider") == "kakao" else None}]
    return {
        "itinerary": {"title": f"{date or '오늘'} 제주 하루 일정", "days": [{"date": date, "stops": day_stops, "legs": day_legs}]},
        "route": r.get("polyline") or [], "route_meta": r.get("route_meta"),
        "total_distance_m": sum(l["distance_m"] for l in day_legs), "total_duration_s": sum(l["duration_s"] for l in day_legs),
        "end_time": end_time, "warnings": warnings, "sources": sources, "provider": r.get("provider", "straight"),
    }
