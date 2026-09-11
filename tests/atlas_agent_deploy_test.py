import hashlib
import importlib.util
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import zipfile
import json


SPEC = importlib.util.spec_from_file_location(
    "atlas_agent_deploy", Path(__file__).resolve().parents[1] / "scripts/deploy-atlas-agent.py",
)
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)


class AtlasAgentDeployTests(unittest.TestCase):
    def test_bundle_replaces_old_application_without_losing_sdk_dependencies(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            base, target = root / "base.zip", root / "result.zip"
            source = root / "guide"
            (source / "atlas_agent").mkdir(parents=True)
            (source / "main.py").write_text("import atlas_agent\n")
            (source / "atlas_agent/__init__.py").write_text("VALUE = 'independent'\n")
            with zipfile.ZipFile(base, "w") as archive:
                archive.writestr("main.py", "import ohmyjeju_agent\n")
                archive.writestr("ohmyjeju_agent/__init__.py", "VALUE = 'reference'\n")
                archive.writestr("__pycache__/main.cpython-314.pyc", b"old bytecode")
                archive.writestr("strands/__init__.py", "SDK = '1.54.0'\n")
                archive.writestr("strands_agents-1.54.0.dist-info/METADATA", "Name: strands-agents\nVersion: 1.54.0\n")
            result = deploy.build_bundle(base, source, "guide", target)
            with zipfile.ZipFile(target) as archive:
                self.assertEqual(archive.read("main.py"), b"import atlas_agent\n")
                self.assertEqual(archive.read("atlas_agent/__init__.py"), b"VALUE = 'independent'\n")
                self.assertEqual(archive.read("strands/__init__.py"), b"SDK = '1.54.0'\n")
                self.assertNotIn("ohmyjeju_agent/__init__.py", archive.namelist())
                self.assertNotIn("__pycache__/main.cpython-314.pyc", archive.namelist())
            self.assertEqual(result["sha256"], hashlib.sha256(target.read_bytes()).hexdigest())
            second = root / "second.zip"
            self.assertEqual(deploy.build_bundle(base, source, "guide", second)["sha256"], result["sha256"])

    def test_bundle_rejects_path_traversal_and_symlink_dependencies(self):
        for path, link in [("../outside.py", False), ("linked.py", True)]:
            with self.subTest(path=path), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = root / "guide"
                source.mkdir()
                (source / "main.py").write_text("pass\n")
                with zipfile.ZipFile(root / "base.zip", "w") as archive:
                    info = zipfile.ZipInfo(path)
                    if link:
                        info.create_system = 3
                        info.external_attr = (stat.S_IFLNK | 0o777) << 16
                    archive.writestr(info, b"contents")
                with self.assertRaises(ValueError):
                    deploy.build_bundle(root / "base.zip", source, "guide", root / "result.zip")
                self.assertFalse((root / "result.zip").exists())

    def test_bundle_does_not_read_or_include_environment_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "guide"
            source.mkdir()
            (source / "main.py").write_text("pass\n")
            # The empty filename sentinel verifies rejection without reading a secret.
            (source / ".env.local").touch()
            with zipfile.ZipFile(root / "base.zip", "w"):
                pass
            with self.assertRaisesRegex(ValueError, "protected"):
                deploy.build_bundle(root / "base.zip", source, "guide", root / "result.zip")

    def test_changeset_refuses_the_reference_stack_even_with_safe_resource_types(self):
        changes = [{
            "ResourceChange": {
                "Action": "Modify", "LogicalResourceId": "Guide",
                "ResourceType": "AWS::BedrockAgentCore::Runtime", "Replacement": "False",
            },
        }]
        with self.assertRaisesRegex(ValueError, "Jeju3dAgentCore"):
            deploy.validate_changeset({"StackName": "AgentCore-Ohmyjeju-default", "Changes": changes})

    def test_changeset_refuses_network_changes_and_memory_replacement(self):
        for resource in [
            {"Action": "Add", "LogicalResourceId": "Vpc", "ResourceType": "AWS::EC2::VPC"},
            {"Action": "Modify", "LogicalResourceId": "Memory", "ResourceType": "AWS::BedrockAgentCore::Memory", "Replacement": "True"},
            {"Action": "Remove", "LogicalResourceId": "Memory", "ResourceType": "AWS::BedrockAgentCore::Memory"},
        ]:
            with self.subTest(resource=resource), self.assertRaises(ValueError):
                deploy.validate_changeset({"StackName": "Jeju3dAgentCore", "Changes": [{"ResourceChange": resource}]})

    def test_changeset_accepts_only_the_owned_runtime_and_its_supporting_resources(self):
        change = {
            "StackName": "Jeju3dAgentCore",
            "Changes": [{"ResourceChange": {
                "Action": "Add", "LogicalResourceId": "GuideRuntime",
                "ResourceType": "AWS::BedrockAgentCore::Runtime",
            }}],
        }
        self.assertEqual(deploy.validate_changeset(change), ["GuideRuntime"])

    def test_deployment_artifact_keys_are_tied_to_their_content_and_role(self):
        digest = "a" * 64
        self.assertEqual(deploy.artifact_key("guide", digest), f"agent/releases/{digest}/guide.zip")
        for role, sha in [("../tools", digest), ("guide", "../bad"), ("unknown", digest)]:
            with self.subTest(role=role, sha=sha), self.assertRaises(ValueError):
                deploy.artifact_key(role, sha)

    def test_new_review_stack_requires_the_recorded_tagged_add_only_changeset(self):
        class CloudFormation:
            def describe_stacks(self, **kwargs):
                return {"Stacks": [{"StackName": "Jeju3dAgentCore", "StackId": "owned-stack",
                                    "StackStatus": "REVIEW_IN_PROGRESS", "Tags": []}]}

            def describe_change_set(self, **kwargs):
                return {"StackName": "Jeju3dAgentCore", "StackId": self.stack_id,
                        "Tags": [{"Key": "Project", "Value": "jeju-3d"},
                                 {"Key": "Component", "Value": "independent-agent"}],
                        "Changes": [{"ResourceChange": {"Action": "Add", "LogicalResourceId": "GuideRuntime",
                                                        "ResourceType": "AWS::BedrockAgentCore::Runtime"}}]}

        with tempfile.TemporaryDirectory() as directory, patch.object(deploy, "LOCAL", Path(directory)):
            Path(directory, "atlas-agent-change-set.json").write_text(json.dumps({
                "stack": "Jeju3dAgentCore", "changeSetId": "recorded-change",
            }))
            cf = CloudFormation()
            cf.stack_id = "owned-stack"
            self.assertEqual(deploy.existing_stack(cf)["StackStatus"], "REVIEW_IN_PROGRESS")
            cf.stack_id = "some-other-stack"
            with self.assertRaises(ValueError):
                deploy.existing_stack(cf)

    def test_log_names_never_accept_reference_or_foreign_runtime_arns(self):
        outputs = {
            "guideRuntimeArn": "arn:aws:bedrock-agentcore:ap-northeast-2:061525506239:runtime/JejuAtlas_Guide-ABCDEFGHIJ",
            "toolsRuntimeArn": "arn:aws:bedrock-agentcore:ap-northeast-2:061525506239:runtime/JejuAtlas_Tools-KLMNOPQRST",
        }
        self.assertEqual(deploy.runtime_log_names(outputs), [
            "/aws/bedrock-agentcore/runtimes/JejuAtlas_Guide-ABCDEFGHIJ-DEFAULT",
            "/aws/bedrock-agentcore/runtimes/JejuAtlas_Tools-KLMNOPQRST-DEFAULT",
        ])
        for bad in [
            outputs["guideRuntimeArn"].replace("JejuAtlas_Guide", "Ohmyjeju_OhmyjejuAgent"),
            outputs["guideRuntimeArn"].replace("061525506239", "000000000000"),
        ]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                deploy.runtime_log_names({**outputs, "guideRuntimeArn": bad})


if __name__ == "__main__":
    unittest.main()
