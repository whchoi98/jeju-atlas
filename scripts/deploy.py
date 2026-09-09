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
    cf = session.client("cloudformation")
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
            "DesiredCount": "1",
        }
        name, template = APP, ROOT / "infra/application.yaml"
    else:
        name, template, params = BOOTSTRAP, ROOT / "infra/bootstrap.yaml", {}
    subprocess.run(["cfn-lint", str(template)], check=True, cwd=ROOT)
    try:
        existing = cf.describe_stacks(StackName=name)["Stacks"][0]
        if existing["StackStatus"] == "ROLLBACK_COMPLETE":
            raise RuntimeError("Stack rolled back; inspect events before changing it")
        change_type = "CREATE" if existing["StackStatus"] == "REVIEW_IN_PROGRESS" else "UPDATE"
    except ClientError as error:
        if "does not exist" not in str(error):
            raise
        change_type = "CREATE"
    change_name = "jeju-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    created = cf.create_change_set(
        StackName=name,
        ChangeSetName=change_name,
        ChangeSetType=change_type,
        Description="User-requested Jeju 3D deployment; existing VPC and NAT reused",
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
        "stack": name, "changeSetArn": created["Id"], "type": change_type,
        "changes": [
            {key: change[key] for key in ["Action", "LogicalResourceId", "ResourceType", "Replacement"] if key in change}
            for change in changes
        ],
    }
    save(f"{kind}-change-set.json", review)
    emit(review)


def apply(session, kind):
    cf = session.client("cloudformation")
    review = load(f"{kind}-change-set.json")
    if review["stack"] not in [BOOTSTRAP, APP]:
        raise RuntimeError("Unexpected stack")
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
    subprocess.run(["node", "--test", "tests/server.test.mjs"], check=True, cwd=ROOT)
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
    cf = session.client("cloudformation")
    name = APP if kind == "app" else BOOTSTRAP
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
    parser.add_argument("action", choices=["network", "plan-bootstrap", "apply-bootstrap", "status-bootstrap", "build-push", "plan-app", "apply-app", "status-app", "invalidate"])
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
