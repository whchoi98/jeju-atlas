#!/usr/bin/env python3
"""Verify the deployed Jeju app, network placement and origin restrictions."""
from __future__ import annotations

from datetime import datetime, timezone
import json
import re
import sys

import requests
from deploy import ACCOUNT, APP, LOCAL, PREFIX, PRIVATE, PUBLIC, REGION, VPC, SETTINGS, assert_network, connect, emit, load, save, stack_outputs, validate_settings


def task_iam_scoped(iam, role_name, environment, *, details_bucket=""):
    """Require every selected object/runtime/table grant, with no additional access."""
    if environment.get("DETAILS_BUCKET", "") != details_bucket:
        return False
    if details_bucket and environment.get("DETAILS_KEY") != "place-details/latest.json":
        return False
    expected_resources = {
        "s3:GetObject": {f"arn:aws:s3:::{environment.get('CATALOG_BUCKET')}/catalog/catalog.sqlite"},
        "bedrock-agentcore:InvokeAgentRuntime": {
            environment.get("GUIDE_RUNTIME_ARN"),
            str(environment.get("GUIDE_RUNTIME_ARN")) + "/runtime-endpoint/DEFAULT",
        },
        "bedrock-agentcore:InvokeAgentRuntimeForUser": {
            environment.get("GUIDE_RUNTIME_ARN"),
            str(environment.get("GUIDE_RUNTIME_ARN")) + "/runtime-endpoint/DEFAULT",
        },
        "dynamodb:UpdateItem": {
            f"arn:aws:dynamodb:ap-northeast-2:{ACCOUNT}:table/{environment.get('GUIDE_QUOTA_TABLE')}"
        },
        "dynamodb:GetItem": {
            f"arn:aws:dynamodb:ap-northeast-2:{ACCOUNT}:table/{environment.get('GUIDE_QUOTA_TABLE')}"
        },
    }
    if details_bucket:
        expected_resources["s3:GetObject"].add(f"arn:aws:s3:::{details_bucket}/place-details/latest.json")
    if iam.list_attached_role_policies(RoleName=role_name)["AttachedPolicies"]:
        return False
    granted = {action: set() for action in expected_resources}
    for policy_name in iam.list_role_policies(RoleName=role_name)["PolicyNames"]:
        statements = iam.get_role_policy(RoleName=role_name, PolicyName=policy_name)["PolicyDocument"].get("Statement", [])
        if isinstance(statements, dict):
            statements = [statements]
        for statement in statements:
            actions = statement.get("Action", [])
            resources = statement.get("Resource", [])
            if isinstance(actions, str):
                actions = [actions]
            if isinstance(resources, str):
                resources = [resources]
            if (statement.get("Effect") != "Allow" or not actions or not resources
                    or "NotAction" in statement or "NotResource" in statement
                    or not all(isinstance(value, str) for value in [*actions, *resources])):
                return False
            for action in actions:
                if action not in expected_resources or not set(resources) <= expected_resources[action]:
                    return False
                granted[action].update(resources)
    return granted == expected_resources


def verify_media_delivery(edge, config, parameters, check):
    """Read-only checks for the optional private S3 media origin and its cache."""
    bucket = parameters.get("DetailsBucket", "")
    origins = [item for item in config.get("Origins", {}).get("Items", []) if item.get("Id") == "jeju-media"]
    behaviors = config.get("CacheBehaviors", {}).get("Items", [])
    routes = [item for item in behaviors if item.get("PathPattern") in ("/media/*", "media/*")]
    media_targets = [item for item in behaviors if item.get("TargetOriginId") == "jeju-media"]
    default_is_media = config.get("DefaultCacheBehavior", {}).get("TargetOriginId") == "jeju-media"
    if not bucket:
        check("Media remains disabled without a details bucket",
              not origins and not routes and not media_targets and not default_is_media)
        return

    origin = origins[0] if len(origins) == 1 else {}
    oac_id = parameters.get("MediaOriginAccessControlId", "")
    expected_domain = f"{bucket}.s3.{REGION}.amazonaws.com"
    headers = origin.get("CustomHeaders", {})
    check("Media uses the selected S3 bucket and OAC without ALB credentials", bool(origin)
          and parameters.get("MediaBucketDomainName") == expected_domain
          and origin.get("DomainName") == expected_domain
          and bool(oac_id) and origin.get("OriginAccessControlId") == oac_id
          and origin.get("S3OriginConfig", {}).get("OriginAccessIdentity") == ""
          and not origin.get("CustomOriginConfig") and not origin.get("OriginPath")
          and headers.get("Quantity", 0) == 0 and not headers.get("Items"))
    oac = {}
    if oac_id and origin.get("OriginAccessControlId") == oac_id:
        oac = edge.get_origin_access_control(Id=oac_id)["OriginAccessControl"]["OriginAccessControlConfig"]
    check("Media S3 OAC signs every origin request", oac.get("OriginAccessControlOriginType") == "s3"
          and oac.get("SigningBehavior") == "always" and oac.get("SigningProtocol") == "sigv4")

    behavior = routes[0] if len(routes) == 1 else {}
    methods = behavior.get("AllowedMethods", {})
    check("Only the public media path reaches S3 with GET and HEAD", bool(behavior)
          and behavior.get("PathPattern") == "/media/*" and media_targets == [behavior]
          and not default_is_media and behaviors[0] == behavior
          and behavior.get("ViewerProtocolPolicy") == "redirect-to-https"
          and set(methods.get("Items", [])) == {"GET", "HEAD"}
          and set(methods.get("CachedMethods", {}).get("Items", [])) == {"GET", "HEAD"}
          and behavior.get("Compress") is False and not behavior.get("OriginRequestPolicyId"))
    cache = {}
    if behavior.get("CachePolicyId"):
        cache = edge.get_cache_policy(Id=behavior["CachePolicyId"])["CachePolicy"]["CachePolicyConfig"]
    key = cache.get("ParametersInCacheKeyAndForwardedToOrigin", {})
    check("One-year media cache excludes cookies, headers and query strings",
          cache.get("MinTTL") == 0 and cache.get("DefaultTTL") == 31536000 and cache.get("MaxTTL") == 31536000
          and key.get("CookiesConfig", {}).get("CookieBehavior") == "none"
          and key.get("HeadersConfig", {}).get("HeaderBehavior") == "none"
          and key.get("QueryStringsConfig", {}).get("QueryStringBehavior") == "none"
          and key.get("EnableAcceptEncodingGzip") is False and not key.get("EnableAcceptEncodingBrotli", False))


def verify():
    session = connect()
    cf = session.client("cloudformation")
    ec2 = session.client("ec2")
    ecs = session.client("ecs")
    elb = session.client("elbv2")
    edge = session.client("cloudfront")
    outputs = stack_outputs(cf, APP)
    image = load("image.json")
    settings = validate_settings(json.loads(SETTINGS.read_text()))
    checks = []

    def check(name, condition, detail=None):
        result = {"check": name, "passed": bool(condition)}
        if detail is not None:
            result["detail"] = detail
        checks.append(result)
        emit(result)

    assert_network(session)
    network = load("network.json")
    nat_ids = {s["defaultRoute"] for s in network["subnets"] if s["role"] == "private-ecs"}
    check("Existing NAT Gateways reused", nat_ids == {"nat-00b8a70dc184a4d0c", "nat-08379e076e2e6e234"}, sorted(nat_ids))

    stack = cf.describe_stacks(StackName=APP)["Stacks"][0]
    parameters = {item["ParameterKey"]: item["ParameterValue"] for item in stack.get("Parameters", [])}
    check("CloudFormation complete", stack["StackStatus"] in ["CREATE_COMPLETE", "UPDATE_COMPLETE"], stack["StackStatus"])
    resources = cf.list_stack_resources(StackName=APP)["StackResourceSummaries"]
    forbidden = {"AWS::EC2::VPC", "AWS::EC2::Subnet", "AWS::EC2::NatGateway", "AWS::EC2::EIP", "AWS::EC2::Route", "AWS::EC2::RouteTable"}
    check("No shared network resources created or managed", not any(r["ResourceType"] in forbidden for r in resources))

    service = ecs.describe_services(cluster=outputs["ClusterName"], services=[outputs["ServiceName"]])["services"][0]
    check("Service maintains the configured minimum capacity", service["desiredCount"] >= int(settings["MinTaskCount"]))
    check("Fargate service stable", service["runningCount"] == service["desiredCount"] and service["pendingCount"] == 0
          and all(d.get("rolloutState") == "COMPLETED" for d in service["deployments"]),
          {"desired": service["desiredCount"], "running": service["runningCount"], "pending": service["pendingCount"]})
    awsvpc = service["networkConfiguration"]["awsvpcConfiguration"]
    check("Private subnets and public IP disabled", set(awsvpc["subnets"]) == set(PRIVATE) and awsvpc["assignPublicIp"] == "DISABLED", awsvpc)
    taskdef = ecs.describe_task_definition(taskDefinition=service["taskDefinition"])["taskDefinition"]
    container = taskdef["containerDefinitions"][0]
    check("ARM64 0.25 vCPU 512 MiB", taskdef["runtimePlatform"]["cpuArchitecture"] == "ARM64"
          and taskdef["cpu"] == "256" and taskdef["memory"] == "512")
    check("Immutable image digest deployed", container["image"] == image["imageUri"], container["image"])
    check("Nonroot and read-only container", container.get("user") == "1000:1000" and container.get("readonlyRootFilesystem") is True)
    task_role_name = taskdef["taskRoleArn"].split("/")[-1]
    iam = session.client("iam")
    environment = {item["name"]: item["value"] for item in container.get("environment", [])}
    check("Task IAM limited to selected catalog, guide and quota",
          task_iam_scoped(iam, task_role_name, environment, details_bucket=parameters.get("DetailsBucket", "")))
    check("Only catalog cache volume is writable", [
        mount["containerPath"] for mount in container.get("mountPoints", []) if not mount.get("readOnly", False)
    ] == ["/tmp"])
    check("Session secret injected without plaintext environment", "ATLAS_SESSION_SECRET" not in environment
          and any(item["name"] == "ATLAS_SESSION_SECRET" and item["valueFrom"].startswith("arn:aws:secretsmanager:")
                  for item in container.get("secrets", [])))
    check("Guide fleet limits configured", environment.get("GUIDE_DAILY_LIMIT") == settings["GuideDailyLimit"]
          and environment.get("GUIDE_HOURLY_LIMIT") == settings["GuideHourlyLimit"]
          and environment.get("GUIDE_GLOBAL_CONCURRENCY") == settings["GuideGlobalConcurrency"])
    check("Graceful shutdown precedes the ECS stop deadline", container.get("stopTimeout") == 120
          and 90_000 < int(environment.get("DRAIN_TIMEOUT_MS", "0")) < 120_000)

    task_arns = ecs.list_tasks(cluster=outputs["ClusterName"], serviceName=outputs["ServiceName"], desiredStatus="RUNNING")["taskArns"]
    tasks = ecs.describe_tasks(cluster=outputs["ClusterName"], tasks=task_arns)["tasks"] if task_arns else []
    check("Container health checks passing", bool(tasks) and all(t.get("healthStatus") == "HEALTHY" for t in tasks))
    check("Healthy tasks span two availability zones", len({
        task.get("availabilityZone") for task in tasks if task.get("healthStatus") == "HEALTHY"
    } - {None}) >= 2)
    eni_ids = [
        detail["value"] for task in tasks for attachment in task.get("attachments", [])
        for detail in attachment.get("details", []) if detail["name"] == "networkInterfaceId"
    ]
    enis = ec2.describe_network_interfaces(NetworkInterfaceIds=eni_ids)["NetworkInterfaces"] if eni_ids else []
    task_network = [
        {"eni": eni["NetworkInterfaceId"], "subnet": eni["SubnetId"], "privateIp": eni["PrivateIpAddress"],
         "hasPublicIp": bool(eni.get("Association", {}).get("PublicIp"))}
        for eni in enis
    ]
    check("Running ENIs are private", bool(enis) and all(eni["VpcId"] == VPC and eni["SubnetId"] in PRIVATE
          and not eni.get("Association", {}).get("PublicIp") for eni in enis), task_network)

    alb = elb.describe_load_balancers(LoadBalancerArns=[outputs["LoadBalancerArn"]])["LoadBalancers"][0]
    check("ALB placed in public subnets", alb["Scheme"] == "internet-facing" and alb["VpcId"] == VPC
          and {s["SubnetId"] for s in alb["AvailabilityZones"]} == set(PUBLIC))
    targets = elb.describe_target_health(TargetGroupArn=outputs["TargetGroupArn"])["TargetHealthDescriptions"]
    check("ALB targets healthy", bool(targets) and all(t["TargetHealth"]["State"] == "healthy" for t in targets),
          [{"ip": t["Target"]["Id"], "port": t["Target"]["Port"], "state": t["TargetHealth"]["State"]} for t in targets])
    groups = ec2.describe_security_groups(GroupIds=[outputs["AlbSecurityGroupId"], outputs["TaskSecurityGroupId"]])["SecurityGroups"]
    alb_sg = next(g for g in groups if g["GroupId"] == outputs["AlbSecurityGroupId"])
    task_sg = next(g for g in groups if g["GroupId"] == outputs["TaskSecurityGroupId"])
    ingress = alb_sg["IpPermissions"]
    check("ALB ingress only CloudFront managed prefix TCP 80", len(ingress) == 1
          and ingress[0].get("FromPort") == 80 and ingress[0].get("ToPort") == 80
          and not ingress[0].get("IpRanges") and not ingress[0].get("Ipv6Ranges") and not ingress[0].get("UserIdGroupPairs")
          and [p["PrefixListId"] for p in ingress[0].get("PrefixListIds", [])] == [PREFIX])
    ingress = task_sg["IpPermissions"]
    check("Task ingress only ALB SG TCP 8080", len(ingress) == 1
          and ingress[0].get("FromPort") == 8080 and ingress[0].get("ToPort") == 8080
          and not ingress[0].get("IpRanges") and not ingress[0].get("Ipv6Ranges") and not ingress[0].get("PrefixListIds")
          and [g["GroupId"] for g in ingress[0].get("UserIdGroupPairs", [])] == [alb_sg["GroupId"]])
    egress = alb_sg["IpPermissionsEgress"]
    check("ALB egress only task SG TCP 8080", len(egress) == 1 and egress[0].get("FromPort") == 8080
          and egress[0].get("ToPort") == 8080 and not egress[0].get("IpRanges")
          and [g["GroupId"] for g in egress[0].get("UserIdGroupPairs", [])] == [task_sg["GroupId"]])

    distribution = edge.get_distribution(Id=outputs["DistributionId"])["Distribution"]
    check("CloudFront deployed", distribution["Status"] == "Deployed", distribution["Status"])
    config = distribution["DistributionConfig"]
    check("Confirmed custom domain and certificate are preserved",
          config.get("Aliases", {}).get("Items") == [settings["ViewerDomainName"]]
          and config.get("ViewerCertificate", {}).get("ACMCertificateArn") == settings["ViewerCertificateArn"])
    check("Dedicated WAF protects the distribution",
          "/webacl/jeju-3d-edge/" in config.get("WebACLId", ""))
    check("Viewers redirected to HTTPS", config["DefaultCacheBehavior"]["ViewerProtocolPolicy"] == "redirect-to-https")
    origin = next(item for item in config["Origins"]["Items"] if item["Id"] == "jeju-alb")
    use_tls = settings["OriginTlsEnabled"] == "true"
    check("CloudFront uses the configured ALB origin", origin["DomainName"] == (
        settings["OriginDomainName"] if use_tls else outputs["LoadBalancerDnsName"]))
    check("Origin protocol matches the staged TLS configuration",
          origin["CustomOriginConfig"]["OriginProtocolPolicy"] == ("https-only" if use_tls else "http-only"))
    verify_media_delivery(edge, config, parameters, check)
    terrain_origin = next((item for item in config["Origins"]["Items"] if item["Id"] == "jeju-terrain"), None)
    check("Terrain origin uses HTTPS and receives no ALB secret", bool(terrain_origin)
          and terrain_origin["DomainName"] == "elevation-tiles-prod.s3.us-east-1.amazonaws.com"
          and terrain_origin["CustomOriginConfig"]["OriginProtocolPolicy"] == "https-only"
          and terrain_origin.get("CustomHeaders", {}).get("Quantity", 0) == 0)
    terrain_behavior = next((item for item in config.get("CacheBehaviors", {}).get("Items", [])
                             if item["PathPattern"] == "/terrarium/*"), None)
    check("Elevation tile route bypasses the ALB", bool(terrain_behavior)
          and terrain_behavior["TargetOriginId"] == "jeju-terrain"
          and terrain_behavior["ViewerProtocolPolicy"] == "redirect-to-https"
          and set(terrain_behavior["AllowedMethods"]["Items"]) == {"GET", "HEAD"})
    if terrain_behavior:
        terrain_cache = edge.get_cache_policy(Id=terrain_behavior["CachePolicyId"])["CachePolicy"]["CachePolicyConfig"]
        cache_key = terrain_cache["ParametersInCacheKeyAndForwardedToOrigin"]
        check("Seven-day edge terrain cache shared across viewers", terrain_cache["DefaultTTL"] == 604800
              and terrain_cache["MinTTL"] == 0
              and cache_key["CookiesConfig"]["CookieBehavior"] == "none"
              and cache_key["HeadersConfig"]["HeaderBehavior"] == "none"
              and cache_key["QueryStringsConfig"]["QueryStringBehavior"] == "none")
    behaviors = config.get("CacheBehaviors", {}).get("Items", [])
    catalog_behavior = next((item for item in behaviors if item["PathPattern"] == "/api/catalog/*"), None)
    api_behavior = next((item for item in behaviors if item["PathPattern"] == "/api/*"), None)
    check("Private API never cached and supports POST", bool(api_behavior)
          and api_behavior["CachePolicyId"] == "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
          and "POST" in api_behavior["AllowedMethods"]["Items"])
    if api_behavior:
        request_policy = edge.get_origin_request_policy(Id=api_behavior["OriginRequestPolicyId"])["OriginRequestPolicy"]["OriginRequestPolicyConfig"]
        check("Private API forwards the session-bound request proof",
              "x-atlas-csrf" in [value.lower() for value in request_policy["HeadersConfig"].get("Headers", {}).get("Items", [])])
    if catalog_behavior:
        policy = edge.get_cache_policy(Id=catalog_behavior["CachePolicyId"])["CachePolicy"]["CachePolicyConfig"]
        check("Public catalog cache does not forward cookies", policy["MinTTL"] == 0 and policy["DefaultTTL"] == 60
              and policy["ParametersInCacheKeyAndForwardedToOrigin"]["CookiesConfig"]["CookieBehavior"] == "none")
    else:
        check("Public catalog cache configured", False)
    listeners = elb.describe_listeners(LoadBalancerArn=outputs["LoadBalancerArn"])["Listeners"]
    listener = next(item for item in listeners if item["Port"] == 80)
    check("Unmatched ALB requests denied", listener["DefaultActions"][0]["Type"] == "fixed-response"
          and listener["DefaultActions"][0]["FixedResponseConfig"]["StatusCode"] == "403")
    rules = elb.describe_rules(ListenerArn=listener["ListenerArn"])["Rules"]
    rules = [r for r in rules if not r["IsDefault"]]
    # Values are compared only in memory, never included in reports or logs.
    header = next((h for h in origin["CustomHeaders"]["Items"] if h["HeaderName"].lower() == "x-jeju-origin-verify"), None)
    condition = next((c["HttpHeaderConfig"] for r in rules for c in r["Conditions"] if c["Field"] == "http-header"), None)
    check("CloudFront and ALB share the private origin verification value", bool(header and condition)
          and condition["HttpHeaderName"].lower() == header["HeaderName"].lower()
          and condition["Values"] == [header["HeaderValue"]] and len(header["HeaderValue"]) >= 32)
    del header, condition, config, rules, distribution

    url = outputs["ApplicationUrl"]
    root = requests.get(url + "/", timeout=30)
    check("Public HTTPS app responds", root.status_code == 200 and "제주" in root.text, {"status": root.status_code, "bytes": len(root.content)})
    check("CloudFront serves the response", "cloudfront" in root.headers.get("Via", "").lower() and bool(root.headers.get("X-Amz-Cf-Id")))
    check("Security headers present", root.headers.get("X-Content-Type-Options") == "nosniff"
          and root.headers.get("X-Frame-Options") == "DENY" and "max-age=31536000" in root.headers.get("Strict-Transport-Security", ""))
    redirect = requests.get(url.replace("https://", "http://") + "/", allow_redirects=False, timeout=20)
    check("HTTP redirects to HTTPS", redirect.status_code in [301, 302, 307, 308] and redirect.headers.get("Location", "").startswith(url))
    health = requests.get(url + "/healthz", timeout=30)
    health_data = health.json() if health.status_code == 200 else {}
    check("Live health reports the deployed release", health_data.get("status") == "ok" and health_data.get("release") == image["release"], health_data)
    check("Health is never cached", health.headers.get("Cache-Control") == "no-store")
    readiness = requests.get(url + "/readyz", timeout=30)
    check("Catalog readiness is healthy and never cached", readiness.status_code == 200
          and readiness.headers.get("Cache-Control") == "no-store")
    for host in dict.fromkeys([f"https://{settings['ViewerDomainName']}", outputs.get("CloudFrontUrl", url)]):
        browser = requests.Session()
        configuration = browser.get(host + "/api/config", timeout=30)
        proof = configuration.json().get("guide", {}).get("csrf_token", "")
        validation = browser.post(host + "/api/guide", json={"message": "", "locale": "en"},
                                  headers={"Origin": host, "X-Atlas-CSRF": proof}, timeout=20)
        check("Both served origins accept the app proof before model invocation",
              configuration.status_code == 200 and validation.status_code == 400
              and validation.json().get("error", {}).get("code") == "invalid_message", {"host": host})
    asset = re.search(r'src="(/assets/[^"]+\.js)"', root.text)
    if asset:
        asset_url = url + asset.group(1)
        requests.get(asset_url, timeout=30)
        cached = requests.get(asset_url, timeout=30)
        check("Versioned assets served from CloudFront cache", cached.status_code == 200
              and "Hit from cloudfront" in cached.headers.get("X-Cache", ""),
              {"asset": asset.group(1), "cache": cached.headers.get("X-Cache"), "age": cached.headers.get("Age")})
    else:
        check("Versioned assets present", False)
    missing = requests.get(url + "/assets/does-not-exist.js", timeout=30)
    check("Missing asset returns 404", missing.status_code == 404)
    catalog_response = requests.get(url + "/api/catalog/status", timeout=30)
    catalog_data = catalog_response.json() if catalog_response.status_code == 200 else {}
    check("Live service catalog includes enriched and OSM data", catalog_data.get("total", 0) >= 6000
          and catalog_data.get("by_source", {}).get("OpenStreetMap", 0) >= 6000
          and catalog_data.get("by_source", {}).get("sample", 0) >= 130,
          {"total": catalog_data.get("total"), "bySource": catalog_data.get("by_source")})
    check("Public catalog has no session cookie", not catalog_response.headers.get("Set-Cookie"))
    client = requests.Session()
    api_config = client.get(url + "/api/config", timeout=30)
    api_data = api_config.json() if api_config.status_code == 200 else {}
    check("Private config enables bounded guide without caching", api_config.status_code == 200
          and api_config.headers.get("Cache-Control") == "no-store"
          and api_data.get("guide", {}).get("daily_limit") == 30)
    cookie_header = api_config.headers.get("Set-Cookie", "").lower()
    check("Session cookie is HttpOnly and Secure", "httponly" in cookie_header and "secure" in cookie_header and "samesite=lax" in cookie_header)
    csrf_token = api_data.get("guide", {}).get("csrf_token", "")
    check("Private config returns a bounded session-bound request proof",
          isinstance(csrf_token, str) and bool(re.fullmatch(r"[A-Za-z0-9_-]{43}", csrf_token)))
    rejected = client.post(url + "/api/guide", json={"message": "이 요청은 실행되지 않아야 합니다."},
                           headers={"Origin": "https://example.com"}, timeout=20)
    check("Foreign-origin guide requests rejected", rejected.status_code == 403)
    # Empty messages stop at validation, before quota or model invocation.
    proof_request = client.post(url + "/api/guide", json={"message": ""},
                                headers={"Origin": "null", "X-Atlas-CSRF": csrf_token}, timeout=20)
    check("Verified app requests tolerate a missing browser origin without a model call",
          proof_request.status_code == 400 and proof_request.json().get("error", {}).get("code") == "invalid_message")
    forged_proof = client.post(url + "/api/guide", json={"message": ""},
                               headers={"Origin": "null", "X-Atlas-CSRF": "forged"}, timeout=20)
    check("Forged app request proofs are rejected",
          forged_proof.status_code == 403 and forged_proof.json().get("error", {}).get("code") == "csrf_invalid")
    worker = requests.get(url + "/sw.js", timeout=20)
    check("PWA worker revalidates", worker.status_code == 200 and "no-cache" in worker.headers.get("Cache-Control", ""))

    try:
        direct = requests.get("http://" + outputs["LoadBalancerDnsName"] + "/", timeout=6)
        check("Direct public ALB bypass blocked", direct.status_code == 403, {"status": direct.status_code})
    except requests.exceptions.ConnectTimeout:
        check("Direct public ALB bypass blocked", True, "TCP connection timed out as expected for a non-CloudFront source")
    except requests.exceptions.ConnectionError as error:
        check("Direct public ALB bypass blocked", False, {"error": type(error).__name__, "message": "Network failure is inconclusive; inspect connectivity"})

    report = {
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "account": ACCOUNT,
        "url": url,
        "release": image["release"],
        "checks": checks,
        "passed": all(item["passed"] for item in checks),
        "taskNetwork": task_network,
        "network": network,
    }
    save("verification.json", report)
    emit({"passed": report["passed"], "count": len(checks), "report": str(LOCAL / "verification.json")})
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(verify())
