"""Coordinate helpers shared by the consolidated tools. Coordinates are always {lat, lng} objects.

WARNING: `atlas_tools.external.geo` (the copied KMA/Kakao normaliser module) also defines a
`latlng()` with the OPPOSITE argument order — `latlng(lng, lat)`, following provider (Kakao x/y,
TourAPI mapx/mapy) conventions. Never import both `latlng` names into the same module without an
alias; this module's `latlng(lat, lng)` is the one every consolidated tool and the {lat, lng}
contract use.
"""
from __future__ import annotations

from datetime import datetime
from math import asin, cos, isfinite, radians, sin, sqrt
from zoneinfo import ZoneInfo

KST = ZoneInfo("Asia/Seoul")
JEJU_BBOX = {"lat": (33.10, 33.60), "lng": (126.15, 126.98)}
EARTH_RADIUS_M = 6_371_008.8


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> int:
    dlat, dlng = radians(lat2 - lat1), radians(lng2 - lng1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlng / 2) ** 2
    return int(round(2 * EARTH_RADIUS_M * asin(sqrt(a))))


def in_jeju(lat: float, lng: float) -> bool:
    return JEJU_BBOX["lat"][0] <= lat <= JEJU_BBOX["lat"][1] and JEJU_BBOX["lng"][0] <= lng <= JEJU_BBOX["lng"][1]


def parse_bbox(text: str | None) -> tuple[float, float, float, float] | None:
    """'minLng,minLat,maxLng,maxLat' → tuple, or None when malformed/inverted/non-finite.

    NaN and inf must be rejected here: `float("nan")` parses fine and every NaN comparison is False,
    so the inverted-box guard below would pass a NaN box through and `in_bbox` would then reject every
    item — the caller would see "0건" instead of the honest `invalid_bbox` error.
    """
    try:
        parts = [float(p) for p in str(text or "").split(",")]
    except ValueError:
        return None
    if len(parts) != 4 or not all(isfinite(p) for p in parts):
        return None
    min_lng, min_lat, max_lng, max_lat = parts
    if min_lng >= max_lng or min_lat >= max_lat:
        return None
    return (min_lng, min_lat, max_lng, max_lat)


def in_bbox(lat: float, lng: float, bbox: tuple[float, float, float, float]) -> bool:
    min_lng, min_lat, max_lng, max_lat = bbox
    return min_lat <= lat <= max_lat and min_lng <= lng <= max_lng


def latlng(lat: float, lng: float) -> dict[str, float]:
    return {"lat": float(lat), "lng": float(lng)}


def now_iso() -> str:
    return datetime.now(KST).replace(microsecond=0).isoformat()
