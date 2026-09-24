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
                     ("--participant",), ("--project-name", ""), ("--unknown",)):
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
