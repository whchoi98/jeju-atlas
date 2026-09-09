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


if __name__ == "__main__":
    unittest.main()
