import gzip
import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location(
    "routing_data", Path(__file__).resolve().parents[1] / "scripts/build-routing-data.py"
)
data = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(data)


class Response(io.BytesIO):
    def __init__(self, content, url, declared_length=None):
        super().__init__(content)
        self.url = url
        self.headers = {"Content-Length": str(len(content) if declared_length is None else declared_length)}

    def geturl(self):
        return self.url


class RoutingDataTests(unittest.TestCase):
    def test_integrity_failure_preserves_last_verified_download(self):
        payload = b"new graph source"
        url = data.PBF_URL
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "source.osm.pbf"
            target.write_bytes(b"last verified source")
            with self.assertRaisesRegex(ValueError, "checksum"):
                data.download(
                    url, target, 100, expected_md5="0" * 32,
                    opener=lambda request, timeout: Response(payload, url),
                )
            self.assertEqual(target.read_bytes(), b"last verified source")
            self.assertEqual(sorted(path.name for path in Path(directory).iterdir()), ["source.osm.pbf"])

    def test_stream_limit_is_enforced_when_server_understates_length(self):
        url = data.PBF_URL
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "source.osm.pbf"
            with self.assertRaisesRegex(ValueError, "limit"):
                data.download(
                    url, target, 8,
                    opener=lambda request, timeout: Response(b"0123456789", url, 1),
                )
            self.assertFalse(target.exists())
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_download_checks_redirect_host_before_accepting_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "source.osm.pbf"
            with self.assertRaisesRegex(ValueError, "source"):
                data.download(
                    data.PBF_URL, target, 100,
                    opener=lambda request, timeout: Response(b"not a trusted source", "http://169.254.169.254/latest/meta-data/"),
                )
            self.assertFalse(target.exists())

    def test_verified_download_has_independently_calculated_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "source.osm.pbf"
            result = data.download(
                data.PBF_URL, target, 100,
                expected_md5="900150983cd24fb0d6963f7d28e17f72",
                opener=lambda request, timeout: Response(b"abc", data.PBF_URL),
            )
            self.assertEqual(result["sha256"], "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
            self.assertEqual(result["bytes"], 3)
            self.assertEqual(target.read_bytes(), b"abc")

    def test_invalid_elevation_never_replaces_verified_dem(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "tile.hgt.gz"
            target = Path(directory) / "tile.hgt"
            source.write_bytes(gzip.compress(b"\0" * 20))
            target.write_bytes(b"previous")
            with self.assertRaisesRegex(ValueError, "size"):
                data.decompress_elevation(source, target, expected_bytes=8)
            self.assertEqual(target.read_bytes(), b"previous")

    def test_valid_elevation_is_preserved_byte_for_byte(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "tile.hgt.gz"
            target = Path(directory) / "tile.hgt"
            expected = b"\x00\x06\x80\x00\x00\x11\x00\x28"
            source.write_bytes(gzip.compress(expected))
            data.decompress_elevation(source, target, expected_bytes=8)
            self.assertEqual(target.read_bytes(), expected)

    def test_manifest_rejects_changed_graph_and_missing_elevation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "valhalla_tiles.tar").write_bytes(b"graph")
            (root / "jeju.osm.pbf").write_bytes(b"extract")
            (root / "elevation_data/N33").mkdir(parents=True)
            (root / "elevation_data/N33/N33E126.hgt").write_bytes(b"dem")
            metadata = {
                "osm_timestamp": "2026-09-09T20:00:00Z",
                "source_url": data.PBF_URL,
                "source_sha256": hashlib.sha256(b"source").hexdigest(),
                "source_md5": hashlib.md5(b"source").hexdigest(),
            }
            manifest = data.make_manifest(root, metadata)
            self.assertTrue(data.verify_manifest(root, manifest))
            (root / "valhalla_tiles.tar").write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "checksum"):
                data.verify_manifest(root, manifest)
            (root / "valhalla_tiles.tar").write_bytes(b"graph")
            (root / "elevation_data/N33/N33E126.hgt").unlink()
            with self.assertRaisesRegex(ValueError, "missing"):
                data.verify_manifest(root, manifest)

    def test_manifest_rejects_paths_outside_graph_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(ValueError, "path"):
                data.verify_manifest(root, {"files": {"../escape": {"sha256": "0" * 64, "bytes": 1}}})

    def test_osm_timestamp_cannot_be_unknown_or_in_the_future(self):
        for timestamp in ["", "not-a-date", "2999-01-01T00:00:00Z"]:
            with self.subTest(timestamp=timestamp), self.assertRaises(ValueError):
                data.validate_osm_timestamp(timestamp)


if __name__ == "__main__":
    unittest.main()
