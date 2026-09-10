#!/usr/bin/env python3
"""Prepare immutable web assets from cached Docker digests; upload only with --execute."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import tempfile
import threading
from types import SimpleNamespace

from botocore.config import Config
from botocore.exceptions import ClientError
from deploy import ACCOUNT, REGION, connect, emit

REPOSITORY = f"{ACCOUNT}.dkr.ecr.{REGION}.amazonaws.com/jeju-3d"
ASSETS_BUCKET = f"jeju-3d-assets-{ACCOUNT}-{REGION}"
MAX_IMAGES = 8
MAX_FILES = 1024
MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_TOTAL_BYTES = 128 * 1024 * 1024
MAX_ENTRIES = 4096
PUBLIC_CACHE = "public, max-age=31536000, immutable"
CONTENT_TYPES = {
    ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
    ".wasm": "application/wasm", ".woff": "font/woff", ".woff2": "font/woff2",
    ".ttf": "font/ttf", ".otf": "font/otf", ".svg": "image/svg+xml",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
}


class AssetError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise AssetError(message)


def validate_inputs(image_uris, bucket):
    require(bucket == ASSETS_BUCKET, "Only the owned assets bucket is allowed")
    require(isinstance(image_uris, (list, tuple)) and 1 <= len(image_uris) <= MAX_IMAGES,
            "Provide between one and eight immutable image URIs")
    pattern = re.escape(REPOSITORY) + r"@sha256:[a-f0-9]{64}"
    require(all(isinstance(image, str) and re.fullmatch(pattern, image) for image in image_uris),
            "Images must be immutable digests in the owned ECR repository")
    return list(dict.fromkeys(image_uris))


class LimitedReader:
    def __init__(self, source, budget):
        self.source, self.budget = source, budget

    def read(self, size=-1):
        remaining = MAX_TOTAL_BYTES + MAX_ENTRIES * 1024 - self.budget["archiveBytes"]
        require(remaining >= 0, "Docker archive exceeds the byte limit")
        data = self.source.read(min(size if size >= 0 else remaining + 1, remaining + 1))
        self.budget["archiveBytes"] += len(data)
        require(len(data) <= remaining, "Docker archive exceeds the byte limit")
        return data


def extract_tar(source, directory, budget):
    assets = {}
    with tarfile.open(fileobj=LimitedReader(source, budget), mode="r|") as archive:
        for member in archive:
            budget["entries"] += 1
            require(budget["entries"] <= MAX_ENTRIES, "Docker archive has too many entries")
            path = PurePosixPath(member.name)
            require(not path.is_absolute() and len(member.name) <= 512
                    and all(re.fullmatch(r"[\w-][\w.-]*", part) for part in path.parts),
                    "Unsafe asset path in the Docker image")
            require(member.isdir() or member.isreg(), "Asset links and special files are forbidden")
            destination = directory.joinpath(*path.parts)
            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True)
                continue
            require(bool(path.parts), "An asset filename is required")
            content_type = CONTENT_TYPES.get(path.suffix.lower())
            require(content_type is not None, "Unsupported asset content type")
            budget["files"] += 1
            budget["bytes"] += member.size
            require(budget["files"] <= MAX_FILES and 0 <= member.size <= MAX_FILE_BYTES
                    and budget["bytes"] <= MAX_TOTAL_BYTES, "Asset file count or size limit exceeded")
            destination.parent.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256()
            size = 0
            body = archive.extractfile(member)
            require(body is not None, "Asset data is missing")
            with body, destination.open("xb") as output:
                while chunk := body.read(64 * 1024):
                    size += len(chunk)
                    require(size <= member.size, "Asset size differs from its archive header")
                    digest.update(chunk)
                    output.write(chunk)
            require(size == member.size, "Truncated Docker asset")
            key = "assets/" + path.as_posix()
            assets[key] = {"path": destination, "size": size, "sha256": digest.hexdigest(), "contentType": content_type}
    require(bool(assets), "Image has no publishable assets")
    return assets


def docker_assets(image, directory, budget, docker):
    def run(command):
        result = docker.run(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=30)
        require(result.returncode == 0, "Docker image inspection or extraction failed")
        return result.stdout.strip()

    digests = json.loads(run(["docker", "image", "inspect", "--format", "{{json .RepoDigests}}", image]))
    require(isinstance(digests, list) and image in digests, "The exact requested digest is not cached locally")
    identity = run(["docker", "create", "--pull=never", "--network", "none", "--read-only", image])
    require(re.fullmatch(r"[a-f0-9]{64}", identity) is not None, "Unexpected temporary Docker container identity")
    try:
        process = docker.popen(["docker", "cp", identity + ":/app/dist/assets/.", "-"],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        deadline = threading.Timer(60, process.kill)
        deadline.daemon = True
        deadline.start()
        try:
            assets = extract_tar(process.stdout, directory, budget)
            require(process.wait(timeout=5) == 0, "Docker asset export did not complete")
            return assets
        finally:
            deadline.cancel()
            if process.poll() is None:
                process.kill()
            process.stdout.close()
            process.wait(timeout=5)
    finally:
        run(["docker", "rm", "-f", "-v", identity])


def prepare_assets(image_uris, bucket, directory, *, docker=None):
    images = validate_inputs(image_uris, bucket)
    docker = docker or SimpleNamespace(run=subprocess.run, popen=subprocess.Popen)
    budget = {"files": 0, "bytes": 0, "entries": 0, "archiveBytes": 0}
    bundle = {"bucket": bucket, "assets": {}, "manifests": []}
    try:
        for image in images:
            digest = image.rsplit(":", 1)[1]
            root = Path(directory) / digest
            root.mkdir(parents=True, exist_ok=True, mode=0o700)
            assets = docker_assets(image, root, budget, docker)
            for key, asset in assets.items():
                previous = bundle["assets"].get(key)
                require(previous is None or all(previous[field] == asset[field] for field in ("sha256", "size", "contentType")),
                        "Images contain different bytes at the same immutable asset key")
                bundle["assets"].setdefault(key, asset)
            manifest = {"version": 1, "imageUri": image,
                        "assetsSHA": {key: asset["sha256"] for key, asset in sorted(assets.items())}}
            body = (json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode()
            require(len(body) <= 2 * 1024 * 1024, "Release manifest exceeds the size limit")
            bundle["manifests"].append({
                "key": f"releases/{digest}.json", "imageUri": image, "body": body,
                "sha256": hashlib.sha256(body).hexdigest(), "assetCount": len(assets),
            })
    except AssetError:
        raise
    except (OSError, ValueError, tarfile.TarError, subprocess.SubprocessError) as error:
        raise AssetError("Docker assets could not be safely extracted") from error
    return bundle


def put_immutable(s3, bucket, key, body, size, digest, content_type, cache_control):
    checksum = base64.b64encode(bytes.fromhex(digest)).decode()
    try:
        result = s3.put_object(Bucket=bucket, Key=key, Body=body, ContentLength=size,
                               ContentType=content_type, CacheControl=cache_control,
                               Metadata={"sha256": digest}, ChecksumAlgorithm="SHA256",
                               ChecksumSHA256=checksum, IfNoneMatch="*")
        require(result.get("ChecksumSHA256") == checksum, "S3 did not confirm the uploaded checksum")
    except ClientError as error:
        code = error.response.get("Error", {}).get("Code")
        status = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if code not in ("PreconditionFailed", "ConditionalRequestConflict") and status not in (409, 412):
            raise
        existing = s3.head_object(Bucket=bucket, Key=key, ChecksumMode="ENABLED")
        require(existing.get("Metadata", {}).get("sha256") == digest
                and existing.get("ChecksumSHA256") == checksum and existing.get("ContentLength") == size
                and existing.get("ContentType") == content_type and existing.get("CacheControl") == cache_control,
                "Immutable S3 object collision; existing bytes or headers differ")


def publish_assets(bundle, s3):
    require(bundle["bucket"] == ASSETS_BUCKET, "Unexpected assets bucket")
    for key, asset in sorted(bundle["assets"].items()):
        with asset["path"].open("rb") as body:
            put_immutable(s3, bundle["bucket"], key, body, asset["size"], asset["sha256"],
                          asset["contentType"], PUBLIC_CACHE)
    # Both images' entire asset union must exist before either private manifest is committed.
    for manifest in bundle["manifests"]:
        put_immutable(s3, bundle["bucket"], manifest["key"], manifest["body"], len(manifest["body"]),
                      manifest["sha256"], "application/json; charset=utf-8", "no-store")


def summary(bundle, executed):
    return {
        "status": "published" if executed else "prepared", "bucket": bundle["bucket"],
        "assetCount": len(bundle["assets"]), "bytes": sum(asset["size"] for asset in bundle["assets"].values()),
        "manifests": [{key: manifest[key] for key in ("imageUri", "key", "sha256", "assetCount")}
                      for manifest in bundle["manifests"]],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image-uri", action="append", required=True, help="Owned immutable ECR URI; repeat for bootstrap")
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--execute", action="store_true", help="Upload create-only objects after complete local validation")
    args = parser.parse_args()
    validate_inputs(args.image_uri, args.bucket)
    with tempfile.TemporaryDirectory(prefix="jeju-assets-") as directory:
        bundle = prepare_assets(args.image_uri, args.bucket, Path(directory))
        if args.execute:
            session = connect()
            s3 = session.client("s3", region_name=REGION,
                                config=Config(connect_timeout=3, read_timeout=15,
                                              retries={"total_max_attempts": 1, "mode": "standard"}))
            publish_assets(bundle, s3)
        emit(summary(bundle, args.execute))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"status": "failed", "error": str(error) if isinstance(error, AssetError) else type(error).__name__})
        raise SystemExit(1)
