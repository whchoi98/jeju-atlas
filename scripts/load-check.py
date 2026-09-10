#!/usr/bin/env python3
"""Bounded GET-only load check. Writes only the explicitly selected JSON report."""
from __future__ import annotations

import sys
sys.dont_write_bytecode = True

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import re
import threading
import time
from urllib.parse import urlencode, urlsplit

import requests

HTTP_TIMEOUT = 15
MAX_BODY_BYTES = 1024 * 1024
RELEASE = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
SEARCHES = tuple(
    (f"search:{label}", "/api/catalog/search?" + urlencode({"q": query, "limit": 12}))
    for label, query in [
        ("hallasan", "한라산"), ("hyeopjae", "협재"), ("seongsan", "성산"),
        ("family", "가족"), ("cafe", "카페"),
    ]
)
CONFIG = ("config", "/api/config")
HEALTH = ("health", "/healthz")
WORKLOAD = tuple(route for search in SEARCHES for route in (search, CONFIG))
WARMUP = SEARCHES + (CONFIG,)


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def canonical_url(value):
    """Only an origin, never a credential-bearing URL or a query to be logged."""
    try:
        parsed = urlsplit(value.strip())
        host, port = parsed.hostname, parsed.port
        if (not host or parsed.username is not None or parsed.password is not None
                or parsed.query or parsed.fragment or parsed.path not in ("", "/")
                or "\\" in value or any(ord(char) <= 32 for char in value.strip())):
            raise ValueError()
        if parsed.scheme != "https" and not (
                parsed.scheme == "http" and host in {"localhost", "127.0.0.1", "::1"}):
            raise ValueError()
        authority = f"[{host.lower()}]" if ":" in host else host.lower()
        if port and port != (443 if parsed.scheme == "https" else 80):
            authority += f":{port}"
        return f"{parsed.scheme}://{authority}"
    except (AttributeError, TypeError, ValueError):
        raise ValueError("URL must be an HTTPS origin (HTTP is allowed only on loopback)") from None


class InvalidResponse(Exception):
    pass


def validate_json(route, data, release=None):
    if not isinstance(data, dict):
        raise InvalidResponse("invalid_json_schema")
    if route == "health":
        value = data.get("release")
        if (data.get("status") != "ok" or data.get("service") != "jeju-3d"
                or not isinstance(value, str) or not RELEASE.fullmatch(value)):
            raise InvalidResponse("invalid_health")
        if release is not None and value != release:
            raise InvalidResponse("release_changed")
        return value
    if route == "config":
        features, guide = data.get("features"), data.get("guide")
        version = data.get("version")
        if (not isinstance(version, str) or not RELEASE.fullmatch(version)
                or (release is not None and version != release) or not isinstance(features, dict)
                or not all(type(features.get(key)) is bool for key in ("catalog", "guide", "planner", "pwa"))
                or features["catalog"] is not True or not isinstance(guide, dict)
                or type(guide.get("daily_limit")) is not int or not 1 <= guide["daily_limit"] <= 30):
            raise InvalidResponse("invalid_config")
        proof = guide.get("csrf_token")
        if features["guide"] and (not isinstance(proof, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", proof)):
            raise InvalidResponse("invalid_config")
        return None
    if route.startswith("search:"):
        items = data.get("items")
        if (not isinstance(items, list) or not 1 <= len(items) <= 12
                or type(data.get("total")) is not int or data["total"] < len(items)
                or type(data.get("has_more")) is not bool):
            raise InvalidResponse("invalid_search")
        for item in items:
            if (not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"]
                    or not isinstance(item.get("name"), str) or not item["name"]
                    or not isinstance(item.get("category"), str)
                    or type(item.get("lat")) not in (int, float)
                    or type(item.get("lng")) not in (int, float)
                    or not 33.1 <= item["lat"] <= 33.6 or not 126.15 <= item["lng"] <= 126.98):
                raise InvalidResponse("invalid_search")
        return None
    raise InvalidResponse("unexpected_route")


def probe(session, base, route, release=None, *, timeout=HTTP_TIMEOUT, clock=time.monotonic):
    """Read bounded JSON; never return response headers, cookies, or bodies."""
    label, path = route
    started = clock()
    sample = {"route": label, "status": 0, "error": None, "elapsed_ms": 0}
    try:
        if not 0 < timeout <= HTTP_TIMEOUT:
            raise InvalidResponse("deadline_exceeded")
        with session.get(base + path, timeout=timeout, allow_redirects=False, stream=True) as response:
            sample["status"] = int(response.status_code)
            if response.status_code != 200:
                raise InvalidResponse(f"http_{response.status_code}")
            if not response.headers.get("Content-Type", "").lower().startswith("application/json"):
                raise InvalidResponse("invalid_content_type")
            chunks, size = [], 0
            for chunk in response.iter_content(chunk_size=4096):
                if clock() - started > timeout:
                    raise InvalidResponse("deadline_exceeded")
                size += len(chunk)
                if size > MAX_BODY_BYTES:
                    raise InvalidResponse("response_too_large")
                chunks.append(chunk)
            value = validate_json(label, json.loads(b"".join(chunks)), release)
            if label == "health":
                sample["release"] = value
    except InvalidResponse as error:
        sample["error"] = str(error)
    except requests.Timeout:
        sample["error"] = "timeout"
    except requests.RequestException:
        sample["error"] = "connection_error"
    except (ValueError, UnicodeError, TypeError):
        sample["error"] = "invalid_json"
    except Exception:
        sample["error"] = "request_error"
    sample["elapsed_ms"] = round(max(0, clock() - started) * 1000, 3)
    return sample


def summarize(samples, elapsed_seconds, *, per_route=True):
    values = sorted(sample["elapsed_ms"] for sample in samples)
    percentile = lambda fraction: values[max(0, math.ceil(len(values) * fraction) - 1)] if values else None
    result = {
        "requests": len(samples),
        "errors": sum(sample["error"] is not None for sample in samples),
        "error_counts": dict(Counter(sample["error"] for sample in samples if sample["error"])),
        "status_counts": dict(Counter(str(sample["status"]) for sample in samples)),
        "p50_ms": percentile(.5), "p95_ms": percentile(.95),
        "max_ms": values[-1] if values else None,
        "elapsed_seconds": round(elapsed_seconds, 3),
        "rps": round(len(samples) / max(elapsed_seconds, .000001), 3),
    }
    if per_route:
        result["per_route"] = {
            route: summarize([sample for sample in samples if sample["route"] == route],
                             elapsed_seconds, per_route=False)
            for route in sorted({sample["route"] for sample in samples})
        }
    return result


def run_load(url, *, sessions=50, warmup=True, session_factory=requests.Session,
             clock=time.monotonic, progress=lambda event: None):
    if type(sessions) is not int or not 1 <= sessions <= 100:
        raise ValueError("sessions must be an integer from 1 to 100")
    base = canonical_url(url)
    report = {
        "kind": "load", "started_at": utc_now(), "target": base, "sessions": sessions,
        "requests_per_session": 10, "expected_measured_requests": sessions * 10,
        "request_timeout_seconds": HTTP_TIMEOUT, "release": None, "passed": False,
        "goal": {"errors": 0, "p95_ms_at_most": 1000, "scope": "temporary target from a Seoul test host"},
        "route_paths": dict(SEARCHES + (CONFIG,)),
    }
    warm_samples = []
    with session_factory() as session:
        health = probe(session, base, HEALTH, clock=clock)
        report["preflight"] = health
        report["release"] = health.get("release")
        if health["error"]:
            report["warmup"] = summarize([], 0)
            report["measured"] = summarize([], 0)
            return report
        warm_started = clock()
        if warmup:
            for route in WARMUP:
                warm_samples.append(probe(session, base, route, report["release"], clock=clock))
        report["warmup"] = {**summarize(warm_samples, clock() - warm_started), "excluded_from_measurement": True}
    stop = threading.Event()
    samples = []

    def worker():
        results = []
        with session_factory() as session:
            for route in WORKLOAD:
                if stop.is_set():
                    break
                results.append(probe(session, base, route, report["release"], clock=clock))
        return results

    started = clock()
    with ThreadPoolExecutor(max_workers=sessions) as executor:
        futures = [executor.submit(worker) for _ in range(sessions)]
        try:
            for completed, future in enumerate(as_completed(futures), 1):
                samples.extend(future.result())
                if completed % 10 == 0 or completed == sessions:
                    progress({"phase": "load", "completed_sessions": completed, "sessions": sessions})
        except KeyboardInterrupt:
            stop.set()
            report["interrupted"] = True
            samples = [sample for future in futures for sample in future.result()]
    report["measured"] = summarize(samples, clock() - started)
    result = report["measured"]
    report["passed"] = (len(samples) == sessions * 10 and result["errors"] == 0
                        and result["p95_ms"] <= 1000 and not report.get("interrupted"))
    report["finished_at"] = utc_now()
    return report


def write_report(path, report):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", help="Public app origin, CloudFront URL, or loopback preview")
    parser.add_argument("--output", "-o", type=Path, required=True, help="Only report file written, e.g. .local/load.json")
    parser.add_argument("--sessions", type=int, default=50)
    parser.add_argument("--no-warmup", action="store_true")
    args = parser.parse_args()
    try:
        report = run_load(args.url, sessions=args.sessions, warmup=not args.no_warmup,
                          progress=lambda event: print(json.dumps(event), flush=True))
    except Exception:
        report = {"kind": "load", "passed": False, "error": "invalid_arguments_or_check_failure"}
    write_report(args.output, report)
    print(json.dumps({"report": str(args.output), "passed": report["passed"],
                      "measured": report.get("measured")}, ensure_ascii=False))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
