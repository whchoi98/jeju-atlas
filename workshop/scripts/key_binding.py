"""Publish a participant key to SSM and bind a narrowly scoped Runtime policy."""
import json
from pathlib import Path
from urllib.parse import unquote

from core import check_session, read_account, read_json, safe_path
from model_config import configure, runtime_spec
from workshop_env import model_values, read_env


def context(project):
    project = safe_path(project)
    owner = read_json(project.parent / ".owner.json")
    repo = safe_path(owner.get("repo", ""))
    participant, name = owner.get("participant", ""), owner.get("project", "")
    _, _, destination, _ = check_session(repo, participant, name)
    if project != destination:
        raise ValueError("Use the owned participant CLI project")
    account = read_account(repo, participant, name)
    if not account:
        raise ValueError("Initialize and confirm the participant's EC2 account first")
    targets = read_json(project / "agentcore/aws-targets.json")
    if targets != [{"name": "default", "account": account, "region": "ap-northeast-2"}]:
        raise ValueError("The sole default target must match the saved participant account and Seoul")
    spec = read_json(project / "agentcore/agentcore.json")
    if spec.get("name") != name:
        raise ValueError("Project name does not match the participant session")
    parameter = f"/jeju-atlas-lab-{participant}/bedrock-api-key"
    return {
        "project": name, "participant": participant, "account": account,
        "region": "ap-northeast-2", "parameterName": parameter,
        "parameterArn": f"arn:aws:ssm:ap-northeast-2:{account}:parameter{parameter}",
        "policyName": f"{name}-bedrock-key",
        "policyArn": f"arn:aws:iam::{account}:policy/jeju-atlas/{name}-bedrock-key",
    }, spec


def tags(info):
    return [{"Key": "jeju-atlas:participant", "Value": info["participant"]},
            {"Key": "jeju-atlas:project", "Value": info["project"]},
            {"Key": "jeju-atlas:purpose", "Value": "workshop-bedrock-key"}]


def policy(info):
    return {"Version": "2012-10-17", "Statement": [{
        "Effect": "Allow", "Action": ["ssm:GetParameter"], "Resource": info["parameterArn"],
    }]}


def client_for(service):
    import boto3
    from botocore.config import Config
    return boto3.client(service, region_name="ap-northeast-2", config=Config(
        connect_timeout=5, read_timeout=30, retries={"total_max_attempts": 1},
    ))


def call(operation, *, missing=None, **kwargs):
    try:
        return operation(**kwargs)
    except Exception as error:
        code = getattr(error, "response", {}).get("Error", {}).get("Code", type(error).__name__)
        if missing and code == missing:
            return None
        # AWS error text can repeat request input. Only expose a service error code.
        raise ValueError(f"AWS {operation.__name__} failed ({code}); no key values are displayed") from None


def require_tags(observed, info):
    values = {item["Key"]: item["Value"] for item in observed}
    if any(values.get(item["Key"]) != item["Value"] for item in tags(info)):
        raise ValueError("Existing resource is not tagged for this participant/project; preserve it")


def inspect_resources(info, factory):
    if call(factory("sts").get_caller_identity).get("Account") != info["account"]:
        raise ValueError("Current AWS account differs from the saved participant account")
    iam, ssm = factory("iam"), factory("ssm")
    found_policy = call(iam.get_policy, missing="NoSuchEntity", PolicyArn=info["policyArn"])
    if found_policy:
        observed = call(iam.list_policy_tags, PolicyArn=info["policyArn"])
        if observed.get("IsTruncated"):
            raise ValueError("Review unexpectedly paginated policy tags before reuse")
        require_tags(observed["Tags"], info)
        version = call(iam.get_policy_version, PolicyArn=info["policyArn"],
                       VersionId=found_policy["Policy"]["DefaultVersionId"])
        document = version["PolicyVersion"]["Document"]
        if isinstance(document, str):
            document = json.loads(unquote(document))
        if document != policy(info):
            raise ValueError("Preserve the modified policy; only the single-parameter policy can be reused")
    found_parameter = call(ssm.describe_parameters, ParameterFilters=[
        {"Key": "Name", "Option": "Equals", "Values": [info["parameterName"]]},
    ])
    if found_parameter.get("NextToken"):
        raise ValueError("Review unexpected parameter pagination before reuse")
    parameters = found_parameter.get("Parameters", [])
    if parameters:
        if len(parameters) != 1 or parameters[0]["Name"] != info["parameterName"]:
            raise ValueError("Unexpected parameter lookup result")
        observed = call(ssm.list_tags_for_resource, ResourceType="Parameter", ResourceId=info["parameterName"])
        require_tags(observed["TagList"], info)
    return iam, ssm, bool(found_policy), parameters[0] if parameters else None


def publish(project, env_file, *, execute=False, client_factory=client_for):
    info, _ = context(project)
    # Planning is local, needs no key and must not initialize an AWS client.
    result = {**info, "operation": "publish-bedrock-key", "executed": False,
              "modelAccessVerified": False, "runtimeDeployed": False}
    if not execute:
        return result
    runtime_spec(project)
    if Path(env_file).absolute().is_relative_to(Path(project) / "app/JejuGuide"):
        raise ValueError("Keep .env outside Runtime source before publishing")
    values = model_values(read_env(env_file))
    size = len(values["AWS_BEARER_TOKEN_BEDROCK"].encode("utf-8"))
    if size > 8192:
        raise ValueError("Key exceeds the SSM parameter size limit")
    iam, ssm, policy_exists, parameter = inspect_resources(info, client_factory)
    parameter_exists = parameter is not None
    # Validate and prepare every local file before the first cloud mutation.
    configure(project, env_file=env_file, key_parameter_arn=info["parameterArn"], policy_arn=info["policyArn"])
    if not policy_exists:
        call(iam.create_policy, PolicyName=info["policyName"], Path="/jeju-atlas/",
             PolicyDocument=json.dumps(policy(info)), Tags=tags(info),
             Description="Read only this Jeju Atlas workshop participant's Bedrock API key")
    options = {
        "Name": info["parameterName"], "Value": values["AWS_BEARER_TOKEN_BEDROCK"],
        "Type": "SecureString", "Overwrite": parameter_exists,
        # Parameter Store permits upgrades, but cannot downgrade an existing
        # Advanced parameter when a renewed short-term token happens to shrink.
        "Tier": "Advanced" if size > 4096 or (parameter and parameter.get("Tier") == "Advanced") else "Standard",
    }
    if not parameter_exists:
        options["Tags"] = tags(info)
    response = call(ssm.put_parameter, **options)
    return {**result, "executed": True, "parameterVersion": response["Version"],
            "parameterTier": options["Tier"], "callerRegion": values["ATLAS_BEDROCK_REGION"],
            "next": "Validate and deploy this CLI project, then verify a new Runtime session"}


def cleanup(project, env_file=None, *, execute=False, client_factory=client_for):
    info, spec = context(project)
    result = {**info, "operation": "delete-owned-bedrock-key", "executed": False}
    if not execute:
        return result
    if any(item.get("name") == "JejuGuide" for item in spec.get("runtimes", [])):
        raise ValueError("Remove JejuGuide and deploy its removal before cleaning up the key")
    iam, ssm, policy_exists, parameter = inspect_resources(info, client_factory)
    parameter_exists = parameter is not None
    if policy_exists:
        entities = call(iam.list_entities_for_policy, PolicyArn=info["policyArn"])
        if (entities.get("IsTruncated") or any(entities.get(kind)
                for kind in ("PolicyRoles", "PolicyUsers", "PolicyGroups"))):
            raise ValueError("The key policy is still attached; finish Runtime/role removal first")
        call(iam.delete_policy, PolicyArn=info["policyArn"])
    if parameter_exists:
        call(ssm.delete_parameter, Name=info["parameterName"])
    # Do not delete .env, shared bootstrap, network resources or another project.
    return {**result, "executed": True, "policyRemoved": policy_exists,
            "parameterRemoved": parameter_exists, "localEnvPreserved": True}
