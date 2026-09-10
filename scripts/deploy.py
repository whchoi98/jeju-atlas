#!/usr/bin/env python3
"""Deploy the explicitly scoped Jeju stacks without changing shared networking.

Use plan-bootstrap/plan-app, inspect the change-set JSON, then apply.
ECR credentials are piped to an isolated temporary Docker config and removed.
Origin verification secrets are never read or printed by this script.
"""
from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
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
    "edge": "Jeju3dEdge", "operations": "Jeju3dOperations",
}


def validate_settings(values):
    """Validate non-secret production settings before creating an AWS change set."""
    integer_bounds = {
        "DesiredCount": (1, 4), "MinTaskCount": (2, 4), "MaxTaskCount": (2, 4),
        "GuideDailyLimit": (1, 30), "GuideHourlyLimit": (1, 5), "GuideGlobalConcurrency": (1, 2),
    }
    allowed = {
        "ViewerDomainName", "ViewerCertificateArn", "OriginDomainName",
        "OriginTlsEnabled", "TargetHealthPath",
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
    for key, bounds in integer_bounds.items():
        raw = values.get(key, {
            "DesiredCount": 2, "MinTaskCount": 2, "MaxTaskCount": 4,
            "GuideDailyLimit": 30, "GuideHourlyLimit": 5, "GuideGlobalConcurrency": 2,
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
    if not isinstance(origin_domain, str) or origin_domain and not re.fullmatch(r"[a-z0-9-]+\.whchoi\.net", origin_domain):
        raise ValueError("OriginDomainName must be a public hostname under whchoi.net")
    if tls not in ("true", "false"):
        raise ValueError("OriginTlsEnabled must be the string true or false")
    if tls == "true" and (not origin_domain or origin_domain == domain):
        raise ValueError("TLS requires a separate public origin hostname pointing directly to the ALB")
    result.update(OriginDomainName=origin_domain, OriginTlsEnabled=tls)
    health_path = values.get("TargetHealthPath", "/readyz")
    if health_path not in ("/readyz", "/healthz"):
        raise ValueError("TargetHealthPath must be /readyz or /healthz")
    result["TargetHealthPath"] = health_path
    return result


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
    return session.client("cloudformation", region_name="us-east-1") if kind == "edge" else session.client("cloudformation")


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
        if not certificate_arn or not any(
            domain_matches(name, params["OriginDomainName"])
            for name in certificate.get("SubjectAlternativeNames", [])
        ):
            raise ValueError("The regional certificate must cover the configured origin domain")
        canonical, aliases, _ = socket.gethostbyname_ex(params["OriginDomainName"])
        expected = outputs.get("LoadBalancerDnsName", "").lower()
        if not expected or canonical.rstrip(".").lower() != expected.rstrip("."):
            raise ValueError("Public origin DNS must resolve directly to this ALB before enabling HTTPS")


def infrastructure_parameters(session, kind):
    if kind in ("bootstrap", "origin"):
        return {}
    outputs = stack_outputs(session.client("cloudformation"), APP)
    if kind == "edge":
        return {"DistributionArn": f"arn:aws:cloudfront::{ACCOUNT}:distribution/{outputs['DistributionId']}"}
    if kind == "operations":
        return {
            "ClusterName": outputs["ClusterName"], "ServiceName": outputs["ServiceName"],
            "AlbFullName": outputs["LoadBalancerArn"].split(":loadbalancer/", 1)[1],
            "TargetGroupFullName": outputs["TargetGroupArn"].split(":", 5)[5],
            "LogGroupName": outputs["LogGroupName"],
            "GuideQuotaTableName": outputs["GuideQuotaTableName"],
        }
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


def plan(session, kind):
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
        params.update(settings)
        edge = optional_stack_outputs(session, "edge")
        origin = optional_stack_outputs(session, "origin")
        if edge:
            params["WebAclArn"] = edge["WebAclArn"]
        if origin:
            params["OriginCertificateArn"] = origin["OriginCertificateArn"]
        name, template = APP, ROOT / "infra/application.yaml"
    else:
        name, template, params = STACKS[kind], ROOT / f"infra/{kind}.yaml", infrastructure_parameters(session, kind)
    subprocess.run(["cfn-lint", str(template)], check=True, cwd=ROOT)
    try:
        existing = cf.describe_stacks(StackName=name)["Stacks"][0]
        if existing["StackStatus"] == "ROLLBACK_COMPLETE":
            raise RuntimeError("Stack rolled back; inspect events before changing it")
        change_type = "CREATE" if existing["StackStatus"] == "REVIEW_IN_PROGRESS" else "UPDATE"
        if kind == "app" and change_type == "UPDATE":
            outputs = {item["OutputKey"]: item["OutputValue"] for item in existing.get("Outputs", [])}
            # Preserve existing non-secret parameters not overridden by the
            # checked-in settings (for example a previously deployed WebACL).
            for item in existing.get("Parameters", []):
                if item.get("ParameterValue") and item["ParameterValue"] != "****":
                    params.setdefault(item["ParameterKey"], item["ParameterValue"])
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
        assert_domain(session, settings, {})
        assert_origin_tls(session, params, {})
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


def apply(session, kind):
    cf = stack_client(session, kind)
    review = load(f"{kind}-change-set.json")
    if review["stack"] != STACKS[kind] or review.get("status") != "REVIEWABLE":
        raise RuntimeError("Run and review a successful plan for this stack before applying")
    arn = review["changeSetArn"]
    detail = cf.describe_change_set(ChangeSetName=arn)
    if detail["ExecutionStatus"] != "AVAILABLE":
        raise RuntimeError(f"Change set is not available: {detail['ExecutionStatus']}")
    cf.execute_change_set(ChangeSetName=arn)
    emit({"started": review["stack"], "changeSet": arn})


def build_push(session):
    cf = session.client("cloudformation")
    ecr = session.client("ecr")
    registry = stack_outputs(cf, BOOTSTRAP)
    uri = registry["RepositoryUri"]
    release = "release-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    tag = f"{uri}:{release}"
    subprocess.run(["node", "scripts/check.mjs"], check=True, cwd=ROOT)
    subprocess.run(["docker", "build", "--platform", "linux/arm64", "--tag", tag, "."], check=True, cwd=ROOT)
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
    save("image.json", image)
    emit(image)


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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["network", "build-push", "invalidate"] + [
        f"{action}-{kind}" for kind in STACKS for action in ["plan", "apply", "status"]
    ])
    args = parser.parse_args()
    session = connect()
    if args.action == "network":
        assert_network(session)
    elif args.action.startswith("plan-"):
        plan(session, args.action.split("-")[1])
    elif args.action.startswith("apply-"):
        apply(session, args.action.split("-")[1])
    elif args.action.startswith("status-"):
        status(session, args.action.split("-")[1])
    elif args.action == "build-push":
        build_push(session)
    elif args.action == "invalidate":
        outputs = stack_outputs(session.client("cloudformation"), APP)
        result = session.client("cloudfront").create_invalidation(
            DistributionId=outputs["DistributionId"],
            InvalidationBatch={
                "Paths": {"Quantity": 2, "Items": ["/", "/index.html"]},
                "CallerReference": str(time.time_ns()),
            },
        )
        emit({"invalidation": result["Invalidation"]["Id"], "status": result["Invalidation"]["Status"]})


if __name__ == "__main__":
    main()
