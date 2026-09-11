"""Atlas POI catalog — one SQLite file (places + FTS5 trigram index) built from the curated sample set,
TourAPI snapshots, Jeju Data Hub snapshots and OpenStreetMap snapshots; read by JejuAtlasTools.

This module is owned by the Atlas Tools CodeZip as `catalog.py`; tools call its module-level
`search()` / `get()`. It imports no reference repository or BFF source.

Tokenizer decision (verified 2026-09-06 on SQLite 3.40.0 / Python 3.12.12): `trigram` matches Korean substrings
without any morphological analysis ('일출봉' -> 성산일출봉) but needs >= 3 characters per query token, and
`unicode61` only matches whole whitespace-delimited tokens ('일출' misses 성산일출봉). We index with trigram and
route query tokens shorter than MIN_FTS_CHARS to a LIKE scan over the normalised name / tags columns.

Coordinates are always {lat, lng}; records outside BBOX are rejected at build time (SLO: 100 %).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import sqlite3
import sys
import threading
import time
import unicodedata
from collections.abc import Sequence
from datetime import datetime, timezone
from math import asin, cos, radians, sin, sqrt
from pathlib import Path
from typing import Any

log = logging.getLogger("atlas.catalog")

SCHEMA_VERSION = 2  # plan 13: adds the place_extra table (meta.extra_tables); places/places_fts unchanged
EXTRA_TABLES: tuple[str, ...] = ("place_extra",)
MAX_EXTRA_PHOTOS = 8
BBOX: dict[str, tuple[float, float]] = {"lat": (33.10, 33.60), "lng": (126.15, 126.98)}
CATEGORIES: list[str] = ["관광지", "오름", "해변", "카페", "맛집", "올레길", "박물관", "시장", "문화시설", "레포츠", "숙박", "쇼핑", "주차장"]
DEDUPE_RADIUS_M = 150
OSM_DEDUPE_RADIUS_M = 100  # tighter than DEDUPE_RADIUS_M: applies whenever either side of a duplicate pair is OSM
OSM_ATTRIBUTION = "장소 데이터 © OpenStreetMap contributors (ODbL) · 큐레이션 데이터 오마이제주"
MAX_LIMIT = 30
MIN_FTS_CHARS = 3
DEFAULT_RADIUS_M = 3000
MAX_TAGS = 8
# lower value wins a duplicate
SOURCE_PRIORITY: dict[str, int] = {"manual": 0, "sample": 1, "public-data": 1, "tourapi": 2, "jejuhub": 3, "OpenStreetMap": 4}
SOURCE_LABELS: dict[str, str] = {
    "sample": "오마이제주 큐레이션", "manual": "오마이제주 큐레이션", "public-data": "공공데이터포털",
    "tourapi": "한국관광공사 TourAPI 4.0", "jejuhub": "제주데이터허브(제주테크노파크)", "OpenStreetMap": "OpenStreetMap 기여자",
}
# TourAPI contenttypeid -> catalog category (15 축제공연행사 / 25 여행코스 are not places)
TOURAPI_CATEGORY: dict[str, str] = {"12": "관광지", "14": "문화시설", "28": "레포츠", "32": "숙박", "38": "쇼핑", "39": "맛집"}
JEJUHUB_CATEGORY: dict[str, str] = {"oreum": "오름", "museums": "박물관"}
# OSM (key, value) -> catalog category. natural=peak is special-cased in _osm_category(): only a name
# ending in 오름/봉/악/산, or containing 한라산, keeps 오름 here — anything else demotes to 관광지.
OSM_CATEGORY: dict[tuple[str, str], str] = {
    ("amenity", "cafe"): "카페", ("amenity", "restaurant"): "맛집", ("amenity", "fast_food"): "맛집",
    ("amenity", "parking"): "주차장",
    ("tourism", "attraction"): "관광지", ("tourism", "viewpoint"): "관광지", ("tourism", "theme_park"): "관광지",
    ("tourism", "zoo"): "관광지", ("tourism", "museum"): "박물관", ("tourism", "gallery"): "박물관",
    ("natural", "beach"): "해변", ("natural", "peak"): "오름",
    ("leisure", "park"): "관광지",
}
# amenity -> tourism -> natural -> leisure: the same precedence write_snapshot() uses for its `counts`
# report (see task-1-report.md), but here it is a per-field FALLTHROUGH, not a first-non-null pick: an
# element tagged amenity=shelter (unmappable) AND tourism=viewpoint (mappable) still maps to 관광지
# instead of being dropped, because _osm_category() keeps checking the remaining keys.
OSM_CATEGORY_KEYS: tuple[str, ...] = ("amenity", "tourism", "natural", "leisure")
OSM_OREUM_NAME_RE = re.compile(r"(오름|봉|악|산)$")
CUISINE_KO: dict[str, str] = {"korean": "한식", "japanese": "일식", "chinese": "중식", "coffee_shop": "커피", "seafood": "해산물"}
RECORD_KEYS: tuple[str, ...] = ("id", "name", "name_en", "category", "lat", "lng", "address", "summary", "tags",
                                "source", "url", "phone", "hours", "updated_at", "region", "avg_stay_min")
MARKER_KEYS: tuple[str, ...] = ("id", "name", "lat", "lng", "category", "summary", "source", "observed_at", "url", "phone", "hours", "distance_m")


def _sample_path() -> Path | None:
    """Only the sample dataset shipped beside this CodeZip module."""
    candidate = Path(__file__).resolve().parent / "data" / "jeju_pois.json"
    return candidate if candidate.is_file() else None


# ---- pure helpers ----------------------------------------------------------------------------
def in_bbox(lat: float, lng: float) -> bool:
    return BBOX["lat"][0] <= lat <= BBOX["lat"][1] and BBOX["lng"][0] <= lng <= BBOX["lng"][1]


def norm_text(text: str | None) -> str:
    """NFC, drop all whitespace, casefold — the comparison form for names and short queries."""
    return re.sub(r"\s+", "", unicodedata.normalize("NFC", text or "")).casefold()


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> int:
    dlat, dlng = radians(lat2 - lat1), radians(lng2 - lng1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlng / 2) ** 2
    return int(round(2 * 6371008.8 * asin(sqrt(a))))


def _f(value: Any) -> float | None:
    if value is None:
        return None
    try:
        s = str(value).strip()
        return float(s) if s else None
    except (TypeError, ValueError):
        return None


def _s(value: Any) -> str | None:
    s = str(value).strip() if value is not None else ""
    return s or None


def _date_from_compact(value: Any, fallback: str) -> str:
    """'20250101120000' -> '2025-01-01'; anything else -> fallback[:10]."""
    s = str(value or "").strip()
    if re.fullmatch(r"\d{8,14}", s):
        return f"{s[:4]}-{s[4:6]}-{s[6:8]}"
    return fallback[:10]


def _record(**fields: Any) -> dict[str, Any]:
    rec: dict[str, Any] = {k: None for k in RECORD_KEYS}
    rec["tags"] = []
    rec.update(fields)
    return rec


# ---- source mappers --------------------------------------------------------------------------
def map_sample(poi: dict[str, Any], updated_at: str) -> dict[str, Any]:
    """data/jeju_pois.json record (schema data/schema.json) -> catalog record; ids like poi_0001 are preserved."""
    return _record(
        id=poi["id"], name=poi["name"], name_en=_s(poi.get("name_en")), category=poi["category"],
        lat=float(poi["lat"]), lng=float(poi["lng"]), address=_s(poi.get("address")), summary=_s(poi.get("summary")),
        tags=list(poi.get("tags") or [])[:MAX_TAGS], source=poi.get("source") or "sample", region=_s(poi.get("region")),
        avg_stay_min=poi.get("avg_stay_min"), updated_at=updated_at[:10],
    )


def sample_extra(poi: dict[str, Any], updated_at: str) -> dict[str, Any]:
    """data/jeju_pois.json's kid_friendly/parking (schema data/schema.json, required on every curated
    POI) -> a place_extra row (spec §4.1). map_sample() never reads these two booleans into the places
    row itself (spec §1 결함 3) -- build_catalog() calls this once per curated POI and folds the result
    into the SAME accumulator _collect_extra() builds from enrich snapshots, via _merge_extra_item()
    with source="curated" (the lowest-priority source in every _EXTRA_FIELD_PRECEDENCE list, so a real
    enrich source's facilities value always wins when one exists)."""
    facilities: dict[str, str] = {}
    if "kid_friendly" in poi:
        facilities["kid_friendly"] = "yes" if poi["kid_friendly"] else "no"
    if "parking" in poi:
        facilities["parking"] = "yes" if poi["parking"] else "no"
    return {
        "id": poi["id"], "photos": [], "hours_week": None, "hours_source": None, "facilities": facilities,
        "overview": None, "menu": None, "business_status": None, "tips": None,
        "sources": [{"source": "curated", "url": None, "observed_at": None, "license": "curated"}],
        "fetched_at": updated_at,
    }


def _apply_curated_extra(rows: list[dict[str, Any]], sample_pois: list[dict[str, Any]],
                         valid_ids: set[str], built_at: str) -> list[dict[str, Any]]:
    """Fold each curated POI's kid_friendly/parking (sample_extra()) into rows, mutating and returning
    the same list. curated NEVER overwrites a facility key an enrich source already set -- it is the
    lowest-priority source in _EXTRA_FIELD_PRECEDENCE["facilities"] -- it only fills keys still missing,
    via a plain dict.setdefault() rather than re-running the full _merge_extra_item() precedence machinery
    (curated has no competing overview/hours_week/menu/business_status contribution, so that machinery
    would be pure overhead here)."""
    by_id = {r["id"]: r for r in rows}
    for poi in sample_pois:
        pid = poi.get("id")
        if pid not in valid_ids:
            continue
        extra = sample_extra(poi, built_at)
        row = by_id.get(pid)
        if row is None:
            rows.append(extra)
            by_id[pid] = extra
            continue
        for key, value in extra["facilities"].items():
            row["facilities"].setdefault(key, value)
        row["sources"] = [*row["sources"], *extra["sources"]]
        if not row.get("fetched_at"):
            row["fetched_at"] = extra["fetched_at"]
    return rows


def map_tourapi(item: dict[str, Any], fetched_at: str) -> dict[str, Any] | None:
    """Raw KorService2 item -> catalog record. mapx is longitude, mapy is latitude (strings). None when unusable."""
    lng, lat = _f(item.get("mapx")), _f(item.get("mapy"))
    category = TOURAPI_CATEGORY.get(str(item.get("contenttypeid") or "").strip())
    name = _s(item.get("title"))
    cid = _s(item.get("contentid"))
    if lat is None or lng is None or category is None or name is None or cid is None:
        return None
    address = " ".join(p for p in (_s(item.get("addr1")) or "", _s(item.get("addr2")) or "") if p) or None
    return _record(
        id=f"tour_{cid}", name=name, category=category, lat=lat, lng=lng, address=address, tags=[category],
        source="tourapi", phone=_s(item.get("tel")), updated_at=_date_from_compact(item.get("modifiedtime"), fetched_at),
    )


def map_jejuhub(row: dict[str, Any], kind: str, fetched_at: str) -> dict[str, Any] | None:
    """Jeju Data Hub 오름/박물관 row (2025-09 Kakao POI snapshot) -> catalog record with a stable content-hash id."""
    category = JEJUHUB_CATEGORY.get(kind)
    lat, lng = _f(row.get("latitude")), _f(row.get("longitude"))
    name = _s(row.get("placeName"))
    if category is None or lat is None or lng is None or name is None:
        return None
    raw_cat = str(row.get("category") or "")
    extra_tags = [t.strip() for t in re.split(r"[>,]", raw_cat) if t.strip() and t.strip() != category]
    digest = hashlib.sha1(f"{name}|{lat:.5f}|{lng:.5f}".encode("utf-8")).hexdigest()[:10]
    return _record(
        id=f"hub_{kind}_{digest}", name=name, category=category, lat=lat, lng=lng,
        address=_s(row.get("addressDoro")) or _s(row.get("addressJibun")), tags=[category, *extra_tags][:MAX_TAGS],
        source="jejuhub", url=_s(row.get("placeUrl")), updated_at=fetched_at[:10],
    )


def _osm_is_short_name(name: str | None) -> bool:
    return not name or len(name) < 2


def _osm_is_lifecycle_tagged(osm_tags: dict[str, Any]) -> bool:
    """True when any osm_tags value carries an OSM lifecycle prefix (disused:*/abandoned:*) -- the only
    way that convention can show up given osm_tags' fixed 5 keys (see map_osm's docstring)."""
    return any(isinstance(v, str) and (v.startswith("disused:") or v.startswith("abandoned:")) for v in osm_tags.values())


def _osm_category(osm_tags: dict[str, Any], name: str) -> tuple[str, str] | None:
    """First (key, value) pair in OSM_CATEGORY_KEYS order whose value maps to a catalog category, plus the
    raw matched value (kept for `tags`). natural=peak only keeps 오름 when `name` ends in 오름/봉/악/산 or
    contains 한라산 (map_osm's docstring links this to the peak/오름/관광지 split in OSM_CATEGORY). None when
    no key in osm_tags maps to anything -- the caller drops the item, uncounted, same as an unmappable
    TourAPI contenttypeid or Data Hub `kind` already does in map_tourapi()/map_jejuhub()."""
    for key in OSM_CATEGORY_KEYS:
        value = osm_tags.get(key)
        if not value:
            continue
        category = OSM_CATEGORY.get((key, value))
        if category is None:
            continue
        if key == "natural" and value == "peak" and not (OSM_OREUM_NAME_RE.search(name) or "한라산" in name):
            category = "관광지"
        return category, value
    return None


def map_osm(item: dict[str, Any], fetched_at: str) -> dict[str, Any] | None:
    """Task 1's normalised OSM snapshot item (scripts/product-runner-osm.py; see task-1-report.md
    "Interfaces for later tasks") -> catalog record. None when: the name is missing or under 2 characters,
    coordinates are missing, any osm_tags value carries an OSM lifecycle prefix (disused:*/abandoned:*,
    the only way that convention can show up given osm_tags' fixed 5 keys -- see task-2-report.md), or no
    tag in osm_tags maps to a catalog category (OSM_CATEGORY). bbox is NOT checked here: validate_record()
    catches that uniformly for every source and counts it under "out_of_bbox".

    Do NOT read the snapshot envelope's `counts` field for category info (task-1-report.md warns it is a
    report-only aggregate with a different, lossy precedence) -- osm_tags itself is the source of truth."""
    name = _s(item.get("name"))
    lat, lng = _f(item.get("lat")), _f(item.get("lng"))
    item_id = _s(item.get("id"))
    if _osm_is_short_name(name) or lat is None or lng is None or item_id is None:
        return None
    osm_tags = item.get("osm_tags") or {}
    if _osm_is_lifecycle_tagged(osm_tags):
        return None
    found = _osm_category(osm_tags, name)
    if found is None:
        return None
    category, matched_value = found
    cuisine = _s(osm_tags.get("cuisine"))
    summary = f"{CUISINE_KO.get(cuisine, cuisine)} · OpenStreetMap 등록 장소" if cuisine else "OpenStreetMap 등록 장소"
    # Controller ruling R10 overrides the original brief's `tags: [osm 카테고리 원문, cuisine…]`: the
    # Korean catalog category goes FIRST (matching map_tourapi()/map_jejuhub()), the raw OSM value
    # second, cuisine after. Sidebar category chips send their label as free-text `q` against
    # name_norm/tags_text (not the `category` column) -- with the English value first, a chip search
    # for e.g. 맛집/관광지 could never match an OSM row (measured before this fix: 맛집 3/5,241, 관광지
    # 0/348). dict.fromkeys() dedupes in case category and matched_value ever collide.
    tags = list(dict.fromkeys([category, matched_value, *([cuisine] if cuisine else [])]))[:MAX_TAGS]
    osm_prefix, sep, osm_ref = item_id.partition(":")  # "osm:node/1001" -> "node/1001"
    # `osm_ref` is only meaningful when item_id actually had an "osm:" prefix (sep == ":" and
    # osm_prefix == "osm") -- the same prefix dedupe() relies on (see its dropped.duplicate vs
    # dropped.duplicate_osm split, ~line 393) to tell an OSM id apart from any other source's id. Without
    # that prefix `osm_ref` would be empty and building a permalink from it would yield a bare, useless
    # "https://www.openstreetmap.org/" -- fall back to None instead.
    fallback_url = f"https://www.openstreetmap.org/{osm_ref}" if sep and osm_prefix == "osm" and osm_ref else None
    url = _s(item.get("url")) or fallback_url
    return _record(
        id=item_id, name=name, name_en=_s(item.get("name_en")), category=category, lat=lat, lng=lng,
        address=_s(item.get("address")), summary=summary, tags=tags,
        source="OpenStreetMap", url=url, phone=_s(item.get("phone")), hours=_s(item.get("hours")),
        updated_at=str(item.get("updated_at") or fetched_at)[:10],
    )


def validate_record(rec: dict[str, Any]) -> str | None:
    if not _s(rec.get("name")):
        return "missing_name"
    if not isinstance(rec.get("lat"), (int, float)) or not isinstance(rec.get("lng"), (int, float)):
        return "missing_coords"
    if not in_bbox(float(rec["lat"]), float(rec["lng"])):
        return "out_of_bbox"
    if rec.get("category") not in CATEGORIES:
        return "bad_category"
    return None


def dedupe(records: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[tuple[str, str]]]:
    """Same normalised name within a radius -> keep the higher-priority source and fill its empty fields
    from the dropped record. The radius is DEDUPE_RADIUS_M (150 m) except when either side of the pair is
    an OSM record, where it tightens to OSM_DEDUPE_RADIUS_M (100 m, brief's rule) -- this also covers two
    OSM records duplicating each other. Returns (kept, [(kept_id, dropped_id), ...]); input order does not
    matter; the caller classifies a dropped id by its "osm:" id prefix to count it under dropped.duplicate
    vs dropped.duplicate_osm."""
    ordered = sorted(records, key=lambda r: (SOURCE_PRIORITY.get(r["source"], 9), r["id"]))
    kept: list[dict[str, Any]] = []
    by_name: dict[str, list[dict[str, Any]]] = {}
    dropped: list[tuple[str, str]] = []
    for rec in ordered:
        key = norm_text(rec["name"])
        winner = next((k for k in by_name.get(key, [])
                       if haversine_m(k["lat"], k["lng"], rec["lat"], rec["lng"])
                       <= (OSM_DEDUPE_RADIUS_M if "OpenStreetMap" in (k["source"], rec["source"]) else DEDUPE_RADIUS_M)), None)
        if winner is None:
            kept.append(rec)
            by_name.setdefault(key, []).append(rec)
            continue
        for field in ("name_en", "address", "summary", "phone", "hours", "avg_stay_min", "region"):
            if not winner.get(field) and rec.get(field):
                winner[field] = rec[field]
        # url is back-filled separately (final review, spec §1 결함 1): a curated winner (source
        # "sample"/"manual") NEVER receives a back-filled url regardless of the donor -- only jejuhub's
        # own map_jejuhub()-assigned url and a source's own real website may ever appear on a places row
        # (test_catalog_url_only_comes_from_the_jejuhub_snapshot_never_from_the_kakao_api's boundary).
        # An OpenStreetMap.org permalink specifically is never back-filled into ANY winner, curated or
        # not -- it is legitimate only as an OSM record's OWN url (map_osm()'s fallback), never as
        # someone else's "website".
        donor_url = rec.get("url")
        if (not winner.get("url") and donor_url and "openstreetmap.org" not in donor_url
                and winner.get("source") not in ("sample", "manual")):
            winner["url"] = donor_url
        winner["tags"] = list(dict.fromkeys([*winner["tags"], *rec["tags"]]))[:MAX_TAGS]
        dropped.append((winner["id"], rec["id"]))
    return kept, dropped


# ---- build -----------------------------------------------------------------------------------
DDL = """
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE places(
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  name_en TEXT,
  category TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  address TEXT,
  summary TEXT,
  tags TEXT NOT NULL,          -- JSON array
  source TEXT NOT NULL,
  url TEXT,
  phone TEXT,
  hours TEXT,
  updated_at TEXT NOT NULL,    -- YYYY-MM-DD
  region TEXT,
  avg_stay_min INTEGER,
  name_norm TEXT NOT NULL,     -- norm_text(name)
  tags_text TEXT NOT NULL      -- ' '.join(tags), casefolded
);
CREATE INDEX idx_places_lat_lng ON places(lat, lng);
CREATE INDEX idx_places_category ON places(category);
CREATE VIRTUAL TABLE places_fts USING fts5(
  name, name_en, tags_text, summary, address,
  content='places', content_rowid='rid', tokenize='trigram'
);
CREATE TABLE IF NOT EXISTS place_extra(
  id TEXT PRIMARY KEY,
  photos TEXT, hours_week TEXT, hours_source TEXT, facilities TEXT,
  overview TEXT, menu TEXT, business_status TEXT, tips TEXT, sources TEXT, fetched_at TEXT
);
"""
INSERT_SQL = ("INSERT INTO places(id,name,name_en,category,lat,lng,address,summary,tags,source,url,phone,hours,updated_at,region,avg_stay_min,name_norm,tags_text) "
              "VALUES(:id,:name,:name_en,:category,:lat,:lng,:address,:summary,:tags,:source,:url,:phone,:hours,:updated_at,:region,:avg_stay_min,:name_norm,:tags_text)")
EXTRA_INSERT_SQL = ("INSERT INTO place_extra(id,photos,hours_week,hours_source,facilities,overview,menu,business_status,tips,sources,fetched_at) "
                    "VALUES(:id,:photos,:hours_week,:hours_source,:facilities,:overview,:menu,:business_status,:tips,:sources,:fetched_at)")
_EXTRA_JSON_FIELDS: tuple[str, ...] = ("photos", "hours_week", "facilities", "menu", "sources", "tips")
_EXTRA_LIST_DEFAULTS: dict[str, Any] = {"photos": [], "menu": [], "sources": []}
# facilities is a dict-shaped column, not list-shaped -- mirrors place_extra.py's _DICT_DEFAULTS so a NULL
# facilities column decodes to {} here too (Catalog.extra()/stats() callers must see the same shape
# place_extra.read_extra() gives BFF/agent-tool callers; a bare .get(field) miss must never surface as None).
_EXTRA_DICT_DEFAULTS: dict[str, Any] = {"facilities": {}}
# Photo license / no-derivatives / menu-length gates duplicated from place_extra.py's validate_extra() --
# catalog.py cannot import place_extra.py (R6), so the SAME enum/caps are re-declared here verbatim and
# enforced in _merge_extra_item() (Global Constraints: photos with an unmapped license, or a KOGL-3/4 photo
# carrying a non-null thumb_url, are never written to place_extra; menu is capped the same way as the
# upsert_extra() write path).
EXTRA_LICENSES: frozenset[str] = frozenset({
    "KOGL-1", "KOGL-2", "KOGL-3", "KOGL-4", "CC-BY-SA-2.0", "CC-BY-SA-3.0", "CC-BY-SA-4.0",
    "CC-BY-4.0", "CC0", "PD", "unrestricted", "curated",
})
EXTRA_NO_DERIVATIVES: frozenset[str] = frozenset({"KOGL-3", "KOGL-4"})
MAX_EXTRA_MENU_ITEMS = 12
# Field precedence when several enrich sources contribute to the SAME place_id (spec §4.1/§13). Lower
# index wins. facilities merges per KEY at this precedence; the other three are whole-field. business_status
# and photos/sources/fetched_at are handled separately in _merge_extra_item() (no "precedence" — see there).
_EXTRA_FIELD_PRECEDENCE: dict[str, tuple[str, ...]] = {
    "facilities": ("tourapi_detail", "localdata", "visitjeju", "osm", "curated"),
    "overview": ("tourapi_detail", "wikimedia", "visitjeju"),
    "hours_week": ("tourapi_detail", "osm", "curated"),
    "menu": ("good_price", "tourapi_detail"),
}


# OSM amenity tag -> place_extra.facilities key/value (plan 14 판정 R11). scripts/product-runner-osm.py
# keeps nine tags per item in `osm_extra_tags`; only these four map onto the facilities enum, and only the
# listed tag values do -- an unknown token (wheelchair=designated, internet_access=terminal) is DROPPED
# rather than guessed, because "unknown" is a first-class facilities value the BFF simply does not render.
# `fee`/`wikidata`/`wikipedia`/`image`/`brand` have no facilities counterpart and are ignored here.
_OSM_FACILITY_MAP: dict[str, dict[str, tuple[str, str]]] = {
    "wheelchair": {"yes": ("wheelchair", "yes"), "limited": ("wheelchair", "limited"), "no": ("wheelchair", "no")},
    "outdoor_seating": {"yes": ("outdoor_seating", "yes"), "no": ("outdoor_seating", "no")},
    "internet_access": {"wlan": ("wifi", "yes"), "yes": ("wifi", "yes"), "free": ("wifi", "yes"), "no": ("wifi", "no")},
    "toilets": {"yes": ("restroom", "yes"), "no": ("restroom", "no")},
}
OSM_EXTRA_LICENSE = "ODbL"  # sources[].license for an OSM contribution (place_extra.validate_extra gates
# photo licenses only, so this carries the real licence instead of being flattened into "unrestricted")


def _facilities_from_osm_tags(tags: dict[str, Any]) -> dict[str, str]:
    """`osm_extra_tags` -> the place_extra.facilities subset OSM can actually attest. {} when nothing maps."""
    out: dict[str, str] = {}
    for tag, values in _OSM_FACILITY_MAP.items():
        mapped = values.get(str(tags.get(tag) or "").strip().lower())
        if mapped is not None:
            out[mapped[0]] = mapped[1]
    return out


def _extra_rank(field: str, source: str) -> int:
    order = _EXTRA_FIELD_PRECEDENCE.get(field, ())
    return order.index(source) if source in order else len(order)


def _encode_extra_row(row: dict[str, Any]) -> dict[str, Any]:
    params = {"id": row["id"], "hours_source": row.get("hours_source"), "overview": row.get("overview"),
              "business_status": row.get("business_status"), "fetched_at": row.get("fetched_at")}
    for field in _EXTRA_JSON_FIELDS:
        value = row.get(field)
        params[field] = json.dumps(value, ensure_ascii=False) if value not in (None, [], {}) else None
    return params


def _decode_extra_row(row: sqlite3.Row) -> dict[str, Any]:
    out: dict[str, Any] = {"id": row["id"], "hours_source": row["hours_source"], "overview": row["overview"],
                           "business_status": row["business_status"], "fetched_at": row["fetched_at"]}
    for field in _EXTRA_JSON_FIELDS:
        value = row[field]
        out[field] = json.loads(value) if value else _EXTRA_LIST_DEFAULTS.get(field, _EXTRA_DICT_DEFAULTS.get(field))
    return out


def _new_extra_row(place_id: str, fetched_at: str) -> dict[str, Any]:
    return {"id": place_id, "photos": [], "hours_week": None, "hours_source": None, "facilities": {},
            "overview": None, "menu": None, "business_status": None, "tips": None, "sources": [],
            "fetched_at": fetched_at}


def _photo_key(photo: dict[str, Any]) -> str | None:
    """Dedupe identity for one place_extra photo: the mirrored `url` when media_sync has already written
    one, otherwise the `origin_url` the runner produced. At BUILD time no producer has filled `url` yet
    (_photos_from_images/_commons_imageinfo write origin_url only; media_sync fills url/thumb_url
    afterwards), so keying on `url` alone made every photo after the first collide on None and be dropped.
    None means "no identity" -- such a photo is appended without taking part in dedupe."""
    return photo.get("url") or photo.get("origin_url") or None


def _merge_extra_item(rows: dict[str, dict[str, Any]], owners: dict[str, dict[str, Any]],
                      place_id: str, source: str, extra: dict[str, Any], fetched_at: str) -> None:
    """Fold one matched enrich item into the accumulator for place_id (spec §4.1 precedence). photos
    concatenate (dedup by _photo_key, capped at MAX_EXTRA_PHOTOS, and gated by EXTRA_LICENSES/EXTRA_NO_DERIVATIVES
    -- an unmapped license or a KOGL-3/4 photo with a non-null thumb_url is skipped, never appended) and
    sources/fetched_at always accumulate -- neither has a "precedence", every contributing source's entry
    survives. menu is capped at MAX_EXTRA_MENU_ITEMS (overflow items dropped) the same way upsert_extra()
    caps it. business_status only ever comes from source == "localdata"; any other source's value is
    ignored."""
    row = rows.setdefault(place_id, _new_extra_row(place_id, fetched_at))
    owner = owners.setdefault(place_id, {"facilities": {}})
    if fetched_at > (row["fetched_at"] or ""):
        row["fetched_at"] = fetched_at

    seen_urls = {key for key in (_photo_key(p) for p in row["photos"]) if key is not None}
    for photo in extra.get("photos") or []:
        if len(row["photos"]) >= MAX_EXTRA_PHOTOS:
            break
        license_ = photo.get("license")
        if license_ not in EXTRA_LICENSES:
            continue  # Global Constraints: an unmapped license -> skip the photo itself, never store it
        if license_ in EXTRA_NO_DERIVATIVES and photo.get("thumb_url") is not None:
            continue  # KOGL-3/4 변경 금지: 원본 바이트만 미러, thumb_url must stay null
        key = _photo_key(photo)
        if key is not None and key in seen_urls:
            continue
        row["photos"].append(photo)
        if key is not None:
            seen_urls.add(key)

    for key, value in (extra.get("facilities") or {}).items():
        current = owner["facilities"].get(key)
        if current is None or _extra_rank("facilities", source) < _extra_rank("facilities", current):
            row["facilities"][key] = value
            owner["facilities"][key] = source

    for field in ("overview", "menu"):
        value = extra.get(field)
        if value is None:
            continue
        if field == "menu" and isinstance(value, list) and len(value) > MAX_EXTRA_MENU_ITEMS:
            value = value[:MAX_EXTRA_MENU_ITEMS]  # place_extra MAX_MENU_ITEMS cap: drop the overflow items
        current = owner.get(field)
        if current is None or _extra_rank(field, source) < _extra_rank(field, current):
            row[field] = value
            owner[field] = source

    hours_week = extra.get("hours_week")
    if hours_week is not None:
        current = owner.get("hours_week")
        if current is None or _extra_rank("hours_week", source) < _extra_rank("hours_week", current):
            row["hours_week"] = hours_week
            row["hours_source"] = extra.get("hours_source")
            owner["hours_week"] = source

    if source == "localdata" and extra.get("business_status") is not None:
        row["business_status"] = extra["business_status"]

    if extra.get("sources"):
        row["sources"] = [*row["sources"], *extra["sources"]]


def _collect_extra(extra_snapshots: Sequence[Path], valid_ids: set[str], built_at: str,
                   osm_snapshots: Sequence[Path] = ()) -> list[dict[str, Any]]:
    """Read every enrich-<source>-latest.json envelope (spec §4.9 shape) and merge per place_id. An item
    whose match.place_id is not (or no longer, post-dedupe) a real catalog id is dropped silently -- a
    stale enrich snapshot must never resurrect a row the build itself just rejected.

    osm_snapshots is the SAME osm-latest.json the places rows come from, folded in as a source="osm"
    facilities contribution (plan 14 판정 R11) -- the only producer of facilities for the 6,587 OSM
    places. It is merged through _merge_extra_item() like every other source, so
    _EXTRA_FIELD_PRECEDENCE decides each contested key (tourapi_detail/localdata/visitjeju all outrank
    osm). A place whose tags map to nothing gets NO row: an empty place_extra row would inflate
    extra_count and teach the BFF that a place "has extra" when it has none.
    """
    rows: dict[str, dict[str, Any]] = {}
    owners: dict[str, dict[str, Any]] = {}
    for snap in osm_snapshots:
        payload = _load_json(snap)
        fetched_at = str(payload.get("fetched_at") or built_at)
        for item in payload.get("items", []):
            place_id = item.get("id")
            if not place_id or place_id not in valid_ids:
                continue
            facilities = _facilities_from_osm_tags(item.get("osm_extra_tags") or {})
            if not facilities:
                continue
            extra = {"facilities": facilities,
                     "sources": [{"source": "osm", "url": None, "observed_at": fetched_at,
                                  "license": OSM_EXTRA_LICENSE}]}
            _merge_extra_item(rows, owners, place_id, "osm", extra, fetched_at)
    for snap in extra_snapshots:
        payload = _load_json(snap)
        source = str(payload.get("source") or "")
        envelope_fetched_at = str(payload.get("fetched_at") or built_at)
        for item in payload.get("items", []):
            match = item.get("match") or {}
            place_id = match.get("place_id")
            if not place_id or place_id not in valid_ids:
                continue
            extra = item.get("extra") or {}
            item_fetched_at = str(extra.get("fetched_at") or envelope_fetched_at)
            # extra.sources is the item's own provenance list; when the runner didn't set one (a plain
            # single-field enrichment), fall back to one entry built from the envelope itself so
            # extra_by_source (derived from every row's accumulated sources[]) still attributes the
            # contribution to its actual source.
            if not extra.get("sources"):
                extra = {**extra, "sources": [{"source": source, "url": None, "observed_at": item_fetched_at,
                                               "license": str(payload.get("license") or "")}]}
            _merge_extra_item(rows, owners, place_id, source, extra, item_fetched_at)
    return list(rows.values())


def _load_json(path: Path) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _collect(sample_path: Path | None, tourapi_snapshots: Sequence[Path], jejuhub_snapshots: Sequence[Path],
             osm_snapshots: Sequence[Path], built_at: str) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Read every build input. The curated sample set, TourAPI snapshots, Jeju Data Hub snapshots and OSM
    snapshots are the ONLY sources. Kakao REST API responses must never become a build input — the single
    Kakao-derived value in the catalog is the Data Hub snapshot's `placeUrl` (distributed under the Data Hub
    terms), mapped by map_jejuhub(). OSM's `url` is either the snapshot's own `website`/`contact:website`
    value or an openstreetmap.org permalink built by map_osm() -- never Kakao either. Adding a further
    source here needs the same audit
    (test_catalog_url_only_comes_from_the_jejuhub_snapshot_never_from_the_kakao_api fixes this boundary).

    Returns (records, osm_quality_dropped): unlike map_tourapi()/map_jejuhub() (an unmappable category
    silently returns None, uncounted), the brief requires the OSM short-name and lifecycle-tag quality
    filters to be COUNTED (review fix round 1), so this loop checks those two conditions itself -- with
    the exact predicates map_osm() uses internally (_osm_is_short_name/_osm_is_lifecycle_tagged) so the
    two never drift apart -- before calling map_osm(), and tallies them in the returned dict instead of
    letting map_osm() swallow them. Unmappable categories still fall through map_osm() and stay
    uncounted, unchanged from before this fix."""
    records: list[dict[str, Any]] = []
    osm_quality_dropped: dict[str, int] = {}
    if sample_path:
        records.extend(map_sample(p, built_at) for p in _load_json(sample_path))
    for snap in tourapi_snapshots:
        payload = _load_json(snap)
        fetched = str(payload.get("fetched_at") or built_at)
        records.extend(r for r in (map_tourapi(i, fetched) for i in payload.get("items", [])) if r is not None)
    for snap in jejuhub_snapshots:
        payload = _load_json(snap)
        fetched, kind = str(payload.get("fetched_at") or built_at), str(payload.get("kind") or "")
        records.extend(r for r in (map_jejuhub(i, kind, fetched) for i in payload.get("items", [])) if r is not None)
    for snap in osm_snapshots:
        payload = _load_json(snap)
        fetched = str(payload.get("fetched_at") or built_at)
        for item in payload.get("items", []):
            name = _s(item.get("name"))
            if _osm_is_short_name(name):
                osm_quality_dropped["short_name"] = osm_quality_dropped.get("short_name", 0) + 1
                continue
            if _osm_is_lifecycle_tagged(item.get("osm_tags") or {}):
                osm_quality_dropped["lifecycle_tagged"] = osm_quality_dropped.get("lifecycle_tagged", 0) + 1
                continue
            rec = map_osm(item, fetched)
            if rec is not None:
                records.append(rec)
    return records, osm_quality_dropped


def build_catalog(out_path: Path, sample_path: Path | None = None, tourapi_snapshots: Sequence[Path] = (),
                  jejuhub_snapshots: Sequence[Path] = (), osm_snapshots: Sequence[Path] = (),
                  extra_snapshots: Sequence[Path] = (), built_at: str | None = None, use_sample: bool = True) -> dict[str, Any]:
    """Build a fresh SQLite catalog at out_path (replaced atomically) and return the build report.

    use_sample=False builds a snapshot-only catalog (no curated sample records at all — the CLI's
    --no-sample). sample_path is only consulted when use_sample is True: an explicit path is used as
    given, None falls back to auto-discovering data/jeju_pois.json via _sample_path()."""
    out_path = Path(out_path)
    sample = (Path(sample_path) if sample_path else _sample_path()) if use_sample else None
    built_at = built_at or datetime.now(timezone.utc).isoformat(timespec="seconds")
    dropped = {"out_of_bbox": 0, "bad_category": 0, "missing_name": 0, "missing_coords": 0, "duplicate": 0}
    if osm_snapshots:
        dropped["duplicate_osm"] = 0
    valid: list[dict[str, Any]] = []
    collected, osm_quality_dropped = _collect(sample, list(tourapi_snapshots), list(jejuhub_snapshots), list(osm_snapshots), built_at)
    if osm_snapshots:
        dropped["short_name"] = osm_quality_dropped.get("short_name", 0)
        dropped["lifecycle_tagged"] = osm_quality_dropped.get("lifecycle_tagged", 0)
    for rec in collected:
        reason = validate_record(rec)
        if reason:
            dropped[reason] += 1
            continue
        valid.append(rec)
    # Captured before dedupe() runs (Minor #3, final review): dedupe() back-fills a surviving record's
    # empty fields (name_en/address/summary/url/phone/hours/...) from every record it drops, OSM ones
    # included, so a build can have zero surviving "source": "OpenStreetMap" rows and still owe its
    # attribution to an OSM record that contributed a field before being dropped as a duplicate.
    osm_mapped_count = sum(1 for r in valid if r["source"] == "OpenStreetMap")
    kept, duplicates = dedupe(valid)
    # A dropped id's "osm:" prefix (map_osm's id format, task-1-report.md) is how the OSM-specific
    # dedupe rule (brief: 100 m, keep the existing sample/tourapi/jejuhub record, count separately) is
    # told apart from the pre-existing 150 m cross-source rule without dedupe() returning full records.
    osm_duplicates = sum(1 for _, dropped_id in duplicates if dropped_id.startswith("osm:"))
    dropped["duplicate"] = len(duplicates) - osm_duplicates
    if osm_snapshots:
        dropped["duplicate_osm"] = osm_duplicates
    kept.sort(key=lambda r: (SOURCE_PRIORITY.get(r["source"], 9), r["id"]))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_suffix(out_path.suffix + ".tmp")
    if tmp.exists():
        tmp.unlink()
    by_source: dict[str, int] = {}
    by_category: dict[str, int] = {}
    conn = sqlite3.connect(tmp)
    try:
        conn.executescript(DDL)
        conn.executemany(INSERT_SQL, [{**r, "tags": json.dumps(r["tags"], ensure_ascii=False), "name_norm": norm_text(r["name"]),
                                       "tags_text": " ".join(r["tags"]).casefold()} for r in kept])
        conn.execute("INSERT INTO places_fts(places_fts) VALUES('rebuild')")
        valid_ids = {r["id"] for r in kept}
        extra_rows = _collect_extra(list(extra_snapshots), valid_ids, built_at,
                                    osm_snapshots=list(osm_snapshots))
        if use_sample and sample:
            extra_rows = _apply_curated_extra(extra_rows, _load_json(sample), valid_ids, built_at)
        conn.executemany(EXTRA_INSERT_SQL, [_encode_extra_row(r) for r in extra_rows])
        extra_by_source: dict[str, int] = {}
        for extra_row in extra_rows:
            for contributed in extra_row.get("sources") or []:
                src_name = contributed.get("source")
                if src_name:
                    extra_by_source[src_name] = extra_by_source.get(src_name, 0) + 1
        extra_count = len(extra_rows)
        photos_count = sum(1 for r in extra_rows if r.get("photos"))
        hours_week_count = sum(1 for r in extra_rows if r.get("hours_week"))
        by_source = dict(sorted(conn.execute("SELECT source, COUNT(*) FROM places GROUP BY source").fetchall()))
        by_category = dict(sorted(conn.execute("SELECT category, COUNT(*) FROM places GROUP BY category").fetchall()))
        # attribution is a meta ROW, not a places COLUMN (R5: no schema/column changes) — written when
        # at least one OSM record was mapped and passed validate_record() (osm_mapped_count, captured
        # before dedupe above), NOT only when one survived dedupe into by_source: see the osm_mapped_count
        # comment for why a build can owe attribution to an OSM record that dedupe() later dropped.
        attribution = OSM_ATTRIBUTION if osm_mapped_count > 0 else None
        meta = {"schema_version": str(SCHEMA_VERSION), "built_at": built_at, "count": str(len(kept)),
                "by_source": json.dumps(by_source, ensure_ascii=False), "dropped": json.dumps(dropped),
                "extra_tables": json.dumps(list(EXTRA_TABLES)), "extra_count": str(extra_count),
                "extra_by_source": json.dumps(extra_by_source, ensure_ascii=False),
                "photos_count": str(photos_count), "hours_week_count": str(hours_week_count),
                "match_precision_sample": "null"}
        if attribution:
            meta["attribution"] = attribution
        conn.executemany("INSERT INTO meta(key, value) VALUES(?, ?)", list(meta.items()))
        conn.commit()
        conn.execute("VACUUM")
    finally:
        conn.close()
    os.replace(tmp, out_path)
    report = {"path": str(out_path), "count": len(kept), "by_source": by_source, "by_category": by_category,
              "dropped": dropped, "built_at": built_at, "schema_version": SCHEMA_VERSION, "attribution": attribution,
              "extra_tables": list(EXTRA_TABLES), "extra_count": extra_count, "extra_by_source": extra_by_source,
              "photos_count": photos_count, "hours_week_count": hours_week_count, "match_precision_sample": None}
    log.info("catalog built: %s", json.dumps(report, ensure_ascii=False))
    return report


# ---- read side -------------------------------------------------------------------------------
def _row_to_record(row: sqlite3.Row) -> dict[str, Any]:
    rec = {k: row[k] for k in RECORD_KEYS}
    rec["tags"] = json.loads(row["tags"]) if row["tags"] else []
    return rec


class Catalog:
    """Read-only view over a built catalog file. Safe to share across FastAPI threadpool workers."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._conn = sqlite3.connect(f"file:{self.path}?mode=ro&immutable=1", uri=True, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        self._has_extra: bool | None = None

    def _query(self, sql: str, params: tuple | list = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(sql, params).fetchall()

    def get(self, place_id: str) -> dict[str, Any] | None:
        rows = self._query("SELECT * FROM places WHERE id = ?", (place_id,))
        return _row_to_record(rows[0]) if rows else None

    def has_extra(self) -> bool:
        if self._has_extra is None:
            self._has_extra = bool(self._query(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='place_extra'"))
        return self._has_extra

    def extra(self, place_id: str) -> dict[str, Any] | None:
        if not self.has_extra():
            return None
        rows = self._query("SELECT * FROM place_extra WHERE id = ?", (place_id,))
        return _decode_extra_row(rows[0]) if rows else None

    @staticmethod
    def _clamp_limit(limit: Any) -> int:
        try:
            return max(1, min(int(limit), MAX_LIMIT))
        except (TypeError, ValueError):
            return 10

    @staticmethod
    def _like(fragment: str) -> str:
        return "%" + fragment.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"

    @staticmethod
    def _bbox_clause(lat: float, lng: float, radius_m: int) -> tuple[str, list[float]]:
        dlat = radius_m / 111_320.0
        dlng = radius_m / (111_320.0 * max(cos(radians(lat)), 0.01))
        return " AND p.lat BETWEEN ? AND ? AND p.lng BETWEEN ? AND ?", [lat - dlat, lat + dlat, lng - dlng, lng + dlng]

    def _with_distance(self, rows: list[sqlite3.Row], lat: float, lng: float, radius_m: int | None) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for row in rows:
            rec = _row_to_record(row)
            rec["distance_m"] = haversine_m(lat, lng, rec["lat"], rec["lng"])
            if radius_m is None or rec["distance_m"] <= radius_m:
                out.append(rec)
        return out

    def search(self, q: str = "", lat: float | None = None, lng: float | None = None, radius_m: int | None = None,
               category: str | None = None, limit: int = 10) -> list[dict[str, Any]]:
        """Text/category search, optionally centred on (lat, lng).

        Default radius policy — deliberately different for the two shapes the contract allows
        (`/api/search?q=&lat=&lng=&limit=` has no `radius_m`), because the two mean different things:

        * empty `q` + center  → a "what is around me" browse, so an unbounded answer would be the whole
          island sorted by distance. It defaults to DEFAULT_RADIUS_M (3 km) via nearby().
        * non-empty `q` + center → the user named a place; the center only orders the results. No radius
          is applied unless the caller passes one, so searching 성산일출봉 from 제주시 still finds it
          instead of returning nothing because it is 40 km away.

        An explicit `radius_m` bounds both shapes identically."""
        limit = self._clamp_limit(limit)
        has_center = lat is not None and lng is not None
        tokens = [t for t in unicodedata.normalize("NFC", q or "").casefold().split() if t]
        if not tokens:
            if has_center:
                return self.nearby(float(lat), float(lng), radius_m or DEFAULT_RADIUS_M, category, limit)
            return self._browse(category, limit)

        fts_tokens = [t for t in tokens if len(t) >= MIN_FTS_CHARS]
        short_tokens = [t for t in tokens if len(t) < MIN_FTS_CHARS]
        params: list[Any] = []
        if fts_tokens:
            match = " ".join('"' + t.replace('"', '""') + '"' for t in fts_tokens)
            sql = ("SELECT p.*, bm25(places_fts, 10.0, 6.0, 4.0, 1.0, 1.0) AS rank "
                   "FROM places_fts JOIN places p ON p.rid = places_fts.rowid WHERE places_fts MATCH ?")
            params.append(match)
        else:
            joined = norm_text("".join(short_tokens))
            sql = "SELECT p.*, 0.0 AS rank FROM places p WHERE (p.name_norm LIKE ? ESCAPE '\\' OR p.tags_text LIKE ? ESCAPE '\\')"
            params += [self._like(joined), self._like(joined)]
            short_tokens = []  # consumed as one joined fragment
        for t in short_tokens:
            sql += " AND (p.name_norm LIKE ? ESCAPE '\\' OR p.tags_text LIKE ? ESCAPE '\\' OR COALESCE(p.summary, '') LIKE ? ESCAPE '\\')"
            params += [self._like(norm_text(t)), self._like(t), self._like(t)]
        if category:
            sql += " AND p.category = ?"
            params.append(category)
        if has_center and radius_m:
            clause, box = self._bbox_clause(float(lat), float(lng), int(radius_m))
            sql += clause
            params += box
        sql += " ORDER BY rank, p.name"
        if not has_center:
            # No center: rank/name order IS the final contract order, so the DB may cut directly.
            sql += " LIMIT ?"
            params.append(limit)
        # With a center, never pre-cut in SQL: (rank, distance_m) is the final order and a SQL-side
        # LIMIT here would select rows by (rank, name) BEFORE distance is known, silently dropping
        # closer matches that happen to sort later alphabetically (verified against real data: a
        # short-token LIKE query ties every row's rank at 0.0, so a pre-cut is a pure name-alphabetical
        # cut and routinely evicts the nearest result). The catalog is small enough (curated + TourAPI +
        # JejuHub + OpenStreetMap snapshots combined, ~6.7k rows, measured p95 < 4 ms for a centred query)
        # that fetching every WHERE-matching row and
        # sorting in Python stays well inside the 300ms p95 search budget.
        rows = self._query(sql, params)
        if not has_center:
            return [_row_to_record(r) for r in rows]
        ranked = {r["id"]: r["rank"] for r in rows}
        recs = self._with_distance(rows, float(lat), float(lng), int(radius_m) if radius_m else None)
        recs.sort(key=lambda r: (ranked[r["id"]], r["distance_m"], r["name"]))
        return recs[:limit]

    def nearby(self, lat: float, lng: float, radius_m: int = DEFAULT_RADIUS_M, category: str | None = None,
               limit: int = 10) -> list[dict[str, Any]]:
        limit = self._clamp_limit(limit)
        clause, params = self._bbox_clause(float(lat), float(lng), int(radius_m))
        sql = "SELECT p.* FROM places p WHERE 1=1" + clause
        if category:
            sql += " AND p.category = ?"
            params.append(category)
        recs = self._with_distance(self._query(sql, params), float(lat), float(lng), int(radius_m))
        recs.sort(key=lambda r: (r["distance_m"], r["name"]))
        return recs[:limit]

    def _browse(self, category: str | None, limit: int) -> list[dict[str, Any]]:
        if category:
            rows = self._query("SELECT * FROM places WHERE category = ? ORDER BY name LIMIT ?", (category, limit))
        else:
            rows = self._query("SELECT * FROM places ORDER BY name LIMIT ?", (limit,))
        return [_row_to_record(r) for r in rows]

    def stats(self) -> dict[str, Any]:
        meta = {r["key"]: r["value"] for r in self._query("SELECT key, value FROM meta")}
        return {"count": int(meta.get("count", "0")), "schema_version": int(meta.get("schema_version", "0")),
                "built_at": meta.get("built_at"), "by_source": json.loads(meta.get("by_source", "{}")),
                "dropped": json.loads(meta.get("dropped", "{}")), "path": str(self.path), "attribution": meta.get("attribution"),
                "extra_tables": json.loads(meta.get("extra_tables", "[]")), "extra_count": int(meta.get("extra_count", "0")),
                "extra_by_source": json.loads(meta.get("extra_by_source", "{}")), "photos_count": int(meta.get("photos_count", "0")),
                "hours_week_count": int(meta.get("hours_week_count", "0")),
                "match_precision_sample": json.loads(meta.get("match_precision_sample", "null"))}

    def close(self) -> None:
        with self._lock:
            self._conn.close()


# ---- projections -----------------------------------------------------------------------------
_HTTP_SCHEME_RE = re.compile(r"^https?://", re.IGNORECASE)
_ANY_SCHEME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*:")  # e.g. "javascript:", "tel:", "mailto:" -- no "//" required


def normalise_url(url: str | None) -> str | None:
    """A catalog url as stored may lack a scheme (10 rows, e.g. "www.jejumaze.com" -> a dead link when
    rendered as-is) or be an OpenStreetMap permalink (map_osm()'s own fallback when a row has no real
    website -- legitimate to STORE there, but not something a marker should label as a website). Both
    are normalised away here at PROJECTION time only (to_marker()); places.url itself is untouched, so
    an OSM row's own permalink still exists for plan 14's osm_url field to read later. None/blank -> None.
    A non-http(s) scheme -> None defensively (none of the mappers in this module ever emit one today) --
    checked via _ANY_SCHEME_RE (bare "scheme:", no "//") BEFORE the scheme-less case prepends "https://",
    otherwise "javascript:alert(1)" would wrongly become "https://javascript:alert(1)"."""
    value = _s(url)
    if value is None:
        return None
    if "openstreetmap.org" in value:
        return None
    if _HTTP_SCHEME_RE.match(value):
        return value
    if _ANY_SCHEME_RE.match(value):
        return None
    return f"https://{value}"


def to_marker(rec: dict[str, Any]) -> dict[str, Any]:
    """MarkerV2 keys, exactly and in MARKER_KEYS order (interfaces contract)."""
    summary = _s(rec.get("summary")) or f"{rec['category']} · {_s(rec.get('address')) or '제주'}"
    return {
        "id": rec["id"], "name": rec["name"], "lat": float(rec["lat"]), "lng": float(rec["lng"]), "category": rec["category"],
        "summary": summary, "source": SOURCE_LABELS.get(rec["source"], rec["source"]), "observed_at": rec.get("updated_at"),
        "url": normalise_url(rec.get("url")), "phone": rec.get("phone"), "hours": rec.get("hours"), "distance_m": rec.get("distance_m"),
    }


def to_item(rec: dict[str, Any]) -> dict[str, Any]:
    """MarkerV2 + address/tags/avg_stay_min — the item shape plan 02's catalog_client expects."""
    return {**to_marker(rec), "address": rec.get("address"), "tags": list(rec.get("tags") or []), "avg_stay_min": rec.get("avg_stay_min")}


# ---- S3 sync ---------------------------------------------------------------------------------
DEFAULT_S3_KEY = "catalog/catalog.sqlite"
SQLITE_CONTENT_TYPE = "application/vnd.sqlite3"


def _cache_dir() -> Path:
    return Path(os.environ.get("ATLAS_CATALOG_CACHE_DIR", "/tmp/atlas"))


def catalog_bucket() -> str | None:
    """Only the bucket explicitly configured for this independent Atlas runtime."""
    return os.environ.get("ATLAS_CATALOG_BUCKET") or None


_s3_client_singleton: Any = None
_s3_client_lock = threading.Lock()


def s3_client():
    """Process-wide S3 client, built once and reused. Public because the BFF layer service and the domestic
    runner publish snapshots to the same bucket and must share these timeouts (they used to reach for the
    private name; final review, 2026-09-06).

    boto3's defaults (60s connect/read timeout, up to 5 retries per call) mean an unreachable S3
    endpoint or credentials provider can make a single head_object/download_file call take several
    minutes. get_catalog() calls this while it may still be holding book-keeping state that other
    threads read, so a short, bounded timeout/retry budget here is what keeps a slow S3 endpoint from
    turning into a multi-minute stall for the whole process (see get_catalog())."""
    global _s3_client_singleton
    if _s3_client_singleton is None:
        with _s3_client_lock:
            if _s3_client_singleton is None:
                import boto3  # imported lazily: not needed for local builds/tests
                from botocore.config import Config

                _s3_client_singleton = boto3.client(
                    "s3",
                    region_name=os.environ.get("AWS_REGION", "ap-northeast-2"),
                    config=Config(connect_timeout=2, read_timeout=5, retries={"max_attempts": 2}),
                )
    return _s3_client_singleton


def download_catalog(bucket: str, key: str, dest: Path) -> tuple[Path, bool]:
    """Download s3://bucket/key to dest unless the sidecar ETag already matches. Returns (dest, refreshed).

    The downloaded object is verified to be a readable catalog (meta.count > 0) BEFORE it is promoted onto
    `dest` and before its ETag sidecar is written. Without that check a truncated or corrupt object would get
    a permanently-matching sidecar, so every later boot and re-check would skip the download and keep opening
    a broken SQLite file with `immutable=1` until the upstream ETag happened to change. Raises on a bad
    object, which ensure_local_catalog() already handles by serving the previous cache or the dev build."""
    dest = Path(dest)
    etag_file = dest.with_suffix(dest.suffix + ".etag")
    s3 = s3_client()
    etag = str(s3.head_object(Bucket=bucket, Key=key)["ETag"]).strip('"')
    if dest.exists() and etag_file.exists() and etag_file.read_text(encoding="utf-8").strip() == etag:
        return dest, False
    dest.parent.mkdir(parents=True, exist_ok=True)
    # Per-PID scratch name, not a fixed ".part": with UVICORN_WORKERS > 1 (plan 07) every worker of a freshly
    # started task lazy-loads the catalog on its first /api/search, so two processes download concurrently into
    # the same cache dir. On a shared name the first to finish os.replace()s the file away and the other's
    # _built_record_count() reads a missing path -> None -> a bogus "not a readable catalog" RuntimeError and a
    # "serving cached"/dev-fallback warning on every task start. os.replace() is atomic, so both may promote.
    part = dest.with_suffix(dest.suffix + f".part.{os.getpid()}")
    s3.download_file(bucket, key, str(part))
    count = _built_record_count(part)
    if not count:
        part.unlink(missing_ok=True)
        raise RuntimeError(f"s3://{bucket}/{key} (etag={etag}) is not a readable catalog (meta.count={count}); "
                           f"the download was discarded and no ETag sidecar was written")
    os.replace(part, dest)
    etag_file.write_text(etag, encoding="utf-8")
    log.info("catalog downloaded s3://%s/%s etag=%s count=%d -> %s", bucket, key, etag, count, dest)
    return dest, True


def upload_catalog(path: Path, bucket: str, key: str = DEFAULT_S3_KEY) -> str:
    s3 = s3_client()
    s3.upload_file(str(path), bucket, key, ExtraArgs={"ContentType": SQLITE_CONTENT_TYPE})
    return str(s3.head_object(Bucket=bucket, Key=key)["ETag"]).strip('"')


_dev_fallback_active = False


def dev_fallback_active() -> bool:
    """True when this process is currently serving the auto-built dev catalog (curated sample set
    only, no S3 sync) rather than an S3-synced or explicitly-pinned one. Reflects the most recent
    ensure_local_catalog()/get_catalog() call.

    A diagnostics helper: the bundled curated fallback must remain distinguishable
    from a full S3 or explicitly configured catalog."""
    return _dev_fallback_active


def _built_record_count(path: Path) -> int | None:
    """Read meta.count from an already-built catalog file without going through the read-only/
    immutable Catalog connection (that mode assumes a fully-formed, unchanging file). Returns None
    when the file is missing, still mid-write, or otherwise not a valid catalog — treated the same
    as "0 records" by callers, since either way there is nothing usable to serve."""
    if not path.exists():
        return None
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            row = conn.execute("SELECT value FROM meta WHERE key = 'count'").fetchone()
            return int(row[0]) if row else None
        finally:
            conn.close()
    except sqlite3.Error:
        return None


def ensure_local_catalog() -> Path:
    """Resolve the catalog file for this process: ATLAS_CATALOG_PATH > S3 (cached by ETag) > dev build from the sample set."""
    global _dev_fallback_active
    explicit = os.environ.get("ATLAS_CATALOG_PATH")
    if explicit:
        _dev_fallback_active = False
        return Path(explicit)
    bucket = catalog_bucket()
    if bucket:
        dest = _cache_dir() / "catalog.sqlite"
        try:
            path, _ = download_catalog(bucket, os.environ.get("ATLAS_CATALOG_S3_KEY", DEFAULT_S3_KEY), dest)
            _dev_fallback_active = False
            return path
        except Exception as exc:  # noqa: BLE001 — credentials, network, missing object
            if dest.exists():
                log.warning("catalog S3 sync failed type=%s; serving cached catalog", type(exc).__name__)
                _dev_fallback_active = False
                return dest
            log.error("catalog S3 sync failed type=%s; no cache exists, using bundled data", type(exc).__name__)
    dev = _cache_dir() / "catalog-dev.sqlite"
    # Re-check the on-disk record count on EVERY call, not just when dev is missing: build_catalog()
    # always os.replace()s out_path regardless of how many records it kept, so a previous 0-record
    # attempt (raised as RuntimeError below) leaves a permanently-reusable empty file sitting at `dev`.
    # Without re-reading meta.count here, dev.exists() alone would be True on every call after the
    # first, so this branch would skip straight to `_dev_fallback_active = True` below and quietly
    # keep serving that empty catalog forever instead of raising again.
    if _built_record_count(dev) in (None, 0):
        report = build_catalog(dev, sample_path=_sample_path())
        if report["count"] == 0:
            log.error("catalog dev fallback at %s built 0 records (data/jeju_pois.json not found?); refusing to silently serve an empty catalog", dev)
            raise RuntimeError(
                f"dev catalog fallback at {dev} has 0 records — data/jeju_pois.json was not found next to "
                "agent/tools/catalog.py; set ATLAS_CATALOG_PATH or ATLAS_CATALOG_BUCKET instead of relying on the dev fallback"
            )
    _dev_fallback_active = True
    log.warning("serving the dev-build catalog fallback (%s): no S3 bucket is configured, or S3 sync failed with no cache", dev)
    return dev


_current: Catalog | None = None
_last_check = 0.0
_current_etag: str | None = None
_singleton_lock = threading.Lock()


def _sidecar_etag(path: Path) -> str | None:
    etag_file = path.with_suffix(path.suffix + ".etag")
    return etag_file.read_text(encoding="utf-8").strip() if etag_file.exists() else None


def get_catalog() -> Catalog:
    """Process-wide Catalog. Re-checks S3 every ATLAS_CATALOG_REFRESH_S seconds and swaps in a new connection on change.

    ensure_local_catalog() below runs OUTSIDE _singleton_lock: it may call S3 (bounded by s3_client()'s
    short timeouts, but still real network I/O), and holding a process-wide lock for that duration would
    serialize every FastAPI threadpool request behind whichever thread happens to trigger the refresh.
    The lock is only held (a) to snapshot the current catalog/decide whether a refresh is due, and (b) to
    publish a newly opened Catalog — opening the sqlite file itself is fast local I/O, so it stays inside
    the lock rather than adding another race window.

    The replaced Catalog is NOT closed here on purpose. Catalog.close() takes the instance's own lock, so it
    waits for a _query() already in flight, but a thread that received the old object from an earlier
    get_catalog() and has not called a method yet would hit `sqlite3.ProgrammingError: Cannot operate on a
    closed database` on every ETag swap (an operator uploads a new catalog about weekly). Dropping the last
    reference is enough: CPython closes the sqlite3 connection when the Catalog is collected, and the file is
    opened read-only/immutable so nothing needs flushing."""
    global _current, _last_check, _current_etag
    refresh_s = float(os.environ.get("ATLAS_CATALOG_REFRESH_S", "21600"))
    with _singleton_lock:
        current = _current
        due = current is None or (catalog_bucket() and time.monotonic() - _last_check >= refresh_s)
        if not due:
            return current

    path = ensure_local_catalog()
    etag = _sidecar_etag(path)

    with _singleton_lock:
        _last_check = time.monotonic()
        if _current is None or path != _current.path or etag != _current_etag:
            _current, _current_etag = Catalog(path), etag
        return _current


def reset_catalog() -> None:
    """Reset the process-wide Catalog singleton AND the dev_fallback_active() flag it implies.

    Also clears _dev_fallback_active: it is set only inside ensure_local_catalog(), which is not
    itself re-run just because the singleton was dropped, so without this the flag would keep
    reporting whichever source the *previous* singleton happened to be serving — most visibly
    between tests, which rely on reset_catalog() (via the s3_env fixture) to fully isolate this
    module's global state between runs.

    Unlike the ETag swap in get_catalog(), this DOES close the connection: it is a lifecycle/test
    reset called when nothing is meant to be serving requests any more, and closing releases the
    file handle deterministically so a tmp_path catalog can be removed."""
    global _current, _last_check, _current_etag, _dev_fallback_active
    with _singleton_lock:
        if _current is not None:
            _current.close()
        _current, _last_check, _current_etag, _dev_fallback_active = None, 0.0, None, False


# ---- module-level API consumed by JejuAtlasTools (plan 02 catalog_client) ---------------------
def search(q: str = "", lat: float | None = None, lng: float | None = None, radius_m: int | None = None,
           category: str | None = None, limit: int = 10) -> list[dict[str, Any]]:
    return [to_item(r) for r in get_catalog().search(q, lat=lat, lng=lng, radius_m=radius_m, category=category, limit=limit)]


def get(place_id: str) -> dict[str, Any] | None:
    rec = get_catalog().get(place_id)
    return to_item(rec) if rec is not None else None


# ---- CLI -------------------------------------------------------------------------------------
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python agent/tools/catalog.py", description="Build / inspect / upload the Atlas POI catalog")
    sub = parser.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="build catalog.sqlite from the sample set and snapshots")
    b.add_argument("--out", required=True, type=Path)
    sample_group = b.add_mutually_exclusive_group()
    sample_group.add_argument("--sample", type=Path, default=None, help="defaults to data/jeju_pois.json")
    sample_group.add_argument("--no-sample", action="store_true", help="exclude the curated sample set entirely (snapshot-only catalog)")
    b.add_argument("--tourapi", type=Path, nargs="*", default=[])
    b.add_argument("--jejuhub", type=Path, nargs="*", default=[])
    b.add_argument("--osm", type=Path, nargs="*", default=[])
    b.add_argument("--extra", type=Path, nargs="*", default=[])
    s = sub.add_parser("stats", help="print meta of a built catalog")
    s.add_argument("--path", required=True, type=Path)
    u = sub.add_parser("upload", help="upload a built catalog to S3 (operator machine)")
    u.add_argument("--path", required=True, type=Path)
    u.add_argument("--bucket", required=True)
    u.add_argument("--key", default=DEFAULT_S3_KEY)
    args = parser.parse_args(argv)
    if args.cmd == "build":
        report = build_catalog(args.out, sample_path=args.sample, tourapi_snapshots=args.tourapi,
                                jejuhub_snapshots=args.jejuhub, osm_snapshots=args.osm, extra_snapshots=args.extra,
                                use_sample=not args.no_sample)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "stats":
        cat = Catalog(args.path)
        print(json.dumps(cat.stats(), ensure_ascii=False, indent=2))
        cat.close()
        return 0
    # args.cmd == "upload": add_subparsers(required=True) rejects anything else before we get here.
    etag = upload_catalog(args.path, args.bucket, args.key)
    print(json.dumps({"bucket": args.bucket, "key": args.key, "etag": etag, "bytes": Path(args.path).stat().st_size}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
