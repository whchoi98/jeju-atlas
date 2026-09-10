"""Extract actual-image-shaped Docker tar streams and publish into an in-memory S3."""
import base64
from copy import deepcopy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from botocore.exceptions import ClientError

ROOT = Path(__file__).resolve().parents[1]
REPO = "061525506239.dkr.ecr.ap-northeast-2.amazonaws.com/jeju-3d"
CURRENT = REPO + "@sha256:0ef30ebd2d916a26fcc53eeee47a92c5483c55aef408c836e5a49c25880f671b"
PREVIOUS = REPO + "@sha256:9c3959d38054d2d6c3715439b897ae1204f4059a8f4724409399d32ab46b35b7"
BUCKET = "jeju-3d-assets-061525506239-ap-northeast-2"


def archive(files):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as stream:
        for name, value in files.items():
            member = tarfile.TarInfo(name)
            if isinstance(value, tuple):
                member.type, member.linkname = value
                stream.addfile(member)
            else:
                member.size = len(value)
                stream.addfile(member, io.BytesIO(value))
    return output.getvalue()


class Process:
    def __init__(self, data):
        self.stdout = io.BytesIO(data)
        self.returncode = 0

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        return self.returncode

    def kill(self):
        self.returncode = -9


class DockerFixture:
    def __init__(self):
        self.files = {
            CURRENT: {"index-DMIDY6QD.js": b"CURRENT IMAGE JS", "index-current.css": b"body{}", "same.woff2": b"font"},
            PREVIOUS: {"index-previous.js": b"PREVIOUS IMAGE JS", "same.woff2": b"font"},
        }
        self.commands = []
        self.containers = {}
        self.bad_digest = False

    def run(self, command, **kwargs):
        self.commands.append(command)
        assert command[0] == "docker"
        assert not kwargs.get("shell")
        if command[1:3] == ["image", "inspect"]:
            assert ".RepoDigests" in command[command.index("--format") + 1]
            return SimpleNamespace(returncode=0, stdout=json.dumps([] if self.bad_digest else [command[-1]]))
        if command[1] == "create":
            assert "--pull=never" in command and command[command.index("--network") + 1] == "none"
            assert "--read-only" in command
            assert not any(arg in command for arg in ("--env", "--env-file", "-e", "-v", "--mount"))
            image = command[-1]
            identity = hashlib.sha256(image.encode()).hexdigest()
            self.containers[identity] = image
            return SimpleNamespace(returncode=0, stdout=identity)
        if command[1] == "rm":
            assert command[-1] in self.containers
            del self.containers[command[-1]]
            return SimpleNamespace(returncode=0, stdout="")
        raise AssertionError(f"Unexpected Docker command: {command}")

    def popen(self, command, **kwargs):
        self.commands.append(command)
        assert command[:2] == ["docker", "cp"] and command[-1] == "-"
        identity, source = command[2].split(":", 1)
        assert source == "/app/dist/assets/."
        return Process(archive(self.files[self.containers[identity]]))


class S3Fixture:
    def __init__(self):
        self.objects = {}
        self.writes = []

    def put_object(self, **kwargs):
        assert kwargs["Bucket"] == BUCKET and kwargs["IfNoneMatch"] == "*"
        key = kwargs["Key"]
        data = kwargs["Body"].read() if hasattr(kwargs["Body"], "read") else kwargs["Body"]
        checksum = base64.b64encode(hashlib.sha256(data).digest()).decode()
        assert kwargs["ChecksumSHA256"] == checksum
        assert kwargs["Metadata"]["sha256"] == hashlib.sha256(data).hexdigest()
        if key in self.objects:
            raise ClientError({"Error": {"Code": "PreconditionFailed"}, "ResponseMetadata": {"HTTPStatusCode": 412}}, "PutObject")
        self.objects[key] = {
            "Body": data, "Metadata": deepcopy(kwargs["Metadata"]), "ContentLength": len(data),
            "ContentType": kwargs["ContentType"], "CacheControl": kwargs["CacheControl"],
            "ChecksumSHA256": checksum,
        }
        self.writes.append(key)
        return {"ChecksumSHA256": checksum}

    def head_object(self, **kwargs):
        assert kwargs["Bucket"] == BUCKET and kwargs["ChecksumMode"] == "ENABLED"
        return deepcopy(self.objects[kwargs["Key"]])


class PublishAssetsTest(unittest.TestCase):
    def setUp(self):
        path = ROOT / "scripts/publish-assets.py"
        self.assertTrue(path.is_file(), "Asset publisher is not implemented")
        spec = importlib.util.spec_from_file_location("assets_deploy", ROOT / "scripts/deploy.py")
        deploy = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(deploy)
        spec = importlib.util.spec_from_file_location("publish_assets", path)
        self.module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"deploy": deploy}):
            spec.loader.exec_module(self.module)
        self.temp = tempfile.TemporaryDirectory(prefix="jeju-assets-test-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.docker = DockerFixture()
        self.s3 = S3Fixture()

    def prepare(self, images=None, bucket=BUCKET):
        return self.module.prepare_assets(images or [CURRENT, PREVIOUS], bucket, self.directory,
                                          docker=self.docker)

    def test_two_image_union_comes_from_docker_and_retains_both_private_manifests(self):
        (self.directory / "dist").mkdir()
        (self.directory / "dist" / "index-DMIDY6QD.js").write_bytes(b"STALE HOST DIST")
        bundle = self.prepare()
        self.assertEqual(self.docker.containers, {})
        self.module.publish_assets(bundle, self.s3)
        current = self.s3.objects["assets/index-DMIDY6QD.js"]
        self.assertEqual(current["Body"], b"CURRENT IMAGE JS")
        self.assertEqual(current["ContentType"], "text/javascript; charset=utf-8")
        self.assertEqual(self.s3.objects["assets/index-current.css"]["ContentType"], "text/css; charset=utf-8")
        self.assertIn("immutable", current["CacheControl"])
        self.assertEqual(len([key for key in self.s3.objects if key.startswith("assets/")]), 4)
        manifests = [key for key in self.s3.writes if key.startswith("releases/")]
        self.assertEqual(len(manifests), 2)
        self.assertEqual(self.s3.writes[-2:], manifests, "No manifest may precede the completed asset union")
        for image in (CURRENT, PREVIOUS):
            key = "releases/" + image.rsplit(":", 1)[1] + ".json"
            manifest = json.loads(self.s3.objects[key]["Body"])
            self.assertEqual(manifest["imageUri"], image)
            self.assertTrue(manifest["assetsSHA"])
            for asset, digest in manifest["assetsSHA"].items():
                self.assertEqual(hashlib.sha256(self.s3.objects[asset]["Body"]).hexdigest(), digest)

    def test_republication_is_idempotent_and_cannot_replace_an_existing_object(self):
        bundle = self.prepare()
        self.module.publish_assets(bundle, self.s3)
        before = deepcopy(self.s3.objects)
        writes = list(self.s3.writes)
        self.module.publish_assets(bundle, self.s3)
        self.assertEqual(self.s3.objects, before)
        self.assertEqual(self.s3.writes, writes)

    def test_existing_hash_checksum_or_content_type_collision_blocks_manifest_publication(self):
        for field, bad in [("Metadata", {}), ("ChecksumSHA256", "wrong"), ("ContentType", "text/html")]:
            with self.subTest(field=field):
                with tempfile.TemporaryDirectory(dir=self.directory) as directory:
                    bundle = self.module.prepare_assets([CURRENT], BUCKET, Path(directory), docker=self.docker)
                    s3 = S3Fixture()
                    self.module.publish_assets(bundle, s3)
                    s3.objects = {key: value for key, value in s3.objects.items() if key.startswith("assets/")}
                    s3.writes.clear()
                    s3.objects["assets/index-DMIDY6QD.js"][field] = bad
                    with self.assertRaises(self.module.AssetError):
                        self.module.publish_assets(bundle, s3)
                    self.assertFalse(any(key.startswith("releases/") for key in s3.writes))

    def test_different_bytes_on_same_asset_name_fail_before_any_upload(self):
        self.docker.files[PREVIOUS]["index-DMIDY6QD.js"] = b"OLD DIFFERENT BYTES"
        with self.assertRaises(self.module.AssetError):
            self.prepare()
        self.assertEqual(self.s3.writes, [])
        self.assertEqual(self.docker.containers, {})

    def test_unowned_images_tags_wrong_bucket_and_uncached_digest_are_rejected(self):
        for image, bucket in [
            (REPO + ":latest", BUCKET),
            (CURRENT.replace("061525506239", "111111111111"), BUCKET),
            (CURRENT.replace("/jeju-3d@", "/other@"), BUCKET),
            (CURRENT, "unrelated-bucket"),
        ]:
            with self.subTest(image=image, bucket=bucket), self.assertRaises(self.module.AssetError):
                self.prepare([image], bucket)
        self.assertEqual(self.docker.commands, [])
        self.docker.bad_digest = True
        with self.assertRaises(self.module.AssetError):
            self.prepare()
        self.assertFalse(any(command[1] == "create" for command in self.docker.commands))

    def test_unsafe_tar_entries_empty_images_and_unknown_types_are_rejected(self):
        for files in [
            {"../outside.js": b"x"}, {"/outside.js": b"x"},
            {"link.js": (tarfile.SYMTYPE, "/etc/passwd")},
            {"link.js": (tarfile.LNKTYPE, "other.js")}, {".env": b"secret"},
            {"key.pem": b"secret"}, {},
        ]:
            with self.subTest(files=list(files)), tempfile.TemporaryDirectory(dir=self.directory) as directory:
                docker = DockerFixture()
                docker.files[CURRENT] = files
                with self.assertRaises(self.module.AssetError):
                    self.module.prepare_assets([CURRENT], BUCKET, Path(directory), docker=docker)
                self.assertEqual(docker.containers, {})
                self.assertFalse((Path(directory).parent / "outside.js").exists())

    def test_file_count_size_and_total_limits_fail_closed(self):
        for name, limit in [("MAX_FILES", 1), ("MAX_FILE_BYTES", 2), ("MAX_TOTAL_BYTES", 4)]:
            with self.subTest(limit=name), patch.object(self.module, name, limit):
                with tempfile.TemporaryDirectory(dir=self.directory) as directory:
                    with self.assertRaises(self.module.AssetError):
                        self.module.prepare_assets([CURRENT], BUCKET, Path(directory), docker=self.docker)
                    self.assertEqual(self.docker.containers, {})

    def test_cli_preparation_does_not_connect_to_aws_and_execute_publishes(self):
        bundle = self.prepare()
        for execute in (False, True):
            with self.subTest(execute=execute):
                output = []
                session = SimpleNamespace(client=lambda name, **kwargs: self.s3)
                arguments = ["publish-assets", "--image-uri", CURRENT, "--image-uri", PREVIOUS, "--bucket", BUCKET]
                if execute:
                    arguments.append("--execute")
                with patch.object(sys, "argv", arguments), \
                        patch.object(self.module, "prepare_assets", return_value=bundle), \
                        patch.object(self.module, "connect", return_value=session) as connect, \
                        patch.object(self.module, "emit", output.append):
                    self.module.main()
                self.assertEqual(output[0]["status"], "published" if execute else "prepared")
                self.assertEqual(connect.call_count, 1 if execute else 0)
                self.assertEqual(bool(self.s3.writes), execute)


if __name__ == "__main__":
    unittest.main()
