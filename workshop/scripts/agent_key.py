"""Bind the advanced Guide to the same private Bedrock key as chapter 04."""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile

from core import read_json, safe_path
from key_binding import inspect_resources, publish_resources, session_context
from lab_config import binding_digest, validate_config
from lab_workspace import read_template, replace_once, rewrite_text, verify_workspace
from model_config import MODEL_ID, caller_region
from workshop_env import model_values, private_path, read_env

FORMAT = "jeju-atlas-agent-key/v1"
LOADER = "agent/guide/model/load.py"
AUTH = "agent/guide/model/workshop_auth.py"
TEMPLATE = "infra/agentcore.yaml"
RECEIPT = ".local/workshop-agent-key.json"
RUNTIME_SOURCE = Path(__file__).resolve().parents[1] / "runtime/bedrock_auth.py"


def digest(value):
    return hashlib.sha256(value).hexdigest()


def regular(path, *, optional=False):
    path = safe_path(path)
    if not path.exists() and optional:
        return None
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 1024 * 1024:
        raise ValueError("Preserve and review non-regular or oversized workshop file: " + str(path))
    return path.read_bytes()


def context(repo, config, workspace):
    repo = safe_path(repo)
    config = validate_config(config, require_network=True)
    parent = safe_path(repo / "workshop/.local/labs" / config["participant"])
    workspace = safe_path(workspace)
    if workspace != parent / "app":
        raise ValueError("Use this participant's existing app workspace")
    # Check paths before the legacy verifier reads the files.
    for name in [".local/workshop-binding.json", "scripts/deploy.py",
                 "scripts/deploy-atlas-agent.py", LOADER, TEMPLATE]:
        regular(workspace / name)
    verify_workspace(config, workspace)
    owner = read_json(parent / ".owner.json")
    project = parent / owner.get("project", "")
    info = session_context(project)
    if (info["participant"] != config["participant"] or info["account"] != config["accountId"]
            or info["region"] != config["region"]):
        raise ValueError("The key session and app account/participant/region must match")
    return repo, workspace, info, parent / ".env"


def legacy_loader(repo, config, workspace):
    source = regular(repo / LOADER)
    binding = read_json(workspace / ".local/workshop-binding.json")
    if binding.get("sourceFiles", {}).get(LOADER) != digest(source):
        raise ValueError("Guide source version differs; preserve the existing loader and review its API-key integration")
    return replace_once(rewrite_text(source.decode("utf-8"), config), {
        'MODEL_ID = "global.openai.gpt-6-astra"': f'MODEL_ID = "{MODEL_ID}"',
        'BEDROCK_REGION = "ap-northeast-2"': 'BEDROCK_REGION = os.environ.get("ATLAS_BEDROCK_REGION", "")',
        '    resolved_id = model_id or MODEL_ID':
            '    if not BEDROCK_REGION:\n'
            '        raise ValueError("Configure the organizer-verified ATLAS_BEDROCK_REGION; no deployment-region fallback")\n'
            '    resolved_id = model_id or MODEL_ID',
    })


def api_loader(legacy):
    text = replace_once(legacy, {
        "import os\n": "import os\nimport threading\n\nfrom .workshop_auth import prepare_model_auth\n",
        'log = logging.getLogger(__name__)':
            'log = logging.getLogger(__name__)\n'
            '_WORKSHOP_MODEL_LOCK = threading.RLock()\n'
            '_WORKSHOP_AUTH_IDENTITY = None',
        "def load_model(model_id: str | None = None, *, thinking: str | None = None) -> BedrockModel:":
            "def _load_workshop_model(model_id: str | None = None, *, thinking: str | None = None) -> BedrockModel:",
        "Get a cached Bedrock model client using IAM credentials.":
            "Get a cached Bedrock model client using the private workshop API key.",
        "    if not BEDROCK_REGION:\n":
            "    global _WORKSHOP_AUTH_IDENTITY\n"
            "    auth_identity, auth_options = prepare_model_auth()\n"
            "    if auth_identity != _WORKSHOP_AUTH_IDENTITY:\n"
            "        _MODEL_CACHE.clear()\n"
            "        _WORKSHOP_AUTH_IDENTITY = auth_identity\n"
            "    if not BEDROCK_REGION:\n",
        '        if not is_openai:\n':
            '        kwargs.update(auth_options)\n'
            '        if not is_openai:\n',
    })
    return text + (
        "\n\ndef load_model(model_id: str | None = None, *, thinking: str | None = None) -> BedrockModel:\n"
        '    """Serialize key refresh and cache access across Guide request threads."""\n'
        "    with _WORKSHOP_MODEL_LOCK:\n"
        "        return _load_workshop_model(model_id, thinking=thinking)\n"
    )


def template_with_key(template, info):
    env = template["Resources"]["GuideRuntime"]["Properties"]["EnvironmentVariables"]
    if env.get("ATLAS_BEDROCK_REGION") != {"Ref": "BedrockCallerRegion"}:
        raise ValueError("Preserve and review the custom Guide caller-region configuration")
    if "AWS_BEARER_TOKEN_BEDROCK" in env:
        raise ValueError("Preserve and review the template containing a direct key; the workshop uses an SSM ARN only")
    arn = env.get("ATLAS_BEDROCK_API_KEY_SSM_ARN")
    if arn is not None and arn != info["parameterArn"]:
        raise ValueError("Guide already refers to a different key; preserve its configuration")
    auth = env.get("ATLAS_BEDROCK_AUTH")
    if auth not in (None, "iam", "api-key"):
        raise ValueError("Guide has a custom model authentication mode; preserve it")
    env.update(ATLAS_BEDROCK_AUTH="api-key", ATLAS_BEDROCK_API_KEY_SSM_ARN=info["parameterArn"])
    role = template["Resources"]["GuideRole"]["Properties"]
    policies = role.setdefault("ManagedPolicyArns", [])
    if not isinstance(policies, list) or policies.count(info["policyArn"]) > 1:
        raise ValueError("Review the existing Guide managed-policy configuration")
    if info["policyArn"] not in policies:
        policies.append(info["policyArn"])
    return (json.dumps(template, ensure_ascii=False, indent=2) + "\n").encode()


def planned_files(repo, config, workspace, info):
    legacy = legacy_loader(repo, config, workspace)
    updated = api_loader(legacy).encode()
    current = regular(workspace / LOADER)
    receipt_data = regular(workspace / RECEIPT, optional=True)
    receipt = json.loads(receipt_data) if receipt_data else None
    if receipt:
        if (receipt.get("format") != FORMAT or receipt.get("bindingDigest") != binding_digest(config)
                or receipt.get("parameterArn") != info["parameterArn"]
                or receipt.get("policyArn") != info["policyArn"]):
            raise ValueError("Preserve an unrelated or invalid Guide API-key receipt")
        if digest(current) != receipt.get("files", {}).get(LOADER):
            raise ValueError("Guide loader changed after key setup; preserve and review the edits")
    elif current != legacy.encode():
        raise ValueError("Guide loader has participant edits; preserve them and integrate the API-key helper explicitly")
    auth = regular(workspace / AUTH, optional=True)
    if auth is not None and (not receipt or digest(auth) != receipt.get("files", {}).get(AUTH)):
        raise ValueError("Preserve the existing custom Guide authentication helper")
    return {
        LOADER: updated,
        AUTH: regular(RUNTIME_SOURCE),
        TEMPLATE: template_with_key(read_template(workspace / TEMPLATE), info),
    }


def replace_files(workspace, contents, originals):
    """Keep a private backup and roll back ordinary local write failures."""
    for name, old in originals.items():
        if regular(workspace / name, optional=True) != old:
            raise ValueError("Guide files changed during key setup; preserve the newer edits and retry after review")
    changed = [name for name, data in contents.items() if originals[name] != data]
    if not changed:
        return [], None
    local = safe_path(workspace / ".local")
    stage = Path(tempfile.mkdtemp(prefix="agent-key-backup-", dir=local))
    stage.chmod(0o700)
    replaced = []
    try:
        for index, name in enumerate(changed):
            old = originals[name]
            mode = (workspace / name).stat().st_mode & 0o777 if old is not None else 0o644
            if old is not None:
                backup = stage / (str(index) + ".before")
                backup.write_bytes(old)
                backup.chmod(0o600)
            prepared = stage / (str(index) + ".after")
            prepared.write_bytes(contents[name])
            prepared.chmod(0o600 if name.startswith(".local/") else mode)
        for name, old in originals.items():
            if regular(workspace / name, optional=True) != old:
                raise ValueError("Guide files changed during key setup; no local update was applied")
        for index, name in enumerate(changed):
            os.replace(stage / (str(index) + ".after"), workspace / name)
            replaced.append((index, name))
    except BaseException:
        for index, name in reversed(replaced):
            if originals[name] is None:
                (workspace / name).unlink()
            else:
                mode = stat.S_IMODE((workspace / name).stat().st_mode)
                os.replace(stage / (str(index) + ".before"), workspace / name)
                (workspace / name).chmod(mode)
        raise
    return changed, str(stage)


def configure(repo, config, workspace, *, env_file=None, execute=False, client_factory=None):
    repo, workspace, info, initial_env = context(repo, config, workspace)
    env_file = private_path(env_file or initial_env)
    if env_file != initial_env:
        raise ValueError("Reuse the initial participant .env outside the app workspace")
    originals = {name: regular(workspace / name, optional=True) for name in [LOADER, AUTH, TEMPLATE, RECEIPT]}
    contents = planned_files(repo, config, workspace, info)
    updates = [name for name, data in contents.items() if regular(workspace / name, optional=True) != data]
    result = {
        **info, "operation": "configure-guide-api-key", "envFile": str(env_file),
        "workspace": str(workspace), "executed": False, "runtimeDeployed": False,
        "modelAccessVerified": False, "updatedFiles": [], "plannedFiles": updates,
    }
    if not execute:
        return result
    values = model_values(read_env(env_file))
    region = caller_region(config.get("bedrockCallerRegion", ""))
    if region != "ap-northeast-2":
        raise ValueError("Chapter 06 uses ap-northeast-2; confirm the initial API key's Seoul model region")
    if values["ATLAS_BEDROCK_REGION"] != region:
        raise ValueError("Initial .env model region differs from the advanced caller region; confirm the intended region before changing it")
    if len(values["AWS_BEARER_TOKEN_BEDROCK"].encode()) > 8192:
        raise ValueError("Key exceeds the SSM parameter size limit")
    if client_factory is None:
        raise ValueError("Use lab.py agent-key with the verified participant AWS session")
    inspected = inspect_resources(info, client_factory)
    for name, old in originals.items():
        if regular(workspace / name, optional=True) != old:
            raise ValueError("Guide files changed during key setup; no key was published")
    publication = publish_resources(info, values, inspected)
    receipt = {
        "format": FORMAT, "bindingDigest": binding_digest(config),
        "parameterArn": info["parameterArn"], "policyArn": info["policyArn"],
        "callerRegion": region, **publication,
        "configuredAt": datetime.now(timezone.utc).isoformat(),
        "files": {name: digest(data) for name, data in contents.items()},
    }
    changed, backup = replace_files(workspace, {
        **contents, RECEIPT: (json.dumps(receipt, indent=2) + "\n").encode(),
    }, originals)
    return {
        **result, **publication, "executed": True, "callerRegion": region,
        "updatedFiles": [name for name in changed if name != RECEIPT],
        "backupPath": backup,
        "next": "Build/publish the changed Guide, review agent-plan, then agent-apply and agent-status",
    }


def require_binding(repo, config, workspace):
    _, workspace, info, _ = context(repo, config, workspace)
    receipt_data = regular(workspace / RECEIPT, optional=True)
    if receipt_data is None:
        raise ValueError("Run lab.py agent-key --config \"$ATLAS_CONFIG\" --execute to bind the initial API key before building or deploying the Guide")
    receipt = json.loads(receipt_data)
    if (receipt.get("format") != FORMAT or receipt.get("bindingDigest") != binding_digest(config)
            or receipt.get("parameterArn") != info["parameterArn"] or receipt.get("policyArn") != info["policyArn"]
            or receipt.get("callerRegion") != "ap-northeast-2"
            or receipt.get("callerRegion") != caller_region(config.get("bedrockCallerRegion", ""))):
        raise ValueError("Guide API-key binding differs from this participant configuration")
    for name in [LOADER, AUTH]:
        if digest(regular(workspace / name)) != receipt.get("files", {}).get(name):
            raise ValueError("Guide authentication code changed; preserve and review its API-key integration")
    template = read_template(workspace / TEMPLATE)
    env = template["Resources"]["GuideRuntime"]["Properties"]["EnvironmentVariables"]
    policies = template["Resources"]["GuideRole"]["Properties"].get("ManagedPolicyArns", [])
    if (env.get("ATLAS_BEDROCK_AUTH") != "api-key"
            or env.get("ATLAS_BEDROCK_API_KEY_SSM_ARN") != info["parameterArn"]
            or env.get("ATLAS_BEDROCK_REGION") != {"Ref": "BedrockCallerRegion"}
            or "AWS_BEARER_TOKEN_BEDROCK" in env
            or not isinstance(policies, list) or policies.count(info["policyArn"]) != 1):
        raise ValueError("Guide must use its shared API-key ARN and single-parameter policy")
    return {"authMode": "api-key", "parameterArn": info["parameterArn"], "modelAccessVerified": False}
