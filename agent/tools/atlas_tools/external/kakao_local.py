"""Kakao Local REST API (장소 검색) + Kakao Mobility 길찾기(자동차) + Kakao 도보/대중교통 경로.

Key: KAKAO_REST_API_KEY (REST API 키 — JavaScript 키와 다름). Header: ``Authorization: KakaoAK <key>``.
Never raises: every failure (missing key, HTTP status, body error code, network) becomes
``{"error": <code>, "message": <한국어 안내>, "fallback": True, "provider": "kakao"}``.
Coordinates are always returned as {lat, lng} objects; Kakao's x/y (lng/lat) order is converted here.
"""
from __future__ import annotations

from typing import Any, Callable

import httpx

from . import geo, keys

PROVIDER = "kakao"
ENV_KEY = "KAKAO_REST_API_KEY"
SOURCE_LOCAL = "카카오맵 REST API"
SOURCE_MOBILITY = "카카오모빌리티 길찾기 API"

KEYWORD_URL = "https://dapi.kakao.com/v2/local/search/keyword.json"
NAVI_URL = "https://apis-navi.kakaomobility.com/v1/directions"
WALK_URL = "https://dapi.kakao.com/v2/routing/walk"
TRANSIT_URL = "https://dapi.kakao.com/v2/routing/publictraffic"

TIMEOUT = httpx.Timeout(10.0, connect=5.0)
MAX_RADIUS_M = 20000
MAX_SIZE = 15
MAX_WAYPOINTS = 5
MODES = ("car", "walk", "transit")

# 한글 카테고리 → Kakao category_group_code
CATEGORY: dict[str, str] = {
    "카페": "CE7", "음식점": "FD6", "관광명소": "AT4", "숙박": "AD5", "주차장": "PK6",
    "문화시설": "CT1", "편의점": "CS2", "대형마트": "MT1", "병원": "HP8", "약국": "PM9",
}
_CATEGORY_CODES = frozenset(CATEGORY.values())

_MSG_INVALID_KEY = (
    "카카오 REST API 키가 잘못되었거나 호출 허용 IP에 등록되지 않았습니다. 카카오 디벨로퍼스 [앱] > [플랫폼 키]의 "
    "REST API 키(JavaScript 키 아님)와 [앱] > [보안]의 허용 IP 설정을 확인하세요."
)
_MSG_KAKAOMAP_DISABLED = (
    "카카오맵 API 사용 설정이 꺼져 있습니다. 카카오 디벨로퍼스 [앱] > [제품 설정] > [카카오맵] > [사용 설정]을 ON으로 바꾼 뒤 다시 시도하세요."
)
_MSG_FEATURE_DISABLED = (
    "카카오모빌리티 길찾기 API 사용 권한이 없습니다. 카카오 디벨로퍼스 [앱] > [제품 설정] > [카카오모빌리티]에서 사용 신청·설정을 확인하세요."
)
_MSG_QUOTA = "카카오 API 일 쿼터를 초과했습니다. 잠시 후(또는 다음 날) 다시 시도하거나 로컬 데이터 도구(search_pois/nearby_pois/plan_route)를 사용하세요."
_MSG_UPSTREAM = "카카오 API 서버 오류입니다. 잠시 후 다시 시도하거나 로컬 데이터 도구를 사용하세요."


# ---- generic helpers ---------------------------------------------------------------------------
def _fallback(error: str, message: str, **extra: Any) -> dict[str, Any]:
    return {"error": error, "message": message, "fallback": True, "provider": PROVIDER, **extra}


def _headers(key: str, json_content: bool = False) -> dict[str, str]:
    h = {"Authorization": f"KakaoAK {key}"}
    if json_content:
        h["Content-Type"] = "application/json"
    return h


def _clamp(value: Any, lo: int, hi: int, default: int) -> int:
    try:
        return max(lo, min(int(value), hi))
    except (TypeError, ValueError):
        return default


def _num(value: Any) -> str:
    """Coordinate → query-string text without float noise (126.942 → '126.942', 33.0 → '33')."""
    f = float(value)
    return str(int(f)) if f.is_integer() else repr(f)


def _to_int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


def _vertexes_to_polyline(flat: list[Any]) -> list[dict[str, float]]:
    """Kakao Mobility ``vertexes`` are flat ``[lng, lat, lng, lat, ...]`` — pair them into {lat, lng} objects."""
    out: list[dict[str, float]] = []
    for i in range(0, len(flat) - 1, 2):
        try:
            out.append(geo.latlng(flat[i], flat[i + 1]))
        except (TypeError, ValueError):
            continue
    return out


def _points_to_polyline(points: list[Any]) -> list[dict[str, float]]:
    """``points`` may be ``[[x, y], ...]`` or ``[{"x","y"}|{"lat","lng"}, ...]``."""
    out: list[dict[str, float]] = []
    for p in points:
        try:
            if isinstance(p, (list, tuple)) and len(p) >= 2:
                out.append(geo.latlng(p[0], p[1]))
            elif isinstance(p, dict):
                if "x" in p and "y" in p:
                    out.append(geo.latlng(p["x"], p["y"]))
                elif "lat" in p and "lng" in p:
                    out.append(geo.latlng(p["lng"], p["lat"]))
        except (TypeError, ValueError):
            continue
    return out


def _extract_polyline(route: dict[str, Any]) -> list[dict[str, float]]:
    """Use whichever geometry the route carries: ``points`` or ``sections[].roads[].vertexes``; else []."""
    pts = route.get("points")
    if isinstance(pts, list):
        return _points_to_polyline(pts)
    out: list[dict[str, float]] = []
    for sec in route.get("sections") or []:
        if not isinstance(sec, dict):
            continue
        for road in sec.get("roads") or []:
            if isinstance(road, dict):
                out.extend(_vertexes_to_polyline(road.get("vertexes") or []))
    return out


def _distance_duration(route: dict[str, Any]) -> tuple[int | None, int | None]:
    summary = route.get("summary") if isinstance(route.get("summary"), dict) else {}
    return _to_int(summary.get("distance", route.get("distance"))), _to_int(summary.get("duration", route.get("duration")))


def _parse_waypoints(waypoints: list[dict] | None, limit: int) -> list[tuple[float, float]]:
    """→ [(lng, lat), ...] accepting {lat,lng} or Kakao {x,y}; silently drops malformed entries."""
    out: list[tuple[float, float]] = []
    for wp in waypoints or []:
        if not isinstance(wp, dict):
            continue
        lat, lng = (wp.get("lat"), wp.get("lng")) if "lat" in wp else (wp.get("y"), wp.get("x"))
        try:
            out.append((float(lng), float(lat)))
        except (TypeError, ValueError):
            continue
        if len(out) >= limit:
            break
    return out


# ---- error mapping -----------------------------------------------------------------------------
def _map_dapi_error(status: int, body: Any) -> dict[str, Any] | None:
    """dapi.kakao.com: error bodies look like {"errorType": ..., "message": ...}."""
    err_type = body.get("errorType") if isinstance(body, dict) else None
    msg = str(body.get("message", "")) if isinstance(body, dict) else ""
    if status == 200 and err_type is None:
        return None
    detail = f" (원인: {err_type}: {msg})" if err_type or msg else ""
    if status == 429:
        return _fallback("quota_exceeded", _MSG_QUOTA + detail, status=status)
    if status >= 500:
        return _fallback("upstream_error", _MSG_UPSTREAM + f" (HTTP {status})", status=status)
    if status == 401 or err_type == "AccessDeniedError":
        return _fallback("invalid_key_or_domain", _MSG_INVALID_KEY + detail, status=status)
    if status == 403 or err_type == "NotAuthorizedError":
        if "OPEN_MAP_AND_LOCAL" in msg or err_type == "NotAuthorizedError":
            return _fallback("kakaomap_disabled", _MSG_KAKAOMAP_DISABLED + detail, status=status)
        return _fallback("forbidden", "카카오 API 접근이 거부되었습니다. 앱 권한 설정을 확인하세요." + detail, status=status)
    return _fallback("bad_request", f"카카오 API 요청이 거부되었습니다(HTTP {status}). 파라미터를 확인하세요." + detail, status=status)


def _map_navi_error(status: int, body: Any) -> dict[str, Any] | None:
    """apis-navi.kakaomobility.com: error bodies look like {"code": <int>, "msg": ...}."""
    code = body.get("code") if isinstance(body, dict) else None
    msg = str(body.get("msg", "")) if isinstance(body, dict) else ""
    if status == 200 and code is None:
        return None
    detail = f" (원인: code={code}, {msg})" if code is not None or msg else ""
    if status == 429 or code == -10:
        return _fallback("quota_exceeded", _MSG_QUOTA + detail, status=status)
    if status >= 500:
        return _fallback("upstream_error", _MSG_UPSTREAM + f" (HTTP {status})", status=status)
    if status == 401 or code in (-401, 401):
        return _fallback("invalid_key", _MSG_INVALID_KEY + detail, status=status)
    if status == 403 or code in (-3, 403):
        return _fallback("feature_disabled", _MSG_FEATURE_DISABLED + detail, status=status)
    return _fallback("bad_request", f"카카오모빌리티 요청이 거부되었습니다(HTTP {status}). 좌표·파라미터를 확인하세요." + detail, status=status)


def _request(url: str, params: dict[str, Any], headers: dict[str, str],
             mapper: Callable[[int, Any], dict[str, Any] | None]) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Single GET, no retry. Returns (body, None) on success or (None, fallback) on any failure."""
    try:
        resp = httpx.get(url, params=params, headers=headers, timeout=TIMEOUT)
    except httpx.TimeoutException as e:
        return None, _fallback("timeout", f"카카오 API 응답이 지연되었습니다({type(e).__name__}). 잠시 후 다시 시도하거나 로컬 데이터 도구를 사용하세요.")
    except httpx.HTTPError as e:
        return None, _fallback("network_error", f"카카오 API 에 연결하지 못했습니다({type(e).__name__}). 네트워크를 확인하거나 로컬 데이터 도구를 사용하세요.")
    try:
        body: Any = resp.json()
    except ValueError:
        body = None
    err = mapper(resp.status_code, body)
    if err:
        return None, err
    if not isinstance(body, dict):
        return None, _fallback("bad_response", "카카오 API 응답을 해석할 수 없습니다(JSON 아님). 잠시 후 다시 시도하세요.")
    return body, None


# ---- tool 1: place search ------------------------------------------------------------------------
def kakao_place_search(query: str, lat: float | None = None, lng: float | None = None, radius_m: int | None = None,
                       category: str | None = None, limit: int = 10) -> dict[str, Any]:
    """카카오맵 키워드로 장소(카페·음식점·관광지 등)를 검색해 이름·주소·전화·좌표를 반환합니다. 로컬 POI 데이터에 없는 실제 상호명이나 최신 장소 정보가 필요할 때 사용하세요. (API 키 필요: KAKAO_REST_API_KEY)

    lat/lng 를 주면 그 지점 기준 거리순(sort=distance), radius_m(0~20000m) 로 반경 제한. category 는 한글(카페/음식점/관광명소/숙박/주차장/문화시설/편의점/대형마트/병원/약국) 또는 Kakao 코드(CE7 등).
    """
    try:
        return _place_search(query, lat, lng, radius_m, category, limit)
    except Exception as e:  # noqa: BLE001 — tool contract: never raise
        return _fallback("unexpected_error", f"장소 검색 처리 중 오류가 발생했습니다({type(e).__name__}). 로컬 데이터 도구를 사용하세요.")


def _place_search(query: str, lat: float | None, lng: float | None, radius_m: int | None,
                  category: str | None, limit: int) -> dict[str, Any]:
    q = str(query or "").strip()
    if not q:
        return {"error": "empty_query", "message": "검색어(query)가 비어 있습니다.", "fallback": True, "provider": PROVIDER}
    code: str | None = None
    if category:
        code = CATEGORY.get(category) or (category if category in _CATEGORY_CODES else None)
        if code is None:
            return {
                "error": "invalid_category",
                "message": f"지원하지 않는 카테고리입니다: {category!r}. allowed 중 하나(또는 Kakao 코드)를 사용하세요.",
                "category": category,
                "allowed": list(CATEGORY),
                "fallback": True,
                "provider": PROVIDER,
            }
    key = keys.get_key(ENV_KEY)
    if not key:
        return keys.missing_key_response(PROVIDER, ENV_KEY)

    params: dict[str, Any] = {"query": q, "size": _clamp(limit, 1, MAX_SIZE, 10)}
    has_center = lat is not None and lng is not None
    if has_center:
        params["x"] = str(float(lng))  # type: ignore[arg-type]
        params["y"] = str(float(lat))  # type: ignore[arg-type]
        if radius_m is not None:
            params["radius"] = _clamp(radius_m, 0, MAX_RADIUS_M, MAX_RADIUS_M)
        params["sort"] = "distance"
    else:
        params["sort"] = "accuracy"
    if code:
        params["category_group_code"] = code

    body, err = _request(KEYWORD_URL, params, _headers(key), _map_dapi_error)
    if err:
        return err
    assert body is not None
    meta = body.get("meta") or {}
    items = []
    for d in body.get("documents") or []:
        if not isinstance(d, dict):
            continue
        p_lat, p_lng = geo.parse_float(d.get("y")), geo.parse_float(d.get("x"))
        if p_lat is None or p_lng is None:
            continue
        items.append({
            "id": d.get("id"),
            "name": d.get("place_name"),
            "category": d.get("category_name"),
            "category_code": d.get("category_group_code"),
            "address": d.get("road_address_name") or d.get("address_name"),
            "phone": d.get("phone") or None,
            "lat": p_lat,
            "lng": p_lng,
            "url": d.get("place_url"),
            "distance_m": _to_int(d.get("distance")),
        })
    return {
        "items": items,
        "total": meta.get("pageable_count", len(items)),
        "is_end": bool(meta.get("is_end", True)),
        "query": q,
        "center": geo.latlng(lng, lat) if has_center else None,
        "source": SOURCE_LOCAL,
        "provider": PROVIDER,
    }


# ---- tool 2: route ----------------------------------------------------------------------------
def kakao_route(origin_lat: float, origin_lng: float, dest_lat: float, dest_lng: float, mode: str = "car",
                waypoints: list[dict] | None = None) -> dict[str, Any]:
    """두 지점 사이의 자동차(car)·도보(walk)·대중교통(transit) 경로를 카카오 길찾기 API로 계산해 거리·소요시간·폴리라인({lat,lng} 목록)을 반환합니다. 실제 도로 기준 이동 시간, 택시 요금, 지도에 그릴 경로 선이 필요할 때 사용하세요. (API 키 필요: KAKAO_REST_API_KEY)

    waypoints 는 [{"lat", "lng"}, ...] (car 최대 5개, walk 는 첫 1개만 via 로 사용, transit 은 무시).
    """
    try:
        return _route(origin_lat, origin_lng, dest_lat, dest_lng, mode, waypoints)
    except Exception as e:  # noqa: BLE001 — tool contract: never raise
        return _fallback("unexpected_error", f"경로 계산 처리 중 오류가 발생했습니다({type(e).__name__}). plan_route(직선 경로)를 사용하세요.")


def _route(origin_lat: Any, origin_lng: Any, dest_lat: Any, dest_lng: Any, mode: str,
           waypoints: list[dict] | None) -> dict[str, Any]:
    mode = str(mode or "").strip().lower()
    if mode not in MODES:
        return {
            "error": "invalid_mode",
            "message": f"지원하지 않는 이동 수단입니다: {mode!r}. car/walk/transit 중 하나를 사용하세요.",
            "mode": mode,
            "allowed": list(MODES),
            "fallback": True,
            "provider": PROVIDER,
        }
    try:
        o_lat, o_lng, d_lat, d_lng = float(origin_lat), float(origin_lng), float(dest_lat), float(dest_lng)
    except (TypeError, ValueError):
        return {"error": "invalid_coordinates", "message": "출발/도착 좌표는 숫자(lat, lng)여야 합니다.", "fallback": True, "provider": PROVIDER}
    key = keys.get_key(ENV_KEY)
    if not key:
        return keys.missing_key_response(PROVIDER, ENV_KEY)
    if mode == "car":
        return _route_car(key, o_lat, o_lng, d_lat, d_lng, waypoints)
    if mode == "walk":
        return _route_walk(key, o_lat, o_lng, d_lat, d_lng, waypoints)
    return _route_transit(key, o_lat, o_lng, d_lat, d_lng)


def _route_car(key: str, o_lat: float, o_lng: float, d_lat: float, d_lng: float, waypoints: list[dict] | None) -> dict[str, Any]:
    params: dict[str, Any] = {
        "origin": f"{_num(o_lng)},{_num(o_lat)}",
        "destination": f"{_num(d_lng)},{_num(d_lat)}",
        "priority": "RECOMMEND",
    }
    wps = _parse_waypoints(waypoints, MAX_WAYPOINTS)
    if wps:
        params["waypoints"] = "|".join(f"{_num(x)},{_num(y)}" for x, y in wps)
    body, err = _request(NAVI_URL, params, _headers(key, json_content=True), _map_navi_error)
    if err:
        return err
    assert body is not None
    routes = body.get("routes") or []
    route = routes[0] if routes and isinstance(routes[0], dict) else {}
    result_code = route.get("result_code")
    if result_code != 0:
        msg = str(route.get("result_msg") or "경로를 찾을 수 없습니다.")
        return _fallback("route_not_found", msg, result_code=result_code)
    summary = route.get("summary") or {}
    fare = summary.get("fare") or {}
    return {
        "mode": "car",
        "distance_m": _to_int(summary.get("distance")),
        "duration_s": _to_int(summary.get("duration")),
        "taxi_fare": _to_int(fare.get("taxi")),
        "toll_fare": _to_int(fare.get("toll")),
        "polyline": _extract_polyline(route),
        "sections": [{"distance_m": _to_int(s.get("distance")), "duration_s": _to_int(s.get("duration"))}
                     for s in (route.get("sections") or []) if isinstance(s, dict)],
        "origin": geo.latlng(o_lng, o_lat),
        "destination": geo.latlng(d_lng, d_lat),
        "source": SOURCE_MOBILITY,
        "provider": PROVIDER,
    }


def _dapi_route_ok(body: dict[str, Any]) -> tuple[dict[str, Any] | None, str]:
    """(first route, status). status is body.status, else routes[0].status, else 'OK' when a route exists."""
    routes = body.get("routes") or []
    route = routes[0] if routes and isinstance(routes[0], dict) else None
    status = body.get("status")
    if status is None and route is not None:
        status = route.get("status", "OK")
    return route, str(status) if status is not None else ""


def _route_walk(key: str, o_lat: float, o_lng: float, d_lat: float, d_lng: float, waypoints: list[dict] | None) -> dict[str, Any]:
    params: dict[str, Any] = {"start_x": _num(o_lng), "start_y": _num(o_lat), "end_x": _num(d_lng), "end_y": _num(d_lat)}
    via = _parse_waypoints(waypoints, 1)
    if via:
        params["via_x"], params["via_y"] = _num(via[0][0]), _num(via[0][1])
    body, err = _request(WALK_URL, params, _headers(key), _map_dapi_error)
    if err:
        return err
    assert body is not None
    route, status = _dapi_route_ok(body)
    if status != "OK" or route is None:
        return _fallback("route_not_found", str(body.get("message") or f"도보 경로를 찾을 수 없습니다(status={status or 'unknown'})."), status=status)
    distance, duration = _distance_duration(route)
    return {
        "mode": "walk",
        "distance_m": distance,
        "duration_s": duration,
        "polyline": _extract_polyline(route),
        "origin": geo.latlng(o_lng, o_lat),
        "destination": geo.latlng(d_lng, d_lat),
        "source": SOURCE_LOCAL,
        "provider": PROVIDER,
    }


def _route_transit(key: str, o_lat: float, o_lng: float, d_lat: float, d_lng: float) -> dict[str, Any]:
    params: dict[str, Any] = {"start_x": _num(o_lng), "start_y": _num(o_lat), "end_x": _num(d_lng), "end_y": _num(d_lat)}
    body, err = _request(TRANSIT_URL, params, _headers(key), _map_dapi_error)
    if err:
        return err
    assert body is not None
    route, status = _dapi_route_ok(body)
    if status != "OK" or route is None:
        return _fallback("route_not_found", str(body.get("message") or f"대중교통 경로를 찾을 수 없습니다(status={status or 'unknown'})."), status=status)
    props = route.get("properties") if isinstance(route.get("properties"), dict) else {}
    distance, duration = _distance_duration(route)
    return {
        "mode": "transit",
        "summary": props,
        "distance_m": distance if distance is not None else _to_int(props.get("totalDistance")),
        "duration_s": duration if duration is not None else _to_int(props.get("totalTime")),
        "polyline": _extract_polyline(route),
        "origin": geo.latlng(o_lng, o_lat),
        "destination": geo.latlng(d_lng, d_lat),
        "source": SOURCE_LOCAL,
        "provider": PROVIDER,
    }
