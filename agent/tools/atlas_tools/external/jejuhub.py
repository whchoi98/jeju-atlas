"""제주데이터허브 오픈 API (open.jejudatahub.net) — 버스 정류소·올레길·오름/박물관·전기차 충전소.

Request : GET https://open.jejudatahub.net/api/proxy/{dataKey}/{projectKey}?number=<page>&limit=<1..100>&<filters>
Response: {"totCnt": int, "hasMore": bool, "data": [...]}
Key     : JEJUHUB_PROJECT_KEY (마이페이지 > 프로젝트 관리 > 프로젝트키). The project must have each dataset added to it.

Every tool degrades gracefully: missing key → keys.missing_key_response(...); any HTTP / network / parse failure →
{"error": <code>, "message": <한국어>, "fallback": True, "provider": "jejuhub"}. Nothing here raises.
Coordinates are always {"lat": float | None, "lng": float | None}.
"""
from __future__ import annotations

import re
from typing import Any

import httpx

from . import geo, keys

PROVIDER = "jejuhub"
ENV_KEY = "JEJUHUB_PROJECT_KEY"
BASE_URL = "https://open.jejudatahub.net/api/proxy"
TIMEOUT = httpx.Timeout(10.0, connect=5.0)
MIN_LIMIT, MAX_LIMIT = 1, 100
PAGE = 1  # no pagination: always the first page; `has_more` tells the agent there is more
SOURCE_PREFIX = "제주데이터허브(제주테크노파크) · 원출처: "
NOTE = "데이터셋 갱신 시점은 제주데이터허브 상세 페이지 참고; 카카오 POI는 2025-09 스냅샷"

# dataset id -> proxy dataKey / human title / original data owner (for the 출처 line)
DATASETS: dict[str, dict[str, str]] = {
    "bus_stops": {"key": "DD11ab6a6t11D16baaa1a2tD26ata161", "title": "버스 정류소 기본 정보", "origin": "제주특별자치도"},
    "olle_courses": {"key": "1Daaa177batDba8b8t711D17D18atDa7", "title": "올레길 위치 정보", "origin": "제주올레"},
    "oreum": {"key": "1Dttb1tab8tD88Dtat11111at1t1atD8", "title": "오름 위치 정보", "origin": "카카오위치서비스(2025-09 스냅샷)"},
    "museums": {"key": "at2ta1D1aaa811bata88Dt1D22b1t1bt", "title": "박물관 및 미술관 위치 정보", "origin": "카카오위치서비스(2025-09 스냅샷)"},
    "ev_chargers": {"key": "atDab6t8218btaa122b26DDtbatD86t1", "title": "전기자동차 충전소 정보", "origin": "공공데이터포털"},
    "weather_stations": {"key": "t1bab75a555a15715btaa7a5abaa1aab", "title": "기상관측소 정보", "origin": "기상청"},
}
PLACE_KINDS = ("oreum", "museums")

_COURSE_NUMBER_RE = re.compile(r"^\d+(-\d+)?$")          # "7", "7-1", "10-1"
_MUST_BE_RE = re.compile(r"must be[^\"'\n}]*")           # 500 body: "... limit must be less than or equal to 100 ..."
_TRUE_WORDS = {"true", "t", "y", "yes", "1", "on"}


# ---- small helpers ---------------------------------------------------------------------------
def _clamp_limit(limit: Any, default: int) -> int:
    try:
        return max(MIN_LIMIT, min(int(limit), MAX_LIMIT))
    except (TypeError, ValueError):
        return default


def _to_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, (int, float)):
        return value != 0
    return str(value).strip().lower() in _TRUE_WORDS


def _to_int(value: Any) -> int | None:
    try:
        return int(str(value).strip()) if value is not None and str(value).strip() else None
    except (TypeError, ValueError):
        return None


def _text(value: Any) -> str | None:
    """None for empty strings so optional fields stay JSON-null instead of ''."""
    if value is None:
        return None
    s = str(value).strip()
    return s or None


def _hours(start: Any, end: Any) -> str | None:
    s, e = _text(start), _text(end)
    if s and e:
        return f"{s}-{e}"
    return s or e


def _source(dataset_id: str) -> str:
    return SOURCE_PREFIX + DATASETS[dataset_id]["origin"]


def _error(code: str, message: str, **extra: Any) -> dict[str, Any]:
    return {"error": code, "message": message, "fallback": True, "provider": PROVIDER, **extra}


def _try_json(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except ValueError:
        return None


def _upstream_message(body: Any, fallback: str) -> str:
    if isinstance(body, dict):
        for k in ("message", "error", "msg", "resultMsg"):
            if _text(body.get(k)):
                return str(body[k]).strip()
    return fallback


# ---- HTTP -------------------------------------------------------------------------------------
def _map_http_error(resp: httpx.Response, dataset: str) -> dict[str, Any]:
    status = resp.status_code
    text = resp.text or ""
    ctx = {"status": status, "dataset": dataset}
    if status == 403:
        return _error("invalid_key", "제주데이터허브 프로젝트키가 유효하지 않거나 프로젝트에 해당 데이터셋이 담기지 않았습니다(403). 마이페이지 > 프로젝트 관리에서 프로젝트키와 데이터셋 담기를 확인하세요.", **ctx)
    if status == 404:
        return _error("invalid_request", "요청 경로가 올바르지 않습니다(404). 프로젝트키가 누락되었을 수 있습니다.", **ctx)
    if status == 400:
        body = _try_json(resp)
        if isinstance(body, dict):
            return _error("bad_request", f"잘못된 요청(400): {_upstream_message(body, text[:200])}", **ctx)
        if "invalid request" in text.lower():
            return _error("invalid_dataset", "데이터셋 키(dataKey)가 올바르지 않습니다(400 Invalid Request).", **ctx)
        return _error("bad_request", f"잘못된 요청(400): {text[:200] or '본문 없음'}", **ctx)
    if status == 500:
        m = _MUST_BE_RE.search(text)
        if m:
            return _error("bad_parameter", f"요청 파라미터 오류(500): {m.group(0).strip()}", **ctx)
    if status >= 500:
        return _error("upstream_error", f"제주데이터허브 서버 오류(HTTP {status}). 잠시 후 다시 시도하세요.", **ctx)
    return _error("http_error", f"제주데이터허브 요청 실패(HTTP {status}).", **ctx)


def _query(dataset_id: str, filters: dict[str, Any] | None, limit: int, default_limit: int) -> dict[str, Any]:
    """One proxy call. Returns the raw body ({"totCnt","hasMore","data"}) or an error dict — never raises."""
    ds = DATASETS[dataset_id]
    project_key = keys.get_key(ENV_KEY)
    if not project_key:
        return keys.missing_key_response(PROVIDER, ENV_KEY)

    params: dict[str, Any] = {"number": PAGE, "limit": _clamp_limit(limit, default_limit)}
    for k, v in (filters or {}).items():
        if _text(v) is not None:
            params[k] = v  # httpx percent-encodes 한글 values
    url = f"{BASE_URL}/{ds['key']}/{project_key}"
    ctx = {"dataset": ds["title"]}

    try:
        resp = httpx.get(url, params=params, timeout=TIMEOUT)
    except httpx.TimeoutException as e:
        return _error("timeout", f"제주데이터허브 응답 시간 초과: {type(e).__name__}", **ctx)
    except httpx.HTTPError as e:
        return _error("network_error", f"제주데이터허브 연결 실패: {type(e).__name__}: {e}", **ctx)
    except Exception as e:  # noqa: BLE001 — tool contract: never raise
        return _error("request_failed", f"제주데이터허브 요청 중 오류: {type(e).__name__}: {e}", **ctx)

    if resp.status_code != 200:
        return _map_http_error(resp, ds["title"])

    body = _try_json(resp)
    if not isinstance(body, dict):
        return _error("invalid_response", "제주데이터허브 응답이 JSON 객체가 아닙니다(로그인 페이지 또는 HTML일 수 있음).", status=200, **ctx)
    if not isinstance(body.get("data"), list):
        # 200 with an error payload: {"status": 401, "message": "..."} / {"code": ..., "error": ...}
        code = body.get("status") or body.get("code") or body.get("resultCode")
        msg = _upstream_message(body, "응답에 data 배열이 없습니다.")
        return _error("upstream_error", f"제주데이터허브 오류 응답: {msg}", status=200, upstream_code=code, **ctx)
    return body


def _envelope(dataset_id: str, body: dict[str, Any], items: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    total = body.get("totCnt")
    try:
        total = int(total) if total is not None else len(items)
    except (TypeError, ValueError):
        total = len(items)
    return {
        "items": items,
        "total": total,
        "has_more": _to_bool(body.get("hasMore")),
        "dataset": DATASETS[dataset_id]["title"],
        "source": _source(dataset_id),
        "provider": PROVIDER,
        "note": NOTE,
        **extra,
    }


def _rows(body: dict[str, Any]) -> list[dict[str, Any]]:
    return [r for r in body["data"] if isinstance(r, dict)]


# ---- tools ------------------------------------------------------------------------------------
def jejuhub_bus_stops(station_name: str, limit: int = 20) -> dict[str, Any]:
    """제주 버스 정류소를 이름 부분일치로 검색해 정류소 ID·주소·방면·좌표를 반환합니다. 사용자가 특정 정류소 위치나 근처 버스 정류장을 물을 때 사용하세요. (API 키 필요: JEJUHUB_PROJECT_KEY)

    Dataset 612 「버스 정류소 기본 정보」 (stationName partial match). Coordinates are always present upstream.
    """
    body = _query("bus_stops", {"stationName": station_name}, limit, default_limit=20)
    if "error" in body:
        return body
    items = [
        {
            "id": _text(r.get("stationId")),
            "name": _text(r.get("stationName")),
            "address": _text(r.get("stationAddress")),
            "direction": _text(r.get("direction")),
            "lat": geo.parse_float(r.get("latitude")),
            "lng": geo.parse_float(r.get("longitude")),
        }
        for r in _rows(body)
    ]
    return _envelope("bus_stops", body, items, query=station_name)


def jejuhub_olle_courses(course: str | None = None, limit: int = 30) -> dict[str, Any]:
    """제주올레 코스(전체 26개)의 시작·종료 지점 좌표와 휠체어 구간 여부를 반환합니다. 올레길 코스 목록이나 특정 코스의 출발/도착 위치가 필요할 때 사용하세요. (API 키 필요: JEJUHUB_PROJECT_KEY)

    Dataset 871 「올레길 위치 정보」. `course` like "7" / "7-1" filters courseNumber; any other text filters courseName.
    No filter → the whole list (26 courses).
    """
    filters: dict[str, Any] = {}
    c = _text(course)
    if c:
        filters["courseNumber" if _COURSE_NUMBER_RE.match(c) else "courseName"] = c
    body = _query("olle_courses", filters, limit, default_limit=30)
    if "error" in body:
        return body
    items = [
        {
            "course_number": _text(r.get("courseNumber")),
            "name": _text(r.get("courseName")),
            "wheelchair": _to_bool(r.get("wheelchairCourseFlag")),
            "start": {
                "name": _text(r.get("startPoint")),
                "lat": geo.parse_float(r.get("startLatitude")),
                "lng": geo.parse_float(r.get("startLongitude")),
            },
            "end": {
                "name": _text(r.get("endPoint")),
                "lat": geo.parse_float(r.get("endLatitude")),
                "lng": geo.parse_float(r.get("endLongitude")),
            },
        }
        for r in _rows(body)
    ]
    return _envelope("olle_courses", body, items, query=c)


def jejuhub_places(kind: str, name: str | None = None, limit: int = 20) -> dict[str, Any]:
    """제주 오름(kind="oreum") 또는 박물관·미술관(kind="museums") 위치를 이름 부분일치로 검색해 주소·좌표·카카오 장소 URL을 반환합니다. 로컬 POI 데이터에 없는 오름/박물관을 찾을 때 사용하세요. (API 키 필요: JEJUHUB_PROJECT_KEY)

    Datasets 「오름 위치 정보」 / 「박물관 및 미술관 위치 정보」 (카카오위치서비스 2025-09 snapshot; placeName partial match).
    """
    if kind not in PLACE_KINDS:
        return _error("invalid_kind", f"지원하지 않는 kind 입니다: {kind!r}. oreum(오름) 또는 museums(박물관·미술관)를 사용하세요.", kind=kind, allowed=list(PLACE_KINDS))
    body = _query(kind, {"placeName": name}, limit, default_limit=20)
    if "error" in body:
        return body
    items = [
        {
            "name": _text(r.get("placeName")),
            "category": _text(r.get("category")),
            "address": _text(r.get("addressDoro")) or _text(r.get("addressJibun")),
            "lat": geo.parse_float(r.get("latitude")),
            "lng": geo.parse_float(r.get("longitude")),
            "url": _text(r.get("placeUrl")),
        }
        for r in _rows(body)
    ]
    return _envelope(kind, body, items, kind=kind, query=_text(name))


def jejuhub_ev_chargers(place: str | None = None, quick_only: bool = False, limit: int = 20) -> dict[str, Any]:
    """제주 전기차 충전소를 장소명 부분일치(선택)와 급속충전 여부로 검색해 운영시간·충전기 수·좌표를 반환합니다. 렌터카 전기차 충전소 위치나 급속충전 가능 여부를 물을 때 사용하세요. (API 키 필요: JEJUHUB_PROJECT_KEY)

    Dataset 862 「전기자동차 충전소 정보」 (chargingPlace partial match; quickChargingFlag=true when quick_only).
    Coordinates may be absent upstream → lat/lng None.
    """
    filters: dict[str, Any] = {"chargingPlace": place}
    if quick_only:
        filters["quickChargingFlag"] = "true"
    body = _query("ev_chargers", filters, limit, default_limit=20)
    if "error" in body:
        return body
    items = [
        {
            "place": _text(r.get("chargingPlace")),
            "detail": _text(r.get("chargingPlaceDetail")),
            "hours": _hours(r.get("startTime"), r.get("endTime")),
            "quick": _to_bool(r.get("quickChargingFlag")),
            "charger_count": _to_int(r.get("chargerCount")),
            "lat": geo.parse_float(r.get("latitude")),
            "lng": geo.parse_float(r.get("longitude")),
        }
        for r in _rows(body)
    ]
    return _envelope("ev_chargers", body, items, query=_text(place), quick_only=bool(quick_only))
