#!/usr/bin/env python3
"""Deploy the explicitly scoped Jeju stacks without changing shared networking.

Use plan-bootstrap/plan-app, inspect the change-set JSON, then apply.
ECR credentials are piped to an isolated temporary Docker config and removed.
Origin verification secrets are never read or printed by this script.
"""
from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import time
import warnings

warnings.filterwarnings("ignore", category=DeprecationWarning)
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / ".local"
ACCOUNT = "061525506239"
REGION = "ap-northeast-2"
BOOTSTRAP = "Jeju3dRegistry"
APP = "Jeju3dApp"
VPC = "vpc-0dfa5610180dfa628"
PUBLIC = ["subnet-08486a1e618b1991e", "subnet-0c161777c4031c320"]
PRIVATE = ["subnet-07b1e65682847dce9", "subnet-095297380cd45e1eb"]
PREFIX = "pl-22a6434b"
SETTINGS = ROOT / "infra/production.json"
STACKS = {
    "bootstrap": BOOTSTRAP, "app": APP, "origin": "Jeju3dOrigin",
    "edge": "Jeju3dEdge", "operations": "Jeju3dOperations", "data": "Jeju3dData",
    "origin-routing": "Jeju3dOriginRouting", "tls-probe": "Jeju3dTlsProbe",
    "static": "Jeju3dStatic",
}
FARGATE_MEMORY = {
    "256": {512, 1024, 2048},
    "512": set(range(1024, 4097, 1024)),
    "1024": set(range(2048, 8193, 1024)),
    "2048": set(range(4096, 16385, 1024)),
}
ROUTING_MEMORY = {256, 512, 1024, 2048, 4096, 8192}
OWN_CATALOG_BUCKET = f"jeju-3d-data-{ACCOUNT}-{REGION}"


def normalize_routing_image(value):
    if not isinstance(value, dict):
        raise ValueError("A paired routing image is required")
    uri = value.get("imageUri", "")
    pattern = rf"{ACCOUNT}\.dkr\.ecr\.{REGION}\.amazonaws\.com/jeju-3d@sha256:[a-f0-9]{{64}}"
    if not isinstance(uri, str) or not re.fullmatch(pattern, uri):
        raise ValueError("Routing must use an immutable image in the owned repository")
    date = value.get("dataUpdatedAt")
    date = "" if date is None else date
    if not isinstance(date, str) or len(date) > 40:
        raise ValueError("Invalid routing source timestamp")
    if date:
        try:
            if datetime.fromisoformat(date.replace("Z", "+00:00")).tzinfo is None:
                raise ValueError()
        except ValueError:
            raise ValueError("Invalid routing source timestamp") from None
    if value.get("engineVersion", "3.8.3") != "3.8.3":
        raise ValueError("Routing graph must use the pinned engine version")
    return {"imageUri": uri, "dataUpdatedAt": date}


def routing_parameters(image, settings, existing):
    paired = image.get("routing")
    enabled = settings.get("RoutingEnabled") == "true"
    if enabled and paired is None:
        raise ValueError("Build the web release with its routing image before enabling routing")
    if paired is not None and not enabled:
        raise ValueError("The web release contains routing; enable it explicitly")
    if not enabled and existing.get("RoutingImageUri") and settings.get("RoutingEnabled") != "false":
        raise ValueError("Do not implicitly remove an existing routing sidecar")
    routing = normalize_routing_image(paired) if enabled else {"imageUri": "", "dataUpdatedAt": ""}
    cpu = str(settings.get("TaskCpu", existing.get("TaskCpu", "256")))
    memory = str(settings.get("TaskMemory", existing.get("TaskMemory", "512")))
    if enabled and not {"TaskCpu", "TaskMemory"} & settings.keys() and (cpu, memory) == ("256", "512"):
        cpu, memory = "512", "1024"
    if cpu not in FARGATE_MEMORY or not memory.isdigit() or int(memory) not in FARGATE_MEMORY[cpu]:
        raise ValueError("Unsupported Fargate task CPU/memory pair")
    route_memory = str(settings.get("RoutingMemory", existing.get("RoutingMemory", "512")))
    if not route_memory.isdigit() or int(route_memory) not in ROUTING_MEMORY:
        raise ValueError("Unsupported routing memory limit")
    if enabled and (int(cpu) < 512 or int(memory) - int(route_memory) < 256):
        raise ValueError("Routing must leave CPU and memory for the web container")
    return {
        "RoutingImageUri": routing["imageUri"], "RoutingDataUpdatedAt": routing["dataUpdatedAt"],
        "TaskCpu": cpu, "TaskMemory": memory, "RoutingMemory": route_memory,
    }


def atlas_agent_parameters(path=None):
    """New app plans require the dedicated Atlas runtime and catalog boundary."""
    path = Path(path) if path is not None else LOCAL / "atlas-agent-outputs.json"
    raw = path.read_bytes()
    if len(raw) > 64 * 1024:
        raise ValueError("Atlas agent outputs are oversized")
    value = json.loads(raw)
    arn = value.get("guideRuntimeArn", "") if isinstance(value, dict) else ""
    pattern = rf"arn:aws:bedrock-agentcore:{REGION}:{ACCOUNT}:runtime/JejuAtlas_Guide(?:-[A-Za-z0-9_-]+)?"
    if (not isinstance(arn, str) or not re.fullmatch(pattern, arn)
            or value.get("catalogBucket") != OWN_CATALOG_BUCKET):
        raise ValueError("Atlas outputs must identify a separate owned runtime")
    return {"GuideRuntimeArn": arn, "CatalogBucket": OWN_CATALOG_BUCKET}


def validate_settings(values):
    """Validate non-secret production settings before creating an AWS change set."""
    integer_bounds = {
        "DesiredCount": (1, 4), "MinTaskCount": (2, 4), "MaxTaskCount": (2, 4),
        "GuideDailyLimit": (1, 30), "GuideHourlyLimit": (1, 5), "GuideGlobalConcurrency": (1, 2),
        "KakaoDailyLimit": (1, 1000),
    }
    allowed = {
        "ViewerDomainName", "ViewerCertificateArn", "OriginDomainName",
        "OriginTlsEnabled", "OriginTlsMode", "TargetHealthPath",
        "RoutingEnabled", "TaskCpu", "TaskMemory", "RoutingMemory",
        "KakaoRestApiKeyParameter", "GuideLimitsEnabled",
    } | set(integer_bounds)
    if not isinstance(values, dict) or set(values) - allowed:
        raise ValueError("Unknown production setting; secrets and networking do not belong here")
    domain = values.get("ViewerDomainName", "")
    certificate = values.get("ViewerCertificateArn", "")
    if not isinstance(domain, str) or not isinstance(certificate, str) or bool(domain) != bool(certificate):
        raise ValueError("ViewerDomainName and ViewerCertificateArn must be supplied together")
    if domain and not re.fullmatch(r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}", domain):
        raise ValueError("ViewerDomainName must be a lowercase DNS hostname")
    if certificate and not re.fullmatch(rf"arn:aws:acm:us-east-1:{ACCOUNT}:certificate/[a-f0-9-]{{36}}", certificate):
        raise ValueError("The viewer certificate must belong to this account in us-east-1")
    result = {
        "ViewerDomainName": domain, "ViewerCertificateArn": certificate,
    }
    guide_limits = values.get("GuideLimitsEnabled", "true")
    if guide_limits not in ("true", "false"):
        raise ValueError("GuideLimitsEnabled must be the string true or false")
    result["GuideLimitsEnabled"] = guide_limits
    kakao_parameter = values.get("KakaoRestApiKeyParameter", "")
    if kakao_parameter not in ("", "/jeju-atlas/kakao-rest-api-key"):
        raise ValueError("KakaoRestApiKeyParameter must reference the owned SecureString, never a key value")
    result["KakaoRestApiKeyParameter"] = kakao_parameter
    for key, bounds in integer_bounds.items():
        raw = values.get(key, {
            "DesiredCount": 2, "MinTaskCount": 2, "MaxTaskCount": 4,
            "GuideDailyLimit": 30, "GuideHourlyLimit": 5, "GuideGlobalConcurrency": 2,
            "KakaoDailyLimit": 1000,
        }[key])
        if isinstance(raw, bool) or not re.fullmatch(r"\d+", str(raw)) or not bounds[0] <= int(raw) <= bounds[1]:
            raise ValueError(f"{key} must be an integer between {bounds[0]} and {bounds[1]}")
        result[key] = str(raw)
    if int(result["MinTaskCount"]) > int(result["MaxTaskCount"]):
        raise ValueError("Minimum capacity cannot exceed maximum capacity")
    if int(result["DesiredCount"]) > int(result["MaxTaskCount"]):
        raise ValueError("Desired capacity cannot exceed maximum capacity")
    if int(result["DesiredCount"]) < int(result["MinTaskCount"]):
        raise ValueError("Desired capacity cannot be below the configured minimum")
    origin_domain = values.get("OriginDomainName", "")
    tls = values.get("OriginTlsEnabled", "false")
    tls_mode = values.get("OriginTlsMode", "dns")
    if not isinstance(origin_domain, str) or origin_domain and not re.fullmatch(r"[a-z0-9-]+\.whchoi\.net", origin_domain):
        raise ValueError("OriginDomainName must be a public hostname under whchoi.net")
    if tls not in ("true", "false"):
        raise ValueError("OriginTlsEnabled must be the string true or false")
    if tls_mode not in ("dns", "canonical-host"):
        raise ValueError("OriginTlsMode must be dns or canonical-host")
    if tls == "true" and tls_mode == "dns" and (not origin_domain or origin_domain == domain):
        raise ValueError("TLS requires a separate public origin hostname pointing directly to the ALB")
    if tls == "true" and tls_mode == "canonical-host" and not domain:
        raise ValueError("Canonical origin TLS requires the existing viewer domain and certificate")
    result.update(OriginDomainName=origin_domain, OriginTlsEnabled=tls, OriginTlsMode=tls_mode)
    health_path = values.get("TargetHealthPath", "/readyz")
    if health_path not in ("/readyz", "/healthz"):
        raise ValueError("TargetHealthPath must be /readyz or /healthz")
    result["TargetHealthPath"] = health_path
    if "RoutingEnabled" in values:
        if values["RoutingEnabled"] not in ("true", "false"):
            raise ValueError("RoutingEnabled must be the string true or false")
        result["RoutingEnabled"] = values["RoutingEnabled"]
    if {"TaskCpu", "TaskMemory"} & values.keys():
        cpu, memory = str(values.get("TaskCpu", "")), str(values.get("TaskMemory", ""))
        if cpu not in FARGATE_MEMORY or not memory.isdigit() or int(memory) not in FARGATE_MEMORY[cpu]:
            raise ValueError("Provide a supported TaskCpu/TaskMemory pair")
        result.update(TaskCpu=cpu, TaskMemory=memory)
    if "RoutingMemory" in values:
        memory = str(values["RoutingMemory"])
        if not memory.isdigit() or int(memory) not in ROUTING_MEMORY:
            raise ValueError("Unsupported routing container memory limit")
        result["RoutingMemory"] = memory
    return result


def assert_kakao_parameter(session, settings):
    """Check metadata only; the deployer never reads the provider key value."""
    name = settings.get("KakaoRestApiKeyParameter")
    if not name:
        return
    rows = session.client("ssm").describe_parameters(ParameterFilters=[
        {"Key": "Name", "Option": "Equals", "Values": [name]},
    ])["Parameters"]
    if len(rows) != 1 or rows[0].get("Name") != name or rows[0].get("Type") != "SecureString":
        raise ValueError("Create the owned Kakao SecureString before enabling this feature")


def validate_live_domain(settings, distribution):
    """Refuse to remove live aliases merely because they were missing from IaC."""
    requested = {settings.get("ViewerDomainName")} - {"", None}
    existing = set(distribution.get("Aliases", {}).get("Items", []))
    if not existing.issubset(requested):
        raise ValueError("Production settings would remove a live CloudFront alias; reconcile the domain configuration first")


def preserved_desired_count(configured, current, maximum=4):
    desired = max(int(configured), int(current))
    if desired > int(maximum):
        raise ValueError("Current service capacity exceeds the configured maximum; review sizing instead of scaling in during deployment")
    return str(desired)


def validate_readiness_transition(current_path, requested_path, supports_ready, service_stable):
    if current_path != "/readyz" and requested_path == "/readyz" and not (supports_ready and service_stable):
        raise ValueError("Deploy the readiness-capable image with /healthz first; switch to /readyz only after the service is stable")


def domain_matches(certificate_name, hostname):
    return certificate_name == hostname or (
        certificate_name.startswith("*.") and hostname.split(".", 1)[-1] == certificate_name[2:]
        and hostname.count(".") == certificate_name.count(".")
    )


def assert_domain(session, settings, outputs):
    if outputs.get("DistributionId"):
        distribution = session.client("cloudfront").get_distribution_config(
            Id=outputs["DistributionId"],
        )["DistributionConfig"]
        # The response includes the origin secret: only compare public alias fields
        # in memory, never serialize or print the response.
        validate_live_domain(settings, distribution)
    certificate_arn = settings.get("ViewerCertificateArn")
    if certificate_arn:
        certificate = session.client("acm", region_name="us-east-1").describe_certificate(
            CertificateArn=certificate_arn,
        )["Certificate"]
        if certificate["Status"] != "ISSUED" or not any(
            domain_matches(name, settings["ViewerDomainName"])
            for name in certificate.get("SubjectAlternativeNames", [])
        ):
            raise ValueError("The issued viewer certificate must cover the configured hostname")


def stack_client(session, kind):
    return session.client("cloudformation", region_name="us-east-1") if kind in ("edge", "origin-routing") else session.client("cloudformation")


def optional_stack_outputs(session, kind):
    try:
        stack = stack_client(session, kind).describe_stacks(StackName=STACKS[kind])["Stacks"][0]
    except ClientError as error:
        if "does not exist" in str(error):
            return {}
        raise
    if stack["StackStatus"] not in ("CREATE_COMPLETE", "UPDATE_COMPLETE"):
        raise RuntimeError(f"{STACKS[kind]} must be stable before planning the app")
    return {item["OutputKey"]: item["OutputValue"] for item in stack.get("Outputs", [])}


def assert_origin_tls(session, params, outputs):
    certificate_arn = params.get("OriginCertificateArn", "")
    if certificate_arn:
        certificate = session.client("acm").describe_certificate(CertificateArn=certificate_arn)["Certificate"]
        if certificate["Status"] != "ISSUED":
            raise ValueError("The ALB origin certificate must be issued before it is attached")
    if params.get("OriginTlsEnabled") == "true":
        use_host = params.get("OriginTlsMode", "dns") == "canonical-host"
        identity = params["ViewerDomainName"] if use_host else params["OriginDomainName"]
        if not certificate_arn or not any(
            domain_matches(name, identity)
            for name in certificate.get("SubjectAlternativeNames", [])
        ):
            raise ValueError("The regional certificate must cover the configured origin domain")
        if use_host:
            routing = optional_stack_outputs(session, "origin-routing")
            arn = params.get("OriginHostFunctionVersionArn")
            if (not arn or routing.get("OriginHostFunctionVersionArn") != arn
                    or routing.get("AlbDomainName") != outputs.get("LoadBalancerDnsName")
                    or routing.get("CanonicalHostName") != identity):
                raise ValueError("The immutable origin function must match this ALB and certificate identity")
            config = session.client("cloudfront").get_distribution_config(Id=outputs["DistributionId"])["DistributionConfig"]
            origin = next(item for item in config["Origins"]["Items"] if item["Id"] == "jeju-alb")
            behaviors = [config["DefaultCacheBehavior"], *config.get("CacheBehaviors", {}).get("Items", [])]
            relevant = [item for item in behaviors if item["TargetOriginId"] == "jeju-alb"]
            live = (origin["DomainName"] == outputs["LoadBalancerDnsName"]
                    and origin["CustomOriginConfig"]["OriginProtocolPolicy"] == "https-only"
                    and len(relevant) == 3 and all(any(
                        row["LambdaFunctionARN"] == arn and row["EventType"] == "origin-request" and not row.get("IncludeBody")
                        for row in item.get("LambdaFunctionAssociations", {}).get("Items", [])
                    ) for item in relevant))
            if not live:
                proof_path = LOCAL / "tls-probe-verification.json"
                proof = json.loads(proof_path.read_text()) if proof_path.exists() else {}
                if (not proof.get("passed") or proof.get("functionVersionArn") != arn
                        or proof.get("albDomainName") != outputs["LoadBalancerDnsName"]
                        or proof.get("canonicalHostName") != identity):
                    raise ValueError("Verify the isolated canonical-host HTTPS probe before changing production")
            return
        canonical, aliases, _ = socket.gethostbyname_ex(params["OriginDomainName"])
        expected = outputs.get("LoadBalancerDnsName", "").lower()
        if not expected or canonical.rstrip(".").lower() != expected.rstrip("."):
            raise ValueError("Public origin DNS must resolve directly to this ALB before enabling HTTPS")


def infrastructure_parameters(session, kind):
    if kind in ("bootstrap", "origin"):
        return {}
    outputs = stack_outputs(session.client("cloudformation"), APP)
    if kind in ("edge", "static"):
        return {"DistributionArn": f"arn:aws:cloudfront::{ACCOUNT}:distribution/{outputs['DistributionId']}"}
    if kind == "origin-routing":
        settings = validate_settings(json.loads(SETTINGS.read_text()))
        values = {"AlbDomainName": outputs["LoadBalancerDnsName"], "CanonicalHostName": settings["ViewerDomainName"]}
        body = (ROOT / "infra/origin-routing.yaml").read_bytes() + json.dumps(values, sort_keys=True).encode()
        values["CodeRevision"] = hashlib.sha256(body).hexdigest()[:20]
        return values
    if kind == "tls-probe":
        routing = optional_stack_outputs(session, "origin-routing")
        edge = optional_stack_outputs(session, "edge")
        if not routing or not edge or routing["AlbDomainName"] != outputs["LoadBalancerDnsName"]:
            raise ValueError("Prepare the owned origin function and WAF before the TLS probe")
        secret = session.client("cloudformation").describe_stack_resource(
            StackName=APP, LogicalResourceId="OriginSecret")["StackResourceDetail"]["PhysicalResourceId"]
        return {
            "AlbDomainName": outputs["LoadBalancerDnsName"],
            "OriginHostFunctionVersionArn": routing["OriginHostFunctionVersionArn"],
            "OriginSecretArn": secret, "WebAclArn": edge["WebAclArn"],
        }
    if kind == "operations":
        data = optional_stack_outputs(session, "data")
        return {
            "ClusterName": outputs["ClusterName"], "ServiceName": outputs["ServiceName"],
            "AlbFullName": outputs["LoadBalancerArn"].split(":loadbalancer/", 1)[1],
            "TargetGroupFullName": outputs["TargetGroupArn"].split(":", 5)[5],
            "LogGroupName": outputs["LogGroupName"],
            "GuideQuotaTableName": outputs["GuideQuotaTableName"],
            "OfficialDetailsEnabled": "true" if data.get("WorkerTaskDefinitionArn") else "false",
        }
    if kind == "data":
        assert_network(session)
        values = {
            "CatalogBucket": OWN_CATALOG_BUCKET,
            "DistributionArn": f"arn:aws:cloudfront::{ACCOUNT}:distribution/{outputs['DistributionId']}",
            "VpcId": VPC, "PrivateSubnetIds": ",".join(PRIVATE),
        }
        operations = optional_stack_outputs(session, "operations")
        if operations:
            values["DataNotificationsTopicArn"] = operations["NotificationTopicArn"]
        if (LOCAL / "data-image.json").is_file():
            values["WorkerImageUri"] = load("data-image.json")["imageUri"]
        settings_path = ROOT / "infra/data-settings.json"
        if settings_path.exists():
            settings = json.loads(settings_path.read_text())
            if settings.get("ScheduleState") not in ("ENABLED", "DISABLED") or set(settings) != {"ScheduleState"}:
                raise ValueError("Data schedule settings must contain only ENABLED or DISABLED ScheduleState")
            values.update(settings)
        return values
    raise ValueError("Unexpected infrastructure stack")


def emit(value):
    print(json.dumps(value, ensure_ascii=False, default=str), flush=True)


def save(name, value):
    LOCAL.mkdir(exist_ok=True)
    (LOCAL / name).write_text(json.dumps(value, indent=2, ensure_ascii=False, default=str) + "\n")


def load(name):
    return json.loads((LOCAL / name).read_text())


def connect():
    session = boto3.Session(region_name=REGION)
    actual = session.client("sts").get_caller_identity()["Account"]
    if actual != ACCOUNT:
        raise RuntimeError(f"Refusing deployment to unexpected account {actual}; expected {ACCOUNT}")
    return session


def stack_outputs(cf, name):
    return {
        value["OutputKey"]: value["OutputValue"]
        for value in cf.describe_stacks(StackName=name)["Stacks"][0].get("Outputs", [])
    }


def assert_network(session):
    ec2 = session.client("ec2")
    vpc = ec2.describe_vpcs(VpcIds=[VPC])["Vpcs"][0]
    if not any(t["Key"] == "Name" and t["Value"] == "cc-on-bedrock-vpc" for t in vpc.get("Tags", [])):
        raise RuntimeError("VPC name does not match the user's requested VPC")
    subnets = ec2.describe_subnets(SubnetIds=PUBLIC + PRIVATE)["Subnets"]
    if any(s["VpcId"] != VPC or s["State"] != "available" for s in subnets):
        raise RuntimeError("Subnets must all be available in the requested VPC")
    if len({s["AvailabilityZone"] for s in subnets if s["SubnetId"] in PUBLIC}) < 2:
        raise RuntimeError("ALB requires public subnets in at least two availability zones")
    routes = ec2.describe_route_tables(Filters=[{"Name": "vpc-id", "Values": [VPC]}])["RouteTables"]
    main = next(r for r in routes if any(a.get("Main") for a in r["Associations"]))
    network = []
    for subnet in subnets:
        subnet_id = subnet["SubnetId"]
        table = next((r for r in routes if any(a.get("SubnetId") == subnet_id for a in r["Associations"])), main)
        route = next((r for r in table["Routes"] if r.get("DestinationCidrBlock") == "0.0.0.0/0" and r["State"] == "active"), None)
        if not route:
            raise RuntimeError(f"No active default route for {subnet_id}")
        if subnet_id in PUBLIC and not route.get("GatewayId", "").startswith("igw-"):
            raise RuntimeError(f"ALB subnet {subnet_id} is not public")
        if subnet_id in PRIVATE:
            if not route.get("NatGatewayId"):
                raise RuntimeError(f"Task subnet {subnet_id} does not reuse a NAT Gateway")
            if subnet["MapPublicIpOnLaunch"]:
                raise RuntimeError(f"Task subnet {subnet_id} maps public IPs on launch")
            nat = ec2.describe_nat_gateways(NatGatewayIds=[route["NatGatewayId"]])["NatGateways"][0]
            if nat["State"] != "available" or nat["VpcId"] != VPC:
                raise RuntimeError(f"NAT {nat['NatGatewayId']} is not available in the requested VPC")
        network.append({
            "subnet": subnet_id, "az": subnet["AvailabilityZone"], "cidr": subnet["CidrBlock"],
            "role": "public-alb" if subnet_id in PUBLIC else "private-ecs",
            "routeTable": table["RouteTableId"],
            "defaultRoute": route.get("NatGatewayId", route.get("GatewayId")),
        })
    prefix = ec2.describe_managed_prefix_lists(PrefixListIds=[PREFIX])["PrefixLists"][0]
    if prefix["OwnerId"] != "AWS" or prefix["PrefixListName"] != "com.amazonaws.global.cloudfront.origin-facing":
        raise RuntimeError("Prefix list is not the AWS managed CloudFront origin-facing list")
    save("network.json", {"account": ACCOUNT, "region": REGION, "vpc": VPC, "prefixList": PREFIX, "subnets": network})
    emit({"network": "verified", "subnets": network})


def plan(session, kind, overrides=None):
    cf = stack_client(session, kind)
    if kind not in STACKS:
        raise ValueError("Unexpected stack kind")
    # A failed or no-op plan must not leave an older change set available to apply.
    save(f"{kind}-change-set.json", {"stack": STACKS[kind], "status": "PLANNING"})
    if kind == "app":
        assert_network(session)
        image = load("image.json")
        registry = stack_outputs(cf, BOOTSTRAP)
        params = {
            "VpcId": VPC,
            "PublicSubnetIds": ",".join(PUBLIC),
            "PrivateSubnetIds": ",".join(PRIVATE),
            "CloudFrontPrefixListId": PREFIX,
            "ImageUri": image["imageUri"],
            "RepositoryArn": registry["RepositoryArn"],
            "Release": image["release"],
        }
        settings = validate_settings(json.loads(SETTINGS.read_text()))
        assert_kakao_parameter(session, settings)
        params.update({key: value for key, value in settings.items() if key != "RoutingEnabled"})
        # Never fall back to the reference runtime/catalog on a new app deployment.
        params.update(atlas_agent_parameters())
        edge = optional_stack_outputs(session, "edge")
        origin = optional_stack_outputs(session, "origin")
        data = optional_stack_outputs(session, "data")
        routing = optional_stack_outputs(session, "origin-routing")
        assets = optional_stack_outputs(session, "static")
        if edge:
            params["WebAclArn"] = edge["WebAclArn"]
        if origin:
            params["OriginCertificateArn"] = origin["OriginCertificateArn"]
        if routing:
            params["OriginHostFunctionVersionArn"] = routing["OriginHostFunctionVersionArn"]
        if assets:
            require_asset_manifest(session, assets["AssetsBucketName"], image["imageUri"])
            params.update({
                "AssetsBucketDomainName": assets["AssetsBucketDomainName"],
                "AssetsOriginAccessControlId": assets["AssetsOriginAccessControlId"],
            })
        if data:
            params.update({
                "DetailsBucket": data["DetailsBucketName"],
                "MediaBucketDomainName": data["MediaBucketDomainName"],
                "MediaOriginAccessControlId": data["MediaOriginAccessControlId"],
            })
        name, template = APP, ROOT / "infra/application.yaml"
    else:
        name, template, params = STACKS[kind], ROOT / f"infra/{kind}.yaml", infrastructure_parameters(session, kind)
    if overrides:
        if kind != "tls-probe" or overrides != {"Enabled": "false"}:
            raise ValueError("Only the owned probe disable operation accepts a parameter override")
        params.update(overrides)
    subprocess.run(["cfn-lint", str(template)], check=True, cwd=ROOT)
    try:
        existing = cf.describe_stacks(StackName=name)["Stacks"][0]
        if existing["StackStatus"] == "ROLLBACK_COMPLETE":
            raise RuntimeError("Stack rolled back; inspect events before changing it")
        change_type = "CREATE" if existing["StackStatus"] == "REVIEW_IN_PROGRESS" else "UPDATE"
        if change_type == "UPDATE":
            for item in existing.get("Parameters", []):
                if item.get("ParameterValue") and item["ParameterValue"] != "****":
                    params.setdefault(item["ParameterKey"], item["ParameterValue"])
        if kind == "app" and change_type == "UPDATE":
            current_parameters = {item["ParameterKey"]: item.get("ParameterValue", "")
                                  for item in existing.get("Parameters", [])}
            params.update(routing_parameters(image, settings, current_parameters))
            verify_routing_image(session, image.get("routing"))
            outputs = {item["OutputKey"]: item["OutputValue"] for item in existing.get("Outputs", [])}
            # Preserve existing non-secret parameters not overridden by the
            # checked-in settings (for example a previously deployed WebACL).
            assert_domain(session, settings, outputs)
            assert_origin_tls(session, params, outputs)
            services = session.client("ecs").describe_services(
                cluster=outputs["ClusterName"], services=[outputs["ServiceName"]],
            )["services"]
            if len(services) != 1:
                raise RuntimeError("Expected the existing Jeju service before planning an update")
            params["DesiredCount"] = preserved_desired_count(
                settings["DesiredCount"], services[0]["desiredCount"], settings["MaxTaskCount"],
            )
            if settings["TargetHealthPath"] == "/readyz":
                target = session.client("elbv2").describe_target_groups(TargetGroupArns=[outputs["TargetGroupArn"]])["TargetGroups"][0]
                task = session.client("ecs").describe_task_definition(taskDefinition=services[0]["taskDefinition"])["taskDefinition"]
                env = {item["name"]: item["value"] for item in task["containerDefinitions"][0].get("environment", [])}
                stable = services[0]["runningCount"] == services[0]["desiredCount"] and not services[0]["pendingCount"]
                stable = stable and len(services[0]["deployments"]) == 1 and services[0]["deployments"][0].get("rolloutState") == "COMPLETED"
                validate_readiness_transition(target["HealthCheckPath"], "/readyz", env.get("ATLAS_READY_ENDPOINT") == "true", stable)
    except ClientError as error:
        if "does not exist" not in str(error):
            raise
        change_type = "CREATE"
    if kind == "app" and change_type == "CREATE":
        params.update(routing_parameters(image, settings, {}))
        verify_routing_image(session, image.get("routing"))
        assert_domain(session, settings, {})
        assert_origin_tls(session, params, {})
    if kind == "app" and not params.get("GuideRuntimeArn"):
        raise ValueError("Provide an explicitly selected dedicated guide runtime for a new app stack")
    change_name = "jeju-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    created = cf.create_change_set(
        StackName=name,
        ChangeSetName=change_name,
        ChangeSetType=change_type,
        Description="User-requested Jeju Atlas deployment; existing VPC and NAT reused",
        TemplateBody=template.read_text(),
        Parameters=[{"ParameterKey": key, "ParameterValue": value} for key, value in params.items()],
        Capabilities=["CAPABILITY_IAM"],
        Tags=[{"Key": "Project", "Value": "jeju-3d"}, {"Key": "ManagedBy", "Value": "CloudFormation"}],
    )
    while True:
        detail = cf.describe_change_set(ChangeSetName=created["Id"])
        if detail["Status"] in ["CREATE_COMPLETE", "FAILED"]:
            break
        time.sleep(2)
    if detail["Status"] == "FAILED":
        if "didn't contain changes" in detail.get("StatusReason", ""):
            save(f"{kind}-change-set.json", {"stack": name, "status": "NO_CHANGES"})
            emit({"stack": name, "noChanges": True})
            return
        raise RuntimeError(detail.get("StatusReason", "Change set failed"))
    changes = [item["ResourceChange"] for item in detail["Changes"]]
    forbidden = {
        "AWS::EC2::VPC", "AWS::EC2::Subnet", "AWS::EC2::NatGateway", "AWS::EC2::EIP",
        "AWS::EC2::RouteTable", "AWS::EC2::Route", "AWS::EC2::InternetGateway",
        "AWS::Route53::HostedZone", "AWS::Route53::RecordSet",
    }
    if any(change["ResourceType"] in forbidden for change in changes):
        raise RuntimeError("Change set would modify shared networking or DNS")
    # A new immutable task-definition revision is the normal ECS image-update
    # path. Other replacements and removals need explicit operator review.
    if any(change["Action"] == "Remove" or (
        change.get("Replacement") == "True" and change["ResourceType"] != "AWS::ECS::TaskDefinition"
        and not (kind == "origin-routing" and change["ResourceType"] == "AWS::Lambda::Version"
                 and change["LogicalResourceId"] == "OriginHostVersion")
    ) for change in changes):
        raise RuntimeError("Destructive changes need explicit review; no action executed")
    review = {
        "stack": name, "changeSetArn": created["Id"], "type": change_type, "status": "REVIEWABLE",
        "parameters": params,
        "changes": [
            {key: change[key] for key in ["Action", "LogicalResourceId", "ResourceType", "Replacement"] if key in change}
            for change in changes
        ],
    }
    save(f"{kind}-change-set.json", review)
    emit(review)


def prepare_edge_log_groups(session):
    """Precreate this function's log group with retention, never grant group creation to the function."""
    regions = [item["RegionName"] for item in session.client("ec2").describe_regions()["Regions"]
               if item["RegionName"] != "us-east-1"]
    name = "/jeju-3d/edge-origin"

    def prepare(region):
        logs = session.client("logs", region_name=region,
                              config=Config(connect_timeout=5, read_timeout=10, retries={"total_max_attempts": 2}))
        existing = [item for item in logs.describe_log_groups(logGroupNamePrefix=name)["logGroups"]
                    if item["logGroupName"] == name]
        if existing:
            tags = logs.list_tags_log_group(logGroupName=name).get("tags", {})
            if tags.get("Project") != "jeju-3d" or tags.get("Component") != "edge-origin":
                raise ValueError(f"Refusing to take over an existing log group in {region}")
        else:
            logs.create_log_group(logGroupName=name, tags={"Project": "jeju-3d", "Component": "edge-origin"})
        logs.put_retention_policy(logGroupName=name, retentionInDays=14)
        return region

    with ThreadPoolExecutor(max_workers=4) as pool:
        prepared = list(pool.map(prepare, regions))
    save("origin-routing-log-groups.json", {"logGroupName": name, "retentionInDays": 14, "regions": sorted(prepared)})
    emit({"edgeLogGroups": len(prepared), "retentionInDays": 14})


def apply(session, kind):
    cf = stack_client(session, kind)
    review = load(f"{kind}-change-set.json")
    if review["stack"] != STACKS[kind] or review.get("status") != "REVIEWABLE":
        raise RuntimeError("Run and review a successful plan for this stack before applying")
    arn = review["changeSetArn"]
    detail = cf.describe_change_set(ChangeSetName=arn)
    if detail["ExecutionStatus"] != "AVAILABLE":
        raise RuntimeError(f"Change set is not available: {detail['ExecutionStatus']}")
    if kind == "origin-routing":
        prepare_edge_log_groups(session)
    cf.execute_change_set(ChangeSetName=arn)
    emit({"started": review["stack"], "changeSet": arn})


def verify_routing_image(session, routing):
    if routing is None:
        return
    value = normalize_routing_image(routing)
    digest = value["imageUri"].split("@", 1)[1]
    images = session.client("ecr").describe_images(
        registryId=ACCOUNT, repositoryName="jeju-3d", imageIds=[{"imageDigest": digest}],
    )["imageDetails"]
    if len(images) != 1 or images[0]["imageDigest"] != digest:
        raise ValueError("The paired routing image is not available in ECR")


def routing_source():
    spec = importlib.util.spec_from_file_location("jeju_routing_runtime", ROOT / "routing/runtime.py")
    runtime = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runtime)
    path = ROOT / ".local/routing-data"
    source = runtime.validate_artifacts(path)
    return {
        "engineVersion": runtime.ENGINE_VERSION, "baseImage": runtime.BASE_IMAGE,
        "dataUpdatedAt": runtime.data_updated_at(source.get("data_updated_at")),
        "sourceSha256": runtime.file_hash(path / "source.json"),
        "graphSha256": source["files"]["valhalla_tiles.tar"]["sha256"],
    }


def build_push(session, data_worker=False, routing_worker=False):
    if data_worker and routing_worker:
        raise ValueError("Select one image build type")
    cf = session.client("cloudformation")
    ecr = session.client("ecr")
    registry = stack_outputs(cf, BOOTSTRAP)
    uri = registry["RepositoryUri"]
    prefix = "routing-release-" if routing_worker else "data-release-" if data_worker else "release-"
    release = prefix + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    tag = f"{uri}:{release}"
    metadata = routing_source() if routing_worker else {}
    paired = None
    if not data_worker and not routing_worker:
        settings = validate_settings(json.loads(SETTINGS.read_text()))
        if settings.get("RoutingEnabled") == "true":
            paired = normalize_routing_image(load("routing-image.json"))
            verify_routing_image(session, paired)
    if routing_worker:
        subprocess.run(["python3", "-m", "unittest", "discover", "-s", "tests", "-p", "routing_image_test.py"],
                       check=True, cwd=ROOT)
    elif data_worker:
        subprocess.run(["python3", "-m", "unittest", "discover", "-s", "tests", "-p", "*detail*test.py"], check=True, cwd=ROOT)
    else:
        subprocess.run(["node", "scripts/check.mjs"], check=True, cwd=ROOT)
    dockerfile = "Dockerfile.routing" if routing_worker else "Dockerfile.data" if data_worker else "Dockerfile"
    command = ["docker", "build", "--platform", "linux/arm64", "--file", dockerfile, "--tag", tag]
    if routing_worker:
        # Refresh signed Ubuntu fixes for the pinned engine on every release.
        # Artifact sealing remains network-isolated in Dockerfile.routing.
        command.extend(["--network", "default", "--no-cache"])
    subprocess.run([*command, "."], check=True, cwd=ROOT)
    token = ecr.get_authorization_token()["authorizationData"][0]
    username, password = base64.b64decode(token["authorizationToken"]).decode().split(":", 1)
    with tempfile.TemporaryDirectory(prefix="jeju-ecr-") as config:
        subprocess.run(
            ["docker", "--config", config, "login", "--username", username, "--password-stdin", token["proxyEndpoint"]],
            input=password + "\n", text=True, check=True, capture_output=True,
        )
        subprocess.run(["docker", "--config", config, "push", tag], check=True)
    result = ecr.describe_images(repositoryName="jeju-3d", imageIds=[{"imageTag": release}])["imageDetails"][0]
    image = {"release": release, "tag": tag, "digest": result["imageDigest"], "imageUri": f"{uri}@{result['imageDigest']}"}
    if routing_worker:
        image.update(metadata)
    elif not data_worker:
        image["routing"] = paired
    save("routing-image.json" if routing_worker else "data-image.json" if data_worker else "image.json", image)
    if not data_worker and not routing_worker:
        (LOCAL / "release-pairs").mkdir(parents=True, exist_ok=True)
        save(f"release-pairs/{result['imageDigest'].split(':', 1)[1]}.json", image)
        assets = optional_stack_outputs(session, "static")
        if assets:
            subprocess.run([
                "python3", "scripts/publish-assets.py", "--image-uri", image["imageUri"],
                "--bucket", assets["AssetsBucketName"], "--execute",
            ], check=True, cwd=ROOT)
    emit(image)


def require_asset_manifest(session, bucket, image_uri):
    """A manifest is committed only after every asset has an immutable S3 copy."""
    if bucket != f"jeju-3d-assets-{ACCOUNT}-{REGION}" or not re.fullmatch(
        rf"{ACCOUNT}\.dkr\.ecr\.{REGION}\.amazonaws\.com/jeju-3d@sha256:[a-f0-9]{{64}}", image_uri
    ):
        raise ValueError("Unexpected shared asset bucket or image")
    key = "releases/" + image_uri.split("@sha256:", 1)[1] + ".json"
    body = session.client("s3", config=Config(connect_timeout=3, read_timeout=10,
                                            retries={"total_max_attempts": 1})).get_object(Bucket=bucket, Key=key)["Body"]
    try:
        raw = body.read(2 * 1024 * 1024 + 1)
    finally:
        body.close()
    if len(raw) > 2 * 1024 * 1024:
        raise ValueError("The asset release manifest is too large")
    manifest = json.loads(raw)
    entries = manifest.get("assetsSHA")
    if (manifest.get("version") != 1 or manifest.get("imageUri") != image_uri
            or not isinstance(entries, dict) or not 1 <= len(entries) <= 1024
            or any(not name.startswith("assets/") or ".." in name.split("/") or "\\" in name
                   or not isinstance(digest, str) or not re.fullmatch("[a-f0-9]{64}", digest)
                   for name, digest in entries.items())):
        raise ValueError("Publish the complete selected image's shared assets before planning deployment")
    return manifest


def status(session, kind):
    cf = stack_client(session, kind)
    name = STACKS[kind]
    stack = cf.describe_stacks(StackName=name)["Stacks"][0]
    events = cf.describe_stack_events(StackName=name)["StackEvents"][:12]
    emit({
        "stack": name, "status": stack["StackStatus"],
        "events": [
            {key: event[key] for key in ["Timestamp", "LogicalResourceId", "ResourceStatus", "ResourceStatusReason"] if key in event}
            for event in events
        ],
    })
    if stack["StackStatus"] in ["CREATE_COMPLETE", "UPDATE_COMPLETE"]:
        outputs = stack_outputs(cf, name)
        save(f"{kind}-outputs.json", outputs)
        emit({"outputs": outputs})


def delete_tls_probe(session):
    cf = session.client("cloudformation")
    stack = cf.describe_stacks(StackName=STACKS["tls-probe"])["Stacks"][0]
    if stack["StackStatus"] not in ("CREATE_COMPLETE", "UPDATE_COMPLETE"):
        raise ValueError("The owned probe stack must be stable")
    outputs = {item["OutputKey"]: item["OutputValue"] for item in stack["Outputs"]}
    app = stack_outputs(cf, APP)
    if outputs["DistributionId"] == app["DistributionId"]:
        raise ValueError("Never delete the production distribution")
    resources = cf.list_stack_resources(StackName=STACKS["tls-probe"])["StackResourceSummaries"]
    if any(item["ResourceType"] not in ("AWS::CloudFront::Distribution", "AWS::CloudFront::OriginRequestPolicy")
           for item in resources):
        raise ValueError("Unexpected resources in the temporary probe")
    distribution = session.client("cloudfront").get_distribution(Id=outputs["DistributionId"])["Distribution"]
    config = distribution["DistributionConfig"]
    if (distribution["Status"] != "Deployed" or config["Enabled"] or config["Aliases"]["Quantity"]
            or config["Comment"] != "Jeju Atlas temporary canonical-host HTTPS verification"):
        raise ValueError("Disable and verify the owned probe before deleting it")
    cf.delete_stack(StackName=STACKS["tls-probe"])
    emit({"deleting": STACKS["tls-probe"]})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["network", "build-push", "build-data-push", "build-routing-push", "invalidate",
                                          "plan-tls-probe-disable", "delete-tls-probe"] + [
        f"{action}-{kind}" for kind in STACKS for action in ["plan", "apply", "status"]
    ])
    args = parser.parse_args()
    session = connect()
    if args.action == "network":
        assert_network(session)
    elif args.action == "plan-tls-probe-disable":
        plan(session, "tls-probe", overrides={"Enabled": "false"})
    elif args.action == "delete-tls-probe":
        delete_tls_probe(session)
    elif args.action.startswith("plan-"):
        plan(session, args.action.split("-", 1)[1])
    elif args.action.startswith("apply-"):
        apply(session, args.action.split("-", 1)[1])
    elif args.action.startswith("status-"):
        status(session, args.action.split("-", 1)[1])
    elif args.action == "build-push":
        build_push(session)
    elif args.action == "build-data-push":
        build_push(session, data_worker=True)
    elif args.action == "build-routing-push":
        build_push(session, routing_worker=True)
    elif args.action == "invalidate":
        outputs = stack_outputs(session.client("cloudformation"), APP)
        paths = ["/", "/index.html", "/sw.js", "/manifest.webmanifest",
                 "/favicon.svg", "/icons/*", "/workshop*"]
        result = session.client("cloudfront").create_invalidation(
            DistributionId=outputs["DistributionId"],
            InvalidationBatch={
                "Paths": {"Quantity": len(paths), "Items": paths},
                "CallerReference": str(time.time_ns()),
            },
        )
        emit({"invalidation": result["Invalidation"]["Id"], "status": result["Invalidation"]["Status"]})


if __name__ == "__main__":
    main()
