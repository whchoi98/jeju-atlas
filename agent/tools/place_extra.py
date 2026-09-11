"""Read/write helper for the `place_extra` SQLite table (spec §4.1) — photos, weekly hours, facility
flags, overview, menu, business status, guide tips and their sources, one row per catalog place id.

Packaged beside agent/tools/catalog.py as the top-level `place_extra` module.
It has no repository imports (stdlib + sqlite3 only); every function takes an
already-open sqlite3.Connection.
catalog.py cannot import this module either, for the identical reason: its own Catalog.has_extra()/
Catalog.extra() duplicate the read-side SQL below on purpose instead of importing it.
"""
from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable
from typing import Any

EXTRA_KEYS: tuple[str, ...] = (
    "id", "photos", "hours_week", "hours_source", "facilities", "overview", "menu",
    "business_status", "tips", "sources", "fetched_at",
)
# JSON-encoded columns; the rest (id/hours_source/overview/business_status/fetched_at) are plain TEXT.
_JSON_FIELDS: tuple[str, ...] = ("photos", "hours_week", "facilities", "menu", "sources", "tips")
_LIST_DEFAULTS: dict[str, Any] = {"photos": [], "menu": [], "sources": []}
_DICT_DEFAULTS: dict[str, Any] = {"facilities": {}}

LICENSES: frozenset[str] = frozenset({
    "KOGL-1", "KOGL-2", "KOGL-3", "KOGL-4", "CC-BY-SA-2.0", "CC-BY-SA-3.0", "CC-BY-SA-4.0",
    "CC-BY-4.0", "CC0", "PD", "unrestricted", "curated",
})
# 공공누리 3·4유형: 변경 금지(재인코딩·파생 썸네일 금지) — media_sync.py(이 계획의 후속 Task)가 원본 바이트만 미러.
NO_DERIVATIVES: frozenset[str] = frozenset({"KOGL-3", "KOGL-4"})
_BUSINESS_STATUSES: frozenset[str] = frozenset({"open", "closed_permanently", "unknown"})
MAX_PHOTOS = 8
MAX_MENU_ITEMS = 12

EXTRA_DDL = (
    "CREATE TABLE IF NOT EXISTS place_extra("
    "id TEXT PRIMARY KEY, photos TEXT, hours_week TEXT, hours_source TEXT, facilities TEXT, "
    "overview TEXT, menu TEXT, business_status TEXT, tips TEXT, sources TEXT, fetched_at TEXT)"
)
_UPSERT_SQL = (
    "INSERT OR REPLACE INTO place_extra(id,photos,hours_week,hours_source,facilities,overview,menu,"
    "business_status,tips,sources,fetched_at) "
    "VALUES(:id,:photos,:hours_week,:hours_source,:facilities,:overview,:menu,:business_status,:tips,"
    ":sources,:fetched_at)"
)


def ensure_table(conn: sqlite3.Connection) -> None:
    """Idempotent (IF NOT EXISTS) — safe to call on every runner/tips-batch write path before an upsert."""
    conn.executescript(EXTRA_DDL)


def has_extra_table(conn: sqlite3.Connection) -> bool:
    row = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='place_extra'").fetchone()
    return row is not None


def validate_extra(row: dict[str, Any]) -> str | None:
    """None when row is a well-formed place_extra candidate; otherwise a short reason string.
    upsert_extra() uses this to SKIP malformed rows instead of raising — a half-written enrich snapshot
    must never crash the build (spec §3.1 "소스별로 독립 실패", extended here to row-level defects)."""
    if not row.get("id"):
        return "missing_id"
    unknown = set(row) - set(EXTRA_KEYS)
    if unknown:
        return "unknown_key"
    for field in _JSON_FIELDS:
        try:
            json.dumps(row.get(field), ensure_ascii=False)
        except TypeError:
            return "not_json_encodable"
    photos = row.get("photos") or []
    if len(photos) > MAX_PHOTOS:
        return "too_many_photos"
    for photo in photos:
        license_ = photo.get("license")
        if license_ not in LICENSES:
            return "bad_license"
        if license_ in NO_DERIVATIVES and photo.get("thumb_url") is not None:
            return "thumb_url_forbidden_for_license"
    if len(row.get("menu") or []) > MAX_MENU_ITEMS:
        return "too_many_menu_items"
    business_status = row.get("business_status")
    if business_status is not None and business_status not in _BUSINESS_STATUSES:
        return "bad_business_status"
    return None


def _encode(row: dict[str, Any]) -> dict[str, Any]:
    params: dict[str, Any] = {k: row.get(k) for k in EXTRA_KEYS}
    for field in _JSON_FIELDS:
        value = params[field]
        params[field] = json.dumps(value, ensure_ascii=False) if value not in (None, [], {}) else None
    return params


def upsert_extra(conn: sqlite3.Connection, rows: Iterable[dict[str, Any]]) -> int:
    """INSERT OR REPLACE every row that passes validate_extra(); returns the count actually written."""
    ensure_table(conn)
    written = 0
    for row in rows:
        if validate_extra(row) is not None:
            continue
        conn.execute(_UPSERT_SQL, _encode(row))
        written += 1
    conn.commit()
    return written


def update_extra(conn: sqlite3.Connection, place_id: str, **fields: Any) -> bool:
    """Partial write for ONE place: merge `fields` into the existing row (or a fresh {"id": place_id}) and
    INSERT OR REPLACE the result. media_sync.py (photos write-back) and tips_batch.py (tips) use this so a
    step never clobbers a column another step owns. False when the merged row fails validate_extra()."""
    current = read_extra(conn, place_id) or {"id": place_id}
    merged = {**current, **fields, "id": place_id}
    return upsert_extra(conn, [merged]) == 1


def decode_row(row: sqlite3.Row) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key in EXTRA_KEYS:
        value = row[key]
        if key in _JSON_FIELDS:
            out[key] = json.loads(value) if value else _LIST_DEFAULTS.get(key, _DICT_DEFAULTS.get(key))
        else:
            out[key] = value
    return out


def read_extra(conn: sqlite3.Connection, place_id: str) -> dict[str, Any] | None:
    """None both when the table is absent (schema_version 1 catalog) and when the id has no row — every
    caller (BFF, agent tools) treats both the same way (spec §4.1 backward-compat rule)."""
    if not has_extra_table(conn):
        return None
    cur = conn.cursor()
    cur.row_factory = sqlite3.Row
    row = cur.execute("SELECT * FROM place_extra WHERE id = ?", (place_id,)).fetchone()
    return decode_row(row) if row is not None else None
