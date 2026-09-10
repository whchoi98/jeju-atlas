import importlib.util
import io
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("asset_deploy", ROOT / "scripts/deploy.py")
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

BUCKET = "jeju-3d-assets-061525506239-ap-northeast-2"
IMAGE = "061525506239.dkr.ecr.ap-northeast-2.amazonaws.com/jeju-3d@sha256:" + "a" * 64


class ManifestTests(unittest.TestCase):
    def call(self, manifest):
        body = io.BytesIO(json.dumps(manifest).encode())
        class S3:
            def get_object(self, **kwargs):
                self.assertions = kwargs
                return {"Body": body}
        client = S3()
        class Session:
            def client(self, service, **kwargs):
                if service != "s3":
                    raise AssertionError("Unexpected service")
                return client
        try:
            result = deploy.require_asset_manifest(Session(), BUCKET, IMAGE)
            self.assertEqual(client.assertions, {"Bucket": BUCKET, "Key": "releases/" + "a" * 64 + ".json"})
            return result
        finally:
            self.assertTrue(body.closed)

    def test_only_a_complete_manifest_for_the_selected_image_passes(self):
        data = {"version": 1, "imageUri": IMAGE, "assetsSHA": {"assets/main-abcdefgh.js": "b" * 64}}
        self.assertEqual(self.call(data), data)

    def test_wrong_image_or_unsafe_incomplete_entries_stop_deployment(self):
        for edits in [
            {"imageUri": IMAGE.replace("a" * 64, "c" * 64)},
            {"assetsSHA": {}},
            {"assetsSHA": {"releases/private.json": "b" * 64}},
            {"assetsSHA": {"assets/../private": "b" * 64}},
            {"assetsSHA": {"assets/main.js": None}},
            {"assetsSHA": {"assets/main.js": "not-a-checksum"}},
        ]:
            with self.subTest(edits=edits), self.assertRaises(ValueError):
                self.call({"version": 1, "imageUri": IMAGE,
                           "assetsSHA": {"assets/main-abcdefgh.js": "b" * 64}, **edits})


if __name__ == "__main__":
    unittest.main()
