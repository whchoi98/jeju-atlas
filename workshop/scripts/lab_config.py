"""Validated, non-secret workshop configuration and resource ownership."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re

FIELDS = {"version", "participant", "accountId", "region", "profile", "vpcName", "bedrockCallerRegion",
          "network", "domainName", "viewerCertificateArn", "ec2Context"}
NETWORK_FIELDS = {"vpcId", "publicSubnetIds", "privateSubnetIds", "cloudFrontPrefixListId"}
PROTECTED_DOMAINS = {"jeju-atlas.whchoi.net", "ohmyjeju.whchoi.net"}
RESERVED = {"prod", "production", "main", "default", "jeju3d", "jejuatlas", "ohmyjeju"}


def validate_ec2_context(value):
    if not isinstance(value, dict) or set(value) != {"instanceId", "accountId", "region", "vpcId"}:
        raise ValueError("EC2 context must contain only instance/account/region/VPC identifiers")
    checks = {
        "instanceId": r"i-[a-f0-9]{8,17}", "accountId": r"[0-9]{12}",
        "region": r"[a-z]{2}(?:-[a-z]+)+-[0-9]+", "vpcId": r"vpc-[a-f0-9]{8,17}",
    }
    if any(not isinstance(value[key], str) or not re.fullmatch(pattern, value[key])
           for key, pattern in checks.items()):
        raise ValueError("Invalid EC2 identity or network metadata")
    return deepcopy(value)


def validate_config(value, require_network=False):
    if not isinstance(value, dict) or set(value) - FIELDS:
        raise ValueError("Configuration accepts only the documented non-secret fields")
    result = deepcopy(value)
    defaults = {"version": 1, "region": "ap-northeast-2", "profile": "", "bedrockCallerRegion": "",
                "vpcName": "cc-on-bedrock-vpc", "network": {},
                "domainName": "", "viewerCertificateArn": ""}
    result = {**defaults, **result}
    if type(result["version"]) is not int or result["version"] != 1:
        raise ValueError("Unsupported configuration version")
    participant = result.get("participant", "")
    if (not isinstance(participant, str) or not re.fullmatch(r"[a-z][a-z0-9]{2,9}", participant)
            or participant in RESERVED or re.search(r"prod|shared|live|reference|default", participant)):
        raise ValueError("Use a unique participant such as team01 (3–10 lowercase letters/digits)")
    account = result.get("accountId", "")
    if not isinstance(account, str) or not re.fullmatch(r"[0-9]{12}", account) or account == "000000000000":
        raise ValueError("An explicit 12-digit AWS accountId is required")
    if result["region"] != "ap-northeast-2":
        raise ValueError("Use the workshop EC2 in ap-northeast-2; no cross-region VPC fallback is allowed")
    caller = result["bedrockCallerRegion"]
    if not isinstance(caller, str) or caller and not re.fullmatch(r"[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+", caller):
        raise ValueError("bedrockCallerRegion must be explicitly provided by the organizer; do not use a URL or alias")
    if "ec2Context" in result:
        context = validate_ec2_context(result["ec2Context"])
        if context["accountId"] != account or context["region"] != result["region"]:
            raise ValueError("Configuration must use this EC2's own account and region")
        result["ec2Context"] = context
    if not isinstance(result["profile"], str) or not re.fullmatch(r"[A-Za-z0-9_.@-]{0,64}", result["profile"]):
        raise ValueError("Invalid AWS profile name")
    if not isinstance(result["vpcName"], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}", result["vpcName"]):
        raise ValueError("Invalid existing VPC Name tag")
    domain, certificate = result["domainName"], result["viewerCertificateArn"]
    if domain != "" or certificate != "":
        raise ValueError("This workshop uses the CloudFront default HTTPS domain, without domainName or viewerCertificateArn. Preserve existing custom-domain configurations separately.")
    network = result["network"]
    if not isinstance(network, dict) or set(network) - NETWORK_FIELDS:
        raise ValueError("Invalid network configuration")
    if require_network or network:
        if set(network) != NETWORK_FIELDS:
            raise ValueError("Discover or provide the existing VPC, four subnets and CloudFront prefix list")
        for key, prefix in [("vpcId", "vpc"), ("cloudFrontPrefixListId", "pl")]:
            if not isinstance(network[key], str) or not re.fullmatch(rf"{prefix}-[a-f0-9]{{8,17}}", network[key]):
                raise ValueError("Invalid " + key)
        all_subnets = []
        for key in ["publicSubnetIds", "privateSubnetIds"]:
            values = network[key]
            if not isinstance(values, list) or len(values) != 2 or any(
                    not isinstance(item, str) or not re.fullmatch(r"subnet-[a-f0-9]{8,17}", item) for item in values):
                raise ValueError("Exactly two existing subnets are required for " + key)
            all_subnets.extend(values)
        if len(set(all_subnets)) != 4:
            raise ValueError("Public and private subnets must be four distinct subnets")
        if result.get("ec2Context") and network["vpcId"] != result["ec2Context"]["vpcId"]:
            raise ValueError("The selected network must be this EC2's primary-interface VPC")
    return result


def resource_names(config):
    config = validate_config(config)
    label = config["participant"][0].upper() + config["participant"][1:]
    project = "jeju-atlas-lab-" + config["participant"]
    prefix = "AtlasLab" + label
    return {
        "project": project, "stackPrefix": prefix, "corePrefix": prefix,
        "cliProject": "AtlasCli" + label,
        "dataBucket": f"{project}-data-{config['accountId']}-{config['region']}",
        "assetsBucket": f"{project}-assets-{config['accountId']}-{config['region']}",
    }


def binding_digest(config):
    config = validate_config(config, require_network=True)
    # CloudFront allocates the hostname at deployment; ownership is fixed here.
    binding = {key: config[key] for key in ["participant", "accountId", "region", "vpcName", "network"]}
    if config.get("ec2Context"):
        binding["ec2Context"] = config["ec2Context"]
    return hashlib.sha256(json.dumps(binding, sort_keys=True).encode()).hexdigest()


def read_config(path, require_network=False):
    path = Path(path)
    if path.is_symlink() or path.stat().st_size > 32 * 1024:
        raise ValueError("Configuration must be a small regular JSON file")
    return validate_config(json.loads(path.read_text()), require_network)


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise ValueError("Refusing to overwrite a symlink")
    temporary = path.with_name("." + path.name + ".tmp")
    if temporary.exists() or temporary.is_symlink():
        raise FileExistsError("Temporary output already exists: " + str(temporary))
    try:
        with temporary.open("x") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        temporary.chmod(0o600)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def aws_session(config):
    import boto3
    from botocore.config import Config
    config = validate_config(config)
    session = boto3.Session(profile_name=config["profile"] or None, region_name=config["region"])
    caller = session.client("sts", config=Config(connect_timeout=5, read_timeout=15)).get_caller_identity()
    if caller["Account"] != config["accountId"]:
        raise ValueError("AWS credentials do not match the configured account; no operation executed")
    if config.get("ec2Context"):
        from ec2_context import read_ec2_context
        if read_ec2_context() != config["ec2Context"]:
            raise ValueError("Run cloud steps on the EC2 instance that created this workshop configuration")
    return session


def discover_network(config, ec2):
    config = validate_config(config)
    if config.get("ec2Context"):
        vpcs = ec2.describe_vpcs(VpcIds=[config["ec2Context"]["vpcId"]])["Vpcs"]
    else:
        vpcs = ec2.describe_vpcs(Filters=[{"Name": "tag:Name", "Values": [config["vpcName"]]},
                                        {"Name": "state", "Values": ["available"]}])["Vpcs"]
    if len(vpcs) != 1:
        raise ValueError("Expected exactly one configured existing VPC")
    vpc = vpcs[0]["VpcId"]
    if vpcs[0].get("State", "available") != "available":
        raise ValueError("The EC2 VPC must be available")
    if config.get("ec2Context") and vpc != config["ec2Context"]["vpcId"]:
        raise ValueError("EC2 lookup returned a different VPC")
    subnets = ec2.describe_subnets(Filters=[{"Name": "vpc-id", "Values": [vpc]},
                                          {"Name": "state", "Values": ["available"]}])["Subnets"]
    tables = ec2.describe_route_tables(Filters=[{"Name": "vpc-id", "Values": [vpc]}])["RouteTables"]
    main = next((table for table in tables if any(a.get("Main") for a in table.get("Associations", []))), None)
    choices = {"public": {}, "private": {}}
    for subnet in sorted(subnets, key=lambda row: (row["AvailabilityZone"], row["SubnetId"])):
        table = next((table for table in tables if any(
            a.get("SubnetId") == subnet["SubnetId"] for a in table.get("Associations", []))), main)
        if not table:
            continue
        route = next((route for route in table["Routes"] if route.get("DestinationCidrBlock") == "0.0.0.0/0"
                      and route.get("State") == "active"), {})
        if route.get("GatewayId", "").startswith("igw-"):
            choices["public"].setdefault(subnet["AvailabilityZone"], subnet["SubnetId"])
        elif route.get("NatGatewayId") and not subnet.get("MapPublicIpOnLaunch"):
            nat = ec2.describe_nat_gateways(NatGatewayIds=[route["NatGatewayId"]])["NatGateways"]
            if len(nat) == 1 and nat[0]["State"] == "available" and nat[0]["VpcId"] == vpc:
                choices["private"].setdefault(subnet["AvailabilityZone"], subnet["SubnetId"])
    common_azs = sorted(set(choices["public"]) & set(choices["private"]))
    if len(common_azs) < 2:
        raise ValueError("Need existing public/private subnets in two AZs and active NAT routes; nothing was created")
    prefixes = ec2.describe_managed_prefix_lists(
        Filters=[{"Name": "prefix-list-name", "Values": ["com.amazonaws.global.cloudfront.origin-facing"]}]
    )["PrefixLists"]
    prefixes = [item for item in prefixes if item.get("OwnerId") == "AWS"]
    if len(prefixes) != 1:
        raise ValueError("Could not identify the AWS-managed CloudFront origin-facing prefix list")
    result = deepcopy(config)
    result["network"] = {
        "vpcId": vpc,
        "publicSubnetIds": [choices["public"][az] for az in common_azs[:2]],
        "privateSubnetIds": [choices["private"][az] for az in common_azs[:2]],
        "cloudFrontPrefixListId": prefixes[0]["PrefixListId"],
    }
    return validate_config(result, require_network=True)
