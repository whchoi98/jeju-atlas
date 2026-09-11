"""Coordinate helpers: KMA Lambert-conformal grid conversion and provider-specific normalisers.

KMA 단기예보 uses a 5 km LCC grid (nx, ny). Constants follow the official 기상청 DFS reference implementation.

WARNING: `atlas_tools.geo` (the new consolidated-tools module) also defines a `latlng()` with the
OPPOSITE argument order — `latlng(lat, lng)`. Never import both `latlng` names into the same module
without an alias; this module's `latlng(lng, lat)` order matches the providers copied here (Kakao
x/y, TourAPI mapx/mapy) and must stay as-is.
"""
from __future__ import annotations

import math
from typing import Any

# 기상청 격자 상수 (LCC DFS)
RE = 6371.00877   # 지구 반경 (km)
GRID = 5.0        # 격자 간격 (km)
SLAT1 = 30.0      # 표준 위도 1
SLAT2 = 60.0      # 표준 위도 2
OLON = 126.0      # 기준점 경도
OLAT = 38.0       # 기준점 위도
XO = 43           # 기준점 X 좌표 (격자)
YO = 136          # 기준점 Y 좌표 (격자)

_DEGRAD = math.pi / 180.0
_RADDEG = 180.0 / math.pi
_re = RE / GRID
_slat1 = SLAT1 * _DEGRAD
_slat2 = SLAT2 * _DEGRAD
_olon = OLON * _DEGRAD
_olat = OLAT * _DEGRAD
_sn = math.log(math.cos(_slat1) / math.cos(_slat2)) / math.log(math.tan(math.pi * 0.25 + _slat2 * 0.5) / math.tan(math.pi * 0.25 + _slat1 * 0.5))
_sf = (math.tan(math.pi * 0.25 + _slat1 * 0.5) ** _sn) * math.cos(_slat1) / _sn
_ro = _re * _sf / (math.tan(math.pi * 0.25 + _olat * 0.5) ** _sn)


def latlng_to_grid(lat: float, lng: float) -> tuple[int, int]:
    """WGS84 → (nx, ny) 기상청 격자."""
    ra = _re * _sf / (math.tan(math.pi * 0.25 + lat * _DEGRAD * 0.5) ** _sn)
    theta = lng * _DEGRAD - _olon
    if theta > math.pi:
        theta -= 2.0 * math.pi
    if theta < -math.pi:
        theta += 2.0 * math.pi
    theta *= _sn
    nx = int(math.floor(ra * math.sin(theta) + XO + 0.5))
    ny = int(math.floor(_ro - ra * math.cos(theta) + YO + 0.5))
    return nx, ny


def grid_to_latlng(nx: int, ny: int) -> tuple[float, float]:
    """(nx, ny) → WGS84 (lat, lng) of the grid cell centre."""
    xn = nx - XO
    yn = _ro - ny + YO
    ra = math.sqrt(xn * xn + yn * yn)
    if _sn < 0.0:
        ra = -ra
    alat = 2.0 * math.atan((_re * _sf / ra) ** (1.0 / _sn)) - math.pi * 0.5
    if abs(xn) <= 0.0:
        theta = 0.0
    elif abs(yn) <= 0.0:
        theta = math.pi * 0.5 if xn > 0 else -math.pi * 0.5
    else:
        theta = math.atan2(xn, yn)
    alon = theta / _sn + _olon
    return alat * _RADDEG, alon * _RADDEG


def latlng(lng: Any, lat: Any) -> dict[str, float]:
    """Build a {lat, lng} object from provider values given in (lng, lat) order (Kakao x/y, TourAPI mapx/mapy)."""
    return {"lat": float(lat), "lng": float(lng)}


def naver_scaled(value: Any) -> float:
    """Naver 검색(지역) API returns WGS84 with 7 implied decimals as integers (e.g. 1269876543 → 126.9876543)."""
    return int(value) / 1e7


def parse_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        s = str(value).strip()
        return float(s) if s else None
    except (TypeError, ValueError):
        return None
