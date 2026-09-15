"""Pin only participant model configuration, never deployment targets or IAM."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "workshop/scripts"))
SCRIPT = ROOT / "workshop/scripts/model_config.py"


class ModelConfigTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.is_file(), "The pinned runtime model configurator is missing")
        spec = importlib.util.spec_from_file_location("workshop_model_config_test", SCRIPT)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.temp = tempfile.TemporaryDirectory(prefix="atlas-model-config-")
        self.addCleanup(self.temp.cleanup)
        self.project = Path(self.temp.name) / "AtlasCliTeam01"
        (self.project / "agentcore").mkdir(parents=True)
        (self.project / "app/JejuGuide/model").mkdir(parents=True)
        (self.project / "agentcore/agentcore.json").write_text(json.dumps({
            "name": "AtlasCliTeam01",
            "runtimes": [{"name": "JejuGuide", "build": "CodeZip", "codeLocation": "app/JejuGuide/",
                          "envVars": [{"name": "KEEP_ME", "value": "existing"}]}],
        }))
        self.targets = self.project / "agentcore/aws-targets.json"
        self.targets.write_text('[{"name":"default","account":"123456789012","region":"ap-northeast-2"}]\n')
        self.loader = self.project / "app/JejuGuide/model/load.py"
        self.loader.write_text(
            'from strands.models.bedrock import BedrockModel\n'
            'def load_model() -> BedrockModel:\n'
            '    """Get Bedrock model client using IAM credentials."""\n'
            '    return BedrockModel(model_id="global.anthropic.claude-sonnet-4-5-20250929-v1:0")\n'
        )

    def test_configure_pins_sonnet_and_keeps_deployment_target_and_other_env(self):
        before = self.targets.read_bytes()
        result = self.module.configure(self.project, "eu-west-1")
        self.assertEqual(result["modelId"], "global.anthropic.claude-sonnet-4-6")
        self.assertEqual(result["callerRegion"], "eu-west-1")
        self.assertFalse(result["modelAccessVerified"])
        self.assertEqual(self.targets.read_bytes(), before)
        spec = json.loads((self.project / "agentcore/agentcore.json").read_text())
        env = {row["name"]: row["value"] for row in spec["runtimes"][0]["envVars"]}
        self.assertEqual(env["ATLAS_BEDROCK_REGION"], "eu-west-1")
        self.assertEqual(env["KEEP_ME"], "existing")
        self.assertNotIn("AWS_REGION", env)
        self.assertIn("global.anthropic.claude-sonnet-4-6", self.loader.read_text())
        self.assertEqual(self.module.check_model(self.project, spec)["callerRegion"], "eu-west-1")

    def test_no_approved_caller_region_stays_unconfigured_without_guessing(self):
        result = self.module.configure(self.project, None)
        self.assertFalse(result["readyForInvocation"])
        self.assertIsNone(result["callerRegion"])
        spec = json.loads((self.project / "agentcore/agentcore.json").read_text())
        with self.assertRaises(ValueError):
            self.module.check_model(self.project, spec)

    def test_existing_custom_model_code_is_preserved(self):
        self.loader.write_text("# participant custom implementation\nx = 7\n")
        before = self.loader.read_bytes()
        spec_before = (self.project / "agentcore/agentcore.json").read_bytes()
        with self.assertRaises(ValueError):
            self.module.configure(self.project, "ap-northeast-2")
        self.assertEqual(self.loader.read_bytes(), before)
        self.assertEqual((self.project / "agentcore/agentcore.json").read_bytes(), spec_before)

    def test_repeat_configuration_preserves_caller_region_without_an_override(self):
        self.module.configure(self.project, "eu-west-1")
        result = self.module.configure(self.project, None)
        self.assertEqual(result["callerRegion"], "eu-west-1")
        self.assertFalse(result["modelAccessVerified"])

    def test_loader_uses_only_the_explicit_model_region(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        calls = []
        def model(**kwargs):
            calls.append(kwargs)
            return kwargs
        self.module.configure(self.project, "eu-west-1")
        spec = importlib.util.spec_from_file_location("pinned_sonnet_fixture", self.loader)
        loader = importlib.util.module_from_spec(spec)
        with patch.dict("sys.modules", {"strands": SimpleNamespace(),
                                       "strands.models": SimpleNamespace(),
                                       "strands.models.bedrock": SimpleNamespace(BedrockModel=model)}):
            spec.loader.exec_module(loader)
        with patch.dict("os.environ", {"ATLAS_BEDROCK_REGION": "eu-west-1", "AWS_REGION": "ap-northeast-2"}, clear=True):
            loader.load_model()
        self.assertEqual(calls[0]["region_name"], "eu-west-1")
        with patch.dict("os.environ", {"AWS_REGION": "ap-northeast-2"}, clear=True), self.assertRaises(ValueError):
            loader.load_model()

    def test_advanced_copy_pins_sonnet_and_keeps_iam_policy_unchanged(self):
        sys.path.insert(0, str(ROOT / "workshop/tests"))
        from test_lab_boundary import configuration
        from lab_workspace import prepare_workspace, read_template, rewrite_text
        from lab_config import validate_config
        config = configuration()
        config["bedrockCallerRegion"] = "eu-west-1"  # Offline fixture, not live approval.
        config = validate_config(config)
        original = read_template(ROOT / "infra/agentcore.yaml")
        expected_policy = json.loads(rewrite_text(json.dumps(original["Resources"]["GuideRole"]["Properties"]["Policies"]), config))
        app = prepare_workspace(config, ROOT, Path(self.temp.name) / "advanced")
        template = read_template(app / "infra/agentcore.yaml")
        env = template["Resources"]["GuideRuntime"]["Properties"]["EnvironmentVariables"]
        self.assertEqual(env["ATLAS_MODEL_FAST"], "global.anthropic.claude-sonnet-4-6")
        self.assertEqual(env["ATLAS_MODEL_DEEP"], "global.anthropic.claude-sonnet-4-6")
        self.assertEqual(env["ATLAS_BEDROCK_REGION"], {"Ref": "BedrockCallerRegion"})
        self.assertEqual(template["Resources"]["GuideRole"]["Properties"]["Policies"], expected_policy)
        self.assertIn('os.environ.get("ATLAS_BEDROCK_REGION", "")',
                      (app / "agent/guide/model/load.py").read_text())


if __name__ == "__main__":
    unittest.main()
