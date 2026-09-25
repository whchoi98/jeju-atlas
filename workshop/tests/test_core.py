"""Core participants must not inherit the advanced lab's prerequisites or state."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "workshop/scripts/core.py"


def copy_core_source(repo):
    for name in ("AGENTS.md", ".nvmrc", "package.json", "workshop/course.json",
                 "workshop/scripts/core.py",
                 "workshop/scripts/lab.py", "workshop/scripts/lab_config.py",
                 "workshop/scripts/lab_workspace.py", "workshop/scripts/ec2_context.py",
                 "workshop/scripts/lab_cloudfront.py",
                 "workshop/scripts/model_config.py", "workshop/scripts/model_check.py",
                 "workshop/scripts/install_core.sh", "workshop/requirements-core.txt",
                 "workshop/scripts/start.sh", "workshop/scripts/check_env.sh",
                 "workshop/scripts/workshop_env.py", "workshop/scripts/key_binding.py",
                 "workshop/scripts/cdk_bootstrap.py",
                 "workshop/.env.example",
                 "agent/tools/data/jeju_pois.json"):
        destination = repo / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, destination)


class InstallFixture:
    """Run the real preparation/installer with offline executable boundaries."""

    def __init__(self, directory, repo, node_version="24.18.1", cli_version="0.28.1"):
        self.directory = directory / "installed-tools"
        self.bin = self.directory / "bin"
        self.global_prefix = self.directory / "user/.npm-global"
        self.tools = repo / "workshop/.local/toolchain"
        self.commands = self.directory / "commands.jsonl"
        self.bin.mkdir(parents=True)
        packages = self.directory / "packages"
        packages.mkdir()
        for name, version in (("boto3", "1.42.86"), ("requests", "2.32.5")):
            (packages / (name + ".py")).write_text("__version__ = " + repr(version) + "\n")
        # The fixture executes real core Python code, with the interpreter
        # version supplied at the process boundary instead of requiring a
        # particular host Python installation or downloading one in tests.
        self.python_template = self.directory / "python-template"
        self.python_template.write_text(f"""#!{sys.executable}
import collections, pathlib, runpy, sys
sys.version_info = collections.namedtuple("version_info", "major minor micro releaselevel serial")(*__VERSION__)
sys.executable = str(pathlib.Path(__file__))
args = sys.argv[1:]
if args and args[0] == "-B":
    args = args[1:]
if args == ["--version"]:
    print("Python %d.%d.%d" % sys.version_info[:3])
elif args and args[0] == "-c":
    sys.argv = args
    exec(args[1], {{"__name__": "__main__"}})
elif args and args[0] == "-":
    sys.argv = args
    exec(sys.stdin.read(), {{"__name__": "__main__"}})
else:
    sys.argv = args
    sys.path.insert(0, str(pathlib.Path(args[0]).parent))
    runpy.run_path(args[0], run_name="__main__")
""")
        self.env = {
            "PATH": str(self.bin) + ":" + str(self.global_prefix / "bin") + ":" + os.defpath,
            "BASH_ENV": "/dev/null", "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONPATH": str(packages),
            "ATLAS_TEST_COMMANDS": str(self.commands),
            "ATLAS_TEST_PYTHON_TEMPLATE": str(self.python_template),
        }
        (self.bin / "python3").symlink_to(sys.executable)
        self.program(self.bin / "node", f"""
if sys.argv[1:] != ["--version"]: sys.exit(91)
print("v{node_version}")
""")
        self.program(self.bin / "npm", """
args = sys.argv[1:]
if args == ["--version"]:
    print("11.11.0")
    sys.exit()
if not (args[0] == "--prefix" and args[2] == "install"
        and args[-1] == "@aws/agentcore@0.28.1"):
    sys.exit(91)
destination = Path(args[1])
destination.mkdir(exist_ok=True)
if os.environ.get("ATLAS_TEST_NPM_FAIL"):
    (destination / "incomplete").write_text("partial install")
    sys.exit(53)
package = destination / "node_modules/@aws/agentcore"
entry = package / "dist/cli/index.mjs"
entry.parent.mkdir(parents=True)
entry.write_text("#!/bin/sh\\nexit 91\\n")
entry.chmod(0o755)
(package / "package.json").write_text(json.dumps({
    "name": "@aws/agentcore", "version": "0.28.1",
    "bin": {"agentcore": "dist/cli/index.mjs"},
}))
binary = destination / "node_modules/.bin/agentcore"
binary.parent.mkdir(parents=True)
binary.symlink_to("../@aws/agentcore/dist/cli/index.mjs")
(destination / "package.json").write_text(json.dumps({"dependencies": {"@aws/agentcore": "0.28.1"}}))
(destination / "package-lock.json").write_text('{"lockfileVersion":3}\\n')
""")
        self.program(self.bin / "uv", """
args = [arg for arg in sys.argv[1:] if arg != "--no-config"]
if args == ["--version"]:
    print("uv 0.12.15")
    sys.exit()
runtime = Path(os.environ["UV_PYTHON_INSTALL_DIR"]) / "cpython-fixture/bin/python3.12"
if args[:2] == ["python", "install"]:
    if args[2:] != ["--no-bin", "3.12"]: sys.exit(92)
    runtime.parent.mkdir(parents=True, exist_ok=True)
    runtime.write_text(Path(os.environ["ATLAS_TEST_PYTHON_TEMPLATE"]).read_text().replace(
        "__VERSION__", repr((3, 12, 13, "final", 0))))
    runtime.chmod(0o755)
elif args[:2] == ["python", "find"]:
    if args[-1] != "3.12" or "--no-python-downloads" not in args or not runtime.is_file():
        sys.exit(93)
    print(runtime)
elif args[:1] == ["venv"]:
    if args[1:3] != ["--python", str(runtime)]: sys.exit(94)
    helper = Path(args[-1]) / "bin/python3"
    helper.parent.mkdir(parents=True)
    helper.write_bytes(runtime.read_bytes())
    helper.chmod(0o755)
elif args[:2] != ["pip", "install"]:
    sys.exit(95)
""")
        for name in ("aws", "codex", "claude", "kiro-cli"):
            self.program(self.bin / name, f"""
if sys.argv[1:] != ["--version"]: sys.exit(91)
print("{name} fixture")
""")
        # Never reach the real network, cloud, or Docker daemon from a test.
        self.program(self.bin / "curl", "sys.exit(96)\n")
        self.program(self.bin / "docker", "sys.exit(97)\n")
        if cli_version:
            self.agentcore(self.global_prefix, cli_version)

    def program(self, path, body):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"""#!{sys.executable}
import json, os, sys
from pathlib import Path
with open(os.environ["ATLAS_TEST_COMMANDS"], "a") as stream:
    stream.write(json.dumps([Path(__file__).name, *sys.argv[1:]]) + "\\n")
""" + body)
        path.chmod(0o755)

    def agentcore(self, prefix, version):
        package = prefix / "lib/node_modules/@aws/agentcore"
        entry = package / "dist/cli/index.mjs"
        self.program(entry, "sys.exit(91)\n")
        (package / "package.json").write_text(json.dumps({
            "name": "@aws/agentcore", "version": version,
            "bin": {"agentcore": "dist/cli/index.mjs"},
        }))
        binary = prefix / "bin/agentcore"
        binary.parent.mkdir(parents=True, exist_ok=True)
        binary.symlink_to(entry)
        return binary

    def helper(self, version):
        helper = self.tools / "helpers/bin/python3"
        helper.parent.mkdir(parents=True)
        helper.write_text(self.python_template.read_text().replace("__VERSION__", repr((*version, "final", 0))))
        helper.chmod(0o755)
        return helper

    def restrict_path(self, missing=()):
        """Expose only fixture tools and the installer's real OS utilities."""
        for name in ("bash", "dirname", "uname", "mktemp", "rm", "mv", "tar",
                     "gzip", "sha256sum", "awk", "cat"):
            (self.bin / name).symlink_to(shutil.which(name))
        for name in missing:
            (self.bin / name).unlink()
        self.env["PATH"] = str(self.bin) + ":" + str(self.global_prefix / "bin")
        self.env.pop("PYTHONPATH", None)

    def trace_bootstrap(self):
        # Unlink the fixture symlink before writing a wrapper around real Python.
        binary = self.bin / "python3"
        binary.unlink()
        self.program(binary, f"os.execv({sys.executable!r}, [{sys.executable!r}, *sys.argv[1:]])\n")

    def node_download(self, *, checksum_ok=True, include_npm=True, reported_version="24.21.0"):
        """Serve a local archive; keep extraction and checksum validation real."""
        arch = "arm64" if os.uname().machine in {"aarch64", "arm64"} else "x64"
        name = "node-v24.21.0-linux-" + arch
        unpacked = self.directory / name
        self.program(unpacked / "bin/node", f'print("v{reported_version}")\n')
        if include_npm:
            shutil.copyfile(self.bin / "npm", unpacked / "bin/npm")
            (unpacked / "bin/npm").chmod(0o755)
        archive = self.directory / (name + ".tar.gz")
        with tarfile.open(archive, "w:gz") as stream:
            stream.add(unpacked, arcname=name)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest() if checksum_ok else "0" * 64
        self.program(self.bin / "curl", f"""
args = sys.argv[1:]
output = Path(args[args.index("--output") + 1])
if args[-1] == "https://nodejs.org/dist/v24.21.0/SHASUMS256.txt":
    output.write_text("{digest}  {name}.tar.gz\\n")
elif args[-1] == "https://nodejs.org/dist/v24.21.0/{name}.tar.gz":
    output.write_bytes(Path({str(archive)!r}).read_bytes())
else:
    sys.exit(96)
""")

    def calls(self):
        return [json.loads(line) for line in self.commands.read_text().splitlines()] if self.commands.exists() else []


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
        copy_core_source(self.repo)
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

    def test_source_missing_a_start_or_environment_helper_cannot_pass_preparation(self):
        for name in ("workshop/scripts/start.sh", "workshop/scripts/check_env.sh",
                     "workshop/scripts/workshop_env.py", "workshop/scripts/key_binding.py",
                     "workshop/.env.example"):
            with self.subTest(file=name):
                path = self.repo / name
                before = path.read_bytes()
                path.unlink()
                with self.assertRaises(ValueError):
                    self.prepare()
                self.assertFalse((self.repo / "workshop/.local").exists())
                path.write_bytes(before)

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

    def test_switching_assistant_preserves_project_credentials_and_account(self):
        report = self.core.prepare(self.repo, "team01", "AtlasCliTeam01", "codex")
        parent = Path(report["activationPath"]).parent
        project = Path(report["projectPath"])
        project.mkdir()
        student = project / "student.py"
        student.write_text("# participant implementation\n")
        env_file = parent / ".env"
        env_file.write_text("TOKEN=TEST_SECRET_MUST_NOT_BE_PRINTED\n")
        env_file.chmod(0o600)
        account = self.repo / "workshop/.local/team01.json"
        account.write_text(json.dumps({
            "participant": "team01", "accountId": "123456789012", "region": "ap-northeast-2",
        }))
        protected = (student, env_file, account, parent / "cli-config/config.json")
        before = {path: (path.read_bytes(), path.stat().st_mode) for path in protected}
        for assistant in ("claude", "kiro", "codex"):
            with self.subTest(assistant=assistant):
                self.core.prepare(self.repo, "team01", "AtlasCliTeam01", assistant)
                result = subprocess.run(
                    ["bash", "--noprofile", "--norc", "-c",
                     'source "$1" && printf "%s\\n" "$ATLAS_ASSISTANT" "$ATLAS_ACCOUNT" "$ATLAS_CLI"',
                     "bash", report["activationPath"]],
                    env={"PATH": os.defpath, "BASH_ENV": "/dev/null"},
                    capture_output=True, text=True,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.splitlines(), [
                    assistant, "123456789012", str(project),
                ])
                self.assertEqual(json.loads((parent / ".owner.json").read_text())["assistant"], assistant)
                self.assertEqual(before, {
                    path: (path.read_bytes(), path.stat().st_mode) for path in protected
                })

    def test_assistant_switch_keeps_modified_setup_and_reports_conflicting_field(self):
        report = self.prepare()
        parent = Path(report["activationPath"]).parent
        owner_file = parent / ".owner.json"
        owner = owner_file.read_bytes()
        activation = Path(report["activationPath"])
        original_activation = activation.read_bytes()
        for field, value in (("repo", str(self.other)), ("project", "AtlasCliAnother"),
                             ("format", "foreign-session/v1"), ("participant", "team02")):
            with self.subTest(field=field):
                data = json.loads(owner)
                data[field] = value
                owner_file.write_text(json.dumps(data))
                before = owner_file.read_bytes()
                with self.assertRaisesRegex(ValueError, field):
                    self.core.prepare(self.repo, "team01", "AtlasCliTeam01", "kiro")
                self.assertEqual(owner_file.read_bytes(), before)
                self.assertEqual(activation.read_bytes(), original_activation)
        owner_file.write_bytes(owner)
        activation.write_bytes(original_activation + b"# participant customization\n")
        before = activation.read_bytes()
        with self.assertRaisesRegex(ValueError, "Activation"):
            self.core.prepare(self.repo, "team01", "AtlasCliTeam01", "kiro")
        self.assertEqual(activation.read_bytes(), before)
        self.assertEqual(owner_file.read_bytes(), owner)

    def test_assistant_switch_restores_original_metadata_when_replace_fails(self):
        report = self.prepare()
        parent = Path(report["activationPath"]).parent
        before = {path: (path.read_bytes(), path.stat().st_mode)
                  for path in (parent / ".owner.json", parent / "activate.sh")}
        replace = os.replace
        failed = False

        def fail_owner_once(source, destination):
            nonlocal failed
            if Path(destination) == parent / ".owner.json" and not failed:
                failed = True
                raise OSError("simulated metadata write failure")
            return replace(source, destination)

        with patch.object(self.core.os, "replace", side_effect=fail_owner_once):
            with self.assertRaisesRegex(OSError, "simulated"):
                self.core.prepare(self.repo, "team01", "AtlasCliTeam01", "kiro")
        self.assertTrue(failed)
        self.assertEqual(before, {
            path: (path.read_bytes(), path.stat().st_mode) for path in before
        })
        self.core.check_session(self.repo, "team01", "AtlasCliTeam01")
        self.core.prepare(self.repo, "team01", "AtlasCliTeam01", "kiro")
        self.assertFalse(list(parent.glob(".assistant-update-*")))

    def test_assistant_switch_refuses_linked_metadata_without_changing_link_target(self):
        report = self.prepare()
        parent = Path(report["activationPath"]).parent
        for name in (".owner.json", "activate.sh"):
            with self.subTest(file=name):
                path = parent / name
                linked = self.other / ("linked-" + name)
                os.link(path, linked)
                before = linked.read_bytes()
                with self.assertRaisesRegex(ValueError, "link"):
                    self.core.prepare(self.repo, "team01", "AtlasCliTeam01", "kiro")
                self.assertEqual(linked.read_bytes(), before)
                self.assertEqual(path.read_bytes(), before)
                linked.unlink()

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
            self.assertEqual(command[-1], "3.12")
            self.assertIn("--no-python-downloads", command)
            return subprocess.CompletedProcess(command, 0, "/test/python3.12\n", "")
        if "-c" in command:
            return subprocess.CompletedProcess(command, 0, '{"boto3":"1.42.86","requests":"2.32.5"}', "")
        if command[1:] != ["--version"]:
            raise AssertionError("Unexpected external operation: " + repr(command))
        versions = {"node": "v24.21.0", "npm": "11.11.0", "uv": "uv 0.12.15",
                    "aws": "aws-cli/2.33.15", "claude": "2.1.272 (Claude Code)",
                    "python3.12": "Python 3.12.13"}
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

    def test_doctor_rejects_a_different_python_minor_even_if_newer(self):
        env, paths = self.ready_environment()
        def observed(command, **kwargs):
            if Path(command[0]).name == "python3.12":
                return subprocess.CompletedProcess(command, 0, "Python 3.14.3", "")
            return self.probes(command, **kwargs)
        with patch.object(self.core.shutil, "which", side_effect=lambda name, **kw: paths.get(name)), \
                patch.object(self.core, "run_capture", side_effect=observed):
            result = self.core.doctor(self.repo, "claude", env)
        failure = next(check for check in result["checks"] if check["name"] == "python3.12")
        self.assertFalse(failure["ok"], result)
        self.assertFalse(result["passed"])

    def test_doctor_rejects_old_helpers_even_when_packages_import_and_python_is_optimized(self):
        env, paths = self.ready_environment()
        fixture = InstallFixture(self.directory, self.repo)
        helper = fixture.helper((3, 11, 9))
        env.update({"PYTHONPATH": fixture.env["PYTHONPATH"], "PYTHONOPTIMIZE": "1",
                    "PYTHONDONTWRITEBYTECODE": "1"})
        capture = self.core.run_capture
        def observed(command, **kwargs):
            if "-c" in command:
                return capture(command, **kwargs)
            return self.probes(command, **kwargs)
        with patch.object(self.core.shutil, "which", side_effect=lambda name, **kw: paths.get(name)), \
                patch.object(self.core, "run_capture", side_effect=observed), \
                patch.object(self.core.sys, "executable", str(helper)):
            result = self.core.doctor(self.repo, "claude", env)
        check = next(check for check in result["checks"] if check["name"] == "helper-packages")
        self.assertFalse(check["ok"], result)
        self.assertIn("3.12", check["reason"])
        self.assertFalse(result["passed"])

    def test_measured_ec2_failures_are_reported_together(self):
        env, paths = self.ready_environment()
        paths.pop("agentcore")
        def observed(command, **kwargs):
            if Path(command[0]).name == "node":
                return subprocess.CompletedProcess(command, 0, "v20.20.1", "")
            if command[1:3] == ["python", "find"]:
                return subprocess.CompletedProcess(command, 1, "", "No interpreter found for Python 3.12")
            if "-c" in command:
                return subprocess.CompletedProcess(command, 1, "", "ModuleNotFoundError: boto3")
            return self.probes(command, **kwargs)
        with patch.object(self.core.shutil, "which", side_effect=lambda name, **kw: paths.get(name)), \
                patch.object(self.core, "run_capture", side_effect=observed):
            result = self.core.doctor(self.repo, "claude", env)
        failures = {check["name"] for check in result["checks"] if not check["ok"]}
        self.assertTrue({"node", "python3.12", "agentcore", "helper-packages"}.issubset(failures), result)
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

    def install(self, fixture, *args):
        return subprocess.run(
            ["bash", str(ROOT / "workshop/scripts/install_core.sh"),
             *(args or ("--repo", str(self.repo)))],
            env=fixture.env, capture_output=True, text=True, timeout=30,
        )

    def test_node_only_installs_pinned_node_for_node20_without_uv_or_other_tools(self):
        report = self.prepare()
        fixture = InstallFixture(self.directory, self.repo, node_version="20.20.2", cli_version=None)
        fixture.restrict_path(missing=("uv", "aws", "codex", "claude", "kiro-cli", "docker"))
        fixture.node_download()
        before = {path: path.read_bytes() for path in (fixture.bin / "node", fixture.bin / "npm")}
        result = self.install(fixture, "--repo", str(self.repo), "--node-only")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(".tar.gz: OK", result.stdout)
        self.assertNotIn("Core tools prepared", result.stdout)
        self.assertNotIn("doctor", result.stdout)
        private = fixture.tools / "node-v24.21.0"
        self.assertTrue((private / "bin/node").is_file())
        self.assertTrue((private / "bin/npm").is_file())
        self.assertEqual({path.name for path in fixture.tools.iterdir()}, {".owner.json", "node-v24.21.0"})
        for path, content in before.items():
            self.assertEqual(path.read_bytes(), content, "The user-global tools must remain untouched")
        calls = fixture.calls()
        self.assertEqual(sum(call[0] == "curl" for call in calls), 2)
        self.assertTrue(all(call[0] in {"node", "npm", "curl"} for call in calls), calls)
        self.assertTrue(all(call[1:] == ["--version"] for call in calls if call[0] == "npm"))
        downloads = [Path(call[call.index("--output") + 1]) for call in calls if call[0] == "curl"]
        self.assertTrue(all(path.parent.parent == fixture.tools
                            and path.parent.name.startswith(".node-install-") for path in downloads))
        activation = subprocess.run(
            ["bash", "--noprofile", "--norc", "-c",
             'source "$1" && command -v node && command -v npm && node --version && npm --version',
             "bash", report["activationPath"]],
            env=fixture.env, capture_output=True, text=True, timeout=15,
        )
        self.assertEqual(activation.returncode, 0, activation.stderr)
        self.assertEqual(activation.stdout.splitlines(), [
            str(private / "bin/node"), str(private / "bin/npm"), "v24.21.0", "11.11.0",
        ])
        again = self.install(fixture, "--node-only", "--repo", str(self.repo))
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        self.assertEqual(sum(call[0] == "curl" for call in fixture.calls()), 2)
        self.assertEqual({path.name for path in fixture.tools.iterdir()}, {".owner.json", "node-v24.21.0"})

    def test_node_only_reuses_compatible_global_node_in_either_argument_order(self):
        self.prepare()
        fixture = InstallFixture(self.directory, self.repo, cli_version=None)
        fixture.restrict_path()
        for version, args in (
            ("24.18.1", ("--node-only", "--repo", str(self.repo))),
            ("24.21.0", ("--repo", str(self.repo), "--node-only")),
        ):
            with self.subTest(version=version):
                fixture.program(fixture.bin / "node", f'print("v{version}")\n')
                result = self.install(fixture, *args)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual({path.name for path in fixture.tools.iterdir()}, {".owner.json"})
        calls = fixture.calls()
        self.assertTrue(all(call[0] in {"node", "npm"} and call[1:] == ["--version"] for call in calls), calls)

    def test_node_only_rejects_bad_checksum_without_publishing_node(self):
        self.prepare()
        fixture = InstallFixture(self.directory, self.repo, node_version="20.20.2", cli_version=None)
        fixture.restrict_path(missing=("uv",))
        fixture.node_download(checksum_ok=False)
        result = self.install(fixture, "--node-only", "--repo", str(self.repo))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("checksum", (result.stdout + result.stderr).lower())
        self.assertEqual({path.name for path in fixture.tools.iterdir()}, {".owner.json"})
        self.assertEqual(sum(call[0] == "node" for call in fixture.calls()), 1,
                         "A download with a bad checksum must never execute")
        self.assertTrue(all(call[0] in {"node", "curl"} for call in fixture.calls()))

    def test_node_only_checks_staged_node_version_before_publishing(self):
        self.prepare()
        fixture = InstallFixture(self.directory, self.repo, node_version="20.20.2", cli_version=None)
        fixture.restrict_path(missing=("uv",))
        fixture.node_download(reported_version="24.18.0")
        result = self.install(fixture, "--repo", str(self.repo), "--node-only")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(".tar.gz: OK", result.stdout)
        self.assertEqual({path.name for path in fixture.tools.iterdir()}, {".owner.json"})
        self.assertTrue(all(call[0] in {"node", "curl"} for call in fixture.calls()))

    def test_node_only_checks_staged_npm_before_publishing(self):
        self.prepare()
        fixture = InstallFixture(self.directory, self.repo, node_version="20.20.2", cli_version=None)
        fixture.restrict_path(missing=("uv",))
        fixture.node_download(include_npm=False)
        result = self.install(fixture, "--repo", str(self.repo), "--node-only")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("npm", result.stderr)
        self.assertIn(".tar.gz: OK", result.stdout)
        self.assertEqual({path.name for path in fixture.tools.iterdir()}, {".owner.json"})

    def test_node_only_preserves_incomplete_private_npm_instead_of_using_global_npm(self):
        self.prepare()
        fixture = InstallFixture(self.directory, self.repo)
        fixture.restrict_path(missing=("uv",))
        private = fixture.tools / "node-v24.21.0"
        fixture.program(private / "bin/node", 'print("v24.21.0")\n')
        before = (private / "bin/node").read_bytes()
        for missing in (True, False):
            with self.subTest(missing=missing):
                if not missing:
                    fixture.program(private / "bin/npm", "sys.exit(91)\n")
                result = self.install(fixture, "--repo", str(self.repo), "--node-only")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("npm", result.stderr)
                self.assertEqual((private / "bin/node").read_bytes(), before)
                self.assertEqual({path.name for path in fixture.tools.iterdir()}, {".owner.json", "node-v24.21.0"})
        self.assertTrue(all(call[0] in {"node", "npm"} for call in fixture.calls()))

    def test_node_only_rejects_unowned_storage_before_probes_or_downloads(self):
        fixture = InstallFixture(self.directory, self.repo, node_version="20.20.2", cli_version=None)
        fixture.restrict_path(missing=("uv",))
        fixture.tools.mkdir(parents=True)
        keep = fixture.tools / "keep.txt"
        keep.write_text("foreign tools\n")
        result = self.install(fixture, "--node-only", "--repo", str(self.repo))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Core workshop:", result.stderr)
        self.assertEqual(keep.read_text(), "foreign tools\n")
        self.assertEqual(list(fixture.tools.iterdir()), [keep])
        self.assertEqual(fixture.calls(), [])

    def test_node_only_rejects_linked_node_before_probes_or_downloads(self):
        self.prepare()
        fixture = InstallFixture(self.directory, self.repo)
        fixture.restrict_path(missing=("uv",))
        private = fixture.tools / "node-v24.21.0"
        private.symlink_to(self.other, target_is_directory=True)
        result = self.install(fixture, "--repo", str(self.repo), "--node-only")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("symlink", result.stderr.lower())
        self.assertTrue(private.is_symlink())
        self.assertEqual((self.other / "keep.txt").read_text(), "existing project\n")
        self.assertEqual(fixture.calls(), [])

    def test_node_only_keeps_linux_and_architecture_checks_before_downloads(self):
        self.prepare()
        fixture = InstallFixture(self.directory, self.repo, node_version="20.20.2", cli_version=None)
        fixture.restrict_path(missing=("uv",))
        (fixture.bin / "uname").unlink()
        for system, arch in (("Darwin", "arm64"), ("Linux", "armv7l")):
            with self.subTest(system=system, arch=arch):
                fixture.program(fixture.bin / "uname",
                                f'print({system!r} if sys.argv[1:] == ["-s"] else {arch!r})\n')
                result = self.install(fixture, "--node-only", "--repo", str(self.repo))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Linux EC2", result.stderr)
                self.assertEqual({path.name for path in fixture.tools.iterdir()}, {".owner.json"})
        self.assertTrue(all(call[0] == "uname" for call in fixture.calls()))

    def test_full_installer_still_requires_uv_before_preparing_node(self):
        self.prepare()
        fixture = InstallFixture(self.directory, self.repo, node_version="20.20.2", cli_version=None)
        fixture.restrict_path(missing=("uv",))
        result = self.install(fixture)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Prerequisite missing: uv", result.stderr)
        self.assertEqual({path.name for path in fixture.tools.iterdir()}, {".owner.json"})
        self.assertEqual(fixture.calls(), [])

    def test_installer_reuses_user_global_node_and_cli_and_creates_python312_helpers(self):
        report = self.prepare()
        fixture = InstallFixture(self.directory, self.repo)
        global_entry = fixture.global_prefix / "lib/node_modules/@aws/agentcore/dist/cli/index.mjs"
        before = global_entry.read_bytes()
        result = self.install(fixture)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        tools = Path(report["toolchainPath"])
        self.assertFalse((tools / "node-v24.21.0").exists(), "Compatible Node must not be installed again")
        self.assertFalse((tools / "agentcore").exists(), "The pinned global npm CLI must be reused")
        self.assertEqual(global_entry.read_bytes(), before)
        helper = tools / "helpers/bin/python3"
        version = subprocess.run([str(helper), "--version"], capture_output=True, text=True, env=fixture.env)
        self.assertEqual(version.stdout.strip(), "Python 3.12.13")
        self.assertTrue((tools / "python/cpython-fixture/bin/python3.12").is_file())
        calls = fixture.calls()
        self.assertIn(["uv", "--no-config", "python", "install", "--no-bin", "3.12"], calls)
        self.assertFalse(any(call[0] == "curl" or (call[0] == "npm" and "--prefix" in call) for call in calls))
        self.assertFalse(any(call[0] == "index.mjs" for call in calls), "Metadata discovery must not launch the CLI")

    def test_installer_preserves_existing_helpers_from_python312_or_newer(self):
        self.prepare()
        fixture = InstallFixture(self.directory, self.repo)
        helper = fixture.helper((3, 12, 13))
        for version in ((3, 12, 13), (3, 14, 3)):
            with self.subTest(version=version):
                helper.write_text(fixture.python_template.read_text().replace(
                    "__VERSION__", repr((*version, "final", 0))))
                before = helper.read_bytes()
                result = self.install(fixture)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(helper.read_bytes(), before)
        self.assertFalse(any("venv" in call for call in fixture.calls()))

    def test_installer_preserves_and_rejects_helpers_older_than_python312(self):
        self.prepare()
        fixture = InstallFixture(self.directory, self.repo)
        helper = fixture.helper((3, 11, 9))
        before = helper.read_bytes()
        result = self.install(fixture)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("3.12", result.stdout + result.stderr)
        self.assertEqual(helper.read_bytes(), before)
        self.assertFalse((fixture.tools / "agentcore").exists())

    def test_installer_uses_pinned_local_cli_when_global_cli_version_is_wrong(self):
        self.prepare()
        fixture = InstallFixture(self.directory, self.repo, cli_version="0.29.0")
        manifest = fixture.global_prefix / "lib/node_modules/@aws/agentcore/package.json"
        before = manifest.read_bytes()
        result = self.install(fixture)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(manifest.read_bytes(), before)
        self.assertEqual(self.core.npm_agentcore(fixture.tools / "agentcore/node_modules/.bin/agentcore"), "0.28.1")
        self.assertFalse((fixture.tools / "node-v24.21.0").exists())
        self.assertFalse(list(fixture.tools.glob(".agentcore-install-*")))

    def test_installer_reuses_a_complete_private_cli_and_keeps_its_lock(self):
        self.prepare()
        fixture = InstallFixture(self.directory, self.repo, cli_version="0.29.0")
        result = self.install(fixture)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        private = fixture.tools / "agentcore"
        lock = private / "package-lock.json"
        before = lock.read_bytes()
        again = self.install(fixture)
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        self.assertEqual(lock.read_bytes(), before)
        self.assertEqual(sum(call[0] == "npm" and "--prefix" in call for call in fixture.calls()), 1)
        lock.unlink()
        before = (private / "package.json").read_bytes()
        incomplete = self.install(fixture)
        self.assertNotEqual(incomplete.returncode, 0)
        self.assertIn("lock", incomplete.stderr.lower())
        self.assertEqual((private / "package.json").read_bytes(), before)
        self.assertFalse(lock.exists(), "An incomplete existing installation must be preserved")

    def test_installer_uses_checksum_verified_private_node_for_unsupported_versions(self):
        self.prepare()
        fixture = InstallFixture(self.directory, self.repo)
        arch = "arm64" if os.uname().machine in {"aarch64", "arm64"} else "x64"
        name = "node-v24.21.0-linux-" + arch
        unpacked = self.directory / name
        fixture.program(unpacked / "bin/node", 'print("v24.21.0")\n')
        (unpacked / "bin/npm").write_bytes((fixture.bin / "npm").read_bytes())
        (unpacked / "bin/npm").chmod(0o755)
        archive = self.directory / (name + ".tar.gz")
        with tarfile.open(archive, "w:gz") as stream:
            stream.add(unpacked, arcname=name)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        fixture.program(fixture.bin / "curl", f"""
args = sys.argv[1:]
output = Path(args[args.index("--output") + 1])
if args[-1].endswith("/SHASUMS256.txt"):
    output.write_text("{digest}  {name}.tar.gz\\n")
else:
    output.write_bytes(Path({str(archive)!r}).read_bytes())
""")
        for version in ("24.18.0", "25.0.0"):
            with self.subTest(version=version):
                fixture.program(fixture.bin / "node", f'print("v{version}")\n')
                result = self.install(fixture)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn(".tar.gz: OK", result.stdout)
                private_node = fixture.tools / "node-v24.21.0"
                self.assertTrue((private_node / "bin/node").is_file())
                self.assertFalse(list(fixture.tools.glob(".node-install-*")))
                self.assertFalse((fixture.tools / "agentcore").exists())
                shutil.rmtree(private_node)

    def test_installer_refuses_linked_tool_directories_even_when_global_tools_match(self):
        self.prepare()
        fixture = InstallFixture(self.directory, self.repo)
        for name in ("node-v24.21.0", "helpers", "agentcore", "python", "cache"):
            with self.subTest(directory=name):
                directory = fixture.tools / name
                directory.symlink_to(self.other, target_is_directory=True)
                result = self.install(fixture)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("symlink", result.stderr.lower())
                self.assertEqual((self.other / "keep.txt").read_text(), "existing project\n")
                self.assertTrue(directory.is_symlink())
                self.assertEqual(fixture.calls(), [])
                directory.unlink()

    def test_installer_rejects_bad_node_checksum_without_replacing_tools(self):
        installer = ROOT / "workshop/scripts/install_core.sh"
        self.assertTrue(installer.is_file(), "The private core toolchain installer is missing")
        report = self.prepare()
        tools = Path(report["toolchainPath"])
        fakebin = self.directory / "bin"
        fakebin.mkdir()
        node = fakebin / "node"
        node.write_text("#!/bin/sh\nprintf 'v20.20.1\\n'\n")
        node.chmod(0o755)
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
        uv.write_text("#!/bin/sh\ncase \"$*\" in *'python find'*) printf '/test/python3.12\\n';; esac\n")
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
        self.assertEqual(result.returncode, 53, result.stdout + result.stderr)
        self.assertFalse((tools / "agentcore").exists(), "An incomplete npm install must remain unpublished")
        self.assertFalse(list(tools.glob(".agentcore-install-*")))
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
                "runtimeVersion": "PYTHON_3_12", "networkMode": "PUBLIC",
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
        spec_path = project / "agentcore/agentcore.json"
        spec = json.loads(spec_path.read_text())
        for runtime in ("PYTHON_3_11", "PYTHON_3_14"):
            spec["runtimes"][0]["runtimeVersion"] = runtime
            spec_path.write_text(json.dumps(spec))
            with self.subTest(runtime=runtime), self.assertRaisesRegex(ValueError, "3.12"):
                self.core.check_project(self.repo, "team01", "AtlasCliTeam01")
        spec["runtimes"][0]["runtimeVersion"] = "PYTHON_3_12"
        spec_path.write_text(json.dumps(spec))
        data.write_text("[]")
        with self.assertRaises(ValueError):
            self.core.check_project(self.repo, "team01", "AtlasCliTeam01")


if __name__ == "__main__":
    unittest.main()
