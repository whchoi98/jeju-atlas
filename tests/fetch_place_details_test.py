from collections import Counter
from contextlib import redirect_stdout
import copy
import importlib.util
import io
import json
from pathlib import Path
import signal
import sqlite3
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "scripts"))
spec = importlib.util.spec_from_file_location("fetch_details", root / "scripts/fetch-place-details.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class Response:
    def __init__(self, data=b"", status=200):
        self.data = data
        self.status_code = status
    def __enter__(self): return self
    def __exit__(self, *_): return False
    def iter_content(self, size):
        for offset in range(0, len(self.data), size):
            yield self.data[offset:offset + size]


class Http:
    def __init__(self, response):
        self.response = response
        self.calls = []
    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.response


class ScriptedHttp:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.pages = []
    def get(self, _url, **kwargs):
        self.pages.append(kwargs["params"].get("page"))
        response = next(self.responses)
        if isinstance(response, BaseException):
            raise response
        return response if isinstance(response, Response) else Response(json.dumps(response).encode())


def visit_page(page, ids, total=3, pages=2):
    return {"result": "200", "currentPage": page, "pageCount": pages, "totalCount": total,
            "items": [{"contentsid": identity, "title": identity} for identity in ids]}


class CollectorTests(unittest.TestCase):
    def fetcher(self, response):
        fetcher = worker.Fetcher({"tourapi": "fixture-not-a-real-key", "visitjeju": "another-fixture-key"}, time.monotonic() + 30)
        fetcher.http = Http(response)
        return fetcher

    def test_provider_errors_never_echo_a_key_or_provider_body(self):
        fetcher = self.fetcher(Response(b"key=fixture-not-a-real-key", 403))
        with self.assertRaises(worker.SourceFailure) as error:
            fetcher.tour("detailCommon2", contentId="123")
        self.assertEqual(str(error.exception), "http_403")
        self.assertNotIn("fixture", str(error.exception))

    def test_provider_envelopes_are_checked_before_records_are_accepted(self):
        response = Response(json.dumps({"response": {"header": {"resultCode": "99"}, "body": {"items": []}}}).encode())
        with self.assertRaisesRegex(worker.SourceFailure, "provider_rejected"):
            self.fetcher(response).tour("detailCommon2", contentId="123")
        valid = Response(json.dumps({"response": {"header": {"resultCode": "0000"}, "body": {"totalCount": 0}}}).encode())
        self.assertEqual(self.fetcher(valid).tour("areaBasedList2")["totalCount"], 0)

    def test_transport_and_json_errors_have_distinct_safe_codes(self):
        from urllib3.exceptions import ReadTimeoutError
        cases = [
            (worker.requests.ConnectTimeout("never-log-this"), "connect_timeout"),
            (worker.requests.ReadTimeout("never-log-this"), "read_timeout"),
            (worker.requests.ConnectionError(ReadTimeoutError(None, "never-log-this", "timeout")), "read_timeout"),
            (worker.requests.ConnectionError("never-log-this"), "connection_error"),
            (worker.requests.RequestException("never-log-this"), "transport_error"),
            (Response(b'{"never-log-this":'), "invalid_json"),
            (Response(b"\xff"), "invalid_json"),
        ]
        for response, code in cases:
            with self.subTest(code=code):
                fetcher = self.fetcher(Response())
                fetcher.http = ScriptedHttp([response])
                with self.assertRaises(worker.SourceFailure) as error:
                    fetcher.get_json("visitjeju", "searchList", {})
                self.assertEqual(str(error.exception), code)
                self.assertTrue(error.exception.__suppress_context__)

    def test_identical_boundary_duplicates_require_complete_pages_and_unique_total(self):
        for first in (["a", "b"], ["a", "a", "b"]):
            fetcher = self.fetcher(Response())
            fetcher.http = ScriptedHttp([visit_page(1, first), visit_page(2, ["b", "c"])])
            with patch.object(worker.time, "sleep"):
                rows = worker._category_list(fetcher, "visitjeju", "c4", "kr")
            self.assertEqual([row["contentsid"] for row in rows], ["a", "b", "c"])
            self.assertEqual(fetcher.http.pages, [1, 2])
        cases = [
            ([visit_page(1, ["a", "b"]), visit_page(2, ["b"])], "listing_no_progress"),
            ([visit_page(1, ["a", "b"], total=4), visit_page(2, ["b", "c"], total=4)], "inconsistent_listing_count"),
            ([visit_page(1, ["a", "b"], pages=3), visit_page(2, ["c"], pages=3), Response(status=503)], "http_503"),
            ([visit_page(1, ["a", "b"]), visit_page(1, ["b", "c"])], "unexpected_listing_page"),
            ([{k: v for k, v in visit_page(1, ["a", "b"]).items() if k != "totalCount"},
              {k: v for k, v in visit_page(2, ["b", "c"]).items() if k != "totalCount"}], "unverified_duplicate_listing"),
        ]
        for responses, code in cases:
            with self.subTest(code=code):
                fetcher = self.fetcher(Response())
                fetcher.http = ScriptedHttp(responses)
                with patch.object(worker.time, "sleep"), self.assertRaises(worker.SourceFailure) as error:
                    worker._category_list(fetcher, "visitjeju", "c4", "kr")
                self.assertEqual(str(error.exception), code)

    def test_category_retry_restarts_page_one_and_never_merges_failed_rows(self):
        for failed_second in (
            worker.requests.ReadTimeout("never-log-this"), Response(b"{invalid"),
            visit_page(2, ["b"]), visit_page(2, ["b", "c"], total=4),
        ):
            fetcher = self.fetcher(Response())
            fetcher.http = ScriptedHttp([
                visit_page(1, ["a", "b"]), failed_second,
                visit_page(1, ["x", "y"]), visit_page(2, ["y", "z"]),
            ])
            output = io.StringIO()
            with patch.object(worker.time, "sleep"), redirect_stdout(output):
                rows = worker._category_with_retry(fetcher, "visitjeju", "c4", "kr")
            self.assertEqual([row["contentsid"] for row in rows], ["x", "y", "z"])
            self.assertEqual(fetcher.http.pages, [1, 2, 1, 2])
            self.assertEqual(fetcher.calls["visitjeju:searchList"], 4)
            events = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["event"], "category_retry")
            self.assertEqual(events[0]["attempt"], 2)
            self.assertEqual(set(events[0]), {"event", "provider", "locale", "category", "attempt", "code"})
            self.assertNotIn("never-log-this", output.getvalue())

    def test_category_retry_is_once_and_never_retries_permanent_errors(self):
        for response, code, count in [
            (Response(status=503), "http_503", 2),
            (Response(status=403), "http_403", 1),
            ({"result": "403"}, "provider_rejected", 1),
        ]:
            fetcher = self.fetcher(Response())
            fetcher.http = ScriptedHttp([response, response])
            with patch.object(worker.time, "sleep"), redirect_stdout(io.StringIO()), self.assertRaises(worker.SourceFailure) as error:
                worker._category_with_retry(fetcher, "visitjeju", "c4", "kr")
            self.assertEqual(str(error.exception), code)
            self.assertEqual(fetcher.http.pages, [1] * count)
            self.assertEqual(fetcher.calls["visitjeju:searchList"], count)

    def test_category_retry_preserves_call_budget_and_checks_deadline_before_and_after_backoff(self):
        fetcher = self.fetcher(Response())
        fetcher.calls["visitjeju:searchList"] = 849
        fetcher.http = ScriptedHttp([worker.requests.ReadTimeout()])
        with patch.object(worker.time, "sleep") as sleep, redirect_stdout(io.StringIO()), self.assertRaises(worker.SourceFailure):
            worker._category_with_retry(fetcher, "visitjeju", "c4", "kr")
        self.assertEqual(fetcher.calls["visitjeju:searchList"], 850)
        self.assertEqual(fetcher.http.pages, [1])
        sleep.assert_not_called()
        for deadline, expires_during_wait in [(100.5, False), (110, True)]:
            fetcher = self.fetcher(Response())
            fetcher.deadline = deadline
            fetcher.http = ScriptedHttp([worker.requests.ReadTimeout()])
            now = [100.0]
            def sleep(_):
                now[0] = deadline
            with patch.object(worker.time, "monotonic", side_effect=lambda: now[0]), \
                 patch.object(worker.time, "sleep", side_effect=sleep) as wait, \
                 redirect_stdout(io.StringIO()), self.assertRaises(worker.SourceFailure):
                worker._category_with_retry(fetcher, "visitjeju", "c4", "kr")
            self.assertEqual(fetcher.http.pages, [1])
            self.assertEqual(wait.call_count, int(expires_during_wait))
        fetcher = self.fetcher(Response())
        fetcher.http = ScriptedHttp([worker.requests.ReadTimeout()])
        with patch.object(worker.time, "sleep", side_effect=worker.JobDeadline()), \
             redirect_stdout(io.StringIO()), self.assertRaises(worker.JobDeadline):
            worker._category_with_retry(fetcher, "visitjeju", "c4", "kr")
        self.assertEqual(fetcher.http.pages, [1])

    def test_budget_and_deadline_stop_before_a_network_request(self):
        fetcher = self.fetcher(Response())
        fetcher.calls["tourapi:detailCommon2"] = 850
        with self.assertRaisesRegex(worker.SourceFailure, "operation_budget"):
            fetcher.tour("detailCommon2")
        fetcher.deadline = 0
        with self.assertRaisesRegex(worker.SourceFailure, "deadline"):
            fetcher.tour("detailImage2")
        self.assertEqual(fetcher.http.calls, [])

    def test_media_cannot_fetch_credentials_or_arbitrary_internal_destinations(self):
        self.assertEqual(worker.media_url("http://tong.visitkorea.or.kr/cms/a.jpg"), "https://tong.visitkorea.or.kr/cms/a.jpg")
        for value in (
            "https://127.0.0.1/a.jpg", "http://169.254.169.254/latest/meta-data/",
            "https://user:password@tong.visitkorea.or.kr/a.jpg",
            "https://tong.visitkorea.or.kr/a.jpg?serviceKey=private",
            "https://tong.visitkorea.or.kr:8443/a.jpg",
        ):
            with self.subTest(value=value):
                self.assertIsNone(worker.media_url(value))

    def test_no_derivative_media_is_copied_byte_for_byte_with_an_immutable_hash_key(self):
        image = b"\xff\xd8\xff" + b"original-image-bytes"
        fetcher = self.fetcher(Response(image))
        writes = []
        class S3:
            def put_object(self, **kwargs): writes.append(kwargs)
        record = {"photos": [{"origin_url": "https://tong.visitkorea.or.kr/a.jpg", "license": "KOGL-3", "credit": "한국관광공사", "thumb_url": "https://wrong.test/crop.jpg"}]}
        worker.mirror_photos(record, [], fetcher, S3(), "fixture-bucket", "https://atlas.example.test", {"bytes": 0}, True)
        self.assertEqual(writes[0]["Body"], image)
        self.assertTrue(writes[0]["Key"].startswith("media/"))
        self.assertIn("immutable", writes[0]["CacheControl"])
        self.assertIsNone(record["photos"][0]["thumb_url"])
        self.assertTrue(record["photos"][0]["url"].startswith("https://atlas.example.test/media/"))

    def test_noncommercial_photos_never_trigger_a_download(self):
        fetcher = self.fetcher(Response())
        record = {"photos": [{"origin_url": "https://tong.visitkorea.or.kr/a.jpg", "license": "KOGL-4", "credit": "KTO"}]}
        worker.mirror_photos(record, [], fetcher, None, "", "https://atlas.example.test", {"bytes": 0}, False)
        self.assertEqual(record["photos"], [])
        self.assertEqual(fetcher.http.calls, [])

    def test_failed_category_pages_are_discarded_without_discarding_other_categories(self):
        class Lists:
            deadline = float("inf")
            calls = Counter()
            def tour(self, operation, **params):
                category, page = params["contentTypeId"], params["pageNo"]
                if category == "12":
                    if page == 2:
                        raise worker.SourceFailure("http_503")
                    return {"items": {"item": [{"contentid": str(i), "contenttypeid": "12"} for i in range(100)]}, "totalCount": 101}
                if category == "39":
                    return {"items": {"item": [{"contentid": "999", "contenttypeid": "39"}]}, "totalCount": 1}
                return {"items": {}, "totalCount": 0}
            def get_json(self, provider, operation, params):
                if params["locale"] == "kr" and params["category"] == "c1":
                    if params["page"] == 2:
                        raise worker.SourceFailure("http_503")
                    return {"items": [{"contentsid": "partial"}], "pageCount": 2}
                if params["locale"] == "kr" and params["category"] == "c4":
                    return {"items": [{"contentsid": "complete"}], "pageCount": 1}
                return {"items": [], "pageCount": 0}
        with patch.object(worker.time, "sleep"), redirect_stdout(io.StringIO()):
            rows, failures = worker.collect_lists(Lists())
        self.assertEqual([row["contentid"] for row in rows["tourapi"]], ["999"])
        self.assertEqual([row["contentsid"] for row in rows["visitjeju"]], ["complete"])
        self.assertEqual(len(failures), 2)
        self.assertFalse(worker.provider_complete_for({"category": "관광지"}, "tourapi", failures))
        self.assertTrue(worker.provider_complete_for({"category": "맛집"}, "tourapi", failures))
        self.assertFalse(worker.provider_complete_for({"category": "관광지"}, "visitjeju", failures))

    def test_collect_lists_uses_successful_category_retry(self):
        class Lists:
            deadline = float("inf")
            calls = Counter()
            attempts = 0
            def tour(self, *_args, **_kwargs):
                return {"items": {}, "totalCount": 0}
            def get_json(self, provider, operation, params):
                if params["locale"] == "kr" and params["category"] == "c4":
                    self.attempts += 1
                    if self.attempts == 1:
                        raise worker.SourceFailure("read_timeout")
                    return visit_page(1, ["complete"], total=1, pages=1)
                return {"items": [], "pageCount": 0}
        fetcher = Lists()
        with patch.object(worker.time, "sleep"), redirect_stdout(io.StringIO()):
            lists, failures = worker.collect_lists(fetcher)
        self.assertEqual([row["contentsid"] for row in lists["visitjeju"]], ["complete"])
        self.assertEqual(fetcher.attempts, 2)
        self.assertEqual(failures, [])

    def test_incomplete_or_conflicting_pagination_cannot_produce_a_unique_match(self):
        candidate = {"contentid": "1", "contenttypeid": "12", "title": "비자림", "mapy": "33.45", "mapx": "126.5"}
        class Lists:
            deadline = float("inf")
            calls = Counter()
            def __init__(self, scenario): self.scenario = scenario
            def tour(self, operation, **params):
                if params["contentTypeId"] != "12":
                    return {"items": {}, "totalCount": 0}
                if self.scenario == "empty_before_total":
                    return {"items": {"item": [candidate] if params["pageNo"] == 1 else []}, "totalCount": 2}
                if self.scenario == "conflicting_id":
                    return {"items": {"item": [candidate, dict(candidate, mapx="126.501")]}, "totalCount": 2}
                return {"items": {"item": [dict(candidate, contentid=str(params["pageNo"]))]}, "totalCount": 101}
            def get_json(self, *_): return {"items": [], "pageCount": 0}
        for scenario in ("empty_before_total", "conflicting_id", "page_limit"):
            with self.subTest(scenario=scenario), patch.object(worker.time, "sleep"), redirect_stdout(io.StringIO()):
                rows, failures = worker.collect_lists(Lists(scenario))
                self.assertEqual(rows["tourapi"], [])
                self.assertTrue(failures)

    def test_completed_lists_preserve_distinct_ambiguous_ids_and_reject_conflicting_english_duplicates(self):
        first = {"contentid": "1", "contenttypeid": "12", "title": "비자림", "mapy": "33.45", "mapx": "126.5"}
        class Lists:
            def tour(self, operation, **params):
                rows = [first, dict(first, contentid="2")] if params["contentTypeId"] == "12" else []
                return {"items": {"item": rows}, "totalCount": len(rows)}
            def get_json(self, provider, operation, params):
                rows = [{"contentsid": "same", "title": "First"}, {"contentsid": "same", "title": "Different"}] if params["locale"] == "en" and params["category"] == "c1" else []
                return {"items": rows, "pageCount": 1 if rows else 0}
        with redirect_stdout(io.StringIO()):
            rows, failures = worker.collect_lists(Lists())
        canonical = {"id": "poi_test", "name": "비자림", "name_en": None, "category": "관광지", "source": "sample", "lat": 33.45, "lng": 126.5}
        self.assertIsNone(worker.match_place(canonical, rows["tourapi"], "tourapi"))
        self.assertEqual(len(rows["tourapi"]), 2)
        self.assertEqual(rows["visitjeju_en"], [])
        self.assertTrue(any(item.get("locale") == "en" for item in failures))

    def test_absolute_deadline_escapes_lists_http_and_media(self):
        self.assertTrue(hasattr(worker, "JobDeadline"))
        self.assertFalse(issubclass(worker.JobDeadline, Exception))
        class InterruptedResponse(Response):
            def iter_content(self, _):
                raise worker.JobDeadline()
                yield b""
        fetcher = self.fetcher(InterruptedResponse())
        with self.assertRaises(worker.JobDeadline):
            fetcher.tour("detailCommon2")
        class InterruptedLists:
            def tour(self, *_args, **_kwargs): raise worker.JobDeadline()
        with self.assertRaises(worker.JobDeadline):
            worker.collect_lists(InterruptedLists())
        record = {"photos": [{"origin_url": "https://tong.visitkorea.or.kr/a.jpg", "license": "KOGL-3", "credit": "KTO"}]}
        with self.assertRaises(worker.JobDeadline):
            worker.mirror_photos(record, [], fetcher, None, "", "https://atlas.example.test", {"bytes": 0}, False)

    def test_real_alarm_is_not_swallowed_and_cli_reports_only_safe_deadline_code(self):
        self.assertTrue(hasattr(worker, "JobDeadline"))
        class SlowResponse(Response):
            def iter_content(self, _):
                time.sleep(0.2)
                yield b"\xff\xd8\xff"
        fetcher = self.fetcher(SlowResponse())
        record = {"photos": [{"origin_url": "https://tong.visitkorea.or.kr/a.jpg", "license": "KOGL-3", "credit": "KTO"}]}
        previous = signal.signal(signal.SIGALRM, worker.abort_job)
        try:
            signal.setitimer(signal.ITIMER_REAL, 0.01)
            with self.assertRaises(worker.JobDeadline):
                worker.mirror_photos(record, [], fetcher, None, "", "https://atlas.example.test", {"bytes": 0}, False)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous)
        output = io.StringIO()
        with patch.object(worker, "run", side_effect=worker.JobDeadline("never-print-this")), patch.object(sys, "argv", ["collector"]), redirect_stdout(output):
            with self.assertRaises(SystemExit) as error:
                worker.main()
        self.assertEqual(error.exception.code, 1)
        self.assertEqual(json.loads(output.getvalue()), {"event": "collection_failed", "code": "job_deadline"})

    def test_existing_authorized_mirror_survives_a_broken_origin_and_duplicate_old_rows(self):
        origin = "https://tong.visitkorea.or.kr/a.jpg"
        cached = "https://atlas.example.test/media/" + "a" * 64 + ".jpg"
        old = [
            {"photos": [{"origin_url": origin.replace("https:", "http:"), "url": cached, "license": "KOGL-3", "credit": "KTO"}]},
            {"photos": [{"origin_url": origin, "url": cached, "license": "KOGL-1", "credit": "KTO"}]},
        ]
        before = copy.deepcopy(old)
        record = {"photos": [{"origin_url": origin, "license": "KOGL-3", "credit": "current credit", "thumb_url": origin}]}
        fetcher = self.fetcher(Response(status=503))
        worker.mirror_photos(record, old, fetcher, None, "", "https://atlas.example.test", {"bytes": 0}, False)
        self.assertEqual([photo["url"] for photo in record["photos"]], [cached])
        self.assertEqual(record["photos"][0]["credit"], "current credit")
        self.assertIsNone(record["photos"][0]["thumb_url"])
        self.assertEqual(fetcher.http.calls, [], "A valid authorized cached image needs no new download")
        self.assertEqual(old, before)
        for license_ in ("KOGL-4", None):
            record = {"photos": [{"origin_url": origin, "license": license_, "credit": "KTO"}]}
            worker.mirror_photos(record, old, fetcher, None, "", "https://atlas.example.test", {"bytes": 0}, False)
            self.assertEqual(record["photos"], [])
        record = {"photos": [{"origin_url": origin + "-different", "license": "KOGL-3", "credit": "KTO"}]}
        worker.mirror_photos(record, old, fetcher, None, "", "https://atlas.example.test", {"bytes": 0}, False)
        self.assertEqual(record["photos"], [])

    def test_refresh_rotation_reaches_missing_and_old_records_before_recent_records(self):
        places = [{"id": value, "source": "sample" if value == "recent" else "osm"}
                  for value in ("recent", "missing", "old")]
        records = {"recent": [{"fetched_at": "2026-09-10T00:00:00+00:00"}],
                   "old": [{"fetched_at": "2026-09-01T00:00:00+00:00"}]}
        ordered = sorted(places, key=lambda place: worker.refresh_order(place, records))
        self.assertEqual([place["id"] for place in ordered], ["missing", "old", "recent"])

    def test_attempt_rotation_does_not_repeat_a_place_with_a_retained_failed_provider(self):
        places = [{"id": name, "source": "sample"} for name in ("repeat", "waiting", "missing-retry")]
        records = {
            "repeat": [{"fetched_at": "2026-08-01T00:00:00+00:00"}, {"fetched_at": "2026-09-10T00:00:00+00:00"}],
            "waiting": [{"fetched_at": "2026-08-02T00:00:00+00:00"}],
        }
        attempts = {"repeat": "2026-09-10T00:00:00+00:00", "missing-retry": "2026-09-10T00:00:00+00:00"}
        ordered = sorted(places, key=lambda place: worker.refresh_order(place, records, attempts))
        self.assertEqual(ordered[0]["id"], "waiting")

    def test_run_persists_failed_attempt_rotation_without_claiming_fresh_source_data(self):
        previous = {"version": 1, "generated_at": "2026-09-01T00:00:00+00:00", "records": {
            name: [{"provider": "tourapi", "locale": "ko", "provider_id": str(index), "fetched_at": "2026-09-01T00:00:00+00:00", "photos": []}]
            for index, name in enumerate(("a", "b"), 1)
        }}
        class S3:
            snapshot = previous
            def get_object(self, **_):
                return {"Body": io.BytesIO(json.dumps(self.snapshot).encode()), "ETag": '"previous"'}
        s3 = S3()
        class Session:
            def client(self, service, **_):
                if service == "s3": return s3
                if service == "sts": return SimpleNamespace(get_caller_identity=lambda: {"Account": "061525506239"})
                if service == "ssm": return SimpleNamespace(get_parameters=lambda **_: {
                    "Parameters": [{"Name": name, "Value": "fixture-secret-" + str(index)} for index, name in enumerate(worker.KEY_PATHS.values())]
                })
                raise AssertionError(service)
        with tempfile.TemporaryDirectory(prefix="collector-regression-") as folder:
            path = Path(folder)
            catalog = path / "catalog.sqlite"
            with sqlite3.connect(catalog) as db:
                db.execute("CREATE TABLE places (id TEXT,name TEXT,name_en TEXT,category TEXT,source TEXT,lat REAL,lng REAL,address TEXT)")
                db.executemany("INSERT INTO places VALUES (?,?,NULL,'관광지','sample',33.45,126.5,NULL)", [(name, name) for name in ("a", "b")])
            args = SimpleNamespace(catalog=catalog, bucket="fixture", publish=False, media_origin="https://atlas.example.test",
                                   curated_only=False, only_missing=False, place_id=[], max_places=1, output=path / "output.json")
            empty = {"tourapi": [], "visitjeju": [], "visitjeju_en": []}
            with patch.object(worker.boto3, "Session", return_value=Session()), \
                 patch.object(worker, "collect_lists", return_value=(empty, [])), \
                 patch.object(worker.signal, "signal"), patch.object(worker.signal, "setitimer"), \
                 patch.dict(worker.os.environ, {"AWS_REGION": "ap-northeast-2"}), redirect_stdout(io.StringIO()):
                start = worker.iso_now()
                worker.run(args)
                first = json.loads(args.output.read_text())
                self.assertEqual(set(first["last_attempt"]), {"a"})
                self.assertGreaterEqual(first["last_attempt"]["a"], start)
                self.assertLessEqual(first["last_attempt"]["a"], worker.iso_now())
                self.assertEqual(first["records"], previous["records"])
                self.assertEqual(first["coverage"]["updated_places"], 0)
                self.assertEqual(first["coverage"]["attempted_places"], 1)
                s3.snapshot = first
                worker.run(args)
                second = json.loads(args.output.read_text())
                self.assertEqual(set(second["last_attempt"]), {"a", "b"})
                self.assertEqual(second["records"], previous["records"])
                self.assertNotIn("fixture-secret", json.dumps(second))

    def test_publishing_cannot_overwrite_a_concurrent_collection(self):
        writes = []
        class S3:
            def put_object(self, **kwargs): writes.append(kwargs)
        worker.publish_snapshot(S3(), "owned-bucket", b"snapshot", '"previous-etag"')
        self.assertNotIn("IfMatch", writes[0])
        self.assertEqual(writes[1]["Key"], "place-details/latest.json")
        self.assertEqual(writes[1]["IfMatch"], '"previous-etag"')
        writes.clear()
        worker.publish_snapshot(S3(), "owned-bucket", b"snapshot", None)
        self.assertEqual(writes[1]["IfNoneMatch"], "*")


if __name__ == "__main__":
    unittest.main()
