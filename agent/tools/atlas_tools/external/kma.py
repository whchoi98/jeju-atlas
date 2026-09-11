"""기상청 단기예보 조회서비스(VilageFcstInfoService_2.0) — 단기예보(getVilageFcst)·초단기실황(getUltraSrtNcst).

Key: KMA_SERVICE_KEY (data.go.kr "Decoding" key; an "Encoding" key is unquoted once).
Never raises: every failure returns {"error", "message", "fallback": True, "provider": "kma"}.
Base-time rules are pure functions of `now` (KST) so tests can pin the clock.
Responses are cached per (op, base_date, base_time, nx, ny) for CACHE_TTL_S seconds.
"""
from __future__ import annotations

import re
import time
from datetime import datetime, timedelta
from typing import Any
from urllib.parse import unquote
from zoneinfo import ZoneInfo

import httpx

from . import geo, keys

PROVIDER = "kma"
ENV_KEY = "KMA_SERVICE_KEY"  # data.go.kr key (serviceKey)
ENV_HUB_KEY = "KMA_API_HUB_KEY"  # 기상청 API허브 key (authKey) — preferred: apis.data.go.kr is unreachable from AWS (2026-09)
SOURCE = "기상청 단기예보(공공데이터포털)"
SOURCE_HUB = "기상청 단기예보(기상청 API허브)"
BASE = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0"
HUB_BASE = "https://apihub.kma.go.kr/api/typ02/openApi/VilageFcstInfoService_2.0"  # same operations/params, authKey instead of serviceKey
KST = ZoneInfo("Asia/Seoul")
TIMEOUT = httpx.Timeout(10.0, connect=5.0)
CACHE_TTL_S = 600.0
MAX_HOURS = 72
DEFAULT_HOURS = 12
MISSING_ABS = 900.0  # |fcstValue| >= 900 (e.g. -999, +999) → 결측

# 격자 유효 범위 (기상청 DFS)
NX_RANGE = (1, 149)
NY_RANGE = (1, 253)

VILAGE_RELEASE_HOURS = (2, 5, 8, 11, 14, 17, 20, 23)
RELEASE_DELAY_MIN = 10

SKY_KO: dict[str, str] = {"1": "맑음", "3": "구름많음", "4": "흐림"}
PTY_FCST_KO: dict[str, str] = {"0": "없음", "1": "비", "2": "비/눈", "3": "눈", "4": "소나기"}
PTY_NCST_KO: dict[str, str] = {**PTY_FCST_KO, "5": "빗방울", "6": "빗방울눈날림", "7": "눈날림"}

GATEWAY_ERRORS: dict[str, str] = {
    "22": "quota_exceeded",
    "23": "rate_limited",
    "30": "invalid_key",
    "31": "key_expired",
    "20": "access_denied",
}

_cache: dict[tuple[str, str, str, int, int], tuple[float, list[dict[str, Any]]]] = {}


class _ApiError(Exception):
    """Internal: carries a ready-made fallback dict out of the fetch helpers."""

    def __init__(self, error: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.payload = {"error": error, "message": message, "fallback": True, "provider": PROVIDER, **extra}


# ---- time helpers ----------------------------------------------------------------------------
def _now_kst() -> datetime:
    return datetime.now(KST)


def _to_kst(now: datetime) -> datetime:
    return now.replace(tzinfo=KST) if now.tzinfo is None else now.astimezone(KST)


def _fmt_base(dt: datetime) -> tuple[str, str]:
    return dt.strftime("%Y%m%d"), dt.strftime("%H00")


def village_base(now: datetime) -> tuple[str, str]:
    """단기예보(getVilageFcst) base_date/base_time: 발표시각(02,05,…,23시)+10분 <= now 인 가장 최근 발표."""
    now = _to_kst(now)
    for hour in reversed(VILAGE_RELEASE_HOURS):
        release = now.replace(hour=hour, minute=RELEASE_DELAY_MIN, second=0, microsecond=0)
        if release <= now:
            return _fmt_base(now.replace(hour=hour))
    return _fmt_base((now - timedelta(days=1)).replace(hour=23))


def ncst_base(now: datetime) -> tuple[str, str]:
    """초단기실황(getUltraSrtNcst) base_date/base_time: 매시 40분 이후 HH00, 그 전엔 한 시간 전."""
    now = _to_kst(now)
    if now.minute < 40:
        now = now - timedelta(hours=1)
    return _fmt_base(now)


# ---- value helpers ---------------------------------------------------------------------------
def _num(value: Any) -> float | None:
    """fcstValue/obsrValue → float; 결측(±900 이상) 또는 숫자가 아니면 None."""
    f = geo.parse_float(value)
    if f is None or abs(f) >= MISSING_ABS:
        return None
    return f


def _int(value: Any) -> int | None:
    f = _num(value)
    return int(round(f)) if f is not None else None


def _text(value: Any) -> str | None:
    """PCP/RN1 같은 문자열 값은 그대로 두되, 결측 숫자(-999 등)는 None."""
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    f = geo.parse_float(s)
    if f is not None and abs(f) >= MISSING_ABS:
        return None
    return s


def _rain_mm(value: Any) -> float | None:
    """RN1 → mm(float). '강수없음' → 0.0, '1.5' → 1.5, '1mm 미만' → 0.5, 결측 → None."""
    s = _text(value)
    if s is None:
        return None
    if "강수없음" in s or s in {"0", "0.0", "없음"}:
        return 0.0
    if "미만" in s:
        return 0.5
    m = re.search(r"-?\d+(?:\.\d+)?", s)
    return float(m.group(0)) if m else None


def _fmt_num(value: float | None, unit: str = "") -> str:
    if value is None:
        return "-"
    text = str(int(value)) if float(value).is_integer() else f"{value:.1f}"
    return f"{text}{unit}"


def _clamp_hours(hours: Any) -> int:
    try:
        return max(1, min(int(hours), MAX_HOURS))
    except (TypeError, ValueError):
        return DEFAULT_HOURS


def _service_key() -> str | None:
    key = keys.get_key(ENV_KEY)
    if key and "%" in key:  # data.go.kr "Encoding" key → decode once
        key = unquote(key)
    return key


def _endpoint() -> tuple[str, str, str, str] | None:
    """(base_url, key_param, key, source) — API허브 first (reachable from AWS), then the data.go.kr gateway."""
    hub = keys.get_key(ENV_HUB_KEY)
    if hub:
        return HUB_BASE, "authKey", hub, SOURCE_HUB
    key = _service_key()
    if key:
        return BASE, "serviceKey", key, SOURCE
    return None


def _source() -> str:
    ep = _endpoint()
    return ep[3] if ep else SOURCE


def _grid(lat: float, lng: float) -> tuple[int, int]:
    try:
        lat_f, lng_f = float(lat), float(lng)
    except (TypeError, ValueError):
        raise _ApiError("invalid_coordinates", "lat/lng는 숫자여야 합니다. search_pois/nearby_pois 결과의 좌표를 사용하세요.") from None
    nx, ny = geo.latlng_to_grid(lat_f, lng_f)
    if not (NX_RANGE[0] <= nx <= NX_RANGE[1] and NY_RANGE[0] <= ny <= NY_RANGE[1]):
        raise _ApiError(
            "outside_korea",
            "기상청 단기예보 격자 범위(한반도 주변) 밖의 좌표입니다. 제주도 안의 좌표를 사용하거나 get_weather(Open-Meteo)로 대체하세요.",
            grid={"nx": nx, "ny": ny},
        )
    return nx, ny


# ---- response parsing ------------------------------------------------------------------------
_XML_CODE = re.compile(r"<returnReasonCode>\s*(\d+)\s*</returnReasonCode>")
_XML_MSG = re.compile(r"<returnAuthMsg>\s*(.*?)\s*</returnAuthMsg>", re.S)
_XML_ERR = re.compile(r"<errMsg>\s*(.*?)\s*</errMsg>", re.S)


def _raise_gateway_error(code: str | None, msg: str) -> None:
    error = GATEWAY_ERRORS.get(str(code or "").strip(), "gateway_error")
    raise _ApiError(error, f"공공데이터포털 게이트웨이 오류(returnReasonCode={code}): {msg}. 키 등록·트래픽 한도를 확인하세요.", reason_code=code)


def _parse_items(resp: httpx.Response) -> list[dict[str, Any]]:
    """HTTP 응답 → items 목록. 게이트웨이 오류·resultCode·NO_DATA 를 모두 검사한다."""
    text = resp.text or ""
    if text.lstrip().startswith("{") and '"result"' in text[:200]:  # 기상청 API허브 envelope {"result": {"status", "message"}}
        try:
            result = resp.json().get("result") or {}
        except ValueError:
            result = {}
        if isinstance(result, dict) and "status" in result:
            status = int(result.get("status") or 0)
            msg = str(result.get("message") or "").strip().rstrip(".")
            error = {401: "invalid_key", 403: "access_denied", 429: "quota_exceeded"}.get(status, "gateway_error")
            hint = ("apihub.kma.go.kr에 로그인해 '단기예보 조회서비스(VilageFcstInfoService_2.0)'의 활용신청을 완료하세요"
                    if status == 403 else "apihub.kma.go.kr 마이페이지의 인증키와 호출 한도를 확인하세요")
            raise _ApiError(error, f"기상청 API허브 오류(status={status}): {msg}. {hint}.", status=status)
    if "OpenAPI_ServiceResponse" in text:
        try:
            header = resp.json()["OpenAPI_ServiceResponse"]["cmmMsgHeader"]
            code = header.get("returnReasonCode")
            msg = header.get("returnAuthMsg") or header.get("errMsg") or ""
        except (ValueError, KeyError, TypeError, AttributeError):
            code_m, msg_m, err_m = _XML_CODE.search(text), _XML_MSG.search(text), _XML_ERR.search(text)
            code = code_m.group(1) if code_m else None
            msg = (msg_m.group(1) if msg_m else "") or (err_m.group(1) if err_m else "")
        _raise_gateway_error(code, msg)

    if resp.status_code >= 400:
        raise _ApiError("http_error", f"기상청 API HTTP {resp.status_code} 오류입니다. 잠시 후 다시 시도하거나 get_weather로 대체하세요.", status=resp.status_code)

    try:
        data = resp.json()
        response = data["response"]
        header = response.get("header") or {}
    except (ValueError, KeyError, TypeError, AttributeError):
        raise _ApiError("bad_response", "기상청 API 응답을 해석할 수 없습니다(JSON 아님).") from None

    code = str(header.get("resultCode", "")).strip()
    msg = str(header.get("resultMsg", ""))
    if code == "03":
        raise _ApiError("no_data", f"기상청 단기예보에 해당 발표 시각·격자의 데이터가 없습니다({msg}). Open-Meteo 기반 get_weather 도구로 대체하세요.")
    if code != "00":
        raise _ApiError("api_error", f"기상청 API 오류 resultCode={code}: {msg}", result_code=code)

    body = response.get("body") or {}
    items = body.get("items") if isinstance(body, dict) else None
    if not items or not isinstance(items, dict):
        raise _ApiError("no_data", "기상청 단기예보 응답에 항목이 없습니다. Open-Meteo 기반 get_weather 도구로 대체하세요.")
    item = items.get("item")
    if isinstance(item, dict):
        item = [item]
    if not isinstance(item, list) or not item:
        raise _ApiError("no_data", "기상청 단기예보 응답에 항목이 없습니다. Open-Meteo 기반 get_weather 도구로 대체하세요.")
    return [i for i in item if isinstance(i, dict)]


# ---- fetch (with cache) ----------------------------------------------------------------------
def reset_cache() -> None:
    _cache.clear()


def _fetch(op: str, base_date: str, base_time: str, nx: int, ny: int, num_rows: int) -> list[dict[str, Any]]:
    cache_key = (op, base_date, base_time, nx, ny)
    now_m = time.monotonic()
    hit = _cache.get(cache_key)
    if hit and hit[0] > now_m:
        return hit[1]

    ep = _endpoint()
    if not ep:  # defensive; callers check first
        raise _ApiError("missing_api_key", f"{ENV_HUB_KEY} 또는 {ENV_KEY} 환경 변수가 없습니다.")
    base, key_param, key, _ = ep
    params = {
        key_param: key,
        "pageNo": 1,
        "numOfRows": num_rows,
        "dataType": "JSON",
        "base_date": base_date,
        "base_time": base_time,
        "nx": nx,
        "ny": ny,
    }
    try:
        resp = httpx.get(f"{base}/{op}", params=params, timeout=TIMEOUT)
    except httpx.TimeoutException:
        raise _ApiError("timeout", "기상청 API 응답 시간이 초과되었습니다. 잠시 후 다시 시도하거나 get_weather로 대체하세요.") from None
    except httpx.HTTPError as e:
        raise _ApiError("network_error", f"기상청 API 연결에 실패했습니다({type(e).__name__}).") from None

    items = _parse_items(resp)
    _cache[cache_key] = (now_m + CACHE_TTL_S, items)
    return items


def _guard(fn, *args: Any) -> dict[str, Any]:
    """Run a tool body converting every failure to a fallback dict."""
    try:
        return fn(*args)
    except _ApiError as e:
        return e.payload
    except Exception as e:  # noqa: BLE001 — tools must never raise
        return {"error": "unexpected_error", "message": f"기상청 도구 처리 중 예기치 않은 오류: {type(e).__name__}: {e}", "fallback": True, "provider": PROVIDER}


# ---- forecast normalisation ------------------------------------------------------------------
def _slot_dt(fcst_date: str, fcst_time: str) -> datetime | None:
    try:
        return datetime.strptime(f"{fcst_date}{fcst_time}", "%Y%m%d%H%M").replace(tzinfo=KST)
    except (TypeError, ValueError):
        return None


def _summary_ko(slot: dict[str, Any]) -> str:
    hour = slot["time"][11:13]
    parts = [f"{hour}시 {slot['sky'] or '하늘상태 미상'}"]
    if slot["temp_c"] is not None:
        parts.append(f"기온 {_fmt_num(slot['temp_c'], '℃')}")
    if slot["pop"] is not None:
        parts.append(f"강수확률 {slot['pop']}%")
    s = ", ".join(parts)
    if slot["pty"] and slot["pty"] != "없음":
        pcp = f" {slot['pcp']}" if slot["pcp"] and slot["pcp"] != "강수없음" else ""
        s += f" ({slot['pty']}{pcp})"
    return s


def _forecast(lat: float, lng: float, hours: int, now: datetime) -> dict[str, Any]:
    now = _to_kst(now)
    nx, ny = _grid(lat, lng)
    base_date, base_time = village_base(now)
    items = _fetch("getVilageFcst", base_date, base_time, nx, ny, 1000)

    slots: dict[datetime, dict[str, Any]] = {}
    today = now.strftime("%Y%m%d")
    tmin: float | None = None
    tmax: float | None = None
    for it in items:
        cat = str(it.get("category", ""))
        val = it.get("fcstValue")
        if cat == "TMN" and str(it.get("fcstDate")) == today:
            tmin = _num(val)
            continue
        if cat == "TMX" and str(it.get("fcstDate")) == today:
            tmax = _num(val)
            continue
        if cat in ("TMN", "TMX"):
            continue
        dt = _slot_dt(str(it.get("fcstDate", "")), str(it.get("fcstTime", "")))
        if dt is None:
            continue
        slots.setdefault(dt, {})[cat] = val

    floor_now = now.replace(minute=0, second=0, microsecond=0)
    hourly: list[dict[str, Any]] = []
    for dt in sorted(slots):
        if dt < floor_now:
            continue
        raw = slots[dt]
        hourly.append({
            "time": dt.strftime("%Y-%m-%d %H:%M"),
            "temp_c": _num(raw.get("TMP")),
            "pop": _int(raw.get("POP")),
            "sky": SKY_KO.get(str(raw.get("SKY", "")).strip()) if raw.get("SKY") is not None else None,
            "pty": PTY_FCST_KO.get(str(raw.get("PTY", "")).strip()) if raw.get("PTY") is not None else None,
            "pcp": _text(raw.get("PCP")),
            "humidity": _int(raw.get("REH")),
            "wind_ms": _num(raw.get("WSD")),
        })
        if len(hourly) >= hours:
            break

    return {
        "grid": {"nx": nx, "ny": ny},
        "base": {"date": base_date, "time": base_time},
        "hourly": hourly,
        "today": {"date": now.strftime("%Y-%m-%d"), "tmin": tmin, "tmax": tmax},
        "summary_ko": _summary_ko(hourly[0]) if hourly else "기준 시각 이후의 예보 데이터가 없습니다.",
        "source": _source(),
        "provider": PROVIDER,
    }


def _observe(lat: float, lng: float, now: datetime) -> dict[str, Any]:
    now = _to_kst(now)
    nx, ny = _grid(lat, lng)
    base_date, base_time = ncst_base(now)
    items = _fetch("getUltraSrtNcst", base_date, base_time, nx, ny, 20)
    obs: dict[str, Any] = {str(it.get("category", "")): it.get("obsrValue") for it in items}
    observed = _slot_dt(base_date, base_time)
    pty_raw = obs.get("PTY")
    return {
        "observed_at": observed.strftime("%Y-%m-%d %H:%M") if observed else f"{base_date} {base_time}",
        "temp_c": _num(obs.get("T1H")),
        "rain_1h_mm": _rain_mm(obs.get("RN1")),
        "humidity": _int(obs.get("REH")),
        "pty": PTY_NCST_KO.get(str(pty_raw).strip()) if pty_raw is not None else None,
        "wind_ms": _num(obs.get("WSD")),
        "grid": {"nx": nx, "ny": ny},
        "base": {"date": base_date, "time": base_time},
        "source": _source(),
        "provider": PROVIDER,
    }


# ---- public tools ----------------------------------------------------------------------------
def kma_forecast(lat: float, lng: float, hours: int = 12) -> dict[str, Any]:
    """기상청 단기예보로 좌표의 시간별 예보(기온·강수확률·하늘상태·강수형태·강수량·습도·풍속)와 오늘 최저/최고기온을 가져옵니다. 사용자가 '오늘 오후', '내일 아침'처럼 특정 시간대의 제주 날씨나 비 올 확률을 물을 때 사용하세요. (API 키 필요: KMA_API_HUB_KEY 또는 KMA_SERVICE_KEY)

    hours: 기준 시각 이후 몇 시간분을 돌려줄지(1~72, 기본 12). 실패·데이터 없음이면 fallback=true 이므로 get_weather(Open-Meteo)로 대체하세요.
    """
    if not _endpoint():
        return keys.missing_key_response(PROVIDER, ENV_HUB_KEY, ENV_KEY)
    return _guard(_forecast, lat, lng, _clamp_hours(hours), _now_kst())


def kma_now(lat: float, lng: float) -> dict[str, Any]:
    """기상청 초단기실황으로 좌표의 현재 관측값(기온·1시간 강수량·습도·강수형태·풍속)을 가져옵니다. 사용자가 '지금' 제주 날씨나 비가 오는지 정확한 관측치를 필요로 할 때 사용하세요. (API 키 필요: KMA_API_HUB_KEY 또는 KMA_SERVICE_KEY)

    관측 시각은 매시 정시 발표(40분 이후 반영)입니다. 실패·데이터 없음이면 fallback=true 이므로 get_weather(Open-Meteo)로 대체하세요.
    """
    if not _endpoint():
        return keys.missing_key_response(PROVIDER, ENV_HUB_KEY, ENV_KEY)
    return _guard(_observe, lat, lng, _now_kst())
