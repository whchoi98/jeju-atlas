"""CloudFront-only workshop boundaries; safe to copy into participant scripts."""
import re
from urllib.parse import urlsplit


def require_default_settings(settings):
    if not isinstance(settings, dict):
        raise ValueError("Workshop settings must be an object")
    for key in ("ViewerDomainName", "ViewerCertificateArn", "OriginDomainName",
                "OriginCertificateArn", "OriginHostFunctionVersionArn"):
        if settings.get(key, "") != "":
            raise ValueError("Use the CloudFront default domain; do not configure " + key)
    if settings.get("OriginTlsEnabled", "false") != "false":
        raise ValueError("The workshop uses CloudFront viewer HTTPS and the existing HTTP ALB origin")


def cloudfront_origin(value):
    if not isinstance(value, str):
        raise ValueError("CloudFrontUrl is missing from the participant stack outputs")
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or not re.fullmatch(r"d[a-z0-9]+\.cloudfront\.net", parsed.netloc)
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise ValueError("Expected the stack's default https://d....cloudfront.net root URL")
    return value.rstrip("/")


def cloudfront_url(outputs):
    if not isinstance(outputs, dict):
        raise ValueError("Read the participant App stack outputs first")
    url = cloudfront_origin(outputs.get("CloudFrontUrl"))
    if outputs.get("ApplicationUrl", "").rstrip("/") != url:
        raise ValueError("ApplicationUrl must equal CloudFrontUrl; custom-domain stacks are outside this workshop")
    if not re.fullmatch(r"[A-Z0-9]+", str(outputs.get("DistributionId", ""))):
        raise ValueError("DistributionId is missing from the participant App stack outputs")
    return url


def require_default_viewer(distribution, outputs):
    url = cloudfront_url(outputs)
    config = distribution.get("DistributionConfig", {})
    certificate = config.get("ViewerCertificate", {})
    aliases = config.get("Aliases", {})
    if (distribution.get("Id") != outputs["DistributionId"]
            or "https://" + distribution.get("DomainName", "") != url
            or aliases.get("Items") or aliases.get("Quantity", 0) != 0
            or certificate.get("CloudFrontDefaultCertificate") is not True
            or certificate.get("ACMCertificateArn") or certificate.get("IAMCertificateId")):
        raise ValueError("Verify the actual distribution's default domain/certificate with no aliases")
    return url


def read_stack_url(session, account, region, stack_name, project):
    response = session.client("cloudformation", region_name=region).describe_stacks(StackName=stack_name)
    stacks = response.get("Stacks", [])
    if len(stacks) != 1:
        raise ValueError("Expected one participant App stack")
    stack = stacks[0]
    prefix = f"arn:aws:cloudformation:{region}:{account}:stack/{stack_name}/"
    tags = {item["Key"]: item["Value"] for item in stack.get("Tags", [])}
    if (stack.get("StackName") != stack_name or not stack.get("StackId", "").startswith(prefix)
            or tags.get("Project") != project):
        raise ValueError("The App stack does not belong to this participant account and namespace")
    if stack.get("StackStatus") not in {"CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"}:
        raise ValueError("Wait for the participant App stack operation to finish before reading its URL")
    parameters = {item["ParameterKey"]: item["ParameterValue"] for item in stack.get("Parameters", [])}
    require_default_settings(parameters)
    outputs = {item["OutputKey"]: item["OutputValue"] for item in stack.get("Outputs", [])}
    return cloudfront_url(outputs)
