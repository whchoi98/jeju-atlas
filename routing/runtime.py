"""Build-time configuration for the pinned, offline Jeju routing image."""
from copy import deepcopy
from datetime import datetime
import argparse
import hashlib
import json
from pathlib import Path
import re

ENGINE_VERSION = "3.8.3"
BASE_IMAGE = "ghcr.io/valhalla/valhalla@sha256:58c7dd3fb256f306b00c558fb76aea9fd4fb804edd831e2b4847c26511cca507"
DATA_ROOT = Path("/opt/routing/data")
CONFIG_PATH = Path("/opt/routing/valhalla.json")
REQUIRED_FILES = ("valhalla_tiles.tar", "admin.sqlite", "elevation_data/N33/N33E126.hgt")


class ArtifactError(ValueError):
    pass


def data_updated_at(value):
    if value is None or value == "":
        return ""
    if not isinstance(value, str) or len(value) > 40:
        raise ArtifactError("Invalid routing source timestamp")
    try:
        date = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if date.tzinfo is None:
            raise ValueError()
    except ValueError:
        raise ArtifactError("Invalid routing source timestamp") from None
    return value


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_artifacts(data_root=DATA_ROOT, *, verify_hashes=True):
    root = Path(data_root)
    manifest = root / "source.json"
    if manifest.is_symlink() or not manifest.is_file() or not 0 < manifest.stat().st_size <= 1024 * 1024:
        raise ArtifactError("Routing source manifest is missing or oversized")
    source = json.loads(manifest.read_text())
    if not isinstance(source, dict) or source.get("version") != 1:
        raise ArtifactError("Unsupported routing source manifest")
    engine = source.get("engine", {})
    if engine.get("version") != ENGINE_VERSION or engine.get("base_image") != BASE_IMAGE:
        raise ArtifactError("Graph and runtime must use the same pinned Valhalla image")
    data_updated_at(source.get("data_updated_at"))
    names = [*REQUIRED_FILES]
    if (root / "timezones.sqlite").exists() or (root / "timezones.sqlite").is_symlink():
        names.append("timezones.sqlite")
    for name in names:
        path = root / name
        metadata = source.get("files", {}).get(name, {})
        if (path.is_symlink() or any(parent.is_symlink() for parent in path.parents if parent != root.parent)
                or not path.is_file() or path.stat().st_size <= 0
                or metadata.get("bytes") != path.stat().st_size
                or not re.fullmatch(r"[a-f0-9]{64}", str(metadata.get("sha256", "")))):
            raise ArtifactError("Routing artifact is missing or inconsistent")
        if verify_hashes and file_hash(path) != metadata["sha256"]:
            raise ArtifactError("Routing artifact checksum differs from its source manifest")
    return source


def configure(defaults, data_root=DATA_ROOT):
    root = Path(data_root)
    validate_artifacts(root)
    config = deepcopy(defaults)
    config["logging"] = {"type": "", "color": False}
    mjolnir = config.setdefault("mjolnir", {})
    for key in ("tile_url", "tile_url_gz", "tile_url_user_pw", "incident_dir", "incident_log", "landmarks", "timezone"):
        mjolnir.pop(key, None)
    mjolnir.update({
        "tile_extract": str(root / "valhalla_tiles.tar"), "tile_dir": str(root / "tiles"),
        "admin": str(root / "admin.sqlite"), "traffic_extract": "",
        "max_cache_size": 64 * 1024 * 1024, "use_lru_mem_cache": True,
        "lru_mem_cache_hard_control": True, "use_simple_mem_cache": False,
        "global_synchronized_cache": False, "max_concurrent_reader_users": 1,
    })
    if (root / "timezones.sqlite").is_file():
        mjolnir["timezone"] = str(root / "timezones.sqlite")
    elevation = config.setdefault("additional_data", {})
    elevation.pop("elevation_url", None)
    elevation.pop("elevation_url_user_pw", None)
    elevation["elevation"] = str(root / "elevation_data")
    config.setdefault("loki", {}).update({"actions": ["route", "height", "status"],
                                          "service": {"proxy": "ipc:///tmp/routing-loki"}})
    config.setdefault("thor", {})["service"] = {"proxy": "ipc:///tmp/routing-thor"}
    config.setdefault("odin", {})["service"] = {"proxy": "ipc:///tmp/routing-odin"}
    for suffix in ("astar", "bidir_astar", "dijkstras", "bidir_dijkstras"):
        config["thor"]["max_reserved_labels_count_" + suffix] = 250000
    config.setdefault("httpd", {})["service"] = {
        "listen": "tcp://127.0.0.1:8002", "loopback": "ipc:///tmp/routing-loopback",
        "interrupt": "ipc:///tmp/routing-interrupt", "drain_seconds": 25,
        "shutdown_seconds": 5, "timeout_seconds": 15,
    }
    limits = config.setdefault("service_limits", {})
    for mode in ("auto", "pedestrian"):
        limits.setdefault(mode, {}).update({"max_locations": 12, "max_distance": 1200000})
    limits.setdefault("skadi", {}).update({"max_shape": 2048, "min_resample": 10.0})
    limits["status"] = {"allow_verbose": True}
    return config


def seal_artifacts(data_root=DATA_ROOT):
    root = Path(data_root)
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ArtifactError("Routing artifacts cannot be symlinks")
        path.chmod(0o555 if path.is_dir() else 0o444)
    root.chmod(0o555)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--defaults", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=CONFIG_PATH)
    parser.add_argument("--seal", action="store_true")
    args = parser.parse_args()
    config = configure(json.loads(args.defaults.read_text()))
    args.output.write_text(json.dumps(config, sort_keys=True, indent=2) + "\n")
    if args.seal:
        seal_artifacts()
        args.output.chmod(0o444)


if __name__ == "__main__":
    main()
