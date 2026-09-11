"""Routing image configuration and health checks without running containers."""
from copy import deepcopy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
BASE = "ghcr.io/valhalla/valhalla@sha256:58c7dd3fb256f306b00c558fb76aea9fd4fb804edd831e2b4847c26511cca507"


def load(test, name):
    path = ROOT / "routing" / name
    test.assertTrue(path.is_file(), f"Missing routing runtime module: {name}")
    spec = importlib.util.spec_from_file_location(name.replace(".", "_"), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RoutingImageTest(unittest.TestCase):
    def setUp(self):
        self.runtime = load(self, "runtime.py")
        self.temp = tempfile.TemporaryDirectory(prefix="routing-image-test-")
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name)
        values = {"valhalla_tiles.tar": b"graph", "admin.sqlite": b"admin",
                  "elevation_data/N33/N33E126.hgt": b"height"}
        self.source = {
            "version": 1, "data_updated_at": "2026-09-10T20:21:06Z",
            "engine": {"name": "Valhalla", "version": "3.8.3", "base_image": BASE},
            "files": {},
        }
        for name, body in values.items():
            path = self.data / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
            path.chmod(0o600)
            self.source["files"][name] = {"bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()}
        self.save_source()

    def save_source(self):
        (self.data / "source.json").write_text(json.dumps(self.source))

    def test_configuration_uses_only_fixed_local_artifacts_and_bounded_private_actions(self):
        original = {
            "logging": {"type": "std_out"},
            "mjolnir": {"tile_url": "https://forbidden.invalid", "timezone": "/world.sqlite", "traffic_extract": "/traffic.tar"},
            "additional_data": {"elevation_url": "https://forbidden.invalid"},
            "loki": {"actions": ["route", "isochrone", "trace_route"]},
            "httpd": {"service": {"listen": "tcp://*:8002"}},
            "service_limits": {"auto": {}, "pedestrian": {}, "status": {}, "skadi": {}},
        }
        result = self.runtime.configure(original, self.data)
        self.assertEqual(original["logging"]["type"], "std_out", "Do not mutate the upstream default object")
        self.assertEqual(result["httpd"]["service"]["listen"], "tcp://127.0.0.1:8002")
        self.assertEqual(result["loki"]["actions"], ["route", "height", "status"])
        self.assertEqual(result["logging"]["type"], "")
        self.assertEqual(result["mjolnir"]["tile_extract"], str(self.data / "valhalla_tiles.tar"))
        self.assertEqual(result["mjolnir"]["admin"], str(self.data / "admin.sqlite"))
        self.assertNotIn("timezone", result["mjolnir"])
        self.assertNotIn("tile_url", result["mjolnir"])
        self.assertNotIn("elevation_url", result["additional_data"])
        self.assertEqual(result["additional_data"]["elevation"], str(self.data / "elevation_data"))
        self.assertLessEqual(result["mjolnir"]["max_cache_size"], 128 * 1024 * 1024)
        self.assertTrue(result["mjolnir"]["lru_mem_cache_hard_control"])
        self.assertFalse(result["mjolnir"]["global_synchronized_cache"],
                         "Valhalla 3.8.3 global LRU cache must not be enabled after the concurrent-load crash")
        self.assertEqual(result["service_limits"]["auto"]["max_locations"], 12)
        self.assertEqual(result["service_limits"]["pedestrian"]["max_locations"], 12)
        self.assertTrue(result["service_limits"]["status"]["allow_verbose"])

    def test_timezone_is_optional_but_used_only_when_manifest_and_file_match(self):
        self.runtime.validate_artifacts(self.data)
        body = b"timezones"
        (self.data / "timezones.sqlite").write_bytes(body)
        with self.assertRaises(self.runtime.ArtifactError):
            self.runtime.validate_artifacts(self.data)
        self.source["files"]["timezones.sqlite"] = {"bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()}
        self.save_source()
        config = self.runtime.configure({}, self.data)
        self.assertEqual(config["mjolnir"]["timezone"], str(self.data / "timezones.sqlite"))

    def test_wrong_engine_hash_missing_files_and_symlinks_fail_before_startup(self):
        for change in ("engine", "base", "hash", "missing", "symlink"):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                import shutil
                root = Path(directory) / "data"
                shutil.copytree(self.data, root)
                source = deepcopy(self.source)
                if change == "engine":
                    source["engine"]["version"] = "latest"
                elif change == "base":
                    source["engine"]["base_image"] = "untrusted"
                elif change == "hash":
                    (root / "valhalla_tiles.tar").write_bytes(b"other")
                else:
                    (root / "admin.sqlite").unlink()
                    if change == "symlink":
                        (root / "admin.sqlite").symlink_to(self.data / "admin.sqlite")
                (root / "source.json").write_text(json.dumps(source))
                with self.assertRaises(self.runtime.ArtifactError):
                    self.runtime.validate_artifacts(root)

    def test_sealing_makes_private_input_files_readable_by_the_runtime_user(self):
        self.runtime.seal_artifacts(self.data)
        for path in self.data.rglob("*"):
            self.assertEqual(path.stat().st_mode & 0o777, 0o555 if path.is_dir() else 0o444)

    def test_health_requires_loaded_tiles_and_version_and_never_prints_response_coordinates(self):
        health = load(self, "healthcheck.py")
        valid = {"version": "3.8.3", "has_tiles": True, "tileset_last_modified": 1789071666,
                 "available_actions": ["route", "height", "status"], "bbox": "PRIVATE_COORDINATES"}
        class Response(io.BytesIO):
            status = 200
        for changes, expected in [({}, True), ({"has_tiles": False}, False), ({"version": "3.8.30"}, False),
                                  ({"available_actions": ["status"]}, False), ({"tileset_last_modified": 0}, False)]:
            with self.subTest(changes=changes), patch("sys.stdout", new_callable=io.StringIO) as output:
                opener = lambda *args, **kwargs: Response(json.dumps({**valid, **changes}).encode())
                self.assertEqual(health.healthy(opener=opener), expected)
                self.assertEqual(output.getvalue(), "")

    def test_entrypoint_suppresses_native_output_and_execs_a_single_worker(self):
        with patch.dict(sys.modules, {"runtime": self.runtime}):
            entrypoint = load(self, "entrypoint.py")
        config = self.data / "valhalla.json"
        config.write_text("{}")
        with patch.object(entrypoint, "DATA_ROOT", self.data), patch.object(entrypoint, "CONFIG_PATH", config), \
                patch.object(entrypoint.os, "dup2") as redirect, patch.object(entrypoint.os, "execv") as execute, \
                patch("sys.stdout", new_callable=io.StringIO) as output:
            entrypoint.main()
        self.assertEqual([call.args[1] for call in redirect.call_args_list], [1, 2])
        self.assertEqual(execute.call_args.args, (
            "/usr/local/bin/valhalla_service", ["valhalla_service", str(config), "1"],
        ))
        self.assertEqual(json.loads(output.getvalue()), {"event": "routing_starting", "engine_version": "3.8.3"})


if __name__ == "__main__":
    unittest.main()
