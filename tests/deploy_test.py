"""Exercise the CloudFormation request contract without modifying AWS."""
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import warnings

warnings.filterwarnings("ignore", category=DeprecationWarning)
import boto3
from botocore.stub import ANY, Stubber

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("jeju_deploy", root / "scripts/deploy.py")
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class ChangeSetPlanningTest(unittest.TestCase):
    def test_replan_of_unexecuted_stack_uses_create(self):
        """Using UPDATE for REVIEW_IN_PROGRESS must fail the API contract."""
        cf = boto3.client(
            "cloudformation", region_name="ap-northeast-2",
            aws_access_key_id="test-key", aws_secret_access_key="test-secret",
        )
        arn = "arn:aws:cloudformation:ap-northeast-2:061525506239:changeSet/test/id"
        stubber = Stubber(cf)
        stubber.add_response("describe_stacks", {
            "Stacks": [{
                "StackName": "Jeju3dRegistry",
                "CreationTime": datetime(2026, 9, 9, tzinfo=timezone.utc),
                "StackStatus": "REVIEW_IN_PROGRESS",
            }],
        }, {"StackName": "Jeju3dRegistry"})
        stubber.add_response("create_change_set", {"Id": arn}, {
            "StackName": "Jeju3dRegistry",
            "ChangeSetName": ANY,
            "ChangeSetType": "CREATE",
            "Description": ANY,
            "TemplateBody": ANY,
            "Parameters": [],
            "Capabilities": ["CAPABILITY_IAM"],
            "Tags": ANY,
        })
        stubber.add_response("describe_change_set", {
            "Status": "CREATE_COMPLETE",
            "Changes": [{
                "Type": "Resource",
                "ResourceChange": {
                    "Action": "Add", "LogicalResourceId": "Repository",
                    "ResourceType": "AWS::ECR::Repository",
                },
            }],
        }, {"ChangeSetName": arn})

        class Session:
            def client(self, service):
                if service != "cloudformation":
                    raise AssertionError(f"Unexpected service: {service}")
                return cf

        with tempfile.TemporaryDirectory(prefix="jeju-plan-test-") as temp:
            with patch.object(deploy, "LOCAL", Path(temp)), stubber:
                deploy.plan(Session(), "bootstrap")
                result = json.loads((Path(temp) / "bootstrap-change-set.json").read_text())
                self.assertEqual(result["type"], "CREATE")
                self.assertEqual(result["changes"][0]["Action"], "Add")
                stubber.assert_no_pending_responses()


class ProductionSettingsTest(unittest.TestCase):
    def config(self, **changes):
        values = {
            "ViewerDomainName": "jeju-atlas.whchoi.net",
            "ViewerCertificateArn": "arn:aws:acm:us-east-1:061525506239:certificate/7d53182a-2a2a-4225-a319-4f94030561b7",
            "DesiredCount": 2,
        }
        values.update(changes)
        return values

    def test_current_domain_and_certificate_are_explicit_deployment_parameters(self):
        settings = deploy.validate_settings(self.config())
        self.assertEqual(settings["ViewerDomainName"], "jeju-atlas.whchoi.net")
        self.assertEqual(settings["DesiredCount"], "2")
        self.assertIn(":us-east-1:", settings["ViewerCertificateArn"])

    def test_incomplete_or_wrong_region_certificate_is_rejected_before_aws(self):
        for changes in [
            {"ViewerCertificateArn": ""},
            {"ViewerDomainName": ""},
            {"ViewerCertificateArn": self.config()["ViewerCertificateArn"].replace("us-east-1", "ap-northeast-2")},
            {"ViewerCertificateArn": self.config()["ViewerCertificateArn"].replace("061525506239", "111111111111")},
            {"ViewerDomainName": "https://jeju-atlas.whchoi.net/path"},
            {"DesiredCount": True},
            {"DesiredCount": 0},
            {"DesiredCount": 5},
            {"DesiredCount": 1},
            {"GuideDailyLimit": 31},
            {"GuideHourlyLimit": 6},
            {"GuideGlobalConcurrency": 3},
            {"MinTaskCount": 4, "MaxTaskCount": 2},
            {"OriginTlsEnabled": True},
            {"OriginTlsEnabled": "true"},
            {"OriginTlsEnabled": "true", "OriginDomainName": "jeju-atlas.whchoi.net"},
            {"TargetHealthPath": "/unknown"},
            {"SessionSecret": "must-not-be-a-deploy-setting"},
        ]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                deploy.validate_settings(self.config(**changes))

    def test_live_domain_cannot_silently_disappear_on_redeployment(self):
        live = {
            "Aliases": {"Items": ["jeju-atlas.whchoi.net"], "Quantity": 1},
            "ViewerCertificate": {"ACMCertificateArn": self.config()["ViewerCertificateArn"]},
        }
        deploy.validate_live_domain(self.config(), live)
        with self.assertRaises(ValueError):
            deploy.validate_live_domain(self.config(ViewerDomainName=""), live)
        with self.assertRaises(ValueError):
            deploy.validate_live_domain(self.config(ViewerDomainName="different.whchoi.net"), live)
        with self.assertRaises(ValueError):
            deploy.validate_live_domain(self.config(), {
                **live, "Aliases": {"Items": ["jeju-atlas.whchoi.net", "another.whchoi.net"]},
            })

    def test_existing_autoscaled_capacity_is_not_reset_to_minimum(self):
        self.assertEqual(deploy.preserved_desired_count(2, 4, 4), "4")
        self.assertEqual(deploy.preserved_desired_count(2, 1, 4), "2")
        with self.assertRaises(ValueError):
            deploy.preserved_desired_count(2, 5, 4)

    def test_readiness_migration_cannot_make_legacy_targets_unhealthy_during_rollout(self):
        deploy.validate_readiness_transition("/healthz", "/healthz", False, False)
        deploy.validate_readiness_transition("/healthz", "/readyz", True, True)
        deploy.validate_readiness_transition("/readyz", "/readyz", True, False)
        for supported, stable in ((False, True), (True, False), (False, False)):
            with self.subTest(supported=supported, stable=stable), self.assertRaises(ValueError):
                deploy.validate_readiness_transition("/healthz", "/readyz", supported, stable)


if __name__ == "__main__":
    unittest.main()
