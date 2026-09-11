"""Read this EC2's identity and primary-interface VPC via IMDSv2, never credentials."""
import json
import re

from lab_config import validate_config, validate_ec2_context

BASE = "http://169.254.169.254/latest/"


def read_ec2_context(http=None):
    import requests
    owned = http is None
    if owned:
        http = requests.Session()
        http.trust_env = False
    try:
        response = http.request(
            "PUT", BASE + "api/token",
            headers={"X-aws-ec2-metadata-token-ttl-seconds": "60"},
            timeout=(2, 3), allow_redirects=False,
        )
        if response.status_code != 200 or not 1 <= len(response.content) <= 4096:
            raise ValueError("EC2 IMDSv2 is unavailable; run inside the workshop EC2 and check metadata access")
        token = response.content.decode("ascii").strip()
        if not token or "\n" in token or "\r" in token:
            raise ValueError("EC2 metadata returned an invalid session response")

        def get(path, limit):
            result = http.request(
                "GET", BASE + path, headers={"X-aws-ec2-metadata-token": token},
                timeout=(2, 3), allow_redirects=False,
            )
            if result.status_code != 200 or not 1 <= len(result.content) <= limit:
                raise ValueError("EC2 identity/network metadata is unavailable; no fallback VPC was selected")
            return result.content.decode("utf-8").strip()

        identity = json.loads(get("dynamic/instance-identity/document", 16384))
        if not isinstance(identity, dict):
            raise ValueError("EC2 identity document is invalid")
        mac = get("meta-data/mac", 64).lower()
        if not re.fullmatch(r"(?:[a-f0-9]{2}:){5}[a-f0-9]{2}", mac):
            raise ValueError("EC2 primary-interface metadata is invalid")
        vpc = get("meta-data/network/interfaces/macs/" + mac + "/vpc-id", 64)
        return validate_ec2_context({
            "accountId": identity.get("accountId"), "region": identity.get("region"),
            "instanceId": identity.get("instanceId"), "vpcId": vpc,
        })
    except (requests.RequestException, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError("Cannot read EC2 IMDSv2 identity; use the EC2 terminal, not the local PC") from None
    finally:
        if owned:
            http.close()


def configuration_for_ec2(participant, context):
    context = validate_ec2_context(context)
    return validate_config({
        "version": 1, "participant": participant, "accountId": context["accountId"],
        "region": context["region"], "profile": "", "vpcName": context["vpcId"],
        "network": {}, "domainName": "", "viewerCertificateArn": "",
        "ec2Context": context,
    })
