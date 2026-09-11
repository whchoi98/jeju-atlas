"""sun_times — local sunrise/sunset via astral (no network, no key). Golden hour = sunset − 60 min."""
from __future__ import annotations

from datetime import date as _date, datetime, timedelta
from typing import Any

from astral import Observer
from astral.sun import sun

from . import geo, places

SOURCE = "astral 로컬 계산"


def sun_times(lat: float | None = None, lng: float | None = None, date: str | None = None, near: str | None = None) -> dict[str, Any]:
    """제주 좌표의 일출·일몰·박명·골든아워 시각을 계산합니다(네트워크·API 키 불필요, astral 로컬 계산). 사용자가
    '일몰 언제야', '노을 보기 좋은 시간', '몇 시에 해 뜨는지' 처럼 해뜨는/지는 시각을 물을 때 사용하세요.

    date: YYYY-MM-DD(생략하면 오늘, KST 기준). lat/lng 대신 near 에 장소 이름(예: '성산일출봉')을 주면 카탈로그에서
    그 장소를 찾아 기준점(anchor)으로 씁니다 — find_places 와 같은 턴에 동시에 호출할 수 있습니다(좌표를 기다리지
    마세요). lat/lng 가 함께 오면 near 는 무시하고 좌표를 그대로 씁니다. 응답의 anchor(기준 장소)와 anchor_match
    (exact|fuzzy — fuzzy 면 기준 장소가 다를 수 있음)를 확인하세요. near 를 카탈로그에서 찾을 수 없으면
    error="unresolvable_near" 를 돌려줍니다. 실패해도 예외를 던지지 않고 fallback=true 딕셔너리를 돌려줍니다.
    """
    anchor: dict[str, Any] | None = None
    anchor_match: str | None = None
    if (lat is None or lng is None) and near:
        anchor, err = places.anchor_for(near, provider="astral")
        if err is not None:
            return err
        anchor_match = places._anchor_match(near, anchor["name"])
        lat, lng = anchor["lat"], anchor["lng"]

    def _finish(payload: dict[str, Any]) -> dict[str, Any]:
        if anchor is not None:
            return {**payload, "anchor": anchor, "anchor_match": anchor_match}
        return payload

    try:
        lat_f, lng_f = float(lat), float(lng)
    except (TypeError, ValueError):
        return _finish({"error": "invalid_coordinates", "message": "lat/lng 는 숫자여야 합니다.", "fallback": True, "provider": "astral"})
    if date:
        try:
            d = _date.fromisoformat(str(date))
        except ValueError:
            return _finish({"error": "invalid_date", "message": "date 는 YYYY-MM-DD 형식이어야 합니다.", "fallback": True, "provider": "astral"})
    else:
        d = datetime.now(geo.KST).date()
    try:
        s = sun(Observer(latitude=lat_f, longitude=lng_f), date=d, tzinfo=geo.KST)
    except ValueError as exc:  # polar day/night — impossible for Jeju, kept for the never-raise contract
        return _finish({"error": "no_sun_event", "message": str(exc), "fallback": True, "provider": "astral"})
    fmt = "%H:%M"
    return _finish({"date": d.isoformat(), "sunrise": s["sunrise"].strftime(fmt), "sunset": s["sunset"].strftime(fmt),
            "dawn": s["dawn"].strftime(fmt), "dusk": s["dusk"].strftime(fmt),
            "golden_hour_start": (s["sunset"] - timedelta(minutes=60)).strftime(fmt), "source": SOURCE, "provider": "astral"})
