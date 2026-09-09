#!/usr/bin/env python3
"""Verify tile bytes, cache hits, CORS and download latency through CloudFront.

Network timings describe this test host and cache state, not browser FPS.
Only five sample Jeju tiles are downloaded; no regional dataset is copied.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import statistics
import time

import requests

SAMPLES = [
    ("Hallasan overview", "10/871/411.png"),
    ("Hallasan", "12/3487/1644.png"),
    ("Hallasan close", "14/13950/6579.png"),
    ("Seongsan", "12/3492/1643.png"),
    ("Udo", "14/13969/6572.png"),
]
SOURCE = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium"


def fetch(session, url, *, origin=False):
    start = time.perf_counter()
    response = session.get(
        url, timeout=20,
        headers={"Origin": "https://example.com"} if origin else None,
    )
    elapsed = (time.perf_counter() - start) * 1000
    return response, elapsed


def verify(url, rounds, report_path):
    source = requests.Session()
    cached = requests.Session()
    rows = []
    for name, tile in SAMPLES:
        original, original_ms = fetch(source, f"{SOURCE}/{tile}")
        original.raise_for_status()
        assert original.content.startswith(b"\x89PNG\r\n\x1a\n"), f"{name}: upstream is not PNG"
        digest = hashlib.sha256(original.content).hexdigest()
        tile_url = f"{url.rstrip('/')}/terrarium/{tile}"
        first, first_ms = fetch(cached, tile_url, origin=True)
        assert first.status_code == 200, f"{name}: CDN tile returned {first.status_code}"
        assert first.headers.get("Content-Type", "").startswith("image/png"), f"{name}: wrong CDN content type"
        assert hashlib.sha256(first.content).hexdigest() == digest, f"{name}: CDN changed the elevation bytes"
        assert first.headers.get("Access-Control-Allow-Origin") == "*", f"{name}: public tile CORS missing"
        assert first.headers.get("Cache-Control") == "public, max-age=86400", f"{name}: browser TTL missing"
        assert first.headers.get("Timing-Allow-Origin") == "*", f"{name}: tile timing unavailable"
        assert first.headers.get("ETag"), f"{name}: tile revalidation tag missing"
        revalidated = cached.get(
            tile_url, headers={"If-None-Match": first.headers["ETag"]}, timeout=20,
        )
        assert revalidated.status_code == 304, f"{name}: cached tile revalidation failed"
        assert revalidated.headers.get("Cache-Control") == "public, max-age=86400", f"{name}: 304 lost the browser TTL"
        timings = []
        direct_timings = []
        cache_states = []
        for index in range(rounds):
            # Alternate the order to avoid always giving one endpoint the first request.
            if index % 2:
                direct, direct_ms = fetch(source, f"{SOURCE}/{tile}")
                response, elapsed = fetch(cached, tile_url)
            else:
                response, elapsed = fetch(cached, tile_url)
                direct, direct_ms = fetch(source, f"{SOURCE}/{tile}")
            assert response.status_code == direct.status_code == 200
            assert hashlib.sha256(response.content).hexdigest() == digest
            assert hashlib.sha256(direct.content).hexdigest() == digest
            assert "Hit from cloudfront" in response.headers.get("X-Cache", ""), (
                f"{name}: expected warm edge hit, got {response.headers.get('X-Cache')}"
            )
            timings.append(round(elapsed, 3))
            direct_timings.append(round(direct_ms, 3))
            cache_states.append(response.headers["X-Cache"])
        row = {
            "name": name, "tile": tile, "bytes": len(first.content), "sha256": digest,
            "firstDirectMs": round(original_ms, 3), "firstCdnMs": round(first_ms, 3),
            "firstCdnCache": first.headers.get("X-Cache"),
            "revalidationStatus": revalidated.status_code,
            "directMs": direct_timings, "warmCdnMs": timings, "warmCacheStates": cache_states,
        }
        rows.append(row)
        print(json.dumps({
            "tile": tile, "bytesMatch": True,
            "directMedianMs": statistics.median(direct_timings),
            "warmCdnMedianMs": statistics.median(timings), "cacheHits": len(cache_states),
        }), flush=True)
    all_direct = [value for row in rows for value in row["directMs"]]
    all_warm = [value for row in rows for value in row["warmCdnMs"]]
    direct_median = statistics.median(all_direct)
    warm_median = statistics.median(all_warm)
    missing, _ = fetch(cached, f"{url.rstrip('/')}/terrarium/15/0/does-not-exist.png")
    assert missing.status_code in (403, 404), "Missing tiles must remain errors"
    assert missing.headers.get("Cache-Control") == "no-store", "Tile errors must not stick in the browser cache"
    result = {
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "url": url, "passed": True, "samples": len(rows), "rounds": rounds,
        "warmHits": len(all_warm),
        "directMedianMs": round(direct_median, 3),
        "warmCdnMedianMs": round(warm_median, 3),
        "downloadLatencyReductionPercent": round((1 - warm_median / direct_median) * 100, 1),
        "missingTileStatus": missing.status_code,
        "errorCacheControl": missing.headers.get("Cache-Control"),
        "scope": "Five Jeju DEM tiles; sequential HTTP downloads from this host with warm edge cache; not browser FPS or whole-page loading time.",
        "tiles": rows,
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({key: value for key, value in result.items() if key != "tiles"}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="https://d2mznud99i2mdr.cloudfront.net")
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--report", type=Path, default=Path(".local/terrain-cache-verification.json"))
    args = parser.parse_args()
    if not 1 <= args.rounds <= 10:
        parser.error("--rounds must be between 1 and 10")
    verify(args.url, args.rounds, args.report)
