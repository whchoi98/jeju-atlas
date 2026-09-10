#!/usr/bin/env python3
"""Rehearse current -> previous -> current with real immutable images, offline.

This does not change ECS or CloudFormation and does not invoke a model.
The same local HTTP endpoints read the same read-only catalog in all phases.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = "061525506239.dkr.ecr.ap-northeast-2.amazonaws.com/jeju-3d"
PROBE = """
(async () => {
  const base = 'http://127.0.0.1:8080';
  async function get(path) {
    const r = await fetch(base + path);
    if (r.status !== 200) throw new Error('Unexpected HTTP status');
    return r;
  }
  const ready = await (await get('/readyz')).json();
  const config = await (await get('/api/config')).json();
  const place = await (await get('/api/catalog/places/poi_0008')).json();
  const html = await (await get('/')).text();
  const asset = html.match(/src=\"(\\/assets\\/[^\\\"]+\\.js)\"/)?.[1];
  if (!asset || ready.status !== 'ready' || config.features.guide ||
      place.id !== 'poi_0008' || place.name !== '성산일출봉' ||
      !place.official_details?.length) throw new Error('Incompatible release');
  await get(asset);
  console.log(JSON.stringify({
    ready: true, modelDisabled: !config.features.guide, placeId: place.id,
    coordinates: [place.lat, place.lng], officialRecords: place.official_details.length,
    asset
  }));
})().catch(() => process.exit(1));
"""


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--current", required=True)
    parser.add_argument("--previous", required=True)
    parser.add_argument("--catalog", type=Path, default=ROOT / ".local/reference-catalog.sqlite")
    parser.add_argument("--details", type=Path, default=ROOT / ".local/official-details-current.json")
    parser.add_argument("--output", type=Path, default=ROOT / ".local/release-rollback-rehearsal.json")
    args = parser.parse_args()
    for value in (args.current, args.previous):
        if not re.fullmatch(re.escape(REPOSITORY) + r"@sha256:[a-f0-9]{64}", value):
            parser.error("Use immutable image digests from the owned Jeju repository")
    catalog, details = args.catalog.resolve(), args.details.resolve()
    if catalog.read_bytes()[:16] != b"SQLite format 3\x00":
        parser.error("Expected the read-only Jeju catalog")
    snapshot = json.loads(details.read_text())
    if snapshot.get("version") != 1 or "poi_0008" not in snapshot.get("records", {}):
        parser.error("Expected a validated official-detail snapshot")
    before = {str(path): (digest(path), path.stat().st_mtime_ns) for path in (catalog, details)}
    report = {
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "scope": "Offline Docker image rollback rehearsal; production is untouched",
        "modelInvocations": 0, "phases": [], "passed": False,
    }
    name = "jeju-release-rehearsal-" + uuid.uuid4().hex[:10]
    try:
        for phase, image in (("current", args.current), ("previous", args.previous), ("restored-current", args.current)):
            inspect = json.loads(subprocess.check_output(["docker", "image", "inspect", image], text=True))[0]
            subprocess.run([
                "docker", "run", "--detach", "--rm", "--name", name, "--network", "none", "--read-only",
                "--memory", "512m", "--cpus", "0.25",
                "--mount", f"type=bind,source={catalog},target=/snapshots/catalog.sqlite,readonly",
                "--mount", f"type=bind,source={details},target=/snapshots/details.json,readonly",
                "--env", "CATALOG_LOCAL_PATH=/snapshots/catalog.sqlite",
                "--env", "DETAILS_LOCAL_PATH=/snapshots/details.json",
                "--env", "PUBLIC_ORIGIN=http://localhost:8080",
                "--env", "AWS_EC2_METADATA_DISABLED=true",
                "--env", "GUIDE_RUNTIME_ARN=", "--env", "GUIDE_QUOTA_TABLE=",
                "--env", "ATLAS_SESSION_SECRET=local-rehearsal-only-not-a-production-secret",
                "--env", "RELEASE=" + phase, image,
            ], check=True, capture_output=True, text=True)
            try:
                result = None
                for _ in range(40):
                    probe = subprocess.run(["docker", "exec", name, "node", "-e", PROBE],
                                           text=True, capture_output=True, timeout=10)
                    if probe.returncode == 0:
                        result = json.loads(probe.stdout)
                        break
                    time.sleep(1)
                if result is None:
                    raise RuntimeError("Release did not serve the required HTTP/data contract")
                report["phases"].append({"phase": phase, "image": image, "imageId": inspect["Id"], **result})
                print(json.dumps(report["phases"][-1]), flush=True)
            finally:
                subprocess.run(["docker", "stop", "--time", "10", name], capture_output=True, check=False)
        after = {str(path): (digest(path), path.stat().st_mtime_ns) for path in (catalog, details)}
        report["readOnlyDataUnchanged"] = after == before
        report["passed"] = report["readOnlyDataUnchanged"] and len(report["phases"]) == 3
        if not report["passed"]:
            raise RuntimeError("Rollback rehearsal changed the reference data")
    finally:
        report["finishedAt"] = datetime.now(timezone.utc).isoformat()
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
