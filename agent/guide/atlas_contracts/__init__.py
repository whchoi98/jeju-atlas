"""Atlas runtime response contracts (v2), packaged with the independent guide."""
from __future__ import annotations

from .mapresponse_v2 import (
    ANSWER_ONLY_WARNING,
    FALLBACK_ANSWER,
    JEJU_BBOX,
    LENIENT_PARSE_WARNING,
    MAP_MISSING_WARNING,
    MAX_ANSWER_CHARS,
    MAX_MARKERS_V1,
    MAX_MARKERS_V2,
    MAX_ROUTE_POINTS,
    MAX_WARNINGS,
    SAFE_URL_SCHEMES,
    SERVER_WARNING_CODES,
    Itinerary,
    ItineraryDay,
    LatLng,
    Leg,
    MapResponseV2,
    MarkerV2,
    RouteMeta,
    Source,
    Stop,
    in_jeju_bbox,
    is_server_warning,
    itinerary_bbox_warnings,
    parse_map_response_v2,
    to_v1,
)

__version__ = "2.1.0"

__all__ = [
    "__version__", "ANSWER_ONLY_WARNING", "FALLBACK_ANSWER", "JEJU_BBOX", "LENIENT_PARSE_WARNING",
    "MAP_MISSING_WARNING", "MAX_ANSWER_CHARS", "MAX_MARKERS_V1", "MAX_MARKERS_V2", "MAX_ROUTE_POINTS",
    "MAX_WARNINGS", "SAFE_URL_SCHEMES", "SERVER_WARNING_CODES",
    "Itinerary", "ItineraryDay", "LatLng", "Leg", "MapResponseV2", "MarkerV2", "RouteMeta", "Source", "Stop",
    "in_jeju_bbox", "is_server_warning", "itinerary_bbox_warnings", "parse_map_response_v2", "to_v1",
]
