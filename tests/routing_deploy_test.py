"""Offline pairing, sizing, and dedicated-agent selection contracts."""
from copy import deepcopy
import base64
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from origin_tls_test import Render as BaseRender

ROOT = Path(__file__).resolve().parents[1]
REPO = "061525506239.dkr.ecr.ap-northeast-2.amazonaws.com/jeju-3d"
ROUTER = REPO + "@sha256:" + "a" * 64
UPDATED = "2026-09-10T20:21:06Z"


class Render(BaseRender):
    def value(self, value):
        if isinstance(value, dict) and "ContainerName" in value and "Condition" in value:
            return {key: self.value(item) for key, item in value.items()}
        if isinstance(value, dict) and "Fn::Contains" in value:
            items, needle = self.value(value["Fn::Contains"])
            if any(not isinstance(item, str) for item in items):
                raise ValueError("CloudFormation rule comparisons require string values")
            return str(needle) in items
        if isinstance(value, dict) and "Fn::Equals" in value:
            operands = value["Fn::Equals"]
            if len(operands) != 2 or any(not isinstance(item, (str, dict)) for item in operands):
                raise ValueError("CloudFormation Fn::Equals requires two string operands")
            left, right = self.value(operands)
            return str(left) == str(right)
        return super().value(value)


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class RoutingDeployTest(unittest.TestCase):
    def setUp(self):
        self.deploy = module("scripts/deploy.py", "mobility_deploy")
        self.image = {"routing": {"imageUri": ROUTER, "dataUpdatedAt": UPDATED}}

    def test_explicit_routing_binds_the_web_image_to_one_router_and_preserves_legacy_defaults(self):
        self.assertTrue(callable(getattr(self.deploy, "routing_parameters", None)))
        enabled = self.deploy.routing_parameters(self.image, {"RoutingEnabled": "true"}, {})
        self.assertEqual(enabled, {
            "RoutingImageUri": ROUTER, "RoutingDataUpdatedAt": UPDATED,
            "TaskCpu": "512", "TaskMemory": "1024", "RoutingMemory": "512",
        })
        legacy = self.deploy.routing_parameters({}, {}, {})
        self.assertEqual(legacy["RoutingImageUri"], "")
        self.assertEqual((legacy["TaskCpu"], legacy["TaskMemory"]), ("256", "512"))

    def test_unpaired_or_implicit_router_changes_are_rejected(self):
        self.assertTrue(callable(getattr(self.deploy, "routing_parameters", None)))
        for image, settings, existing in [
            ({}, {"RoutingEnabled": "true"}, {}),
            (self.image, {}, {}),
            ({}, {}, {"RoutingImageUri": ROUTER}),
            ({"routing": {"imageUri": "https://outside.invalid", "dataUpdatedAt": UPDATED}}, {"RoutingEnabled": "true"}, {}),
            (self.image, {"RoutingEnabled": "true", "TaskCpu": "256", "TaskMemory": "512"}, {}),
        ]:
            with self.subTest(image=image, settings=settings), self.assertRaises(ValueError):
                self.deploy.routing_parameters(image, settings, existing)

    def test_measured_sizing_is_parameterized_without_changing_network_or_guide_values(self):
        self.assertTrue(callable(getattr(self.deploy, "routing_parameters", None)))
        existing = {"GuideRuntimeArn": "protected", "VpcId": "protected", "TaskCpu": "1024", "TaskMemory": "2048"}
        result = self.deploy.routing_parameters(self.image, {"RoutingEnabled": "true", "RoutingMemory": "1024"}, existing)
        self.assertEqual((result["TaskCpu"], result["TaskMemory"], result["RoutingMemory"]), ("1024", "2048", "1024"))
        self.assertNotIn("GuideRuntimeArn", result)
        self.assertNotIn("VpcId", result)
        with self.assertRaises(ValueError):
            self.deploy.routing_parameters(self.image, {"RoutingEnabled": "true", "RoutingMemory": "2048"}, {})
        self.assertFalse(Render({"RoutingImageUri": ROUTER, "TaskCpu": "512", "TaskMemory": "1024",
                                 "RoutingMemory": 1024}).valid_tls_parameters())
        self.assertTrue(Render({"RoutingImageUri": ROUTER, "TaskCpu": "1024", "TaskMemory": "2048",
                                "RoutingMemory": 1024}).valid_tls_parameters())

    def test_new_app_plan_requires_dedicated_outputs_without_shared_fallback(self):
        from types import SimpleNamespace
        settings = {
            "ViewerDomainName": "jeju-atlas.whchoi.net",
            "ViewerCertificateArn": "arn:aws:acm:us-east-1:061525506239:certificate/11111111-1111-1111-1111-111111111111",
        }
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "settings.json").write_text(json.dumps(settings))
            cf = SimpleNamespace()
            with patch.object(self.deploy, "LOCAL", root), patch.object(self.deploy, "SETTINGS", root / "settings.json"), \
                    patch.object(self.deploy, "assert_network"), \
                    patch.object(self.deploy, "load", return_value={"imageUri": REPO + "@sha256:" + "a" * 64,
                                                                  "release": "release-test"}), \
                    patch.object(self.deploy, "stack_outputs", return_value={"RepositoryArn": "owned"}):
                with self.assertRaises(FileNotFoundError):
                    self.deploy.plan(SimpleNamespace(client=lambda *args: cf), "app")
            self.assertEqual(json.loads((root / "app-change-set.json").read_text())["status"], "PLANNING")

    def test_dedicated_agent_output_is_explicit_and_rejects_the_shared_reference(self):
        self.assertTrue(callable(getattr(self.deploy, "atlas_agent_parameters", None)))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "atlas-agent-outputs.json"
            own = "arn:aws:bedrock-agentcore:ap-northeast-2:061525506239:runtime/JejuAtlas_Guide-test"
            bucket = "jeju-3d-data-061525506239-ap-northeast-2"
            path.write_text(json.dumps({"guideRuntimeArn": own, "catalogBucket": bucket}))
            self.assertEqual(self.deploy.atlas_agent_parameters(path), {"GuideRuntimeArn": own, "CatalogBucket": bucket})
            for arn, catalog in [
                (own.replace("JejuAtlas_Guide-test", "Ohmyjeju_OhmyjejuAgent-shared"), bucket),
                (own, "ohmyjeju-catalog-shared"),
            ]:
                path.write_text(json.dumps({"guideRuntimeArn": arn, "catalogBucket": catalog}))
                with self.assertRaises(ValueError):
                    self.deploy.atlas_agent_parameters(path)

    def test_template_preserves_the_no_router_task_and_only_adds_a_local_optional_sidecar(self):
        baseline = Render({}).resource("TaskDefinition")
        self.assertEqual((baseline["Cpu"], baseline["Memory"]), ("256", "512"))
        self.assertEqual([item["Name"] for item in baseline["ContainerDefinitions"]], ["web"])
        self.assertEqual(baseline["Volumes"], [{"Name": "catalog-cache"}])
        self.assertNotIn("Default", Render({}).template["Parameters"]["GuideRuntimeArn"])
        self.assertEqual(Render({}).template["Parameters"]["CatalogBucket"]["Default"],
                         "jeju-3d-data-061525506239-ap-northeast-2")
        template = Render({"RoutingImageUri": ROUTER, "RoutingDataUpdatedAt": UPDATED,
                           "TaskCpu": "512", "TaskMemory": "1024"})
        task = template.resource("TaskDefinition")
        containers = {item["Name"]: item for item in task["ContainerDefinitions"]}
        self.assertIn("routing", containers)
        routing = containers["routing"]
        self.assertFalse(routing["Essential"])
        self.assertTrue(routing["ReadonlyRootFilesystem"])
        self.assertEqual(routing["User"], "65532:65532")
        self.assertNotIn("PortMappings", routing)
        self.assertNotIn("Secrets", routing)
        self.assertTrue(routing["RestartPolicy"]["Enabled"])
        environment = {item["Name"]: item["Value"] for item in containers["web"]["Environment"]}
        self.assertEqual(environment["ROUTING_URL"], "http://127.0.0.1:8002")
        self.assertEqual(environment["ROUTING_DATA_UPDATED_AT"], UPDATED)
        self.assertEqual(template.resource("Service")["LoadBalancers"][0]["ContainerPort"], 8080)
        self.assertTrue(template.resource("Service")["DeploymentConfiguration"]["DeploymentCircuitBreaker"]["Rollback"])

    def test_data_worker_receives_the_owned_catalog_bucket_explicitly(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(self.deploy, "ROOT", Path(directory)), \
                patch.object(self.deploy, "LOCAL", Path(directory)), \
                patch.object(self.deploy, "assert_network"), \
                patch.object(self.deploy, "optional_stack_outputs", return_value={}), \
                patch.object(self.deploy, "stack_outputs", return_value={"DistributionId": "owned"}):
            from types import SimpleNamespace
            values = self.deploy.infrastructure_parameters(SimpleNamespace(client=lambda *args: object()), "data")
        self.assertEqual(values.get("CatalogBucket"), "jeju-3d-data-061525506239-ap-northeast-2")

    def test_manual_rollback_targets_a_complete_approved_pair(self):
        with patch.dict(sys.modules, {"deploy": self.deploy}):
            rollback = module("scripts/rollback-release.py", "mobility_rollback")
        release = "release-mobility-test"
        record = {"digest": "sha256:" + "b" * 64, "routing": self.image["routing"]}
        with patch.dict(rollback.APPROVED_RELEASES, {release: record}):
            try:
                target = rollback.approved_image(release)
            except Exception as error:
                self.fail(f"Approved routing pair is not supported: {type(error).__name__}")
        self.assertEqual(target["routing"], self.image["routing"])
        parameters = {"ImageUri": "old", "Release": "old", "DesiredCount": "2",
                      "RoutingImageUri": "old-router", "RoutingDataUpdatedAt": "",
                      "TaskCpu": "1024", "TaskMemory": "2048", "GuideRuntimeArn": "protected"}
        values = {item["ParameterKey"]: item for item in rollback.rollback_parameters(parameters, {"desiredCount": 3}, target)}
        self.assertEqual(values["RoutingImageUri"]["ParameterValue"], ROUTER)
        self.assertEqual(values["RoutingDataUpdatedAt"]["ParameterValue"], UPDATED)
        self.assertTrue(values["TaskMemory"]["UsePreviousValue"])
        self.assertTrue(values["GuideRuntimeArn"]["UsePreviousValue"])
        legacy = rollback.approved_image("release-20260910T180902Z")
        values = {item["ParameterKey"]: item for item in rollback.rollback_parameters(parameters, {"desiredCount": 3}, legacy)}
        self.assertEqual(values["RoutingImageUri"]["ParameterValue"], "")
        self.assertEqual(values["RoutingDataUpdatedAt"]["ParameterValue"], "")

    def test_routing_build_refreshes_os_patches_without_forwarding_credentials_or_publishing_web_assets(self):
        from types import SimpleNamespace
        digest = "sha256:" + "a" * 64
        ecr = SimpleNamespace(
            get_authorization_token=lambda: {"authorizationData": [{
                "authorizationToken": base64.b64encode(b"AWS:PRIVATE_TEST_PASSWORD").decode(),
                "proxyEndpoint": "https://061525506239.dkr.ecr.ap-northeast-2.amazonaws.com",
            }]},
            describe_images=lambda **kwargs: {"imageDetails": [{"imageDigest": digest}]},
        )
        session = SimpleNamespace(client=lambda service: ecr if service == "ecr" else object())
        metadata = {"engineVersion": "3.8.3", "dataUpdatedAt": UPDATED}
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(self.deploy, "LOCAL", Path(directory)), \
                patch.object(self.deploy, "stack_outputs", return_value={"RepositoryUri": REPO}), \
                patch.object(self.deploy, "routing_source", return_value=metadata), \
                patch.object(self.deploy.subprocess, "run") as commands, \
                patch.object(self.deploy, "emit") as emitted, \
                patch.object(self.deploy, "optional_stack_outputs") as optional:
            self.deploy.build_push(session, routing_worker=True)
            record = json.loads((Path(directory) / "routing-image.json").read_text())
            self.assertFalse((Path(directory) / "image.json").exists())
        build = next(call.args[0] for call in commands.call_args_list if call.args[0][:2] == ["docker", "build"])
        self.assertIn("Dockerfile.routing", build)
        self.assertEqual(build[build.index("--network") + 1], "default")
        self.assertIn("--no-cache", build, "Every routing release must refresh the pinned base's OS fixes")
        self.assertFalse({"--secret", "--ssh", "--build-arg"} & set(build))
        self.assertEqual(record["imageUri"], ROUTER)
        self.assertEqual(record["dataUpdatedAt"], UPDATED)
        self.assertIn("routing-release-", record["release"])
        self.assertNotIn("PRIVATE_TEST_PASSWORD", json.dumps(emitted.call_args.args[0]))
        optional.assert_not_called()

    def test_full_rollback_plan_and_apply_restore_both_pinned_images(self):
        from rollback_release_test import AWSFixture, TARGET
        class PairedFixture(AWSFixture):
            def describe_task_definition(inner, **kwargs):
                result = super(PairedFixture, inner).describe_task_definition(**kwargs)
                web = result["taskDefinition"]["containerDefinitions"][0]
                web["environment"].extend([
                    {"name": "ROUTING_URL", "value": "http://127.0.0.1:8002"},
                    {"name": "ROUTING_DATA_UPDATED_AT", "value": UPDATED},
                ])
                result["taskDefinition"]["containerDefinitions"].append({
                    "name": "routing", "image": inner.parameters["RoutingImageUri"],
                })
                return result

            def describe_images(inner, **kwargs):
                if "imageDigest" in kwargs["imageIds"][0]:
                    return {"imageDetails": [{"imageDigest": kwargs["imageIds"][0]["imageDigest"]}]}
                return super(PairedFixture, inner).describe_images(**kwargs)
        aws = PairedFixture()
        aws.parameters.update(RoutingImageUri=REPO + "@sha256:" + "c" * 64, RoutingDataUpdatedAt=UPDATED,
                              TaskCpu="512", TaskMemory="1024",
                              GuideRuntimeArn="arn:aws:bedrock-agentcore:ap-northeast-2:061525506239:runtime/JejuAtlas_Guide-test",
                              CatalogBucket="jeju-3d-data-061525506239-ap-northeast-2")
        with patch.dict(sys.modules, {"deploy": self.deploy}):
            rollback = module("scripts/rollback-release.py", "paired_rollback")
        approved = {"digest": rollback.APPROVED_RELEASES[TARGET], "routing": self.image["routing"]}
        with tempfile.TemporaryDirectory() as directory, patch.dict(rollback.APPROVED_RELEASES, {TARGET: approved}):
            path = Path(directory) / "rollback-change-set.json"
            report = rollback.plan(aws, TARGET, plan_path=path, sleep=lambda _: None)
            values = {item["ParameterKey"]: item for item in aws.create_calls[-1]["Parameters"]}
            self.assertEqual(values["RoutingImageUri"]["ParameterValue"], ROUTER)
            self.assertTrue(values["TaskMemory"]["UsePreviousValue"])
            self.assertTrue(values["GuideRuntimeArn"]["UsePreviousValue"])
            self.assertTrue(values["CatalogBucket"]["UsePreviousValue"])
            self.assertEqual(report["base"]["routing"]["imageUri"], aws.parameters["RoutingImageUri"])
            rollback.apply(aws, TARGET, plan_path=path, execute=True)
            self.assertEqual(len(aws.execute_calls), 1)


if __name__ == "__main__":
    unittest.main()
