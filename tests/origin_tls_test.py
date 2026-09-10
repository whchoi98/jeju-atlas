"""Offline origin TLS contracts: render the app template and verify AWS-shaped fixtures."""
from copy import deepcopy
import importlib.util
from pathlib import Path
import re
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[1]
ALB_DNS = "jeju-3d-alb-123.ap-northeast-2.elb.amazonaws.com"
FUNCTION = "arn:aws:lambda:us-east-1:061525506239:function:jeju-3d-origin-host:7"
VIEWER = {
    "ViewerDomainName": "jeju-atlas.whchoi.net",
    "ViewerCertificateArn": "arn:aws:acm:us-east-1:061525506239:certificate/11111111-1111-1111-1111-111111111111",
}
CANONICAL = {
    **VIEWER, "OriginTlsEnabled": "true", "OriginTlsMode": "canonical-host",
    "OriginCertificateArn": "arn:aws:acm:ap-northeast-2:061525506239:certificate/22222222-2222-2222-2222-222222222222",
    "OriginHostFunctionVersionArn": FUNCTION,
}
OMIT = object()


class Loader(yaml.SafeLoader):
    pass


def intrinsic(loader, tag, node):
    if isinstance(node, yaml.ScalarNode):
        value = loader.construct_scalar(node)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node)
    else:
        value = loader.construct_mapping(node)
    return {tag if tag in ("Ref", "Condition") else "Fn::" + tag: value}


Loader.add_multi_constructor("!", intrinsic)


class Render:
    def __init__(self, changes):
        self.template = yaml.load((ROOT / "infra/application.yaml").read_text(), Loader=Loader)
        self.parameters = {key: value.get("Default", key) for key, value in self.template["Parameters"].items()}
        self.parameters.update(changes)

    def condition(self, name):
        return self.value(self.template["Conditions"][name])

    def value(self, value):
        if isinstance(value, list):
            return [item for raw in value if (item := self.value(raw)) is not OMIT]
        if not isinstance(value, dict):
            return value
        if "Ref" in value:
            name = value["Ref"]
            return {"AWS::NoValue": OMIT, "AWS::Region": "ap-northeast-2",
                    "AWS::AccountId": "061525506239", "AWS::Partition": "aws"}.get(name, self.parameters.get(name, name))
        if "Condition" in value:
            return self.condition(value["Condition"])
        if "Fn::If" in value:
            name, yes, no = value["Fn::If"]
            return self.value(yes if self.condition(name) else no)
        if "Fn::Equals" in value:
            left, right = self.value(value["Fn::Equals"])
            return left == right
        if "Fn::Not" in value:
            return not self.value(value["Fn::Not"][0])
        if "Fn::And" in value:
            return all(self.value(item) for item in value["Fn::And"])
        if "Fn::Or" in value:
            return any(self.value(item) for item in value["Fn::Or"])
        if "Fn::GetAtt" in value:
            attribute = value["Fn::GetAtt"]
            attribute = ".".join(attribute) if isinstance(attribute, list) else attribute
            return ALB_DNS if attribute == "LoadBalancer.DNSName" else attribute
        if "Fn::Sub" in value:
            return re.sub(r"\$\{([^}]+)\}", lambda match: str(self.value({"Ref": match.group(1)})), value["Fn::Sub"])
        return {key: item for key, raw in value.items() if (item := self.value(raw)) is not OMIT}

    def valid_tls_parameters(self):
        for name in ["OriginTlsEnabled", "OriginTlsMode", "OriginHostFunctionVersionArn"]:
            specification = self.template["Parameters"].get(name)
            if specification is None:
                if name in self.parameters:
                    return False
                continue
            value = self.parameters[name]
            if "AllowedValues" in specification and value not in specification["AllowedValues"]:
                return False
            if "AllowedPattern" in specification and not re.fullmatch(specification["AllowedPattern"], value):
                return False
        return all(
            all(self.value(assertion["Assert"]) for assertion in rule["Assertions"])
            for rule in self.template["Rules"].values()
            if self.value(rule.get("RuleCondition", True))
        )

    def resource(self, name):
        resource = self.template["Resources"].get(name)
        if not resource or "Condition" in resource and not self.condition(resource["Condition"]):
            return None
        return self.value(resource["Properties"])

    def distribution(self):
        return self.resource("Distribution")["DistributionConfig"]


def load_verifier():
    spec = importlib.util.spec_from_file_location("origin_tls_deploy", ROOT / "scripts/deploy.py")
    deploy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(deploy)
    spec = importlib.util.spec_from_file_location("origin_tls_verify", ROOT / "scripts/verify.py")
    verify = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {"deploy": deploy}):
        spec.loader.exec_module(verify)
    return verify


class OriginTlsTest(unittest.TestCase):
    def test_dns_is_default_and_retains_its_certificate_and_origin_dns_rule(self):
        rendered = Render({})
        self.assertEqual(rendered.template["Parameters"].get("OriginTlsMode", {}).get("Default"), "dns")
        self.assertTrue(rendered.valid_tls_parameters())
        self.assertFalse(Render({"OriginTlsEnabled": "true"}).valid_tls_parameters())
        dns = {"OriginTlsEnabled": "true", "OriginDomainName": "jeju-atlas-origin.whchoi.net",
               "OriginCertificateArn": CANONICAL["OriginCertificateArn"]}
        self.assertTrue(Render(dns).valid_tls_parameters())
        self.assertFalse(Render({**dns, "OriginCertificateArn": ""}).valid_tls_parameters())
        self.assertFalse(Render({**dns, "OriginDomainName": ""}).valid_tls_parameters())

    def test_canonical_host_requires_both_certificates_viewer_name_and_version_but_no_new_dns(self):
        self.assertTrue(Render(CANONICAL).valid_tls_parameters())
        for name in ("ViewerDomainName", "ViewerCertificateArn", "OriginCertificateArn", "OriginHostFunctionVersionArn"):
            with self.subTest(missing=name):
                self.assertFalse(Render({**CANONICAL, name: ""}).valid_tls_parameters())
        self.assertFalse(Render({**CANONICAL, "OriginTlsMode": "other"}).valid_tls_parameters())

    def test_function_parameter_rejects_aliases_latest_and_wrong_region_account_or_name(self):
        self.assertTrue(Render(CANONICAL).valid_tls_parameters())
        for arn in [
            FUNCTION.rsplit(":", 1)[0], FUNCTION.rsplit(":", 1)[0] + ":$LATEST",
            FUNCTION.rsplit(":", 1)[0] + ":production", FUNCTION.rsplit(":", 1)[0] + ":0",
            FUNCTION.replace("us-east-1", "ap-northeast-2"),
            FUNCTION.replace("061525506239", "111111111111"),
            FUNCTION.replace("jeju-3d-origin-host", "unrelated-function"),
        ]:
            with self.subTest(arn=arn):
                self.assertFalse(Render({**CANONICAL, "OriginHostFunctionVersionArn": arn}).valid_tls_parameters())

    def test_only_canonical_tls_adds_three_body_free_alb_associations(self):
        for mode, tls in [("dns", "false"), ("dns", "true"), ("canonical-host", "false"), ("canonical-host", "true")]:
            with self.subTest(mode=mode, tls=tls):
                rendered = Render({**CANONICAL, "OriginTlsMode": mode, "OriginTlsEnabled": tls,
                                   "OriginDomainName": "jeju-atlas-origin.whchoi.net", "DetailsBucket": "details-test",
                                   "MediaBucketDomainName": "details-test.s3.ap-northeast-2.amazonaws.com",
                                   "MediaOriginAccessControlId": "OAC123"})
                config = rendered.distribution()
                canonical = mode == "canonical-host" and tls == "true"
                alb = next(origin for origin in config["Origins"] if origin["Id"] == "jeju-alb")
                self.assertEqual(alb["DomainName"], "jeju-atlas-origin.whchoi.net" if tls == "true" and mode == "dns" else ALB_DNS)
                self.assertEqual(alb["CustomOriginConfig"]["OriginProtocolPolicy"], "https-only" if tls == "true" else "http-only")
                behaviors = [config["DefaultCacheBehavior"], *config["CacheBehaviors"]]
                alb_count = 0
                for behavior in behaviors:
                    if behavior["TargetOriginId"] == "jeju-alb":
                        alb_count += 1
                        self.assertEqual(behavior.get("LambdaFunctionAssociations", []), [{
                            "EventType": "origin-request", "IncludeBody": False, "LambdaFunctionARN": FUNCTION,
                        }] if canonical else [])
                        if behavior.get("PathPattern") != "/api/*":
                            self.assertEqual(behavior.get("OriginRequestPolicyId"), "HostOnlyOriginRequestPolicy" if canonical else None)
                    else:
                        self.assertNotIn("LambdaFunctionAssociations", behavior)
                        self.assertNotIn("OriginRequestPolicyId", behavior)
                self.assertEqual(alb_count, 3)
                self.assertEqual(rendered.resource("HostOnlyOriginRequestPolicy") is not None, canonical)

    def test_host_policy_and_private_api_keep_cache_cookie_query_and_proof_boundaries(self):
        for enabled in ("false", "true"):
            with self.subTest(tls=enabled):
                rendered = Render({**CANONICAL, "OriginTlsEnabled": enabled})
                api = rendered.resource("ApiOriginRequestPolicy")["OriginRequestPolicyConfig"]
                self.assertEqual(set(api["HeadersConfig"]["Headers"]),
                                 {"Origin", "Content-Type", "Accept", "X-Atlas-CSRF"} | ({"Host"} if enabled == "true" else set()))
                self.assertEqual(api["CookiesConfig"]["CookieBehavior"], "all")
                self.assertEqual(api["QueryStringsConfig"]["QueryStringBehavior"], "all")
                config = rendered.distribution()
                private = next(item for item in config["CacheBehaviors"] if item["PathPattern"] == "/api/*")
                self.assertIn("POST", private["AllowedMethods"])
                self.assertEqual(private["CachePolicyId"], "4135ea2d-6df8-44a3-9df3-4b5a84be39ad")
                for name in ("CachePolicy", "CatalogCachePolicy"):
                    key = rendered.resource(name)["CachePolicyConfig"]["ParametersInCacheKeyAndForwardedToOrigin"]
                    self.assertEqual(key["CookiesConfig"]["CookieBehavior"], "none")
                    self.assertEqual(key["HeadersConfig"]["HeaderBehavior"], "none")
                    self.assertEqual(key["QueryStringsConfig"]["QueryStringBehavior"], "all" if name == "CatalogCachePolicy" else "none")
                if enabled == "true":
                    host = rendered.resource("HostOnlyOriginRequestPolicy")["OriginRequestPolicyConfig"]
                    self.assertEqual(host["HeadersConfig"], {"HeaderBehavior": "whitelist", "Headers": ["Host"]})
                    self.assertEqual(host["CookiesConfig"]["CookieBehavior"], "none")
                    self.assertEqual(host["QueryStringsConfig"]["QueryStringBehavior"], "none")

    def fixture(self, changes=None):
        rendered = Render({**CANONICAL, "DetailsBucket": "details-test", **(changes or {})})
        config = rendered.distribution()
        config["Origins"] = {"Items": config["Origins"]}
        config["CacheBehaviors"] = {"Items": config["CacheBehaviors"]}
        for behavior in [config["DefaultCacheBehavior"], *config["CacheBehaviors"]["Items"]]:
            methods = behavior["AllowedMethods"]
            behavior["AllowedMethods"] = {"Items": methods, "CachedMethods": {"Items": behavior.pop("CachedMethods")}}
            associations = behavior.get("LambdaFunctionAssociations", [])
            behavior["LambdaFunctionAssociations"] = {"Quantity": len(associations), "Items": associations}
        policies = {}
        for name, resource in rendered.template["Resources"].items():
            if resource["Type"] != "AWS::CloudFront::OriginRequestPolicy":
                continue
            properties = rendered.resource(name)
            if properties:
                policy = properties["OriginRequestPolicyConfig"]
                headers = policy["HeadersConfig"].get("Headers")
                if headers is not None:
                    policy["HeadersConfig"]["Headers"] = {"Items": headers, "Quantity": len(headers)}
                policies[name] = policy
        return rendered.parameters, config, policies

    def verify_fixture(self, parameters, config, policies, settings=None):
        verify = load_verifier()
        self.assertTrue(callable(getattr(verify, "verify_origin_routing", None)))
        results = {}
        edge = SimpleNamespace(get_origin_request_policy=lambda Id: {
            "OriginRequestPolicy": {"OriginRequestPolicyConfig": deepcopy(policies[Id])},
        })
        verify.verify_origin_routing(edge, config, parameters, settings or parameters,
                                     {"LoadBalancerDnsName": ALB_DNS},
                                     lambda name, passed: results.update({name: bool(passed)}))
        self.assertTrue(results)
        return results

    def test_verifier_accepts_both_tls_modes_and_disabled_tls(self):
        for changes in [{}, {"OriginTlsEnabled": "false"},
                        {"OriginTlsMode": "dns", "OriginDomainName": "jeju-atlas-origin.whchoi.net"}]:
            with self.subTest(changes=changes):
                self.assertTrue(all(self.verify_fixture(*self.fixture(changes)).values()))

    def test_verifier_rejects_wrong_host_association_body_access_or_s3_attachment(self):
        parameters, original, policies = self.fixture()
        self.assertTrue(all(self.verify_fixture(parameters, original, policies).values()))
        for change in ("body", "event", "version", "missing", "media", "terrain", "domain", "protocol"):
            with self.subTest(change=change):
                config = deepcopy(original)
                association = config["DefaultCacheBehavior"]["LambdaFunctionAssociations"]["Items"][0]
                if change == "body":
                    association["IncludeBody"] = True
                elif change == "event":
                    association["EventType"] = "viewer-request"
                elif change == "version":
                    association["LambdaFunctionARN"] = FUNCTION.rsplit(":", 1)[0] + ":$LATEST"
                elif change == "missing":
                    config["DefaultCacheBehavior"]["LambdaFunctionAssociations"] = {"Items": [], "Quantity": 0}
                elif change in ("media", "terrain"):
                    target = "jeju-media" if change == "media" else "jeju-terrain"
                    behavior = next(item for item in config["CacheBehaviors"]["Items"] if item["TargetOriginId"] == target)
                    behavior["LambdaFunctionAssociations"] = {"Items": [association], "Quantity": 1}
                else:
                    origin = next(item for item in config["Origins"]["Items"] if item["Id"] == "jeju-alb")
                    if change == "domain":
                        origin["DomainName"] = "jeju-atlas.whchoi.net"
                    else:
                        origin["CustomOriginConfig"]["OriginProtocolPolicy"] = "http-only"
                self.assertFalse(all(self.verify_fixture(parameters, config, policies).values()))

    def test_verifier_rejects_forwarding_drift_without_losing_private_proof(self):
        parameters, config, original = self.fixture()
        for name, field, value in [
            ("HostOnlyOriginRequestPolicy", "CookiesConfig", {"CookieBehavior": "all"}),
            ("HostOnlyOriginRequestPolicy", "QueryStringsConfig", {"QueryStringBehavior": "all"}),
            ("HostOnlyOriginRequestPolicy", "HeadersConfig", {"HeaderBehavior": "allViewer"}),
            ("ApiOriginRequestPolicy", "CookiesConfig", {"CookieBehavior": "none"}),
            ("ApiOriginRequestPolicy", "QueryStringsConfig", {"QueryStringBehavior": "none"}),
            ("ApiOriginRequestPolicy", "HeadersConfig", {"HeaderBehavior": "whitelist", "Headers": {"Items": ["Host"]}}),
        ]:
            with self.subTest(policy=name, field=field):
                policies = deepcopy(original)
                policies[name][field] = value
                self.assertFalse(all(self.verify_fixture(parameters, config, policies).values()))
        self.assertFalse(all(self.verify_fixture(parameters, config, original,
                                                settings={**parameters, "OriginTlsMode": "dns"}).values()))


if __name__ == "__main__":
    unittest.main()
