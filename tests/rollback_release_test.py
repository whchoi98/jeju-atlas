"""Image-only rollback contracts; every AWS boundary is an in-memory fixture."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
ACCOUNT = "061525506239"
REGION = "ap-northeast-2"
REPOSITORY = f"{ACCOUNT}.dkr.ecr.{REGION}.amazonaws.com/jeju-3d"
DIGESTS = {
    "release-20260910T180902Z": "sha256:0ef30ebd2d916a26fcc53eeee47a92c5483c55aef408c836e5a49c25880f671b",
    "release-20260910T173044Z": "sha256:9c3959d38054d2d6c3715439b897ae1204f4059a8f4724409399d32ab46b35b7",
}
TARGET = "release-20260910T173044Z"
CURRENT = "release-20260910T180902Z"
STACK = f"arn:aws:cloudformation:{REGION}:{ACCOUNT}:stack/Jeju3dApp/test-stack"
TASK = f"arn:aws:ecs:{REGION}:{ACCOUNT}:task-definition/jeju-3d:10"


def change(name, kind, replacement, property_name, source, cause, evaluation):
    return {"Type": "Resource", "ResourceChange": {
        "Action": "Modify", "LogicalResourceId": name, "ResourceType": kind,
        "Replacement": replacement, "Scope": ["Properties"], "Details": [{
            "Target": {"Attribute": "Properties", "Name": property_name,
                       "RequiresRecreation": "Always" if replacement != "False" else "Never"},
            "ChangeSource": source, "CausingEntity": cause, "Evaluation": evaluation,
        }],
    }}


class AWSFixture:
    def __init__(self):
        self.parameters = {
            "ImageUri": f"{REPOSITORY}@{DIGESTS[CURRENT]}", "Release": CURRENT,
            "DesiredCount": "2", "MinTaskCount": "2", "MaxTaskCount": "4",
            "ViewerDomainName": "jeju-atlas.whchoi.net", "OriginTlsEnabled": "true",
            "OriginTlsMode": "canonical-host", "OriginHostFunctionVersionArn": "owned-function:7",
            "GuideDailyLimit": "30", "GuideHourlyLimit": "5", "GuideGlobalConcurrency": "2",
            "VpcId": "existing-vpc", "PrivateSubnetIds": "existing-a,existing-b",
            "WebAclArn": "owned-waf", "FutureProtectedParameter": "DO_NOT_EMIT_TEST_SECRET",
        }
        self.updated = datetime(2026, 9, 10, 18, 30, tzinfo=timezone.utc)
        self.status = "UPDATE_COMPLETE"
        self.desired = 3
        self.task_image = self.parameters["ImageUri"]
        self.task_release = CURRENT
        self.deployment_id = "ecs-svc/original"
        self.template = {"Resources": {
            "TaskDefinition": {"Type": "AWS::ECS::TaskDefinition", "Properties": {
                "ContainerDefinitions": [{"Name": "web", "Image": {"Ref": "ImageUri"}}]}},
            "Service": {"Type": "AWS::ECS::Service", "Properties": {
                "ServiceName": "jeju-3d", "TaskDefinition": {"Ref": "TaskDefinition"}}},
            "Distribution": {"Type": "AWS::CloudFront::Distribution", "Properties": {"Protected": True}},
        }}
        self.changes = [
            change("TaskDefinition", "AWS::ECS::TaskDefinition", "True", "ContainerDefinitions",
                   "ParameterReference", "ImageUri", "Static"),
            change("Service", "AWS::ECS::Service", "False", "TaskDefinition",
                   "ResourceReference", "TaskDefinition", "Dynamic"),
            change("ScalableTarget", "AWS::ApplicationAutoScaling::ScalableTarget", "Conditional", "ResourceId",
                   "ResourceAttribute", "Service.Name", "Dynamic"),
            change("CpuScalingPolicy", "AWS::ApplicationAutoScaling::ScalingPolicy", "Conditional", "ScalingTargetId",
                   "ResourceReference", "ScalableTarget", "Dynamic"),
            change("MemoryScalingPolicy", "AWS::ApplicationAutoScaling::ScalingPolicy", "Conditional", "ScalingTargetId",
                   "ResourceReference", "ScalableTarget", "Dynamic"),
        ]
        self.create_calls = []
        self.execute_calls = []
        self.ecr_calls = []
        self.clients = []
        self.bad_digest = False
        self.execute_error = False
        self.extra_page = []

    def client(self, name, **kwargs):
        assert name in {"cloudformation", "ecs", "ecr"}
        self.clients.append(name)
        return self

    def describe_stacks(self, **kwargs):
        assert kwargs["StackName"] in ("Jeju3dApp", STACK)
        return {"Stacks": [{
            "StackName": "Jeju3dApp", "StackId": STACK, "StackStatus": self.status,
            "CreationTime": self.updated - timedelta(days=1), "LastUpdatedTime": self.updated,
            "Parameters": [{"ParameterKey": key, "ParameterValue": value} for key, value in self.parameters.items()],
            "Capabilities": ["CAPABILITY_IAM"],
            "Outputs": [{"OutputKey": key, "OutputValue": value} for key, value in {
                "ClusterName": "jeju-3d", "ServiceName": "jeju-3d", "TaskDefinitionArn": TASK,
            }.items()],
        }]}

    def describe_services(self, **kwargs):
        assert kwargs == {"cluster": "jeju-3d", "services": ["jeju-3d"]}
        return {"services": [{
            "serviceName": "jeju-3d", "status": "ACTIVE", "taskDefinition": TASK,
            "desiredCount": self.desired, "runningCount": self.desired, "pendingCount": 0,
            "deployments": [{"id": self.deployment_id, "rolloutState": "COMPLETED"}],
        }]}

    def describe_task_definition(self, **kwargs):
        assert kwargs == {"taskDefinition": TASK}
        return {"taskDefinition": {"family": "jeju-3d", "containerDefinitions": [{
            "name": "web", "image": self.task_image,
            "environment": [{"name": "RELEASE", "value": self.task_release}],
        }]}}

    def get_template(self, **kwargs):
        assert kwargs["StackName"] in ("Jeju3dApp", STACK)
        assert kwargs["TemplateStage"] == "Original"
        return {"TemplateBody": deepcopy(self.candidate_template if kwargs.get("ChangeSetName") else self.template)}

    def describe_images(self, **kwargs):
        self.ecr_calls.append(kwargs)
        assert kwargs["registryId"] == ACCOUNT and kwargs["repositoryName"] == "jeju-3d"
        release = kwargs["imageIds"][0]["imageTag"]
        return {"imageDetails": [{
            "imageDigest": "sha256:" + "f" * 64 if self.bad_digest else DIGESTS[release],
            "imageTags": [release], "repositoryName": "jeju-3d", "registryId": ACCOUNT,
        }]}

    def create_change_set(self, **kwargs):
        self.create_calls.append(deepcopy(kwargs))
        assert kwargs["StackName"] in ("Jeju3dApp", STACK)
        self.candidate_template = deepcopy(self.template)
        self.change_set_id = f"arn:aws:cloudformation:{REGION}:{ACCOUNT}:changeSet/{kwargs['ChangeSetName']}/test-id"
        self.review = {
            "StackName": "Jeju3dApp", "StackId": STACK, "ChangeSetId": self.change_set_id,
            "ChangeSetName": kwargs["ChangeSetName"], "Description": kwargs["Description"],
            "Status": "CREATE_COMPLETE", "ExecutionStatus": "AVAILABLE",
            "Parameters": deepcopy(kwargs["Parameters"]), "Changes": deepcopy(self.changes),
        }
        return {"Id": self.change_set_id, "StackId": STACK}

    def describe_change_set(self, **kwargs):
        assert kwargs["ChangeSetName"] == self.change_set_id
        result = deepcopy(self.review)
        if kwargs.get("NextToken"):
            assert kwargs["NextToken"] == "more"
            result["Changes"] = deepcopy(self.extra_page)
        elif self.extra_page:
            result["NextToken"] = "more"
        return result

    def execute_change_set(self, **kwargs):
        self.execute_calls.append(kwargs)
        assert kwargs["ChangeSetName"] == self.change_set_id
        if self.execute_error:
            raise RuntimeError("DO_NOT_EMIT_TEST_SECRET")
        return {}


class RollbackReleaseTest(unittest.TestCase):
    def setUp(self):
        path = ROOT / "scripts/rollback-release.py"
        self.assertTrue(path.is_file(), "Rollback utility is not implemented")
        spec = importlib.util.spec_from_file_location("rollback_test_deploy", ROOT / "scripts/deploy.py")
        deploy = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(deploy)
        spec = importlib.util.spec_from_file_location("rollback_release", path)
        self.module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"deploy": deploy}):
            spec.loader.exec_module(self.module)
        self.temp = tempfile.TemporaryDirectory(prefix="jeju-rollback-test-")
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "rollback-change-set.json"
        self.aws = AWSFixture()

    def plan(self, release=TARGET):
        return self.module.plan(self.aws, release, plan_path=self.path, sleep=lambda _: None)

    def apply(self, release=TARGET, execute=True):
        return self.module.apply(self.aws, release, plan_path=self.path, execute=execute)

    def test_plan_uses_current_template_preserves_every_protected_parameter_and_actual_capacity(self):
        for desired in (2, 3, 4):
            with self.subTest(desired=desired):
                self.aws.desired = desired
                report = self.plan()
                request = self.aws.create_calls[-1]
                self.assertTrue(request["UsePreviousTemplate"])
                self.assertNotIn("TemplateBody", request)
                self.assertNotIn("TemplateURL", request)
                self.assertEqual(request["ChangeSetType"], "UPDATE")
                parameters = {item["ParameterKey"]: item for item in request["Parameters"]}
                self.assertEqual(set(parameters), set(self.aws.parameters))
                for key in set(parameters) - {"ImageUri", "Release", "DesiredCount"}:
                    self.assertEqual(parameters[key], {"ParameterKey": key, "UsePreviousValue": True})
                self.assertEqual(parameters["DesiredCount"]["ParameterValue"], str(desired))
                self.assertEqual(parameters["ImageUri"]["ParameterValue"], f"{REPOSITORY}@{DIGESTS[TARGET]}")
                self.assertEqual(parameters["Release"]["ParameterValue"], TARGET)
                self.assertEqual(report["base"]["currentImage"], self.aws.task_image)
                self.assertEqual(report["base"]["stackLastUpdatedTime"], self.aws.updated.isoformat())
                self.assertEqual(report["status"], "REVIEWABLE")
                self.assertEqual(self.aws.execute_calls, [])
                self.assertNotIn("DO_NOT_EMIT_TEST_SECRET", self.path.read_text())
                self.assertFalse((self.path.parent / "app-change-set.json").exists())

    def test_both_exact_approved_images_can_be_planned(self):
        for target, current in [(TARGET, CURRENT), (CURRENT, TARGET)]:
            with self.subTest(target=target):
                self.aws.parameters.update(ImageUri=f"{REPOSITORY}@{DIGESTS[current]}", Release=current)
                self.aws.task_image = self.aws.parameters["ImageUri"]
                self.aws.task_release = current
                report = self.plan(target)
                self.assertEqual(report["target"]["imageUri"], f"{REPOSITORY}@{DIGESTS[target]}")

    def test_unknown_release_or_ecr_digest_mismatch_cannot_create_a_change_set(self):
        with self.assertRaises(self.module.RollbackError):
            self.plan("release-unapproved")
        self.assertEqual(self.aws.create_calls, [])
        self.assertEqual(self.aws.ecr_calls, [])
        self.aws.bad_digest = True
        with self.assertRaises(self.module.RollbackError):
            self.plan()
        self.assertEqual(self.aws.create_calls, [])

    def test_shared_assets_must_be_published_for_the_selected_image(self):
        bucket = f"jeju-3d-assets-{ACCOUNT}-{REGION}"
        self.aws.parameters["AssetsBucketDomainName"] = f"{bucket}.s3.{REGION}.amazonaws.com"
        with patch.object(self.module, "require_asset_manifest", side_effect=ValueError("missing publication")):
            with self.assertRaises(ValueError):
                self.plan()
        self.assertEqual(self.aws.create_calls, [])
        with patch.object(self.module, "require_asset_manifest", return_value={}) as published:
            self.plan()
            published.assert_called_once_with(self.aws, bucket, f"{REPOSITORY}@{DIGESTS[TARGET]}")

    def test_unstable_stack_and_out_of_bounds_capacity_are_rejected_before_plan(self):
        for status, desired in [("UPDATE_IN_PROGRESS", 3), ("DELETE_IN_PROGRESS", 3),
                                ("UPDATE_COMPLETE", 1), ("UPDATE_COMPLETE", 5)]:
            with self.subTest(status=status, desired=desired):
                self.aws.status, self.aws.desired = status, desired
                with self.assertRaises(self.module.RollbackError):
                    self.plan()
                self.assertEqual(self.aws.create_calls, [])

    def test_stale_timestamp_image_template_parameter_or_capacity_blocks_apply(self):
        for field in ("timestamp", "image", "template", "parameter", "capacity", "deployment"):
            with self.subTest(field=field):
                self.aws = AWSFixture()
                self.plan()
                if field == "timestamp":
                    self.aws.updated += timedelta(seconds=1)
                elif field == "image":
                    self.aws.task_image = f"{REPOSITORY}@sha256:" + "e" * 64
                elif field == "template":
                    self.aws.template["Resources"]["Distribution"]["Properties"]["Protected"] = False
                elif field == "parameter":
                    self.aws.parameters["OriginTlsMode"] = "dns"
                elif field == "capacity":
                    self.aws.desired = 4
                else:
                    self.aws.deployment_id = "ecs-svc/other"
                with self.assertRaises(self.module.RollbackError):
                    self.apply()
                self.assertEqual(self.aws.execute_calls, [])

    def test_broadened_destructive_or_static_scaling_changes_block_apply(self):
        for kind in ("role", "distribution", "remove", "add", "service-replacement",
                     "task-role", "network", "scaling-limit", "static-scaling"):
            with self.subTest(kind=kind):
                self.aws = AWSFixture()
                self.plan()
                changes = self.aws.review["Changes"]
                if kind in ("role", "distribution"):
                    changes.append(change("TaskRole" if kind == "role" else "Distribution",
                                          "AWS::IAM::Role" if kind == "role" else "AWS::CloudFront::Distribution",
                                          "False", "Policies", "DirectModification", "", "Static"))
                elif kind in ("remove", "add"):
                    changes[0]["ResourceChange"]["Action"] = kind.title()
                elif kind == "service-replacement":
                    changes[1]["ResourceChange"]["Replacement"] = "True"
                else:
                    index, name = {"task-role": (0, "TaskRoleArn"), "network": (1, "NetworkConfiguration"),
                                   "scaling-limit": (2, "MinCapacity"), "static-scaling": (3, "ScalingTargetId")}[kind]
                    detail = changes[index]["ResourceChange"]["Details"][0]
                    detail["Target"]["Name"] = name
                    if kind == "static-scaling":
                        detail["Evaluation"] = "Static"
                with self.assertRaises(self.module.RollbackError):
                    self.apply()
                self.assertEqual(self.aws.execute_calls, [])

    def test_changes_on_later_pages_are_not_hidden(self):
        self.plan()
        self.aws.extra_page = [change("TaskRole", "AWS::IAM::Role", "False", "Policies", "DirectModification", "", "Static")]
        with self.assertRaises(self.module.RollbackError):
            self.apply()
        self.assertEqual(self.aws.execute_calls, [])

    def test_change_set_template_and_protected_parameters_are_revalidated(self):
        for kind in ("template", "protected", "target", "desired", "missing", "unavailable"):
            with self.subTest(kind=kind):
                self.aws = AWSFixture()
                self.plan()
                if kind == "template":
                    self.aws.candidate_template["Resources"]["Distribution"]["Properties"]["Protected"] = False
                elif kind == "unavailable":
                    self.aws.review["ExecutionStatus"] = "OBSOLETE"
                else:
                    key = {"protected": "OriginTlsMode", "target": "ImageUri", "desired": "DesiredCount", "missing": "VpcId"}[kind]
                    values = self.aws.review["Parameters"]
                    values[:] = [value for value in values if value["ParameterKey"] != key]
                    if kind != "missing":
                        values.append({"ParameterKey": key, "ParameterValue": "wrong"})
                with self.assertRaises(self.module.RollbackError):
                    self.apply()
                self.assertEqual(self.aws.execute_calls, [])

    def test_ecr_is_rechecked_and_apply_requires_explicit_matching_release(self):
        self.plan()
        with self.assertRaises(self.module.RollbackError):
            self.apply(execute=False)
        with self.assertRaises(self.module.RollbackError):
            self.apply(CURRENT)
        self.aws.bad_digest = True
        with self.assertRaises(self.module.RollbackError):
            self.apply()
        self.assertEqual(self.aws.execute_calls, [])

    def test_valid_apply_executes_once_and_does_not_claim_rollout_complete(self):
        self.plan()
        report = self.apply()
        self.assertEqual(len(self.aws.execute_calls), 1)
        self.assertEqual(report["status"], "EXECUTING")
        self.assertTrue(self.aws.execute_calls[0]["ClientRequestToken"])
        with self.assertRaises(self.module.RollbackError):
            self.apply()
        self.assertEqual(len(self.aws.execute_calls), 1)

    def test_uncertain_execute_result_is_not_retried(self):
        self.plan()
        self.aws.execute_error = True
        with self.assertRaises(self.module.RollbackError):
            self.apply()
        self.assertEqual(json.loads(self.path.read_text())["status"], "EXECUTION_UNKNOWN")
        with self.assertRaises(self.module.RollbackError):
            self.apply()
        self.assertEqual(len(self.aws.execute_calls), 1)
        self.assertNotIn("DO_NOT_EMIT_TEST_SECRET", self.path.read_text())


if __name__ == "__main__":
    unittest.main()
