"""Read the Atlas official-detail snapshot; no provider keys or live scraping."""
from __future__ import annotations

import json
import logging
import math
import os
import time
import threading
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qsl, urlsplit

import boto3
from botocore.config import Config

log = logging.getLogger(__name__)
MAX_BYTES = 16 * 1024 * 1024
_records: dict = {}
_etag: str | None = None
_next_check = 0.0
_client = None
_stale = True
_lock = threading.RLock()


def _text(value, limit):
    return value.strip()[:limit] if isinstance(value, str) and value.strip() else None


def _url(value):
    value = _text(value, 2048)
    if not value or any(ord(char) <= 32 for char in value):
        return None
    try:
        url = urlsplit(value)
        if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password:
            return None
        if any(key.lower() in {"apikey", "servicekey", "access_token", "authorization", "password", "token"}
               for key, _ in parse_qsl(url.query)):
            return None
        return value
    except ValueError:
        return None


def _refresh_unlocked():
    global _records, _etag, _next_check, _client, _stale
    bucket = os.environ.get("ATLAS_DETAILS_BUCKET")
    if not bucket or time.monotonic() < _next_check:
        return
    _next_check = time.monotonic() + 600
    try:
        if _client is None:
            _client = boto3.client("s3", region_name="ap-northeast-2",
                                   config=Config(connect_timeout=3, read_timeout=10, retries={"total_max_attempts": 1}))
        kwargs = {"Bucket": bucket, "Key": "place-details/latest.json"}
        if _etag:
            kwargs["IfNoneMatch"] = _etag
        response = _client.get_object(**kwargs)
        body = response["Body"]
        try:
            raw = body.read(MAX_BYTES + 1)
        finally:
            body.close()
        if len(raw) > MAX_BYTES:
            raise ValueError("oversized")
        snapshot = json.loads(raw)
        if snapshot.get("version") != 1 or not isinstance(snapshot.get("records"), dict) or len(snapshot["records"]) > 20000:
            raise ValueError("schema")
        _records = snapshot["records"]
        _etag = response.get("ETag")
        _stale = False
    except Exception as error:  # External data failure must not remove base place detail.
        response = getattr(error, "response", {})
        if response.get("ResponseMetadata", {}).get("HTTPStatusCode") == 304:
            _stale = False
            return
        _stale = True
        log.warning("official_details_refresh_failed type=%s", type(error).__name__)


def _refresh():
    with _lock:
        _refresh_unlocked()


def _old_record(value):
    try:
        date = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        return date.tzinfo is None or date > now or date < now - timedelta(days=14)
    except (TypeError, ValueError):
        return True


def for_place(place_id: str) -> dict:
    _refresh()
    raw_records = _records.get(place_id, [])
    if not isinstance(raw_records, list):
        return {}
    result = []
    for raw in raw_records[:4]:
        if not isinstance(raw, dict) or raw.get("provider") not in ("tourapi", "visitjeju"):
            continue
        source = _url(raw.get("source_url"))
        title = _text(raw.get("title"), 200)
        if not source or not title or raw.get("locale") not in ("ko", "en"):
            continue
        facts = []
        raw_facts = raw.get("facts", [])
        for fact in raw_facts[:16] if isinstance(raw_facts, list) else []:
            if not isinstance(fact, dict):
                continue
            value = _text(fact.get("value"), 900)
            label = _text(fact.get("label_ko"), 100)
            if value and label:
                facts.append({"key": _text(fact.get("key"), 100), "label_ko": label,
                              "label_en": _text(fact.get("label_en"), 100), "value": value})
        match = raw.get("match") if isinstance(raw.get("match"), dict) else {}
        distance = match.get("distance_m")
        result.append({
            "provider": raw["provider"], "provider_id": _text(raw.get("provider_id"), 128),
            "locale": raw["locale"], "title": title,
            "address": _text(raw.get("address"), 600), "phone": _text(raw.get("phone"), 120),
            "website": _url(raw.get("website")), "overview": _text(raw.get("overview"), 1600),
            "facts": facts, "source_url": source, "fetched_at": _text(raw.get("fetched_at"), 50),
            "stale": _stale or _old_record(raw.get("fetched_at")),
            "match": {"method": _text(match.get("method"), 100),
                      "distance_m": distance if isinstance(distance, (int, float)) and not isinstance(distance, bool) and math.isfinite(distance) and distance >= 0 else None},
        })
    return {
        "official_details": result,
        "official_details_stale": _stale or any(item["stale"] for item in result),
        "official_details_note": "Provider-reported information matched to this catalog place. Use each field's source and fetched date; do not infer missing facts or current opening status.",
    } if result else {}
