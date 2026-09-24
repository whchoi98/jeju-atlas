"""The one-command EC2 start preserves participant work and stops before secrets."""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

try:
    from .test_core import InstallFixture, copy_core_source
except ImportError:
    from test_core import InstallFixture, copy_core_source

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "workshop/scripts/start.sh"


class StartTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCRIPT.is_file(), "The one-command workshop start is missing")
        self.temporary = tempfile.TemporaryDirectory(prefix="atlas-start-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.repo = self.directory / "jeju-atlas"
        copy_core_source(self.repo)
        self.script = self.repo / "workshop/scripts/start.sh"
        shutil.copyfile(SCRIPT, self.script)
        self.fixture = InstallFixture(self.directory, self.repo)

    def start(self, *args):
        return subprocess.run(
            ["bash", str(self.script), *args], cwd=self.directory,
            env=self.fixture.env, capture_output=True, text=True, timeout=30,
        )

    def test_node_only_start_prepares_node_and_activation_without_full_readiness(self):
        self.fixture.restrict_path(missing=("uv", "aws", "codex", "claude", "kiro-cli", "docker"))
        shutil.rmtree(self.fixture.global_prefix)
        self.fixture.trace_bootstrap()
        self.fixture.program(self.fixture.bin / "node", 'print("v20.20.2")\n')
        self.fixture.node_download()
        result = self.start("--assistant", "claude", "--node-only")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        parent = self.repo / "workshop/.local/labs/team01"
        activation = parent / "activate.sh"
        self.assertIn("activationPath: " + str(activation), result.stdout)
        source_line = next(line for line in result.stdout.splitlines() if line.startswith("source "))
        self.assertNotIn("Core tools prepared", result.stdout)
        self.assertNotIn('"passed":', result.stdout)
        self.assertNotIn("doctor", result.stdout)
        self.assertNotIn("Docker", result.stdout)
        self.assertNotIn("workshop_env.py", result.stdout)
        self.assertFalse((parent / ".env").exists())
        self.assertFalse((parent / "AtlasCliTeam01").exists())
        owner = json.loads((parent / ".owner.json").read_text())
        self.assertEqual(owner["assistant"], "claude")
        self.assertEqual(owner["participant"], "team01")
        self.assertEqual(owner["project"], "AtlasCliTeam01")
        self.assertEqual({path.name for path in self.fixture.tools.iterdir()}, {".owner.json", "node-v24.21.0"})
        calls = self.fixture.calls()
        actions = [call[3] for call in calls if call[0] == "python3"
                   and len(call) > 3 and Path(call[2]).name == "core.py"]
        self.assertEqual(actions, ["prepare", "tools"], "Node-only must stop before activation/doctor")
        self.assertTrue(all(call[0] in {"python3", "node", "npm", "curl"} for call in calls), calls)
        self.assertTrue(all(call[1:] == ["--version"] for call in calls if call[0] == "npm"))
        restored = subprocess.run(
            ["bash", "--noprofile", "--norc", "-c", source_line
             + ' && command -v node && command -v npm && node --version && npm --version'
             + ' && printf "%s\\n" "$ATLAS_ASSISTANT" "$ATLAS_TEAM"'],
            cwd=self.directory, env=self.fixture.env, capture_output=True, text=True, timeout=15,
        )
        self.assertEqual(restored.returncode, 0, restored.stderr)
        private = self.fixture.tools / "node-v24.21.0/bin"
        self.assertEqual(restored.stdout.splitlines(), [
            str(private / "node"), str(private / "npm"), "v24.21.0", "11.11.0", "claude", "team01",
        ])
        # Resuming must keep the existing session and participant files.
        env_file = parent / ".env"
        env_file.write_text("TOKEN=TEST_SECRET_MUST_NOT_BE_PRINTED\n")
        project = parent / "AtlasCliTeam01"
        project.mkdir()
        student = project / "student.py"
        student.write_text("# participant work\n")
        before = {path: path.read_bytes() for path in (activation, env_file, student)}
        again = self.start("--node-only", "--assistant", "claude")
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        self.assertNotIn("TEST_SECRET_MUST_NOT_BE_PRINTED", again.stdout + again.stderr)
        for path, content in before.items():
            self.assertEqual(path.read_bytes(), content)
        self.assertEqual(sum(call[0] == "curl" for call in self.fixture.calls()), 2)

    def test_node_only_start_accepts_repo_in_either_flag_order(self):
        self.fixture.restrict_path(missing=("uv", "codex", "claude", "kiro-cli", "aws", "docker"))
        for assistant in ("codex", "kiro"):
            destination = self.directory / (assistant + "-source")
            copy_core_source(destination)
            for args in (
                ("--node-only", "--repo", str(destination), "--assistant", assistant),
                ("--repo", str(destination), "--assistant", assistant, "--node-only"),
            ):
                with self.subTest(args=args):
                    result = self.start(*args)
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    parent = destination / "workshop/.local/labs/team01"
                    self.assertIn(str(parent / "activate.sh"), result.stdout)
                    owner = json.loads((parent / ".owner.json").read_text())
                    self.assertEqual(owner["repo"], str(destination))
                    self.assertEqual(owner["assistant"], assistant)
                    self.assertFalse((self.repo / "workshop/.local").exists())
                    tools = destination / "workshop/.local/toolchain"
                    self.assertEqual({path.name for path in tools.iterdir()}, {".owner.json"})
        self.assertTrue(all(call[0] in {"node", "npm"} for call in self.fixture.calls()))

    def test_node_only_start_blocks_unowned_session_before_installation(self):
        self.fixture.restrict_path(missing=("uv",))
        parent = self.repo / "workshop/.local/labs/team01"
        parent.mkdir(parents=True)
        keep = parent / "keep.txt"
        keep.write_text("foreign session\n")
        result = self.start("--node-only")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Core workshop:", result.stderr)
        self.assertEqual(keep.read_text(), "foreign session\n")
        self.assertEqual(list(parent.iterdir()), [keep])
        self.assertFalse(self.fixture.tools.exists())
        self.assertEqual(self.fixture.calls(), [])

    def test_node_only_start_propagates_checksum_failure_without_source_instructions(self):
        self.fixture.restrict_path(missing=("uv",))
        self.fixture.program(self.fixture.bin / "node", 'print("v20.20.2")\n')
        self.fixture.node_download(checksum_ok=False)
        result = self.start("--node-only")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("checksum", (result.stdout + result.stderr).lower())
        self.assertNotIn("activationPath:", result.stdout)
        self.assertNotIn("Next,", result.stdout)
        self.assertNotIn('"passed":', result.stdout)
        self.assertEqual({path.name for path in self.fixture.tools.iterdir()}, {".owner.json"})
        self.assertTrue(all(call[0] in {"node", "curl"} for call in self.fixture.calls()))

    def test_default_start_prepares_codex_team01_and_reports_next_commands(self):
        result = self.start()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        parent = self.repo / "workshop/.local/labs/team01"
        self.assertIn(str(parent / "activate.sh"), result.stdout)
        self.assertIn(str(parent / ".env"), result.stdout)
        self.assertIn('workshop_env.py" configure', result.stdout)
        self.assertIn('"passed": true', result.stdout)
        self.assertFalse((parent / ".env").exists(), "Start must not prompt for or create secrets")
        self.assertFalse((parent / "AtlasCliTeam01").exists(), "The assistant creates the project later")
        owner = json.loads((parent / ".owner.json").read_text())
        self.assertEqual(owner["assistant"], "codex")
        self.assertEqual(owner["project"], "AtlasCliTeam01")
        calls = self.fixture.calls()
        self.assertIn(["codex", "--version"], calls)
        self.assertIn(["aws", "--version"], calls)
        self.assertFalse(any(call[0] in {"claude", "kiro-cli", "index.mjs"} for call in calls))
        self.assertFalse(any(call[0] in {"aws", "codex"} and call[1:] != ["--version"] for call in calls))
        activation = subprocess.run(
            ["bash", "--noprofile", "--norc", "-c",
             'source "$1" && printf "%s\\n" "$ATLAS_TEAM" "$ATLAS_ASSISTANT" "$ATLAS_CLI_PARENT"',
             "bash", str(parent / "activate.sh")],
            env=self.fixture.env, capture_output=True, text=True,
        )
        self.assertEqual(activation.returncode, 0, activation.stderr)
        self.assertEqual(activation.stdout.splitlines(), ["team01", "codex", str(parent)])

    def test_explicit_assistants_and_project_name_only_check_the_selected_cli(self):
        for participant, assistant, project in (
            ("team02", "claude", "AtlasCliLearning"), ("team03", "kiro", "AtlasCliTeam03"),
        ):
            with self.subTest(assistant=assistant):
                previous = len(self.fixture.calls())
                args = ["--participant", participant, "--assistant", assistant]
                if assistant == "claude":
                    args.extend(["--project-name", project])
                result = self.start(*args)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                parent = self.repo / "workshop/.local/labs" / participant
                owner = json.loads((parent / ".owner.json").read_text())
                self.assertEqual(owner["project"], project)
                self.assertEqual(owner["assistant"], assistant)
                calls = self.fixture.calls()[previous:]
                selected = "kiro-cli" if assistant == "kiro" else assistant
                self.assertEqual(
                    [call for call in calls if call[0] in {"claude", "codex", "kiro-cli"}],
                    [[selected, "--version"]],
                )

    def test_repeat_start_preserves_custom_project_env_and_activation(self):
        first = self.start()
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        parent = self.repo / "workshop/.local/labs/team01"
        project = parent / "AtlasCliTeam01"
        project.mkdir()
        student = project / "student.py"
        student.write_text("print('participant work')\n")
        env_file = parent / ".env"
        env_file.write_text("TOKEN=TEST_SECRET_MUST_NOT_BE_PRINTED\n")
        activation = parent / "activate.sh"
        before = {path: path.read_bytes() for path in (student, env_file, activation)}
        again = self.start()
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        self.assertNotIn("TEST_SECRET_MUST_NOT_BE_PRINTED", again.stdout + again.stderr)
        for path, content in before.items():
            self.assertEqual(path.read_bytes(), content)
        self.assertEqual(sum("venv" in call for call in self.fixture.calls()), 1)

    def test_modified_activation_is_preserved_and_stops_before_installation(self):
        result = self.start()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        activation = self.repo / "workshop/.local/labs/team01/activate.sh"
        activation.write_text(activation.read_text() + "# participant customization\n")
        before = activation.read_bytes()
        calls = self.fixture.calls()
        again = self.start()
        self.assertNotEqual(again.returncode, 0)
        self.assertIn("preserve", again.stderr.lower())
        self.assertEqual(activation.read_bytes(), before)
        self.assertEqual(self.fixture.calls(), calls)

    def test_invalid_arguments_and_missing_source_do_not_install_anything(self):
        for args in (("--assistant", "other"), ("--participant", "../escape"),
                     ("--participant",), ("--project-name", ""), ("--unknown",),
                     ("--node-only", "--repo"), ("--repo", "", "--node-only"),
                     ("--repo", "--node-only"), ("--node-only", "--assistant", "other")):
            with self.subTest(args=args):
                result = self.start(*args)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.repo / "workshop/.local").exists())
                self.assertEqual(self.fixture.calls(), [])
        (self.repo / "agent/tools/data/jeju_pois.json").unlink()
        result = self.start()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Full Jeju Atlas source", result.stderr)
        self.assertEqual(self.fixture.calls(), [])

    def test_failed_install_stops_before_doctor_or_env_configuration(self):
        manifest = self.fixture.global_prefix / "lib/node_modules/@aws/agentcore/package.json"
        value = json.loads(manifest.read_text())
        value["version"] = "0.29.0"
        manifest.write_text(json.dumps(value))
        self.fixture.env["ATLAS_TEST_NPM_FAIL"] = "1"
        result = self.start()
        self.assertEqual(result.returncode, 53, result.stdout + result.stderr)
        self.assertNotIn('"passed": true', result.stdout)
        self.assertFalse(any(call[0] in {"aws", "codex"} for call in self.fixture.calls()))
        self.assertFalse((self.fixture.tools / "agentcore").exists())
        self.assertFalse(list(self.fixture.tools.glob(".agentcore-install-*")))

    def test_failed_doctor_returns_failure_instead_of_a_ready_message(self):
        self.fixture.program(self.fixture.bin / "codex", "sys.exit(98)\n")
        result = self.start()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('"passed": false', result.stdout)
        self.assertNotIn('workshop_env.py" configure', result.stdout)

    def test_docker_preflight_reports_unavailable_daemon_without_blocking_codezip(self):
        self.fixture.program(self.fixture.bin / "docker", """
if sys.argv[1:] == ["--version"]:
    print("Docker version fixture")
    sys.exit()
sys.exit(1)
""")
        result = self.start()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Docker", result.stdout + result.stderr)
        calls = [call for call in self.fixture.calls() if call[0] == "docker"]
        self.assertTrue(any("info" in call for call in calls), calls)
        self.assertFalse(any("run" in call for call in calls))


if __name__ == "__main__":
    unittest.main()
