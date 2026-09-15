#!/usr/bin/env python3
"""Pin a participant Runtime to Sonnet 4.6 without changing deployment or IAM."""
import argparse
import ast
import json
from pathlib import Path
import re
import sys

from core import read_json, safe_path

MODEL_ID = "global.anthropic.claude-sonnet-4-6"
CLAUDE_CODE_MODEL = "claude-sonnet-4-6"
DEPLOYMENT_REGION = "ap-northeast-2"
REGION_ENV = "ATLAS_BEDROCK_REGION"
LOADER = '''# Jeju Atlas workshop: pinned Sonnet 4.6, explicit caller region.
import os
import re

from strands.models.bedrock import BedrockModel

MODEL_ID = "global.anthropic.claude-sonnet-4-6"


def load_model() -> BedrockModel:
    """The organizer selects the Bedrock endpoint independently of deployment."""
    region = os.environ.get("ATLAS_BEDROCK_REGION", "")
    if not re.fullmatch(r"[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+", region):
        raise ValueError("Set the organizer-verified ATLAS_BEDROCK_REGION; no deployment-region fallback is used")
    return BedrockModel(model_id=MODEL_ID, region_name=region, max_tokens=2048)
'''


def caller_region(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+", value):
        raise ValueError("Provide an explicit organizer-verified Bedrock caller region")
    return value


def runtime_spec(project):
    project = safe_path(project)
    spec = read_json(project / "agentcore/agentcore.json")
    if not isinstance(spec, dict) or not re.fullmatch(r"AtlasCli[A-Za-z0-9]{1,15}", str(spec.get("name", ""))):
        raise ValueError("Use the participant AgentCore project")
    runtimes = spec.get("runtimes")
    if (not isinstance(runtimes, list) or len(runtimes) != 1 or runtimes[0].get("name") != "JejuGuide"
            or runtimes[0].get("build") != "CodeZip"
            or Path(runtimes[0].get("codeLocation", "")) != Path("app/JejuGuide")):
        raise ValueError("Expected the participant JejuGuide CodeZip Runtime")
    env = runtimes[0].get("envVars", [])
    if not isinstance(env, list) or any(not isinstance(item, dict) or set(item) != {"name", "value"} for item in env):
        raise ValueError("Review the Runtime envVars before configuring its model")
    if len({item["name"] for item in env}) != len(env):
        raise ValueError("Runtime environment variable names must be unique")
    return project, spec, runtimes[0]


def generated_loader(text):
    if text == LOADER:
        return True
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return False
    imports = [node for node in tree.body if isinstance(node, ast.ImportFrom)]
    functions = [node for node in tree.body if isinstance(node, ast.FunctionDef)]
    if (len(tree.body) != 2 or len(imports) != 1 or len(functions) != 1
            or imports[0].module != "strands.models.bedrock"
            or [(item.name, item.asname) for item in imports[0].names] != [("BedrockModel", None)]
            or functions[0].name != "load_model"
            or functions[0].args.args or functions[0].args.posonlyargs
            or functions[0].args.kwonlyargs or functions[0].args.vararg or functions[0].args.kwarg):
        return False
    body = functions[0].body
    if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) and isinstance(body[0].value.value, str):
        body = body[1:]
    return (len(body) == 1 and isinstance(body[0], ast.Return) and isinstance(body[0].value, ast.Call)
            and isinstance(body[0].value.func, ast.Name) and body[0].value.func.id == "BedrockModel"
            and not body[0].value.args
            and all(item.arg in {"model_id", "max_tokens", "region_name"} and isinstance(item.value, ast.Constant)
                    for item in body[0].value.keywords))


def configure(project, region=None):
    project, spec, runtime = runtime_spec(project)
    loader = safe_path(project / "app/JejuGuide/model/load.py")
    if not loader.is_file() or not generated_loader(loader.read_text()):
        raise ValueError("Preserve the custom model/load.py; review it and apply the pinned loader manually")
    env = runtime.get("envVars", [])
    current = next((item["value"] for item in env if item["name"] == REGION_ENV), "")
    selected = caller_region(region) if region is not None else caller_region(current) if current else None
    runtime["envVars"] = [item for item in env if item["name"] != REGION_ENV]
    if selected:
        runtime["envVars"].append({"name": REGION_ENV, "value": selected})
    # Only the recognized generated loader and one Runtime variable are changed.
    # aws-targets.json, IAM files, authentication and other Runtime vars are kept.
    loader.write_text(LOADER)
    (project / "agentcore/agentcore.json").write_text(json.dumps(spec, ensure_ascii=False, indent=2) + "\n")
    return {"modelId": MODEL_ID, "callerRegion": selected, "deploymentRegion": DEPLOYMENT_REGION,
            "configurationComplete": bool(selected), "readyForInvocation": False,
            "modelAccessVerified": False, "requiresRealModelCheck": True}


def check_model(project, spec=None):
    project, actual, runtime = runtime_spec(project)
    if spec is not None and actual != spec:
        raise ValueError("Runtime configuration changed during model inspection")
    if (project / "app/JejuGuide/model/load.py").read_text() != LOADER:
        raise ValueError("Configure the pinned Sonnet 4.6 loader before the local Runtime check")
    region = next((item["value"] for item in runtime.get("envVars", []) if item["name"] == REGION_ENV), "")
    return {"modelId": MODEL_ID, "callerRegion": caller_region(region), "modelAccessVerified": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--caller-region", help="Only a caller region explicitly verified by the organizer")
    parser.add_argument("--check", action="store_true", help="Read local model configuration only")
    args = parser.parse_args()
    try:
        result = check_model(args.project) if args.check else configure(args.project, args.caller_region)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (OSError, ValueError, KeyError, TypeError) as error:
        print("Workshop model configuration: " + str(error), file=sys.stderr)
        raise SystemExit(2) from None


if __name__ == "__main__":
    main()
