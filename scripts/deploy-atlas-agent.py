#!/usr/bin/env python3
"""Package and deploy only the independent Jeju Atlas AgentCore stack."""

import argparse
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import tempfile
import time
import zipfile

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / ".local"
ACCOUNT = "061525506239"
REGION = "ap-northeast-2"
STACK = "Jeju3dAgentCore"
BUCKET = f"jeju-3d-data-{ACCOUNT}-{REGION}"
MANIFEST = ROOT / "agent/dependency-artifacts.json"
TEMPLATE = ROOT / "infra/agentcore.yaml"
MAX_ZIP_BYTES = 100 * 1024 * 1024
MAX_EXPANDED_BYTES = 512 * 1024 * 1024
MAX_FILES = 30_000
ROLE_ROOTS = {
    "guide": {"main.py", "mcp_client", "memory", "model", "skills", "ohmyjeju_agent", "atlas_agent", "ohmyjeju_contracts", "atlas_contracts"},
    "tools": {"main.py", "catalog.py", "place_extra.py", "data", "ohmyjeju_tools", "atlas_tools"},
}
ALLOWED_RESOURCES = {
    "MemoryRole": "AWS::IAM::Role", "Memory": "AWS::BedrockAgentCore::Memory",
    "ToolsRole": "AWS::IAM::Role", "ToolsRuntime": "AWS::BedrockAgentCore::Runtime",
    "GatewayRole": "AWS::IAM::Role", "Gateway": "AWS::BedrockAgentCore::Gateway",
    "ToolsTarget": "AWS::BedrockAgentCore::GatewayTarget",
    "GuideRole": "AWS::IAM::Role", "GuideRuntime": "AWS::BedrockAgentCore::Runtime",
}


def digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        temp.write_text(json.dumps(value, indent=2, ensure_ascii=False, default=str) + "\n")
        temp.chmod(0o600)
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


def safe_member(name):
    path = PurePosixPath(name)
    if not name or path.is_absolute() or ".." in path.parts or "\\" in name or "\x00" in name:
        raise ValueError("Unsafe archive path")
    if any(part.startswith(".env") or part in {".aws", ".git", "id_rsa", "id_ed25519"} for part in path.parts):
        raise ValueError("Archive contains a protected file")
    return path


def source_files(source):
    source = Path(source).resolve()
    files = []
    for path in sorted(source.rglob("*")):
        relative = path.relative_to(source).as_posix()
        safe_member(relative)
        if path.is_symlink():
            raise ValueError("Source symlinks are not packaged")
        if "__pycache__" in path.parts or path.suffix == ".pyc" or ".venv" in path.parts:
            continue
        if path.is_file():
            if path.stat().st_size > 5 * 1024 * 1024:
                raise ValueError("Unexpected application source size")
            files.append((relative, path))
    if not any(name == "main.py" for name, _ in files):
        raise ValueError("Application entry point main.py is missing")
    return files


def source_digest(source):
    result = hashlib.sha256()
    for relative, path in source_files(source):
        result.update(relative.encode())
        result.update(b"\0")
        result.update(path.read_bytes())
        result.update(b"\0")
    return result.hexdigest()


def artifact_key(role, sha256):
    if role not in ROLE_ROOTS or not isinstance(sha256, str) or not re.fullmatch(r"[a-f0-9]{64}", sha256):
        raise ValueError("Invalid role or artifact digest")
    return f"agent/releases/{sha256}/{role}.zip"


def build_bundle(base_zip, source, role, target):
    if role not in ROLE_ROOTS:
        raise ValueError("Unknown agent role")
    files = source_files(source)
    base_zip, target = Path(base_zip), Path(target)
    if base_zip.stat().st_size > MAX_ZIP_BYTES:
        raise ValueError("Dependency archive exceeds size limit")
    replaced = ROLE_ROOTS[role] | {"README.md", "pyproject.toml", "uv.lock", ".gitignore", "__pycache__"}
    members, total = {}, 0
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with zipfile.ZipFile(base_zip) as original:
            entries = original.infolist()
            if len(entries) > MAX_FILES:
                raise ValueError("Too many dependency entries")
            for info in entries:
                path = safe_member(info.filename)
                if stat.S_ISLNK(info.external_attr >> 16):
                    raise ValueError("Dependency symlinks are not packaged")
                total += info.file_size
                if total > MAX_EXPANDED_BYTES or info.file_size > 64 * 1024 * 1024:
                    raise ValueError("Dependency archive exceeds expanded size limit")
                if info.is_dir():
                    continue
                top = path.parts[0]
                project_metadata = top.endswith((".dist-info", ".pth", ".egg-info")) and any(
                    name in top.lower() for name in ["ohmyjeju", "jejuatlasguide", "jejuatlastools"]
                )
                if top in replaced or project_metadata:
                    continue
                if info.filename in members:
                    raise ValueError("Duplicate dependency archive path")
                members[info.filename] = info
            descriptor, name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
            os.close(descriptor)
            temporary = Path(name)
            with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as output:
                for name in sorted(members):
                    info = members[name]
                    entry = zipfile.ZipInfo(name, (2020, 1, 1, 0, 0, 0))
                    entry.compress_type = zipfile.ZIP_DEFLATED
                    entry.create_system = 3
                    entry.external_attr = info.external_attr
                    output.writestr(entry, original.read(info))
                for name, path in files:
                    entry = zipfile.ZipInfo(name, (2020, 1, 1, 0, 0, 0))
                    entry.compress_type = zipfile.ZIP_DEFLATED
                    entry.create_system = 3
                    entry.external_attr = (stat.S_IFREG | 0o644) << 16
                    output.writestr(entry, path.read_bytes())
        if temporary.stat().st_size > MAX_ZIP_BYTES:
            raise ValueError("Packaged agent exceeds size limit")
        result = {"sha256": digest(temporary), "bytes": temporary.stat().st_size, "sourceDigest": source_digest(source)}
        temporary.replace(target)
        temporary = None
        return result
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def validate_changeset(response):
    if response.get("StackName") != STACK:
        raise ValueError("Only Jeju3dAgentCore may be changed")
    changed = []
    for item in response.get("Changes", []):
        change = item.get("ResourceChange", {})
        name, kind = change.get("LogicalResourceId"), change.get("ResourceType")
        if ALLOWED_RESOURCES.get(name) != kind or change.get("Action") not in {"Add", "Modify"}:
            raise ValueError("Unexpected independent AgentCore resource change")
        if change.get("Replacement") in {"True", "Conditional"} and kind in {
            "AWS::BedrockAgentCore::Memory", "AWS::BedrockAgentCore::Runtime",
        }:
            raise ValueError("Runtime or memory replacement is not an ordinary code deployment")
        changed.append(name)
    return changed


def session():
    import boto3
    from botocore.config import Config
    value = boto3.Session(region_name=REGION)
    client = value.client("sts", config=Config(connect_timeout=5, read_timeout=15))
    if client.get_caller_identity()["Account"] != ACCOUNT:
        raise ValueError("This deployment belongs to the configured Jeju Atlas account")
    return value


def owned_bucket(s3):
    tags = {item["Key"]: item["Value"] for item in s3.get_bucket_tagging(Bucket=BUCKET)["TagSet"]}
    if tags.get("Project") != "jeju-3d":
        raise ValueError("Artifact bucket is not owned by Jeju Atlas")
    if s3.get_bucket_versioning(Bucket=BUCKET).get("Status") != "Enabled":
        raise ValueError("Artifact bucket must retain object versions")
    public = s3.get_public_access_block(Bucket=BUCKET)["PublicAccessBlockConfiguration"]
    if not all(public.get(key) for key in ["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"]):
        raise ValueError("Artifact bucket must remain private")


def download_s3(s3, bucket, key, target, version_id=None, expected_sha256=None):
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket):
        raise ValueError("Invalid artifact bucket")
    if not isinstance(key, str) or not key.endswith(".zip") or ".." in key.split("/") or key.startswith("/"):
        raise ValueError("Expected a versioned code ZIP artifact")
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    params = {"Bucket": bucket, "Key": key}
    if version_id:
        params["VersionId"] = version_id
    response = s3.get_object(**params)
    body = response["Body"]
    temporary = None
    try:
        if response["ContentLength"] > MAX_ZIP_BYTES:
            raise ValueError("Dependency archive exceeds size limit")
        with tempfile.NamedTemporaryFile(prefix=f".{target.name}.", dir=target.parent, delete=False) as output:
            temporary = Path(output.name)
            size = 0
            for chunk in iter(lambda: body.read(1024 * 1024), b""):
                size += len(chunk)
                if size > MAX_ZIP_BYTES:
                    raise ValueError("Dependency archive exceeds size limit")
                output.write(chunk)
        sha256 = digest(temporary)
        if size != response["ContentLength"] or expected_sha256 and sha256 != expected_sha256:
            raise ValueError("Downloaded artifact checksum or length mismatch")
        temporary.replace(target)
        temporary = None
        return {"sha256": sha256, "bytes": size}
    finally:
        body.close()
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def put_immutable(s3, path, key, sha256):
    from botocore.exceptions import ClientError
    if not re.fullmatch(r"agent/(?:releases|dependencies)/[a-f0-9]{64}/(?:guide|tools)\.zip", key):
        raise ValueError("Artifact key is outside the owned namespace")
    if digest(path) != sha256:
        raise ValueError("Artifact changed after verification")
    try:
        with Path(path).open("rb") as body:
            response = s3.put_object(
                Bucket=BUCKET, Key=key, Body=body, IfNoneMatch="*",
                ContentType="application/zip", ServerSideEncryption="AES256",
                ChecksumSHA256=base64.b64encode(bytes.fromhex(sha256)).decode(),
                Metadata={"sha256": sha256},
            )
        version = response.get("VersionId")
    except ClientError as error:
        if error.response["Error"]["Code"] not in {"PreconditionFailed", "ConditionalRequestConflict"}:
            raise
        head = s3.head_object(Bucket=BUCKET, Key=key)
        if head.get("Metadata", {}).get("sha256") != sha256 or head["ContentLength"] != Path(path).stat().st_size:
            raise ValueError("An immutable artifact key already contains different bytes") from error
        version = head.get("VersionId")
    if not version or version == "null":
        raise ValueError("Artifact version ID is required")
    return version


def validate_dependencies(value):
    if value.get("version") != 1 or set(value.get("roles", {})) != set(ROLE_ROOTS):
        raise ValueError("Independent dependency manifest is incomplete")
    for role, entry in value["roles"].items():
        sha256 = entry.get("sha256")
        if not isinstance(sha256, str) or not re.fullmatch(r"[a-f0-9]{64}", sha256):
            raise ValueError("Dependency digest is invalid")
        if entry.get("bucket") != BUCKET or entry.get("key") != f"agent/dependencies/{sha256}/{role}.zip":
            raise ValueError("Dependencies must be owned by Jeju Atlas")
        if not entry.get("versionId") or entry["versionId"] == "null":
            raise ValueError("Dependency object version must be pinned")
    return value


def bootstrap_dependencies(aws, source_path):
    """One-time read-only import. Later builds fetch only our immutable copies."""
    if MANIFEST.exists():
        validate_dependencies(json.loads(MANIFEST.read_text()))
        print(json.dumps({"dependencies": "already independent"}))
        return
    if not source_path:
        raise ValueError("A reviewed bootstrap source manifest is required for the first import")
    source = json.loads(Path(source_path).read_text())
    if set(source) != set(ROLE_ROOTS):
        raise ValueError("Exactly the two reviewed code artifact sources are required")
    s3 = aws.client("s3")
    owned_bucket(s3)
    result = {"version": 1, "roles": {}}
    for role, entry in source.items():
        if not entry.get("versionId"):
            raise ValueError("Bootstrap source object versions must be pinned")
        local = LOCAL / "independence" / f"{role}-dependencies.zip"
        copied = download_s3(s3, entry["bucket"], entry["key"], local, entry["versionId"])
        # Validate archive names, CRCs and replacement behavior before retaining a copy.
        check = LOCAL / "independence" / f"{role}-bootstrap-check.zip"
        build_bundle(local, ROOT / "agent" / role, role, check)
        check.unlink()
        key = f"agent/dependencies/{copied['sha256']}/{role}.zip"
        version = put_immutable(s3, local, key, copied["sha256"])
        result["roles"][role] = {
            "bucket": BUCKET, "key": key, "versionId": version,
            "sha256": copied["sha256"], "bytes": copied["bytes"],
        }
    validate_dependencies(result)
    write_json(MANIFEST, result)
    print(json.dumps({"dependencies": "independent", "roles": list(result["roles"])}))


def build_agents(aws):
    dependencies = validate_dependencies(json.loads(MANIFEST.read_text()))
    s3 = aws.client("s3")
    owned_bucket(s3)
    report = {"stack": STACK, "createdAt": datetime.now(timezone.utc).isoformat(), "roles": {}}
    for role, entry in dependencies["roles"].items():
        base = LOCAL / "independence" / f"{role}-dependencies.zip"
        if not base.exists() or digest(base) != entry["sha256"]:
            download_s3(s3, BUCKET, entry["key"], base, entry["versionId"], entry["sha256"])
        target = LOCAL / "independence" / f"{role}-independent.zip"
        bundle = build_bundle(base, ROOT / "agent" / role, role, target)
        report["roles"][role] = {**bundle, "key": artifact_key(role, bundle["sha256"]), "file": str(target.relative_to(ROOT))}
    write_json(LOCAL / "atlas-agent-build.json", report)
    print(json.dumps({"built": {role: {"bytes": value["bytes"], "sha256": value["sha256"]} for role, value in report["roles"].items()}}))


def verified_build(published=False):
    path = LOCAL / ("atlas-agent-published.json" if published else "atlas-agent-build.json")
    build = json.loads(path.read_text())
    if build.get("stack") != STACK or set(build.get("roles", {})) != set(ROLE_ROOTS):
        raise ValueError("Build is not an independent Jeju Atlas artifact")
    for role, entry in build["roles"].items():
        if entry["sourceDigest"] != source_digest(ROOT / "agent" / role):
            raise ValueError("Agent source changed after packaging")
        if entry["key"] != artifact_key(role, entry["sha256"]):
            raise ValueError("Artifact key does not match verified content")
        file = (ROOT / entry["file"]).resolve()
        if LOCAL.resolve() not in file.parents or not file.is_file() or digest(file) != entry["sha256"]:
            raise ValueError("Packaged artifact is missing or changed")
        if published and not entry.get("versionId"):
            raise ValueError("Published artifact version is missing")
    return build


def publish_agents(aws):
    build = verified_build()
    s3 = aws.client("s3")
    owned_bucket(s3)
    for role, entry in build["roles"].items():
        entry["versionId"] = put_immutable(s3, ROOT / entry["file"], entry["key"], entry["sha256"])
    write_json(LOCAL / "atlas-agent-published.json", build)
    print(json.dumps({"published": {role: value["key"] for role, value in build["roles"].items()}}))


def existing_stack(cf):
    from botocore.exceptions import ClientError
    try:
        stack = cf.describe_stacks(StackName=STACK)["Stacks"][0]
    except ClientError as error:
        if error.response["Error"]["Code"] == "ValidationError" and "not exist" in str(error).lower():
            return None
        raise
    tags = {item["Key"]: item["Value"] for item in stack.get("Tags", [])}
    if not tags and stack["StackStatus"] == "REVIEW_IN_PROGRESS":
        # CREATE change sets hold the tags until execution. An untagged review
        # stack is ours only when our recorded, tagged, add-only change set is
        # attached to this exact stack ID; never adopt an arbitrary name match.
        path = LOCAL / "atlas-agent-change-set.json"
        if path.is_file():
            plan = json.loads(path.read_text())
            if plan.get("stack") == STACK and plan.get("changeSetId"):
                review = read_changeset(cf, plan["changeSetId"])
                review_tags = {item["Key"]: item["Value"] for item in review.get("Tags", [])}
                validate_changeset(review)
                if (review.get("StackId") == stack.get("StackId")
                        and review_tags.get("Project") == "jeju-3d"
                        and review_tags.get("Component") == "independent-agent"
                        and all(item["ResourceChange"]["Action"] == "Add" for item in review.get("Changes", []))):
                    return stack
    if tags.get("Project") != "jeju-3d" or tags.get("Component") != "independent-agent":
        raise ValueError("Existing stack ownership does not match this project")
    return stack


def read_changeset(cf, identifier):
    result = cf.describe_change_set(StackName=STACK, ChangeSetName=identifier)
    changes = list(result.get("Changes", []))
    token = result.get("NextToken")
    while token:
        page = cf.describe_change_set(StackName=STACK, ChangeSetName=identifier, NextToken=token)
        changes.extend(page.get("Changes", []))
        if len(changes) > 100:
            raise ValueError("Unexpectedly large AgentCore change set")
        token = page.get("NextToken")
    result["Changes"] = changes
    return result


def plan_agents(aws):
    build = verified_build(published=True)
    cf = aws.client("cloudformation")
    stack = existing_stack(cf)
    if stack and stack["StackStatus"].endswith("_IN_PROGRESS") and stack["StackStatus"] != "REVIEW_IN_PROGRESS":
        raise ValueError("An owned AgentCore stack operation is still running")
    body = TEMPLATE.read_text()
    cf.validate_template(TemplateBody=body)
    parameters = [{"ParameterKey": "DataBucketName", "ParameterValue": BUCKET}]
    for role, prefix in [("guide", "Guide"), ("tools", "Tools")]:
        entry = build["roles"][role]
        parameters.extend([
            {"ParameterKey": prefix + "CodeKey", "ParameterValue": entry["key"]},
            {"ParameterKey": prefix + "CodeVersionId", "ParameterValue": entry["versionId"]},
        ])
    name = "atlas-agent-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    change = cf.create_change_set(
        StackName=STACK, ChangeSetName=name,
        ChangeSetType="CREATE" if not stack or stack["StackStatus"] == "REVIEW_IN_PROGRESS" else "UPDATE",
        TemplateBody=body, Parameters=parameters, Capabilities=["CAPABILITY_IAM"],
        Description="Independent Jeju Atlas AgentCore only",
        Tags=[{"Key": "Project", "Value": "jeju-3d"}, {"Key": "Component", "Value": "independent-agent"}],
    )
    record = {
        "stack": STACK, "changeSetId": change["Id"], "templateSha256": digest(TEMPLATE),
        "publishedSha256": digest(LOCAL / "atlas-agent-published.json"), "createdAt": name,
    }
    write_json(LOCAL / "atlas-agent-change-set.json", record)
    deadline = time.monotonic() + 50
    while time.monotonic() < deadline:
        result = read_changeset(cf, change["Id"])
        if result["Status"] not in {"CREATE_PENDING", "CREATE_IN_PROGRESS"}:
            break
        time.sleep(2)
    else:
        print(json.dumps({**record, "status": "PENDING"}))
        return
    if result["Status"] != "CREATE_COMPLETE":
        raise ValueError("AgentCore change set failed: " + result.get("StatusReason", "unknown reason"))
    changed = validate_changeset(result)
    print(json.dumps({**record, "status": result["Status"], "resources": changed}))


def apply_agents(aws):
    verified_build(published=True)
    plan = json.loads((LOCAL / "atlas-agent-change-set.json").read_text())
    if plan.get("stack") != STACK or plan.get("templateSha256") != digest(TEMPLATE):
        raise ValueError("The reviewed AgentCore template changed")
    if plan.get("publishedSha256") != digest(LOCAL / "atlas-agent-published.json"):
        raise ValueError("The reviewed AgentCore artifacts changed")
    cf = aws.client("cloudformation")
    existing_stack(cf)
    result = read_changeset(cf, plan["changeSetId"])
    changes = validate_changeset(result)
    if result.get("Status") != "CREATE_COMPLETE" or result.get("ExecutionStatus") != "AVAILABLE":
        raise ValueError("The reviewed change set is not available for execution")
    cf.execute_change_set(StackName=STACK, ChangeSetName=plan["changeSetId"])
    print(json.dumps({"stack": STACK, "execution": "started", "resources": changes}))


def status_agents(aws):
    stack = existing_stack(aws.client("cloudformation"))
    if not stack:
        print(json.dumps({"stack": STACK, "status": "NOT_CREATED"}))
        return
    outputs = {item["OutputKey"]: item["OutputValue"] for item in stack.get("Outputs", [])}
    record = {"stack": STACK, "status": stack["StackStatus"]}
    if outputs:
        required = ["GuideRuntimeArn", "ToolsRuntimeArn", "GatewayId", "GatewayUrl", "MemoryId", "CatalogBucket"]
        if not all(outputs.get(key) for key in required):
            raise ValueError("Independent AgentCore outputs are incomplete")
        for name, prefix in [("GuideRuntimeArn", "JejuAtlas_Guide"), ("ToolsRuntimeArn", "JejuAtlas_Tools")]:
            if not re.fullmatch(rf"arn:aws:bedrock-agentcore:{REGION}:{ACCOUNT}:runtime/{prefix}-[A-Za-z0-9]{{10}}", outputs[name]):
                raise ValueError("Stack output points outside the independent runtimes")
        if outputs["CatalogBucket"] != BUCKET or not outputs["MemoryId"].startswith("JejuAtlas_Memory-"):
            raise ValueError("Stack output points outside the independent data or memory")
        record.update({
            "guideRuntimeArn": outputs["GuideRuntimeArn"],
            "toolsRuntimeArn": outputs["ToolsRuntimeArn"],
            "gatewayId": outputs["GatewayId"], "gatewayUrl": outputs["GatewayUrl"],
            "memoryId": outputs["MemoryId"], "catalogBucket": outputs["CatalogBucket"],
        })
        if stack["StackStatus"] in {"CREATE_COMPLETE", "UPDATE_COMPLETE"}:
            write_json(LOCAL / "atlas-agent-outputs.json", record)
    print(json.dumps(record))


def runtime_log_names(outputs):
    names = []
    for field, prefix in [("guideRuntimeArn", "JejuAtlas_Guide"), ("toolsRuntimeArn", "JejuAtlas_Tools")]:
        arn = outputs.get(field, "")
        if not isinstance(arn, str) or not re.fullmatch(
            rf"arn:aws:bedrock-agentcore:{REGION}:{ACCOUNT}:runtime/{prefix}-[A-Za-z0-9]{{10}}", arn,
        ):
            raise ValueError("Log retention is limited to independent Jeju Atlas runtimes")
        names.append("/aws/bedrock-agentcore/runtimes/" + arn.rsplit("/", 1)[-1] + "-DEFAULT")
    return names


def configure_logs(aws):
    from botocore.exceptions import ClientError
    stack = existing_stack(aws.client("cloudformation"))
    if not stack or stack["StackStatus"] not in {"CREATE_COMPLETE", "UPDATE_COMPLETE"}:
        raise ValueError("Complete the independent stack before configuring runtime logs")
    outputs = {item["OutputKey"]: item["OutputValue"] for item in stack["Outputs"]}
    selected = {"guideRuntimeArn": outputs["GuideRuntimeArn"], "toolsRuntimeArn": outputs["ToolsRuntimeArn"]}
    names = runtime_log_names(selected)
    control, logs = aws.client("bedrock-agentcore-control"), aws.client("logs")
    report = []
    for arn, name in zip(selected.values(), names):
        state = control.get_agent_runtime(agentRuntimeId=arn.rsplit("/", 1)[-1])
        artifact = state.get("agentRuntimeArtifact", {}).get("codeConfiguration", {}).get("code", {}).get("s3", {})
        if (state.get("status") != "READY" or artifact.get("bucket") != BUCKET
                or not state.get("roleArn", "").startswith(f"arn:aws:iam::{ACCOUNT}:role/{STACK}-")):
            raise ValueError("Runtime identity, artifact, or execution role is not owned and ready")
        groups = logs.describe_log_groups(logGroupNamePrefix=name)["logGroups"]
        if not any(group["logGroupName"] == name for group in groups):
            try:
                logs.create_log_group(logGroupName=name, tags={"Project": "jeju-3d"})
            except ClientError as error:
                if error.response["Error"]["Code"] != "ResourceAlreadyExistsException":
                    raise
        logs.put_retention_policy(logGroupName=name, retentionInDays=14)
        group = next(group for group in logs.describe_log_groups(logGroupNamePrefix=name)["logGroups"]
                     if group["logGroupName"] == name)
        if group.get("retentionInDays") != 14:
            raise ValueError("Runtime log retention verification failed")
        report.append({"runtimeArn": arn, "logGroupName": name, "retentionInDays": 14})
    write_json(LOCAL / "atlas-agent-log-retention.json", report)
    print(json.dumps({"configuredLogs": report}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["bootstrap-dependencies", "build", "publish", "plan", "apply", "status", "configure-logs"])
    parser.add_argument("--bootstrap-source", type=Path)
    args = parser.parse_args()
    aws = session()
    actions = {
        "bootstrap-dependencies": lambda: bootstrap_dependencies(aws, args.bootstrap_source),
        "build": lambda: build_agents(aws), "publish": lambda: publish_agents(aws),
        "plan": lambda: plan_agents(aws), "apply": lambda: apply_agents(aws),
        "status": lambda: status_agents(aws),
        "configure-logs": lambda: configure_logs(aws),
    }
    actions[args.action]()


if __name__ == "__main__":
    main()
