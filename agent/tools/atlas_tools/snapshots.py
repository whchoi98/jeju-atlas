"""Snapshot store for data produced by the Korea-side runner (plan 5): layers/{parking,road,ev}.json, festivals.json.

Resolution order: $ATLAS_SNAPSHOT_DIR/<name>.json → <package>/data/snapshots/<name>.json →
s3://$ATLAS_CATALOG_BUCKET/snapshots/<name>.json. Results (including misses) are cached CACHE_TTL_S seconds.
Schema: {"observed_at": ISO8601, "source": str, "items": [...]}. Never raises.
"""
from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)
CACHE_TTL_S = 60.0
_PKG_DIR = Path(__file__).resolve().parent.parent / "data" / "snapshots"
_cache: dict[str, tuple[float, dict[str, Any] | None]] = {}


def _s3():
    import boto3  # lazy: tests and local dev do not need it

    return boto3.client("s3", region_name=os.environ.get("AWS_REGION", "ap-northeast-2"))


def _valid(data: Any) -> dict[str, Any] | None:
    if isinstance(data, dict) and isinstance(data.get("items"), list):
        return data
    return None


def _from_file(path: Path) -> dict[str, Any] | None:
    try:
        return _valid(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError) as exc:
        log.info("snapshot %s unreadable: %s", path, type(exc).__name__)
        return None


def _from_s3(name: str) -> dict[str, Any] | None:
    bucket = os.environ.get("ATLAS_CATALOG_BUCKET")
    if not bucket:
        return None
    key = f"snapshots/{name}.json"
    try:
        body = _s3().get_object(Bucket=bucket, Key=key)["Body"].read()
        return _valid(json.loads(body))
    except Exception as exc:  # NoSuchKey, AccessDenied, no credentials, bad JSON …
        log.info("snapshot s3://%s/%s unavailable: %s", bucket, key, type(exc).__name__)
        return None


def reset_cache() -> None:
    _cache.clear()


def load(name: str) -> dict[str, Any] | None:
    now = time.monotonic()
    hit = _cache.get(name)
    if hit and hit[0] > now:
        return hit[1]
    snap: dict[str, Any] | None = None
    local_dir = os.environ.get("ATLAS_SNAPSHOT_DIR")
    candidates = [Path(local_dir) / f"{name}.json"] if local_dir else []
    candidates.append(_PKG_DIR / f"{name}.json")
    for path in candidates:
        if path.is_file():
            snap = _from_file(path)
            if snap is not None:
                break
    if snap is None:
        snap = _from_s3(name)
    _cache[name] = (now + CACHE_TTL_S, snap)
    return snap


def age_s(snapshot: dict[str, Any] | None, now: datetime | None = None) -> float | None:
    raw = (snapshot or {}).get("observed_at")
    if not isinstance(raw, str):
        return None
    try:
        observed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if observed.tzinfo is None:
        observed = observed.replace(tzinfo=timezone.utc)
    now = now or datetime.now(timezone.utc)
    return (now - observed).total_seconds()


def is_stale(snapshot: dict[str, Any] | None, max_age_s: float) -> bool:
    age = age_s(snapshot)
    return age is None or age > max_age_s
