"""Prepare a namespaced copy of the existing assets, never the production tree."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess

from lab_config import binding_digest, resource_names, validate_config, write_json
from lab_cloudfront import require_default_settings
from model_config import MODEL_ID

SOURCE_ACCOUNT = "061525506239"
SOURCE_VPC = "vpc-0dfa5610180dfa628"
SOURCE_PUBLIC = ["subnet-08486a1e618b1991e", "subnet-0c161777c4031c320"]
SOURCE_PRIVATE = ["subnet-07b1e65682847dce9", "subnet-095297380cd45e1eb"]
SOURCE_PREFIX = "pl-22a6434b"
SOURCE_DOMAIN = "jeju-atlas.whchoi.net"
FOLDERS = {"src", "public", "shared", "server", "agent", "routing", "infra", "scripts", "tests", "docs"}
FILES = {"package.json", "package-lock.json", "README.md", "index.html", "tsconfig.json",
         "vite.config.ts", ".gitignore", ".dockerignore", ".gitleaks.toml", ".nvmrc"}
PUBLIC_WORKSHOP_FOLDERS = {"chapters", "reference", "prompts", "assets"}
PUBLIC_WORKSHOP_FILES = {"workshop/course.json", "workshop/scripts/build.mjs",
                        "workshop/scripts/pwa.mjs", "workshop/scripts/package_handbook.py"}


def placeholder_hostname(config):
    # Anonymize copied production examples only. Never use this as a deployed
    # URL: that comes exclusively from the participant App stack's outputs.
    return "atlas-" + config["participant"] + ".workshop.example.org"


def read_template(path):
    import yaml
    class Loader(yaml.SafeLoader):
        pass

    def intrinsic(loader, tag, node):
        if isinstance(node, yaml.ScalarNode):
            value = loader.construct_scalar(node)
        elif isinstance(node, yaml.SequenceNode):
            value = loader.construct_sequence(node, deep=True)
        else:
            value = loader.construct_mapping(node, deep=True)
        key = tag if tag in {"Ref", "Condition"} else "Fn::" + tag
        if tag == "GetAtt" and isinstance(value, str):
            value = value.split(".", 1)
        return {key: value}

    Loader.add_multi_constructor("!", intrinsic)
    return yaml.load(Path(path).read_text(), Loader=Loader)


def rewrite_text(text, config):
    names = resource_names(config)
    domain = config["domainName"] or placeholder_hostname(config)
    old_suffix, new_suffix = "whchoi.net", domain.split(".", 1)[1]
    replacements = [
        (SOURCE_DOMAIN, domain), (re.escape(SOURCE_DOMAIN), re.escape(domain)),
        (re.escape(old_suffix), re.escape(new_suffix)), (old_suffix, new_suffix),
        ("jeju-atlas-tools", names["project"] + "-tools"),
        ("/jeju-atlas/", "/" + names["project"] + "/"),
        ("JejuAtlas_", names["corePrefix"] + "_"),
        ("Jeju3d", names["stackPrefix"]), ("jeju-3d", names["project"]),
        (SOURCE_ACCOUNT, config["accountId"]),
        (SOURCE_VPC, config["network"]["vpcId"]),
        (SOURCE_PREFIX, config["network"]["cloudFrontPrefixListId"]),
        ("cc-on-bedrock-vpc", config["vpcName"]),
        *zip(SOURCE_PUBLIC, config["network"]["publicSubnetIds"]),
        *zip(SOURCE_PRIVATE, config["network"]["privateSubnetIds"]),
    ]
    for original, replacement in replacements:
        text = text.replace(original, replacement)
    return text


def data_bootstrap_template(template):
    template = deepcopy(template)
    media = template["Parameters"]["PublicMediaOrigin"]
    media["Default"] = ""
    media["AllowedPattern"] = r"^$|^https://d[a-z0-9]+\.cloudfront\.net$"
    parameter = template["Parameters"]["DistributionArn"]
    parameter["Default"] = ""
    parameter["AllowedPattern"] = r"^$|^arn:aws:cloudfront::[0-9]{12}:distribution/[A-Za-z0-9]+$"
    template.setdefault("Conditions", {})["HasDistribution"] = {
        "Fn::Not": [{"Fn::Equals": [{"Ref": "DistributionArn"}, ""]}]}
    statements = template["Resources"]["DetailsBucketPolicy"]["Properties"]["PolicyDocument"]["Statement"]
    count = 0
    for index, statement in enumerate(statements):
        if statement.get("Sid") == "CloudFrontMediaOnly":
            statements[index] = {"Fn::If": ["HasDistribution", statement, {"Ref": "AWS::NoValue"}]}
            count += 1
    if count != 1:
        raise ValueError("The source media policy changed; review the workshop bootstrap adaptation")
    return template


def adapt_deployer(text):
    needle = '''    if kind in ("bootstrap", "origin"):
        return {}
    outputs = stack_outputs(session.client("cloudformation"), APP)'''
    replacement = '''    if kind in ("bootstrap", "origin"):
        return {}
    # Workshop first install: create private data storage before the app/AgentCore.
    if kind == "data" and not optional_stack_outputs(session, "app"):
        assert_network(session)
        return {
            "CatalogBucket": OWN_CATALOG_BUCKET, "DistributionArn": "",
            "VpcId": VPC, "PrivateSubnetIds": ",".join(PRIVATE),
            "ScheduleState": "DISABLED",
        }
    outputs = stack_outputs(session.client("cloudformation"), APP)'''
    if text.count(needle) != 1:
        raise ValueError("The source deployer changed; review the first-install adaptation")
    text = text.replace(needle, replacement)
    media_needle = '        operations = optional_stack_outputs(session, "operations")'
    if text.count(media_needle) != 1:
        raise ValueError("Review the source data-origin configuration before preparing the lab")
    text = text.replace(media_needle, '        values["PublicMediaOrigin"] = cloudfront_url(outputs)\n' + media_needle)
    replacements = {
        "import json\n": "import json\nfrom workshop_cloudfront import cloudfront_url, require_default_settings\n",
        "def optional_stack_outputs(session, kind):\n":
            'def optional_stack_outputs(session, kind):\n'
            '    if kind in ("origin", "origin-routing", "tls-probe"):\n'
            '        return {}  # Never attach certificates/functions from older domain workflows.\n',
        "def plan(session, kind, overrides=None):\n":
            'def plan(session, kind, overrides=None):\n'
            '    if kind in ("origin", "origin-routing", "tls-probe"):\n'
            '        raise ValueError("The workshop uses the CloudFront default domain; certificate/probe stacks are excluded")\n',
        '        params.update(atlas_agent_parameters())':
            '        params.update(atlas_agent_parameters())\n'
            '        require_default_settings(settings)',
        '    change_name = "jeju-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")':
            '    if kind == "app":\n'
            '        require_default_settings(params)  # Also reject inherited certificate parameters.\n'
            '    change_name = "jeju-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")',
    }
    return replace_once(text, replacements)


def replace_once(text, replacements):
    for before, after in replacements.items():
        if text.count(before) != 1:
            raise ValueError("Review the source before applying the workshop adapter: " + before.splitlines()[0])
        text = text.replace(before, after)
    return text


def adapt_cloudfront_verifiers(workspace):
    """Change generated copies only; keep all production verification contracts."""
    workspace = Path(workspace)
    path = workspace / "scripts/verify.py"
    path.write_text(replace_once(path.read_text(), {
        "import json\n": "import json\nfrom workshop_cloudfront import cloudfront_url, require_default_viewer\n",
        '''    check("Confirmed custom domain and certificate are preserved",
          config.get("Aliases", {}).get("Items") == [settings["ViewerDomainName"]]
          and config.get("ViewerCertificate", {}).get("ACMCertificateArn") == settings["ViewerCertificateArn"])''':
            '''    require_default_viewer(distribution, outputs)
    check("The participant distribution uses its default HTTPS domain and certificate", True)''',
        '''    url = outputs["ApplicationUrl"]''': '''    url = cloudfront_url(outputs)''',
        '''    for host in dict.fromkeys([f"https://{settings['ViewerDomainName']}", outputs.get("CloudFrontUrl", url)]):''':
            '''    for host in [url]:''',
        '''        check("Both served origins accept the app proof before model invocation",''':
            '''        check("The default CloudFront origin accepts app proof before model invocation",''',
        '''    check("Existing NAT Gateways reused", nat_ids == {"nat-00b8a70dc184a4d0c", "nat-08379e076e2e6e234"}, sorted(nat_ids))''':
            '''    check("Existing NAT routes were validated against this participant VPC",
          bool(nat_ids) and all(value.startswith("nat-") for value in nat_ids), sorted(nat_ids))''',
    }))
    path = workspace / "scripts/verify-shared-assets.py"
    path.write_text(replace_once(path.read_text(), {
        "import json\n": "import json\nfrom workshop_cloudfront import cloudfront_url\n",
        '''    app = stack_outputs(cf, APP)''': '''    app = stack_outputs(cf, APP)
    url = cloudfront_url(app)''',
        '''http.get(app["ApplicationUrl"] + "/" + path''': '''http.get(url + "/" + path''',
    }))
    path = workspace / "scripts/verify-terrain-cache.py"
    text = replace_once(path.read_text(), {
        "import json\n": "import json\nfrom workshop_cloudfront import cloudfront_origin\n",
        "    verify(args.url, args.rounds, args.report)":
            "    verify(cloudfront_origin(args.url), args.rounds, args.report)",
    })
    text, count = re.subn(r'parser\.add_argument\("--url", default="https://[a-z0-9]+\.cloudfront\.net"\)',
                          'parser.add_argument("--url", required=True)', text)
    if count != 1:
        raise ValueError("Review the terrain verifier URL argument before copying it")
    path.write_text(text)


def adapt_workshop_models(workspace):
    """Pin participant model code and environment only; never rewrite IAM policy."""
    workspace = Path(workspace)
    path = workspace / "agent/guide/model/load.py"
    text = replace_once(path.read_text(), {
        'MODEL_ID = "global.openai.gpt-6-astra"': f'MODEL_ID = "{MODEL_ID}"',
        'BEDROCK_REGION = "ap-northeast-2"': 'BEDROCK_REGION = os.environ.get("ATLAS_BEDROCK_REGION", "")',
        '    resolved_id = model_id or MODEL_ID':
            '    if not BEDROCK_REGION:\n'
            '        raise ValueError("Configure the organizer-verified ATLAS_BEDROCK_REGION; no deployment-region fallback")\n'
            '    resolved_id = model_id or MODEL_ID',
    })
    path.write_text(text)
    path = workspace / "agent/guide/atlas_agent/routing.py"
    path.write_text(replace_once(path.read_text(), {
        'MODEL_FAST_DEFAULT = "global.openai.gpt-5.6-sol"': f'MODEL_FAST_DEFAULT = "{MODEL_ID}"',
        'MODEL_DEEP_DEFAULT = "global.openai.gpt-6-astra"': f'MODEL_DEEP_DEFAULT = "{MODEL_ID}"',
    }))
    path = workspace / "infra/agentcore.yaml"
    template = read_template(path)
    template["Parameters"]["BedrockCallerRegion"] = {
        "Type": "String", "AllowedPattern": "^[a-z]{2}(-[a-z0-9]+)+-[0-9]+$",
        "Description": "Organizer-verified Bedrock caller endpoint; deployment stays in the workshop region.",
    }
    env = template["Resources"]["GuideRuntime"]["Properties"]["EnvironmentVariables"]
    env.update(ATLAS_MODEL_FAST=MODEL_ID, ATLAS_MODEL_DEEP=MODEL_ID,
               ATLAS_BEDROCK_REGION={"Ref": "BedrockCallerRegion"},
               ATLAS_THINKING="disabled", ATLAS_THINKING_DEEP="disabled")
    path.write_text(json.dumps(template, ensure_ascii=False, indent=2) + "\n")
    path = workspace / "scripts/deploy-atlas-agent.py"
    text = path.read_text()
    if "import os\n" not in text:
        text = replace_once(text, {"import json\n": "import json\nimport os\n"})
    text = replace_once(text, {
        '    parameters = [{"ParameterKey": "DataBucketName", "ParameterValue": BUCKET}]':
            '    parameters = [{"ParameterKey": "DataBucketName", "ParameterValue": BUCKET},\n'
            '                  {"ParameterKey": "BedrockCallerRegion", "ParameterValue": os.environ.get("ATLAS_BEDROCK_REGION", "")}]',
    })
    path.write_text(text)


def adapt_ec2_network_check(text, config):
    if not config.get("ec2Context"):
        return text
    pattern = (r'    if not any\(t\["Key"\] == "Name" and t\["Value"\] == "[^"]+" for t in vpc.get\("Tags", \[\]\)\):\n'
               r'        raise RuntimeError\("VPC name does not match the user\'s requested VPC"\)')
    replacement = ('    if vpc.get("VpcId") != VPC or vpc.get("State") != "available":\n'
                   '        raise RuntimeError("VPC must match the available VPC of the workshop EC2")')
    result, count = re.subn(pattern, replacement, text)
    if count != 1:
        raise ValueError("Review the source VPC guard before preparing an EC2-bound lab")
    return result


def production_settings(config, https=False):
    config = validate_config(config)
    if https:
        raise ValueError("CloudFront already supplies viewer HTTPS; the workshop does not issue origin certificates")
    return {
        "ViewerDomainName": "",
        "ViewerCertificateArn": "",
        "DesiredCount": 2, "MinTaskCount": 2, "MaxTaskCount": 4,
        "GuideLimitsEnabled": "true",
        "GuideDailyLimit": 30, "GuideHourlyLimit": 5, "GuideGlobalConcurrency": 2,
        "RoutingEnabled": "true", "TaskCpu": 512, "TaskMemory": 1024, "RoutingMemory": 512,
        "TargetHealthPath": "/healthz", "OriginDomainName": "",
        "OriginTlsEnabled": "false", "OriginTlsMode": "dns",
    }


def adapt_data_tests(path):
    """Keep existing IAM assertions against the configured branch of the new condition."""
    path = Path(path)
    text = path.read_text()
    marker = "\nclass DataInfrastructureTests(unittest.TestCase):"
    adapter = '''
def configured_distribution_view(value):
    # The original assertions describe media access after a real Distribution is set.
    # Bootstrap-without-access is verified separately by workshop/tests/test_lab_boundary.py.
    if isinstance(value, list):
        return [configured_distribution_view(item) for item in value]
    if isinstance(value, dict):
        branch = value.get("Fn::If")
        if branch and branch[0] == "HasDistribution":
            return configured_distribution_view(branch[1])
        return {(key[4:] if key.startswith("Fn::") else key): configured_distribution_view(item)
                for key, item in value.items()}
    return value

'''
    setup = '        self.template = yaml.load((root / "infra/data.yaml").read_text(), Loader=Loader)'
    if text.count(marker) != 1 or text.count(setup) != 1:
        raise ValueError("Review the source data-policy tests for the workshop bootstrap condition")
    text = text.replace(marker, "\n" + adapter + marker)
    text = text.replace(setup, setup + "\n        self.template = configured_distribution_view(self.template)")
    path.write_text(text)


def prepare_workspace(config, source_root, labs_root):
    config = validate_config(config, require_network=True)
    source_root, labs_root = Path(source_root).resolve(), Path(labs_root)
    if labs_root.is_symlink():
        raise ValueError("Lab storage cannot be a symlink")
    destination = labs_root / config["participant"] / "app"
    if destination.exists() or destination.is_symlink():
        raise FileExistsError("Lab workspace exists; keep student edits and use another participant ID")
    if destination.parent.is_symlink():
        raise ValueError("Participant directory cannot be a symlink")
    raw = subprocess.check_output(["git", "--no-optional-locks", "-C", str(source_root), "ls-files", "-z"])
    tracked = [name.decode() for name in raw.split(b"\0") if name]
    selected = [name for name in tracked if name.split("/")[0] in FOLDERS or name in FILES
                or name.startswith("Dockerfile") or name in PUBLIC_WORKSHOP_FILES
                or (name.startswith("workshop/") and name.split("/")[1] in PUBLIC_WORKSHOP_FOLDERS)]
    if not selected:
        raise ValueError("Prepare from the Jeju Atlas Git repository root")
    destination.mkdir(parents=True)
    manifest = {}
    for name in selected:
        if name == "agent/dependency-artifacts.json":
            continue  # A new participant builds and publishes their own dependencies.
        source, target = source_root / name, destination / name
        if source.is_symlink() or not source.is_file():
            raise ValueError("Application assets must be regular tracked files: " + name)
        target.parent.mkdir(parents=True, exist_ok=True)
        data = source.read_bytes()
        manifest[name] = hashlib.sha256(data).hexdigest()
        # Runtime/UI assets remain byte-for-byte copies. Deployment/test text is scoped.
        if name.split("/")[0] in {"infra", "scripts", "tests", "docs", "agent", "server"} or name == "README.md":
            try:
                data = rewrite_text(data.decode(), config).encode()
            except UnicodeDecodeError:
                pass
        target.write_bytes(data)
        shutil.copymode(source, target)
    deploy = destination / "scripts/deploy.py"
    deploy.write_text(adapt_ec2_network_check(adapt_deployer(deploy.read_text()), config))
    support = Path(__file__).with_name("lab_cloudfront.py")
    if support.is_symlink() or not support.is_file():
        raise ValueError("Use the bundled CloudFront helper source")
    (destination / "scripts/workshop_cloudfront.py").write_bytes(support.read_bytes())
    manifest["workshop/scripts/lab_cloudfront.py"] = hashlib.sha256(support.read_bytes()).hexdigest()
    adapt_cloudfront_verifiers(destination)
    adapt_workshop_models(destination)
    template = destination / "infra/data.yaml"
    template.write_text(json.dumps(data_bootstrap_template(read_template(template)), indent=2) + "\n")
    adapt_data_tests(destination / "tests/data_detail_infra_test.py")
    write_json(destination / "infra/production.json", production_settings(config))
    write_json(destination / "infra/data-settings.json", {"ScheduleState": "DISABLED"})
    (destination / ".local").mkdir()
    write_json(destination / ".local/workshop-binding.json", {
        "version": 1, "bindingDigest": binding_digest(config), "names": resource_names(config),
        "accountId": config["accountId"], "sourceFiles": manifest,
    })
    names = resource_names(config)
    (destination / "AGENTS.md").write_text(
        "# Jeju Atlas participant workspace\n\n"
        f"This copy belongs to participant `{config['participant']}`, account `{config['accountId']}` "
        f"in `{config['region']}`. Owned project prefix: `{names['project']}`; "
        f"stack prefix: `{names['stackPrefix']}`.\n\n"
        "- Edit this workspace only. Never edit the source repository, agentcore-cli or another participant.\n"
        "- Preserve workshop-binding.json and account/network/name checks.\n"
        "- Use the workshop lab.py runner for cloud steps. Review the selected step and its change set.\n"
        "- Use the existing VPC/subnets/NAT without creating, replacing or deleting them.\n"
        "- Access this workshop only through its stack's default CloudFront HTTPS domain; do not issue certificates or configure DNS.\n"
        "- Do not read or print credentials, .env files or provider key values. Use the hidden-input helper.\n"
        "- Preserve sample provenance and official evidence; do not invent opening hours or facilities.\n"
        "- Run npm run check for app changes. A local build is not proof of AWS deployment.\n",
        encoding="utf-8",
    )
    (destination / "CLAUDE.md").write_text(
        "@AGENTS.md\n\n# Claude Code workshop context\n\n"
        "Follow the shared account, VPC, namespace and source-protection rules in AGENTS.md. "
        "Changing the developer CLI does not change the Atlas runtime model configuration.\n",
        encoding="utf-8",
    )
    steering = destination / ".kiro/steering"
    steering.mkdir(parents=True)
    (steering / "workshop.md").write_text(
        "---\ninclusion: always\n---\n\n"
        + (destination / "AGENTS.md").read_text()
        + "\nUse the same lab.py ownership checks. Do not enable trust-all-tools or change production resources.\n",
        encoding="utf-8",
    )
    (destination / "README.md").write_text(
        f"# Jeju Atlas lab · {config['participant']}\n\n"
        "This is a generated participant copy, not a record of a completed cloud deployment.\n\n"
        f"- Account: `{config['accountId']}` / region: `{config['region']}`\n"
        f"- Owned resource prefix: `{names['project']}`\n"
        f"- Owned stack prefix: `{names['stackPrefix']}`\n\n"
        "Follow the chapter Markdown/HTML in the source repository's `workshop/` directory. "
        "Use its `lab.py` runner with your own configuration for deployment. "
        "Historical documents copied under `docs/` describe the source application, not this lab's live state.\n",
        encoding="utf-8",
    )
    package = json.loads((destination / "package.json").read_text())
    package["scripts"] = {key: value for key, value in package["scripts"].items()
                          if not key.startswith("workshop:")}
    write_json(destination / "package.json", package)
    subprocess.run(["git", "init", "--quiet", "--initial-branch=main"], cwd=destination, check=True)
    subprocess.run(["git", "add", "."], cwd=destination, check=True, capture_output=True)
    subprocess.run(["git", "-c", "user.name=Jeju Atlas Workshop",
                    "-c", "user.email=workshop@example.invalid",
                    "commit", "--quiet", "-m", "Initialize isolated participant assets"],
                   cwd=destination, check=True, capture_output=True)
    return destination


def verify_workspace(config, workspace):
    config = validate_config(config, require_network=True)
    workspace = Path(workspace)
    if workspace.is_symlink() or not workspace.is_dir():
        raise ValueError("Prepare the participant workspace first")
    receipt = workspace / ".local/workshop-binding.json"
    value = json.loads(receipt.read_text())
    if value.get("bindingDigest") != binding_digest(config) or value.get("names") != resource_names(config):
        raise ValueError("The prepared workspace belongs to a different account/network/participant")
    deploy = (workspace / "scripts/deploy.py").read_text()
    agent = (workspace / "scripts/deploy-atlas-agent.py").read_text()
    names = resource_names(config)
    for text in [deploy, agent]:
        if f'ACCOUNT = "{config["accountId"]}"' not in text or "Jeju3d" in text or '"jeju-3d"' in text:
            raise ValueError("Deployment scope was changed; no command will run")
    if f'STACK = "{names["stackPrefix"]}AgentCore"' not in agent:
        raise ValueError("AgentCore stack scope does not match the lab")
    if f'VPC = "{config["network"]["vpcId"]}"' not in deploy:
        raise ValueError("Prepared VPC binding was changed")
    if "/jeju-atlas/" in (workspace / "scripts/fetch-place-details.py").read_text():
        raise ValueError("Collector would read the production provider parameters")
    require_default_settings(json.loads((workspace / "infra/production.json").read_text()))
    return workspace
