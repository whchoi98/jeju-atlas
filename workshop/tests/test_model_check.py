"""Real checks are opt-in, bounded, region-specific and never hide policy denial."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "workshop/scripts"))
SCRIPT = ROOT / "workshop/scripts/model_check.py"
MODEL = "global.anthropic.claude-sonnet-4-6"


class ModelCheckTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.is_file(), "The explicit real-model checker is missing")
        spec = importlib.util.spec_from_file_location("workshop_model_check_test", SCRIPT)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.temp = tempfile.TemporaryDirectory(prefix="atlas-model-check-")
        self.addCleanup(self.temp.cleanup)
        self.report = Path(self.temp.name) / "result.json"

    def test_plan_never_constructs_a_client_or_writes_a_success_report(self):
        def forbidden(region):
            self.fail("Read-only planning constructed a model client")
        result = self.module.check("ap-northeast-2", self.report, execute=False, client_factory=forbidden)
        self.assertFalse(result["executed"])
        self.assertFalse(result["passed"])
        self.assertFalse(self.report.exists())

    def test_one_small_converse_uses_the_explicit_caller_region(self):
        calls = []
        class Client:
            def converse(self, **kwargs):
                calls.append(kwargs)
                return {"output": {"message": {"content": [{"text": "OK"}]}},
                        "stopReason": "end_turn", "usage": {"inputTokens": 9, "outputTokens": 1}}
        def factory(region):
            self.assertEqual(region, "eu-west-1")  # Fixture only, not a verified live region.
            return Client()
        result = self.module.check("eu-west-1", self.report, execute=True, client_factory=factory)
        self.assertTrue(result["passed"])
        self.assertEqual(result["deploymentRegion"], "ap-northeast-2")
        self.assertEqual(result["callerRegion"], "eu-west-1")
        self.assertEqual(result["modelId"], MODEL)
        self.assertEqual(result["response"], "OK")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["modelId"], MODEL)
        self.assertLessEqual(calls[0]["inferenceConfig"]["maxTokens"], 32)
        self.assertEqual(json.loads(self.report.read_text())["passed"], True)

    def test_scp_denial_is_failed_and_no_other_region_is_attempted(self):
        from botocore.exceptions import ClientError
        calls = []
        class Client:
            def converse(self, **kwargs):
                calls.append(kwargs)
                raise ClientError({
                    "Error": {"Code": "AccessDeniedException",
                              "Message": "User arn:aws:sts::123456789012:assumed-role/PrivateRole/private-session "
                                         "is not authorized to perform bedrock:InvokeModel with an explicit deny "
                                         "in a service control policy"},
                    "ResponseMetadata": {"HTTPStatusCode": 403},
                }, "Converse")
        regions = []
        def factory(region):
            regions.append(region)
            return Client()
        result = self.module.check("ap-northeast-2", self.report, execute=True, client_factory=factory)
        self.assertFalse(result["passed"])
        self.assertTrue(result["executed"])
        self.assertFalse(result["modelResponseReceived"])
        self.assertEqual(result["error"]["code"], "AccessDeniedException")
        self.assertEqual(result["error"]["classification"], "scp_explicit_deny")
        self.assertEqual(regions, ["ap-northeast-2"])
        self.assertEqual(len(calls), 1)
        stored = self.report.read_text()
        self.assertNotIn("123456789012", stored)
        self.assertNotIn("PrivateRole", stored)
        self.assertNotIn("private-session", stored)

    def test_api_key_is_scoped_to_the_call_and_removed_from_failure_reports(self):
        token = "test-only-private-bearer-token"
        seen = []
        class Client:
            def converse(self, **kwargs):
                seen.append(os.environ.get("AWS_BEARER_TOKEN_BEDROCK"))
                raise ValueError("rejected credential " + token)
        with patch.dict(os.environ, {"AWS_BEARER_TOKEN_BEDROCK": "previous-value"}, clear=False):
            result = self.module.check(
                "us-west-2", self.report, execute=True, api_key=token,
                client_factory=lambda region: Client(),
            )
            self.assertEqual(os.environ["AWS_BEARER_TOKEN_BEDROCK"], "previous-value")
        self.assertEqual(seen, [token])
        self.assertEqual(result["authMode"], "api-key")
        self.assertFalse(result["passed"])
        self.assertNotIn(token, self.report.read_text() + json.dumps(result))

    def test_iam_check_cannot_accidentally_use_an_inherited_bearer_key(self):
        seen = []
        class Client:
            def converse(self, **kwargs):
                seen.append(os.environ.get("AWS_BEARER_TOKEN_BEDROCK"))
                return {"output": {"message": {"content": [{"text": "OK"}]}}, "stopReason": "end_turn"}
        with patch.dict(os.environ, {"AWS_BEARER_TOKEN_BEDROCK": "other-tool-key"}, clear=False):
            result = self.module.check(
                "us-west-2", self.report, execute=True, client_factory=lambda region: Client(),
            )
            self.assertEqual(os.environ["AWS_BEARER_TOKEN_BEDROCK"], "other-tool-key")
        self.assertEqual(seen, [None])
        self.assertEqual(result["authMode"], "iam")

    def test_incomplete_or_unexpected_model_output_does_not_pass(self):
        for response in ({}, {"output": {"message": {"content": [{"text": "not the expected answer"}]}}},
                         {"output": {"message": {"content": [{"text": "OK"}]}}, "stopReason": "max_tokens"}):
            class Client:
                def converse(self, **kwargs):
                    return response
            with self.subTest(response=response):
                report = self.report.with_name(str(len(list(Path(self.temp.name).iterdir()))) + ".json")
                result = self.module.check("ap-northeast-2", report, execute=True,
                                           client_factory=lambda region: Client())
                self.assertFalse(result["passed"])

    def test_existing_or_symlink_report_is_rejected_before_any_invocation(self):
        self.report.write_text("preserve")
        link = self.report.with_name("link.json")
        link.symlink_to(self.report)
        for output in [self.report, link]:
            with self.subTest(output=output), self.assertRaises(ValueError):
                self.module.check("ap-northeast-2", output, execute=True,
                                  client_factory=lambda region: self.fail("Should not call a model"))
        self.assertEqual(self.report.read_text(), "preserve")

    def test_missing_or_invalid_caller_region_is_not_replaced_with_deployment_region(self):
        for region in ["", None, "approved-region", "https://bedrock.example.org"]:
            with self.subTest(region=region), self.assertRaises(ValueError):
                self.module.check(region, self.report, execute=True,
                                  client_factory=lambda region: self.fail("Should not call a model"))


if __name__ == "__main__":
    unittest.main()
