"""Shared Jeju input regressions; Docker and downloads are replaced at their boundaries."""
from contextlib import closing, redirect_stderr, redirect_stdout
from copy import deepcopy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
from types import SimpleNamespace
import sys
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "preextracted_routing", Path(__file__).resolve().parents[1] / "scripts/build-routing-data.py",
)
data = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(data)


class PreextractedRoutingTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="atlas-shared-pbf-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.shared = self.directory / "provided"
        self.shared.mkdir()
        self.pbf = self.shared / "jeju.osm.pbf"
        self.pbf.write_bytes(b"abc")
        self.input_info = {
            "kind": "jeju-atlas-pre-extracted-osm/v1",
            "file": "jeju.osm.pbf", "bytes": 3,
            "sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            "osmTimestamp": "2026-09-10T20:21:06Z",
            "bounds": [126.1, 33.0, 127.05, 33.75],
            "originalSource": {
                "url": "https://download.geofabrik.de/asia/south-korea-latest.osm.pbf",
                "sha256": hashlib.sha256(b"original national snapshot").hexdigest(),
                "md5": hashlib.md5(b"original national snapshot").hexdigest(),
            },
            "attribution": "© OpenStreetMap contributors",
            "license": "ODbL-1.0",
            "licenseUrl": "https://www.openstreetmap.org/copyright",
        }
        self.info = self.shared / "jeju-input.json"
        self.save_input()
        self.project = self.directory / "participant app"
        self.project.mkdir()
        (self.project / "Dockerfile.routing-builder").write_text("FROM fixture\n")
        self.output = self.project / ".local/routing-data"
        self.network_calls = 0
        self.docker_calls = []
        self.image_builds = []
        self.addCleanup(patch.stopall)
        patch.object(data, "fetch_sources", side_effect=self.fetch).start()
        patch.object(data, "fetch_elevation", side_effect=self.elevation, create=True).start()
        patch.object(data, "docker_command", side_effect=self.docker).start()
        patch.object(data.subprocess, "run", side_effect=self.build_image).start()

    def save_input(self):
        self.info.write_text(json.dumps(self.input_info))

    def add_admin_input(self):
        path = self.shared / "admin.sqlite"
        path.unlink(missing_ok=True)
        with closing(sqlite3.connect(path)) as database, database:
            database.execute("CREATE TABLE admins(admin_level INTEGER, iso_code TEXT, name TEXT, name_en TEXT, geom BLOB)")
            database.execute("INSERT INTO admins VALUES(2, 'KR', '대한민국', 'South Korea', ?)", (b"geometry",))
            database.execute("INSERT INTO admins VALUES(4, '49', '제주특별자치도', 'Jeju', ?)", (b"geometry",))
            database.executemany("INSERT INTO admins VALUES(4, ?, ?, ?, ?)", [
                (str(i), "region " + str(i), "region " + str(i), b"geometry") for i in range(15)
            ])
        self.input_info["kind"] = "jeju-atlas-pre-extracted-osm/v2"
        self.input_info["admin"] = {
            "file": "admin.sqlite", "bytes": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "osmTimestamp": self.input_info["osmTimestamp"],
            "sourceSha256": self.input_info["originalSource"]["sha256"],
            "engine": {"name": "Valhalla", "version": "3.8.3",
                       "base_image": "ghcr.io/valhalla/valhalla@sha256:58c7dd3fb256f306b00c558fb76aea9fd4fb804edd831e2b4847c26511cca507",
                       "platform": "linux/arm64"},
            "adminLevelCounts": {"2": 1, "4": 16},
        }
        (self.project / "Dockerfile.routing-builder").write_text(
            "FROM " + self.input_info["admin"]["engine"]["base_image"] + "\n"
        )
        self.save_input()
        self.save_sums()
        return path

    def save_sums(self):
        names = ["jeju.osm.pbf", "admin.sqlite", "jeju-input.json"]
        (self.shared / "SHA256SUMS").write_text("".join(
            hashlib.sha256((self.shared / name).read_bytes()).hexdigest() + "  " + name + "\n"
            for name in names if (self.shared / name).exists()
        ))

    def elevation(self, root, cached=None):
        path = Path(root) / "elevation_data/N33/N33E126.hgt"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"height")
        return {"last_modified": "fixture observation"}

    def fetch(self, root):
        self.network_calls += 1
        root = Path(root)
        root.mkdir(parents=True, exist_ok=True)
        national = b"national snapshot used by admin"
        (root / "south-korea.osm.pbf").write_bytes(national)
        dem = root / "elevation_data/N33/N33E126.hgt"
        dem.parent.mkdir(parents=True, exist_ok=True)
        dem.write_bytes(b"height")
        receipt = {
            "pbf": {"sha256": hashlib.sha256(national).hexdigest(),
                    "md5": hashlib.md5(national).hexdigest(), "bytes": len(national)},
            "elevation": {"last_modified": "fixture observation"},
        }
        (root / "downloads.json").write_text(json.dumps(receipt))
        return receipt

    def build_image(self, command, **kwargs):
        self.assertEqual(command[:2], ["docker", "build"])
        self.image_builds.append(command)
        return SimpleNamespace(returncode=0)

    def docker(self, root, command, capture=False, **kwargs):
        self.docker_calls.append(command)
        root = Path(root)
        if command[:2] == ["osmium", "fileinfo"]:
            if command[-1] == "/data/jeju.osm.pbf":
                return b'{"data":{"timestamp":{"last":"2026-09-10T20:00:00Z"},"metadata":{"all_objects":{"timestamp":true}}}}'
            self.assertEqual(command[-1], "/data/south-korea.osm.pbf")
            return b"2026-09-29T20:00:00Z\n"
        if command[:2] == ["osmium", "extract"]:
            (root / "jeju.osm.pbf").write_bytes(b"newly extracted")
        elif command[0] == "valhalla_build_config":
            return b'{"mjolnir": {}}'
        elif command[0] == "valhalla_build_admins":
            self.assertEqual(command[-1], "/data/south-korea.osm.pbf")
            (root / "admin.sqlite").write_bytes(b"admin")
        elif command[0] == "valhalla_build_tiles":
            self.assertEqual(command[-1], "/data/jeju.osm.pbf")
        elif command[0] == "valhalla_build_extract":
            (root / "valhalla_tiles.tar").write_bytes(b"tiles")
        else:
            self.fail("Unexpected Docker operation: " + repr(command))

    def invoke(self, *, shared=True, metadata=None, action="build"):
        command = ["build-routing-data.py", action, "--output", str(self.output)]
        if shared:
            command += ["--jeju-pbf", str(self.pbf), "--project-root", str(self.project)]
        if metadata is not None:
            command += ["--input-metadata", str(metadata)]
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(sys, "argv", command), redirect_stdout(stdout), redirect_stderr(stderr):
            try:
                data.main()
            except SystemExit as error:
                return error.code, stdout.getvalue(), stderr.getvalue()
        return 0, stdout.getvalue(), stderr.getvalue()

    def test_shared_input_skips_extract_and_preserves_its_date_and_source(self):
        code, output, error = self.invoke()
        self.assertEqual(code, 0, error)
        self.assertEqual(self.pbf.read_bytes(), b"abc")
        self.assertEqual((self.output / "jeju.osm.pbf").read_bytes(), b"abc")
        self.assertFalse(any(command[:2] == ["osmium", "extract"] for command in self.docker_calls))
        self.assertEqual(self.image_builds[0][-1], str(self.project))
        manifest = json.loads((self.output / "source.json").read_text())
        self.assertEqual(manifest["osm_timestamp"], "2026-09-10T20:21:06Z")
        self.assertEqual(manifest["data_updated_at"], "2026-09-10T20:21:06Z")
        self.assertEqual(manifest["source_sha256"], self.input_info["originalSource"]["sha256"])
        self.assertEqual(manifest["files"]["jeju.osm.pbf"]["sha256"], self.input_info["sha256"])
        self.assertEqual(manifest["admin_source"]["osm_timestamp"], "2026-09-29T20:00:00Z")
        self.assertEqual(manifest["input"]["mode"], "pre-extracted")
        self.assertIn('"event": "jeju_extract_skipped"', output)
        self.assertIn('"event": "graph_verified"', output)
        events = [json.loads(line) for line in output.splitlines()]
        completed = next(event for event in events if event.get("event") == "graph_verified")
        self.assertEqual(completed["osm_timestamp"], "2026-09-10T20:21:06Z")
        before = (self.output / "jeju.osm.pbf").stat().st_mtime_ns
        code, _, error = self.invoke()
        self.assertEqual(code, 0, error)
        self.assertEqual((self.output / "jeju.osm.pbf").stat().st_mtime_ns, before)

    def test_invalid_input_fails_before_download_or_docker(self):
        original = deepcopy(self.input_info)
        for kind in ("hash", "size", "bounds", "date", "source", "kind", "missing"):
            with self.subTest(kind=kind):
                self.input_info = deepcopy(original)
                if kind == "hash":
                    self.input_info["sha256"] = "0" * 64
                elif kind == "size":
                    self.input_info["bytes"] = 4
                elif kind == "bounds":
                    self.input_info["bounds"] = [0, 0, 1, 1]
                elif kind == "date":
                    self.input_info["osmTimestamp"] = ""
                elif kind == "source":
                    self.input_info["originalSource"]["url"] = "http://169.254.169.254/"
                elif kind == "kind":
                    self.input_info["kind"] = "unknown"
                self.save_input()
                if kind == "missing":
                    self.info.unlink()
                with self.assertRaises((ValueError, FileNotFoundError)):
                    code, _, error = self.invoke()
                    self.assertEqual(code, 0, error)
                self.assertEqual(self.network_calls, 0)
                self.assertEqual(self.docker_calls, [])
                self.assertEqual(self.image_builds, [])
                self.assertFalse(self.output.exists())

    def test_existing_different_jeju_is_not_overwritten(self):
        self.output.mkdir(parents=True)
        target = self.output / "jeju.osm.pbf"
        target.write_bytes(b"participant's previous extract")
        with self.assertRaisesRegex(ValueError, "existing|Existing"):
            code, _, error = self.invoke()
            self.assertEqual(code, 0, error)
        self.assertEqual(target.read_bytes(), b"participant's previous extract")
        self.assertEqual(self.network_calls, 0)

    def test_symlink_input_or_output_does_not_write_through_it(self):
        self.pbf.unlink()
        outside = self.directory / "original.pbf"
        outside.write_bytes(b"abc")
        self.pbf.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "symlink|regular"):
            code, _, error = self.invoke()
            self.assertEqual(code, 0, error)
        self.pbf.unlink()
        self.pbf.write_bytes(b"abc")
        other = self.directory / "other-output"
        other.mkdir()
        self.output.parent.mkdir()
        self.output.symlink_to(other, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlink"):
            code, _, error = self.invoke()
            self.assertEqual(code, 0, error)
        self.assertEqual(list(other.iterdir()), [])
        self.assertEqual(self.network_calls, 0)

    def test_legacy_build_still_extracts_the_national_input(self):
        self.fetch(self.output)
        code, _, error = self.invoke(shared=False)
        self.assertEqual(code, 0, error)
        self.assertEqual((self.output / "jeju.osm.pbf").read_bytes(), b"newly extracted")
        manifest = json.loads((self.output / "source.json").read_text())
        self.assertEqual(manifest["data_updated_at"], "2026-09-29T20:00:00Z")

    def test_shared_input_options_are_not_silently_ignored_for_fetch(self):
        code, _, _ = self.invoke(action="fetch")
        self.assertNotEqual(code, 0)
        self.assertEqual(self.network_calls, 0)

    def test_failed_tiles_do_not_create_a_graph_completion_manifest(self):
        previous_docker = self.docker
        def fail_tiles(root, command, **kwargs):
            if command[0] == "valhalla_build_tiles":
                raise data.subprocess.CalledProcessError(1, command)
            return previous_docker(root, command, **kwargs)
        with patch.object(data, "docker_command", side_effect=fail_tiles):
            with self.assertRaises(data.subprocess.CalledProcessError):
                code, _, error = self.invoke()
                self.assertEqual(code, 0, error)
        self.assertEqual((self.output / "jeju.osm.pbf").read_bytes(), b"abc")
        self.assertFalse((self.output / "source.json").exists())

    def test_shared_admin_skips_national_download_and_admin_build(self):
        admin = self.add_admin_input()
        original = admin.read_bytes()
        with patch.object(data, "fetch_elevation", side_effect=self.elevation, create=True):
            try:
                code, output, error = self.invoke()
            except ValueError as error:
                self.fail("Valid shared admin bundle was rejected: " + str(error))
        self.assertEqual(code, 0, error)
        self.assertEqual(self.network_calls, 0)
        self.assertFalse((self.output / "south-korea.osm.pbf").exists())
        self.assertEqual((self.output / "admin.sqlite").read_bytes(), original)
        self.assertFalse(any(command[0] == "valhalla_build_admins" for command in self.docker_calls))
        self.assertFalse(any(command[:2] == ["osmium", "extract"] for command in self.docker_calls))
        result = json.loads((self.output / "source.json").read_text())
        self.assertEqual(result["admin_source"]["osm_timestamp"], "2026-09-10T20:21:06Z")
        self.assertTrue(result["admin_source"]["reused"])
        self.assertEqual(result["input"]["admin"]["adminLevelCounts"], {"2": 1, "4": 16})
        self.assertIn('"event": "admin_build_skipped"', output)
        self.assertEqual(json.loads(self.info.read_text()), self.input_info)

    def test_empty_admin_database_is_rejected_even_with_matching_hashes(self):
        admin = self.add_admin_input()
        with closing(sqlite3.connect(admin)) as database, database:
            database.execute("DELETE FROM admins")
        self.input_info["admin"]["sha256"] = hashlib.sha256(admin.read_bytes()).hexdigest()
        self.save_input()
        self.save_sums()
        with self.assertRaisesRegex(ValueError, "admin|Admin"):
            code, _, error = self.invoke()
            self.assertEqual(code, 0, error)
        self.assertEqual(self.network_calls, 0)
        self.assertEqual(self.image_builds, [])

    def test_bundle_checksums_protect_metadata_as_well_as_pbf(self):
        self.add_admin_input()
        self.input_info["osmTimestamp"] = "2026-09-11T20:00:00Z"
        self.save_input()  # Deliberately leave the trusted checksum list unchanged.
        with self.assertRaisesRegex(ValueError, "checksum"):
            code, _, error = self.invoke()
            self.assertEqual(code, 0, error)
        self.assertEqual(self.network_calls, 0)

    def test_shared_admin_must_match_snapshot_and_engine(self):
        for key, value in [("sourceSha256", "0" * 64), ("osmTimestamp", "2026-09-12T20:00:00Z"),
                           ("engine", {"version": "different"})]:
            with self.subTest(key=key):
                self.add_admin_input()
                self.input_info["admin"][key] = value
                self.save_input()
                self.save_sums()
                with self.assertRaisesRegex(ValueError, "admin|Admin"):
                    code, _, error = self.invoke()
                    self.assertEqual(code, 0, error)
                self.assertEqual(self.network_calls, 0)

    def test_newer_pbf_objects_cannot_be_labeled_with_older_snapshot_date(self):
        self.add_admin_input()
        previous_docker = self.docker
        def newer_objects(root, command, **kwargs):
            if command[:2] == ["osmium", "fileinfo"] and command[-1] == "/data/jeju.osm.pbf":
                return b'{"data":{"timestamp":{"last":"2026-09-29T00:00:00Z"},"metadata":{"all_objects":{"timestamp":true}}}}'
            return previous_docker(root, command, **kwargs)
        with patch.object(data, "fetch_elevation", side_effect=self.elevation, create=True), \
                patch.object(data, "docker_command", side_effect=newer_objects):
            with self.assertRaisesRegex(ValueError, "timestamp|snapshot"):
                code, _, error = self.invoke()
                self.assertEqual(code, 0, error)
        self.assertFalse((self.output / "source.json").exists())

    def test_shared_admin_rejects_a_different_builder_base_before_work(self):
        self.add_admin_input()
        (self.project / "Dockerfile.routing-builder").write_text("FROM alpine:latest\n")
        with self.assertRaisesRegex(ValueError, "builder.*engine"):
            code, _, error = self.invoke()
            self.assertEqual(code, 0, error)
        self.assertFalse(self.output.exists())
        self.assertEqual(self.network_calls, 0)


if __name__ == "__main__":
    unittest.main()
