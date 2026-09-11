"""한국관광공사 TourAPI 4.0 (KorService2) — keyword search, location-based list, festivals, detail.

Key: TOURAPI_SERVICE_KEY (data.go.kr *Decoding* key). An *Encoding* key (contains %2B/%3D) is unquoted once.
Jeju scoping uses the 법정동 codes introduced in KorService2 (lDongRegnCd=50, lDongSignguCd 110/130) — the
legacy areaCode=39 / sigunguCode values are not used. Never raises: every failure becomes a fallback dict.
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Any
from urllib.parse import unquote

import httpx

from . import geo, keys

PROVIDER = "tourapi"
SOURCE = "한국관광공사 TourAPI 4.0"
ENV_KEY = "TOURAPI_SERVICE_KEY"
BASE = "https://apis.data.go.kr/B551011/KorService2"
TIMEOUT = httpx.Timeout(10.0, connect=5.0)

JEJU_LDONG_REGN_CD = "50"                                   # 제주특별자치도 (법정동 시도 코드)
SIGUNGU: dict[str, str] = {"제주시": "110", "서귀포시": "130"}   # 법정동 시군구 코드
CONTENT_TYPES: dict[str, str] = {
    "관광지": "12", "문화시설": "14", "축제공연행사": "15", "여행코스": "25",
    "레포츠": "28", "숙박": "32", "쇼핑": "38", "음식점": "39",
}
CONTENT_TYPE_NAMES: dict[str, str] = {v: k for k, v in CONTENT_TYPES.items()}

MAX_LIMIT = 50
MAX_ROWS = 100
MIN_RADIUS_M, MAX_RADIUS_M = 1, 20000

# data.go.kr gateway (OpenAPI_ServiceResponse.cmmMsgHeader.returnReasonCode) -> (error code, 한국어 설명)
_GATEWAY_CODES: dict[str, tuple[str, str]] = {
    "22": ("quota_exceeded", "일일 호출 한도를 초과했습니다"),
    "23": ("rate_limited", "초당 호출 한도를 초과했습니다. 잠시 후 다시 시도하세요"),
    "30": ("invalid_key", "등록되지 않은 서비스 키입니다(Decoding 키인지, 인코딩이 중복되지 않았는지 확인)"),
    "31": ("key_expired", "서비스 키 사용 기간이 만료되었습니다"),
    "20": ("access_denied", "서비스 접근이 거부되었습니다(활용신청 승인 여부 확인)"),
}
_NO_DATA_CODES = {"03", "0003"}

_URL_RE = re.compile(r"https?://[^\s\"'<>]+")
_XML_TAG_RE = {
    "returnReasonCode": re.compile(r"<returnReasonCode>\s*([^<]*?)\s*</returnReasonCode>"),
    "returnAuthMsg": re.compile(r"<returnAuthMsg>\s*([^<]*?)\s*</returnAuthMsg>"),
    "errMsg": re.compile(r"<errMsg>\s*([^<]*?)\s*</errMsg>"),
    "resultCode": re.compile(r"<resultCode>\s*([^<]*?)\s*</resultCode>"),
    "resultMsg": re.compile(r"<resultMsg>\s*([^<]*?)\s*</resultMsg>"),
}


# ---- small helpers -------------------------------------------------------------------------
def _fallback(error: str, message: str, **extra: Any) -> dict[str, Any]:
    return {"error": error, "message": message, "fallback": True, "provider": PROVIDER, **extra}


def _service_key_value(raw: str) -> str:
    """Normalise a data.go.kr key: an Encoding key (percent-escaped, e.g. %2B/%3D) is unquoted exactly once."""
    key = raw.strip()
    if "%" in key:
        key = unquote(key)
    return key


def _service_key() -> str | None:
    raw = keys.get_key(ENV_KEY)
    return _service_key_value(raw) if raw else None


def _clamp(value: Any, lo: int, hi: int, default: int) -> int:
    try:
        return max(lo, min(int(value), hi))
    except (TypeError, ValueError):
        return default


def _content_type_id(content_type: str | None) -> str | None:
    """'관광지' or '12' → '12'. Returns None when unknown (caller decides)."""
    if content_type is None:
        return None
    ct = str(content_type).strip()
    if ct in CONTENT_TYPES:
        return CONTENT_TYPES[ct]
    if ct in CONTENT_TYPE_NAMES:
        return ct
    return None


def _invalid_content_type(content_type: str) -> dict[str, Any]:
    return _fallback(
        "invalid_content_type",
        f"지원하지 않는 content_type 입니다: {content_type!r}. allowed 중 하나(또는 숫자 코드)를 사용하세요",
        content_type=content_type,
        allowed=list(CONTENT_TYPES),
    )


def _yyyymmdd(value: Any) -> str | None:
    """'20261001' / '2026-10-01' → '20261001'; anything else (or an impossible date) → None."""
    s = str(value or "").strip().replace("-", "")
    if not re.fullmatch(r"\d{8}", s):
        return None
    try:
        datetime.strptime(s, "%Y%m%d")
    except ValueError:
        return None
    return s


def _iso_date(value: Any) -> str | None:
    s = str(value or "").strip()
    return f"{s[:4]}-{s[4:6]}-{s[6:8]}" if re.fullmatch(r"\d{8}", s) else (s or None)


def _homepage_url(html: Any) -> str | None:
    """TourAPI returns homepage as an HTML anchor; keep only the first URL."""
    m = _URL_RE.search(str(html or ""))
    return m.group(0) if m else None


def _address(item: dict[str, Any]) -> str | None:
    parts = [str(item.get(k) or "").strip() for k in ("addr1", "addr2")]
    return " ".join(p for p in parts if p) or None


def _common_params(service_key: str, num_of_rows: int) -> dict[str, Any]:
    return {"serviceKey": service_key, "MobileOS": "ETC", "MobileApp": "JejuAtlas", "_type": "json",
            "numOfRows": num_of_rows, "pageNo": 1}


# ---- response parsing ----------------------------------------------------------------------
def _gateway_error(header: dict[str, Any] | Any) -> dict[str, Any]:
    header = header if isinstance(header, dict) else {}
    code = str(header.get("returnReasonCode", "")).strip()
    auth_msg = str(header.get("returnAuthMsg", "")).strip()
    err_msg = str(header.get("errMsg", "")).strip()
    error, ko = _GATEWAY_CODES.get(code, ("gateway_error", f"공공데이터포털 게이트웨이 오류(code {code or '?'})"))
    detail = " / ".join(x for x in (auth_msg, err_msg) if x)
    return _fallback(error, f"{ko}: {detail}" if detail else ko, return_reason_code=code)


def _parse(data: Any) -> dict[str, Any]:
    """KorService2 JSON → {"items": [raw item dicts], "total": int} or a fallback dict.

    (1) OpenAPI_ServiceResponse → data.go.kr gateway error (key/quota); (2) header.resultCode != 0000 → api_error,
    except NO_DATA which is an empty success; (3) body.items == "" → []; items.item dict → [dict].
    """
    if not isinstance(data, dict):
        return _fallback("invalid_response", "TourAPI 응답을 해석할 수 없습니다")
    if "OpenAPI_ServiceResponse" in data:
        gw = data.get("OpenAPI_ServiceResponse") or {}
        return _gateway_error(gw.get("cmmMsgHeader") if isinstance(gw, dict) else None)
    resp = data.get("response")
    if not isinstance(resp, dict):
        return _fallback("invalid_response", "TourAPI 응답에 response 필드가 없습니다")
    header = resp.get("header") or {}
    code = str(header.get("resultCode", "")).strip()
    msg = str(header.get("resultMsg", "")).strip()
    if code != "0000":
        if code in _NO_DATA_CODES or "NO_DATA" in msg.upper():
            return {"items": [], "total": 0}
        return _fallback("api_error", f"TourAPI 오류({code or '?'}): {msg or '알 수 없는 오류'}", result_code=code, result_msg=msg)
    body = resp.get("body") or {}
    raw = body.get("items") if isinstance(body, dict) else None
    items: list[dict[str, Any]] = []
    if isinstance(raw, dict):
        item = raw.get("item")
        if isinstance(item, dict):
            items = [item]
        elif isinstance(item, list):
            items = [i for i in item if isinstance(i, dict)]
    elif isinstance(raw, list):
        items = [i for i in raw if isinstance(i, dict)]
    try:
        total = int(body.get("totalCount") or 0) if isinstance(body, dict) else 0
    except (TypeError, ValueError):
        total = len(items)
    return {"items": items, "total": total}


def _parse_xml_error(text: str, status: int) -> dict[str, Any]:
    """The gateway answers unregistered keys with XML even when _type=json was requested."""
    found = {k: (m.group(1).strip() if (m := rx.search(text)) else "") for k, rx in _XML_TAG_RE.items()}
    if "OpenAPI_ServiceResponse" in text or found["returnReasonCode"]:
        return _gateway_error({"returnReasonCode": found["returnReasonCode"], "returnAuthMsg": found["returnAuthMsg"], "errMsg": found["errMsg"]})
    if found["resultCode"] and found["resultCode"] != "0000":
        if found["resultCode"] in _NO_DATA_CODES or "NO_DATA" in found["resultMsg"].upper():
            return {"items": [], "total": 0}
        return _fallback("api_error", f"TourAPI 오류({found['resultCode']}): {found['resultMsg']}", result_code=found["resultCode"], result_msg=found["resultMsg"])
    if status >= 400:
        return _fallback("http_error", f"TourAPI HTTP {status} 응답", status=status)
    return _fallback("invalid_response", "TourAPI 응답이 JSON이 아닙니다", status=status)


def _decode(resp: httpx.Response) -> dict[str, Any]:
    try:
        data = resp.json()
    except ValueError:
        return _parse_xml_error(resp.text, resp.status_code)
    if isinstance(data, dict) and "OpenAPI_ServiceResponse" in data:
        return _parse(data)   # gateway error is more informative than the HTTP status
    if resp.status_code >= 400:
        return _fallback("http_error", f"TourAPI HTTP {resp.status_code} 응답", status=resp.status_code)
    return _parse(data)


def _call(path: str, params: dict[str, Any]) -> dict[str, Any]:
    """GET {BASE}/{path}; returns _parse output or a fallback dict. Never raises."""
    try:
        resp = httpx.get(f"{BASE}/{path}", params=params, timeout=TIMEOUT)
    except httpx.TimeoutException as e:
        return _fallback("timeout", f"TourAPI 응답 시간 초과: {e}")
    except httpx.HTTPError as e:
        return _fallback("network_error", f"TourAPI 요청 실패: {type(e).__name__}: {e}")
    except Exception as e:  # noqa: BLE001 — tool contract: never raise
        return _fallback("unexpected_error", f"TourAPI 호출 중 예외: {type(e).__name__}: {e}")
    try:
        return _decode(resp)
    except Exception as e:  # noqa: BLE001
        return _fallback("parse_error", f"TourAPI 응답 해석 실패: {type(e).__name__}: {e}")


# ---- item normalisation ----------------------------------------------------------------------
def _normalise(item: dict[str, Any]) -> dict[str, Any] | None:
    """Raw KorService2 item → Atlas POI shape. Returns None when the item has no coordinates."""
    lng, lat = geo.parse_float(item.get("mapx")), geo.parse_float(item.get("mapy"))
    if lat is None or lng is None:
        return None
    type_id = str(item.get("contenttypeid") or "").strip()
    return {
        "id": str(item.get("contentid") or "").strip(),
        "name": str(item.get("title") or "").strip(),
        "category": CONTENT_TYPE_NAMES.get(type_id, type_id or None),
        "address": _address(item),
        **geo.latlng(lng, lat),
        "image": (str(item.get("firstimage") or "").strip() or None),
        "tel": (str(item.get("tel") or "").strip() or None),
        "modified": (str(item.get("modifiedtime") or "").strip() or None),
    }


def _normalise_list(raw_items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for raw in raw_items:
        n = _normalise(raw)
        if n is not None:
            out.append(n)
    return out


# ---- tools -----------------------------------------------------------------------------------
def tour_search(keyword: str, content_type: str | None = None, sigungu: str | None = None, limit: int = 10) -> dict[str, Any]:
    """제주 관광지·문화시설·축제·레포츠·숙박·쇼핑·음식점을 한국관광공사 TourAPI에서 키워드로 검색합니다. 로컬 POI(search_pois)에 없는 장소나 공식 관광 정보·사진·전화번호가 필요할 때 사용하세요. (API 키 필요: TOURAPI_SERVICE_KEY)

    content_type: 관광지|문화시설|축제공연행사|여행코스|레포츠|숙박|쇼핑|음식점 (또는 숫자 코드). sigungu: 제주시|서귀포시.
    v2 keyword search has no contentTypeId parameter, so the type filter is applied client-side (3x over-fetch).
    """
    key = _service_key()
    if not key:
        return keys.missing_key_response(PROVIDER, ENV_KEY)
    kw = str(keyword or "").strip()
    if not kw:
        return _fallback("invalid_keyword", "검색어(keyword)를 입력하세요")
    type_id = _content_type_id(content_type)
    if content_type is not None and type_id is None:
        return _invalid_content_type(content_type)
    sigungu_code = SIGUNGU.get(str(sigungu).strip()) if sigungu else None
    if sigungu and sigungu_code is None:
        return _fallback("invalid_sigungu", f"지원하지 않는 시군구입니다: {sigungu!r}. 제주시 또는 서귀포시를 사용하세요", sigungu=sigungu, allowed=list(SIGUNGU))
    lim = _clamp(limit, 1, MAX_LIMIT, 10)
    params = _common_params(key, min(lim * 3, MAX_ROWS))
    params.update({"keyword": kw, "lDongRegnCd": JEJU_LDONG_REGN_CD, "arrange": "C"})
    if sigungu_code:
        params["lDongSignguCd"] = sigungu_code
    parsed = _call("searchKeyword2", params)
    if "error" in parsed:
        return parsed
    raw = parsed["items"]
    if type_id:
        raw = [i for i in raw if str(i.get("contenttypeid") or "").strip() == type_id]
    return {
        "items": _normalise_list(raw)[:lim],
        "total": parsed["total"],
        "keyword": kw,
        "content_type": CONTENT_TYPE_NAMES.get(type_id) if type_id else None,
        "sigungu": sigungu if sigungu_code else None,
        "source": SOURCE,
        "provider": PROVIDER,
    }


def tour_nearby(lat: float, lng: float, radius_m: int = 3000, content_type: str | None = None, limit: int = 10) -> dict[str, Any]:
    """좌표(lat, lng) 반경 radius_m(최대 20km) 안의 관광지·음식점·숙박 등을 한국관광공사 TourAPI에서 가까운 순으로 가져옵니다(distance_km 포함). 로컬 nearby_pois보다 넓은 공식 데이터가 필요할 때 사용하세요. (API 키 필요: TOURAPI_SERVICE_KEY)

    content_type: 관광지|문화시설|축제공연행사|여행코스|레포츠|숙박|쇼핑|음식점 (또는 숫자 코드), 서버 필터.
    """
    key = _service_key()
    if not key:
        return keys.missing_key_response(PROVIDER, ENV_KEY)
    type_id = _content_type_id(content_type)
    if content_type is not None and type_id is None:
        return _invalid_content_type(content_type)
    try:
        lat_f, lng_f = float(lat), float(lng)
    except (TypeError, ValueError):
        return _fallback("invalid_coordinates", "lat/lng는 숫자여야 합니다")
    radius = _clamp(radius_m, MIN_RADIUS_M, MAX_RADIUS_M, 3000)
    lim = _clamp(limit, 1, MAX_LIMIT, 10)
    params = _common_params(key, lim)
    params.update({"mapX": lng_f, "mapY": lat_f, "radius": radius, "arrange": "E"})
    if type_id:
        params["contentTypeId"] = type_id
    parsed = _call("locationBasedList2", params)
    if "error" in parsed:
        return parsed
    items: list[dict[str, Any]] = []
    for raw in parsed["items"]:
        n = _normalise(raw)
        if n is None:
            continue
        dist_m = geo.parse_float(raw.get("dist"))
        n["distance_km"] = round(dist_m / 1000.0, 2) if dist_m is not None else None
        items.append(n)
    return {
        "items": items[:lim],
        "total": parsed["total"],
        "center": {"lat": lat_f, "lng": lng_f},
        "radius_m": radius,
        "content_type": CONTENT_TYPE_NAMES.get(type_id) if type_id else None,
        "source": SOURCE,
        "provider": PROVIDER,
    }


def tour_festivals(start_date: str, end_date: str | None = None, limit: int = 20) -> dict[str, Any]:
    """start_date(YYYYMMDD) 이후에 열리는 제주 축제·공연·행사를 한국관광공사 TourAPI에서 조회합니다(기간·진행 상태 포함). 사용자가 특정 날짜·여행 기간의 축제나 행사를 물을 때 사용하세요. (API 키 필요: TOURAPI_SERVICE_KEY)

    end_date(YYYYMMDD, 선택)를 주면 그 날짜까지 끝나는 행사만 반환됩니다. 'YYYY-MM-DD'도 허용합니다.
    """
    key = _service_key()
    if not key:
        return keys.missing_key_response(PROVIDER, ENV_KEY)
    start = _yyyymmdd(start_date)
    if start is None:
        return _fallback("invalid_date", "start_date는 YYYYMMDD 형식의 8자리 숫자여야 합니다", start_date=start_date)
    end = None
    if end_date is not None and str(end_date).strip():
        end = _yyyymmdd(end_date)
        if end is None:
            return _fallback("invalid_date", "end_date는 YYYYMMDD 형식의 8자리 숫자여야 합니다", end_date=end_date)
    lim = _clamp(limit, 1, MAX_ROWS, 20)
    params = _common_params(key, lim)
    params.update({"eventStartDate": start, "lDongRegnCd": JEJU_LDONG_REGN_CD, "arrange": "C"})
    if end:
        params["eventEndDate"] = end
    parsed = _call("searchFestival2", params)
    if "error" in parsed:
        return parsed
    items: list[dict[str, Any]] = []
    for raw in parsed["items"]:
        n = _normalise(raw)
        if n is None:
            continue
        n.update({
            "start": _iso_date(raw.get("eventstartdate")),
            "end": _iso_date(raw.get("eventenddate")),
            "progress": (str(raw.get("progresstype") or "").strip() or None),
            "festival_type": (str(raw.get("festivaltype") or "").strip() or None),
        })
        items.append(n)
    return {
        "items": items[:lim],
        "total": parsed["total"],
        "start_date": start,
        "end_date": end,
        "source": SOURCE,
        "provider": PROVIDER,
    }


def tour_detail(content_id: str, content_type: str | None = None) -> dict[str, Any]:
    """TourAPI contentid로 장소의 개요(overview)·홈페이지·전화·주소·좌표·대표 이미지를 가져오고, content_type을 주면 이용시간·휴무일·주차 등 소개 정보(intro)도 함께 가져옵니다. tour_search/tour_nearby 결과 중 한 곳을 자세히 설명해야 할 때 사용하세요. (API 키 필요: TOURAPI_SERVICE_KEY)

    detailCommon2 is called with contentId only (KorService2 removed contentTypeId and the *YN flags);
    detailIntro2 requires both contentId and contentTypeId and is optional — its failure does not hide the detail.
    """
    key = _service_key()
    if not key:
        return keys.missing_key_response(PROVIDER, ENV_KEY)
    cid = str(content_id or "").strip()
    if not cid:
        return _fallback("invalid_content_id", "content_id를 입력하세요")
    type_id = _content_type_id(content_type)
    if content_type is not None and type_id is None:
        return _invalid_content_type(content_type)
    params = _common_params(key, 10)
    params["contentId"] = cid
    parsed = _call("detailCommon2", params)
    if "error" in parsed:
        return parsed
    if not parsed["items"]:
        return _fallback("not_found", "해당 contentid의 정보가 없습니다. tour_search/tour_nearby 결과의 id를 사용하세요", id=cid)
    raw = parsed["items"][0]
    lng, lat = geo.parse_float(raw.get("mapx")), geo.parse_float(raw.get("mapy"))
    raw_type = str(raw.get("contenttypeid") or "").strip()
    detail: dict[str, Any] = {
        "id": str(raw.get("contentid") or cid).strip(),
        "name": str(raw.get("title") or "").strip(),
        "category": CONTENT_TYPE_NAMES.get(raw_type, raw_type or None),
        "overview": (str(raw.get("overview") or "").strip() or None),
        "homepage": _homepage_url(raw.get("homepage")),
        "tel": (str(raw.get("tel") or "").strip() or None),
        "address": _address(raw),
        "lat": lat,
        "lng": lng,
        "image": (str(raw.get("firstimage") or "").strip() or None),
        "source": SOURCE,
        "provider": PROVIDER,
    }
    if type_id:
        intro_params = _common_params(key, 10)
        intro_params.update({"contentId": cid, "contentTypeId": type_id})
        intro = _call("detailIntro2", intro_params)
        if "error" in intro:
            detail["intro"] = None
            detail["intro_error"] = intro["error"]
        elif intro["items"]:
            detail["intro"] = {str(k): ("" if v is None else str(v)) for k, v in intro["items"][0].items()}
        else:
            detail["intro"] = None
            detail["intro_error"] = "not_found"
    return detail
