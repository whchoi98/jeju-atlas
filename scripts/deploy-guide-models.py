#!/usr/bin/env python3
"""Deploy reviewed guide models, provenance rules and official place details.

Keeps live dependency bundles, Gateway and Memory intact. Optional official
details add only a read grant for the owned snapshot to the Tools role.
The canonical source changes live in the supplied agentcore-cli worktree.
"""
from __future__ import annotations

import argparse
from collections import Counter
import copy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import time
import zipfile

from deploy import connect, LOCAL, load, save, stack_outputs

STACK = "AgentCore-Ohmyjeju-default"
NAME = "Ohmyjeju_OhmyjejuAgent"
FILES = ("model/load.py", "ohmyjeju_agent/routing.py", "ohmyjeju_agent/prompts/system.md")
TOOLS_NAME = "Ohmyjeju_OhmyjejuTools"
TOOLS_FILES = ("ohmyjeju_tools/places.py", "ohmyjeju_tools/official_details.py")
NEW_FILES = {"ohmyjeju_tools/official_details.py"}
MODELS = {
    "OHMYJEJU_MODEL_ROUTING": "auto",
    "OHMYJEJU_MODEL_FAST": "global.openai.gpt-5.6-sol",
    "OHMYJEJU_MODEL_DEEP": "global.openai.gpt-6-astra",
    "OHMYJEJU_THINKING": "disabled",
    "OHMYJEJU_THINKING_DEEP": "adaptive:medium",
}


def digest(file):
    result = hashlib.sha256()
    with Path(file).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def unchanged_lint_findings(before, after, old_issues, new_issues):
    """Accept only existing findings at unchanged values in the live template."""
    missing = object()

    def value_at(document, path):
        try:
            for key in path:
                document = document[key]
            return document
        except (KeyError, IndexError, TypeError):
            return missing

    def signature(issue):
        return (issue["Rule"]["Id"], tuple(issue["Location"]["Path"]), issue["Message"])

    counts = Counter(signature(issue) for issue in old_issues)
    for issue in new_issues:
        key = signature(issue)
        path = issue["Location"]["Path"]
        if counts[key] < 1 or value_at(before, path) != value_at(after, path):
            return False
        counts[key] -= 1
    return True


def lint_template_change(before_path, after_path, before, after):
    # AgentCore's live schema can be newer than cfn-lint's bundled registry.
    # No rule is disabled globally: a finding is accepted only when it was
    # already present in the deployed template and its exact value is unchanged.
    results = []
    for path in (before_path, after_path):
        completed = subprocess.run(["cfn-lint", "--format", "json", str(path)], capture_output=True, text=True)
        if completed.returncode not in (0, 2, 4, 6):
            raise RuntimeError("cfn-lint did not complete its template validation")
        results.append(json.loads(completed.stdout or "[]"))
    if not unchanged_lint_findings(before, after, results[0], results[1]):
        raise RuntimeError("The proposed template introduces new lint findings or changes a value with an existing finding")
    report = {"existingFindings": len(results[0]), "remainingFindings": len(results[1]), "newFindings": 0,
              "unchangedFindingValues": True, "scope": "Existing AgentCore template only"}
    save("guide-model-template-validation.json", report)
    print(json.dumps(report))


def patch_archive(original, target, source, files=FILES):
    """Preserve every deployed member except the explicitly reviewed files."""
    patches = {name: (source / name).read_bytes() for name in files}
    compiled = tuple(str(Path(name).parent / "__pycache__" / Path(name).stem) + "."
                     for name in files if name.endswith(".py"))
    with zipfile.ZipFile(original) as before:
        names = before.namelist()
        if any(names.count(name) != 1 and not (name in NEW_FILES and names.count(name) == 0) for name in files):
            raise RuntimeError("Expected exactly one copy of each reviewed model module")
        if any(Path(name).name.startswith(".env") or name in (".aws/credentials", "credentials") for name in names):
            raise RuntimeError("The bundle contains a credential/config file; do not process it with this script")
        with zipfile.ZipFile(target, "w") as after:
            for info in before.infolist():
                # Changed source must not reuse a compiled module from the old version.
                if compiled and info.filename.startswith(compiled):
                    continue
                data = patches.get(info.filename)
                after.writestr(info, before.read(info.filename) if data is None else data)
            for name in files:
                if name not in names:
                    info = zipfile.ZipInfo(name, date_time=(2026, 9, 10, 0, 0, 0))
                    info.external_attr = 0o100644 << 16
                    info.compress_type = zipfile.ZIP_DEFLATED
                    after.writestr(info, patches[name])
    Path(target).chmod(0o600)


def allowed_changes(changes, runtime_ids, detail_policies=()):
    """Only runtime edits and unchanged references to their stable ARNs."""
    dependency_properties = {
        "AWS::BedrockAgentCore::GatewayTarget": "TargetConfiguration",
        "AWS::IAM::Policy": "PolicyDocument",
    }
    for item in changes:
        if item["Action"] != "Modify" or item.get("Replacement") == "True":
            return False
        if item["LogicalResourceId"] in runtime_ids:
            if item["ResourceType"] != "AWS::BedrockAgentCore::Runtime" or item.get("Replacement") != "False":
                return False
        elif item["LogicalResourceId"] in detail_policies:
            if item["ResourceType"] != "AWS::IAM::Policy" or item.get("Replacement") != "False":
                return False
            if any(detail.get("Target", {}).get("Name") != "PolicyDocument" for detail in item.get("Details", [])):
                return False
        else:
            property_name = dependency_properties.get(item["ResourceType"])
            if not property_name or not item.get("Details") or any(
                detail.get("Evaluation") != "Dynamic"
                or detail.get("ChangeSource") != "ResourceAttribute"
                or detail.get("CausingEntity") not in {f"{logical}.AgentRuntimeArn" for logical in runtime_ids}
                or detail.get("Target", {}).get("Name") != property_name
                for detail in item["Details"]
            ):
                return False
    return bool(changes)


def review_runtimes(review):
    return review.get("runtimes") or [{
        "name": NAME, "logicalId": review["logicalId"], "runtimeId": review["runtimeId"],
        "expectedRuntimeVersion": review.get("expectedRuntimeVersion"),
    }]


def detail_statement(bucket):
    if bucket != "jeju-3d-data-061525506239-ap-northeast-2":
        raise RuntimeError("Official detail access is restricted to the owned Atlas bucket")
    return {
        "Sid": "AtlasOfficialDetailsRead", "Effect": "Allow", "Action": "s3:GetObject",
        "Resource": f"arn:aws:s3:::{bucket}/place-details/latest.json",
    }


def detail_policy_only(before, after, bucket):
    expected = copy.deepcopy(before)
    statements = expected["Properties"]["PolicyDocument"]["Statement"]
    statements[:] = [item for item in statements if item.get("Sid") != "AtlasOfficialDetailsRead"]
    statements.append(detail_statement(bucket))
    return expected == after


def plan(session, source, include_tools=False, details_bucket=None):
    save("guide-model-change-set.json", {"stack": STACK, "status": "PLANNING"})
    cf = session.client("cloudformation")
    control = session.client("bedrock-agentcore-control")
    s3 = session.client("s3")
    stack = cf.describe_stacks(StackName=STACK)["Stacks"][0]
    if stack["StackStatus"] not in ("CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"):
        raise RuntimeError("Agent stack must be stable")
    template = cf.get_template(StackName=STACK, TemplateStage="Original")["TemplateBody"]
    if isinstance(template, str):
        template = json.loads(template)
    updated = copy.deepcopy(template)
    if details_bucket:
        if not include_tools or stack_outputs(cf, "Jeju3dData").get("DetailsBucketName") != details_bucket:
            raise RuntimeError("The owned data stack and the Tools runtime must both be selected")
        detail_statement(details_bucket)
    specs = [(NAME, source, FILES)]
    if include_tools:
        specs.append((TOOLS_NAME, source.parent / "OhmyjejuTools", TOOLS_FILES))
    runtimes = []
    uploads = []
    detail_policies = []
    for name, directory, files in specs:
        logical = next(key for key, item in template["Resources"].items()
                       if item["Type"] == "AWS::BedrockAgentCore::Runtime"
                       and item["Properties"].get("AgentRuntimeName") == name)
        physical = cf.describe_stack_resource(StackName=STACK, LogicalResourceId=logical)["StackResourceDetail"]["PhysicalResourceId"]
        runtime_id = physical.rsplit("/", 1)[-1]
        current = control.get_agent_runtime(agentRuntimeId=runtime_id)
        if current["status"] != "READY":
            raise RuntimeError("Guide runtimes must be ready")
        old = current["agentRuntimeArtifact"]["codeConfiguration"]["code"]["s3"]
        declared = template["Resources"][logical]["Properties"]["AgentRuntimeArtifact"]["CodeConfiguration"]["Code"]["S3"]
        if declared["Bucket"] != old["bucket"] or declared["Prefix"] != old["prefix"]:
            raise RuntimeError("Runtime artifact differs from CloudFormation; reconcile it before deployment")
        if s3.head_object(Bucket=old["bucket"], Key=old["prefix"])["ContentLength"] > 200 * 1024 * 1024:
            raise RuntimeError("Unexpected bundle size")
        original = LOCAL / f"{name}-original.zip"
        candidate = LOCAL / f"{name}-candidate.zip"
        s3.download_file(old["bucket"], old["prefix"], str(original))
        original.chmod(0o600)
        patch_archive(original, candidate, directory, files)
        sha = digest(candidate)
        key = f"{sha}.zip"
        properties = updated["Resources"][logical]["Properties"]
        properties["AgentRuntimeArtifact"]["CodeConfiguration"]["Code"]["S3"]["Prefix"] = key
        if name == NAME:
            properties["EnvironmentVariables"].update(MODELS)
        elif details_bucket:
            properties["EnvironmentVariables"]["OHMYJEJU_DETAILS_BUCKET"] = details_bucket
            role_ref = properties["RoleArn"]["Fn::GetAtt"]
            role_id = role_ref[0] if isinstance(role_ref, list) else role_ref.split(".", 1)[0]
            policy_id = next(key for key, item in updated["Resources"].items()
                             if item["Type"] == "AWS::IAM::Policy"
                             and {"Ref": role_id} in item["Properties"].get("Roles", []))
            statements = updated["Resources"][policy_id]["Properties"]["PolicyDocument"]["Statement"]
            statements[:] = [item for item in statements if item.get("Sid") != "AtlasOfficialDetailsRead"]
            statements.append(detail_statement(details_bucket))
            detail_policies.append(policy_id)
        runtimes.append({
            "name": name, "logicalId": logical, "runtimeId": runtime_id,
            "expectedRuntimeVersion": current["agentRuntimeVersion"],
            "artifact": {"bucket": old["bucket"], "key": key, "sha256": sha},
            "source": str(directory.resolve()), "changedFiles": list(files),
        })
        uploads.append((candidate, old["bucket"], key, sha))
    runtime_ids = {item["logicalId"] for item in runtimes}
    for resource in template["Resources"]:
        if resource in detail_policies:
            if not detail_policy_only(template["Resources"][resource], updated["Resources"][resource], details_bucket):
                raise RuntimeError("Unexpected detail access policy change")
        elif resource not in runtime_ids and template["Resources"][resource] != updated["Resources"][resource]:
            raise RuntimeError("Unexpected non-runtime change")
    before_path = LOCAL / "guide-model-before-template.json"
    after_path = LOCAL / "guide-model-template.json"
    before_path.write_text(json.dumps(template, indent=2) + "\n")
    history = LOCAL / "guide-model-history"
    history.mkdir(exist_ok=True)
    baseline_name = f"guide-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}.json"
    baseline_path = history / baseline_name
    baseline_path.write_text(json.dumps(template, indent=2) + "\n")
    after_path.write_text(json.dumps(updated, indent=2) + "\n")
    lint_template_change(before_path, after_path, template, updated)
    body = json.dumps(updated, separators=(",", ":"))
    if len(body.encode()) > 51200:
        raise RuntimeError("Template exceeds inline size; use an explicitly reviewed S3 template")
    for candidate, bucket, key, sha in uploads:
        s3.upload_file(str(candidate), bucket, key, ExtraArgs={
            "ContentType": "application/zip", "ServerSideEncryption": "AES256",
            "Metadata": {"project": "jeju-atlas", "sha256": sha},
        })
    change = cf.create_change_set(
        StackName=STACK,
        ChangeSetName="jeju-models-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S"),
        ChangeSetType="UPDATE",
        TemplateBody=body,
        Parameters=[{"ParameterKey": item["ParameterKey"], "UsePreviousValue": True} for item in stack.get("Parameters", [])],
        Capabilities=["CAPABILITY_IAM"],
        Description="Jeju guide: Seoul Global CRIS models, exact anchors and official place details",
    )
    while True:
        detail = cf.describe_change_set(ChangeSetName=change["Id"])
        if detail["Status"] in ("CREATE_COMPLETE", "FAILED"):
            break
        time.sleep(2)
    if detail["Status"] != "CREATE_COMPLETE":
        raise RuntimeError(detail.get("StatusReason", "Change set failed"))
    changes = [item["ResourceChange"] for item in detail["Changes"]]
    if not allowed_changes(changes, runtime_ids, detail_policies):
        raise RuntimeError("Expected in-place guide runtime changes only")
    review = {
        "stack": STACK, "runtimes": runtimes,
        "changeSetArn": change["Id"], "status": "REVIEWABLE",
        "models": MODELS,
        "detailsBucket": details_bucket, "detailPolicies": detail_policies,
        "source": str(source.resolve()),
        "rollbackTemplate": str(baseline_path),
        "changes": [{k: item[k] for k in ("LogicalResourceId", "Action", "ResourceType", "Replacement")} for item in changes],
    }
    save("guide-model-change-set.json", review)
    print(json.dumps(review, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["plan", "apply", "status"])
    parser.add_argument("--source", type=Path)
    parser.add_argument("--include-tools", action="store_true", help="Include reviewed place lookup and official-detail modules in the existing Tools runtime.")
    parser.add_argument("--details-bucket", help="Allow Tools to read the owned official-detail snapshot only.")
    args = parser.parse_args()
    session = connect()
    cf = session.client("cloudformation")
    if args.action == "plan":
        if not args.source:
            parser.error("--source must point to the reviewed OhmyjejuAgent source directory")
        plan(session, args.source, args.include_tools, args.details_bucket)
    elif args.action == "apply":
        review = load("guide-model-change-set.json")
        if review["stack"] != STACK or review.get("status") != "REVIEWABLE":
            raise RuntimeError("No reviewed model change set")
        runtimes = review_runtimes(review)
        for item in runtimes:
            current = session.client("bedrock-agentcore-control").get_agent_runtime(agentRuntimeId=item["runtimeId"])
            if current.get("agentRuntimeName") not in (NAME, TOOLS_NAME) or current["agentRuntimeVersion"] != item["expectedRuntimeVersion"]:
                raise RuntimeError("Guide runtime changed after planning")
        detail = cf.describe_change_set(ChangeSetName=review["changeSetArn"])
        if detail["ExecutionStatus"] != "AVAILABLE":
            raise RuntimeError("Change set is not available")
        if detail.get("StackName") != STACK or not allowed_changes(
            [item["ResourceChange"] for item in detail.get("Changes", [])],
            {item["logicalId"] for item in runtimes},
            review.get("detailPolicies", []),
        ):
            raise RuntimeError("Unexpected runtime change set")
        if review.get("detailPolicies"):
            before = cf.get_template(StackName=STACK, TemplateStage="Original")["TemplateBody"]
            after = cf.get_template(ChangeSetName=review["changeSetArn"], TemplateStage="Original")["TemplateBody"]
            before = json.loads(before) if isinstance(before, str) else before
            after = json.loads(after) if isinstance(after, str) else after
            for policy_id in review["detailPolicies"]:
                if not detail_policy_only(before["Resources"][policy_id], after["Resources"][policy_id], review["detailsBucket"]):
                    raise RuntimeError("Detail policy changed outside its single read-only object")
        cf.execute_change_set(ChangeSetName=review["changeSetArn"])
        print(json.dumps({"started": STACK, "runtimeIds": [item["runtimeId"] for item in runtimes]}))
    else:
        stack = cf.describe_stacks(StackName=STACK)["Stacks"][0]
        report = {"stackStatus": stack["StackStatus"], "runtimes": []}
        for page in cf.get_paginator("list_stack_resources").paginate(StackName=STACK):
            for item in page["StackResourceSummaries"]:
                if item["ResourceType"] != "AWS::BedrockAgentCore::Runtime" or not item.get("PhysicalResourceId"):
                    continue
                runtime_id = item["PhysicalResourceId"].rsplit("/", 1)[-1]
                runtime = session.client("bedrock-agentcore-control").get_agent_runtime(agentRuntimeId=runtime_id)
                if runtime["agentRuntimeName"] not in (NAME, TOOLS_NAME):
                    continue
                report["runtimes"].append({
                    "name": runtime["agentRuntimeName"], "runtimeStatus": runtime["status"],
                    "runtimeVersion": runtime["agentRuntimeVersion"],
                    "models": {name: runtime.get("environmentVariables", {}).get(name) for name in MODELS}
                    if runtime["agentRuntimeName"] == NAME else {},
                })
        save("guide-model-status.json", report)
        print(json.dumps(report))


if __name__ == "__main__":
    main()
