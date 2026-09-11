#!/usr/bin/env python3
"""Build a verified Jeju road graph locally. No AWS credentials or APIs are used."""

import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tempfile
import urllib.parse
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
PBF_URL = "https://download.geofabrik.de/asia/south-korea-latest.osm.pbf"
ELEVATION_URL = "https://s3.amazonaws.com/elevation-tiles-prod/skadi/N33/N33E126.hgt.gz"
VALHALLA_IMAGE = "ghcr.io/valhalla/valhalla@sha256:58c7dd3fb256f306b00c558fb76aea9fd4fb804edd831e2b4847c26511cca507"
BUILDER_IMAGE = "jeju-atlas-routing-builder:3.8.3"
BOUNDS = [126.1, 33.0, 127.05, 33.75]
MAX_PBF_BYTES = 450 * 1024 * 1024
HGT_BYTES = 3601 * 3601 * 2
REQUIRED_FILES = ["jeju.osm.pbf", "valhalla_tiles.tar", "elevation_data/N33/N33E126.hgt"]
OPTIONAL_FILES = ["admin.sqlite", "timezones.sqlite"]


def trusted_source(url):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.query or parsed.fragment:
        return False
    if parsed.port not in (None, 443):
        return False
    if re.fullmatch(r"download[0-9]*\.geofabrik\.de", parsed.hostname or ""):
        return bool(re.fullmatch(r"/asia/south-korea-(?:latest|\d{6})\.osm\.pbf(?:\.md5)?", parsed.path))
    return url == ELEVATION_URL


class SourceRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        if not trusted_source(newurl):
            raise ValueError("Untrusted download source redirect")
        return super().redirect_request(request, fp, code, message, headers, newurl)


def source_opener(request, timeout):
    return urllib.request.build_opener(SourceRedirects()).open(request, timeout=timeout)


def file_digest(path, algorithm="sha256"):
    digest = hashlib.new(algorithm)
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url, target, max_bytes, expected_md5=None, opener=source_opener):
    if not trusted_source(url):
        raise ValueError("Untrusted download source")
    if expected_md5 is not None and not re.fullmatch(r"[a-f0-9]{32}", expected_md5):
        raise ValueError("Invalid expected checksum")
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={
        "Accept-Encoding": "identity",
        "User-Agent": "JejuAtlasRoutingBuild/1.0",
    })
    temporary = None
    try:
        with opener(request, timeout=45) as response:
            if not trusted_source(response.geturl()):
                raise ValueError("Untrusted download source")
            declared = response.headers.get("Content-Length")
            if declared and int(declared) > max_bytes:
                raise ValueError("Download exceeds byte limit")
            sha256 = hashlib.sha256()
            md5 = hashlib.md5()
            size = 0
            with tempfile.NamedTemporaryFile(prefix=f".{target.name}.", dir=target.parent, delete=False) as output:
                temporary = Path(output.name)
                while True:
                    chunk = response.read(min(1024 * 1024, max_bytes - size + 1))
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > max_bytes:
                        raise ValueError("Download exceeds byte limit")
                    output.write(chunk)
                    sha256.update(chunk)
                    md5.update(chunk)
                output.flush()
                os.fsync(output.fileno())
            if size == 0 or (declared and size != int(declared)):
                raise ValueError("Download size is incomplete")
            if expected_md5 and md5.hexdigest() != expected_md5:
                raise ValueError("Download checksum does not match")
            metadata = {
                "url": url, "bytes": size, "sha256": sha256.hexdigest(),
                "md5": md5.hexdigest(), "last_modified": response.headers.get("Last-Modified"),
            }
        temporary.replace(target)
        temporary = None
        return metadata
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def decompress_elevation(source, target, expected_bytes=HGT_BYTES):
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with gzip.open(source, "rb") as compressed, tempfile.NamedTemporaryFile(
            prefix=f".{target.name}.", dir=target.parent, delete=False,
        ) as output:
            temporary = Path(output.name)
            size = 0
            while True:
                chunk = compressed.read(min(1024 * 1024, expected_bytes - size + 1))
                if not chunk:
                    break
                size += len(chunk)
                if size > expected_bytes:
                    raise ValueError("Elevation tile size is invalid")
                output.write(chunk)
            if size != expected_bytes:
                raise ValueError("Elevation tile size is invalid")
        temporary.replace(target)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def validate_osm_timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", value):
        raise ValueError("OSM source timestamp is unavailable")
    stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if stamp.year < 2004 or stamp > datetime.now(timezone.utc):
        raise ValueError("OSM source timestamp is invalid")
    return value


def make_manifest(root, metadata):
    root = Path(root)
    timestamp = validate_osm_timestamp(metadata.get("osm_timestamp"))
    source_url = metadata.get("source_url")
    if not trusted_source(source_url or ""):
        raise ValueError("Invalid manifest source")
    files = {}
    for relative in REQUIRED_FILES + [name for name in OPTIONAL_FILES if (root / name).is_file()]:
        path = root / relative
        if not path.is_file() or path.is_symlink() or path.stat().st_size == 0:
            raise ValueError(f"Required graph artifact missing: {relative}")
        files[relative] = {"sha256": file_digest(path), "bytes": path.stat().st_size}
    return {
        "version": 1,
        "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "osm_timestamp": timestamp,
        "data_updated_at": timestamp,
        "source_url": source_url,
        "source_sha256": metadata["source_sha256"],
        "source_md5": metadata["source_md5"],
        "bounds": BOUNDS,
        "engine": {"name": "Valhalla", "version": "3.8.3", "base_image": VALHALLA_IMAGE},
        "attribution": "© OpenStreetMap contributors",
        "license": "ODbL-1.0",
        "license_url": "https://www.openstreetmap.org/copyright",
        "elevation": {
            "source": "Mapzen / AWS elevation tiles",
            "url": ELEVATION_URL,
            "attribution_url": "https://github.com/tilezen/joerd/blob/master/docs/attribution.md",
            "tile": "N33E126",
            "source_last_modified": metadata.get("elevation_last_modified"),
            "note": "DEM terrain height; not surveyed entrance height or current construction.",
        },
        "files": files,
    }


def verify_manifest(root, manifest):
    root = Path(root).resolve()
    files = manifest.get("files")
    if not isinstance(files, dict) or not files:
        raise ValueError("Graph artifact list missing")
    for relative, expected in files.items():
        path_parts = PurePosixPath(relative)
        if (path_parts.is_absolute() or ".." in path_parts.parts or "\\" in relative
                or str(path_parts) != relative or relative not in REQUIRED_FILES + OPTIONAL_FILES):
            raise ValueError("Invalid graph artifact path")
        path = root / relative
        if not path.is_file() or path.is_symlink() or root not in path.resolve().parents:
            raise ValueError(f"Graph artifact missing: {relative}")
        if path.stat().st_size != expected.get("bytes") or file_digest(path) != expected.get("sha256"):
            raise ValueError(f"Graph artifact checksum mismatch: {relative}")
    if not set(REQUIRED_FILES).issubset(files):
        raise ValueError("Required graph artifact missing")
    return True


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def read_provider_md5(url):
    request = urllib.request.Request(url + ".md5", headers={"Accept-Encoding": "identity"})
    with source_opener(request, timeout=30) as response:
        text = response.read(1025).decode("ascii").strip()
    if len(text) > 1024 or not re.fullmatch(r"[a-f0-9]{32}\s+\S+\.osm\.pbf", text):
        raise ValueError("Provider checksum is invalid")
    return text.split()[0]


def fetch_sources(root):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    expected = read_provider_md5(PBF_URL)
    pbf = root / "south-korea.osm.pbf"
    previous = root / "downloads.json"
    cached = json.loads(previous.read_text()) if previous.is_file() else {}
    if (pbf.is_file() and cached.get("pbf", {}).get("md5") == expected
            and file_digest(pbf, "md5") == expected):
        pbf_meta = cached["pbf"]
    else:
        print(json.dumps({"event": "download_osm", "max_bytes": MAX_PBF_BYTES}), flush=True)
        pbf_meta = download(PBF_URL, pbf, MAX_PBF_BYTES, expected_md5=expected)
    if read_provider_md5(PBF_URL) != expected:
        raise ValueError("Provider source changed during download; retry to pin a consistent snapshot")
    elevation = root / "N33E126.hgt.gz"
    elevation_meta = cached.get("elevation", {})
    if not elevation.is_file() or file_digest(elevation) != elevation_meta.get("sha256"):
        elevation_meta = download(ELEVATION_URL, elevation, 32 * 1024 * 1024)
    decompress_elevation(elevation, root / "elevation_data/N33/N33E126.hgt")
    metadata = {"pbf": pbf_meta, "elevation": elevation_meta}
    write_json(previous, metadata)
    print(json.dumps({"event": "sources_verified", "osm_bytes": pbf_meta["bytes"], "osm_sha256": pbf_meta["sha256"]}), flush=True)
    return metadata


def docker_command(root, command, capture=False, timeout=1200):
    argv = [
        "docker", "run", "--rm", "--network", "none", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--user", f"{os.getuid()}:{os.getgid()}",
        "--mount", f"type=bind,src={Path(root).resolve()},dst=/data",
        "--workdir", "/data", "--entrypoint", command[0], BUILDER_IMAGE, *command[1:],
    ]
    completed = subprocess.run(argv, check=True, stdout=subprocess.PIPE if capture else None, timeout=timeout)
    return completed.stdout if capture else None


def build_graph(root, threads):
    root = Path(root).resolve()
    if not 1 <= threads <= 16:
        raise ValueError("Build threads must be between 1 and 16")
    downloads = json.loads((root / "downloads.json").read_text())
    if file_digest(root / "south-korea.osm.pbf") != downloads["pbf"]["sha256"]:
        raise ValueError("OSM source checksum mismatch")
    subprocess.run([
        "docker", "build", "-f", str(ROOT / "Dockerfile.routing-builder"),
        "-t", BUILDER_IMAGE, str(ROOT),
    ], check=True, timeout=600)
    timestamp = docker_command(root, [
        "osmium", "fileinfo", "-g", "header.option.osmosis_replication_timestamp", "/data/south-korea.osm.pbf",
    ], capture=True).decode().strip()
    validate_osm_timestamp(timestamp)
    docker_command(root, [
        "osmium", "extract", "--bbox", ",".join(str(value) for value in BOUNDS),
        "--strategy", "complete_ways", "--overwrite", "-o", "/data/jeju.osm.pbf", "/data/south-korea.osm.pbf",
    ])
    config = json.loads(docker_command(root, [
        "valhalla_build_config", "--mjolnir-tile-dir", "/data/valhalla_tiles",
        "--mjolnir-tile-extract", "/data/valhalla_tiles.tar",
        "--mjolnir-admin", "/data/admin.sqlite",
        "--mjolnir-timezone", "/data/timezones.sqlite",
        "--additional-data-elevation", "/data/elevation_data",
    ], capture=True))
    config["mjolnir"]["concurrency"] = threads
    write_json(root / "build.json", config)
    # Administrative boundaries need the complete national source, not clipped polygons.
    docker_command(root, ["valhalla_build_admins", "-c", "/data/build.json", "/data/south-korea.osm.pbf"])
    docker_command(root, ["valhalla_build_tiles", "-c", "/data/build.json", "/data/jeju.osm.pbf"])
    docker_command(root, ["valhalla_build_extract", "-c", "/data/build.json"])
    metadata = {
        "osm_timestamp": timestamp,
        "source_url": PBF_URL,
        "source_sha256": downloads["pbf"]["sha256"],
        "source_md5": downloads["pbf"]["md5"],
        "elevation_last_modified": downloads["elevation"].get("last_modified"),
    }
    manifest = make_manifest(root, metadata)
    verify_manifest(root, manifest)
    write_json(root / "source.json", manifest)
    print(json.dumps({"event": "graph_verified", "osm_timestamp": timestamp, "files": manifest["files"]}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["fetch", "build", "verify"])
    parser.add_argument("--output", type=Path, default=ROOT / ".local/routing-data")
    parser.add_argument("--threads", type=int, default=8)
    args = parser.parse_args()
    if args.action == "fetch":
        fetch_sources(args.output)
    elif args.action == "build":
        build_graph(args.output, args.threads)
    else:
        verify_manifest(args.output, json.loads((args.output / "source.json").read_text()))
        print(json.dumps({"verified": True}))


if __name__ == "__main__":
    main()
