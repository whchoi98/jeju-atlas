"""The model release must leave every unrelated deployed archive member intact."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
import warnings
import zipfile

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "scripts"))
spec = importlib.util.spec_from_file_location("guide_model_deploy", root / "scripts/deploy-guide-models.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ModelArchiveTests(unittest.TestCase):
    def fixture(self, directory, extra=()):
        directory = Path(directory)
        source = directory / "source"
        for name in module.FILES:
            target = source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(f"# reviewed {name}\n")
        original = directory / "before.zip"
        with zipfile.ZipFile(original, "w") as archive:
            for name in module.FILES:
                archive.writestr(name, b"# old source\n")
            archive.writestr("main.py", b"UNCHANGED MAIN")
            archive.writestr("dependency/binary.so", b"\x00\x01\xffUNCHANGED")
            archive.writestr("model/__pycache__/load.cpython-314.pyc", b"STALE")
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                for name in extra:
                    archive.writestr(name, b"MUST NOT READ")
        return source, original, directory / "after.zip"

    def test_only_reviewed_sources_are_replaced_and_stale_bytecode_is_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            source, original, target = self.fixture(directory)
            module.patch_archive(original, target, source)
            with zipfile.ZipFile(target) as result, zipfile.ZipFile(original) as before:
                for name in module.FILES:
                    self.assertEqual(result.read(name), (source / name).read_bytes())
                for name in ("main.py", "dependency/binary.so"):
                    self.assertEqual(result.read(name), before.read(name))
                self.assertNotIn("model/__pycache__/load.cpython-314.pyc", result.namelist())

    def test_ambiguous_or_credential_bundles_are_rejected(self):
        for extra in (("model/load.py",), (".env.local",), (".aws/credentials",)):
            with self.subTest(extra=extra), tempfile.TemporaryDirectory() as directory:
                source, original, target = self.fixture(directory, extra)
                with self.assertRaises(RuntimeError):
                    module.patch_archive(original, target, source)


class ExistingSchemaFindingsTests(unittest.TestCase):
    def issue(self, path, rule="E3030", message="Unrecognized live runtime version"):
        return {"Rule": {"Id": rule}, "Location": {"Path": path}, "Message": message}

    def test_unchanged_live_schema_finding_does_not_hide_an_unrelated_model_update(self):
        before = {"runtime": "PYTHON_3_14", "model": "old"}
        after = {**before, "model": "global.openai.gpt-6-astra"}
        issue = self.issue(["runtime"])
        self.assertTrue(module.unchanged_lint_findings(before, after, [issue], [issue]))

    def test_new_findings_or_changed_problematic_values_are_rejected(self):
        before = {"runtime": "PYTHON_3_14", "model": "old"}
        issue = self.issue(["runtime"])
        self.assertFalse(module.unchanged_lint_findings(before, {**before, "runtime": "BOGUS"}, [issue], [issue]))
        self.assertFalse(module.unchanged_lint_findings(before, before, [issue], [issue, issue]))
        self.assertFalse(module.unchanged_lint_findings(before, before, [issue], [self.issue(["model"])]))


class RuntimeChangeScopeTests(unittest.TestCase):
    def change(self, logical="Agent", kind="AWS::BedrockAgentCore::Runtime", **fields):
        return {"LogicalResourceId": logical, "ResourceType": kind, "Action": "Modify", "Replacement": "False", **fields}

    def test_only_selected_runtime_updates_and_dynamic_gateway_references_are_allowed(self):
        agent, tools = self.change(), self.change("Tools")
        detail = {"Evaluation": "Dynamic", "ChangeSource": "ResourceAttribute", "CausingEntity": "Tools.AgentRuntimeArn"}
        dynamic = self.change("Target", "AWS::BedrockAgentCore::GatewayTarget", Details=[{
            **detail, "Target": {"Name": "TargetConfiguration"},
        }])
        policy = self.change("InvokePolicy", "AWS::IAM::Policy", Details=[{
            **detail, "Target": {"Name": "PolicyDocument"},
        }])
        self.assertTrue(module.allowed_changes([agent, tools, dynamic, policy], {"Agent", "Tools"}))
        for bad in (
            self.change("DifferentRuntime"),
            self.change("Agent", "AWS::IAM::Role"),
            self.change(Action="Remove"),
            self.change(Replacement="True"),
            self.change("Target", "AWS::BedrockAgentCore::GatewayTarget", Details=[{"Evaluation": "Static"}]),
            self.change("InvokePolicy", "AWS::IAM::Policy", Details=[{
                **detail, "ChangeSource": "DirectModification", "Target": {"Name": "PolicyDocument"},
            }]),
        ):
            with self.subTest(bad=bad):
                self.assertFalse(module.allowed_changes([agent, bad], {"Agent", "Tools"}))


class OfficialDetailPolicyTests(unittest.TestCase):
    def test_only_one_read_only_object_grant_can_be_added(self):
        bucket = "jeju-3d-data-061525506239-ap-northeast-2"
        before = {"Type": "AWS::IAM::Policy", "Properties": {
            "Roles": [{"Ref": "ToolsRole"}],
            "PolicyDocument": {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "logs:PutLogEvents", "Resource": "existing"}]},
        }}
        import copy
        after = copy.deepcopy(before)
        after["Properties"]["PolicyDocument"]["Statement"].append(module.detail_statement(bucket))
        self.assertTrue(module.detail_policy_only(before, after, bucket))
        after["Properties"]["PolicyDocument"]["Statement"][-1]["Action"] = "s3:PutObject"
        self.assertFalse(module.detail_policy_only(before, after, bucket))
        with self.assertRaises(RuntimeError):
            module.detail_statement("unrelated-bucket")

    def test_new_archive_files_require_an_explicit_allowlist(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            source = path / "source"
            (source / "ohmyjeju_tools").mkdir(parents=True)
            target_file = source / "ohmyjeju_tools/official_details.py"
            target_file.write_text("# new reviewed module")
            original = path / "original.zip"
            with zipfile.ZipFile(original, "w") as archive:
                archive.writestr("main.py", b"unchanged")
            result = path / "result.zip"
            module.patch_archive(original, result, source, ("ohmyjeju_tools/official_details.py",))
            with zipfile.ZipFile(result) as archive:
                self.assertEqual(archive.read("main.py"), b"unchanged")
                self.assertEqual(archive.read("ohmyjeju_tools/official_details.py"), target_file.read_bytes())


if __name__ == "__main__":
    unittest.main()
