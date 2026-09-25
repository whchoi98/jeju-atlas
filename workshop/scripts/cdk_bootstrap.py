#!/usr/bin/env python3
"""Read-only CDK bootstrap preflight for the Seoul AgentCore course."""
import argparse
import json
import os
import re

REGION = "ap-northeast-2"
STACK = "CDKToolkit"
PARAMETER = "/cdk-bootstrap/hnb659fds/version"
MINIMUM_VERSION = 30  # Required by the course's @aws/agentcore 0.28.1.
READY_STACK_STATES = {
    "CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE",
}
STACK_STATES = READY_STACK_STATES | {
    "CREATE_IN_PROGRESS", "CREATE_FAILED",
    "ROLLBACK_IN_PROGRESS", "ROLLBACK_FAILED", "ROLLBACK_COMPLETE",
    "DELETE_IN_PROGRESS", "DELETE_FAILED", "DELETE_COMPLETE",
    "UPDATE_IN_PROGRESS", "UPDATE_FAILED", "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS",
    "UPDATE_ROLLBACK_IN_PROGRESS", "UPDATE_ROLLBACK_FAILED",
    "UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS",
    "REVIEW_IN_PROGRESS", "IMPORT_IN_PROGRESS", "IMPORT_COMPLETE",
    "IMPORT_ROLLBACK_IN_PROGRESS", "IMPORT_ROLLBACK_FAILED", "IMPORT_ROLLBACK_COMPLETE",
}


def client_for(service):
    """Import the helper SDK only when a read is needed, with bounded requests."""
    import boto3
    from botocore.config import Config
    return boto3.client(service, region_name=REGION, config=Config(
        connect_timeout=5, read_timeout=15,
        retries={"total_max_attempts": 1, "mode": "standard"},
    ))


def valid_account(value):
    return (isinstance(value, str) and re.fullmatch(r"[0-9]{12}", value) is not None
            and value != "000000000000")


def error_details(error):
    response = getattr(error, "response", None)
    details = response.get("Error") if isinstance(response, dict) else None
    return details if isinstance(details, dict) else {}


def stack_is_missing(error):
    details = error_details(error)
    message = details.get("Message")
    # ValidationError also covers other invalid requests. Only the
    # exact named-stack absence response establishes that bootstrap is missing.
    return (details.get("Code") == "ValidationError" and isinstance(message, str)
            and re.fullmatch(r"Stack (?:with id )?CDKToolkit does not exist\.?", message)
            is not None)


def failure(result, status, service, message):
    result.update(status=status, ready=False, error={"service": service, "message": message})
    return result


def request_failure(result, service, error):
    """Classify known failures without printing exception text or arbitrary codes."""
    code = error_details(error).get("Code")
    code = code if isinstance(code, str) else None
    name = type(error).__name__
    if code in {"AccessDenied", "AccessDeniedException", "UnauthorizedOperation",
                "AuthorizationError", "ForbiddenException"}:
        status = "access_denied"
        message = "AWS denied this read; verify the current role's permissions."
    elif isinstance(error, (TimeoutError, ConnectionError)) or name in {
            "ConnectTimeoutError", "ReadTimeoutError", "EndpointConnectionError",
            "ProxyConnectionError", "ConnectionClosedError", "SSLError",
            "HTTPClientError"} or code in {"RequestTimeout", "RequestTimeoutException"}:
        status = "network_error"
        message = "The AWS read failed because of a connection or timeout error."
    elif name in {
            "NoCredentialsError", "PartialCredentialsError", "CredentialRetrievalError",
            "SSOTokenLoadError", "UnauthorizedSSOTokenError", "TokenRetrievalError",
            "RefreshWithMFAUnsupportedError"} or code in {
            "ExpiredToken", "ExpiredTokenException", "InvalidClientTokenId",
            "UnrecognizedClientException", "InvalidSignatureException",
            "SignatureDoesNotMatch"}:
        status = "credentials_error"
        message = "AWS credentials could not be loaded or accepted."
    elif isinstance(error, ImportError):
        status = "sdk_unavailable"
        message = "Run with the helper Python environment containing boto3 and botocore."
    else:
        status = "error"
        message = "AWS client creation or read failed; raw error details are suppressed."
    return failure(result, status, service, message)


def numeric_version(value):
    if not isinstance(value, str) or re.fullmatch(r"[0-9]+", value) is None:
        raise ValueError("Invalid bootstrap version")
    return int(value)


def stack_metadata(response):
    stacks = response.get("Stacks") if isinstance(response, dict) else None
    if not isinstance(stacks, list) or len(stacks) != 1 or not isinstance(stacks[0], dict):
        raise ValueError("Invalid stack metadata")
    stack = stacks[0]
    status = stack.get("StackStatus")
    if (stack.get("StackName") != STACK or not isinstance(status, str)
            or status not in STACK_STATES):
        raise ValueError("Invalid stack identity or status")
    outputs = stack.get("Outputs", [])
    if not isinstance(outputs, list) or any(not isinstance(item, dict) for item in outputs):
        raise ValueError("Invalid stack outputs")
    versions = [item.get("OutputValue") for item in outputs
                if item.get("OutputKey") == "BootstrapVersion"]
    if len(versions) > 1 or (not versions and status in READY_STACK_STATES):
        raise ValueError("Missing or duplicated bootstrap output")
    # A stack still being created may not have outputs yet. Its lifecycle state
    # remains not-ready; an absent output never means that the stack is absent.
    return status, numeric_version(versions[0]) if versions else None


def parameter_version(response):
    parameter = response.get("Parameter") if isinstance(response, dict) else None
    if (not isinstance(parameter, dict) or parameter.get("Name") != PARAMETER
            or parameter.get("Type") != "String"):
        raise ValueError("Invalid bootstrap parameter metadata")
    return numeric_version(parameter.get("Value"))


def check(region=REGION, expected_account=None, *, client_factory=None):
    """Read STS first, then exactly CDKToolkit and its default version parameter."""
    result = {
        "account": None, "expectedAccount": None, "region": REGION,
        "stack": STACK, "parameter": PARAMETER, "minimumVersion": MINIMUM_VERSION,
        "stackExists": None, "parameterExists": None, "stackStatus": None,
        "stackVersion": None, "ssmVersion": None, "status": "error", "ready": False,
    }
    if region != REGION:
        return failure(result, "invalid_input", "configuration",
                       "This course checks only ap-northeast-2.")
    if expected_account is not None:
        if not valid_account(expected_account):
            return failure(result, "invalid_input", "configuration",
                           "Expected account must be a nonzero 12-digit ASCII account ID.")
        result["expectedAccount"] = expected_account
    factory = client_for if client_factory is None else client_factory

    try:
        identity = factory("sts").get_caller_identity()
    except Exception as error:
        return request_failure(result, "sts", error)
    account = identity.get("Account") if isinstance(identity, dict) else None
    if not valid_account(account):
        return failure(result, "invalid_metadata", "sts",
                       "STS did not return a valid nonzero 12-digit account ID.")
    result["account"] = account
    if expected_account is not None and account != expected_account:
        return failure(result, "account_mismatch", "sts",
                       "Current AWS account differs from the expected account; no resource reads ran.")

    # Construct resource clients only after identity and account agreement.
    try:
        response = factory("cloudformation").describe_stacks(StackName=STACK)
    except Exception as error:
        if not stack_is_missing(error):
            return request_failure(result, "cloudformation", error)
        result["stackExists"] = False
    else:
        try:
            status, version = stack_metadata(response)
        except ValueError:
            return failure(result, "invalid_metadata", "cloudformation",
                           "CDKToolkit returned invalid stack status or bootstrap version metadata.")
        result.update(stackExists=True, stackStatus=status, stackVersion=version)

    try:
        response = factory("ssm").get_parameter(Name=PARAMETER, WithDecryption=False)
    except Exception as error:
        if error_details(error).get("Code") != "ParameterNotFound":
            return request_failure(result, "ssm", error)
        result["parameterExists"] = False
    else:
        try:
            version = parameter_version(response)
        except ValueError:
            return failure(result, "invalid_metadata", "ssm",
                           "The default bootstrap parameter returned invalid version metadata.")
        result.update(parameterExists=True, ssmVersion=version)

    if not result["stackExists"] and not result["parameterExists"]:
        result["status"] = "missing"
    elif result["stackExists"] and result["stackStatus"] not in READY_STACK_STATES:
        result["status"] = "not_ready"
    elif not result["stackExists"] or not result["parameterExists"]:
        result["status"] = "inconsistent"
    elif result["stackVersion"] is not None and result["stackVersion"] != result["ssmVersion"]:
        result["status"] = "inconsistent"
    elif result["stackVersion"] < MINIMUM_VERSION:
        result["status"] = "outdated"
    else:
        result.update(status="ready", ready=True)
    return result


def main(argv=None, *, client_factory=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--region", default=REGION, choices=(REGION,),
                        help="Course deployment region; ignores AWS region environment defaults")
    parser.add_argument("--expected-account", default=os.environ.get("ATLAS_ACCOUNT") or None,
                        metavar="ACCOUNT", help="Required account match; defaults to nonempty ATLAS_ACCOUNT")
    parser.add_argument("--require-missing", action="store_true",
                        help="Succeed only when both bootstrap resources are absent; never create or upgrade")
    args = parser.parse_args(argv)
    result = check(args.region, args.expected_account, client_factory=client_factory)
    result["requireMissing"] = args.require_missing
    print(json.dumps(result, indent=2))
    accepted = result["status"] == "missing" if args.require_missing else result["ready"]
    return 0 if accepted else 1


if __name__ == "__main__":
    raise SystemExit(main())
