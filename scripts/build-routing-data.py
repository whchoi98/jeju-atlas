#!/usr/bin/env python3
"""Build a verified Jeju road graph locally. No AWS credentials or APIs are used."""

import argparse
from contextlib import closing
from datetime import datetime, timezone
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import subprocess
import sys
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
INPUT_KIND = "jeju-atlas-pre-extracted-osm/v1"
ADMIN_INPUT_KIND = "jeju-atlas-pre-extracted-osm/v2"
MAX_ADMIN_BYTES = 64 * 1024 * 1024


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


def regular_input(path, limit):
    path = Path(path).expanduser().absolute()
    if any(part.is_symlink() for part in (path, *path.parents)):
        raise ValueError("Shared routing input must be a regular file, without symlinks")
    if not path.is_file():
        raise FileNotFoundError(f"Shared routing input is missing: {path}")
    if not 0 < path.stat().st_size <= limit:
        raise ValueError("Shared routing input size is invalid")
    return path


def verify_input_checksums(directory, metadata_path):
    if metadata_path.parent != directory or metadata_path.name != "jeju-input.json":
        raise ValueError("Keep the v2 bundle files and jeju-input.json together")
    sums = regular_input(directory / "SHA256SUMS", 64 * 1024)
    allowed = {"jeju.osm.pbf", "admin.sqlite", "jeju-input.json", "README.txt",
               "PROVENANCE.json", "admin-build.json"}
    seen = set()
    for line in sums.read_text().splitlines():
        match = re.fullmatch(r"([a-f0-9]{64}) [ *]([A-Za-z0-9._-]+)", line)
        if not match or match[2] not in allowed or match[2] in seen:
            raise ValueError("Invalid shared bundle checksum list")
        seen.add(match[2])
        limit = MAX_PBF_BYTES if match[2].endswith(".pbf") else MAX_ADMIN_BYTES
        file = regular_input(directory / match[2], limit)
        if file_digest(file) != match[1]:
            raise ValueError("Shared bundle checksum mismatch: " + match[2])
    if not {"jeju.osm.pbf", "admin.sqlite", "jeju-input.json"}.issubset(seen):
        raise ValueError("Shared bundle checksum list is incomplete")


def admin_summary(path):
    path = regular_input(path, MAX_ADMIN_BYTES)
    try:
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True)) as database:
            database.execute("PRAGMA trusted_schema=OFF")
            if database.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                raise ValueError("Shared admin database integrity check failed")
            table = database.execute(
                "SELECT type FROM sqlite_master WHERE name='admins'"
            ).fetchone()
            if table != ("table",):
                raise ValueError("Shared admin database has no admins table")
            counts = {str(level): count for level, count in database.execute(
                "SELECT admin_level, COUNT(*) FROM admins GROUP BY admin_level"
            )}
            korea = database.execute(
                "SELECT COUNT(*) FROM admins WHERE admin_level=2 AND iso_code='KR'"
            ).fetchone()[0]
            jeju = database.execute(
                "SELECT COUNT(*) FROM admins WHERE admin_level=4 "
                "AND (name='제주특별자치도' OR name_en='Jeju')"
            ).fetchone()[0]
            empty = database.execute(
                "SELECT COUNT(*) FROM admins WHERE geom IS NULL OR length(geom)=0"
            ).fetchone()[0]
    except sqlite3.Error as error:
        raise ValueError("Shared admin database cannot be read") from error
    if not korea or not jeju or empty:
        raise ValueError("Shared admin database must contain Korea and Jeju with nonempty geometry")
    return counts


def read_shared_admin(directory, value, pbf_metadata):
    if not isinstance(value, dict) or value.get("file") != "admin.sqlite":
        raise ValueError("Shared admin metadata is missing")
    if (value.get("osmTimestamp") != pbf_metadata["osmTimestamp"]
            or value.get("sourceSha256") != pbf_metadata["originalSource"]["sha256"]):
        raise ValueError("Shared admin and Jeju PBF must use the same national snapshot")
    engine = value.get("engine")
    expected_engine = {"name": "Valhalla", "version": "3.8.3",
                       "base_image": VALHALLA_IMAGE, "platform": "linux/arm64"}
    if engine != expected_engine:
        raise ValueError("Shared admin engine or platform does not match this workshop")
    admin = regular_input(directory / "admin.sqlite", MAX_ADMIN_BYTES)
    if (type(value.get("bytes")) is not int or value["bytes"] != admin.stat().st_size
            or not isinstance(value.get("sha256"), str)
            or file_digest(admin) != value["sha256"]):
        raise ValueError("Shared admin size or checksum is invalid")
    counts = value.get("adminLevelCounts")
    if (not isinstance(counts, dict) or not counts
            or any(type(count) is not int or count < 1 for count in counts.values())
            or admin_summary(admin) != counts):
        raise ValueError("Shared admin counts do not match the provided database")
    return {key: value[key] for key in (
        "file", "bytes", "sha256", "osmTimestamp", "sourceSha256", "engine", "adminLevelCounts",
    )}


def read_jeju_input(pbf, metadata_path=None):
    pbf = regular_input(pbf, MAX_PBF_BYTES)
    metadata_path = regular_input(metadata_path or pbf.with_name("jeju-input.json"), 1024 * 1024)
    value = json.loads(metadata_path.read_text())
    if (not isinstance(value, dict) or value.get("kind") not in (INPUT_KIND, ADMIN_INPUT_KIND)
            or value.get("file") != "jeju.osm.pbf"):
        raise ValueError("Unsupported shared Jeju input metadata")
    if value["kind"] == ADMIN_INPUT_KIND:
        verify_input_checksums(pbf.parent, metadata_path)
    if value.get("bounds") != BOUNDS:
        raise ValueError("Shared Jeju input bounds do not match this workshop")
    validate_osm_timestamp(value.get("osmTimestamp"))
    size = value.get("bytes")
    digest = value.get("sha256")
    if (type(size) is not int or size != pbf.stat().st_size
            or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)
            or file_digest(pbf) != digest):
        raise ValueError("Shared Jeju PBF size or checksum does not match its metadata")
    origin = value.get("originalSource")
    if (not isinstance(origin, dict) or not isinstance(origin.get("url"), str)
            or not origin["url"].endswith(".osm.pbf") or not trusted_source(origin["url"])
            or not isinstance(origin.get("sha256"), str)
            or not re.fullmatch(r"[a-f0-9]{64}", origin["sha256"])
            or not isinstance(origin.get("md5"), str)
            or not re.fullmatch(r"[a-f0-9]{32}", origin["md5"])):
        raise ValueError("Shared Jeju input original source metadata is invalid")
    if (value.get("license") != "ODbL-1.0"
            or value.get("licenseUrl") != "https://www.openstreetmap.org/copyright"
            or value.get("attribution") != "© OpenStreetMap contributors"):
        raise ValueError("Shared Jeju input must retain its OSM attribution and license")
    result = {
        "kind": value["kind"], "file": "jeju.osm.pbf", "bytes": size, "sha256": digest,
        "osmTimestamp": value["osmTimestamp"], "bounds": list(BOUNDS),
        "originalSource": {key: origin[key] for key in ("url", "sha256", "md5")},
        "attribution": value["attribution"], "license": value["license"],
        "licenseUrl": value["licenseUrl"],
    }
    if value["kind"] == ADMIN_INPUT_KIND:
        result["admin"] = read_shared_admin(pbf.parent, value.get("admin"), result)
    elif "admin" in value:
        raise ValueError("Shared admin inputs require v2 metadata")
    return pbf, result


def check_existing_input(target, metadata, label="Jeju PBF"):
    if target.is_symlink():
        raise ValueError(f"Existing {label} cannot be a symlink")
    if target.exists():
        if (not target.is_file() or target.stat().st_size != metadata["bytes"]
                or file_digest(target) != metadata["sha256"]):
            raise ValueError(f"Existing {label} differs from the shared input; preserve it and select the matching input")
        return True
    return False


def stage_input_file(source_path, target, metadata, label="Jeju PBF"):
    """Publish a checked input without replacing an existing participant file."""
    root = target.parent
    root.mkdir(parents=True, exist_ok=True)
    if not check_existing_input(target, metadata, label):
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(prefix=".jeju-input-", dir=root, delete=False) as output:
                temporary = Path(output.name)
                with source_path.open("rb") as source:
                    shutil.copyfileobj(source, output, 1024 * 1024)
                output.flush()
                os.fsync(output.fileno())
            if temporary.stat().st_size != metadata["bytes"] or file_digest(temporary) != metadata["sha256"]:
                raise ValueError(f"Shared {label} changed while being copied")
            try:
                os.link(temporary, target)
            except FileExistsError:
                check_existing_input(target, metadata, label)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)


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
    result = {
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
    if "input" in metadata:
        result["input"] = metadata["input"]
        result["admin_source"] = metadata["admin_source"]
    return result


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
    elevation_meta = fetch_elevation(root, cached.get("elevation", {}))
    metadata = {"pbf": pbf_meta, "elevation": elevation_meta}
    write_json(previous, metadata)
    print(json.dumps({"event": "sources_verified", "osm_bytes": pbf_meta["bytes"], "osm_sha256": pbf_meta["sha256"]}), flush=True)
    return metadata


def fetch_elevation(root, cached=None):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    elevation = root / "N33E126.hgt.gz"
    elevation_meta = cached or {}
    if not elevation.is_file() or file_digest(elevation) != elevation_meta.get("sha256"):
        elevation_meta = download(ELEVATION_URL, elevation, 32 * 1024 * 1024)
    decompress_elevation(elevation, root / "elevation_data/N33/N33E126.hgt")
    return elevation_meta


def docker_command(root, command, capture=False, timeout=1200):
    argv = [
        "docker", "run", "--rm", "--network", "none", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--user", f"{os.getuid()}:{os.getgid()}",
        "--mount", f"type=bind,src={Path(root).resolve()},dst=/data",
        "--workdir", "/data", "--entrypoint", command[0], BUILDER_IMAGE, *command[1:],
    ]
    completed = subprocess.run(argv, check=True, stdout=subprocess.PIPE if capture else None, timeout=timeout)
    return completed.stdout if capture else None


def verify_shared_object_time(root, shared):
    details = json.loads(docker_command(
        root, ["osmium", "fileinfo", "--extended", "--json", "/data/jeju.osm.pbf"], capture=True,
    ))
    info = details.get("data", {})
    timestamp = info.get("timestamp", {}).get("last")
    validate_osm_timestamp(timestamp)
    if info.get("metadata", {}).get("all_objects", {}).get("timestamp") is not True:
        raise ValueError("Shared PBF objects do not all have a verifiable timestamp")
    if timestamp > shared["osmTimestamp"]:
        raise ValueError("Shared PBF object timestamp is later than its declared snapshot")
    return timestamp


def build_graph(root, threads, *, jeju_pbf=None, input_metadata=None, project_root=None):
    root = Path(root).expanduser().absolute()
    if not 1 <= threads <= 16:
        raise ValueError("Build threads must be between 1 and 16")
    if input_metadata is not None and jeju_pbf is None:
        raise ValueError("Input metadata requires a shared Jeju PBF")
    if any(part.is_symlink() for part in (root, *root.parents)):
        raise ValueError("Routing output cannot use a symlink")
    project_root = Path(project_root or ROOT).resolve()
    if not (project_root / "Dockerfile.routing-builder").is_file():
        raise FileNotFoundError("Routing builder Dockerfile is missing from the selected project")
    shared = None
    shared_admin = None
    if jeju_pbf is not None:
        pbf, shared = read_jeju_input(jeju_pbf, input_metadata)
        shared_admin = shared.get("admin")
        if shared_admin:
            bases = re.findall(
                r"(?im)^\s*FROM\s+(\S+)(?:\s+AS\s+\S+)?\s*$",
                (project_root / "Dockerfile.routing-builder").read_text(),
            )
            if bases != [VALHALLA_IMAGE]:
                raise ValueError("Routing builder engine base differs from the shared admin snapshot")
        check_existing_input(root / "jeju.osm.pbf", shared)
        if shared_admin:
            check_existing_input(root / "admin.sqlite", shared_admin, "admin database")
        stage_input_file(pbf, root / "jeju.osm.pbf", shared)
        print(json.dumps({
            "event": "jeju_extract_skipped", "file": "jeju.osm.pbf",
            "bytes": shared["bytes"], "sha256": shared["sha256"],
            "osm_timestamp": shared["osmTimestamp"],
        }), flush=True)
        if shared_admin:
            stage_input_file(pbf.parent / "admin.sqlite", root / "admin.sqlite",
                             shared_admin, "admin database")
            previous = root / "downloads.json"
            cached = json.loads(previous.read_text()) if previous.exists() else {}
            elevation = fetch_elevation(root, cached.get("elevation", {}))
            write_json(previous, {**cached, "elevation": elevation})
            print(json.dumps({"event": "admin_build_skipped",
                              "adminLevelCounts": shared_admin["adminLevelCounts"],
                              "sha256": shared_admin["sha256"]}), flush=True)
        else:
            # v1 bundles lack admins, so retain the national-source path.
            fetch_sources(root)
    downloads = json.loads((root / "downloads.json").read_text())
    if shared_admin is None:
        if "pbf" not in downloads or not (root / "south-korea.osm.pbf").is_file():
            raise ValueError("National OSM input is missing; keep --jeju-pbf or run routing-fetch for a direct build")
        if file_digest(root / "south-korea.osm.pbf") != downloads["pbf"]["sha256"]:
            raise ValueError("OSM source checksum mismatch")
    subprocess.run([
        "docker", "build", "-f", str(project_root / "Dockerfile.routing-builder"),
        "-t", BUILDER_IMAGE, str(project_root),
    ], check=True, timeout=600)
    if shared_admin is None:
        timestamp = docker_command(root, [
            "osmium", "fileinfo", "-g", "header.option.osmosis_replication_timestamp", "/data/south-korea.osm.pbf",
        ], capture=True).decode().strip()
        validate_osm_timestamp(timestamp)
    else:
        timestamp = shared["osmTimestamp"]
    object_timestamp = verify_shared_object_time(root, shared) if shared else None
    if shared is None:
        docker_command(root, [
            "osmium", "extract", "--bbox", ",".join(str(value) for value in BOUNDS),
            "--strategy", "complete_ways", "--overwrite", "-o", "/data/jeju.osm.pbf", "/data/south-korea.osm.pbf",
        ])
    else:
        if not check_existing_input(root / "jeju.osm.pbf", shared):
            raise FileNotFoundError("Shared Jeju PBF disappeared before tile building")
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
    if shared_admin is None:
        docker_command(root, ["valhalla_build_admins", "-c", "/data/build.json", "/data/south-korea.osm.pbf"])
    docker_command(root, ["valhalla_build_tiles", "-c", "/data/build.json", "/data/jeju.osm.pbf"])
    docker_command(root, ["valhalla_build_extract", "-c", "/data/build.json"])
    metadata = {
        "osm_timestamp": timestamp,
        "source_url": shared["originalSource"]["url"] if shared_admin else PBF_URL,
        "source_sha256": shared["originalSource"]["sha256"] if shared_admin else downloads["pbf"]["sha256"],
        "source_md5": shared["originalSource"]["md5"] if shared_admin else downloads["pbf"]["md5"],
        "elevation_last_modified": downloads["elevation"].get("last_modified"),
    }
    if shared is not None:
        # The imported extract's date must not become today's admin-source date.
        metadata["admin_source"] = {key: metadata[key] for key in (
            "osm_timestamp", "source_url", "source_sha256", "source_md5",
        )}
        if shared_admin:
            metadata["admin_source"].update(
                reused=True, verification="shared-file-hash-and-admin-rows",
            )
        metadata.update({
            "osm_timestamp": shared["osmTimestamp"],
            "source_url": shared["originalSource"]["url"],
            "source_sha256": shared["originalSource"]["sha256"],
            "source_md5": shared["originalSource"]["md5"],
            "input": {"mode": "pre-extracted", "sha256": shared["sha256"], "bytes": shared["bytes"],
                      "maxObjectTimestamp": object_timestamp},
        })
        if not check_existing_input(root / "jeju.osm.pbf", shared):
            raise FileNotFoundError("Shared Jeju PBF disappeared during building")
        if shared_admin:
            if not check_existing_input(root / "admin.sqlite", shared_admin, "admin database"):
                raise FileNotFoundError("Shared admin database disappeared during building")
            metadata["input"]["admin"] = {key: shared_admin[key] for key in (
                "sha256", "bytes", "adminLevelCounts",
            )}
    manifest = make_manifest(root, metadata)
    verify_manifest(root, manifest)
    write_json(root / "source.json", manifest)
    print(json.dumps({"event": "graph_verified", "osm_timestamp": metadata["osm_timestamp"],
                      "files": manifest["files"]}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["fetch", "build", "verify"])
    parser.add_argument("--output", type=Path)
    parser.add_argument("--project-root", type=Path, default=ROOT,
                        help="Project containing Dockerfile.routing-builder; output stays in this project by default")
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--jeju-pbf", type=Path, help="Reuse a facilitator-provided Jeju extract; do not run osmium extract")
    parser.add_argument("--input-metadata", type=Path, help="Defaults to jeju-input.json beside the shared PBF")
    args = parser.parse_args()
    if (args.jeju_pbf or args.input_metadata) and args.action != "build":
        parser.error("Shared Jeju input options apply only to build")
    if args.input_metadata and not args.jeju_pbf:
        parser.error("--input-metadata requires --jeju-pbf")
    output = args.output or args.project_root / ".local/routing-data"
    if args.action == "fetch":
        fetch_sources(output)
    elif args.action == "build":
        build_graph(output, args.threads, jeju_pbf=args.jeju_pbf,
                    input_metadata=args.input_metadata, project_root=args.project_root)
    else:
        verify_manifest(output, json.loads((output / "source.json").read_text()))
        print(json.dumps({"verified": True}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, FileNotFoundError, FileExistsError) as error:
        print("Routing build: " + str(error), file=sys.stderr)
        raise SystemExit(2) from None
