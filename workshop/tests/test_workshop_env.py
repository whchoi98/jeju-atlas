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
        }

    def test_configure_asks_only_for_issuing_region_and_hidden_key(self):
        prompts = []
        def region_input(prompt):
            self.assertEqual(prompts, [], "Only the issuing region should use visible input")
            prompts.append(prompt)
            return " us-west-2 "
        with patch.object(self.module.sys.stdin, "isatty", return_value=True), \
                patch("builtins.input", side_effect=region_input), \
                patch.object(self.module.getpass, "getpass", return_value=TOKEN) as hidden:
            result = self.module.configure(self.path)
        self.assertEqual(len(prompts), 1)
        hidden.assert_called_once()
        self.assertEqual(self.module.read_env(self.path), self.values())
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertTrue(result["readyForModelCheck"])
        self.assertFalse(result["modelAccessVerified"])
        self.assertNotIn(TOKEN, json.dumps(result))
        self.assertNotIn("expiresAt", result)
        self.assertNotIn("minutesRemaining", result)

    def test_configure_blank_inputs_keep_existing_values_and_private_permissions(self):
        existing = {
            **self.values(),
            "ATLAS_BEDROCK_KEY_EXPIRES_AT": "legacy-not-a-timestamp",
            "KEEP_ME": "previous",
            "KAKAO_REST_API_KEY": "existing-kakao",
        }
        self.module.write_env(self.path, existing)
        before_mode = stat.S_IMODE(self.path.stat().st_mode)
        prompts = []
        def region_input(prompt):
            self.assertEqual(prompts, [], "Legacy expiry must not add another question")
            prompts.append(prompt)
            return ""
        with patch.object(self.module.sys.stdin, "isatty", return_value=True), \
                patch("builtins.input", side_effect=region_input), \
                patch.object(self.module.getpass, "getpass", return_value="") as hidden:
            result = self.module.configure(self.path)
        hidden.assert_called_once()
        self.assertEqual(self.module.read_env(self.path), existing)
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), before_mode)
        self.assertTrue(result["readyForModelCheck"])
        report = json.dumps(result) + repr(prompts) + repr(hidden.call_args)
        for private in (TOKEN, "legacy-not-a-timestamp", "existing-kakao"):
            self.assertNotIn(private, report)

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

    def test_status_needs_only_key_and_region_and_never_contains_a_key(self):
        self.module.write_env(self.path, self.values())
        result = self.module.status(self.path)
        self.assertTrue(result["readyForModelCheck"])
        self.assertFalse(result["modelAccessVerified"])
        self.assertNotIn(TOKEN, json.dumps(result))
        self.assertNotIn("expiresAt", result)
        self.assertNotIn("minutesRemaining", result)

    def test_legacy_expiry_does_not_block_readiness_or_appear_in_status(self):
        for expiry in ("2000-01-01T00:00:00Z", "legacy-not-a-timestamp", "2099-09-24T12:00:00Z", ""):
            with self.subTest(expiry=expiry):
                self.module.write_env(self.path, {
                    **self.values(), "ATLAS_BEDROCK_KEY_EXPIRES_AT": expiry,
                })
                result = self.module.status(self.path)
                self.assertTrue(result["readyForModelCheck"])
                self.assertNotIn("expiresAt", result)
                self.assertNotIn("minutesRemaining", result)
                if expiry:
                    self.assertNotIn(expiry, json.dumps(result))
                values = self.module.read_env(self.path)
                self.assertEqual(values["ATLAS_BEDROCK_KEY_EXPIRES_AT"], expiry)
                self.assertEqual(self.module.model_values(values), self.values())

    def test_missing_or_invalid_key_and_region_still_block_readiness_and_children(self):
        for name, invalid in (
            ("ATLAS_BEDROCK_REGION", None), ("ATLAS_BEDROCK_REGION", ""),
            ("ATLAS_BEDROCK_REGION", "not a region"),
            ("AWS_BEARER_TOKEN_BEDROCK", None), ("AWS_BEARER_TOKEN_BEDROCK", ""),
            ("AWS_BEARER_TOKEN_BEDROCK", "key with spaces"),
        ):
            with self.subTest(name=name, invalid=invalid):
                values = self.values()
                if invalid is None:
                    del values[name]
                else:
                    values[name] = invalid
                self.path.unlink(missing_ok=True)
                self.module.write_env(self.path, values)
                result = self.module.status(self.path)
                self.assertFalse(result["readyForModelCheck"])
                self.assertNotIn(TOKEN, json.dumps(result))
                with patch.object(self.module.subprocess, "run",
                                  side_effect=AssertionError("Invalid input must not start a child")):
                    with self.assertRaises(ValueError):
                        self.module.run_command(self.path, ["agentcore", "dev"])

    def test_missing_optional_keys_do_not_block_basic_model_setup(self):
        self.module.write_env(self.path, self.values())
        result = self.module.status(self.path)
        self.assertTrue(result["readyForModelCheck"])
        self.assertEqual(result["integrations"]["kakao"], False)
        self.assertEqual(result["integrations"]["tourapi"], False)
        self.assertEqual(result["integrations"]["visitjeju"], False)

    def test_child_receives_key_only_in_environment_and_parent_is_unchanged(self):
        self.module.write_env(self.path, self.values())
        self.module.write_env(self.path, {
            "UNRELATED_SETTING": "do-not-export",
            "ATLAS_BEDROCK_KEY_EXPIRES_AT": "2099-09-24T12:00:00Z",
            "KAKAO_REST_API_KEY": "test-kakao",
            "TOURAPI_SERVICE_KEY": "test-tourapi",
            "VISIT_JEJU_API_KEY": "test-visitjeju",
        })
        received = {}
        def run(command, **kwargs):
            received.update(command=command, environment=kwargs["env"])
            return subprocess.CompletedProcess(command, 17)
        with patch.dict(os.environ, {
            "AWS_BEARER_TOKEN_BEDROCK": "previous",
            "ATLAS_BEDROCK_KEY_EXPIRES_AT": "legacy-parent-expiry",
            "INHERITED_SETTING": "keep-in-child",
        }, clear=True), \
                patch.object(self.module.subprocess, "run", side_effect=run):
            before = dict(os.environ)
            code = self.module.run_command(self.path, ["agentcore", "dev"])
            self.assertEqual(dict(os.environ), before)
        self.assertEqual(code, 17)
        self.assertEqual(received["command"], ["agentcore", "dev"])
        self.assertEqual(received["environment"], {
            "AWS_BEARER_TOKEN_BEDROCK": TOKEN,
            "ATLAS_BEDROCK_REGION": "us-west-2",
            "ATLAS_BEDROCK_AUTH": "api-key",
            "ATLAS_BEDROCK_LOCAL_KEY": "1",
            "KAKAO_REST_API_KEY": "test-kakao",
            "TOURAPI_SERVICE_KEY": "test-tourapi",
            "VISIT_JEJU_API_KEY": "test-visitjeju",
            "INHERITED_SETTING": "keep-in-child",
        })
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
