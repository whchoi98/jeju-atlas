#!/usr/bin/env python3
"""Explicit, one-attempt Sonnet 4.6 Converse check; never part of doctor/build."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sys
import time

from core import ROOT, safe_path
from model_config import DEPLOYMENT_REGION, MODEL_ID, caller_region

PROMPT = "Reply with exactly OK."
MAX_TOKENS = 16


def client_for(region):
    import boto3
    from botocore.config import Config
    return boto3.client("bedrock-runtime", region_name=region, config=Config(
        connect_timeout=5, read_timeout=30, retries={"total_max_attempts": 1, "mode": "standard"},
    ))


def redact(value, secret=None):
    value = str(value)
    if secret:
        value = value.replace(secret, "[redacted-key]")
    value = re.sub(r"arn:[^\s\"'<>]+", "[redacted-arn]", value)
    value = re.sub(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b", "[redacted-key-id]", value)
    value = re.sub(r"\b\d{12}\b", "[redacted-account]", value)
    value = re.sub(r"\bip-(?:\d{1,3}-){3}\d{1,3}\b", "[redacted-host]", value)
    return value[:600]


@contextmanager
def authentication(api_key):
    """Keep model authentication separate from the coding CLI and AWS control plane."""
    name = "AWS_BEARER_TOKEN_BEDROCK"
    previous = os.environ.pop(name, None)
    if api_key is not None:
        os.environ[name] = api_key
    try:
        yield
    finally:
        os.environ.pop(name, None)
        if previous is not None:
            os.environ[name] = previous


def report_path(path):
    path = safe_path(path)
    if path.exists():
        raise ValueError("Use a fresh report filename; keep the previous real result")
    if path.is_relative_to(ROOT) and not (
            path.is_relative_to(ROOT / "workshop/.local") or path.is_relative_to(ROOT / ".local")):
        raise ValueError("Keep invocation reports under ignored .local storage, never in published source or site")
    return path


def check(region, output, *, execute=False, client_factory=client_for, api_key=None):
    region = caller_region(region)
    if api_key is not None and (not api_key or any(char.isspace() for char in api_key)):
        raise ValueError("A nonempty Bedrock API key is required for api-key mode")
    output = report_path(output)
    result = {
        "operation": "Converse", "modelId": MODEL_ID, "callerRegion": region,
        "deploymentRegion": DEPLOYMENT_REGION, "prompt": PROMPT, "maxTokens": MAX_TOKENS,
        "authMode": "api-key" if api_key is not None else "iam",
        "executed": False, "apiAttempted": False, "modelResponseReceived": False,
        "passed": False, "response": None,
    }
    if not execute:
        return {**result, "status": "planned", "next": "Run on the participant EC2 with --execute after organizer confirmation"}
    output.parent.mkdir(parents=True, exist_ok=True)
    # Reserve the report before any call so an accidental repeat cannot call the
    # model again and overwrite the earlier result.
    result.update(executed=True, status="started", startedAt=datetime.now(timezone.utc).isoformat())
    with output.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    output.chmod(0o600)
    started = time.monotonic()
    try:
        with authentication(api_key):
            client = client_factory(region)
            result["apiAttempted"] = True
            response = client.converse(
                modelId=MODEL_ID,
                messages=[{"role": "user", "content": [{"text": PROMPT}]}],
                inferenceConfig={"maxTokens": MAX_TOKENS},
            )
        blocks = response.get("output", {}).get("message", {}).get("content", [])
        text = "".join(item["text"] for item in blocks if isinstance(item, dict) and isinstance(item.get("text"), str)).strip()
        result["response"] = redact(text, api_key)
        result["modelResponseReceived"] = bool(text)
        result["stopReason"] = response.get("stopReason")
        result["usage"] = {key: value for key, value in response.get("usage", {}).items()
                           if key in {"inputTokens", "outputTokens", "totalTokens"} and type(value) is int}
        result["passed"] = text == "OK" and result["stopReason"] == "end_turn"
        result["status"] = "passed" if result["passed"] else "unexpected_response"
    except Exception as error:
        info = getattr(error, "response", {})
        details = info.get("Error", {}) if isinstance(info, dict) else {}
        code = details.get("Code", type(error).__name__)
        message = str(details.get("Message", str(error)))
        scp = ("explicit deny" in message.lower()
               and ("service control policy" in message.lower() or re.search(r"\bSCP\b", message, re.I)))
        result.update(status="failed", passed=False, error={
            "code": redact(code, api_key), "message": redact(message, api_key),
            "classification": "scp_explicit_deny" if code == "AccessDeniedException" and scp else "request_failed",
        })
    result["elapsedMs"] = round((time.monotonic() - started) * 1000)
    result["finishedAt"] = datetime.now(timezone.utc).isoformat()
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--caller-region", help="Explicit organizer-verified Bedrock endpoint region")
    parser.add_argument("--env-file", type=Path, help="Use the private .env key and its issuing region")
    parser.add_argument("--report", type=Path, required=True, help="Fresh ignored .local JSON report filename")
    parser.add_argument("--execute", action="store_true", help="Make one real, potentially billable Converse request")
    args = parser.parse_args()
    try:
        region, api_key = args.caller_region, None
        if args.env_file is not None:
            from workshop_env import model_values, read_env
            values = model_values(read_env(args.env_file))
            if region is not None and region != values["ATLAS_BEDROCK_REGION"]:
                raise ValueError("Caller region differs from the API key's issuing region in .env")
            region, api_key = values["ATLAS_BEDROCK_REGION"], values["AWS_BEARER_TOKEN_BEDROCK"]
        result = check(region, args.report, execute=args.execute, api_key=api_key)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if args.execute and not result["passed"]:
            raise SystemExit(1)
    except (OSError, ValueError) as error:
        print("Workshop model check: " + redact(error), file=sys.stderr)
        raise SystemExit(2) from None


if __name__ == "__main__":
    main()
