import importlib.util
from pathlib import Path
import unittest
from types import SimpleNamespace
from unittest.mock import Mock
import yaml

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("kakao_deploy", ROOT / "scripts/deploy.py")
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class Loader(yaml.SafeLoader):
    pass


def intrinsic(loader, tag, node):
    if isinstance(node, yaml.ScalarNode):
        value = loader.construct_scalar(node)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node, deep=True)
    else:
        value = loader.construct_mapping(node, deep=True)
    return {tag: value}


Loader.add_multi_constructor("!", intrinsic)


class KakaoInfrastructureTests(unittest.TestCase):
    def test_kakao_key_is_optional_and_scoped_to_the_owned_parameter(self):
        template = yaml.load((ROOT / "infra/application.yaml").read_text(), Loader=Loader)
        self.assertIn("KakaoRestApiKeyParameter", template["Parameters"])
        parameter = template["Parameters"]["KakaoRestApiKeyParameter"]
        self.assertEqual(parameter["Default"], "")
        self.assertIn("/jeju-atlas/kakao-rest-api-key", parameter["AllowedPattern"])
        resources = template["Resources"]
        web = next(c for c in resources["TaskDefinition"]["Properties"]["ContainerDefinitions"] if c["Name"] == "web")
        self.assertNotIn("KAKAO_REST_API_KEY", [e.get("Name") for e in web["Environment"]])
        secret = next(s["If"] for s in web["Secrets"] if "If" in s)
        self.assertEqual(secret[0], "HasKakao")
        self.assertEqual(secret[1]["Name"], "KAKAO_REST_API_KEY")
        self.assertEqual(secret[2], {"Ref": "AWS::NoValue"})
        statements = resources["ExecutionRole"]["Properties"]["Policies"][0]["PolicyDocument"]["Statement"]
        permission = next(s["If"] for s in statements if "If" in s)
        self.assertEqual(permission[0], "HasKakao")
        self.assertEqual(permission[1]["Action"], "ssm:GetParameters")
        self.assertEqual(permission[1]["Resource"], secret[1]["ValueFrom"])
        self.assertNotIn("*", str(permission[1]["Resource"]))
        self.assertEqual(template["Parameters"]["KakaoDailyLimit"]["MaxValue"], 1000)

    def test_settings_accept_only_a_parameter_reference_and_bounded_daily_budget(self):
        for value in ["raw-key-value", "/agentcore-cli/kakao-key", "/jeju-atlas/other"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                deploy.validate_settings({"KakaoRestApiKeyParameter": value})
        result = deploy.validate_settings({"KakaoRestApiKeyParameter": "/jeju-atlas/kakao-rest-api-key"})
        self.assertEqual(result["KakaoRestApiKeyParameter"], "/jeju-atlas/kakao-rest-api-key")
        self.assertEqual(result["KakaoDailyLimit"], "1000")
        for limit in [0, 1001, True]:
            with self.subTest(limit=limit), self.assertRaises(ValueError):
                deploy.validate_settings({"KakaoDailyLimit": limit})

    def test_plan_checks_parameter_metadata_without_reading_credentials(self):
        name = "/jeju-atlas/kakao-rest-api-key"
        ssm = Mock()
        session = SimpleNamespace(client=lambda service: ssm if service == "ssm" else None)
        deploy.assert_kakao_parameter(session, {})
        self.assertFalse(ssm.describe_parameters.called)
        ssm.describe_parameters.return_value = {"Parameters": [{"Name": name, "Type": "SecureString"}]}
        deploy.assert_kakao_parameter(session, {"KakaoRestApiKeyParameter": name})
        ssm.describe_parameters.assert_called_once_with(ParameterFilters=[
            {"Key": "Name", "Option": "Equals", "Values": [name]},
        ])
        self.assertFalse(ssm.get_parameter.called)
        for rows in [[], [{"Name": name, "Type": "String"}], [{"Name": "/other", "Type": "SecureString"}]]:
            ssm.describe_parameters.return_value = {"Parameters": rows}
            with self.assertRaises(ValueError):
                deploy.assert_kakao_parameter(session, {"KakaoRestApiKeyParameter": name})


if __name__ == "__main__":
    unittest.main()
