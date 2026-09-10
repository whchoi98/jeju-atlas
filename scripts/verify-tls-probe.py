#!/usr/bin/env python3
"""Verify the isolated HTTPS origin path without invoking a model."""
from datetime import datetime, timezone
import json
import re
import uuid

import requests

from deploy import APP, connect, emit, save, stack_outputs


def main():
    session = connect()
    regional = session.client("cloudformation")
    app = stack_outputs(regional, APP)
    probe = stack_outputs(regional, "Jeju3dTlsProbe")
    routing = stack_outputs(session.client("cloudformation", region_name="us-east-1"), "Jeju3dOriginRouting")
    edge = session.client("cloudfront")
    distribution = edge.get_distribution(Id=probe["DistributionId"])["Distribution"]
    config = distribution["DistributionConfig"]
    behavior = config["DefaultCacheBehavior"]
    origin = next(item for item in config["Origins"]["Items"] if item["Id"] == "jeju-alb")
    arn = routing["OriginHostFunctionVersionArn"]
    report = {
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "probeId": probe["DistributionId"], "probeUrl": probe["ProbeUrl"],
        "functionVersionArn": arn, "albDomainName": routing["AlbDomainName"],
        "canonicalHostName": routing["CanonicalHostName"],
        "checks": [], "passed": False, "modelInvocations": 0,
    }

    def check(name, condition, **detail):
        item = {"check": name, "passed": bool(condition), **detail}
        report["checks"].append(item)
        emit(item)
        if not condition:
            raise ValueError(name)

    try:
        check("Owned isolated distribution is deployed",
              distribution["Status"] == "Deployed" and config["Enabled"]
              and probe["DistributionId"] != app["DistributionId"]
              and config["Aliases"]["Quantity"] == 0)
        check("Origin connects only through HTTPS 443 to the existing ALB",
              origin["DomainName"] == routing["AlbDomainName"] == app["LoadBalancerDnsName"]
              and origin["CustomOriginConfig"]["OriginProtocolPolicy"] == "https-only"
              and origin["CustomOriginConfig"]["HTTPSPort"] == 443)
        check("Qualified origin function receives no body",
              behavior.get("LambdaFunctionAssociations", {}).get("Items") == [{
                  "LambdaFunctionARN": arn, "EventType": "origin-request", "IncludeBody": False,
              }] and re.fullmatch(r"arn:aws:lambda:us-east-1:061525506239:function:jeju-3d-origin-host:[1-9]\d*", arn))
        policy = edge.get_origin_request_policy(Id=behavior["OriginRequestPolicyId"])["OriginRequestPolicy"]["OriginRequestPolicyConfig"]
        check("Host and existing session proof headers are forwarded without caching",
              {"host", "origin", "x-atlas-csrf"} <= {
                  item.lower() for item in policy["HeadersConfig"].get("Headers", {}).get("Items", [])
              } and behavior["CachePolicyId"] == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad")
        base = probe["ProbeUrl"]
        http = requests.Session()
        ready = http.get(base + "/readyz", timeout=45)
        check("ALB certificate verification and private origin header succeed",
              ready.status_code == 200 and ready.json().get("status") == "ready"
              and "cloudfront" in ready.headers.get("Via", "").lower(), status=ready.status_code)
        root = http.get(base + "/", timeout=30)
        asset = re.search(r'<script[^>]+src="(/assets/[^"]+\.js)"', root.text)
        check("Static HTML is delivered", root.status_code == 200 and asset is not None)
        script = http.get(base + asset.group(1), timeout=30)
        check("Static JavaScript uses the same HTTPS path", script.status_code == 200 and len(script.content) > 1000)
        found = http.get(base + "/api/catalog/search", params={"q": "성산일출봉", "limit": 1}, timeout=30)
        baseline = requests.get(app["ApplicationUrl"] + "/api/catalog/search",
                                params={"q": "성산일출봉", "limit": 1}, timeout=30)
        check("Korean query and limit survive the origin function",
              found.status_code == baseline.status_code == 200 and len(found.json().get("items", [])) == 1
              and [item["id"] for item in found.json()["items"]] == [item["id"] for item in baseline.json()["items"]]
              and found.json().get("total") == baseline.json().get("total"))
        configured = http.get(base + "/api/config", timeout=30)
        settings = configured.json()
        proof = settings.get("guide", {}).get("csrf_token")
        check("Session configuration remains private and secure",
              configured.status_code == 200 and proof and "no-store" in configured.headers.get("Cache-Control", "")
              and "HttpOnly" in configured.headers.get("Set-Cookie", "")
              and "Secure" in configured.headers.get("Set-Cookie", ""))
        # Empty message is rejected before admission/AgentCore invocation.
        body = {"message": "", "locale": "ko", "request_id": str(uuid.uuid4())}
        for label, viewer in (("custom", "https://jeju-atlas.whchoi.net"),
                              ("cloudfront", "https://d2mznud99i2mdr.cloudfront.net")):
            result = http.post(base + "/api/guide", json=body,
                               headers={"Origin": viewer, "X-Atlas-CSRF": proof}, timeout=30)
            check(f"{label} viewer proof, cookie and POST body survive HTTPS",
                  result.status_code == 400 and result.json().get("error", {}).get("code") == "invalid_message",
                  status=result.status_code)
        denied = http.post(base + "/api/guide", json=body,
                           headers={"Origin": "https://unrelated.invalid"}, timeout=30)
        check("A foreign Origin without an app proof remains forbidden",
              denied.status_code == 403 and denied.json().get("error", {}).get("code") == "origin_forbidden")
        forged = http.post(base + "/api/guide", json=body,
                          headers={"Origin": "https://unrelated.invalid", "X-Atlas-CSRF": "forged"}, timeout=30)
        check("A forged app proof remains forbidden",
              forged.status_code == 403 and forged.json().get("error", {}).get("code") == "csrf_invalid")
        report["passed"] = True
    finally:
        save("tls-probe-verification.json", report)
    emit({"passed": report["passed"], "checks": len(report["checks"]), "modelInvocations": 0})


if __name__ == "__main__":
    main()
