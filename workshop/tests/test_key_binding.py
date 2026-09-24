"""Exercise the cloud boundary with fake AWS clients, never real credentials."""
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "workshop/scripts"))
SCRIPT = ROOT / "workshop/scripts/key_binding.py"


class NotFound(Exception):
    def __init__(self, code):
        self.response = {"Error": {"Code": code}}


class Cloud:
    def __init__(self, account="123456789012"):
        self.account = account
        self.writes = []
        self.policy = None
        self.parameter = None
        self.attached = False

    def client(self, service):
        return self

    def get_caller_identity(self):
        return {"Account": self.account}

    def get_policy(self, **kwargs):
        if self.policy is None:
            raise NotFound("NoSuchEntity")
        return {"Policy": {"DefaultVersionId": "v1"}}

    def list_policy_tags(self, **kwargs):
        return {"Tags": self.policy["Tags"]}

    def get_policy_version(self, **kwargs):
        return {"PolicyVersion": {"Document": json.loads(self.policy["PolicyDocument"])}}

    def create_policy(self, **kwargs):
        self.policy = kwargs
        self.writes.append("create-policy")
        return {"Policy": {"Arn": "arn:aws:iam::123456789012:policy/jeju-atlas/AtlasCliTeam01-bedrock-key"}}

    def describe_parameters(self, **kwargs):
        return {"Parameters": [{"Name": self.parameter["Name"], "Tier": self.parameter["Tier"]}]
                if self.parameter else []}

    def list_tags_for_resource(self, **kwargs):
        return {"TagList": self.parameter["Tags"]}

    def put_parameter(self, **kwargs):
        tags = kwargs.get("Tags", self.parameter["Tags"] if self.parameter else [])
        self.parameter = {**kwargs, "Tags": tags}
        self.writes.append("put-parameter")
        return {"Version": len(self.writes)}

    def list_entities_for_policy(self, **kwargs):
        return {"PolicyRoles": [{"RoleName": "still-running"}] if self.attached else [],
                "PolicyUsers": [], "PolicyGroups": [], "IsTruncated": False}

    def delete_policy(self, **kwargs):
        self.writes.append("delete-policy")
        self.policy = None
        return {}

    def delete_parameter(self, **kwargs):
        self.writes.append("delete-parameter")
        self.parameter = None
        return {}


class KeyBindingTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.is_file(), "The .env-to-Runtime key binding helper is missing")
        spec = importlib.util.spec_from_file_location("key_binding_test", SCRIPT)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        import core
        from workshop_env import write_env
        self.temp = tempfile.TemporaryDirectory(prefix="atlas-key-binding-")
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name) / "repo"
        for name in core.SOURCE_FILES:
            target = self.repo / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
        report = core.prepare(self.repo, "team01", "AtlasCliTeam01", "codex")
        self.project = Path(report["projectPath"])
        (self.repo / "workshop/.local/team01.json").write_text(json.dumps({
            "participant": "team01", "accountId": "123456789012", "region": "ap-northeast-2",
        }))
        (self.project / "agentcore").mkdir(parents=True)
        (self.project / "agentcore/agentcore.json").write_text(json.dumps({
            "name": "AtlasCliTeam01", "runtimes": [{
                "name": "JejuGuide", "build": "CodeZip", "codeLocation": "app/JejuGuide/",
                "envVars": [], "runtimeVersion": "PYTHON_3_14",
            }],
        }))
        (self.project / "agentcore/aws-targets.json").write_text(json.dumps([
            {"name": "default", "account": "123456789012", "region": "ap-northeast-2"},
        ]))
        (self.project / "app/JejuGuide/model").mkdir(parents=True)
        (self.project / "app/JejuGuide/model/load.py").write_text(
            'from strands.models.bedrock import BedrockModel\n'
            'def load_model():\n    return BedrockModel(model_id="generated")\n'
        )
        self.env_file = self.project.parent / ".env"
        self.token = "test-only-not-a-real-api-key"
        write_env(self.env_file, {
            "ATLAS_BEDROCK_REGION": "us-west-2", "AWS_BEARER_TOKEN_BEDROCK": self.token,
            "ATLAS_BEDROCK_KEY_EXPIRES_AT": "2099-09-24T12:00:00Z",
        })
        self.cloud = Cloud()

    def test_plan_never_initializes_cloud_clients_or_reads_key(self):
        self.env_file.unlink()
        result = self.module.publish(
            self.project, self.env_file,
            client_factory=lambda service: self.fail("Plan must not contact AWS"),
        )
        self.assertFalse(result["executed"])
        self.assertEqual(result["account"], "123456789012")
        self.assertIn("/jeju-atlas-lab-team01/bedrock-api-key", result["parameterArn"])

    def test_publish_wires_only_an_arn_and_scopes_policy_to_the_owned_parameter(self):
        result = self.module.publish(
            self.project, self.env_file, execute=True, client_factory=self.cloud.client,
        )
        self.assertTrue(result["executed"])
        self.assertEqual(self.cloud.parameter["Value"], self.token)
        self.assertEqual(self.cloud.parameter["Type"], "SecureString")
        policy = json.loads(self.cloud.policy["PolicyDocument"])
        self.assertEqual(policy["Statement"], [{
            "Effect": "Allow", "Action": ["ssm:GetParameter"],
            "Resource": "arn:aws:ssm:ap-northeast-2:123456789012:parameter/jeju-atlas-lab-team01/bedrock-api-key",
        }])
        metadata = (self.project / "agentcore/agentcore.json").read_text()
        self.assertNotIn(self.token, metadata + json.dumps(result))
        self.assertIn("ATLAS_BEDROCK_API_KEY_SSM_ARN", metadata)
        self.assertEqual(self.cloud.writes, ["create-policy", "put-parameter"])

    def test_account_mismatch_stops_before_any_mutation(self):
        self.cloud.account = "999999999999"
        before = (self.project / "agentcore/agentcore.json").read_bytes()
        with self.assertRaises(ValueError):
            self.module.publish(self.project, self.env_file, execute=True, client_factory=self.cloud.client)
        self.assertEqual(self.cloud.writes, [])
        self.assertEqual((self.project / "agentcore/agentcore.json").read_bytes(), before)

    def test_renewal_reuses_owned_policy_and_does_not_adopt_foreign_parameter(self):
        self.module.publish(self.project, self.env_file, execute=True, client_factory=self.cloud.client)
        from workshop_env import write_env
        write_env(self.env_file, {"AWS_BEARER_TOKEN_BEDROCK": "test-renewed"})
        self.module.publish(self.project, self.env_file, execute=True, client_factory=self.cloud.client)
        self.assertEqual(self.cloud.parameter["Value"], "test-renewed")
        self.assertTrue(self.cloud.parameter["Overwrite"])
        self.assertEqual(self.cloud.writes.count("create-policy"), 1)
        self.cloud.parameter["Tags"] = []
        before = list(self.cloud.writes)
        with self.assertRaises(ValueError):
            self.module.publish(self.project, self.env_file, execute=True, client_factory=self.cloud.client)
        self.assertEqual(self.cloud.writes, before)

    def test_shorter_renewed_key_does_not_downgrade_an_advanced_parameter(self):
        from workshop_env import write_env
        write_env(self.env_file, {"AWS_BEARER_TOKEN_BEDROCK": "test-" + "x" * 5000})
        self.module.publish(self.project, self.env_file, execute=True, client_factory=self.cloud.client)
        self.assertEqual(self.cloud.parameter["Tier"], "Advanced")
        write_env(self.env_file, {"AWS_BEARER_TOKEN_BEDROCK": "test-renewed-short-key"})
        result = self.module.publish(
            self.project, self.env_file, execute=True, client_factory=self.cloud.client,
        )
        self.assertEqual(self.cloud.parameter["Tier"], "Advanced")
        self.assertEqual(result["parameterTier"], "Advanced")
        self.assertEqual(self.cloud.parameter["Value"], "test-renewed-short-key")

    def test_attached_policy_prevents_cleanup_and_unused_owned_resources_can_be_removed(self):
        self.module.publish(self.project, self.env_file, execute=True, client_factory=self.cloud.client)
        path = self.project / "agentcore/agentcore.json"
        spec = json.loads(path.read_text())
        spec["runtimes"] = []
        path.write_text(json.dumps(spec))
        self.cloud.attached = True
        before = list(self.cloud.writes)
        with self.assertRaises(ValueError):
            self.module.cleanup(self.project, self.env_file, execute=True, client_factory=self.cloud.client)
        self.assertEqual(self.cloud.writes, before)
        self.cloud.attached = False
        result = self.module.cleanup(self.project, self.env_file, execute=True, client_factory=self.cloud.client)
        self.assertTrue(result["executed"])
        self.assertIsNone(self.cloud.parameter)
        self.assertIsNone(self.cloud.policy)
        self.assertTrue(self.env_file.exists(), "Cloud cleanup must not erase the participant's local settings")


if __name__ == "__main__":
    unittest.main()
