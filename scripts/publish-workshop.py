#!/usr/bin/env python3
"""Publish only workshop static files using an existing App stack and image."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tarfile
import threading
import time

from deploy import ACCOUNT, APP, REGION, connect

ROOT = Path(__file__).resolve().parents[1]
WORKSHOP = "app/dist/workshop"
RUNTIME_FILES = {"etc/hosts", "etc/hostname", "etc/resolv.conf"}
IMAGE_CONFIG_KEYS = (
    "User", "Env", "Cmd", "Entrypoint", "WorkingDir", "Healthcheck", "ExposedPorts",
    "Volumes", "Labels", "StopSignal", "OnBuild", "Shell",
)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def image_uri(value):
    if not re.fullmatch(re.escape(f"{ACCOUNT}.dkr.ecr.{REGION}.amazonaws.com/jeju-3d@sha256:") + r"[a-f0-9]{64}", value):
        raise ValueError("Use an immutable digest from the existing application repository")
    return value


def validate_file_diff(before, after):
    changed = sorted(name for name in set(before) | set(after) if before.get(name) != after.get(name))
    if not changed:
        raise ValueError("The workshop content did not change")
    if any(name != WORKSHOP and not name.startswith(WORKSHOP + "/") for name in changed):
        raise ValueError("The candidate changes files outside /app/dist/workshop")
    return changed


def update_parameters(parameters, image):
    if sum(item["ParameterKey"] == "ImageUri" for item in parameters) != 1:
        raise ValueError("Expected the existing App ImageUri parameter")
    return [{"ParameterKey": item["ParameterKey"], **(
        {"ParameterValue": image} if item["ParameterKey"] == "ImageUri" else {"UsePreviousValue": True}
    )} for item in parameters]


def validate_changes(changes):
    allowed = {"TaskDefinition": "AWS::ECS::TaskDefinition", "Service": "AWS::ECS::Service"}
    if not changes:
        raise ValueError("No workshop image update was planned")
    seen = set()
    for item in changes:
        change = item.get("ResourceChange", {})
        name = change.get("LogicalResourceId")
        if (change.get("Action") != "Modify" or name not in allowed
                or change.get("ResourceType") != allowed[name]):
            raise ValueError("Only the existing web task definition and service may be updated")
        seen.add(name)
    if seen != set(allowed):
        raise ValueError("Expected a task definition revision and its existing service update")


def changed_properties(before, after, path=""):
    if before == after:
        return set()
    if isinstance(before, dict) and isinstance(after, dict):
        return set().union(*(changed_properties(before.get(key), after.get(key), path + "/" + key)
                             for key in before.keys() | after.keys()))
    if isinstance(before, list) and isinstance(after, list) and len(before) == len(after):
        return set().union(*(changed_properties(left, right, path + "/" + str(index))
                             for index, (left, right) in enumerate(zip(before, after))))
    return {path}


def validate_property_changes(changes):
    expected = {"Service": {"/Properties/TaskDefinition"},
                "TaskDefinition": {"/Properties/ContainerDefinitions/0/Image"}}
    for row in changes:
        change = row["ResourceChange"]
        name = change.get("LogicalResourceId")
        if name not in expected or not change.get("BeforeContext") or not change.get("AfterContext"):
            raise ValueError("Require detailed before/after property values for static publication")
        before, after = json.loads(change["BeforeContext"]), json.loads(change["AfterContext"])
        if changed_properties(before, after) != expected[name]:
            raise ValueError("Properties other than the existing web image/service revision would change")
        if name == "TaskDefinition":
            for value in (before, after):
                if value["Properties"]["ContainerDefinitions"][0].get("Name") != "web":
                    raise ValueError("Only the existing web container image may change")


def docker(*args):
    result = subprocess.run(["docker", *args], text=True, capture_output=True, timeout=60)
    if result.returncode:
        raise ValueError("Docker inspection failed; keep the current deployment")
    return result.stdout.strip()


def inspect_image(image):
    return json.loads(docker("image", "inspect", image))[0]


def inventory(image):
    container = docker("create", "--pull=never", "--network", "none", "--read-only", image)
    if not re.fullmatch(r"[a-f0-9]{64}", container):
        raise ValueError("Unexpected temporary container identity")
    process = None
    try:
        process = subprocess.Popen(["docker", "export", container], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        timer = threading.Timer(120, process.kill)
        timer.daemon = True
        timer.start()
        result = {}
        try:
            with tarfile.open(fileobj=process.stdout, mode="r|") as archive:
                for member in archive:
                    name = member.name.removeprefix("./").rstrip("/")
                    if not name or name in RUNTIME_FILES:
                        continue
                    if name.startswith("/") or ".." in Path(name).parts:
                        raise ValueError("Unexpected exported filesystem path")
                    content = None
                    if member.isfile():
                        hasher = hashlib.sha256()
                        with archive.extractfile(member) as stream:
                            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                                hasher.update(chunk)
                        content = hasher.hexdigest()
                    result[name] = [member.type.decode("ascii"), member.mode, member.uid, member.gid,
                                    member.linkname, content]
            if process.wait(timeout=20):
                raise ValueError("Image export did not finish")
        finally:
            timer.cancel()
        return result
    finally:
        if process is not None:
            if process.poll() is None:
                process.kill()
            if process.stdout:
                process.stdout.close()
            process.wait(timeout=10)
        docker("rm", "-v", container)


def fresh_local_path(path):
    path = Path(path)
    if any(item.is_symlink() for item in (path, *path.parents)) or path.exists():
        raise ValueError("Use a fresh local proof/plan filename")
    absolute = path.resolve()
    if absolute.is_relative_to(ROOT) and not (
            absolute.is_relative_to(ROOT / ".local") or absolute.is_relative_to(ROOT / "workshop/.local")):
        raise ValueError("Publication proofs contain private deployment identifiers; keep them in ignored .local storage")
    return path


def write_new(path, value):
    path = fresh_local_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
    path.chmod(0o600)


def verify_images(base, candidate, output):
    image_uri(base)
    fresh_local_path(output)
    original, updated = inspect_image(base), inspect_image(candidate)
    if (updated.get("Architecture") != original.get("Architecture")
            or updated.get("Os") != original.get("Os")
            or updated["RootFS"]["Layers"][:len(original["RootFS"]["Layers"])] != original["RootFS"]["Layers"]):
        raise ValueError("Build the candidate directly from the current immutable image")
    config = {key: original["Config"].get(key) for key in IMAGE_CONFIG_KEYS}
    if config != {key: updated["Config"].get(key) for key in IMAGE_CONFIG_KEYS}:
        raise ValueError("Runtime image configuration changed")
    before, after = inventory(base), inventory(candidate)
    changed = validate_file_diff(before, after)
    proof = {
        "kind": "workshop-static-image-v1", "baseImage": base, "candidateImageId": updated["Id"],
        "outsideWorkshopSha256": digest({key: value for key, value in before.items()
                                         if key != WORKSHOP and not key.startswith(WORKSHOP + "/")}),
        "imageConfigSha256": digest(config), "changedPaths": changed,
        "verifiedAt": datetime.now(timezone.utc).isoformat(), "passed": True,
    }
    write_new(output, proof)
    return {"passed": True, "changedWorkshopPaths": len(changed), "applicationFilesChanged": False}


def outputs(stack):
    return {item["OutputKey"]: item["OutputValue"] for item in stack.get("Outputs", [])}


def live_state(aws):
    stack = aws.client("cloudformation").describe_stacks(StackName=APP)["Stacks"][0]
    if stack["StackStatus"] not in {"CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"}:
        raise ValueError("Wait for the current App stack operation")
    values = outputs(stack)
    ecs = aws.client("ecs")
    service = ecs.describe_services(cluster=values["ClusterName"], services=[values["ServiceName"]])["services"][0]
    if (len(service["deployments"]) != 1 or service["deployments"][0].get("rolloutState") != "COMPLETED"
            or service["pendingCount"] or service["runningCount"] != service["desiredCount"]):
        raise ValueError("Wait for the existing service to be stable")
    parameters = {item["ParameterKey"]: item["ParameterValue"] for item in stack["Parameters"]}
    if int(parameters["DesiredCount"]) != service["desiredCount"]:
        raise ValueError("Service capacity differs from the stack; do not change capacity during static publication")
    tasks = ecs.list_tasks(cluster=values["ClusterName"], serviceName=values["ServiceName"], desiredStatus="RUNNING")["taskArns"]
    running = ecs.describe_tasks(cluster=values["ClusterName"], tasks=tasks)["tasks"]
    web = [item for task in running for item in task["containers"] if item["name"] == "web"]
    digests = {item["imageDigest"] for item in web}
    if not web or len(digests) != 1:
        raise ValueError("Expected one stable current web image")
    repo = web[0]["image"].split("@")[0].split(":")[0]
    return stack, repo + "@" + next(iter(digests))


def changeset(cf, identifier):
    # Property-level evaluation resolves conservative resource-reference
    # estimates; validate the actual before/after values as well as resource IDs.
    value = cf.describe_change_set(StackName=APP, ChangeSetName=identifier, IncludePropertyValues=True)
    if value.get("NextToken"):
        raise ValueError("Unexpectedly large change set")
    return value


def validate_plan_parameters(detail, old_parameters, image):
    old = {row["ParameterKey"]: row["ParameterValue"] for row in old_parameters}
    expected = {**old, "ImageUri": image}
    actual = {
        row["ParameterKey"]: old.get(row["ParameterKey"]) if row.get("UsePreviousValue")
        else row.get("ParameterValue")
        for row in detail.get("Parameters", [])
    }
    if actual != expected:
        raise ValueError("The change set modifies parameters other than the reviewed ImageUri")


def plan(image, proof_file, output):
    fresh_local_path(output)
    image_uri(image)
    proof = json.loads(Path(proof_file).read_text())
    if proof.get("kind") != "workshop-static-image-v1" or proof.get("passed") is not True:
        raise ValueError("Verify the content-only image before planning")
    if inspect_image(image)["Id"] != proof.get("candidateImageId"):
        raise ValueError("The proposed ECR digest differs from the verified local image")
    aws = connect()
    stack, current = live_state(aws)
    if current != proof["baseImage"]:
        raise ValueError("Production image changed after local verification; prepare a new candidate")
    cf = aws.client("cloudformation")
    template = cf.get_template(StackName=APP, TemplateStage="Original")["TemplateBody"]
    created = cf.create_change_set(
        StackName=APP, ChangeSetName="workshop-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S"),
        ChangeSetType="UPDATE", UsePreviousTemplate=True,
        Parameters=update_parameters(stack["Parameters"], image),
        Capabilities=stack.get("Capabilities", []),
        Description="Workshop static content only; existing application, domains and security preserved",
    )
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        detail = changeset(cf, created["Id"])
        if detail["Status"] not in {"CREATE_PENDING", "CREATE_IN_PROGRESS"}:
            break
        time.sleep(3)
    else:
        raise ValueError("The change set is still preparing; inspect it before retrying")
    if detail["Status"] != "CREATE_COMPLETE" or detail.get("ExecutionStatus") != "AVAILABLE":
        raise ValueError("The static-content change set is not available")
    validate_changes(detail.get("Changes", []))
    validate_property_changes(detail.get("Changes", []))
    validate_plan_parameters(detail, stack["Parameters"], image)
    record = {
        "kind": "workshop-static-plan-v1", "stackId": stack["StackId"], "changeSetId": created["Id"],
        "baseImage": current, "imageUri": image, "candidateImageId": proof["candidateImageId"],
        "templateSha256": digest(template), "oldParameters": stack["Parameters"],
        "proofSha256": hashlib.sha256(Path(proof_file).read_bytes()).hexdigest(),
        "status": "REVIEWABLE", "plannedAt": datetime.now(timezone.utc).isoformat(),
    }
    write_new(output, record)
    return {"status": "REVIEWABLE", "changes": [
        {"action": row["ResourceChange"]["Action"], "logicalId": row["ResourceChange"]["LogicalResourceId"]}
        for row in detail["Changes"]], "changedParameters": ["ImageUri"]}


def apply(plan_file):
    record = json.loads(Path(plan_file).read_text())
    if record.get("kind") != "workshop-static-plan-v1" or record.get("status") != "REVIEWABLE":
        raise ValueError("Use a reviewed static-content plan")
    aws = connect()
    stack, current = live_state(aws)
    cf = aws.client("cloudformation")
    if (stack["StackId"] != record["stackId"] or current != record["baseImage"]
            or stack["Parameters"] != record["oldParameters"]
            or digest(cf.get_template(StackName=APP, TemplateStage="Original")["TemplateBody"]) != record["templateSha256"]):
        raise ValueError("The existing deployment changed; do not execute the stale plan")
    detail = changeset(cf, record["changeSetId"])
    validate_changes(detail.get("Changes", []))
    validate_property_changes(detail.get("Changes", []))
    validate_plan_parameters(detail, record["oldParameters"], record["imageUri"])
    if detail.get("ExecutionStatus") != "AVAILABLE":
        raise ValueError("The change set is not available")
    cf.execute_change_set(StackName=APP, ChangeSetName=record["changeSetId"])
    return {"executionStarted": True, "changedParameters": ["ImageUri"],
            "next": "Wait for the existing stack/service, then invalidate only /workshop and /workshop/*"}


def inspect_live(output):
    fresh_local_path(output)
    stack, current = live_state(connect())
    record = {"baseImage": current, "stackId": stack["StackId"],
              "checkedAt": datetime.now(timezone.utc).isoformat()}
    write_new(output, record)
    return {"existingServiceStable": True, "immutableBaseRecorded": True}


def publication_status(plan_file, invalidate=False):
    record = json.loads(Path(plan_file).read_text())
    if record.get("kind") != "workshop-static-plan-v1":
        raise ValueError("Use the recorded workshop plan")
    aws = connect()
    stack, current = live_state(aws)
    expected = {row["ParameterKey"]: row["ParameterValue"] for row in record["oldParameters"]}
    expected["ImageUri"] = record["imageUri"]
    actual = {row["ParameterKey"]: row["ParameterValue"] for row in stack["Parameters"]}
    if (stack["StackId"] != record["stackId"] or current != record["imageUri"] or actual != expected
            or digest(aws.client("cloudformation").get_template(StackName=APP, TemplateStage="Original")["TemplateBody"]) != record["templateSha256"]):
        raise ValueError("The expected content-only image is not the stable deployment")
    result = {"published": True, "stackAndServiceStable": True, "onlyImageParameterChanged": True}
    if invalidate:
        distribution = outputs(stack)["DistributionId"]
        value = aws.client("cloudfront").create_invalidation(
            DistributionId=distribution,
            InvalidationBatch={"CallerReference": "workshop-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f"),
                               "Paths": {"Quantity": 2, "Items": ["/workshop", "/workshop/*"]}},
        )
        result["invalidationId"] = value["Invalidation"]["Id"]
        result["invalidationStatus"] = value["Invalidation"]["Status"]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    inspect = commands.add_parser("inspect-live")
    inspect.add_argument("--output", type=Path, required=True)
    verify = commands.add_parser("verify-images")
    verify.add_argument("--base-image", required=True)
    verify.add_argument("--candidate-image", required=True)
    verify.add_argument("--output", type=Path, required=True)
    prepare = commands.add_parser("plan")
    prepare.add_argument("--image-uri", required=True)
    prepare.add_argument("--proof", type=Path, required=True)
    prepare.add_argument("--output", type=Path, required=True)
    execute = commands.add_parser("apply")
    execute.add_argument("--plan", type=Path, required=True)
    for action in ("status", "invalidate"):
        command = commands.add_parser(action)
        command.add_argument("--plan", type=Path, required=True)
    args = parser.parse_args()
    if args.action == "inspect-live":
        result = inspect_live(args.output)
    elif args.action == "verify-images":
        result = verify_images(args.base_image, args.candidate_image, args.output)
    elif args.action == "plan":
        result = plan(args.image_uri, args.proof, args.output)
    elif args.action == "apply":
        result = apply(args.plan)
    else:
        result = publication_status(args.plan, invalidate=args.action == "invalidate")
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"failed": True, "error": str(error) if isinstance(error, ValueError) else type(error).__name__}))
        raise SystemExit(1)
