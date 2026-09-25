"""The advanced Guide must reuse the initial private key without exposing it."""
import importlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
from types import ModuleType
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "workshop/scripts"))
sys.path.insert(0, str(ROOT / "workshop/tests"))

from test_key_binding import Cloud
from test_lab_boundary import configuration


class AgentKeyTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue((ROOT / "workshop/scripts/agent_key.py").is_file(),
                        "Chapter 06 has no path from the initial key to the Guide")
        self.module = importlib.import_module("agent_key")
        import core
        import key_binding
        from lab_config import validate_config
        from lab_workspace import prepare_workspace
        from workshop_env import write_env
        self.temp = tempfile.TemporaryDirectory(prefix="atlas-agent-key-")
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name) / "repo"
        for name in set(core.SOURCE_FILES) | {"agent/guide/model/load.py"}:
            target = self.repo / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
        session = core.prepare(self.repo, "team01", "AtlasCliTeam01", "claude")
        self.project = Path(session["projectPath"])
        self.config = validate_config({**configuration(), "bedrockCallerRegion": "ap-northeast-2"})
        (self.repo / "workshop/.local/team01.json").write_text(json.dumps(self.config))
        self.app = prepare_workspace(self.config, ROOT, self.repo / "workshop/.local/labs")
        self.env_file = self.project.parent / ".env"
        self.token = "test-only-initial-bedrock-key"
        write_env(self.env_file, {
            "ATLAS_BEDROCK_REGION": "ap-northeast-2",
            "AWS_BEARER_TOKEN_BEDROCK": self.token,
            "KAKAO_REST_API_KEY": "test-unrelated-provider-key",
        })
        self.cloud = Cloud()
        self.info = {
            "participant": "team01", "project": "AtlasCliTeam01", "account": "123456789012",
            "region": "ap-northeast-2", "parameterName": "/jeju-atlas-lab-team01/bedrock-api-key",
            "parameterArn": "arn:aws:ssm:ap-northeast-2:123456789012:parameter/jeju-atlas-lab-team01/bedrock-api-key",
            "policyName": "AtlasCliTeam01-bedrock-key",
            "policyArn": "arn:aws:iam::123456789012:policy/jeju-atlas/AtlasCliTeam01-bedrock-key",
        }
        self.cloud.policy = {"PolicyDocument": json.dumps(key_binding.policy(self.info)),
                             "Tags": key_binding.tags(self.info)}
        self.cloud.parameter = {
            "Name": self.info["parameterName"], "Value": self.token, "Type": "SecureString",
            "Tier": "Standard", "Tags": key_binding.tags(self.info),
        }

    def configure(self, **kwargs):
        return self.module.configure(
            self.repo, self.config, self.app, env_file=self.env_file,
            client_factory=self.cloud.client, **kwargs,
        )

    def snapshot(self):
        return {name: (self.app / name).read_bytes() for name in
                ["agent/guide/model/load.py", "infra/agentcore.yaml",
                 "scripts/deploy-atlas-agent.py", ".local/workshop-binding.json"]}

    def test_preview_does_not_read_key_contact_aws_or_modify_files(self):
        before = self.snapshot()
        self.env_file.unlink()
        with patch.object(self.cloud, "client", side_effect=AssertionError("Preview contacted AWS")):
            result = self.configure()
        self.assertFalse(result["executed"])
        self.assertFalse(result["runtimeDeployed"])
        self.assertEqual(result["parameterArn"], self.info["parameterArn"])
        self.assertEqual(before, self.snapshot())
        self.assertFalse((self.app / ".local/workshop-agent-key.json").exists())

    def test_reuses_shared_key_policy_and_preserves_non_model_iam_and_tools(self):
        from lab_workspace import read_template
        before = self.snapshot()
        original = read_template(self.app / "infra/agentcore.yaml")
        local_env = self.env_file.read_bytes()
        result = self.configure(execute=True)
        self.assertTrue(result["executed"])
        self.assertFalse(result["runtimeDeployed"])
        self.assertEqual(self.cloud.parameter["Value"], self.token)
        self.assertEqual(self.cloud.writes, ["put-parameter"])
        template = read_template(self.app / "infra/agentcore.yaml")
        guide = template["Resources"]["GuideRuntime"]["Properties"]["EnvironmentVariables"]
        self.assertEqual(guide["ATLAS_BEDROCK_AUTH"], "api-key")
        self.assertEqual(guide["ATLAS_BEDROCK_API_KEY_SSM_ARN"], self.info["parameterArn"])
        self.assertNotIn("AWS_BEARER_TOKEN_BEDROCK", guide)
        self.assertEqual(template["Resources"]["GuideRole"]["Properties"]["ManagedPolicyArns"],
                         [self.info["policyArn"]])
        self.assertEqual(template["Resources"]["GuideRole"]["Properties"]["Policies"],
                         original["Resources"]["GuideRole"]["Properties"]["Policies"])
        for name, resource in original["Resources"].items():
            if name not in {"GuideRuntime", "GuideRole"}:
                self.assertEqual(template["Resources"][name], resource, name)
        self.assertEqual(self.env_file.read_bytes(), local_env)
        self.assertEqual((self.app / "scripts/deploy-atlas-agent.py").read_bytes(),
                         before["scripts/deploy-atlas-agent.py"])
        self.assertEqual((self.app / ".local/workshop-binding.json").read_bytes(),
                         before[".local/workshop-binding.json"])
        self.assertTrue((self.app / "agent/guide/model/workshop_auth.py").is_file())
        for name in ["agent/guide/model/load.py", "agent/guide/model/workshop_auth.py",
                     "infra/agentcore.yaml", ".local/workshop-agent-key.json"]:
            text = (self.app / name).read_text()
            self.assertNotIn(self.token, text)
            self.assertNotIn("test-unrelated-provider-key", text)
        self.assertNotIn(self.token, json.dumps(result))
        self.module.require_binding(self.repo, self.config, self.app)

    def test_key_renewal_does_not_change_guide_code_or_duplicate_policy(self):
        from workshop_env import write_env
        self.configure(execute=True)
        before = self.snapshot()
        auth = (self.app / "agent/guide/model/workshop_auth.py").read_bytes()
        write_env(self.env_file, {"AWS_BEARER_TOKEN_BEDROCK": "test-renewed-key"})
        result = self.configure(execute=True)
        self.assertEqual(self.cloud.parameter["Value"], "test-renewed-key")
        self.assertEqual(self.cloud.writes, ["put-parameter", "put-parameter"])
        self.assertEqual(result["updatedFiles"], [])
        self.assertEqual(self.snapshot(), before)
        self.assertEqual((self.app / "agent/guide/model/workshop_auth.py").read_bytes(), auth)

    def test_mismatched_region_and_missing_key_do_not_write_or_contact_aws(self):
        from workshop_env import write_env
        before = self.snapshot()
        for updates in [{"ATLAS_BEDROCK_REGION": "us-west-2"},
                        {"ATLAS_BEDROCK_REGION": "ap-northeast-2", "AWS_BEARER_TOKEN_BEDROCK": ""}]:
            with self.subTest(updates=updates):
                write_env(self.env_file, updates)
                with patch.object(self.cloud, "client", side_effect=AssertionError("Invalid key input contacted AWS")):
                    with self.assertRaises(ValueError):
                        self.configure(execute=True)
                self.assertEqual(self.snapshot(), before)
                self.assertEqual(self.cloud.writes, [])

    def test_advanced_auth_requires_seoul_even_if_other_regions_match(self):
        from workshop_env import write_env
        self.config["bedrockCallerRegion"] = "us-west-2"
        write_env(self.env_file, {"ATLAS_BEDROCK_REGION": "us-west-2"})
        before = self.snapshot()
        with patch.object(self.cloud, "client", side_effect=AssertionError("Wrong region contacted AWS")):
            with self.assertRaisesRegex(ValueError, "ap-northeast-2"):
                self.configure(execute=True)
        self.assertEqual(self.snapshot(), before)

    def test_wrong_account_or_foreign_key_stops_before_any_local_or_cloud_write(self):
        before = self.snapshot()
        self.cloud.account = "999999999999"
        with self.assertRaises(ValueError):
            self.configure(execute=True)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.cloud.writes, [])
        self.cloud.account = self.info["account"]
        self.cloud.parameter["Tags"] = []
        with self.assertRaises(ValueError):
            self.configure(execute=True)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.cloud.writes, [])

    def test_custom_loader_is_preserved_without_any_cloud_changes(self):
        path = self.app / "agent/guide/model/load.py"
        path.write_text(path.read_text() + "\n# participant custom model loader\n")
        before = self.snapshot()
        with self.assertRaises(ValueError):
            self.configure(execute=True)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.cloud.writes, [])

    def test_modified_binding_is_not_accepted_for_build_or_deploy(self):
        self.configure(execute=True)
        path = self.app / "infra/agentcore.yaml"
        template = json.loads(path.read_text())
        template["Resources"]["GuideRuntime"]["Properties"]["EnvironmentVariables"][
            "ATLAS_BEDROCK_AUTH"] = "iam"
        path.write_text(json.dumps(template))
        with self.assertRaises(ValueError):
            self.module.require_binding(self.repo, self.config, self.app)

    def test_unconfigured_legacy_guide_cannot_pass_binding_guard(self):
        with self.assertRaisesRegex(ValueError, "agent-key"):
            self.module.require_binding(self.repo, self.config, self.app)

    def test_linked_model_file_is_rejected_and_target_is_preserved(self):
        path = self.app / "agent/guide/model/load.py"
        target = Path(self.temp.name) / "other-loader.py"
        target.write_bytes(path.read_bytes())
        path.unlink()
        path.symlink_to(target)
        before = target.read_bytes()
        with self.assertRaises(ValueError):
            self.configure(execute=True)
        self.assertEqual(target.read_bytes(), before)
        self.assertEqual(self.cloud.writes, [])

    def test_edits_during_key_publication_are_not_overwritten(self):
        path = self.app / "agent/guide/model/load.py"
        new_content = path.read_bytes() + b"\n# newer participant edit\n"
        original_publish = self.cloud.put_parameter
        def concurrent_edit(**kwargs):
            result = original_publish(**kwargs)
            path.write_bytes(new_content)
            return result
        with patch.object(self.cloud, "put_parameter", side_effect=concurrent_edit):
            with self.assertRaises(ValueError):
                self.configure(execute=True)
        self.assertEqual(path.read_bytes(), new_content)
        self.assertFalse((self.app / ".local/workshop-agent-key.json").exists())
        self.assertFalse((self.app / "agent/guide/model/workshop_auth.py").exists())

    def test_old_guide_build_fails_before_aws_or_deployment_subprocess(self):
        import lab
        from types import SimpleNamespace
        with patch.object(lab, "ROOT", self.repo), patch.object(lab, "LOCAL", self.repo / "workshop/.local"), \
                patch.object(lab, "aws_session", side_effect=AssertionError("Unconfigured Guide contacted AWS")), \
                patch.object(lab.subprocess, "run", side_effect=AssertionError("Unconfigured Guide built code")):
            with self.assertRaisesRegex(ValueError, "agent-key"):
                lab.run_step(self.config, SimpleNamespace(step="agent-build", execute=True))

    def test_failed_local_replace_restores_original_guide_files(self):
        import os
        before = self.snapshot()
        original = os.replace
        def fail_auth_file(source, target):
            if Path(target) == self.app / "agent/guide/model/workshop_auth.py":
                raise OSError("synthetic local write failure")
            return original(source, target)
        with patch.object(self.module.os, "replace", side_effect=fail_auth_file):
            with self.assertRaises(OSError):
                self.configure(execute=True)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse((self.app / "agent/guide/model/workshop_auth.py").exists())
        self.assertFalse((self.app / ".local/workshop-agent-key.json").exists())

    def test_real_packager_includes_auth_adapter_but_no_key(self):
        self.configure(execute=True)
        spec = importlib.util.spec_from_file_location("agent_key_packager", self.app / "scripts/deploy-atlas-agent.py")
        deploy = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(deploy)
        base = Path(self.temp.name) / "dependencies.zip"
        with zipfile.ZipFile(base, "w") as archive:
            archive.writestr("synthetic_dependency.py", "# offline dependency fixture\n")
        output = Path(self.temp.name) / "guide.zip"
        deploy.build_bundle(base, self.app / "agent/guide", "guide", output)
        with zipfile.ZipFile(output) as archive:
            self.assertIn("model/workshop_auth.py", archive.namelist())
            for name in archive.namelist():
                self.assertNotIn(self.token.encode(), archive.read(name), name)
                self.assertFalse(name.endswith(".env"), name)

    @unittest.skipUnless(importlib.util.find_spec("strands") is not None,
                         "Use the pinned Guide environment for the generated loader integration")
    def test_generated_loader_uses_real_bearer_client_and_refreshes_its_cache(self):
        from test_runtime_bedrock_auth import RuntimeBedrockAuthTests, KEY, RENEWED_KEY, MODEL_ID, parameter
        from workshop_env import write_env
        from botocore.exceptions import ClientError
        write_env(self.env_file, {"AWS_BEARER_TOKEN_BEDROCK": KEY})
        self.configure(execute=True)
        self.assertEqual(self.cloud.parameter["Value"], KEY)
        transport = RuntimeBedrockAuthTests(methodName="runTest")
        transport.setUp()
        self.addCleanup(transport.doCleanups)
        transport.ssm_responses = [
            parameter(), parameter(), parameter(key=RENEWED_KEY, version=8),
            ClientError({"Error": {"Code": "AccessDeniedException", "Message": KEY}}, "GetParameter"),
        ]
        package = ModuleType("generated_key_guide")
        package.__path__ = [str(self.app / "agent/guide/model")]
        with patch.dict(sys.modules, {"generated_key_guide": package}):
            spec = importlib.util.spec_from_file_location("generated_key_guide.load", self.app / "agent/guide/model/load.py")
            loader = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(loader)
            first = loader.load_model()
            self.addCleanup(first.client.close)
            self.assertIs(first, loader.load_model())
            transport.assert_bearer(transport.prepared(first.client, "converse", modelId=MODEL_ID))
            renewed = loader.load_model()
            self.addCleanup(renewed.client.close)
            self.assertIsNot(first, renewed)
            transport.assert_bearer(
                transport.prepared(renewed.client, "converse_stream", modelId=MODEL_ID), RENEWED_KEY)
            transport.assert_redacted_failure(loader.load_model, KEY, RENEWED_KEY)


if __name__ == "__main__":
    unittest.main()
