#!/usr/bin/env python3
"""Plan and explicitly apply an approved image-only rollback using the live template."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import time
from uuid import uuid4

from botocore.config import Config
from deploy import ACCOUNT, APP, LOCAL, REGION, connect, emit, require_asset_manifest

REPOSITORY = f"{ACCOUNT}.dkr.ecr.{REGION}.amazonaws.com/jeju-3d"
APPROVED_RELEASES = {
    "release-20260910T202150Z": "sha256:18fb0b1fa57b1ee5552eec9e9db34717c23319c28fc6e6e78bbfc45a939a54b9",
    "release-20260910T180902Z": "sha256:0ef30ebd2d916a26fcc53eeee47a92c5483c55aef408c836e5a49c25880f671b",
    "release-20260910T173044Z": "sha256:9c3959d38054d2d6c3715439b897ae1204f4059a8f4724409399d32ab46b35b7",
}
PLAN_NAME = "rollback-change-set.json"
MUTABLE = {"ImageUri", "Release", "DesiredCount"}
CONFIG = Config(connect_timeout=3, read_timeout=10, retries={"total_max_attempts": 1, "mode": "standard"})
RESOURCE_TYPES = {
    "TaskDefinition": "AWS::ECS::TaskDefinition", "Service": "AWS::ECS::Service",
    "ScalableTarget": "AWS::ApplicationAutoScaling::ScalableTarget",
    "CpuScalingPolicy": "AWS::ApplicationAutoScaling::ScalingPolicy",
    "MemoryScalingPolicy": "AWS::ApplicationAutoScaling::ScalingPolicy",
}


class RollbackError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise RollbackError(message)


def approved_image(release):
    require(release in APPROVED_RELEASES, "Release is not on the approved rollback allowlist")
    digest = APPROVED_RELEASES[release]
    require(re.fullmatch(r"sha256:[a-f0-9]{64}", digest) is not None, "Approved digest is malformed")
    return {"release": release, "digest": digest, "imageUri": f"{REPOSITORY}@{digest}"}


def fingerprint(value):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return hashlib.sha256(value.encode()).hexdigest()
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def parameter_values(items):
    result = {item["ParameterKey"]: item["ParameterValue"] for item in items}
    require(len(result) == len(items), "Duplicate stack parameters are not supported")
    return result


def stamp(stack):
    return {
        "stackId": stack["StackId"],
        "stackLastUpdatedTime": stack["LastUpdatedTime"].isoformat() if stack.get("LastUpdatedTime") else None,
        "stackCreationTime": stack["CreationTime"].isoformat(),
        "parametersSha256": fingerprint(parameter_values(stack["Parameters"])),
    }


def snapshot(cf, ecs):
    stack = cf.describe_stacks(StackName=APP)["Stacks"][0]
    require(stack["StackName"] == APP and stack["StackId"].startswith(
        f"arn:aws:cloudformation:{REGION}:{ACCOUNT}:stack/{APP}/"), "Unexpected stack identity")
    require(stack["StackStatus"] in ("CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"),
            "The deployed stack must be stable before rollback")
    parameters = parameter_values(stack["Parameters"])
    require(MUTABLE | {"MinTaskCount", "MaxTaskCount"} <= parameters.keys(), "Required deployed parameters are missing")
    outputs = {item["OutputKey"]: item["OutputValue"] for item in stack.get("Outputs", [])}
    require(outputs.get("ClusterName") == outputs.get("ServiceName") == "jeju-3d", "Unexpected ECS ownership")
    services = ecs.describe_services(cluster="jeju-3d", services=["jeju-3d"])["services"]
    require(len(services) == 1 and services[0].get("serviceName") == "jeju-3d", "Expected one owned service")
    service = services[0]
    deployments = service.get("deployments", [])
    require(len(deployments) == 1 and deployments[0].get("rolloutState") == "COMPLETED", "A deployment is active")
    require(service["taskDefinition"] == outputs.get("TaskDefinitionArn"), "ECS and CloudFormation task definitions differ")
    desired = service["desiredCount"]
    minimum, maximum = int(parameters["MinTaskCount"]), int(parameters["MaxTaskCount"])
    require(isinstance(desired, int) and not isinstance(desired, bool) and 1 <= minimum <= desired <= maximum,
            "Actual desired capacity is outside the deployed bounds")
    task = ecs.describe_task_definition(taskDefinition=service["taskDefinition"])["taskDefinition"]
    containers = [item for item in task["containerDefinitions"] if item["name"] == "web"]
    require(len(containers) == 1 and containers[0]["image"] == parameters["ImageUri"], "Live image differs from the stack")
    require(re.fullmatch(re.escape(REPOSITORY) + r"@sha256:[a-f0-9]{64}", parameters["ImageUri"]) is not None,
            "Current image must be an immutable digest in the owned repository")
    environment = {item["name"]: item["value"] for item in containers[0].get("environment", [])}
    require(environment.get("RELEASE") == parameters["Release"], "Live release differs from the stack")
    template = cf.get_template(StackName=APP, TemplateStage="Original")["TemplateBody"]
    base = {
        **stamp(stack), "currentImage": parameters["ImageUri"], "currentRelease": parameters["Release"],
        "taskDefinition": service["taskDefinition"], "deploymentId": deployments[0]["id"],
        "desiredCount": desired, "minCapacity": minimum, "maxCapacity": maximum,
        "templateSha256": fingerprint(template),
    }
    latest = cf.describe_stacks(StackName=APP)["Stacks"][0]
    require(stamp(latest) == stamp(stack) and latest["StackStatus"] == stack["StackStatus"],
            "Stack changed during inspection; create a fresh plan")
    return base, parameters


def verify_ecr(ecr, target):
    images = ecr.describe_images(registryId=ACCOUNT, repositoryName="jeju-3d",
                                 imageIds=[{"imageTag": target["release"]}])["imageDetails"]
    require(len(images) == 1 and images[0]["imageDigest"] == target["digest"]
            and target["release"] in images[0].get("imageTags", []), "ECR tag does not match the approved digest")


def rollback_parameters(parameters, base, target):
    replacements = {"ImageUri": target["imageUri"], "Release": target["release"], "DesiredCount": str(base["desiredCount"])}
    return [
        {"ParameterKey": key, **({"ParameterValue": replacements[key]} if key in MUTABLE else {"UsePreviousValue": True})}
        for key in sorted(parameters)
    ]


def verify_shared_assets(session, parameters, target):
    domain = parameters.get("AssetsBucketDomainName", "")
    if domain:
        expected = f"jeju-3d-assets-{ACCOUNT}-{REGION}"
        require(domain == f"{expected}.s3.{REGION}.amazonaws.com", "Unexpected shared asset origin")
        require_asset_manifest(session, expected, target["imageUri"])


def read_change_set(cf, arn):
    result = cf.describe_change_set(ChangeSetName=arn)
    changes = list(result.get("Changes", []))
    token = result.get("NextToken")
    seen = set()
    while token:
        require(token not in seen and len(seen) < 10, "Change set pagination is not bounded")
        seen.add(token)
        page = cf.describe_change_set(ChangeSetName=arn, NextToken=token)
        require(all(page.get(key) == result.get(key) for key in ("ChangeSetId", "StackId", "Status", "ExecutionStatus")),
                "Change set changed during inspection")
        changes.extend(page.get("Changes", []))
        token = page.get("NextToken")
    return {**result, "Changes": changes}


def validate_changes(changes):
    seen = set()
    for entry in changes:
        require(entry.get("Type") == "Resource", "Unexpected change-set entry")
        change = entry["ResourceChange"]
        name = change.get("LogicalResourceId")
        require(name in RESOURCE_TYPES and name not in seen and change.get("ResourceType") == RESOURCE_TYPES[name],
                "Change set contains an unapproved or duplicate resource")
        seen.add(name)
        require(change.get("Action") == "Modify" and change.get("Scope") == ["Properties"],
                "Add, remove, import and non-property changes are forbidden")
        details = change.get("Details", [])
        require(bool(details), "Change details are required for review")
        if name in ("TaskDefinition", "Service"):
            allowed = {"ContainerDefinitions"} if name == "TaskDefinition" else {"TaskDefinition", "DesiredCount"}
            require(change.get("Replacement") in (("True", "Conditional", "False") if name == "TaskDefinition" else ("False",)),
                    "Only a task-definition revision may be replaced")
            require(all(item.get("Target", {}).get("Attribute") == "Properties"
                        and item["Target"].get("Name") in allowed for item in details),
                    "Task or service changes exceed the image/capacity scope")
        else:
            property_name = "ResourceId" if name == "ScalableTarget" else "ScalingTargetId"
            parents = {"Service", "Cluster"} if name == "ScalableTarget" else {"ScalableTarget"}
            require(change.get("Replacement") in ("False", "Conditional") and all(
                item.get("Evaluation") == "Dynamic"
                and item.get("ChangeSource") in ("ResourceReference", "ResourceAttribute")
                and item.get("CausingEntity", "").split(".", 1)[0] in parents
                and item.get("Target", {}).get("Attribute") == "Properties"
                and item["Target"].get("Name") == property_name for item in details),
                "Only unchanged dynamic autoscaling references are allowed")
    require({"TaskDefinition", "Service"} <= seen, "Both the task revision and service update must be present")


def review(cf, report, parameters):
    detail = read_change_set(cf, report["changeSetArn"])
    require(detail.get("StackId") == report["base"]["stackId"] and detail.get("StackName") == APP
            and detail.get("ChangeSetId") == report["changeSetArn"]
            and detail.get("Description") == report["description"], "Change set identity differs from the reviewed plan")
    require(detail.get("Status") == "CREATE_COMPLETE" and detail.get("ExecutionStatus") == "AVAILABLE"
            and not detail.get("IncludeNestedStacks") and not detail.get("ParentChangeSetId"),
            "Change set is not independently available for execution")
    items = detail.get("Parameters", [])
    actual = {item["ParameterKey"]: item for item in items}
    require(len(actual) == len(items) and actual.keys() == parameters.keys(), "Change set parameter coverage differs")
    desired = {"ImageUri": report["target"]["imageUri"], "Release": report["target"]["release"],
               "DesiredCount": str(report["base"]["desiredCount"])}
    for key, item in actual.items():
        if key in MUTABLE:
            require(not item.get("UsePreviousValue") and item.get("ParameterValue") == desired[key],
                    "Image, release or preserved capacity differs from the plan")
        elif item.get("UsePreviousValue") is True:
            require("ParameterValue" not in item or item["ParameterValue"] == parameters[key],
                    "Previous parameter value differs from the deployed value")
        else:
            # DescribeChangeSet can return resolved values instead of the original request flag.
            require(item.get("ParameterValue") == parameters[key] and parameters[key] != "****",
                    "Protected parameters must retain their deployed values")
    template = cf.get_template(StackName=APP, ChangeSetName=report["changeSetArn"], TemplateStage="Original")["TemplateBody"]
    require(fingerprint(template) == report["base"]["templateSha256"], "Change set does not use the current deployed template")
    validate_changes(detail.get("Changes", []))
    return [{key: item["ResourceChange"].get(key) for key in ("Action", "LogicalResourceId", "ResourceType", "Replacement")}
            for item in detail["Changes"]]


def write_report(path, report):
    require(path.name == PLAN_NAME, "Rollback plans must use their separate rollback-change-set.json file")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{uuid4()}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            temporary.chmod(0o600)
            json.dump(report, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def plan(session, release, *, plan_path=None, sleep=time.sleep, clock=time.monotonic):
    target = approved_image(release)
    path = Path(plan_path) if plan_path is not None else LOCAL / PLAN_NAME
    token = str(uuid4())
    report = {"schema": 1, "kind": "image-only-rollback", "stack": APP, "status": "PLANNING",
              "createdAt": datetime.now(timezone.utc).isoformat(), "target": target, "clientToken": token,
              "description": f"Image-only rollback to {release}; plan {token}"}
    write_report(path, report)
    try:
        cf, ecs, ecr = [session.client(name, region_name=REGION, config=CONFIG) for name in ("cloudformation", "ecs", "ecr")]
        base, parameters = snapshot(cf, ecs)
        report["base"] = base
        report["preservedParameters"] = sorted(parameters.keys() - MUTABLE)
        require((target["imageUri"], release) != (base["currentImage"], base["currentRelease"]), "Target image is already deployed")
        verify_ecr(ecr, target)
        verify_shared_assets(session, parameters, target)
        created = cf.create_change_set(
            StackName=APP, ChangeSetName=f"jeju-3d-rollback-{token}", ChangeSetType="UPDATE",
            UsePreviousTemplate=True, Parameters=rollback_parameters(parameters, base, target),
            Capabilities=["CAPABILITY_IAM"], IncludeNestedStacks=False, ClientToken=token,
            Description=report["description"],
        )
        require(created.get("StackId") == base["stackId"], "Stack changed while creating the plan")
        report["changeSetArn"] = created["Id"]
        write_report(path, report)
        deadline = clock() + 120
        while True:
            detail = cf.describe_change_set(ChangeSetName=report["changeSetArn"])
            if detail["Status"] == "CREATE_COMPLETE":
                break
            require(detail["Status"] in ("CREATE_PENDING", "CREATE_IN_PROGRESS") and clock() < deadline,
                    "Change set did not complete within the planning deadline")
            sleep(2)
        report["changes"] = review(cf, report, parameters)
        current, _ = snapshot(cf, ecs)
        require(current == base, "Live state changed during planning; create a fresh plan")
        report["status"] = "REVIEWABLE"
        write_report(path, report)
        return report
    except Exception as error:
        report.update(status="REJECTED", error=type(error).__name__)
        write_report(path, report)
        raise


def apply(session, release, *, plan_path=None, execute=False):
    require(execute, "Apply requires explicit --execute after reviewing the rollback plan")
    target = approved_image(release)
    path = Path(plan_path) if plan_path is not None else LOCAL / PLAN_NAME
    require(path.name == PLAN_NAME, "Use the separate rollback plan")
    report = json.loads(path.read_text())
    require(report.get("schema") == 1 and report.get("kind") == "image-only-rollback"
            and report.get("stack") == APP and report.get("status") == "REVIEWABLE"
            and report.get("target") == target, "A matching reviewed rollback plan is required")
    cf, ecs, ecr = [session.client(name, region_name=REGION, config=CONFIG) for name in ("cloudformation", "ecs", "ecr")]
    current, parameters = snapshot(cf, ecs)
    require(current == report["base"], "Rollback plan is stale; create a fresh plan")
    verify_ecr(ecr, target)
    verify_shared_assets(session, parameters, target)
    review(cf, report, parameters)
    latest, _ = snapshot(cf, ecs)
    require(latest == report["base"], "Live state changed before execution; create a fresh plan")
    report.update(status="EXECUTION_REQUESTED", executionRequestedAt=datetime.now(timezone.utc).isoformat())
    write_report(path, report)
    try:
        cf.execute_change_set(ChangeSetName=report["changeSetArn"], StackName=APP,
                              ClientRequestToken=report["clientToken"])
    except Exception as error:
        report.update(status="EXECUTION_UNKNOWN", error=type(error).__name__)
        write_report(path, report)
        raise RollbackError("Execution response is uncertain; inspect AWS status instead of retrying apply") from None
    report["status"] = "EXECUTING"
    write_report(path, report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    subcommands.add_parser("approved", help="List the two reviewed release/digest pairs without AWS access")
    for command in ("plan", "apply"):
        subparser = subcommands.add_parser(command)
        subparser.add_argument("--release", required=True)
        if command == "apply":
            subparser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    if args.command == "approved":
        emit([approved_image(release) for release in APPROVED_RELEASES])
        return
    approved_image(args.release)
    if args.command == "apply":
        require(args.execute, "Apply requires explicit --execute")
    session = connect()
    result = plan(session, args.release) if args.command == "plan" else apply(session, args.release, execute=args.execute)
    emit({"status": result["status"], "target": result["target"], "report": str(LOCAL / PLAN_NAME)})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"error": str(error) if isinstance(error, RollbackError) else type(error).__name__})
        raise SystemExit(1)
