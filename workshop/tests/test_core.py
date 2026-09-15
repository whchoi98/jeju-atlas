"""Core participants must not inherit the advanced lab's prerequisites or state."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "workshop/scripts/core.py"


class CoreTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.is_file(), "The core preparation/doctor helper is missing")
        spec = importlib.util.spec_from_file_location("atlas_core_test", SCRIPT)
        self.core = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.core)
        self.temporary = tempfile.TemporaryDirectory(prefix="atlas-core-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.repo = self.directory / "jeju-atlas"
        for name in ("AGENTS.md", ".nvmrc", "package.json", "workshop/course.json",
                     "workshop/scripts/lab.py", "workshop/scripts/lab_config.py",
                     "workshop/scripts/lab_workspace.py", "workshop/scripts/ec2_context.py",
                     "workshop/scripts/lab_cloudfront.py",
                     "workshop/scripts/model_config.py", "workshop/scripts/model_check.py",
                     "workshop/scripts/install_core.sh", "workshop/requirements-core.txt",
                     "agent/tools/data/jeju_pois.json"):
            destination = self.repo / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, destination)
        shutil.copyfile(SCRIPT, self.repo / "workshop/scripts/core.py")
        self.other = self.directory / "claude-lab"
        self.other.mkdir()
        (self.other / "keep.txt").write_text("existing project\n")

    def prepare(self):
        return self.core.prepare(self.repo, "team01", "AtlasCliTeam01")

    def test_missing_or_wrong_source_is_rejected_without_creating_directories(self):
        absent = self.directory / "absent"
        for source in (absent, self.other):
            with self.subTest(source=source):
                with self.assertRaises(ValueError):
                    self.core.prepare(source, "team01", "AtlasCliTeam01")
        self.assertFalse(absent.exists())
        self.assertEqual(list(self.other.iterdir()), [self.other / "keep.txt"])

    def test_source_missing_a_chapter_02_helper_cannot_pass_preparation(self):
        (self.repo / "workshop/scripts/lab_config.py").unlink()
        with self.assertRaisesRegex(ValueError, "lab_config.py"):
            self.prepare()
        self.assertFalse((self.repo / "workshop/.local").exists())

    def test_prepare_is_repeatable_and_preserves_participant_work(self):
        report = self.prepare()
        project = Path(report["projectPath"])
        project.mkdir()
        (project / "student.py").write_text("student work\n")
        activation = Path(report["activationPath"])
        before = activation.read_bytes()
        again = self.prepare()
        self.assertEqual(again["activationPath"], str(activation))
        self.assertEqual(activation.read_bytes(), before)
        self.assertEqual((project / "student.py").read_text(), "student work\n")
        with self.assertRaises(ValueError):
            self.core.prepare(self.repo, "team01", "AtlasCliAnother")
        self.assertEqual(activation.read_bytes(), before)

    def test_foreign_or_symlinked_local_storage_is_not_adopted(self):
        storage = self.repo / "workshop/.local"
        storage.symlink_to(self.other, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(list(self.other.iterdir()), [self.other / "keep.txt"])
        storage.unlink()
        toolchain = storage / "toolchain"
        toolchain.mkdir(parents=True)
        (toolchain / "keep.txt").write_text("not ours")
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual((toolchain / "keep.txt").read_text(), "not ours")

    def test_unsafe_names_are_rejected_before_any_local_write(self):
        for participant, project in (("../other", "AtlasCliTeam01"),
                                     ("team01", "AtlasCliTeam01;pwd"),
                                     ("production", "AtlasCliTeam01")):
            with self.subTest(participant=participant, project=project):
                with self.assertRaises(ValueError):
                    self.core.prepare(self.repo, participant, project)
        self.assertFalse((self.repo / "workshop/.local").exists())

    def test_new_bash_restores_paths_and_cli_config_without_aws_or_login_access(self):
        report = self.prepare()
        command = (
            'source "$1" || exit\n'
            'printf "%s\\n" "$ATLAS_REPO" "$ATLAS_TEAM" "$ATLAS_PROJECT" '
            '"$ATLAS_CLI" "$AGENTCORE_CONFIG_DIR" "$AGENTCORE_TELEMETRY_DISABLED" '
            '"$AWS_REGION" "$ATLAS_ACCOUNT"\n'
            'pwd\n'
        )
        result = subprocess.run(
            ["bash", "--noprofile", "--norc", "-c", command, "bash", report["activationPath"]],
            cwd=self.other, env={"PATH": os.defpath, "BASH_ENV": "/dev/null"},
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), [
            str(self.repo), "team01", "AtlasCliTeam01", report["projectPath"],
            str(Path(report["activationPath"]).parent / "cli-config"), "1",
            "ap-northeast-2", "", str(self.repo),
        ])
        self.assertEqual((self.other / "keep.txt").read_text(), "existing project\n")
        self.assertFalse((self.other / ".agentcore").exists())

    def test_bad_cli_config_stops_activation_and_is_not_overwritten(self):
        report = self.prepare()
        config = Path(report["activationPath"]).parent / "cli-config/config.json"
        value = json.loads(config.read_text())
        value["disableTransactionSearch"] = False
        config.write_text(json.dumps(value))
        before = config.read_bytes()
        result = subprocess.run(
            ["bash", "--noprofile", "--norc", "-c", 'source "$1"', "bash", report["activationPath"]],
            cwd=self.other, env={"PATH": os.defpath, "BASH_ENV": "/dev/null"},
            capture_output=True, text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(config.read_bytes(), before)

    def probes(self, command, **kwargs):
        """Only explicit version/discovery/import probes succeed; no cloud calls."""
        binary = Path(command[0]).name
        if binary == "uv" and command[1:3] == ["python", "find"]:
            return subprocess.CompletedProcess(command, 0, "/test/python3.14\n", "")
        if "-c" in command:
            return subprocess.CompletedProcess(command, 0, '{"boto3":"1.42.86","requests":"2.32.5"}', "")
        if command[1:] != ["--version"]:
            raise AssertionError("Unexpected external operation: " + repr(command))
        versions = {"node": "v24.21.0", "npm": "11.11.0", "uv": "uv 0.12.15",
                    "aws": "aws-cli/2.33.15", "claude": "2.1.272 (Claude Code)",
                    "python3.14": "Python 3.14.3"}
        if binary not in versions:
            raise AssertionError("Unexpected tool: " + binary)
        return subprocess.CompletedProcess(command, 0, versions[binary] + "\n", "")

    def ready_environment(self):
        report = self.prepare()
        tools = Path(report["toolchainPath"])
        package = tools / "agentcore/node_modules/@aws/agentcore"
        entry = package / "dist/cli/index.mjs"
        entry.parent.mkdir(parents=True)
        entry.write_text("// npm CLI fixture; must not execute\n")
        (package / "package.json").write_text(json.dumps({
            "name": "@aws/agentcore", "version": "0.28.1",
            "bin": {"agentcore": "dist/cli/index.mjs"},
        }))
        binary = tools / "agentcore/node_modules/.bin/agentcore"
        binary.parent.mkdir(parents=True)
        binary.symlink_to(entry)
        entry.chmod(0o755)
        env = {
            "PATH": os.defpath, "ATLAS_REPO": str(self.repo), "ATLAS_TEAM": "team01",
            "ATLAS_PROJECT": "AtlasCliTeam01", "ATLAS_CLI": report["projectPath"],
            "ATLAS_CLI_PARENT": str(Path(report["projectPath"]).parent),
            "ATLAS_CONFIG": str(self.repo / "workshop/.local/team01.json"),
            "AGENTCORE_CONFIG_DIR": str(Path(report["projectPath"]).parent / "cli-config"),
            "AGENTCORE_TELEMETRY_DISABLED": "1", "AWS_REGION": "ap-northeast-2",
            "AWS_DEFAULT_REGION": "ap-northeast-2", "ATLAS_REGION": "ap-northeast-2",
        }
        paths = {name: "/test/" + name for name in ("node", "npm", "uv", "aws", "claude")}
        paths["agentcore"] = str(binary)
        return env, paths

    def test_core_passes_with_claude_only_and_does_not_require_docker(self):
        env, paths = self.ready_environment()
        with patch.object(self.core.shutil, "which", side_effect=lambda name, **kw: paths.get(name)), \
                patch.object(self.core, "run_capture", side_effect=self.probes):
            result = self.core.doctor(self.repo, "claude", env)
        self.assertTrue(result["passed"], result)
        names = {check["name"] for check in result["checks"]}
        self.assertNotIn("docker", names)
        self.assertNotIn("codex", names)
        self.assertNotIn("kiro-cli", names)
        self.assertFalse(result["awsChecked"])
        self.assertFalse(result["modelInvoked"])

    def test_measured_ec2_failures_are_reported_together(self):
        env, paths = self.ready_environment()
        paths.pop("agentcore")
        def observed(command, **kwargs):
            if Path(command[0]).name == "node":
                return subprocess.CompletedProcess(command, 0, "v20.20.1", "")
            if command[1:3] == ["python", "find"]:
                return subprocess.CompletedProcess(command, 1, "", "No interpreter found for Python 3.14")
            if "-c" in command:
                return subprocess.CompletedProcess(command, 1, "", "ModuleNotFoundError: boto3")
            return self.probes(command, **kwargs)
        with patch.object(self.core.shutil, "which", side_effect=lambda name, **kw: paths.get(name)), \
                patch.object(self.core, "run_capture", side_effect=observed):
            result = self.core.doctor(self.repo, "claude", env)
        failures = {check["name"] for check in result["checks"] if not check["ok"]}
        self.assertTrue({"node", "python3.14", "agentcore", "helper-packages"}.issubset(failures), result)
        self.assertFalse(result["passed"])
        self.assertTrue(next(check for check in result["checks"] if check["name"] == "claude")["ok"])

    def test_unset_session_and_a_python_starter_cli_do_not_pass(self):
        env, paths = self.ready_environment()
        env.pop("ATLAS_CLI")
        paths["agentcore"] = "/test/python-starter-agentcore"
        with patch.object(self.core.shutil, "which", side_effect=lambda name, **kw: paths.get(name)), \
                patch.object(self.core, "run_capture", side_effect=self.probes):
            result = self.core.doctor(self.repo, "claude", env)
        failures = {check["name"] for check in result["checks"] if not check["ok"]}
        self.assertIn("session", failures)
        self.assertIn("agentcore", failures)

    def test_project_check_rejects_missing_runtime_and_wrong_target(self):
        report = self.prepare()
        with self.assertRaises(ValueError):
            self.core.check_project(self.repo, "team01", "AtlasCliTeam01")
        config = self.repo / "workshop/.local/team01.json"
        config.write_text(json.dumps({"participant": "team01", "accountId": "123456789012",
                                      "region": "ap-northeast-2"}))
        project = Path(report["projectPath"])
        (project / "agentcore").mkdir(parents=True)
        (project / "agentcore/aws-targets.json").write_text(json.dumps([
            {"name": "default", "account": "999999999999", "region": "ap-northeast-2"},
        ]))
        with self.assertRaises(ValueError):
            self.core.check_project(self.repo, "team01", "AtlasCliTeam01")

    def test_installer_rejects_foreign_toolchain_before_downloading(self):
        installer = ROOT / "workshop/scripts/install_core.sh"
        self.assertTrue(installer.is_file(), "The private core toolchain installer is missing")
        tools = self.repo / "workshop/.local/toolchain"
        tools.mkdir(parents=True)
        (tools / "keep.txt").write_text("another installation")
        result = subprocess.run(["bash", str(installer), "--repo", str(self.repo)],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(list(tools.iterdir()), [tools / "keep.txt"])

    def test_installer_rejects_bad_node_checksum_without_replacing_tools(self):
        installer = ROOT / "workshop/scripts/install_core.sh"
        self.assertTrue(installer.is_file(), "The private core toolchain installer is missing")
        report = self.prepare()
        tools = Path(report["toolchainPath"])
        fakebin = self.directory / "bin"
        fakebin.mkdir()
        # Exercise the real shell installer; only the network boundary is fake.
        curl = fakebin / "curl"
        curl.write_text('''#!/bin/bash
while (($#)); do
  if [[ "$1" == "--output" ]]; then output="$2"; shift 2; else url="$1"; shift; fi
done
if [[ "$url" == */SHASUMS256.txt ]]; then
  printf '%064d  node-v24.21.0-linux-arm64.tar.gz\\n' 0 > "$output"
  printf '%064d  node-v24.21.0-linux-x64.tar.gz\\n' 0 >> "$output"
else
  printf 'corrupt download' > "$output"
fi
''')
        curl.chmod(0o755)
        uv = fakebin / "uv"
        uv.write_text("#!/bin/sh\nexit 91\n")
        uv.chmod(0o755)
        result = subprocess.run(
            ["bash", str(installer), "--repo", str(self.repo)],
            env={**os.environ, "PATH": str(fakebin) + ":" + os.defpath},
            capture_output=True, text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("checksum", (result.stdout + result.stderr).lower())
        self.assertFalse((tools / "node-v24.21.0").exists())
        self.assertFalse((tools / "helpers").exists())
        self.assertEqual((self.other / "keep.txt").read_text(), "existing project\n")

    def test_failed_npm_install_does_not_publish_a_partial_cli(self):
        report = self.prepare()
        tools = Path(report["toolchainPath"])
        node = tools / "node-v24.21.0/bin/node"
        node.parent.mkdir(parents=True)
        node.write_text("#!/bin/sh\nprintf 'v24.21.0\\n'\n")
        node.chmod(0o755)
        helper = tools / "helpers/bin/python3"
        helper.parent.mkdir(parents=True)
        helper.write_text("#!/bin/sh\nexit 0\n")
        helper.chmod(0o755)
        fakebin = self.directory / "bin"
        fakebin.mkdir()
        uv = fakebin / "uv"
        uv.write_text("#!/bin/sh\ncase \"$*\" in *'python find'*) printf '/test/python3.14\\n';; esac\n")
        uv.chmod(0o755)
        npm = fakebin / "npm"
        npm.write_text('''#!/bin/sh
test "$1" = --prefix || exit 91
mkdir -p "$2/node_modules"
printf 'partial install\\n' > "$2/node_modules/incomplete"
exit 53
''')
        npm.chmod(0o755)
        result = subprocess.run(
            ["bash", str(ROOT / "workshop/scripts/install_core.sh"), "--repo", str(self.repo)],
            env={**os.environ, "PATH": str(fakebin) + ":" + os.defpath},
            capture_output=True, text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((tools / "agentcore").exists(), "An incomplete npm install must remain unpublished")
        self.assertTrue(node.exists())
        self.assertTrue(helper.exists())

    def test_project_check_accepts_complete_local_files_without_calling_aws(self):
        report = self.prepare()
        (self.repo / "workshop/.local/team01.json").write_text(json.dumps({
            "participant": "team01", "accountId": "123456789012", "region": "ap-northeast-2",
        }))
        project = Path(report["projectPath"])
        (project / "agentcore").mkdir(parents=True)
        target = project / "agentcore/aws-targets.json"
        target.write_text(json.dumps([{"name": "default", "account": "123456789012", "region": "ap-northeast-2"}]))
        (project / "agentcore/agentcore.json").write_text(json.dumps({
            "name": "AtlasCliTeam01", "runtimes": [{
                "name": "JejuGuide", "build": "CodeZip", "codeLocation": "app/JejuGuide/",
                "runtimeVersion": "PYTHON_3_14", "networkMode": "PUBLIC",
                "envVars": [{"name": "ATLAS_BEDROCK_REGION", "value": "ap-northeast-2"}],
            }],
        }))
        for name in ("main.py", "model/load.py", "pyproject.toml", "tests/test_search.py"):
            file = project / "app/JejuGuide" / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("# local fixture\n")
        sys.path.insert(0, str(ROOT / "workshop/scripts"))
        from model_config import LOADER
        (project / "app/JejuGuide/model/load.py").write_text(LOADER)
        data = project / "app/JejuGuide/data/jeju_pois.json"
        data.parent.mkdir()
        shutil.copyfile(self.repo / "agent/tools/data/jeju_pois.json", data)
        self.assertEqual(self.core.check_project(self.repo, "team01", "AtlasCliTeam01"), str(project))
        data.write_text("[]")
        with self.assertRaises(ValueError):
            self.core.check_project(self.repo, "team01", "AtlasCliTeam01")


if __name__ == "__main__":
    unittest.main()
