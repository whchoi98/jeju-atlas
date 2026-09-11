"""Offline execution-boundary regressions; no real AWS clients or model calls.

The review intentionally leaves failing regressions for the parent to fix.
Only temporary participant copies are modified.
"""
import ast
import importlib.util
import json
from pathlib import Path
import re
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "workshop/scripts"))

import lab
import lab_artifacts
from lab_config import resource_names, validate_config, write_json
from lab_workspace import prepare_workspace, read_template


def configuration(**changes):
    return validate_config({
        "participant": "team01",
        "accountId": "123456789012",
        "vpcName": "training-vpc",
        "network": {
            "vpcId": "vpc-00000000000000001",
            "publicSubnetIds": [
                "subnet-00000000000000001", "subnet-00000000000000002",
            ],
            "privateSubnetIds": [
                "subnet-00000000000000003", "subnet-00000000000000004",
            ],
            "cloudFrontPrefixListId": "pl-00000000000000001",
        },
        **changes,
    }, require_network=True)


def source_function(path, name, namespace):
    """Load a function definition without importing an AWS-capable deployer."""
    tree = ast.parse(Path(path).read_text())
    node = next(item for item in tree.body
                if isinstance(item, ast.FunctionDef) and item.name == name)
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(path), "exec"),
         namespace)
    return namespace[name]


class LabExecutionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="atlas-execution-review-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.config = configuration()
        self.app = prepare_workspace(self.config, ROOT, self.directory / "labs")
        self.config_path = self.directory / "config.json"
        write_json(self.config_path, self.config)
        self.addCleanup(patch.stopall)
        patch.object(lab, "workspace_path", return_value=self.app).start()
        patch.object(lab, "emit").start()
        patch.object(lab, "aws_session",
                     side_effect=AssertionError("Real AWS access is forbidden")).start()

    def test_data_parameters_bootstrap_before_app_without_fake_distribution(self):
        network = Mock()
        optional = Mock(return_value={})
        names = resource_names(self.config)
        parameters = source_function(
            self.app / "scripts/deploy.py", "infrastructure_parameters", {
                "optional_stack_outputs": optional,
                "assert_network": network,
                "OWN_CATALOG_BUCKET": names["dataBucket"],
                "VPC": self.config["network"]["vpcId"],
                "PRIVATE": self.config["network"]["privateSubnetIds"],
            })
        session = Mock()
        session.client.side_effect = AssertionError("No real AWS client")
        values = parameters(session, "data")
        self.assertEqual(values["DistributionArn"], "")
        self.assertEqual(values["CatalogBucket"], names["dataBucket"])
        self.assertEqual(values["ScheduleState"], "DISABLED")
        self.assertNotIn("WorkerImageUri", values)
        optional.assert_called_once_with(session, "app")
        network.assert_called_once_with(session)

    def test_every_run_step_defaults_to_no_aws_or_subprocess(self):
        steps = (lab.DEPLOY_STEPS | set(lab.AGENT_STEPS)
                 | set(lab.LOCAL_STEPS) | set(lab.VERIFICATION_STEPS))
        with patch.object(lab.subprocess, "run",
                          side_effect=AssertionError("Dry-run executed a process")):
            for step in sorted(steps):
                with self.subTest(step=step):
                    lab.run_step(self.config, SimpleNamespace(step=step, execute=False))
        self.assertFalse((self.app / ".local/workshop-last-step.json").exists())

    def test_ssm_input_and_worker_policy_use_the_same_team_prefix(self):
        names = resource_names(self.config)
        template = read_template(self.app / "infra/data.yaml")
        statements = template["Resources"]["WorkerRole"]["Properties"]["Policies"][0][
            "PolicyDocument"]["Statement"]
        resources = next(row["Resource"] for row in statements
                         if row.get("Action") == "ssm:GetParameters")
        arns = [item["Fn::Sub"] for item in resources]
        collector = (self.app / "scripts/fetch-place-details.py").read_text()
        for provider, suffix in [
            ("tourapi", "tourapi-service-key"),
            ("visitjeju", "visitjeju-api-key"),
        ]:
            name = "/" + names["project"] + "/" + suffix
            lab.set_provider_secret(self.config, SimpleNamespace(
                provider=provider, execute=False))
            self.assertIn(name, collector)
            self.assertTrue(any(arn.endswith(":parameter" + name) for arn in arns))
        self.assertNotIn(":parameter/jeju-atlas/", json.dumps(resources))

    def test_initial_owned_domain_is_accepted_by_origin_function_template(self):
        domain = "team01.training.example.org"
        configured = configuration(
            domainName=domain,
            viewerCertificateArn=(
                "arn:aws:acm:us-east-1:123456789012:certificate/"
                "11111111-1111-1111-1111-111111111111"),
        )
        app = prepare_workspace(configured, ROOT, self.directory / "domain-labs")
        template = read_template(app / "infra/origin-routing.yaml")
        pattern = template["Parameters"]["CanonicalHostName"]["AllowedPattern"]
        self.assertIsNotNone(
            re.fullmatch(pattern, domain),
            f"The rendered canonical-host pattern rejects the configured host: {pattern}",
        )

    def test_configure_domain_rebinds_origin_certificate_after_blank_prepare(self):
        args = SimpleNamespace(
            domain="team01.training.example.org",
            viewer_certificate=(
                "arn:aws:acm:us-east-1:123456789012:certificate/"
                "11111111-1111-1111-1111-111111111111"),
            execute=True, config=self.config_path,
        )
        session = Mock()
        session.client.return_value.describe_certificate.return_value = {
            "Certificate": {
                "Status": "ISSUED", "SubjectAlternativeNames": [args.domain],
            },
        }
        with patch.object(lab, "aws_session", return_value=session):
            lab.configure_domain(self.config, args)
        template = read_template(self.app / "infra/origin.yaml")
        certificate = template["Parameters"]["CertificateDomainName"]["Default"]
        matches = source_function(
            self.app / "scripts/deploy.py", "domain_matches", {})
        self.assertTrue(
            matches(certificate, args.domain),
            f"The origin certificate still targets {certificate}",
        )

    def test_cleanup_retry_preserves_previously_recorded_retained_ids(self):
        names = resource_names(self.config)
        first = [{
            "name": names["stackPrefix"] + "App",
            "arn": "arn:aws:cloudformation:ap-northeast-2:123456789012:stack/lab/app",
            "region": self.config["region"], "status": "CREATE_COMPLETE",
            "resources": [{
                "logicalId": "GuideQuota", "type": "AWS::DynamoDB::Table",
                "physicalId": names["project"] + "-guide-quota",
            }],
        }]
        # After App deletion, a retry can only discover later stacks.
        second = [{
            "name": names["stackPrefix"] + "OriginRouting",
            "arn": "arn:aws:cloudformation:us-east-1:123456789012:stack/lab/edge",
            "region": "us-east-1", "status": "DELETE_FAILED", "resources": [],
        }]
        argv = ["lab.py", "cleanup", "--config", str(self.config_path)]
        with patch.object(lab, "aws_session", return_value=Mock()), \
                patch.object(lab, "cleanup_inventory", side_effect=[first, second]), \
                patch.object(sys, "argv", argv):
            lab.main()
            lab.main()
        receipt = (self.app / ".local/workshop-cleanup-plan.json").read_text()
        self.assertIn(
            names["project"] + "-guide-quota", receipt,
            "Cleanup retries must not erase the only saved IDs of retained resources",
        )

    def test_catalog_bootstrap_also_seeds_first_worker_snapshot(self):
        (self.app / ".local/catalog.sqlite").write_bytes(b"synthetic-catalog")
        deployer = Mock()
        deployer.digest.return_value = "a" * 64
        s3 = Mock()
        s3.put_object.return_value = {"VersionId": "synthetic-version"}
        session = Mock()
        session.client.return_value = s3
        with patch.object(lab_artifacts, "agent_deployer", return_value=deployer):
            lab_artifacts.publish_catalog(self.config, self.app, session)
        published = {call.kwargs["Key"] for call in s3.put_object.call_args_list}
        self.assertIn(
            "place-details/latest.json", published,
            "GetObject-only workers cannot initialize a missing snapshot returning AccessDenied",
        )

    def test_lab_names_accepted_by_config_are_usable_by_cli_preparer(self):
        spec = importlib.util.spec_from_file_location(
            "execution_review_cli_prepare", ROOT / "workshop/cli/prepare.py")
        cli = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cli)
        for participant in ["team01", "prod01", "live01", "shared01"]:
            with self.subTest(participant=participant):
                try:
                    config = configuration(participant=participant)
                except ValueError:
                    continue  # Early, consistent rejection is also a valid fix.
                cli.validate_arguments(
                    resource_names(config)["cliProject"],
                    config["accountId"], config["region"],
                    self.directory / ("cli-" + participant),
                )


if __name__ == "__main__":
    unittest.main()
