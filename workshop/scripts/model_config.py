#!/usr/bin/env python3
"""Configure the participant Python 3.12 Runtime and explicit Bedrock auth."""
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
LEGACY_LOADER = '''# Jeju Atlas workshop: pinned Sonnet 4.6, explicit caller region.
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
LOADER = '''# Jeju Atlas workshop: Sonnet 4.6, explicit region and model authentication.
import os
import re

from strands.models.bedrock import BedrockModel

MODEL_ID = "global.anthropic.claude-sonnet-4-6"


def load_model() -> BedrockModel:
    region = os.environ.get("ATLAS_BEDROCK_REGION", "")
    if not re.fullmatch(r"[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+", region):
        raise ValueError("Set the organizer-verified ATLAS_BEDROCK_REGION")
    auth = os.environ.get("ATLAS_BEDROCK_AUTH", "iam")
    if auth == "api-key":
        parameter = os.environ.get("ATLAS_BEDROCK_API_KEY_SSM_ARN", "")
        if parameter and os.environ.get("ATLAS_BEDROCK_LOCAL_KEY") != "1":
            # Read again for each new Agent/session so a renewed key can be used.
            # Only the ARN is in deployment configuration, never the key value.
            import boto3
            match = re.fullmatch(r"arn:aws:ssm:([a-z0-9-]+):[0-9]{12}:parameter/jeju-atlas-lab-[a-z0-9]+/bedrock-api-key", parameter)
            if not match:
                raise ValueError("Use this participant's Bedrock SSM parameter ARN")
            token = boto3.client("ssm", region_name=match[1]).get_parameter(
                Name=parameter, WithDecryption=True,
            )["Parameter"]["Value"]
        else:
            token = os.environ.get("AWS_BEARER_TOKEN_BEDROCK", "")
        if not token:
            raise ValueError("Bedrock API key is missing; configure/publish it without IAM fallback")
        os.environ["AWS_BEARER_TOKEN_BEDROCK"] = token
    elif auth != "iam":
        raise ValueError("Unsupported ATLAS_BEDROCK_AUTH")
    elif os.environ.get("AWS_BEARER_TOKEN_BEDROCK"):
        raise ValueError("IAM mode must not inherit a Bedrock bearer key")
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
    if text in (LOADER, LEGACY_LOADER):
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


def configure(project, region=None, *, env_file=None, key_parameter_arn=None, policy_arn=None):
    project, spec, runtime = runtime_spec(project)
    loader = safe_path(project / "app/JejuGuide/model/load.py")
    if not loader.is_file() or not generated_loader(loader.read_text()):
        raise ValueError("Preserve the custom model/load.py; review it and apply the pinned loader manually")
    env = runtime.get("envVars", [])
    if any(item["name"] == "AWS_BEARER_TOKEN_BEDROCK" for item in env):
        raise ValueError("Remove the raw key from Runtime envVars; publish an SSM ARN instead")
    auth = next((item["value"] for item in env if item["name"] == "ATLAS_BEDROCK_AUTH"), "iam")
    if env_file is not None:
        from workshop_env import model_values, read_env
        path = safe_path(env_file)
        if path.is_relative_to(project / "app/JejuGuide"):
            raise ValueError("Keep .env outside the Runtime codeLocation so it cannot enter the deployment ZIP")
        settings = model_values(read_env(path))
        if region is not None and caller_region(region) != settings[REGION_ENV]:
            raise ValueError("The caller region must match the key's issuing region in .env")
        region, auth = settings[REGION_ENV], "api-key"
    if key_parameter_arn is not None:
        match = re.fullmatch(
            r"arn:aws:ssm:ap-northeast-2:(\d{12}):parameter/jeju-atlas-lab-[a-z0-9]+/bedrock-api-key",
            key_parameter_arn,
        )
        if not match or policy_arn != f"arn:aws:iam::{match[1]}:policy/jeju-atlas/{spec['name']}-bedrock-key":
            raise ValueError("Use the participant's matching SSM parameter and scoped IAM policy")
        auth = "api-key"
    current = next((item["value"] for item in env if item["name"] == REGION_ENV), "")
    selected = caller_region(region) if region is not None else caller_region(current) if current else None
    runtime["envVars"] = [item for item in env if item["name"] not in {REGION_ENV, "ATLAS_BEDROCK_AUTH"}]
    if selected:
        runtime["envVars"].append({"name": REGION_ENV, "value": selected})
    runtime["envVars"].append({"name": "ATLAS_BEDROCK_AUTH", "value": auth})
    if key_parameter_arn is not None:
        runtime["envVars"] = [item for item in runtime["envVars"]
                              if item["name"] != "ATLAS_BEDROCK_API_KEY_SSM_ARN"]
        runtime["envVars"].append({"name": "ATLAS_BEDROCK_API_KEY_SSM_ARN", "value": key_parameter_arn})
        policies = runtime.setdefault("additionalPolicies", [])
        if not isinstance(policies, list) or any(not isinstance(item, str) for item in policies):
            raise ValueError("Review existing additionalPolicies before binding the key policy")
        if policy_arn not in policies:
            policies.append(policy_arn)
    python_file = safe_path(project / "app/JejuGuide/.python-version")
    if python_file.exists() and python_file.read_text().strip() not in {"3.12", "3.14"}:
        raise ValueError("Preserve the custom .python-version and align it with Python 3.12")
    pyproject = safe_path(project / "app/JejuGuide/pyproject.toml")
    package_text = pyproject.read_text() if pyproject.exists() else None
    if package_text is not None:
        package_text, replacements = re.subn(
            r'(?m)^requires-python\s*=\s*"(?:>=3\.10|>=3\.12(?:,<3\.13)?)"\s*$',
            'requires-python = ">=3.12,<3.13"', package_text,
        )
        if replacements != 1:
            raise ValueError("Review custom pyproject.toml; the workshop uses requires-python >=3.12,<3.13")
    runtime["runtimeVersion"] = "PYTHON_3_12"
    # Preserve custom code, deployment targets and unrelated Runtime variables.
    loader.write_text(LOADER)
    python_file.write_text("3.12\n")
    if package_text is not None:
        pyproject.write_text(package_text)
    (project / "agentcore/agentcore.json").write_text(json.dumps(spec, ensure_ascii=False, indent=2) + "\n")
    return {"modelId": MODEL_ID, "callerRegion": selected, "deploymentRegion": DEPLOYMENT_REGION,
            "authMode": auth, "runtimePython": "3.12", "keyDeliveryConfigured": bool(key_parameter_arn),
            "configurationComplete": bool(selected), "readyForInvocation": False,
            "modelAccessVerified": False, "requiresRealModelCheck": True}


def check_model(project, spec=None):
    project, actual, runtime = runtime_spec(project)
    if spec is not None and actual != spec:
        raise ValueError("Runtime configuration changed during model inspection")
    if (project / "app/JejuGuide/model/load.py").read_text() != LOADER:
        raise ValueError("Configure the pinned Sonnet 4.6 loader before the local Runtime check")
    if any(item["name"] == "AWS_BEARER_TOKEN_BEDROCK" for item in runtime.get("envVars", [])):
        raise ValueError("Raw API keys must not be stored in Runtime configuration")
    region = next((item["value"] for item in runtime.get("envVars", []) if item["name"] == REGION_ENV), "")
    auth = next((item["value"] for item in runtime.get("envVars", [])
                 if item["name"] == "ATLAS_BEDROCK_AUTH"), "iam")
    if auth not in {"api-key", "iam"}:
        raise ValueError("Select api-key or iam model authentication explicitly")
    return {"modelId": MODEL_ID, "callerRegion": caller_region(region),
            "authMode": auth, "modelAccessVerified": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--caller-region", help="Only a caller region explicitly verified by the organizer")
    parser.add_argument("--env-file", type=Path, help="Private .env outside Runtime codeLocation")
    parser.add_argument("--check", action="store_true", help="Read local model configuration only")
    args = parser.parse_args()
    try:
        result = check_model(args.project) if args.check else configure(
            args.project, args.caller_region, env_file=args.env_file,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (OSError, ValueError, KeyError, TypeError) as error:
        print("Workshop model configuration: " + str(error), file=sys.stderr)
        raise SystemExit(2) from None


if __name__ == "__main__":
    main()
