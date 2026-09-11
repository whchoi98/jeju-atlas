#!/usr/bin/env python3
"""Check the synthesized CloudFormation boundary without contacting AWS."""

import argparse
import json
from pathlib import Path


def require(condition, message):
    if not condition:
        raise ValueError(message)


def check(template, owner, expect_empty=False):
    resources = template.get("Resources", {})
    allowed_types = {
        "AWS::BedrockAgentCore::Runtime", "AWS::IAM::Role", "AWS::IAM::Policy",
    }
    require(all(r["Type"] in allowed_types for r in resources.values()),
            "unexpected resource type: this module owns only a Runtime and its IAM role/policy")
    if expect_empty:
        require(not resources, "cleanup synthesis still contains owned resources")
        return {"runtimeCount": 0, "resourceCount": 0, "modelPermissions": 0}

    runtimes = {k: r for k, r in resources.items() if r["Type"] == "AWS::BedrockAgentCore::Runtime"}
    roles = {k: r for k, r in resources.items() if r["Type"] == "AWS::IAM::Role"}
    policies = {k: r for k, r in resources.items() if r["Type"] == "AWS::IAM::Policy"}
    require(len(runtimes) == len(roles) == len(policies) == 1, "expected one Runtime, role and policy")
    runtime = next(iter(runtimes.values()))
    props = runtime["Properties"]
    require(props["AgentRuntimeName"] == owner["projectName"] + "_Warmup", "unowned runtime name")
    require(props["NetworkConfiguration"] == {"NetworkMode": "PUBLIC"}, "unexpected networking")
    require(props.get("ProtocolConfiguration", "HTTP") == "HTTP", "unexpected protocol")
    require(not props.get("AuthorizerConfiguration"), "warmup must use IAM inbound authorization")
    code = props["AgentRuntimeArtifact"].get("CodeConfiguration", {})
    require(code.get("Runtime") == "PYTHON_3_14", "expected Python 3.14 CodeZip")
    require(code.get("EntryPoint") == ["main.py"], "unexpected entrypoint or instrumentation wrapper")
    env = props.get("EnvironmentVariables", {})
    require(env.get("OTEL_SDK_DISABLED") == "true", "telemetry must be disabled")
    require(env.get("OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT") == "false",
            "prompt-content capture must be disabled")
    require(props.get("LifecycleConfiguration") == {
        "IdleRuntimeSessionTimeout": 300, "MaxLifetime": 600,
    }, "unexpected runtime lifetime")

    role_id, role = next(iter(roles.items()))
    policy_id, policy = next(iter(policies.items()))
    require(props["RoleArn"] == {"Fn::GetAtt": [role_id, "Arn"]}, "role must belong to this stack")
    require(not role["Properties"].get("ManagedPolicyArns"), "no unreviewed managed policies")
    require(not role["Properties"].get("Policies"), "no unreviewed inline role policies")
    require(policy["Properties"]["Roles"] == [{"Ref": role_id}], "policy must attach to owned role")
    require({role_id, policy_id}.issubset(set(runtime.get("DependsOn", []))),
            "Runtime must wait for its owned role and log policy")
    trust = role["Properties"]["AssumeRolePolicyDocument"]["Statement"]
    require(len(trust) == 1 and trust[0]["Principal"] == {
        "Service": "bedrock-agentcore.amazonaws.com",
    }, "unexpected trust principal")
    require(trust[0]["Condition"]["StringEquals"]["aws:SourceAccount"] == owner["accountId"],
            "trust must be restricted to the participant account")

    group = (
        "arn:aws:logs:{region}:{account}:log-group:"
        "/aws/bedrock-agentcore/runtimes/{project}_Warmup-*"
    ).format(region=owner["region"], account=owner["accountId"], project=owner["projectName"])
    expected_resources = {
        "logs:DescribeLogGroups": "*",
        "logs:CreateLogGroup": group,
        "logs:DescribeLogStreams": group,
        "logs:CreateLogStream": group + ":log-stream:*",
        "logs:PutLogEvents": group + ":log-stream:*",
    }
    seen = set()
    for statement in policy["Properties"]["PolicyDocument"]["Statement"]:
        require(statement["Effect"] == "Allow", "unexpected policy effect")
        require(not ({"NotAction", "NotResource"} & statement.keys()), "inverted policy is forbidden")
        actions = statement["Action"]
        actions = [actions] if isinstance(actions, str) else actions
        arns = statement["Resource"]
        arns = [arns] if isinstance(arns, str) else arns
        for action in actions:
            require(action in expected_resources, "unexpected IAM action: " + action)
            require(arns == [expected_resources[action]], "unowned log permission: " + action)
            seen.add(action)
    require(seen == expected_resources.keys(), "missing log permissions")
    return {"runtimeCount": 1, "resourceCount": len(resources), "modelPermissions": 0}


def main():
    root = Path(__file__).resolve().parent.parent
    owner = json.loads((root / ".atlas-cli-workshop.json").read_text(encoding="utf-8"))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "template", nargs="?", type=Path,
        default=root / "agentcore/cdk/cdk.out" / (owner["stackName"] + ".template.json"),
    )
    parser.add_argument("--expect-empty", action="store_true")
    args = parser.parse_args()
    try:
        result = check(json.loads(args.template.read_text(encoding="utf-8")), owner, args.expect_empty)
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.error(str(error))
    print(json.dumps({"success": True, **result, "deployed": False}))


if __name__ == "__main__":
    main()
