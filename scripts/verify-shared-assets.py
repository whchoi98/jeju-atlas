#!/usr/bin/env python3
"""Verify old and current immutable assets through production CloudFront."""
import argparse
from datetime import datetime, timezone
import hashlib
import json

import requests

from deploy import APP, connect, emit, require_asset_manifest, save, stack_outputs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image-uri", action="append", required=True)
    args = parser.parse_args()
    session = connect()
    cf = session.client("cloudformation")
    app = stack_outputs(cf, APP)
    assets = stack_outputs(cf, "Jeju3dStatic")
    bucket = assets["AssetsBucketName"]
    manifest = {}
    for image in args.image_uri:
        for path, sha in require_asset_manifest(session, bucket, image)["assetsSHA"].items():
            if path in manifest and manifest[path] != sha:
                raise ValueError("Release manifests disagree on an immutable path")
            manifest[path] = sha
    report = {
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "images": args.image_uri, "assets": [], "passed": False,
    }
    try:
        config = session.client("cloudfront").get_distribution_config(Id=app["DistributionId"])["DistributionConfig"]
        route = next(item for item in config["CacheBehaviors"]["Items"] if item["PathPattern"] == "/assets/*")
        if route["TargetOriginId"] != "jeju-assets":
            raise ValueError("Production assets must bypass ECS")
        blocked = session.client("s3").get_public_access_block(Bucket=bucket)["PublicAccessBlockConfiguration"]
        if not all(blocked.values()):
            raise ValueError("The shared asset bucket must remain private")
        http = requests.Session()
        for path, sha in sorted(manifest.items()):
            response = http.get(app["ApplicationUrl"] + "/" + path, timeout=30)
            item = {"path": path, "status": response.status_code,
                    "sha256Matches": hashlib.sha256(response.content).hexdigest() == sha}
            report["assets"].append(item)
            if response.status_code != 200 or not item["sha256Matches"] or "immutable" not in response.headers.get("Cache-Control", ""):
                raise ValueError("A versioned asset is unavailable or its contents changed")
        path = next(iter(manifest))
        direct = http.get("https://" + assets["AssetsBucketDomainName"] + "/" + path, timeout=20)
        private_manifest = http.get(
            "https://" + assets["AssetsBucketDomainName"] + "/releases/" + args.image_uri[0].split("@sha256:")[1] + ".json",
            timeout=20)
        report["directS3Denied"] = direct.status_code == 403
        report["manifestPrivate"] = private_manifest.status_code == 403
        report["passed"] = bool(manifest) and report["directS3Denied"] and report["manifestPrivate"]
        if not report["passed"]:
            raise ValueError("Assets or release manifests permit direct anonymous access")
    finally:
        save("shared-assets-verification.json", report)
    emit({"passed": report["passed"], "imageVersions": len(args.image_uri), "verifiedAssets": len(report["assets"])})


if __name__ == "__main__":
    main()
