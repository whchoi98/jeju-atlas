#!/usr/bin/env python3
"""Jeju Atlas workshop: prepare and run only a namespaced participant workspace."""
import argparse
import getpass
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone

from lab_config import (
    aws_session, discover_network, read_config, resource_names, validate_config, write_json,
)
from lab_workspace import configure_hostname_templates, placeholder_hostname, prepare_workspace, verify_workspace

ROOT = Path(__file__).resolve().parents[2]
LOCAL = ROOT / "workshop/.local"
STACK_KINDS = ["bootstrap", "app", "origin", "edge", "operations", "data",
               "origin-routing", "tls-probe", "static"]
DEPLOY_STEPS = {"network", "build-push", "build-data-push", "build-routing-push", "invalidate",
                "plan-tls-probe-disable", "delete-tls-probe"} | {
    f"{verb}-{kind}" for verb in ["plan", "apply", "status"] for kind in STACK_KINDS}
AGENT_STEPS = {"agent-" + action: action for action in ["build", "publish", "plan", "apply", "status", "configure-logs"]}
LOCAL_STEPS = {
    "install": ["npm", "ci"],
    "check": ["npm", "run", "check"],
    "build": ["npm", "run", "build"],
    "routing-fetch": [sys.executable, "scripts/build-routing-data.py", "fetch"],
    "routing-build": [sys.executable, "scripts/build-routing-data.py", "build"],
    "routing-verify": [sys.executable, "scripts/build-routing-data.py", "verify"],
}
VERIFICATION_STEPS = {
    "verify": "verify.py",
    "verify-terrain": "verify-terrain-cache.py",
    "verify-assets": "verify-shared-assets.py",
    "verify-tls": "verify-tls-probe.py",
}


def emit(value):
    print(json.dumps(value, ensure_ascii=False, indent=2, default=str), flush=True)


def workspace_path(config):
    return LOCAL / "labs" / config["participant"] / "app"


def cli_path(config):
    return LOCAL / "labs" / config["participant"] / "cli"


def environment(config):
    env = {**os.environ, "AWS_REGION": config["region"], "AWS_DEFAULT_REGION": config["region"]}
    if config["profile"]:
        env["AWS_PROFILE"] = config["profile"]
    return env


def require_execute(args, action):
    if not args.execute:
        emit({"action": action, "executed": False, "next": "Add --execute after reviewing this step"})
        return False
    return True


def command_for(step):
    if step in DEPLOY_STEPS:
        return [sys.executable, "scripts/deploy.py", step], True
    if step in AGENT_STEPS:
        return [sys.executable, "scripts/deploy-atlas-agent.py", AGENT_STEPS[step]], True
    if step in LOCAL_STEPS:
        return LOCAL_STEPS[step], False
    if step in VERIFICATION_STEPS:
        return [sys.executable, "scripts/" + VERIFICATION_STEPS[step]], True
    raise ValueError("Unknown workshop step; arbitrary commands are not accepted")


def run_step(config, args):
    workspace = verify_workspace(config, workspace_path(config))
    command, uses_aws = command_for(args.step)
    emit({"workspace": str(workspace), "accountId": config["accountId"],
          "project": resource_names(config)["project"], "command": command})
    if not require_execute(args, args.step):
        return
    if args.step in {"plan-origin", "plan-origin-routing", "plan-tls-probe"} and not config["domainName"]:
        raise ValueError("Configure an owned hostname and issued viewer certificate for the full HTTPS chapter")
    if uses_aws:
        aws_session(config)
    result = subprocess.run(command, cwd=workspace, env=environment(config))
    write_json(workspace / ".local/workshop-last-step.json", {
        "step": args.step, "exitCode": result.returncode, "at": datetime.now(timezone.utc).isoformat(),
    })
    if result.returncode:
        raise SystemExit(result.returncode)


def doctor(config, include_aws, assistant="codex"):
    assistants = {"codex": "codex", "kiro": "kiro-cli", "claude": "claude"}
    if assistant not in assistants:
        raise ValueError("Choose codex, kiro, or claude")
    assistant_command = assistants[assistant]
    rows = []
    checks = [
        ("node", ["node", "--version"]), ("npm", ["npm", "--version"]),
        ("python", [sys.executable, "--version"]), ("uv", ["uv", "--version"]),
        ("aws", ["aws", "--version"]), ("docker", ["docker", "--version"]),
        ("agentcore", ["agentcore", "--version"]), (assistant_command, [assistant_command, "--version"]),
        ("cfn-lint", ["cfn-lint", "--version"]),
    ]
    for name, command in checks:
        executable = shutil.which(command[0])
        if not executable:
            rows.append({"tool": name, "ok": False, "reason": "not installed"})
            continue
        result = subprocess.run(command, text=True, capture_output=True, timeout=25)
        version = (result.stdout + result.stderr).strip()
        ok = result.returncode == 0
        if name == "node":
            match = re.search(r"v(\d+)\.(\d+)\.(\d+)", version)
            ok = ok and bool(match) and tuple(map(int, match.groups())) >= (24, 18, 1) and match[1] == "24"
        if name == "agentcore":
            ok = ok and bool(re.search(r"\b0\.28\.1\b", version))
        rows.append({"tool": name, "ok": bool(ok), "version": version[:500]})
    result = {"tools": rows, "names": resource_names(config), "awsChecked": False, "assistant": assistant}
    if include_aws:
        session = aws_session(config)
        discovered = discover_network(config, session.client("ec2"))
        result.update(awsChecked=True, network=discovered["network"])
        if config["domainName"]:
            certificate = session.client("acm", region_name="us-east-1").describe_certificate(
                CertificateArn=config["viewerCertificateArn"])["Certificate"]
            host = config["domainName"]
            covered = any(name == host or (name.startswith("*.") and host.split(".", 1)[-1] == name[2:])
                          for name in certificate.get("SubjectAlternativeNames", []))
            if certificate["Status"] != "ISSUED" or not covered:
                raise ValueError("Viewer certificate is not issued for this lab hostname")
    result["passed"] = all(row["ok"] for row in rows)
    return result


def configure_domain(config, args):
    workspace = verify_workspace(config, workspace_path(config))
    previous = config["domainName"] or placeholder_hostname(config)
    changed = validate_config({**config, "domainName": args.domain,
                               "viewerCertificateArn": args.viewer_certificate}, require_network=True)
    aws = aws_session(changed) if args.execute else None
    if aws:
        cert = aws.client("acm", region_name="us-east-1").describe_certificate(
            CertificateArn=changed["viewerCertificateArn"])["Certificate"]
        if cert["Status"] != "ISSUED":
            raise ValueError("Issue the viewer certificate before configuring the lab domain")
    emit({"previousDomain": previous, "newDomain": changed["domainName"],
          "viewerCertificateArn": changed["viewerCertificateArn"]})
    if not require_execute(args, "configure-domain"):
        return
    for directory in ["infra", "scripts", "server", "agent", "tests"]:
        for path in (workspace / directory).rglob("*"):
            if path.suffix not in {".py", ".json", ".yaml", ".yml", ".mjs"} or path.is_symlink():
                continue
            text = path.read_text()
            replacement = text.replace(previous, changed["domainName"]).replace(
                re.escape(previous), re.escape(changed["domainName"]))
            if replacement != text:
                path.write_text(replacement)
    settings = json.loads((workspace / "infra/production.json").read_text())
    settings.update(ViewerDomainName=changed["domainName"], ViewerCertificateArn=changed["viewerCertificateArn"])
    configure_hostname_templates(workspace, changed)
    write_json(workspace / "infra/production.json", settings)
    write_json(args.config, changed)


def set_provider_secret(config, args):
    names = resource_names(config)
    suffix = {"visitjeju": "visitjeju-api-key", "tourapi": "tourapi-service-key"}[args.provider]
    name = "/" + names["project"] + "/" + suffix
    emit({"parameter": name, "type": "SecureString", "valueWillBePrinted": False})
    if not require_execute(args, "set-provider-secret"):
        return
    if not sys.stdin.isatty():
        raise ValueError("Enter provider keys in your own terminal; never send them through a Codex prompt or pipeline")
    session = aws_session(config)
    value = getpass.getpass("API key (hidden input): ").strip()
    if not 8 <= len(value) <= 2048 or any(ord(char) < 32 for char in value):
        raise ValueError("Invalid provider key")
    result = session.client("ssm").put_parameter(
        Name=name, Value=value, Type="SecureString", Overwrite=True,
        Description="Jeju Atlas workshop " + config["participant"] + " " + args.provider,
    )
    emit({"parameter": name, "version": result["Version"]})


def cleanup_inventory(config, session):
    names = resource_names(config)
    order = [("TlsProbe", config["region"]), ("App", config["region"]),
             ("Operations", config["region"]), ("Data", config["region"]),
             ("Static", config["region"]), ("OriginRouting", "us-east-1"),
             ("Edge", "us-east-1"), ("AgentCore", config["region"]),
             ("Origin", config["region"]), ("Registry", config["region"])]
    stacks = []
    from botocore.exceptions import ClientError
    for suffix, region in order:
        stack_name = names["stackPrefix"] + suffix
        cf = session.client("cloudformation", region_name=region)
        try:
            stack = cf.describe_stacks(StackName=stack_name)["Stacks"][0]
        except ClientError as error:
            if error.response["Error"]["Code"] == "ValidationError" and "not exist" in str(error).lower():
                continue
            raise
        tags = {item["Key"]: item["Value"] for item in stack.get("Tags", [])}
        if tags.get("Project") != names["project"]:
            raise ValueError("Cleanup encountered a stack without the lab ownership tag: " + stack_name)
        resources = []
        paginator = cf.get_paginator("list_stack_resources")
        for page in paginator.paginate(StackName=stack["StackId"]):
            resources.extend({"logicalId": item["LogicalResourceId"], "type": item["ResourceType"],
                              "physicalId": item.get("PhysicalResourceId")}
                             for item in page["StackResourceSummaries"])
        forbidden = {"AWS::EC2::VPC", "AWS::EC2::Subnet", "AWS::EC2::NatGateway", "AWS::EC2::EIP",
                     "AWS::EC2::Route", "AWS::EC2::RouteTable", "AWS::EC2::InternetGateway",
                     "AWS::Route53::HostedZone", "AWS::Route53::RecordSet"}
        if any(item["type"] in forbidden for item in resources):
            raise ValueError("Cleanup refuses stacks containing shared networking or DNS")
        stacks.append({"name": stack_name, "arn": stack["StackId"], "region": region,
                       "status": stack["StackStatus"], "resources": resources})
    return stacks


def save_cleanup_inventory(workspace, stacks):
    """Retain discovery history; execution still uses only the fresh, tag-checked list."""
    path = Path(workspace) / ".local/workshop-cleanup-plan.json"
    previous = json.loads(path.read_text()) if path.is_file() else {}
    history = {}
    for item in [*previous.get("history", []), *previous.get("stacks", []), *stacks]:
        existing = history.get(item["arn"], {})
        resources = {
            (entry["logicalId"], entry["type"], entry.get("physicalId")): entry
            for entry in [*existing.get("resources", []), *item.get("resources", [])]
        }
        history[item["arn"]] = {**existing, **item, "resources": list(resources.values())}
    write_json(path, {"stacks": stacks, "history": list(history.values()),
                      "at": datetime.now(timezone.utc).isoformat()})


def drain_collectors(config, session, stacks):
    """Disable this lab's schedule, then stop only its collector-family tasks."""
    config = validate_config(config)
    names = resource_names(config)
    region, account = config["region"], config["accountId"]
    disabled = []
    for stack in stacks:
        for resource in stack.get("resources", []):
            if resource["type"] != "AWS::Scheduler::Schedule":
                continue
            identity = resource["physicalId"]
            if identity.startswith("arn:"):
                prefix = f"arn:aws:scheduler:{region}:{account}:schedule/"
                if not identity.startswith(prefix):
                    raise ValueError("Schedule ARN does not belong to this lab account")
                group, name = identity[len(prefix):].split("/", 1)
            else:
                group, name = "default", identity
            if not name.startswith(names["project"] + "-"):
                raise ValueError("Schedule name is outside the lab namespace")
            scheduler = session.client("scheduler", region_name=region)
            value = scheduler.get_schedule(Name=name, GroupName=group)
            if value.get("State") != "DISABLED":
                fields = {
                    "ScheduleExpression", "ScheduleExpressionTimezone", "StartDate", "EndDate",
                    "FlexibleTimeWindow", "Target", "KmsKeyArn", "Description", "ActionAfterCompletion",
                }
                update = {key: item for key, item in value.items() if key in fields}
                scheduler.update_schedule(Name=name, GroupName=group, State="DISABLED", **update)
            disabled.append(name)
    clusters = [resource["physicalId"] for stack in stacks for resource in stack.get("resources", [])
                if resource["type"] == "AWS::ECS::Cluster"]
    if not clusters:
        return {"disabledSchedules": disabled, "stoppedCollectorTasks": []}
    if len(clusters) != 1 or clusters[0].rsplit("/", 1)[-1] != names["project"]:
        raise ValueError("Collector cleanup requires the exact owned ECS cluster")
    cluster = clusters[0]
    family = names["project"] + "-data"
    ecs = session.client("ecs", region_name=region)
    task_arns, token = [], None
    while True:
        params = {"cluster": cluster, "family": family, "desiredStatus": "RUNNING"}
        if token:
            params["nextToken"] = token
        page = ecs.list_tasks(**params)
        task_arns.extend(page.get("taskArns", []))
        if len(task_arns) > 1000:
            raise ValueError("Unexpected collector task count; inspect before cleanup")
        token = page.get("nextToken")
        if not token:
            break
    stopped = []
    for start in range(0, len(task_arns), 100):
        batch = task_arns[start:start + 100]
        result = ecs.describe_tasks(cluster=cluster, tasks=batch)
        if result.get("failures"):
            raise ValueError("Could not identify all collector tasks; retry after checking task state")
        tasks = result["tasks"]
        prefix = f"arn:aws:ecs:{region}:{account}:task-definition/{family}:"
        arn_prefix = f"arn:aws:ecs:{region}:{account}:task/"
        if any(not task.get("taskDefinitionArn", "").startswith(prefix)
               or not task.get("taskArn", "").startswith(arn_prefix) for task in tasks):
            raise ValueError("Collector cleanup refuses tasks outside the owned family/account")
        for task in tasks:
            if task.get("lastStatus") not in {"STOPPED", "STOPPING"}:
                ecs.stop_task(cluster=cluster, task=task["taskArn"], reason="Owned Jeju Atlas workshop cleanup")
            stopped.append(task["taskArn"])
        if tasks:
            ecs.get_waiter("tasks_stopped").wait(
                cluster=cluster, tasks=[task["taskArn"] for task in tasks],
                WaiterConfig={"Delay": 6, "MaxAttempts": 100})
    return {"disabledSchedules": disabled, "stoppedCollectorTasks": stopped}


def main():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--config", type=Path, default=LOCAL / "config.json")
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    init = commands.add_parser("init", parents=[common])
    init.add_argument("--participant", required=True)
    init.add_argument("--account-id", required=True)
    init.add_argument("--profile", default="")
    init.add_argument("--vpc-name", default="cc-on-bedrock-vpc")
    init.add_argument("--domain", default="")
    init.add_argument("--viewer-certificate", default="")
    ec2_init = commands.add_parser("init-ec2", parents=[common],
                                  help="Use this EC2's account/region/VPC and existing Codex environment")
    ec2_init.add_argument("--participant", required=True)
    doc = commands.add_parser("doctor", parents=[common])
    doc.add_argument("--aws", action="store_true")
    doc.add_argument("--assistant", choices=["codex", "kiro", "claude"], default="codex")
    commands.add_parser("discover", parents=[common])
    commands.add_parser("prepare", parents=[common])
    commands.add_parser("info", parents=[common])
    run = commands.add_parser("run", parents=[common])
    run.add_argument("step", choices=sorted(DEPLOY_STEPS | set(AGENT_STEPS) | set(LOCAL_STEPS) | set(VERIFICATION_STEPS)))
    run.add_argument("--execute", action="store_true")
    for action in ["deps-build", "deps-publish", "publish-catalog", "cli-prepare", "enable-https",
                   "enable-schedule", "cleanup"]:
        command = commands.add_parser(action, parents=[common])
        command.add_argument("--execute", action="store_true")
        if action == "cleanup":
            command.add_argument("--confirm-participant")
    catalog = commands.add_parser("catalog", parents=[common])
    catalog.add_argument("--osm", action="store_true")
    catalog.add_argument("--osm-file", type=Path)
    catalog.add_argument("--execute", action="store_true")
    domain = commands.add_parser("configure-domain", parents=[common])
    domain.add_argument("--domain", required=True)
    domain.add_argument("--viewer-certificate", required=True)
    domain.add_argument("--execute", action="store_true")
    secret = commands.add_parser("set-secret", parents=[common])
    secret.add_argument("--provider", choices=["visitjeju", "tourapi"], required=True)
    secret.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    if args.action == "init-ec2":
        if args.config.exists() or args.config.is_symlink():
            raise FileExistsError("Config already exists; keep the EC2 binding or select another config file")
        from ec2_context import configuration_for_ec2, read_ec2_context
        config = configuration_for_ec2(args.participant, read_ec2_context())
        config = discover_network(config, aws_session(config).client("ec2"))
        write_json(args.config, config)
        emit({"config": str(args.config), "ec2Context": config["ec2Context"],
              "network": config["network"], "names": resource_names(config),
              "createdAwsResources": False})
        return
    if args.action == "init":
        if args.config.exists() or args.config.is_symlink():
            raise FileExistsError("Config already exists; preserve it or select another --config path")
        config = validate_config({
            "participant": args.participant, "accountId": args.account_id, "profile": args.profile,
            "vpcName": args.vpc_name, "domainName": args.domain,
            "viewerCertificateArn": args.viewer_certificate,
        })
        write_json(args.config, config)
        emit({"config": str(args.config), "names": resource_names(config)})
        return
    config = read_config(args.config)
    if args.action == "info":
        emit({"config": str(args.config.resolve()), "names": resource_names(config),
              "workspace": str(workspace_path(config)), "cliWorkspace": str(cli_path(config)),
              "accountId": config["accountId"], "region": config["region"],
              "ec2Context": config.get("ec2Context")})
        return
    if args.action == "doctor":
        result = doctor(config, args.aws, args.assistant)
        emit(result)
        if not result["passed"]:
            raise SystemExit(1)
        return
    if args.action == "discover":
        updated = discover_network(config, aws_session(config).client("ec2"))
        write_json(args.config, updated)
        emit({"network": updated["network"], "createdAwsResources": False})
        return
    config = validate_config(config, require_network=True)
    if args.action == "prepare":
        path = prepare_workspace(config, ROOT, LOCAL / "labs")
        emit({"workspace": str(path), "names": resource_names(config), "deployed": False})
        return
    if args.action == "run":
        run_step(config, args)
        return
    if args.action == "configure-domain":
        configure_domain(config, args)
        return
    if args.action == "set-secret":
        set_provider_secret(config, args)
        return
    workspace = verify_workspace(config, workspace_path(config))
    if args.action == "cleanup":
        session = aws_session(config)
        stacks = cleanup_inventory(config, session)
        save_cleanup_inventory(workspace, stacks)
        emit({"stacks": stacks, "sharedVpcNatAndViewerCertificateExcluded": True,
              "cliProjectRemovedSeparately": resource_names(config)["cliProject"],
              "retainedResourcesMayRemain": True})
        if not args.execute:
            return
        if args.confirm_participant != config["participant"]:
            raise ValueError("Cleanup requires --confirm-participant matching this lab")
        if any(stack["status"].endswith("_IN_PROGRESS") for stack in stacks):
            raise ValueError("Wait for current stack operations, then resume cleanup")
        drained = drain_collectors(config, session, stacks)
        write_json(workspace / ".local/workshop-collector-drain.json", drained)
        emit(drained)
        for stack in stacks:
            if stack["status"].endswith("_IN_PROGRESS"):
                raise ValueError("Wait for the stack operation, then resume cleanup: " + stack["name"])
            cf = session.client("cloudformation", region_name=stack["region"])
            cf.delete_stack(StackName=stack["arn"])
            emit({"deletionStarted": stack["name"], "region": stack["region"]})
            cf.get_waiter("stack_delete_complete").wait(
                StackName=stack["arn"], WaiterConfig={"Delay": 15, "MaxAttempts": 160})
        emit({"stackCleanup": "complete", "retainedDataAndReplicatedEdgeResources": "inspect the saved inventory"})
        return
    if not require_execute(args, args.action):
        return
    if args.action == "catalog":
        command = [sys.executable, str(ROOT / "workshop/scripts/catalog_seed.py"),
                   "--output", str(workspace / ".local/catalog.sqlite")]
        if args.osm:
            command.append("--osm")
        if args.osm_file:
            command.extend(["--osm-file", str(args.osm_file.resolve())])
        subprocess.run(command, check=True, cwd=ROOT)
    elif args.action in {"deps-build", "deps-publish", "publish-catalog"}:
        from lab_artifacts import build_dependencies, publish_catalog, publish_dependencies
        if args.action == "deps-build":
            emit(build_dependencies(config, workspace))
        elif args.action == "deps-publish":
            emit(publish_dependencies(config, workspace, aws_session(config)))
        else:
            emit(publish_catalog(config, workspace, aws_session(config)))
    elif args.action == "cli-prepare":
        subprocess.run([
            sys.executable, str(ROOT / "workshop/cli/prepare.py"),
            "--project-name", resource_names(config)["cliProject"],
            "--account-id", config["accountId"], "--region", config["region"],
            "--output", str(cli_path(config)),
        ], check=True, cwd=ROOT, env=environment(config))
    elif args.action == "enable-https":
        if not config["domainName"]:
            raise ValueError("Configure the lab hostname/certificate and verify the TLS probe first")
        proof_path = workspace / ".local/tls-probe-verification.json"
        proof = json.loads(proof_path.read_text()) if proof_path.exists() else {}
        if not proof.get("passed") or proof.get("canonicalHostName") != config["domainName"]:
            raise ValueError("The matching isolated HTTPS probe has not passed")
        settings = json.loads((workspace / "infra/production.json").read_text())
        settings.update(OriginTlsEnabled="true", OriginTlsMode="canonical-host", TargetHealthPath="/readyz")
        write_json(workspace / "infra/production.json", settings)
        emit({"settingsUpdated": True, "next": "run plan-app, review, then run apply-app"})
    elif args.action == "enable-schedule":
        write_json(workspace / "infra/data-settings.json", {"ScheduleState": "ENABLED"})
        emit({"scheduleSetting": "ENABLED", "next": "run plan-data, review, then run apply-data"})


if __name__ == "__main__":
    try:
        main()
    except (ValueError, FileNotFoundError, FileExistsError, PermissionError) as error:
        print("Workshop: " + str(error), file=sys.stderr)
        raise SystemExit(2) from None
