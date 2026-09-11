"""Offline checks for boundaries that protect the shared/reference workspace."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


PREPARER = Path(__file__).with_name("prepare.py")


class PrepareTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="atlas-cli-test-")
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)

    def prepare(self, output, name="AtlasCliTeam01", account="123456789012",
                region="ap-northeast-2"):
        return subprocess.run(
            [
                sys.executable, str(PREPARER),
                "--project-name", name,
                "--account-id", account,
                "--region", region,
                "--output", str(output),
            ],
            text=True, capture_output=True, check=False,
        )

    def generated(self, output):
        result = self.prepare(output)
        self.assertEqual(result.returncode, 0, result.stderr)
        return output

    def test_generation_is_reproducible_and_has_only_the_owned_runtime(self):
        first = self.generated(self.root / "one")
        second = self.generated(self.root / "two")
        snapshot = lambda root: {
            str(p.relative_to(root)): p.read_bytes()
            for p in root.rglob("*") if p.is_file()
        }
        self.assertEqual(snapshot(first), snapshot(second))
        spec = json.loads((first / "agentcore/agentcore.json").read_text())
        self.assertEqual(spec["name"], "AtlasCliTeam01")
        self.assertEqual([a["name"] for a in spec["runtimes"]], ["Warmup"])
        for resource in ("memories", "credentials", "agentCoreGateways", "harnesses"):
            self.assertEqual(spec[resource], [])
        target = json.loads((first / "agentcore/aws-targets.json").read_text())
        self.assertEqual(target, [{
            "name": "default", "account": "123456789012", "region": "ap-northeast-2",
        }])
        runtime = spec["runtimes"][0]
        code_root = (first / runtime["codeLocation"]).resolve()
        self.assertEqual(code_root.parent, first / "app")
        self.assertTrue((code_root / runtime["entrypoint"]).is_file())
        self.assertEqual(runtime["build"], "CodeZip")
        self.assertEqual(runtime["runtimeVersion"], "PYTHON_3_14")
        self.assertEqual(runtime["instrumentation"], {"enableOtel": False})
        env = {v["name"]: v["value"] for v in runtime["envVars"]}
        self.assertEqual(env["OTEL_SDK_DISABLED"], "true")
        self.assertEqual(env["OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT"], "false")
        config = json.loads((first / ".cli-config/config.json").read_text())
        self.assertTrue(config["disableTransactionSearch"])
        self.assertTrue(config["disableDependencyManagement"])
        self.assertFalse(config["telemetry"]["enabled"])
        self.assertFalse(any(p.name.startswith(".env") for p in first.rglob("*")))

    def test_existing_empty_directory_is_not_reused(self):
        output = self.root / "existing"
        output.mkdir()
        result = self.prepare(output)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(list(output.iterdir()), [])

    def test_participant_verify_does_not_match_live_across_the_cli_prefix(self):
        output = self.root / "verify"
        result = self.prepare(output, name="AtlasCliVerify03")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads((output / "agentcore/agentcore.json").read_text())["name"],
                         "AtlasCliVerify03")

    def test_existing_project_is_not_overwritten(self):
        output = self.generated(self.root / "existing")
        marker = output / "participant-work.txt"
        marker.write_text("keep this work", encoding="utf-8")
        before = {p: p.read_bytes() for p in output.rglob("*") if p.is_file()}
        self.assertNotEqual(self.prepare(output).returncode, 0)
        self.assertEqual(before, {p: p.read_bytes() for p in output.rglob("*") if p.is_file()})

    def test_production_and_unowned_names_are_rejected_before_writes(self):
        for name in (
            "JejuGuide", "JejuAtlas", "Atlas", "production", "AtlasCliProd",
            "AtlasCliShared", "AtlasCliLive", "AtlasCliReference", "AtlasCli",
            "AtlasCliTeam_01", "AtlasCli../../app", "AtlasCliTeam1234567890123456",
        ):
            with self.subTest(name=name):
                output = self.root / "new"
                result = self.prepare(output, name=name)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(output.exists())

    def test_other_account_shapes_and_regions_are_rejected_before_writes(self):
        for account, region in (
            ("123", "ap-northeast-2"), ("000000000000", "ap-northeast-2"),
            ("１２３４５６７８９０１２", "ap-northeast-2"),
            ("123456789012", "us-east-1"),
        ):
            with self.subTest(account=account, region=region):
                output = self.root / "new"
                self.assertNotEqual(self.prepare(output, account=account, region=region).returncode, 0)
                self.assertFalse(output.exists())

    def test_symlink_destination_and_symlink_parent_are_rejected(self):
        target = self.root / "target"
        target.mkdir()
        link = self.root / "link"
        link.symlink_to(target, target_is_directory=True)
        self.assertNotEqual(self.prepare(link).returncode, 0)
        self.assertNotEqual(self.prepare(link / "child").returncode, 0)
        self.assertEqual(list(target.iterdir()), [])
        broken = self.root / "broken"
        broken.symlink_to(self.root / "missing", target_is_directory=True)
        self.assertNotEqual(self.prepare(broken).returncode, 0)
        self.assertFalse((self.root / "missing").exists())

    def test_reference_repository_destinations_are_rejected(self):
        for reference in ("agentcore-cli", "agentcore-cli-main", "agentcore-cli-worktree"):
            root = self.root / reference
            root.mkdir()
            self.assertNotEqual(self.prepare(root / "fresh").returncode, 0)
            self.assertEqual(list(root.iterdir()), [])

    def test_paths_unsafe_for_the_upstream_shell_packager_are_rejected(self):
        for name in ("two words", "lab;command", "lab$(command)", "lab`command`", "한글"):
            with self.subTest(name=name):
                output = self.root / name
                self.assertNotEqual(self.prepare(output).returncode, 0)
                self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
