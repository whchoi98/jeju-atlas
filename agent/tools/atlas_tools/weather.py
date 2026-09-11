"""weather — 기상청(KMA API허브) hourly forecast + now first; Open-Meteo hourly as fallback. Never raises.

Both providers are normalised to the same hourly shape so the agent/BFF read one format. `observed_at` is the
KMA observation time (or Open-Meteo `current.time`) as ISO8601 with +09:00.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

import httpx

from . import geo, places
from .external import kma

OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
OPEN_METEO_SOURCE = "Open-Meteo"
TIMEOUT = httpx.Timeout(10.0, connect=5.0)
MAX_HOURS = 72
_WMO_KO: dict[int, str] = {0: "맑음", 1: "대체로 맑음", 2: "구름 조금", 3: "흐림", 45: "안개", 48: "서리 안개", 51: "약한 이슬비", 53: "이슬비",
                           55: "강한 이슬비", 61: "약한 비", 63: "비", 65: "강한 비", 71: "약한 눈", 73: "눈", 75: "강한 눈", 80: "약한 소나기",
                           81: "소나기", 82: "강한 소나기", 95: "뇌우", 96: "우박 뇌우", 99: "강한 우박 뇌우"}


def _clamp_hours(hours: Any) -> int:
    try:
        return max(1, min(int(hours), MAX_HOURS))
    except (TypeError, ValueError):
        return 12


def _kst_iso(text: str | None, fmt: str) -> str | None:
    if not text:
        return None
    try:
        return datetime.strptime(text, fmt).replace(tzinfo=geo.KST).isoformat()
    except ValueError:
        return None


def _from_kma(lat: float, lng: float, hours: int, warnings: list[str]) -> tuple[dict[str, Any] | None, str | None]:
    fc = kma.kma_forecast(lat, lng, hours)
    if fc.get("error"):
        return None, f"kma: {fc['error']}"
    now = kma.kma_now(lat, lng)
    now_block = None
    observed_at = None
    if now.get("error"):
        # Partial failure: forecast succeeded but the observation leg did not. Record it in `warnings`
        # instead of silently returning now=None, which would be indistinguishable from "no now data".
        warnings.append(f"kma_now: {now['error']}")
    else:
        observed_at = _kst_iso(now.get("observed_at"), "%Y-%m-%d %H:%M")
        now_block = {"temp_c": now.get("temp_c"), "rain_1h_mm": now.get("rain_1h_mm"), "humidity": now.get("humidity"),
                     "pty": now.get("pty"), "wind_ms": now.get("wind_ms"), "observed_at": observed_at}
    if observed_at is None:
        base = fc.get("base") or {}
        observed_at = _kst_iso(f"{base.get('date', '')}{base.get('time', '')}", "%Y%m%d%H%M")
    hourly = [{"time": _kst_iso(h.get("time"), "%Y-%m-%d %H:%M"), "temp_c": h.get("temp_c"), "pop": h.get("pop"),
               "sky": h.get("sky"), "pty": h.get("pty"), "wind_ms": h.get("wind_ms")} for h in fc.get("hourly") or []]
    return {"hourly": hourly[:hours], "now": now_block, "summary_ko": fc.get("summary_ko") or "", "observed_at": observed_at,
            "source": fc.get("source") or kma.SOURCE_HUB, "provider": "kma", "fallback": False}, None


def _summary_ko(first: dict[str, Any] | None) -> str:
    """One-line Korean summary that omits missing fields instead of interpolating None.

    Open-Meteo may return null for any single hour (`temperature_2m: [null, ...]`), and the naive
    f-string produced user-visible text like "기온 None℃ 강수확률 None%".
    """
    if not first:
        return "예보 데이터가 없습니다."
    parts = [str(first.get("time") or "")[11:16], first.get("sky") or ""]
    if first.get("temp_c") is not None:
        parts.append(f"기온 {first['temp_c']}℃")
    if first.get("pop") is not None:
        parts.append(f"강수확률 {first['pop']}%")
    return " ".join(p for p in parts if p).strip() or "예보 데이터가 없습니다."


def _from_open_meteo(lat: float, lng: float, hours: int) -> tuple[dict[str, Any] | None, str | None]:
    params = {"latitude": lat, "longitude": lng, "timezone": "Asia/Seoul", "forecast_days": 3, "wind_speed_unit": "kmh",
              "hourly": "temperature_2m,precipitation_probability,weather_code,wind_speed_10m",
              "current": "temperature_2m,precipitation,wind_speed_10m,weather_code"}
    try:
        resp = httpx.get(OPEN_METEO_URL, params=params, timeout=TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        return None, f"open-meteo: {type(exc).__name__}"
    h = data.get("hourly") or {}
    times = h.get("time") or []
    now_kst = datetime.now(geo.KST).replace(minute=0, second=0, microsecond=0)
    hourly = []
    for i, t in enumerate(times):
        iso = _kst_iso(t, "%Y-%m-%dT%H:%M")
        if iso is None or datetime.fromisoformat(iso) < now_kst:
            continue
        code = (h.get("weather_code") or [None] * len(times))[i]
        wind_kmh = (h.get("wind_speed_10m") or [None] * len(times))[i]
        hourly.append({"time": iso, "temp_c": (h.get("temperature_2m") or [None] * len(times))[i],
                       "pop": (h.get("precipitation_probability") or [None] * len(times))[i],
                       "sky": _WMO_KO.get(code) if code is not None else None, "pty": None,
                       "wind_ms": (wind_kmh / 3.6) if isinstance(wind_kmh, (int, float)) else None})
        if len(hourly) >= hours:
            break
    cur = data.get("current") or {}
    observed_at = _kst_iso(cur.get("time"), "%Y-%m-%dT%H:%M")
    now_block = {"temp_c": cur.get("temperature_2m"), "rain_1h_mm": cur.get("precipitation"), "humidity": None,
                 "pty": _WMO_KO.get(cur.get("weather_code")) if cur.get("weather_code") is not None else None,
                 "wind_ms": (cur["wind_speed_10m"] / 3.6) if isinstance(cur.get("wind_speed_10m"), (int, float)) else None,
                 "observed_at": observed_at} if cur else None
    summary = _summary_ko(hourly[0] if hourly else None)
    return {"hourly": hourly, "now": now_block, "summary_ko": summary, "observed_at": observed_at, "source": OPEN_METEO_SOURCE,
            "provider": "open-meteo", "fallback": True}, None


def weather(lat: float | None = None, lng: float | None = None, hours: int = 12, near: str | None = None) -> dict[str, Any]:
    """제주 좌표의 시간별 날씨 예보와 현재 관측치를 가져옵니다. 기상청 API허브 키가 있으면 그것을 먼저 쓰고, 없거나 실패하면
    Open-Meteo(무키)로 자동 대체합니다. 사용자가 '오늘 날씨', '지금 비 오는지', '오후 날씨 어때' 처럼 제주 날씨를 물을 때 사용하세요.

    hours: 지금부터 몇 시간분 예보를 돌려줄지(1~72, 기본 12). lat/lng 대신 near 에 장소 이름(예: '성산일출봉')을 주면
    카탈로그에서 그 장소를 찾아 기준점(anchor)으로 씁니다 — find_places 와 같은 턴에 동시에 호출할 수 있습니다
    (좌표를 기다리지 마세요). lat/lng 가 함께 오면 near 는 무시하고 좌표를 그대로 씁니다. 응답의 anchor(기준 장소)와
    anchor_match(exact|fuzzy — fuzzy 면 기준 장소가 다를 수 있음)를 확인하세요. near 를 카탈로그에서 찾을 수 없으면
    error="unresolvable_near" 를 돌려줍니다. 실패해도 예외를 던지지 않고 fallback=true 딕셔너리를 돌려줍니다.
    """
    anchor: dict[str, Any] | None = None
    anchor_match: str | None = None
    if (lat is None or lng is None) and near:
        anchor, err = places.anchor_for(near, provider="kma")
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
        return _finish({"error": "invalid_coordinates", "message": "lat/lng 는 숫자여야 합니다.", "fallback": True, "provider": "kma"})
    h = _clamp_hours(hours)
    warnings: list[str] = []
    # KMA and Open-Meteo are tried in two independent try/except blocks. If the KMA leg raises
    # (bad shape from kma_forecast/kma_now, etc.) that must not skip the always-available,
    # key-free Open-Meteo fallback — it only gets recorded as a warning.
    #
    # perf-routing Task 1: `_from_kma` is now called unconditionally (no `kma._endpoint()` pre-check)
    # so that monkeypatching `weather._from_kma` in tests actually takes effect — `kma.kma_forecast`
    # already returns a {"error": "missing_api_key", ...} dict (never raises) when no key is set, so
    # the no-key warning text below is unchanged; this only removes a redundant short-circuit.
    try:
        result, err = _from_kma(lat_f, lng_f, h, warnings)
        if result is not None:
            return _finish({**result, "warnings": warnings})
        warnings.append(err or "kma: unknown")
    except Exception as exc:  # noqa: BLE001 — a KMA-side failure must not block the Open-Meteo fallback below
        warnings.append(f"kma: unexpected_error: {type(exc).__name__}")
    try:
        result, err = _from_open_meteo(lat_f, lng_f, h)
    except Exception as exc:  # noqa: BLE001 — never raise
        result, err = None, f"unexpected_error: {type(exc).__name__}"
    if result is not None:
        return _finish({**result, "warnings": warnings})
    warnings.append(err or "open-meteo: unknown")
    return _finish({"error": "weather_unavailable", "message": "실시간 날씨를 가져오지 못했습니다. 현장 날씨는 직접 확인하세요.", "hourly": [], "now": None,
            "summary_ko": "", "observed_at": None, "source": None, "provider": "none", "fallback": True, "warnings": warnings})
