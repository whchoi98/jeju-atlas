"""Offline bootstrap contracts; use disposable files, never the source catalog."""
from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "workshop/scripts/catalog_seed.py"
SEEDS = ROOT / "agent/tools/data/jeju_pois.json"


def overpass(elements):
    # These are synthetic test objects, not a captured or verified live inventory.
    return {
        "version": 0.6, "generator": "Overpass API test fixture",
        "osm3s": {
            "timestamp_osm_base": "2026-09-01T00:00:00Z",
            "copyright": "OpenStreetMap contributors, ODbL",
        },
        "elements": elements,
    }


def osm_node(identifier, **overrides):
    element = {
        "type": "node", "id": identifier, "lat": 33.45, "lon": 126.5,
        "tags": {"name": "Fixture Cafe", "amenity": "cafe"},
    }
    element.update(overrides)
    return element


class Response(io.BytesIO):
    def __init__(self, raw, headers=None):
        super().__init__(raw)
        self.headers = headers or {}


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CatalogSeedTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="atlas-bootstrap-test-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name).resolve()
        self.output = self.directory / "lab/data/catalog.sqlite"

    def run_cli(self, *arguments, output=None, script=SCRIPT, success=True):
        self.assertTrue(script.is_file(), "the standalone bootstrap helper must exist")
        result = subprocess.run(
            [sys.executable, "-B", str(script), "--output", str(output or self.output),
             *map(str, arguments)],
            cwd=self.directory,
            env={
                "PATH": os.defpath,
                "PYTHONDONTWRITEBYTECODE": "1",
                "AWS_EC2_METADATA_DISABLED": "true",
                "AWS_CONFIG_FILE": os.devnull,
                "AWS_SHARED_CREDENTIALS_FILE": os.devnull,
            },
            capture_output=True, text=True, timeout=30,
        )
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stderr, "")
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "", "failed builds must not print a success summary")
        return result

    def connect(self, path=None):
        db = sqlite3.connect((path or self.output).as_uri() + "?mode=ro", uri=True)
        self.addCleanup(db.close)
        return db

    def fixture(self, value):
        path = self.directory / "overpass.json"
        path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
        return path

    def helper(self):
        return load_module("workshop_catalog_seed_test", SCRIPT)

    def test_offline_cli_preserves_all_sample_ids_and_reports_only_aggregates(self):
        report = self.run_cli()
        data = json.loads(SEEDS.read_text(encoding="utf-8"))
        db = self.connect()
        self.assertEqual(db.execute("PRAGMA quick_check").fetchall(), [("ok",)])
        self.assertEqual(db.execute("SELECT count(*), count(DISTINCT id) FROM places").fetchone(),
                         (137, 137))
        self.assertEqual({row[0] for row in db.execute("SELECT id FROM places")},
                         {row["id"] for row in data})
        self.assertEqual(db.execute("SELECT source, count(*) FROM places GROUP BY source").fetchall(),
                         [("sample", 137)])
        self.assertEqual(db.execute(
            "SELECT count(*) FROM places WHERE lat BETWEEN 33.1 AND 33.6 "
            "AND lng BETWEEN 126.15 AND 126.98"
        ).fetchone()[0], 137)
        self.assertEqual(report["count"], 137)
        self.assertEqual(report["by_source"], {"sample": 137})
        self.assertEqual(report["path"], str(self.output))
        self.assertEqual(report["sha256"], hashlib.sha256(self.output.read_bytes()).hexdigest())
        self.assertEqual(sum(report["by_category"].values()), 137)
        self.assertNotIn("poi_0008", json.dumps(report))
        self.assertNotIn("성산일출봉", json.dumps(report, ensure_ascii=False))
        self.assertEqual(list(self.output.parent.iterdir()), [self.output])

    def test_schema_indexes_and_search_match_the_actual_python_reader(self):
        self.run_cli()
        catalog = load_module("bootstrap_reader_contract", ROOT / "agent/tools/catalog.py")
        expected = sqlite3.connect(":memory:")
        self.addCleanup(expected.close)
        expected.executescript(catalog.DDL)
        db = self.connect()
        for table in ("places", "place_extra", "meta", "places_fts"):
            with self.subTest(table=table):
                self.assertEqual(db.execute(f"PRAGMA table_info({table})").fetchall(),
                                 expected.execute(f"PRAGMA table_info({table})").fetchall())
        for index in ("idx_places_lat_lng", "idx_places_category"):
            self.assertEqual(db.execute(f"PRAGMA index_info({index})").fetchall(),
                             expected.execute(f"PRAGMA index_info({index})").fetchall())
        self.assertIn(("poi_0008",), db.execute(
            "SELECT p.id FROM places_fts JOIN places p ON p.rid=places_fts.rowid "
            "WHERE places_fts MATCH ?", ('"일출봉"',)
        ).fetchall())
        store = catalog.Catalog(self.output)
        self.addCleanup(store.close)
        for query in ("일출", "일출봉", "성산일출봉"):
            self.assertIn("poi_0008", {row["id"] for row in store.search(query)})
        point = store.get("poi_0008")
        self.assertIn("poi_0008", {
            row["id"] for row in store.nearby(point["lat"], point["lng"], radius_m=100)
        })
        self.assertEqual(store.extra("poi_0008")["facilities"], {})
        self.assertEqual(store.stats()["extra_tables"], ["place_extra"])
        self.assertEqual(store.stats()["count"], 137)
        self.assertEqual(store.stats()["schema_version"], 2)

    def test_samples_have_no_manufactured_enrichment_or_observation_dates(self):
        self.run_cli()
        db = self.connect()
        meta = dict(db.execute("SELECT key,value FROM meta"))
        self.assertEqual(meta["schema_version"], "2")
        self.assertEqual(meta["count"], "137")
        self.assertIn("미검증", meta["attribution"])
        self.assertNotIn("OpenStreetMap", meta["attribution"])
        self.assertEqual(meta["photos_count"], "0")
        self.assertEqual(meta["hours_week_count"], "0")
        self.assertEqual(meta["match_precision_sample"], "null")
        self.assertEqual(db.execute(
            "SELECT count(*) FROM places WHERE url IS NULL AND phone IS NULL AND hours IS NULL "
            "AND summary LIKE '%미검증%'"
        ).fetchone()[0], 137)
        extras = db.execute(
            "SELECT photos, hours_week, hours_source, facilities, overview, menu, "
            "business_status, tips, sources, fetched_at FROM place_extra"
        ).fetchall()
        self.assertEqual(len(extras), 137)
        for photos, hours, hours_source, facilities, overview, menu, status, tips, sources, fetched in extras:
            self.assertEqual(json.loads(photos), [])
            self.assertIsNone(hours)
            self.assertIsNone(hours_source)
            self.assertEqual(json.loads(facilities), {})
            self.assertIsNone(overview)
            self.assertEqual(json.loads(menu), [])
            self.assertIsNone(status)
            self.assertIsNone(tips)
            self.assertIsNone(fetched)
            provenance = json.loads(sources)
            self.assertEqual(len(provenance), 1)
            self.assertEqual(provenance[0]["source"], "curated")
            self.assertIsNone(provenance[0]["url"])
            self.assertIsNone(provenance[0]["observed_at"])
            self.assertIn("미검증", provenance[0]["note"])

    def test_minimal_fresh_checkout_and_offline_build_need_only_script_and_seeds(self):
        checkout = self.directory / "fresh"
        script = checkout / "workshop/scripts/catalog_seed.py"
        seeds = checkout / "agent/tools/data/jeju_pois.json"
        script.parent.mkdir(parents=True)
        seeds.parent.mkdir(parents=True)
        self.assertTrue(SCRIPT.is_file(), "the standalone bootstrap helper must exist")
        shutil.copyfile(SCRIPT, script)
        shutil.copyfile(SEEDS, seeds)
        module = load_module("bootstrap_offline_contract", script)
        with patch("socket.socket.connect", side_effect=AssertionError("offline must not connect")):
            result = module.build_catalog(self.output)
        self.assertEqual(result["by_source"], {"sample": 137})
        self.run_cli(script=script, output=self.directory / "second.sqlite")

    def test_existing_files_directories_and_catalogs_are_never_overwritten(self):
        self.run_cli()
        before = self.output.read_bytes()
        self.run_cli(success=False)
        self.assertEqual(self.output.read_bytes(), before)
        unrelated = self.directory / "unrelated.sqlite"
        unrelated.write_bytes(b"unrelated source")
        self.run_cli(output=unrelated, success=False)
        self.assertEqual(unrelated.read_bytes(), b"unrelated source")
        directory = self.directory / "directory.sqlite"
        directory.mkdir()
        self.run_cli(output=directory, success=False)
        self.assertEqual(list(directory.iterdir()), [])
        self.assertEqual(list(self.output.parent.iterdir()), [self.output])

    def test_symlinks_and_parent_traversal_never_redirect_output(self):
        target = self.directory / "protected"
        target.mkdir()
        link = self.directory / "link"
        link.symlink_to(target, target_is_directory=True)
        self.run_cli(output=link / "catalog.sqlite", success=False)
        self.run_cli(output=link / "missing/catalog.sqlite", success=False)
        dangling = self.directory / "dangling.sqlite"
        dangling.symlink_to(target / "catalog.sqlite")
        self.run_cli(output=dangling, success=False)
        self.run_cli(output=link / "../escaped.sqlite", success=False)
        self.assertEqual(list(target.iterdir()), [])
        self.assertTrue(dangling.is_symlink())
        self.assertFalse((self.directory / "escaped.sqlite").exists())

    def test_osm_fixture_keeps_source_namespaces_and_only_unambiguous_in_bounds_objects(self):
        seed = next(row for row in json.loads(SEEDS.read_text(encoding="utf-8"))
                    if row["id"] == "poi_0008")
        fixture = self.fixture(overpass([
            osm_node(100, tags={
                "name": "Fixture Cafe", "name:ko": "검증용 카페", "name:en": "Fixture Cafe",
                "amenity": "cafe", "phone": "064-000-0000",
                "opening_hours": "Mo-Fr 09:00-18:00", "wheelchair": "yes",
                "website": "javascript:private-response-sentinel",
            }),
            osm_node(100),
            {"type": "way", "id": 100, "center": {"lat": 33.4, "lon": 126.4},
             "tags": {"name": "Fixture Museum", "tourism": "museum"}},
            {"type": "relation", "id": 100, "center": {"lat": 33.1, "lon": 126.15},
             "tags": {"name": "Fixture Beach", "natural": "beach"}},
            osm_node(101, tags={"name": "Fixture Gallery", "tourism": "gallery"}),
            osm_node(102, lat=seed["lat"], lon=seed["lng"], tags={
                "name": seed["name"], "tourism": "attraction", "phone": "064-000-0001",
            }),
            osm_node(103, lat=33.60001), osm_node(104, lon=126.14999),
            osm_node(105, tags={"amenity": "cafe"}),
            osm_node(106, tags={"name": "Unnamed Peak", "natural": "peak"}),
            osm_node(107, tags={"name": "Former Cafe", "amenity": "cafe", "disused:amenity": "cafe"}),
            osm_node(108, tags={"name": "Ambiguous", "amenity": "cafe", "tourism": "museum"}),
            osm_node(True), osm_node(109, lat=True),
            osm_node(110, tags={"name": "Malformed", "amenity": ["cafe"]}),
        ]))
        before_seed = hashlib.sha256(SEEDS.read_bytes()).hexdigest()
        report = self.run_cli("--osm", "--osm-file", fixture)
        db = self.connect()
        self.assertEqual(report["by_source"], {"sample": 137, "OpenStreetMap": 5})
        self.assertEqual(report["count"], 142)
        self.assertEqual(report["dropped"]["duplicate_id"], 1)
        self.assertEqual(report["dropped"]["out_of_bbox"], 2)
        self.assertEqual(dict(db.execute(
            "SELECT id, category FROM places WHERE source='OpenStreetMap'"
        )), {
            "osm:node/100": "카페", "osm:way/100": "박물관", "osm:relation/100": "해변",
            "osm:node/101": "문화시설", "osm:node/102": "관광지",
        })
        self.assertEqual(db.execute(
            "SELECT phone FROM places WHERE id='poi_0008'"
        ).fetchone(), (None,), "OSM must not backfill a sample's unverified base fields")
        self.assertEqual(db.execute(
            "SELECT url,phone,hours FROM places WHERE id='osm:node/100'"
        ).fetchone(), ("https://www.openstreetmap.org/node/100", "064-000-0000", "Mo-Fr 09:00-18:00"))
        self.assertEqual(db.execute(
            "SELECT count(*) FROM place_extra WHERE facilities='{}' AND photos='[]' "
            "AND hours_week IS NULL AND hours_source IS NULL"
        ).fetchone()[0], 142)
        provenance = json.loads(db.execute(
            "SELECT sources FROM place_extra WHERE id='osm:node/100'"
        ).fetchone()[0])[0]
        self.assertEqual(provenance["source"], "osm")
        self.assertEqual(provenance["license"], "ODbL")
        self.assertEqual(provenance["url"], "https://www.openstreetmap.org/node/100")
        self.assertIsNone(provenance["observed_at"])
        self.assertIn("파일", provenance["note"])
        meta = dict(db.execute("SELECT key,value FROM meta"))
        osm = json.loads(meta["osm_provenance"])
        self.assertEqual(osm["input"], "file")
        self.assertIsNone(osm["retrieved_at"])
        self.assertEqual(osm["snapshot_at"], "2026-09-01T00:00:00Z")
        self.assertEqual(osm["sha256"], hashlib.sha256(fixture.read_bytes()).hexdigest())
        self.assertIn("https://www.openstreetmap.org/copyright", meta["attribution"])
        self.assertIn("https://opendatacommons.org/licenses/odbl/1-0/", meta["attribution"])
        self.assertNotIn("private-response-sentinel", "\n".join(db.iterdump()))
        self.assertEqual(hashlib.sha256(SEEDS.read_bytes()).hexdigest(), before_seed)

    def test_osm_file_requires_explicit_osm_and_empty_import_still_keeps_samples(self):
        fixture = self.fixture(overpass([]))
        result = self.run_cli("--osm-file", fixture, success=False)
        self.assertIn("--osm", result.stderr)
        self.assertFalse(self.output.exists())
        report = self.run_cli("--osm", "--osm-file", fixture)
        self.assertEqual(report["count"], 137)
        self.assertEqual(report["by_source"], {"sample": 137})
        self.assertEqual(report["osm"]["elements_received"], 0)

    def test_invalid_or_partial_overpass_json_cannot_publish_a_successful_snapshot(self):
        for value in (
            {}, {"elements": {}}, {"elements": [], "remark": "private-response-sentinel"},
            {"elements": [osm_node(1, lat=float("nan"))]},
        ):
            with self.subTest(value_type=type(value).__name__):
                fixture = self.fixture(value)
                result = self.run_cli("--osm", "--osm-file", fixture, success=False)
                self.assertNotIn("private-response-sentinel", result.stderr)
                self.assertFalse(self.output.exists())
        fixture.write_bytes(b"\xffnot JSON")
        self.run_cli("--osm", "--osm-file", fixture, success=False)
        self.assertFalse(self.output.exists())

    def test_malformed_element_types_are_counted_without_crashing_the_import(self):
        fixture = self.fixture(overpass([
            osm_node(1), None, [], "not an object", {"type": [], "id": 2},
            {"type": {}, "id": 3}, osm_node(0), osm_node(-1), osm_node(1.5),
            osm_node("4"), osm_node(5, center=[], lat=None),
        ]))
        report = self.run_cli("--osm", "--osm-file", fixture)
        self.assertEqual(report["count"], 138)
        self.assertEqual(sum(report["dropped"].values()), 10)

    def test_symlink_and_fifo_inputs_cannot_be_read_as_fixtures(self):
        fixture = self.fixture(overpass([osm_node(1)]))
        symlink = self.directory / "symlink.json"
        symlink.symlink_to(fixture)
        self.run_cli("--osm", "--osm-file", symlink, success=False)
        fifo = self.directory / "pipe.json"
        os.mkfifo(fifo)
        self.run_cli("--osm", "--osm-file", fifo, success=False)
        self.assertFalse(self.output.exists())

    def test_element_cap_is_reported_and_oversized_fixture_is_rejected(self):
        fixture = self.fixture(overpass([osm_node(i + 1) for i in range(1003)]))
        report = self.run_cli("--osm", "--osm-file", fixture)
        self.assertEqual(report["by_source"], {"sample": 137, "OpenStreetMap": 1000})
        self.assertTrue(report["osm"]["limited"])
        self.assertEqual(report["osm"]["elements_received"], 1003)
        self.assertEqual(report["dropped"]["over_limit"], 3)
        oversized = self.directory / "too-large.json"
        with oversized.open("wb") as stream:
            stream.seek(8 * 1024 * 1024)
            stream.write(b" ")
        destination = self.directory / "oversized.sqlite"
        self.run_cli("--osm", "--osm-file", oversized, output=destination, success=False)
        self.assertFalse(destination.exists())

    def test_fixture_mode_cannot_connect_to_the_network(self):
        fixture = self.fixture(overpass([osm_node(1)]))
        with patch("socket.socket.connect", side_effect=AssertionError("fixture mode must be offline")):
            report = self.helper().build_catalog(self.output, osm=True, osm_file=fixture)
        self.assertEqual(report["by_source"], {"sample": 137, "OpenStreetMap": 1})

    def test_overpass_request_retries_transient_errors_and_bounds_the_real_query(self):
        module = self.helper()
        raw = json.dumps(overpass([osm_node(1)])).encode()
        requests, delays = [], []

        def request(req, *, timeout):
            requests.append(req)
            self.assertGreater(timeout, 0)
            self.assertLessEqual(timeout, 60)
            if len(requests) == 1:
                raise HTTPError(req.full_url, 429, "busy", {"Retry-After": "0"}, io.BytesIO(b"busy"))
            self.assertEqual(req.full_url, "https://overpass-api.de/api/interpreter")
            self.assertEqual(req.get_method(), "POST")
            query = parse_qs(req.data.decode())["data"][0]
            self.assertIn("[out:json]", query)
            self.assertIn("[timeout:", query)
            self.assertIn("[maxsize:", query)
            self.assertIn("(33.1,126.15,33.6,126.98)", query)
            self.assertRegex(query, r"out\s+body\s+center\s+1001\s*;")
            return Response(raw, {"Content-Length": str(len(raw))})

        with patch("urllib.request.urlopen", side_effect=request), patch("time.sleep", side_effect=delays.append):
            report = module.build_catalog(self.output, osm=True)
        self.assertEqual(report["by_source"]["OpenStreetMap"], 1)
        self.assertEqual(len(requests), 2)
        self.assertLessEqual(sum(delays), 10)
        self.assertEqual(report["osm"]["input"], "overpass")
        self.assertIsNotNone(report["osm"]["retrieved_at"])
        self.assertEqual(report["osm"]["sha256"], hashlib.sha256(raw).hexdigest())

    def test_unavailable_overpass_has_a_retry_ceiling_and_no_silent_sample_fallback(self):
        module = self.helper()
        attempts = []

        def unavailable(*args, **kwargs):
            attempts.append(1)
            raise URLError("private-response-sentinel")

        with patch("urllib.request.urlopen", side_effect=unavailable), patch("time.sleep"):
            with self.assertRaises(module.BootstrapError) as caught:
                module.build_catalog(self.output, osm=True)
        self.assertEqual(len(attempts), 3)
        self.assertNotIn("private-response-sentinel", str(caught.exception))
        self.assertFalse(self.output.exists())

    def test_response_limit_covers_headers_streams_and_slow_trickles(self):
        module = self.helper()
        for response in (
            Response(b"{}", {"Content-Length": "8388609"}),
            Response(b"{}", {"Content-Length": "-1"}),
            Response(b"{}", {"Content-Length": "not a length"}),
            Response(b"{}", {"Content-Length": "3"}),
            Response(b"x" * (8 * 1024 * 1024 + 1)),
            Response(b"{}", {"Content-Encoding": "gzip"}),
        ):
            with patch("urllib.request.urlopen", return_value=response), patch("time.sleep"):
                with self.assertRaises(module.BootstrapError):
                    module.build_catalog(self.output, osm=True)
            self.assertFalse(self.output.exists())

        elapsed, reads = [0], []

        class SlowResponse(Response):
            def read1(self, size):
                elapsed[0] += 20
                reads.append(size)
                return b" "

        with patch("urllib.request.urlopen", return_value=SlowResponse(b"")), \
                patch("time.monotonic", side_effect=lambda: elapsed[0]), patch("time.sleep"):
            with self.assertRaises(module.BootstrapError):
                module.build_catalog(self.output, osm=True)
        self.assertLessEqual(len(reads), 3, "a trickling body must have an overall deadline")
        self.assertFalse(self.output.exists())

    def test_permanent_http_errors_and_long_retry_after_do_not_hammer_overpass(self):
        module = self.helper()
        for code, headers in ((400, {}), (429, {"Retry-After": "120"})):
            attempts = []

            def reject(req, **kwargs):
                attempts.append(1)
                raise HTTPError(req.full_url, code, "rejected", headers, io.BytesIO(b"private-sentinel"))

            with patch("urllib.request.urlopen", side_effect=reject), patch("time.sleep"):
                with self.assertRaises(module.BootstrapError) as caught:
                    module.build_catalog(self.output, osm=True)
            self.assertEqual(len(attempts), 1)
            self.assertNotIn("private-sentinel", str(caught.exception))
            self.assertFalse(self.output.exists())

    def test_fsync_failure_removes_staging_file_and_racing_output_is_preserved(self):
        module = self.helper()
        with patch("os.fsync", side_effect=OSError("simulated full disk")):
            with self.assertRaises(OSError):
                module.build_catalog(self.output)
        self.assertEqual(list(self.output.parent.iterdir()), [])
        original_link = os.link

        def racing_link(source, destination, **kwargs):
            self.output.write_bytes(b"concurrent writer")
            return original_link(source, destination, **kwargs)

        with patch("os.link", side_effect=racing_link):
            with self.assertRaises(module.BootstrapError):
                module.build_catalog(self.output)
        self.assertEqual(self.output.read_bytes(), b"concurrent writer")
        self.assertEqual(list(self.output.parent.iterdir()), [self.output])

    def test_node_catalog_loader_reads_samples_and_osm_without_aws(self):
        node = os.environ.get("NODE_BINARY") or shutil.which("node")
        if not node:
            self.skipTest("Node 24+ is not installed; set NODE_BINARY to run the real reader check")
        version = subprocess.run([node, "--version"], capture_output=True, text=True, check=True)
        if int(version.stdout.lstrip("v").split(".")[0]) < 24:
            self.skipTest("Node 24+ is required for the repository's node:sqlite loader; set NODE_BINARY")
        fixture = self.fixture(overpass([osm_node(1)]))
        for with_osm in (False, True):
            path = self.directory / ("with-osm.sqlite" if with_osm else "samples.sqlite")
            arguments = ("--osm", "--osm-file", fixture) if with_osm else ()
            self.run_cli(*arguments, output=path)
            before = hashlib.sha256(path.read_bytes()).hexdigest()
            result = subprocess.run([
                node, "--input-type=module", "-e", """
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { Catalog } = await import(pathToFileURL(process.argv[2]).href);
const catalog = new Catalog({
  localPath: process.argv[1],
  s3Client: { send() { throw new Error('AWS is forbidden'); } },
});
try {
  await catalog.init();
  const status = catalog.status();
  assert.equal(status.status, 'ready');
  assert.equal(status.by_source.sample, 137);
  assert.equal(status.photos_count, 0);
  assert.equal(status.hours_week_count, 0);
  assert.equal(catalog.points({}).features.length, status.total);
  assert.ok(catalog.search({ q: '일출봉' }).items.some(p => p.id === 'poi_0008'));
  for (const point of catalog.points({}).features) {
    const detail = catalog.detail(point.properties.id);
    assert.deepEqual(detail.facilities, {});
    assert.deepEqual(detail.photos, []);
    assert.deepEqual(detail.hours_week, []);
    assert.equal(detail.field_evidence['facilities.parking'].state, 'unknown');
    assert.equal(detail.field_evidence.lat.observed_at, null);
    assert.ok(!detail.official_details);
    if (detail.source === 'sample') {
      assert.equal(detail.field_evidence.lat.state, 'unverified');
      assert.match(detail.base_note, /검증되지/);
      assert.match(detail.summary, /미검증/);
      assert.equal(detail.enriched_at, null);
    } else {
      assert.equal(detail.source, 'OpenStreetMap');
      assert.equal(detail.field_evidence.lat.state, 'source_reported');
      assert.equal(detail.field_evidence.lat.evidence_url, 'https://www.openstreetmap.org/node/1');
      assert.equal(detail.sources[0].license, 'ODbL');
    }
  }
  console.log(JSON.stringify({ count: status.total }));
} finally { catalog.close(); }
""", str(path), str(ROOT / "server/catalog.mjs")],
                cwd=self.directory, capture_output=True, text=True, timeout=30,
                env={"PATH": os.defpath, "AWS_EC2_METADATA_DISABLED": "true"},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["count"], 138 if with_osm else 137)
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), before)


if __name__ == "__main__":
    unittest.main()
