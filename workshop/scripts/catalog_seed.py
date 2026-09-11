#!/usr/bin/env python3
"""Build an isolated workshop catalog from committed seeds using only the stdlib.

Schema v2 mirrors agent/tools/catalog.py and server/catalog.mjs. Deliberately do
not call the application's builder: it promotes sample facility flags, and can
select remote inputs. This helper never opens an existing destination catalog.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import sqlite3
import stat
import sys
import tempfile
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid


ROOT = Path(__file__).resolve().parents[2]
SAMPLE_PATH = ROOT / "agent/tools/data/jeju_pois.json"
SAMPLE_INPUT = "agent/tools/data/jeju_pois.json"
BBOX = (33.1, 126.15, 33.6, 126.98)  # south, west, north, east; both readers agree.
CATEGORIES = {
    "관광지", "오름", "해변", "카페", "맛집", "올레길", "박물관",
    "시장", "문화시설", "레포츠", "숙박", "쇼핑", "주차장",
}
MAX_DATABASE_BYTES = 32 * 1024 * 1024  # Node openSnapshot's size limit.
SAMPLE_NOTICE = (
    "미검증 워크숍 샘플/큐레이션 자료입니다. 좌표·주소·소개를 독립적으로 검증하지 "
    "않았으며 시설·영업시간·사진·공식 근거를 제공하지 않습니다."
)
SAMPLE_ATTRIBUTION = "큐레이션 데이터 오마이제주 · 미검증 워크숍 샘플"
OSM_ATTRIBUTION = (
    "© OpenStreetMap contributors (ODbL) · https://www.openstreetmap.org/copyright · "
    "https://opendatacommons.org/licenses/odbl/1-0/"
)
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_OSM_ELEMENTS = 1000
REQUEST_TIMEOUT = 35
MAX_ATTEMPTS = 3
MAX_RETRY_DELAY = 5
# Conservative allowlist: a peak is not necessarily an oreum, a gallery is not
# necessarily a museum, and an arbitrary shop is not necessarily a market.
OSM_CATEGORIES = {
    ("amenity", "cafe"): "카페",
    ("amenity", "restaurant"): "맛집",
    ("amenity", "fast_food"): "맛집",
    ("amenity", "parking"): "주차장",
    ("amenity", "marketplace"): "시장",
    ("tourism", "museum"): "박물관",
    ("tourism", "gallery"): "문화시설",
    ("tourism", "attraction"): "관광지",
    ("tourism", "viewpoint"): "관광지",
    ("natural", "beach"): "해변",
}
OVERPASS_QUERY = """
[out:json][timeout:25][maxsize:33554432];
(
  nwr["amenity"~"^(cafe|restaurant|fast_food|parking|marketplace)$"]["name"](33.1,126.15,33.6,126.98);
  nwr["tourism"~"^(museum|gallery|attraction|viewpoint)$"]["name"](33.1,126.15,33.6,126.98);
  nwr["natural"="beach"]["name"](33.1,126.15,33.6,126.98);
);
out body center 1001;
""".strip()  # One extra object detects truncation; inspect at most 1000 locally.

# Keep column order, affinity, nullability, external-content rowid and tokenizer
# compatible with the real producer. Spatial readers use the lat/lng B-tree,
# not an RTree. Tests compare this schema to catalog.DDL and open both readers.
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
  tags TEXT NOT NULL,
  source TEXT NOT NULL,
  url TEXT,
  phone TEXT,
  hours TEXT,
  updated_at TEXT NOT NULL,
  region TEXT,
  avg_stay_min INTEGER,
  name_norm TEXT NOT NULL,
  tags_text TEXT NOT NULL
);
CREATE INDEX idx_places_lat_lng ON places(lat, lng);
CREATE INDEX idx_places_category ON places(category);
CREATE VIRTUAL TABLE places_fts USING fts5(
  name, name_en, tags_text, summary, address,
  content='places', content_rowid='rid', tokenize='trigram'
);
CREATE TABLE place_extra(
  id TEXT PRIMARY KEY,
  photos TEXT, hours_week TEXT, hours_source TEXT, facilities TEXT,
  overview TEXT, menu TEXT, business_status TEXT, tips TEXT, sources TEXT, fetched_at TEXT
);
"""
PLACE_FIELDS = (
    "id", "name", "name_en", "category", "lat", "lng", "address", "summary",
    "tags", "source", "url", "phone", "hours", "updated_at", "region",
    "avg_stay_min", "name_norm", "tags_text",
)
EXTRA_FIELDS = (
    "id", "photos", "hours_week", "hours_source", "facilities", "overview",
    "menu", "business_status", "tips", "sources", "fetched_at",
)


class BootstrapError(Exception):
    """A safe diagnostic that never includes a raw input record or response."""


def json_text(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def absolute_path(value):
    path = Path(value)
    if not path.name or ".." in path.parts:
        raise BootstrapError("Use a file path without '..' traversal.")
    return path if path.is_absolute() else Path.cwd() / path


def open_directory(path, *, create=False):
    """Walk with directory descriptors; never follow a symlink, even on mkdir."""
    if not hasattr(os, "O_NOFOLLOW") or os.open not in os.supports_dir_fd:
        raise BootstrapError("Safe file publication requires POSIX directory descriptors.")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open(path.anchor, flags)
    try:
        for component in path.parts[1:]:
            try:
                child = os.open(component, flags, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    raise
                try:
                    os.mkdir(component, mode=0o700, dir_fd=fd)
                except FileExistsError:
                    pass
                child = os.open(component, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except OSError as error:
        os.close(fd)
        raise BootstrapError("Parent paths must be real directories, without symlinks.") from error


def require_new_output(parent_fd, name):
    try:
        os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    raise BootstrapError("Output already exists; choose a new path. Existing files are never replaced.")


def read_input(path, limit):
    path = absolute_path(path)
    if any(part == "credentials" or part == ".env" or part.startswith(".env.")
           for part in path.parts):
        raise BootstrapError("Credential paths are not catalog inputs.")
    parent_fd = open_directory(path.parent)
    try:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent_fd)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise BootstrapError("Input must be a regular JSON file, without symlinks.")
            if info.st_size > limit:
                raise BootstrapError("JSON input exceeds the response size limit.")
            raw = stream.read(limit + 1)
            if len(raw) > limit:
                raise BootstrapError("JSON input exceeds the response size limit.")
            return raw
    finally:
        os.close(parent_fd)


def decode_json(raw):
    def reject_constant(_value):
        raise ValueError("non-finite JSON number")

    def bounded_int(value):
        if len(value.lstrip("-")) > 20:
            raise ValueError("oversized JSON integer")
        return int(value)

    def finite_float(value):
        result = float(value)
        if not math.isfinite(result):
            raise ValueError("non-finite JSON number")
        return result

    try:
        return json.loads(
            raw.decode("utf-8"), parse_constant=reject_constant,
            parse_int=bounded_int, parse_float=finite_float,
        )
    except (UnicodeError, ValueError, RecursionError) as error:
        raise BootstrapError("Input must contain valid UTF-8 JSON, with finite numbers.") from error


def text(value, limit=2048):
    if not isinstance(value, str) or not value.strip() or len(value) > limit or "\0" in value:
        return None
    return unicodedata.normalize("NFC", value.strip())


def in_bounds(lat, lng):
    return (
        type(lat) in (float, int) and type(lng) in (float, int)
        and math.isfinite(lat) and math.isfinite(lng)
        and BBOX[0] <= lat <= BBOX[2] and BBOX[1] <= lng <= BBOX[3]
    )


def empty_extra(place_id, provenance, fetched_at=None):
    extra = dict.fromkeys(EXTRA_FIELDS)
    extra.update(
        id=place_id, photos="[]", facilities="{}", menu="[]",
        sources=json_text([provenance]), fetched_at=fetched_at,
    )
    return extra


def sample_rows(built_at):
    raw = read_input(SAMPLE_PATH, 1024 * 1024)
    data = decode_json(raw)
    if not isinstance(data, list) or not data:
        raise BootstrapError("The committed sample seed array is missing or empty.")
    rows, extras, seen = [], [], set()
    for item in data:
        if not isinstance(item, dict):
            raise BootstrapError("The committed sample contains an invalid record.")
        place_id, name = text(item.get("id"), 256), text(item.get("name"), 256)
        tags = item.get("tags")
        if (not place_id or place_id in seen or not name
                or item.get("category") not in CATEGORIES
                or not in_bounds(item.get("lat"), item.get("lng"))
                or not isinstance(tags, list) or any(not text(tag, 128) for tag in tags)):
            raise BootstrapError("The committed sample has invalid fields, bounds, or duplicate IDs.")
        seen.add(place_id)
        row = dict.fromkeys(PLACE_FIELDS)
        row.update(
            id=place_id, name=name, name_en=text(item.get("name_en"), 256),
            category=item["category"], lat=item["lat"], lng=item["lng"],
            address=text(item.get("address")), summary="미검증 샘플 · " + (text(item.get("summary")) or ""),
            tags=tags[:8], source="sample", updated_at=built_at[:10],
            region=text(item.get("region")), avg_stay_min=item.get("avg_stay_min"),
        )
        rows.append(row)
        # Do not promote the seed's parking/kid_friendly flags to factual facilities.
        extras.append(empty_extra(place_id, {
            "source": "curated", "url": None, "observed_at": None,
            "license": "curated", "note": SAMPLE_NOTICE,
        }))
    return rows, extras, hashlib.sha256(raw).hexdigest()


def read_response(response, deadline):
    if response.headers.get("Content-Encoding", "identity").strip().lower() != "identity":
        raise BootstrapError("Overpass returned an unsupported compressed response.")
    expected = response.headers.get("Content-Length")
    if expected is not None:
        try:
            expected = int(expected)
        except ValueError as error:
            raise BootstrapError("Overpass returned an invalid response length.") from error
        if not 0 <= expected <= MAX_RESPONSE_BYTES:
            raise BootstrapError("Overpass response exceeds the 8 MiB size limit.")
    chunks, size = [], 0
    while True:
        if time.monotonic() >= deadline:
            raise BootstrapError("Overpass response exceeded the read deadline.")
        # read1 returns after a socket read, letting a slow trickle reach the
        # deadline check; read(n) can wait for n bytes across many socket reads.
        chunk = response.read1(min(65536, MAX_RESPONSE_BYTES - size + 1))
        if not chunk:
            break
        size += len(chunk)
        if size > MAX_RESPONSE_BYTES:
            raise BootstrapError("Overpass response exceeds the 8 MiB size limit.")
        chunks.append(chunk)
    if expected is not None and size != expected:
        raise BootstrapError("Overpass returned an incomplete response.")
    return b"".join(chunks)


def fetch_overpass():
    request = urllib.request.Request(
        OVERPASS_URL,
        data=urllib.parse.urlencode({"data": OVERPASS_QUERY}).encode("ascii"),
        method="POST",
        headers={
            "User-Agent": "JejuAtlasWorkshop/catalog-bootstrap/1.0",
            "Accept": "application/json", "Accept-Encoding": "identity",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    for attempt in range(MAX_ATTEMPTS):
        delay = 2 ** attempt
        deadline = time.monotonic() + REQUEST_TIMEOUT
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
                return read_response(response, deadline)
        except urllib.error.HTTPError as error:
            code = error.code
            retry_after = (error.headers or {}).get("Retry-After", "")
            error.close()
            if code not in {429, 500, 502, 503, 504}:
                raise BootstrapError(f"Overpass request failed (HTTP {code}); no catalog was published.") from None
            if retry_after.isdecimal():
                if len(retry_after) > 3 or int(retry_after) > MAX_RETRY_DELAY:
                    raise BootstrapError("Overpass requested a longer wait; retry later or use --osm-file.") from None
                delay = int(retry_after)
        except (OSError, http.client.HTTPException):
            # Do not echo error bodies, proxy details or remote response text.
            pass
        if attempt + 1 < MAX_ATTEMPTS:
            time.sleep(min(delay, MAX_RETRY_DELAY))
    raise BootstrapError("Overpass failed after 3 attempts; retry later, use --osm-file, or omit --osm.")


def snapshot_time(document):
    metadata = document.get("osm3s")
    stamp = text(metadata.get("timestamp_osm_base"), 64) if isinstance(metadata, dict) else None
    if stamp:
        try:
            parsed = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
            if parsed.tzinfo is not None:
                return stamp
        except ValueError:
            pass
    return None


def map_osm(element, built_at):
    if (not isinstance(element, dict) or not isinstance(element.get("type"), str)
            or element["type"] not in {"node", "way", "relation"}
            or type(element.get("id")) is not int or not 0 < element["id"] <= 2 ** 63 - 1):
        return None, "invalid_element"
    tags = element.get("tags")
    if not isinstance(tags, dict) or any(not isinstance(value, str) for value in tags.values()):
        return None, "invalid_element"
    name = text(tags.get("name:ko"), 256) or text(tags.get("name"), 256) or text(tags.get("name:en"), 256)
    if not name:
        return None, "missing_name"
    lifecycle = ("disused", "abandoned", "demolished", "razed", "construction", "proposed")
    if (any(tags.get(key) == "yes" for key in lifecycle)
            or any(key.startswith(tuple(prefix + ":" for prefix in lifecycle)) for key in tags)):
        return None, "lifecycle_tagged"
    matches = [(category, value) for (key, value), category in OSM_CATEGORIES.items()
               if tags.get(key) == value]
    if not matches:
        return None, "unmapped_category"
    if len({category for category, _value in matches}) > 1:
        return None, "ambiguous_category"
    position = element if element["type"] == "node" else element.get("center")
    if (not isinstance(position, dict) or type(position.get("lat")) not in (int, float)
            or type(position.get("lon")) not in (int, float)):
        return None, "missing_coords"
    lat, lng = position["lat"], position["lon"]
    if not in_bounds(lat, lng):
        return None, "out_of_bbox"
    category = matches[0][0]
    ref = f"{element['type']}/{element['id']}"
    row = dict.fromkeys(PLACE_FIELDS)
    row.update(
        id=f"osm:{ref}", name=name, name_en=text(tags.get("name:en"), 256),
        category=category, lat=lat, lng=lng, address=text(tags.get("addr:full")),
        summary="OpenStreetMap 등록 자료 · 현장/공식 검증 없음",
        tags=list(dict.fromkeys([category, *(value for _category, value in matches)])),
        source="OpenStreetMap", url=f"https://www.openstreetmap.org/{ref}",
        phone=text(tags.get("phone"), 128) or text(tags.get("contact:phone"), 128),
        hours=text(tags.get("opening_hours"), 1024), updated_at=built_at[:10],
    )
    return row, None


def osm_rows(osm_file, built_at):
    from_file = osm_file is not None
    raw = read_input(osm_file, MAX_RESPONSE_BYTES) if from_file else fetch_overpass()
    retrieved_at = None if from_file else utc_now()
    document = decode_json(raw)
    if (not isinstance(document, dict) or not isinstance(document.get("elements"), list)
            or document.get("remark")):
        raise BootstrapError("Expected complete Overpass JSON with an elements array and no error remark.")
    elements = document["elements"]
    rows, extras, seen, dropped = [], [], set(), Counter()
    for element in elements[:MAX_OSM_ELEMENTS]:
        row, reason = map_osm(element, built_at)
        if reason:
            dropped[reason] += 1
            continue
        if row["id"] in seen:
            dropped["duplicate_id"] += 1
            continue
        seen.add(row["id"])
        rows.append(row)
        note = "OpenStreetMap 등록 자료이며 현장/공식 검증이 아닙니다."
        if from_file:
            note += " Overpass JSON 파일 입력이며 라이브 조회 여부·원본 진위는 확인하지 않았습니다."
        extras.append(empty_extra(row["id"], {
            "source": "osm", "url": row["url"], "observed_at": None,
            "license": "ODbL", "note": note,
        }, retrieved_at))
    if len(elements) > MAX_OSM_ELEMENTS:
        dropped["over_limit"] = len(elements) - MAX_OSM_ELEMENTS
    provenance = {
        "input": "file" if from_file else "overpass",
        "sha256": hashlib.sha256(raw).hexdigest(), "response_bytes": len(raw),
        "retrieved_at": retrieved_at, "snapshot_at": snapshot_time(document),
        "endpoint": None if from_file else OVERPASS_URL,
        "query_sha256": None if from_file else hashlib.sha256(OVERPASS_QUERY.encode()).hexdigest(),
        "bbox_south_west_north_east": list(BBOX), "element_limit": MAX_OSM_ELEMENTS,
        "elements_received": len(elements), "elements_considered": min(len(elements), MAX_OSM_ELEMENTS),
        "imported": len(rows), "limited": len(elements) > MAX_OSM_ELEMENTS,
        "attribution": OSM_ATTRIBUTION,
    }
    return rows, extras, dict(sorted(dropped.items())), provenance


def database_bytes(rows, extras, meta):
    """Stage privately; support Python 3.9 without Connection.serialize()."""
    with tempfile.TemporaryDirectory(prefix="atlas-catalog-build-") as temporary:
        path = Path(temporary) / "catalog.sqlite"
        connection = sqlite3.connect(path)
        try:
            connection.executescript(DDL)
            for row in rows:
                values = dict(row)
                values["name_norm"] = "".join(row["name"].split()).casefold()
                values["tags_text"] = " ".join(row["tags"]).casefold()
                values["tags"] = json_text(row["tags"])
                connection.execute(
                    f"INSERT INTO places({','.join(PLACE_FIELDS)}) "
                    f"VALUES({','.join(':' + key for key in PLACE_FIELDS)})", values,
                )
            connection.executemany(
                f"INSERT INTO place_extra({','.join(EXTRA_FIELDS)}) "
                f"VALUES({','.join(':' + key for key in EXTRA_FIELDS)})", extras,
            )
            connection.execute("INSERT INTO places_fts(places_fts) VALUES('rebuild')")
            connection.executemany("INSERT INTO meta(key,value) VALUES(?,?)", meta.items())
            connection.execute(
                "INSERT INTO places_fts(places_fts,rank) VALUES('integrity-check',1)"
            )
            connection.commit()
            if connection.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                raise BootstrapError("Generated catalog failed SQLite integrity validation.")
        except sqlite3.OperationalError as error:
            raise BootstrapError("Catalog creation requires SQLite FTS5 with the trigram tokenizer.") from error
        finally:
            connection.close()
        if path.stat().st_size > MAX_DATABASE_BYTES:
            raise BootstrapError("Generated catalog exceeds the Node reader's size limit.")
        return path.read_bytes()


def publish(parent_fd, name, raw):
    """Publish a complete file atomically, without replacing a racing writer."""
    staging = f".catalog-seed-{uuid.uuid4().hex}.tmp"
    fd = os.open(
        staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600, dir_fd=parent_fd,
    )
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        # link(), unlike replace(), refuses any existing file/symlink atomically.
        try:
            os.link(staging, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd,
                    follow_symlinks=False)
        except FileExistsError as error:
            raise BootstrapError("Output appeared during the build; it was not replaced.") from error
    finally:
        os.unlink(staging, dir_fd=parent_fd)
    os.fsync(parent_fd)


def build_catalog(output, *, osm=False, osm_file=None):
    """Return aggregate-only JSON-compatible statistics for a new lab snapshot."""
    if osm_file is not None and not osm:
        raise BootstrapError("--osm-file requires --osm; omit both for an offline sample catalog.")
    output = absolute_path(output)
    parent_fd = open_directory(output.parent, create=True)
    try:
        require_new_output(parent_fd, output.name)
        built_at = utc_now()
        rows, extras, sample_hash = sample_rows(built_at)
        extra_by_source = {"curated": len(rows)}
        dropped, osm_provenance = {}, None
        if osm:
            imported, osm_extras, dropped, osm_provenance = osm_rows(osm_file, built_at)
            # IDs, fields and evidence remain in distinct source namespaces.
            # No fuzzy matching/backfill into any of the 137 sample records.
            rows.extend(imported)
            extras.extend(osm_extras)
            if imported:
                extra_by_source["osm"] = len(imported)
        by_source = dict(sorted(Counter(row["source"] for row in rows).items()))
        by_category = dict(sorted(Counter(row["category"] for row in rows).items()))
        meta = {
            "schema_version": "2", "built_at": built_at, "count": str(len(rows)),
            "by_source": json_text(by_source), "by_category": json_text(by_category),
            "dropped": json_text(dropped), "extra_tables": '["place_extra"]', "extra_count": str(len(extras)),
            "extra_by_source": json_text(extra_by_source),
            "photos_count": "0", "hours_week_count": "0", "match_precision_sample": "null",
            "attribution": SAMPLE_ATTRIBUTION, "sample_notice": SAMPLE_NOTICE,
            "sample_input": SAMPLE_INPUT, "sample_sha256": sample_hash,
            "updated_at_note": "updated_at is the catalog build date, not an observation or verification.",
        }
        if osm_provenance is not None:
            meta["osm_provenance"] = json_text(osm_provenance)
            meta["attribution"] += " · " + OSM_ATTRIBUTION
        raw = database_bytes(rows, extras, meta)
        publish(parent_fd, output.name, raw)
        return {
            "path": str(output), "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw),
            "schema_version": 2, "built_at": built_at, "count": len(rows),
            "by_source": by_source, "by_category": by_category, "dropped": dropped,
            "sample_sha256": sample_hash, "attribution": meta["attribution"],
            "photos_count": 0, "hours_week_count": 0, "osm": osm_provenance,
        }
    finally:
        os.close(parent_fd)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path, help="new SQLite file; never overwrites")
    parser.add_argument("--osm", action="store_true", help="add a bounded OpenStreetMap import")
    parser.add_argument("--osm-file", type=Path, help="use an Overpass JSON fixture instead of the network")
    args = parser.parse_args(argv)
    try:
        report = build_catalog(args.output, osm=args.osm, osm_file=args.osm_file)
    except BootstrapError as error:
        print(f"catalog bootstrap failed: {error}", file=sys.stderr)
        return 1
    except (OSError, sqlite3.Error):
        print("catalog bootstrap failed: cannot safely read inputs or publish a new SQLite file.",
              file=sys.stderr)
        return 1
    print(json_text(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
