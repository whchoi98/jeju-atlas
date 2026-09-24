"""Keep entered keys out of command arguments, reports and deployment source."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "workshop/scripts/workshop_env.py"
TOKEN = "test-only-Bedrock-token+/=$literal"


class WorkshopEnvTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.is_file(), "The private .env input helper is missing")
        spec = importlib.util.spec_from_file_location("workshop_env_test", SCRIPT)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.temp = tempfile.TemporaryDirectory(prefix="atlas-env-")
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / ".env"

    def values(self):
        return {
            "ATLAS_BEDROCK_REGION": "us-west-2",
            "AWS_BEARER_TOKEN_BEDROCK": TOKEN,
            "ATLAS_BEDROCK_KEY_EXPIRES_AT": "2099-09-24T12:00:00Z",
        }

    def test_write_preserves_existing_fields_and_uses_private_permissions(self):
        self.path.write_text('KEEP_ME="previous"\nKAKAO_REST_API_KEY="existing-kakao"\n')
        self.module.write_env(self.path, self.values())
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        result = self.module.read_env(self.path)
        self.assertEqual(result["KEEP_ME"], "previous")
        self.assertEqual(result["KAKAO_REST_API_KEY"], "existing-kakao")
        self.assertEqual(result["AWS_BEARER_TOKEN_BEDROCK"], TOKEN)

    def test_dotenv_is_data_and_does_not_evaluate_shell_substitutions(self):
        marker = Path(self.temp.name) / "must-not-exist"
        literal = f"$(touch {marker})`touch {marker}`"
        self.module.write_env(self.path, {"TOURAPI_SERVICE_KEY": literal})
        self.assertEqual(self.module.read_env(self.path)["TOURAPI_SERVICE_KEY"], literal)
        self.assertFalse(marker.exists())

    def test_duplicate_and_malformed_lines_do_not_echo_secret_values(self):
        for text in (f"A={TOKEN}\nA=second\n", f"{TOKEN}\n", f'A="{TOKEN}\n'):
            with self.subTest(text=text):
                self.path.write_text(text)
                with self.assertRaises(ValueError) as error:
                    self.module.read_env(self.path)
                self.assertNotIn(TOKEN, str(error.exception))

    def test_symlink_input_and_hardlinked_file_are_not_read_or_replaced(self):
        original = self.path.with_name("original")
        original.write_text('KEEP="original"\n')
        self.path.symlink_to(original)
        with self.assertRaises(ValueError):
            self.module.write_env(self.path, self.values())
        self.path.unlink()
        os.link(original, self.path)
        with self.assertRaises(ValueError):
            self.module.write_env(self.path, self.values())
        self.assertEqual(original.read_text(), 'KEEP="original"\n')

    def test_status_never_contains_a_key_and_missing_or_expired_key_cannot_pass(self):
        self.module.write_env(self.path, self.values())
        result = self.module.status(self.path)
        self.assertTrue(result["readyForModelCheck"])
        self.assertNotIn(TOKEN, json.dumps(result))
        self.module.write_env(self.path, {"ATLAS_BEDROCK_KEY_EXPIRES_AT": "2000-01-01T00:00:00Z"})
        self.assertFalse(self.module.status(self.path)["readyForModelCheck"])
        self.module.write_env(self.path, {"AWS_BEARER_TOKEN_BEDROCK": ""})
        self.assertFalse(self.module.status(self.path)["readyForModelCheck"])

    def test_missing_optional_keys_do_not_block_basic_model_setup(self):
        self.module.write_env(self.path, self.values())
        result = self.module.status(self.path)
        self.assertTrue(result["readyForModelCheck"])
        self.assertEqual(result["integrations"]["kakao"], False)
        self.assertEqual(result["integrations"]["tourapi"], False)
        self.assertEqual(result["integrations"]["visitjeju"], False)

    def test_child_receives_key_only_in_environment_and_parent_is_unchanged(self):
        self.module.write_env(self.path, self.values())
        self.module.write_env(self.path, {"UNRELATED_SETTING": "do-not-export"})
        received = {}
        def run(command, **kwargs):
            received.update(command=command, environment=kwargs["env"])
            return subprocess.CompletedProcess(command, 17)
        with patch.dict(os.environ, {"AWS_BEARER_TOKEN_BEDROCK": "previous"}, clear=False), \
                patch.object(self.module.subprocess, "run", side_effect=run):
            code = self.module.run_command(self.path, ["agentcore", "dev"])
            self.assertEqual(os.environ["AWS_BEARER_TOKEN_BEDROCK"], "previous")
        self.assertEqual(code, 17)
        self.assertEqual(received["command"], ["agentcore", "dev"])
        self.assertEqual(received["environment"]["AWS_BEARER_TOKEN_BEDROCK"], TOKEN)
        self.assertEqual(received["environment"]["ATLAS_BEDROCK_AUTH"], "api-key")
        self.assertNotIn("UNRELATED_SETTING", received["environment"])
        self.assertNotIn(TOKEN, repr(received["command"]))

    def test_noninteractive_input_refuses_to_echo_a_key(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "configure", "--env-file", str(self.path)],
            input="us-west-2\n" + TOKEN + "\n", text=True, capture_output=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        self.assertFalse(self.path.exists())


if __name__ == "__main__":
    unittest.main()
