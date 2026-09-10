#!/usr/bin/env python3
"""Collect official Jeju details into an independent, validated S3 snapshot.

Credentials come from the two Atlas SSM SecureString parameters. They are
never included in snapshots, logs, image URLs or command-line arguments.
Category lists are committed only after complete pagination. Snapshot
last_attempt maps canonical IDs to actual attempt times for fair rotation;
it never refreshes retained provider fetched_at timestamps.
Identical page overlaps require a complete unique-ID total. Retryable category
failures restart once, sharing the original deadline and API call counters.
"""
from __future__ import annotations
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import signal
import sqlite3
import tempfile
import time
from urllib.parse import urlsplit, urlunsplit

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
import requests
from urllib3.exceptions import ReadTimeoutError

from place_detail_sources import TOUR_CATEGORIES, VISIT_CATEGORIES, match_place, parse_tourapi, parse_visitjeju

KEY_PATHS = {
    "tourapi": "/jeju-atlas/tourapi-service-key",
    "visitjeju": "/jeju-atlas/visitjeju-api-key",
}
TOUR = "https://apis.data.go.kr/B551011/KorService2"
VISIT = "https://api.visitjeju.net/vsjApi/contents/searchList"
MEDIA_HOSTS = {"tong.visitkorea.or.kr", "cdn.visitkorea.or.kr", "api.cdn.visitjeju.net"}
PHOTO_LICENSES = {"KOGL-1", "KOGL-3", "CC-BY-4.0", "CC-BY-SA-4.0", "CC0", "PD"}
MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024
MAX_IMAGE_BYTES = 12 * 1024 * 1024
MAX_MEDIA_BYTES = 512 * 1024 * 1024
MAX_OPERATION_CALLS = 850
CATEGORY_RETRY_DELAY = 1.0
CATEGORY_RETRY_CODES = {
    "connect_timeout", "read_timeout", "request_timeout", "connection_error", "transport_error", "invalid_json",
    "http_408", "http_429", "http_500", "http_502", "http_503", "http_504",
    "listing_changed_during_pagination", "listing_no_progress", "inconsistent_listing_count", "incomplete_listing",
    "unexpected_listing_page",
}


class SourceFailure(Exception):
    """A safe error code; never a URL, API key or provider error body."""


class JobDeadline(BaseException):
    """Process termination, never a recoverable provider or media failure."""


def abort_job(*_):
    raise JobDeadline()


def emit(event, **values):
    print(json.dumps({"event": event, **values}, ensure_ascii=False), flush=True)


def iso_now():
    return datetime.now(timezone.utc).isoformat()


class Fetcher:
    def __init__(self, keys, deadline):
        self.keys = keys
        self.deadline = deadline
        self.calls = Counter()
        self.http = requests.Session()
        self.http.headers["User-Agent"] = "JejuAtlasData/1.0"
        self.next_request = 0.0

    def get_json(self, provider, operation, params):
        if time.monotonic() >= self.deadline:
            raise SourceFailure("deadline")
        key = f"{provider}:{operation}"
        if self.calls[key] >= MAX_OPERATION_CALLS:
            raise SourceFailure("operation_budget")
        pause = self.next_request - time.monotonic()
        if pause > 0:
            time.sleep(pause)
        if time.monotonic() >= self.deadline:
            raise SourceFailure("deadline")
        self.next_request = time.monotonic() + 0.12
        self.calls[key] += 1
        url = f"{TOUR}/{operation}" if provider == "tourapi" else VISIT
        parameters = dict(params)
        parameters["serviceKey" if provider == "tourapi" else "apiKey"] = self.keys[provider]
        try:
            with self.http.get(url, params=parameters, timeout=(5, 20), stream=True) as response:
                if response.status_code != 200:
                    raise SourceFailure(f"http_{response.status_code}")
                raw = bytearray()
                for chunk in response.iter_content(65536):
                    raw.extend(chunk)
                    if len(raw) > MAX_SNAPSHOT_BYTES:
                        raise SourceFailure("response_too_large")
        except requests.ConnectTimeout:
            raise SourceFailure("connect_timeout") from None
        except requests.ReadTimeout:
            raise SourceFailure("read_timeout") from None
        except requests.Timeout:
            raise SourceFailure("request_timeout") from None
        except requests.ConnectionError as error:
            # Requests wraps streamed urllib3 read timeouts in ConnectionError.
            code = "read_timeout" if any(isinstance(arg, ReadTimeoutError) for arg in error.args) else "connection_error"
            raise SourceFailure(code) from None
        except requests.RequestException:
            raise SourceFailure("transport_error") from None
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise SourceFailure("invalid_json") from None
        if not isinstance(data, dict):
            raise SourceFailure("invalid_response")
        if provider == "tourapi":
            header = data.get("response", {}).get("header", {})
            if header.get("resultCode") != "0000":
                raise SourceFailure("provider_rejected")
            return data.get("response", {}).get("body", {})
        if str(data.get("result")) != "200":
            raise SourceFailure("provider_rejected")
        return data

    def tour(self, operation, **params):
        return self.get_json("tourapi", operation, {
            "MobileOS": "ETC", "MobileApp": "JejuAtlas", "_type": "json", **params,
        })


def tour_items(body):
    raw = body.get("items") or {}
    rows = raw.get("item", []) if isinstance(raw, dict) else []
    return [rows] if isinstance(rows, dict) else rows if isinstance(rows, list) else []


def _page_count(value):
    if isinstance(value, bool) or not isinstance(value, (str, int)) or not str(value).isdigit():
        raise SourceFailure("invalid_pagination")
    return int(value)


def _stage_rows(staged, rows, identity_key):
    if not isinstance(rows, list):
        raise SourceFailure("invalid_listing")
    for row in rows:
        if not isinstance(row, dict) or isinstance(row.get(identity_key), bool):
            raise SourceFailure("invalid_listing_identity")
        identity = str(row.get(identity_key) or "").strip()
        if not identity:
            raise SourceFailure("invalid_listing_identity")
        if identity in staged and staged[identity] != row:
            raise SourceFailure("conflicting_listing_identity")
        staged[identity] = row


def _category_list(fetcher, provider, category, locale):
    staged, expected, expected_total = {}, None, None
    duplicate_rows, totals_present = 0, None
    identity_key = "contentid" if provider == "tourapi" else "contentsid"
    for page in range(1, 101):
        if provider == "tourapi":
            body = fetcher.tour("areaBasedList2", lDongRegnCd="50", contentTypeId=category,
                                pageNo=page, numOfRows=100)
        else:
            body = fetcher.get_json("visitjeju", "searchList", {"locale": locale, "category": category, "page": page})
        if not isinstance(body, dict):
            raise SourceFailure("invalid_listing")
        page_field = "pageNo" if provider == "tourapi" else "currentPage"
        if page_field in body and _page_count(body[page_field]) != page:
            raise SourceFailure("unexpected_listing_page")
        count = _page_count(body.get("totalCount" if provider == "tourapi" else "pageCount"))
        if expected is not None and count != expected:
            raise SourceFailure("listing_changed_during_pagination")
        expected = count
        if count > (10000 if provider == "tourapi" else 100):
            raise SourceFailure("listing_page_limit")
        if provider == "visitjeju":
            has_total = "totalCount" in body
            if totals_present is not None and has_total != totals_present:
                raise SourceFailure("listing_changed_during_pagination")
            totals_present = has_total
            if has_total:
                total = _page_count(body["totalCount"])
                if expected_total is not None and total != expected_total:
                    raise SourceFailure("listing_changed_during_pagination")
                expected_total = total
        rows = tour_items(body) if provider == "tourapi" else body.get("items", [])
        before = len(staged)
        _stage_rows(staged, rows, identity_key)
        new_ids = len(staged) - before
        duplicate_rows += len(rows) - new_ids
        if page > 1 and rows and not new_ids:
            raise SourceFailure("listing_no_progress")
        if provider == "tourapi":
            if len(staged) > expected:
                raise SourceFailure("inconsistent_listing_count")
            if len(staged) == expected:
                return list(staged.values())
        elif page >= expected:
            if (expected == 0 and staged) or (expected > 1 and not rows):
                raise SourceFailure("incomplete_listing")
            if duplicate_rows and expected_total is None:
                raise SourceFailure("unverified_duplicate_listing")
            if expected_total is not None and len(staged) != expected_total:
                raise SourceFailure("inconsistent_listing_count")
            return list(staged.values())
        if not rows:
            raise SourceFailure("incomplete_listing")
    raise SourceFailure("listing_page_limit")


def _category_with_retry(fetcher, provider, category, locale):
    operation = "areaBasedList2" if provider == "tourapi" else "searchList"
    counter = f"{provider}:{operation}"
    for attempt in (1, 2):
        try:
            # Each call owns a new staging map: never merge different passes.
            return _category_list(fetcher, provider, category, locale)
        except SourceFailure as error:
            code = str(error)
            if attempt == 2 or code not in CATEGORY_RETRY_CODES:
                raise
            if (time.monotonic() + CATEGORY_RETRY_DELAY >= fetcher.deadline
                    or fetcher.calls[counter] >= MAX_OPERATION_CALLS):
                raise
            time.sleep(CATEGORY_RETRY_DELAY)
            if time.monotonic() >= fetcher.deadline:
                raise SourceFailure("deadline") from None
            if fetcher.calls[counter] >= MAX_OPERATION_CALLS:
                raise SourceFailure("operation_budget") from None
            emit("category_retry", provider=provider, locale=locale, category=category, attempt=2, code=code)


def collect_lists(fetcher):
    lists = {"tourapi": [], "visitjeju": [], "visitjeju_en": []}
    failures = []
    groups = [("tourapi", "kr", "tourapi", ("12", "14", "25", "28", "38", "39")),
              ("visitjeju", "kr", "visitjeju", ("c1", "c3", "c4")),
              ("visitjeju", "en", "visitjeju_en", ("c1", "c3", "c4"))]
    for provider, locale, output_key, categories in groups:
        for category in categories:
            try:
                # No row escapes a category until every declared page succeeds.
                rows = _category_with_retry(fetcher, provider, category, locale)
                lists[output_key].extend(rows)
            except SourceFailure as error:
                failures.append({"provider": provider, "locale": locale, "category": category, "code": str(error)})
        try:
            unique = {}
            _stage_rows(unique, lists[output_key], "contentid" if provider == "tourapi" else "contentsid")
            lists[output_key] = list(unique.values())
        except SourceFailure as error:
            # Conflicting IDs across categories must not become last-write-wins,
            # including the English lookup by VisitJeju contentsid.
            lists[output_key] = []
            failures.append({"provider": provider, "locale": locale, "category": "all", "code": str(error)})
    emit("source_lists", tourapi=len(lists["tourapi"]), visitjeju=len(lists["visitjeju"]),
         visitjeju_en=len(lists["visitjeju_en"]), failures=failures)
    return lists, failures


def provider_complete_for(place, provider, failures, locale="kr"):
    categories = TOUR_CATEGORIES if provider == "tourapi" else {
        "c1": VISIT_CATEGORIES["관광지"], "c3": VISIT_CATEGORIES["쇼핑"], "c4": VISIT_CATEGORIES["음식점"],
    }
    for failure in failures:
        if failure.get("provider") != provider or failure.get("locale", "kr") != locale:
            continue
        category = failure.get("category")
        if category == "all" or place["category"] in categories.get(category, set()):
            return False
    return True


def media_url(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in ("http", "https") or parsed.hostname not in MEDIA_HOSTS or parsed.username or parsed.password or parsed.port not in (None, 443):
            return None
        if parsed.query or parsed.fragment or any(ord(c) < 32 for c in value):
            return None
        return urlunsplit(("https", parsed.netloc, parsed.path, "", ""))
    except ValueError:
        return None


def image_type(raw):
    if raw.startswith(b"\xff\xd8\xff"):
        return "jpg", "image/jpeg"
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png", "image/png"
    if raw.startswith(b"RIFF") and raw[8:12] == b"WEBP":
        return "webp", "image/webp"
    return None


def mirror_photos(record, old_records, fetcher, s3, bucket, public_origin, budget, publish):
    old = {}
    for item in old_records:
        for photo in item.get("photos", []):
            if not isinstance(photo, dict):
                continue
            origin = media_url(photo.get("origin_url"))
            url = photo.get("url")
            if not origin or photo.get("license") not in PHOTO_LICENSES or not isinstance(url, str):
                continue
            # Canonicalize the authorized provider origin for cache lookup, but
            # keep the mirrored bytes/URL and require the CURRENT same license.
            if (not url.startswith(public_origin + "/media/") or "?" in url or "#" in url
                    or "%" in url or "\\" in url or any(ord(c) <= 32 for c in url)
                    or any(part.startswith(".") for part in urlsplit(url).path.split("/"))):
                continue
            old.setdefault((origin, photo["license"]), photo)
    photos = []
    for photo in record.get("photos", [])[:4]:
        if photo.get("license") not in PHOTO_LICENSES or not photo.get("credit"):
            continue
        origin = media_url(photo.get("origin_url") or photo.get("url"))
        if not origin:
            continue
        copy = dict(photo, origin_url=origin)
        cached = old.get((origin, photo["license"]))
        if cached:
            copy["url"] = cached["url"]
        elif budget["bytes"] < MAX_MEDIA_BYTES and time.monotonic() < fetcher.deadline:
            try:
                with fetcher.http.get(origin, stream=True, timeout=(5, 20), allow_redirects=False) as response:
                    if response.status_code != 200:
                        continue
                    data = bytearray()
                    for chunk in response.iter_content(65536):
                        data.extend(chunk)
                        if len(data) > MAX_IMAGE_BYTES or budget["bytes"] + len(data) > MAX_MEDIA_BYTES:
                            raise SourceFailure("image_budget")
                kind = image_type(data)
                if not kind:
                    continue
                budget["bytes"] += len(data)
                sha = hashlib.sha256(data).hexdigest()
                key = f"media/{sha}.{kind[0]}"
                if publish:
                    s3.put_object(Bucket=bucket, Key=key, Body=bytes(data), ContentType=kind[1],
                                  CacheControl="public, max-age=31536000, immutable", ServerSideEncryption="AES256",
                                  Metadata={"license": photo["license"], "sha256": sha})
                    copy["url"] = public_origin + "/" + key
                else:
                    copy["url"] = origin
            except (requests.RequestException, SourceFailure, ClientError):
                continue
        else:
            continue
        if copy["license"] == "KOGL-3":
            copy["thumb_url"] = None
        photos.append(copy)
    record["photos"] = photos


def read_previous(s3, bucket):
    if not bucket:
        return {"version": 1, "records": {}}
    try:
        response = s3.get_object(Bucket=bucket, Key="place-details/latest.json")
        raw = response["Body"].read(MAX_SNAPSHOT_BYTES + 1)
        if len(raw) > MAX_SNAPSHOT_BYTES:
            raise SourceFailure("previous_snapshot_too_large")
        data = json.loads(raw)
        if data.get("version") != 1 or not isinstance(data.get("records"), dict):
            raise SourceFailure("invalid_previous_snapshot")
        data["_etag"] = response.get("ETag")
        return data
    except ClientError as error:
        if error.response["Error"]["Code"] in ("NoSuchKey", "404", "NoSuchBucket"):
            return {"version": 1, "records": {}}
        raise


def refresh_order(place, records, last_attempt=None):
    previous = records.get(place["id"], [])
    dates = [str(item.get("fetched_at", "")) for item in previous if isinstance(item, dict)]
    attempt = (last_attempt or {}).get(place["id"], "")
    # Unattempted places first; a retained failed provider cannot pin a recently
    # attempted place ahead of the rest. Legacy source dates are tie-breakers
    # only, never synthesized into last_attempt or a new fetched_at.
    return (attempt, bool(previous), min(dates, default=""), place["source"] != "sample", place["id"])


def publish_snapshot(s3, bucket, raw, previous_etag):
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    options = {"Bucket": bucket, "Body": raw, "ContentType": "application/json",
               "CacheControl": "no-store", "ServerSideEncryption": "AES256"}
    s3.put_object(**options, Key=f"place-details/history/{stamp}.json")
    condition = {"IfMatch": previous_etag} if previous_etag else {"IfNoneMatch": "*"}
    try:
        s3.put_object(**options, Key="place-details/latest.json", **condition)
    except ClientError as error:
        if error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") in (409, 412):
            raise SourceFailure("concurrent_snapshot_update") from None
        raise


def run(args):
    runtime = max(30, min(1800, int(os.environ.get("DATA_MAX_RUNTIME_SECONDS", "900"))))
    deadline = time.monotonic() + runtime
    signal.signal(signal.SIGTERM, abort_job)
    signal.signal(signal.SIGALRM, abort_job)
    # Cover initialization as well as HTTP/S3 and publication. JobDeadline
    # escapes all provider recovery paths and is handled safely only in main.
    signal.setitimer(signal.ITIMER_REAL, runtime + 30)
    region = os.environ.get("AWS_REGION", "ap-northeast-2")
    session = boto3.Session(region_name=region)
    if region != "ap-northeast-2" or session.client("sts").get_caller_identity()["Account"] != "061525506239":
        raise SourceFailure("unexpected_aws_target")
    if args.publish and args.bucket != "jeju-3d-data-061525506239-ap-northeast-2":
        raise SourceFailure("unexpected_output_bucket")
    s3 = session.client("s3", config=Config(connect_timeout=5, read_timeout=30, retries={"total_max_attempts": 2}))
    parameters = session.client("ssm").get_parameters(Names=list(KEY_PATHS.values()), WithDecryption=True)
    values = {item["Name"]: item["Value"] for item in parameters["Parameters"]}
    if any(path not in values for path in KEY_PATHS.values()):
        raise SourceFailure("missing_provider_credentials")
    keys = {name: values[path] for name, path in KEY_PATHS.items()}
    fetcher = Fetcher(keys, deadline)
    previous = read_previous(s3, args.bucket)
    records = dict(previous["records"])
    with tempfile.TemporaryDirectory(prefix="jeju-details-") as temp:
        catalog = args.catalog or Path(temp) / "catalog.sqlite"
        if args.catalog is None:
            s3.download_file(os.environ.get("CATALOG_BUCKET", "ohmyjeju-catalog-061525506239-prod"), "catalog/catalog.sqlite", str(catalog))
        connection = sqlite3.connect(f"file:{catalog.resolve()}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        places = [dict(row) for row in connection.execute("SELECT id,name,name_en,category,source,lat,lng,address FROM places")]
        connection.close()
        attempts = previous.get("last_attempt", {})
        if not isinstance(attempts, dict) or any(not isinstance(value, str) for value in attempts.values()):
            raise SourceFailure("invalid_last_attempt")
        canonical_ids = {place["id"] for place in places}
        last_attempt = {key: value for key, value in attempts.items() if key in canonical_ids}
        if args.curated_only:
            places = [place for place in places if place["source"] == "sample"]
        if args.place_id:
            requested = set(args.place_id)
            places = [place for place in places if place["id"] in requested]
            if {place["id"] for place in places} != requested:
                raise SourceFailure("unknown_place_id")
        if args.only_missing:
            places = [place for place in places if place["id"] not in records]
        places.sort(key=lambda p: refresh_order(p, records, last_attempt))
        lists, failures = collect_lists(fetcher)
        english_visit = {str(item.get("contentsid")): item for item in lists["visitjeju_en"] if item.get("contentsid")}
        fetched_at = iso_now()
        updated = attempted = 0
        budget = {"bytes": 0}
        for place in places:
            if time.monotonic() >= fetcher.deadline or attempted >= args.max_places:
                break
            last_attempt[place["id"]] = iso_now()
            attempted += 1
            new = []
            old = records.get(place["id"], [])
            for provider in ("tourapi", "visitjeju"):
                if not provider_complete_for(place, provider, failures):
                    continue
                matched = match_place(place, lists[provider], provider)
                if not matched:
                    continue
                raw = matched["record"]
                try:
                    if provider == "tourapi":
                        content = str(raw["contentid"])
                        common = tour_items(fetcher.tour("detailCommon2", contentId=content))
                        intro = tour_items(fetcher.tour("detailIntro2", contentId=content, contentTypeId=str(raw["contenttypeid"])))
                        info = tour_items(fetcher.tour("detailInfo2", contentId=content, contentTypeId=str(raw["contenttypeid"])))
                        images = tour_items(fetcher.tour("detailImage2", contentId=content, imageYN="Y"))
                        item = parse_tourapi(raw, common[0] if common else {}, intro[0] if intro else {}, info, images, locale="ko", fetched_at=fetched_at)
                    else:
                        item = parse_visitjeju(raw, locale="ko", fetched_at=fetched_at)
                    item["match"] = matched["match"]
                    mirror_photos(item, old, fetcher, s3, args.bucket, args.media_origin, budget, args.publish)
                    new.append(item)
                    if (provider == "visitjeju" and provider_complete_for(place, provider, failures, "en")
                            and str(raw.get("contentsid")) in english_visit):
                        english = parse_visitjeju(english_visit[str(raw["contentsid"])], locale="en", fetched_at=fetched_at)
                        english["match"] = {**matched["match"], "method": "same_provider_id"}
                        new.append(english)
                except (SourceFailure, KeyError, ValueError) as error:
                    failures.append({"provider": provider, "place_id": place["id"], "code": str(error) if isinstance(error, SourceFailure) else type(error).__name__})
            if new:
                fresh_pairs = {(item["provider"], item["locale"]) for item in new}
                records[place["id"]] = new + [item for item in old if (item.get("provider"), item.get("locale")) not in fresh_pairs]
                updated += 1
            if attempted % 20 == 0:
                emit("collection_progress", attempted_places=attempted, updated_places=updated, media_bytes=budget["bytes"])
        if not attempted or not records:
            raise SourceFailure("no_fresh_records")
        result = {"version": 1, "generated_at": iso_now(), "records": records, "last_attempt": last_attempt,
                  "coverage": {"places": len(records), "updated_places": updated, "attempted_places": attempted,
                               "photo_count": sum(len(item.get("photos", [])) for items in records.values() for item in items)},
                  "collection": {"partial": bool(failures) or attempted < len(places) or time.monotonic() >= fetcher.deadline,
                                 "metadata_only": updated == 0,
                                 "failures": failures[:100], "calls": dict(fetcher.calls)}}
        raw = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode()
        if len(raw) > MAX_SNAPSHOT_BYTES:
            raise SourceFailure("snapshot_too_large")
        if any(key.encode() in raw for key in keys.values()):
            raise SourceFailure("credential_in_output")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(raw)
        if args.publish:
            if not args.bucket:
                raise SourceFailure("missing_output_bucket")
            publish_snapshot(s3, args.bucket, raw, previous.get("_etag"))
        emit("collection_complete", published=args.publish, coverage=result["coverage"],
             partial=result["collection"]["partial"], calls=dict(fetcher.calls), media_bytes=budget["bytes"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--catalog", type=Path)
    parser.add_argument("--bucket", default=os.environ.get("DETAILS_BUCKET", ""))
    parser.add_argument("--media-origin", default=os.environ.get("PUBLIC_MEDIA_ORIGIN", "https://jeju-atlas.whchoi.net"))
    parser.add_argument("--output", type=Path, default=Path("/tmp/jeju-place-details.json"))
    parser.add_argument("--max-places", type=int, default=400, help="Maximum canonical places attempted, including unmatched or failed providers.")
    parser.add_argument("--curated-only", action="store_true")
    parser.add_argument("--only-missing", action="store_true", help="Backfill places without an official record; do not refetch recent pilot records.")
    parser.add_argument("--place-id", action="append", default=[])
    args = parser.parse_args()
    media = urlsplit(args.media_origin)
    if not 1 <= args.max_places <= 900 or media.scheme != "https" or not media.hostname or media.username or media.password or media.query or media.fragment or media.path not in ("", "/"):
        parser.error("Use 1..900 places and an HTTPS media origin")
    args.media_origin = args.media_origin.rstrip("/")
    try:
        run(args)
    except JobDeadline:
        emit("collection_failed", code="job_deadline")
        raise SystemExit(1) from None
    except Exception as error:
        emit("collection_failed", code=str(error) if isinstance(error, SourceFailure) else type(error).__name__)
        raise SystemExit(1) from None
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)


if __name__ == "__main__":
    main()
