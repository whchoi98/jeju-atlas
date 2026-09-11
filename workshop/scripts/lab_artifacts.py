"""Build fresh CodeZip dependencies and publish only into the owned lab bucket."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import zipfile

from lab_config import resource_names, write_json
from lab_workspace import verify_workspace


def normalize_console_scripts(directory):
    """Remove uv's build-machine interpreter paths from Python console launchers."""
    count = 0
    for path in (Path(directory) / "bin").glob("*"):
        if path.is_symlink():
            raise ValueError("Console launchers cannot be symlinks")
        if not path.is_file():
            continue
        data = path.read_bytes()
        lines = data.splitlines(keepends=True)
        if not lines:
            continue
        remaining = None
        if lines[0].startswith(b"#!") and b"python" in lines[0].lower():
            remaining = lines[1:]
        elif (len(lines) >= 3 and lines[0].startswith(b"#!/bin/sh")
              and b"'''exec'" in lines[1] and b"python" in lines[1].lower()
              and lines[2].strip() == b"' '''"):
            remaining = lines[3:]
        if remaining is not None:
            updated = b"#!/usr/bin/env python3\n" + b"".join(remaining)
            if updated != data:
                path.write_bytes(updated)
                count += 1
    return count


def package_dependencies(directory, path):
    directory, path = Path(directory), Path(path)
    normalized = normalize_console_scripts(directory)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        count, expanded = 0, 0
        for item in sorted(directory.rglob("*")):
            if item.is_symlink():
                raise ValueError("Dependency archive cannot contain symlinks")
            if not item.is_file() or "__pycache__" in item.parts:
                continue
            relative = item.relative_to(directory)
            if any(part.startswith(".env") or part in {".aws", ".git"} for part in relative.parts):
                raise ValueError("Unexpected private dependency file")
            count += 1
            expanded += item.stat().st_size
            if count > 30000 or expanded > 512 * 1024 * 1024:
                raise ValueError("Dependency archive exceeds the runtime packaging bounds")
            archive.write(item, relative.as_posix())
    if path.stat().st_size > 100 * 1024 * 1024:
        raise ValueError("Compressed dependency archive exceeds 100 MiB")
    return {"sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "bytes": path.stat().st_size, "files": count, "expandedBytes": expanded,
            "portableConsoleScripts": normalized}


def agent_deployer(workspace):
    path = Path(workspace) / "scripts/deploy-atlas-agent.py"
    spec = importlib.util.spec_from_file_location("workshop_owned_agent_deployer", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build_dependencies(config, workspace):
    workspace = verify_workspace(config, workspace)
    directory = workspace / ".local/workshop-dependencies"
    directory.mkdir(parents=True, exist_ok=True)
    environment = {
        **os.environ,
        "UV_CACHE_DIR": str(workspace / ".local/uv-cache"),
        "UV_PYTHON_INSTALL_DIR": str(workspace / ".local/uv-python"),
    }
    report = {"version": 1, "platform": "aarch64-manylinux_2_28", "python": "3.14", "roles": {}}
    for role in ["guide", "tools"]:
        project = workspace / "agent" / role
        requirements = directory / (role + "-requirements.txt")
        target = directory / (role + "-packages")
        if target.exists():
            raise FileExistsError("Dependency staging exists; inspect/remove only this local staging directory before retry: " + str(target))
        subprocess.run([
            "uv", "export", "--project", str(project), "--frozen", "--no-dev",
            "--no-emit-project", "--format", "requirements-txt", "--output-file", str(requirements),
        ], check=True, cwd=workspace, env=environment)
        subprocess.run([
            "uv", "pip", "install", "--target", str(target), "--python-version", "3.14",
            "--python-platform", "aarch64-manylinux_2_28", "--only-binary", ":all:",
            "--no-deps", "--require-hashes", "--no-compile", "-r", str(requirements),
        ], check=True, cwd=workspace, env=environment)
        path = directory / (role + "-dependencies.zip")
        report["roles"][role] = {
            "file": str(path.relative_to(workspace)), **package_dependencies(target, path),
        }
    write_json(directory / "build.json", report)
    return report


def publish_dependencies(config, workspace, session):
    workspace = verify_workspace(config, workspace)
    report = json.loads((workspace / ".local/workshop-dependencies/build.json").read_text())
    if report.get("platform") != "aarch64-manylinux_2_28" or report.get("python") != "3.14":
        raise ValueError("Dependencies do not target the lab Runtime platform")
    if set(report.get("roles", {})) != {"guide", "tools"}:
        raise ValueError("Exactly the Guide and Tools dependency archives are required")
    deployer = agent_deployer(workspace)
    s3 = session.client("s3")
    deployer.owned_bucket(s3)
    result = {"version": 1, "roles": {}}
    for role, record in report["roles"].items():
        path = (workspace / record["file"]).resolve()
        if (workspace / ".local/workshop-dependencies").resolve() not in path.parents:
            raise ValueError("Dependency archive is outside the owned build directory")
        if deployer.digest(path) != record["sha256"]:
            raise ValueError("Dependency archive changed after its build")
        # Use the existing, tested application overlay and archive validation.
        check = path.with_name(role + "-overlay-check.zip")
        deployer.build_bundle(path, workspace / "agent" / role, role, check)
        check.unlink()
        key = "agent/dependencies/" + record["sha256"] + "/" + role + ".zip"
        version = deployer.put_immutable(s3, path, key, record["sha256"])
        result["roles"][role] = {
            "bucket": resource_names(config)["dataBucket"], "key": key,
            "versionId": version, "sha256": record["sha256"], "bytes": record["bytes"],
        }
    deployer.validate_dependencies(result)
    write_json(workspace / "agent/dependency-artifacts.json", result)
    return result


def publish_catalog(config, workspace, session):
    workspace = verify_workspace(config, workspace)
    path = workspace / ".local/catalog.sqlite"
    if not path.is_file() or path.is_symlink():
        raise ValueError("Build the lab catalog first")
    deployer = agent_deployer(workspace)
    s3 = session.client("s3")
    deployer.owned_bucket(s3)
    sha = deployer.digest(path)
    with path.open("rb") as data:
        response = s3.put_object(
            Bucket=resource_names(config)["dataBucket"], Key="catalog/catalog.sqlite",
            Body=data, ContentType="application/vnd.sqlite3", ServerSideEncryption="AES256",
            Metadata={"sha256": sha, "workshop-participant": config["participant"]},
        )
    if not response.get("VersionId") or response["VersionId"] == "null":
        raise ValueError("Catalog publication must retain an S3 object version")
    # GetObject-only worker roles can receive AccessDenied for a missing key.
    # Seed an explicitly empty snapshot once, without replacing any enrichment.
    from botocore.exceptions import ClientError
    snapshot_state = "initialized"
    try:
        s3.put_object(
            Bucket=resource_names(config)["dataBucket"], Key="place-details/latest.json",
            Body=b'{"version":1,"records":{},"last_attempt":{}}',
            IfNoneMatch="*", ContentType="application/json; charset=utf-8",
            ServerSideEncryption="AES256", Metadata={"workshop-bootstrap": "empty-snapshot"},
        )
    except ClientError as error:
        if error.response["Error"]["Code"] not in {"PreconditionFailed", "ConditionalRequestConflict"}:
            raise
        snapshot_state = "existing-preserved"
    result = {"bucket": resource_names(config)["dataBucket"], "key": "catalog/catalog.sqlite",
              "sha256": sha, "versionId": response["VersionId"], "detailsSnapshot": snapshot_state}
    write_json(workspace / ".local/workshop-catalog-published.json", result)
    return result
