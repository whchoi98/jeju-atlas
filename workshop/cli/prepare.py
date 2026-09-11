#!/usr/bin/env python3
"""Create an independent, offline AgentCore CLI lifecycle workshop project.

Only the explicitly listed bundled files are read. No reference repository,
environment file, AWS credentials, installed CLI, or network is consulted.
"""

import argparse
import json
import os
import re
from pathlib import Path


HERE = Path(__file__).resolve().parent
CLI_VERSION = "0.28.1"
REGION = "ap-northeast-2"
RUNTIME = "Warmup"
TEMPLATE_FILES = (
    "AGENTS.md",
    "README.md",
    "activate.sh",
    ".gitignore",
    "app/warmup/main.py",
    "app/warmup/pyproject.toml",
    "app/warmup/uv.lock",
    "app/warmup/tests/test_main.py",
    "agentcore/cdk/package.json",
    "agentcore/cdk/package-lock.json",
    "agentcore/cdk/cdk.json",
    "agentcore/cdk/tsconfig.json",
    "agentcore/cdk/bin/cdk.ts",
    "agentcore/cdk/lib/stack.ts",
    "checks/check_synth.py",
)
EMPTY_RESOURCES = (
    "memories", "knowledgeBases", "credentials", "evaluators",
    "onlineEvalConfigs", "agentCoreGateways", "policyEngines",
    "configBundles", "abTests", "harnesses", "datasets", "payments",
)


def validate_arguments(name, account, region, destination):
    if not re.fullmatch(r"AtlasCli[A-Za-z0-9]{1,15}", name):
        raise ValueError(
            "project-name must be AtlasCli + 1-15 ASCII letters/digits "
            "(for example AtlasCliTeam01; maximum 23 characters)"
        )
    if re.search(r"prod|shared|live|reference|default", name[len("AtlasCli"):], re.IGNORECASE):
        raise ValueError("production/shared/reference project names are not allowed")
    if not re.fullmatch(r"[0-9]{12}", account) or account == "000000000000":
        raise ValueError("account-id must be a nonzero, 12-digit ASCII AWS account ID")
    if region != REGION:
        raise ValueError("this workshop only supports ap-northeast-2")

    output = Path(os.path.abspath(destination))
    # The pinned upstream ZIP packager passes paths through a shell. Keep its
    # inputs free of whitespace and metacharacters rather than patching the CLI.
    if not re.fullmatch(r"[A-Za-z0-9_./-]+", str(output)):
        raise ValueError("output path must use ASCII letters/digits, /, -, _ or . only")
    if os.path.lexists(output):
        raise ValueError("output must be a fresh, nonexistent directory; nothing was overwritten")
    for ancestor in (output, *output.parents):
        if ancestor.is_symlink():
            raise ValueError("output and its parents must not be symbolic links")
        if ancestor.name in (".git", ".agents", ".codex") or re.fullmatch(
            r"agentcore-cli(?:-.*)?", ancestor.name, re.IGNORECASE
        ):
            raise ValueError("output must not be inside a reference repository or tool directory")

    # Source-tree output is allowed only in the workshop's local storage.
    repo = HERE.parent.parent
    try:
        relative = output.relative_to(repo).parts
    except ValueError:
        relative = ()
    if relative and relative[:2] not in (
        ("workshop", ".local"), (".local", "workshop"),
    ):
        raise ValueError(
            "inside the source repository, use workshop/.local/ or .local/workshop/; "
            "otherwise choose a fresh directory outside the repository"
        )
    return output


def json_text(value):
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def prepare(name, account, region, destination):
    output = validate_arguments(name, account, region, destination)
    # Read an allowlist, rather than copying a tree that could contain local state.
    files = {}
    for relative in TEMPLATE_FILES:
        source = HERE / "template" / relative
        if source.is_symlink() or source.resolve() != source:
            raise ValueError("bundled templates must not be symbolic links")
        files[relative] = source.read_text(encoding="utf-8").replace("__ATLAS_PROJECT__", name)

    spec = {
        "$schema": "https://schema.agentcore.aws.dev/v1/agentcore.json",
        "name": name,
        "version": 1,
        "managedBy": "CDK",
        "tags": {
            "agentcore:project-name": name,
            "workshop:module": "agentcore-cli-intro",
        },
        "runtimes": [{
            "name": RUNTIME,
            "description": "Deterministic CLI lifecycle warmup; no model invocation",
            "build": "CodeZip",
            "entrypoint": "main.py",
            "codeLocation": "app/warmup",
            "runtimeVersion": "PYTHON_3_14",
            "protocol": "HTTP",
            "networkMode": "PUBLIC",
            "authorizerType": "AWS_IAM",
            "instrumentation": {"enableOtel": False},
            "envVars": [
                {"name": "OTEL_SDK_DISABLED", "value": "true"},
                {"name": "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", "value": "false"},
                {"name": "OTEL_TRACES_EXPORTER", "value": "none"},
                {"name": "OTEL_METRICS_EXPORTER", "value": "none"},
                {"name": "OTEL_LOGS_EXPORTER", "value": "none"},
            ],
            "lifecycleConfiguration": {
                "idleRuntimeSessionTimeout": 300,
                "maxLifetime": 600,
            },
        }],
        **{key: [] for key in EMPTY_RESOURCES},
    }
    files["agentcore/agentcore.json"] = json_text(spec)
    files["agentcore/aws-targets.json"] = json_text([{
        "name": "default", "account": account, "region": region,
    }])
    files[".cli-config/config.json"] = json_text({
        "disableDependencyManagement": True,
        "disableTransactionSearch": True,
        "telemetry": {"enabled": False},
    })
    ownership = {
        "module": "agentcore-cli-intro",
        "projectName": name,
        "accountId": account,
        "region": region,
        "target": "default",
        "runtime": RUNTIME,
        "stackName": "AgentCore-{}-default".format(name),
        "cliVersion": CLI_VERSION,
    }
    files["toolchain.json"] = json_text({
        "node": "24",
        "@aws/agentcore": CLI_VERSION,
        "@aws/agentcore-cdk": "0.1.0-alpha.50",
        "python": "3.14",
        "bedrock-agentcore": "1.9.1",
    })

    # mkdir is the atomic no-overwrite gate, including an already-empty directory.
    output.mkdir(parents=True, exist_ok=False)
    for relative, content in sorted(files.items()):
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(content)
    # Written last: a partially generated directory is never marked ready.
    with (output / ".atlas-cli-workshop.json").open("x", encoding="utf-8") as stream:
        stream.write(json_text(ownership))
    return {**ownership, "workspace": str(output), "deploymentPerformed": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-name", required=True)
    parser.add_argument("--account-id", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        result = prepare(args.project_name, args.account_id, args.region, args.output)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print(json_text(result), end="")


if __name__ == "__main__":
    main()
