"""Bundled-POI implementation of the plan-5 catalog interface (search/get) used when `catalog` is absent.

Data: $ATLAS_POIS_PATH → <package>/data/jeju_pois.json, included in this Tools CodeZip.
"""
from __future__ import annotations

import json
import os
import re
import unicodedata
from pathlib import Path
from typing import Any

from . import geo

SOURCE = "오마이제주 카탈로그(샘플 137건)"
MAX_LIMIT = 50
_DEFAULT_PATH = Path(__file__).resolve().parent.parent / "data" / "jeju_pois.json"
_cache: list[dict[str, Any]] | None = None


def _path() -> Path:
    return Path(os.environ.get("ATLAS_POIS_PATH") or _DEFAULT_PATH)


def load_pois() -> list[dict[str, Any]]:
    global _cache
    if _cache is None:
        _cache = json.loads(_path().read_text(encoding="utf-8"))
    return _cache


def reset_cache() -> None:
    global _cache
    _cache = None


def _norm(text: str) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFC", text or "")).casefold()


def _tokenize(q: str) -> list[str]:
    """Split a query on whitespace into normalized tokens.

    Fix round 1 (Task 10 review): a multi-word Korean query like '성산 카페' or '제주 흑돼지 맛집'
    almost never appears as one contiguous substring in any single field — '성산' lands in `name`
    while '카페' lands in `category`. Matching the whole (whitespace-stripped) query as a single
    substring therefore returned 0 items for exactly the query shape the agent actually sends.
    Tokenizing and requiring every token to hit somewhere across the item's fields (AND semantics,
    each token independently) fixes recall while a single-word query behaves exactly as before.
    """
    return [_norm(t) for t in (q or "").split() if t.strip()]


def _item(p: dict[str, Any], distance_m: int | None = None) -> dict[str, Any]:
    return {
        "id": p["id"], "name": p["name"], "lat": p["lat"], "lng": p["lng"],
        "category": p["category"], "summary": p["summary"], "address": p["address"], "tags": list(p["tags"]),
        "source": SOURCE, "observed_at": None, "url": None, "phone": None, "hours": None,
        "distance_m": distance_m, "avg_stay_min": p.get("avg_stay_min"),
    }


def search(q: str, lat: float | None, lng: float | None, radius_m: int | None, category: str | None, limit: int) -> list[dict[str, Any]]:
    tokens = _tokenize(q)
    try:
        lim = max(1, min(int(limit), MAX_LIMIT))
    except (TypeError, ValueError):
        lim = 10
    has_center = lat is not None and lng is not None
    scored: list[tuple[float, dict[str, Any]]] = []
    for p in load_pois():
        if category and p["category"] != category:
            continue
        if tokens:
            name_field = _norm(p["name"]) + "\x1f" + _norm(p["name_en"])
            tag_field = "\x1f".join(_norm(t) for t in p["tags"])
            text_field = _norm(p["summary"]) + "\x1f" + _norm(p["address"]) + "\x1f" + _norm(p["category"])
            fields = (name_field, tag_field, text_field)
            if not all(any(tok in f for f in fields) for tok in tokens):
                continue
            name_hit = all(tok in name_field for tok in tokens)
            tag_hit = all(tok in tag_field for tok in tokens)
            score = 0 if name_hit else (1 if tag_hit else 2)
        else:
            score = 0
        dist = geo.haversine_m(float(lat), float(lng), p["lat"], p["lng"]) if has_center else None  # type: ignore[arg-type]
        if has_center and radius_m is not None and dist > int(radius_m):  # type: ignore[operator]
            continue
        scored.append(((dist if has_center else score), _item(p, dist)))
    scored.sort(key=lambda sp: (sp[0], sp[1]["name"]))
    return [it for _, it in scored[:lim]]


def get(id: str) -> dict[str, Any] | None:  # noqa: A002 — interface name fixed by plan 5
    for p in load_pois():
        if p["id"] == id:
            return _item(p)
    return None
