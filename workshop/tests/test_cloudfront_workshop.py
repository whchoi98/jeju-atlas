"""Default CloudFront HTTPS is the only workshop viewer identity."""
import ast
import copy
import importlib
import io
import json
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "workshop/scripts"))
sys.path.insert(0, str(Path(__file__).parent))
import lab
from lab_config import resource_names, validate_config
from lab_workspace import prepare_workspace, production_settings, read_template
from test_lab_boundary import configuration


URL = "https://d123456789abcd.cloudfront.net"
OUTPUTS = {"CloudFrontUrl": URL, "ApplicationUrl": URL, "DistributionId": "EDISTRIBUTION01"}


def load_function(path, name, namespace=None):
    tree = ast.parse(Path(path).read_text())
    definition = next(item for item in tree.body if isinstance(item, ast.FunctionDef) and item.name == name)
    namespace = {} if namespace is None else namespace
    exec(compile(ast.Module(body=[definition], type_ignores=[]), str(path), "exec"), namespace)
    return namespace[name]


class CloudFrontWorkshopTests(unittest.TestCase):
    def helper(self):
        self.assertTrue((ROOT / "workshop/scripts/lab_cloudfront.py").is_file(),
                        "The owned CloudFront output helper is missing")
        return importlib.import_module("lab_cloudfront")

    def test_custom_domain_configuration_is_rejected_instead_of_becoming_a_prerequisite(self):
        value = configuration()
        value.update(domainName="team01.training.example.org",
                     viewerCertificateArn="arn:aws:acm:us-east-1:123456789012:certificate/"
                                          "11111111-1111-1111-1111-111111111111")
        with self.assertRaisesRegex(ValueError, "CloudFront"):
            validate_config(value)
        with self.assertRaises(ValueError):
            production_settings(configuration(), https=True)

    def test_certificate_and_dns_steps_are_not_available_to_the_lab_runner(self):
        for step in ("plan-origin", "apply-origin-routing", "plan-tls-probe",
                     "delete-tls-probe", "verify-tls"):
            with self.subTest(step=step):
                with self.assertRaises(ValueError):
                    lab.command_for(step)
        for command in ("configure-domain", "enable-https"):
            with self.subTest(command=command), patch.object(sys, "argv", ["lab.py", command]), \
                    redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
                lab.main()
            self.assertEqual(raised.exception.code, 2)

    def test_cloudfront_outputs_must_be_real_https_roots_and_agree(self):
        module = self.helper()
        self.assertEqual(module.cloudfront_url(OUTPUTS), URL)
        for value in ({}, {"CloudFrontUrl": URL, "DistributionId": "EDISTRIBUTION01"},
                      {**OUTPUTS, "ApplicationUrl": "https://other.example.org"},
                      {**OUTPUTS, "CloudFrontUrl": "http://d123456789abcd.cloudfront.net"},
                      {**OUTPUTS, "CloudFrontUrl": URL + "/workshop/"},
                      {**OUTPUTS, "CloudFrontUrl": URL + "?target=other"},
                      {**OUTPUTS, "CloudFrontUrl": "https://d123456789abcd.cloudfront.net.evil.example"},
                      {**OUTPUTS, "CloudFrontUrl": "https://name:password@d123456789abcd.cloudfront.net"}):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    module.cloudfront_url(value)

    def stack(self):
        return {
            "StackName": "AtlasLabTeam01App",
            "StackId": "arn:aws:cloudformation:ap-northeast-2:123456789012:stack/AtlasLabTeam01App/test-id",
            "StackStatus": "CREATE_COMPLETE",
            "Tags": [{"Key": "Project", "Value": "jeju-atlas-lab-team01"}],
            "Outputs": [{"OutputKey": key, "OutputValue": value} for key, value in OUTPUTS.items()],
        }

    def test_url_lookup_uses_the_owned_live_stack_outputs(self):
        module = self.helper()
        cf = Mock()
        cf.describe_stacks.return_value = {"Stacks": [self.stack()]}
        session = Mock()
        session.client.return_value = cf
        result = module.read_stack_url(session, "123456789012", "ap-northeast-2",
                                       "AtlasLabTeam01App", "jeju-atlas-lab-team01")
        self.assertEqual(result, URL)
        self.assertEqual(cf.describe_stacks.call_args.kwargs, {"StackName": "AtlasLabTeam01App"})
        self.assertEqual([call[0] for call in cf.method_calls], ["describe_stacks"])

    def test_other_accounts_tags_and_incomplete_stacks_are_rejected(self):
        module = self.helper()
        for change in (
            {"StackId": "arn:aws:cloudformation:ap-northeast-2:999999999999:stack/AtlasLabTeam01App/test-id"},
            {"Tags": [{"Key": "Project", "Value": "production"}]},
            {"StackStatus": "CREATE_IN_PROGRESS"},
            {"Outputs": []},
        ):
            cf, session = Mock(), Mock()
            cf.describe_stacks.return_value = {"Stacks": [{**self.stack(), **change}]}
            session.client.return_value = cf
            with self.subTest(change=change), self.assertRaises(ValueError):
                module.read_stack_url(session, "123456789012", "ap-northeast-2",
                                      "AtlasLabTeam01App", "jeju-atlas-lab-team01")

    def test_default_viewer_is_checked_against_the_actual_distribution_domain(self):
        module = self.helper()
        distribution = {
            "Id": OUTPUTS["DistributionId"], "DomainName": URL.split("://")[1],
            "DistributionConfig": {"Aliases": {"Quantity": 0},
                                   "ViewerCertificate": {"CloudFrontDefaultCertificate": True}},
        }
        self.assertEqual(module.require_default_viewer(distribution, OUTPUTS), URL)
        for change in ({"Aliases": {"Quantity": 1, "Items": ["custom.example.org"]}},
                       {"ViewerCertificate": {"ACMCertificateArn": "an-existing-certificate"}},
                       {"ViewerCertificate": {"CloudFrontDefaultCertificate": False}}):
            bad = copy.deepcopy(distribution)
            bad["DistributionConfig"].update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                module.require_default_viewer(bad, OUTPUTS)
        distribution["DomainName"] = "danotherdistribution.cloudfront.net"
        with self.assertRaises(ValueError):
            module.require_default_viewer(distribution, OUTPUTS)

    def test_prepared_template_selects_default_certificate_without_changing_production(self):
        protected = ("infra/application.yaml", "infra/origin.yaml", "infra/origin-routing.yaml",
                     "infra/tls-probe.yaml", "scripts/deploy.py", "scripts/verify.py")
        before = {name: (ROOT / name).read_bytes() for name in protected}
        with tempfile.TemporaryDirectory(prefix="atlas-cf-template-") as directory:
            app = prepare_workspace(validate_config(configuration()), ROOT, Path(directory))
            template = read_template(app / "infra/application.yaml")
            parameters = {key: value.get("Default", "") for key, value in template["Parameters"].items()}
            parameters.update(json.loads((app / "infra/production.json").read_text()))

            def evaluate(value):
                if isinstance(value, list):
                    return [evaluate(item) for item in value]
                if not isinstance(value, dict):
                    return value
                if "Ref" in value:
                    return None if value["Ref"] == "AWS::NoValue" else parameters[value["Ref"]]
                if "Fn::If" in value:
                    name, yes, no = value["Fn::If"]
                    return evaluate(yes if evaluate(template["Conditions"][name]) else no)
                if "Fn::Equals" in value:
                    left, right = evaluate(value["Fn::Equals"])
                    return left == right
                if "Fn::Not" in value:
                    return not evaluate(value["Fn::Not"][0])
                if "Fn::And" in value:
                    return all(evaluate(value["Fn::And"]))
                return {key: evaluate(item) for key, item in value.items()}

            config = template["Resources"]["Distribution"]["Properties"]["DistributionConfig"]
            self.assertEqual(evaluate(config["ViewerCertificate"]), {"CloudFrontDefaultCertificate": True})
            self.assertIsNone(evaluate(config["Aliases"]))
            alb = next(item for item in config["Origins"] if item.get("Id") == "jeju-alb")
            self.assertEqual(evaluate(alb["CustomOriginConfig"]["OriginProtocolPolicy"]), "http-only")
            self.assertEqual(parameters["OriginTlsEnabled"], "false")
            self.assertEqual(parameters["ViewerDomainName"], "")
            data = read_template(app / "infra/data.yaml")
            self.assertEqual(data["Parameters"]["PublicMediaOrigin"]["Default"], "")
            self.assertTrue((app / "scripts/workshop_cloudfront.py").is_file())
            no_aws = Mock(side_effect=AssertionError("Do not query certificate stacks"))
            optional = load_function(app / "scripts/deploy.py", "optional_stack_outputs",
                                     {"stack_client": no_aws})
            for kind in ("origin", "origin-routing", "tls-probe"):
                self.assertEqual(optional(Mock(), kind), {})
            plan = load_function(app / "scripts/deploy.py", "plan")
            with self.assertRaises(ValueError):
                plan(Mock(), "origin")
        self.assertEqual(before, {name: (ROOT / name).read_bytes() for name in protected})

    def test_verification_commands_receive_participant_url_and_image(self):
        with tempfile.TemporaryDirectory(prefix="atlas-cf-run-") as directory:
            app = Path(directory)
            (app / ".local").mkdir()
            image = "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/jeju-atlas-lab-team01@sha256:" + "a" * 64
            (app / ".local/image.json").write_text(json.dumps({"imageUri": image}))
            cf, session = Mock(), Mock()
            cf.describe_stacks.return_value = {"Stacks": [self.stack()]}
            session.client.return_value = cf
            with patch.object(lab, "verify_workspace", return_value=app), \
                    patch.object(lab, "aws_session", return_value=session), \
                    patch.object(lab.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as run, \
                    redirect_stdout(io.StringIO()):
                lab.run_step(configuration(), SimpleNamespace(step="verify-terrain", execute=True))
                command = run.call_args.args[0]
                self.assertIn("--url", command)
                self.assertEqual(command[command.index("--url") + 1], URL)
                lab.run_step(configuration(), SimpleNamespace(step="verify-assets", execute=True))
                command = run.call_args.args[0]
                self.assertIn("--image-uri", command)
                self.assertEqual(command[command.index("--image-uri") + 1], image)

    def test_cleanup_does_not_target_certificate_or_origin_function_stacks(self):
        session, cf = Mock(), Mock()
        session.client.return_value = cf
        from botocore.exceptions import ClientError
        queried = []
        def missing(**kwargs):
            queried.append(kwargs["StackName"])
            raise ClientError({"Error": {"Code": "ValidationError", "Message": "does not exist"}}, "DescribeStacks")
        cf.describe_stacks.side_effect = missing
        self.assertEqual(lab.cleanup_inventory(configuration(), session), [])
        self.assertTrue(queried)
        self.assertFalse(any(name.endswith(("Origin", "OriginRouting", "TlsProbe")) for name in queried))


if __name__ == "__main__":
    unittest.main()
