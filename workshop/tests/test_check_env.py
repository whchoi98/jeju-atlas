"""Exercise the EC2 preflight with isolated tools; never contact AWS."""
import json
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "workshop/scripts/check_env.sh"
BASH = shutil.which("bash")
NODE = shutil.which("node")
TIMEOUT = shutil.which("timeout")


@unittest.skipUnless(BASH and NODE, "Bash and Node are needed to test npm metadata discovery")
class CheckEnvTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.bin = self.directory / "bin"
        self.bin.mkdir()
        self.log = self.directory / "calls.tsv"
        # No inherited PATH or credentials: a missing stub must really be missing.
        self.env = {
            "PATH": str(self.bin), "BASH_ENV": "/dev/null", "LC_ALL": "C",
            "PREFLIGHT_CALL_LOG": str(self.log),
        }
        self.tool("node", """
if [[ "$*" == --version ]]; then
  printf '%s\\n' "${PREFLIGHT_NODE_VERSION:-v24.18.1}"
  exit "${PREFLIGHT_NODE_STATUS:-0}"
fi
exec """ + shlex.quote(NODE) + ' "$@"\n')
        self.tool("npm", """
[[ "$*" == --version ]] || exit 91
printf '11.11.0\\n'
""")
        self.python(self.bin / "python3.12", "3.12.12")
        self.runtime = self.directory / "managed python" / "python3.12"
        self.python(self.runtime, "3.12.12")
        self.env["PREFLIGHT_RUNTIME"] = str(self.runtime)
        self.tool("uv", """
case "$*" in
  --version) printf 'uv 0.12.15\\n' ;;
  'python find --no-python-downloads 3.12')
    [[ -n "${PREFLIGHT_RUNTIME:-}" ]] || exit 1
    printf '%s\\n' "$PREFLIGHT_RUNTIME" ;;
  *) exit 91 ;;
esac
""")
        self.tool("docker", """
case "$*" in
  --version) printf 'Docker version 27.5.1, build fixture\\n' ;;
  info)
    printf '%s\\n' "${PREFLIGHT_PRIVATE_OUTPUT:-fixture docker info}" >&2
    exit "${PREFLIGHT_DOCKER_STATUS:-0}" ;;
  *) exit 91 ;;
esac
""")
        self.tool("systemctl", "exit 3\n")  # Rootless/remote Docker may still work.
        self.tool("aws", """
if [[ "$*" == --version ]]; then
  printf '%s\\n' "${PREFLIGHT_AWS_VERSION:-aws-cli/2.33.15 Python/3.13.11 Linux/6.1}" >&2
  exit "${PREFLIGHT_AWS_VERSION_STATUS:-0}"
fi
[[ "$1 $2" == 'sts get-caller-identity' ]] || exit 91
printf '%s\\n' "${PREFLIGHT_PRIVATE_OUTPUT:-fixture identity}" >&2
exit "${PREFLIGHT_STS_STATUS:-0}"
""")
        self.tool("claude", """
[[ "$*" == --version ]] || exit 91
printf '2.1.272 (Claude Code)\\n'
""")
        self.tool("uname", """
case "$*" in
  -m) printf 'x86_64\\n' ;;
  -s) printf 'Linux\\n' ;;
  *) exit 91 ;;
esac
""")
        if TIMEOUT:
            (self.bin / "timeout").symlink_to(TIMEOUT)
        self.package = self.directory / "npm/lib/node_modules/@aws/agentcore"
        entry = self.package / "dist/cli/index.mjs"
        self.executable(entry, "agentcore", "exit 91\n")
        self.manifest = self.package / "package.json"
        self.manifest.write_text(json.dumps({
            "name": "@aws/agentcore", "version": "0.28.1",
            "bin": {"agentcore": "dist/cli/index.mjs"},
        }), encoding="utf-8")
        (self.bin / "agentcore").symlink_to(entry)

    def executable(self, path, name, body):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            "#!" + BASH + "\n"
            "printf '%s' " + shlex.quote(name) + ' >> "$PREFLIGHT_CALL_LOG"\n'
            'printf "\\t%s" "$@" >> "$PREFLIGHT_CALL_LOG"\n'
            'printf "\\n" >> "$PREFLIGHT_CALL_LOG"\n' + body,
            encoding="utf-8",
        )
        path.chmod(0o755)

    def tool(self, name, body):
        self.executable(self.bin / name, name, body)

    def python(self, path, version):
        self.executable(path, str(path), '[[ "$*" == --version ]] || exit 91\n'
                        + "printf 'Python " + version + "\\n'\n")

    def run_check(self, *args):
        self.assertTrue(SCRIPT.is_file(), "The standalone EC2 preflight script is missing")
        return subprocess.run(
            [BASH, "--noprofile", "--norc", str(SCRIPT), *args],
            cwd=self.directory, env=self.env, capture_output=True, text=True, timeout=8,
        )

    def calls(self, name):
        lines = self.log.read_text().splitlines() if self.log.exists() else []
        return [fields[1:] for line in lines
                if (fields := line.split("\t"))[0] == name]

    def assert_status(self, result, status, label):
        self.assertRegex(result.stdout, r"(?m)^\s*\[" + status + r"\] " + re.escape(label))

    def test_ready_ec2_passes_before_prepare_without_starting_agentcore(self):
        result = self.run_check("--assistant", "claude")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assert_status(result, "OK", "AgentCore")
        self.assertIn("@aws/agentcore 0.28.1", result.stdout)
        self.assertEqual(self.calls("agentcore"), [])
        self.assertEqual(self.calls("npm"), [["--version"]])
        self.assertEqual(self.calls("claude"), [["--version"]])
        self.assertFalse((self.directory / "workshop").exists())

    def test_node_must_meet_the_floor_within_major_24(self):
        for version, expected in (
            ("v20.20.1", 1), ("v24.18.0", 1), ("v24.17.99", 1),
            ("v25.0.0", 1), ("v24.18.1-rc.1", 1),
            ("v24.18.1", 0), ("v24.21.0", 0),
        ):
            with self.subTest(version=version):
                self.env["PREFLIGHT_NODE_VERSION"] = version
                result = self.run_check("--offline")
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                self.assert_status(result, "FAIL" if expected else "OK", "Node.js")

    def test_missing_aws_cannot_be_reported_as_a_version(self):
        (self.bin / "aws").unlink()
        result = self.run_check()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assert_status(result, "FAIL", "AWS CLI")
        self.assert_status(result, "SKIP", "AWS credentials")
        self.assertEqual(self.calls("aws"), [])
        self.assertNotIn("command not found", result.stdout + result.stderr)

    def test_aws_version_requires_success_and_recognizable_output(self):
        for version, status in (
            ("aws-cli/2.33.15", "127"), ("aws: command not found", "0"),
        ):
            with self.subTest(version=version, status=status):
                self.env.update(PREFLIGHT_AWS_VERSION=version, PREFLIGHT_AWS_VERSION_STATUS=status)
                result = self.run_check()
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assert_status(result, "FAIL", "AWS CLI")
                self.assert_status(result, "SKIP", "AWS credentials")
        self.assertTrue(all(args == ["--version"] for args in self.calls("aws")))

    def test_uv_managed_python_312_is_found_without_a_path_shim(self):
        (self.bin / "python3.12").unlink()
        self.python(self.bin / "python3", "3.9.25")
        result = self.run_check("--offline")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assert_status(result, "OK", "Python helper")
        self.assert_status(result, "OK", "Python runtime")
        self.assertIn(str(self.runtime), result.stdout)
        self.assertIn(["python", "find", "--no-python-downloads", "3.12"], self.calls("uv"))
        self.assertEqual(self.calls(str(self.bin / "python3")), [])

    def test_native_python_312_is_preferred_for_helpers(self):
        result = self.run_check("--offline")
        self.assertEqual(result.returncode, 0, result.stdout)
        helper = next(line for line in result.stdout.splitlines() if "Python helper" in line)
        self.assertIn(str(self.bin / "python3.12"), helper)

    def test_newer_helper_does_not_replace_missing_runtime_312(self):
        (self.bin / "python3.12").unlink()
        self.python(self.bin / "python3.11", "3.11.14")
        self.python(self.bin / "python3", "3.13.11")
        self.env.pop("PREFLIGHT_RUNTIME")
        result = self.run_check("--offline")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assert_status(result, "OK", "Python helper")
        self.assert_status(result, "FAIL", "Python runtime")
        self.assertIn("3.13.11", result.stdout)

    def test_uv_runtime_path_is_verified_not_just_trusted(self):
        self.python(self.runtime, "3.13.11")
        result = self.run_check("--offline")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assert_status(result, "FAIL", "Python runtime")

    def test_missing_python_is_reported_without_executing_an_empty_command(self):
        (self.bin / "python3.12").unlink()
        self.env.pop("PREFLIGHT_RUNTIME")
        result = self.run_check("--offline")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assert_status(result, "FAIL", "Python helper")
        self.assert_status(result, "FAIL", "Python runtime")
        self.assert_status(result, "OK", "AgentCore")
        self.assertNotIn("command not found", result.stdout + result.stderr)

    def test_uv_is_required_even_when_python_is_on_path(self):
        (self.bin / "uv").unlink()
        result = self.run_check("--offline")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assert_status(result, "FAIL", "uv")
        self.assert_status(result, "OK", "Python helper")

    def test_docker_socket_denial_warns_or_fails_for_containers(self):
        self.env["PREFLIGHT_DOCKER_STATUS"] = "1"
        for args, status, expected in (
            ((), "WARN", 0), (("--containers",), "FAIL", 1),
        ):
            with self.subTest(args=args):
                result = self.run_check("--offline", *args)
                self.assertEqual(result.returncode, expected, result.stdout)
                self.assert_status(result, status, "Docker access")
                self.assertIn("docker info", result.stdout)
        self.assertIn(["info"], self.calls("docker"))

    def test_missing_docker_is_optional_unless_containers_are_requested(self):
        (self.bin / "docker").unlink()
        result = self.run_check("--offline")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assert_status(result, "WARN", "Docker")
        result = self.run_check("--offline", "--containers")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assert_status(result, "FAIL", "Docker")

    def test_inactive_systemd_service_does_not_override_working_docker(self):
        result = self.run_check("--offline", "--containers")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assert_status(result, "OK", "Docker access")
        self.assertNotRegex(result.stdout, r"\[(FAIL|WARN)\] Docker")

    def test_offline_skips_sts_without_marking_credentials_healthy(self):
        result = self.run_check("--offline")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(self.calls("aws"), [["--version"]])
        self.assert_status(result, "SKIP", "AWS credentials")
        self.assertNotRegex(result.stdout, r"\[OK\] AWS credentials")
        self.assertIn("--offline", result.stdout)

    def test_default_sts_is_read_only_and_has_network_timeouts(self):
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assert_status(result, "OK", "AWS credentials")
        calls = self.calls("aws")
        self.assertEqual(len(calls), 2, calls)
        args = calls[1]
        self.assertEqual(args[:2], ["sts", "get-caller-identity"])
        for flag in ("--cli-connect-timeout", "--cli-read-timeout"):
            seconds = int(args[args.index(flag) + 1])
            self.assertGreater(seconds, 0)
            self.assertLessEqual(seconds, 10)

    def test_sts_failure_is_required_and_diagnostics_do_not_expose_secrets(self):
        secret = "DO-NOT-DISPLAY-this-fixture-token"
        self.env.update(PREFLIGHT_STS_STATUS="1", PREFLIGHT_PRIVATE_OUTPUT=secret,
                        AWS_SESSION_TOKEN=secret, AWS_BEARER_TOKEN_BEDROCK=secret)
        dotenv = self.directory / ".env"
        dotenv.write_text("printf '" + secret + "'\nexit 99\n", encoding="utf-8")
        result = self.run_check()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assert_status(result, "FAIL", "AWS credentials")
        self.assert_status(result, "OK", "AgentCore")
        self.assertNotIn(secret, result.stdout + result.stderr)

    def test_timeout_failure_cannot_be_mistaken_for_valid_credentials(self):
        if (self.bin / "timeout").exists():
            (self.bin / "timeout").unlink()
        self.tool("timeout", """
while [[ "$1" == -* ]]; do shift; done
shift
if [[ "$1 $2 $3" == 'aws sts get-caller-identity' ]]; then exit 124; fi
exec "$@"
""")
        result = self.run_check()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assert_status(result, "FAIL", "AWS credentials")
        self.assertTrue(self.calls("timeout"))

    def test_aws_network_timeouts_remain_without_timeout_utility(self):
        if (self.bin / "timeout").exists():
            (self.bin / "timeout").unlink()
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("--cli-read-timeout", self.calls("aws")[1])

    def test_python_starter_cli_is_rejected_without_running_it(self):
        (self.bin / "agentcore").unlink()
        self.tool("agentcore", "printf 'bedrock-agentcore-starter-toolkit 1.0\\n'\n")
        result = self.run_check("--offline")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assert_status(result, "FAIL", "AgentCore")
        self.assertEqual(self.calls("agentcore"), [])

    def test_agentcore_version_must_match_the_workshop_pin(self):
        manifest = json.loads(self.manifest.read_text())
        manifest["version"] = "0.29.0"
        self.manifest.write_text(json.dumps(manifest))
        result = self.run_check("--offline")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assert_status(result, "FAIL", "AgentCore")
        self.assertIn("0.29.0", result.stdout)
        self.assertIn("0.28.1", result.stdout)

    def test_agentcore_manifest_must_point_at_the_executable(self):
        manifest = json.loads(self.manifest.read_text())
        manifest["bin"]["agentcore"] = "dist/cli/other.mjs"
        (self.package / "dist/cli/other.mjs").write_text("// another entry")
        self.manifest.write_text(json.dumps(manifest))
        result = self.run_check("--offline")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assert_status(result, "FAIL", "AgentCore")

    def test_only_the_selected_assistant_is_probed(self):
        for name, binary, version in (
            ("claude", "claude", "2.1.272 (Claude Code)"),
            ("codex", "codex", "codex-cli 0.124.0"),
            ("kiro", "kiro-cli", "kiro-cli 1.30.0"),
        ):
            with self.subTest(assistant=name):
                if self.log.exists():
                    self.log.unlink()
                self.tool(binary, '[[ "$*" == --version ]] || exit 91\n'
                          + "printf '%s\\n' " + shlex.quote(version) + "\n")
                result = self.run_check("--offline", "--assistant", name)
                self.assertEqual(result.returncode, 0, result.stdout)
                for candidate in ("claude", "codex", "kiro-cli"):
                    self.assertEqual(self.calls(candidate), [["--version"]] if candidate == binary else [])

    def test_selected_missing_assistant_fails_but_omitting_selection_skips(self):
        result = self.run_check("--offline", "--assistant", "codex")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assert_status(result, "FAIL", "Assistant")
        result = self.run_check("--offline")
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assert_status(result, "SKIP", "Assistant")

    def test_all_required_failures_are_counted(self):
        for name in ("node", "npm", "uv", "python3.12", "aws", "agentcore"):
            (self.bin / name).unlink()
        result = self.run_check("--offline")
        self.assertEqual(result.returncode, 1, result.stdout)
        for label in ("Node.js", "npm", "uv", "Python helper", "Python runtime", "AWS CLI", "AgentCore"):
            self.assert_status(result, "FAIL", label)
        self.assertIn("7 required failure(s)", result.stdout)
        self.assertEqual(result.stderr, "")

    def test_invalid_options_fail_before_any_probes(self):
        for args in (("--assistant",), ("--assistant", "unknown"), ("--unexpected",)):
            with self.subTest(args=args):
                result = self.run_check(*args)
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertFalse(self.log.exists())

    def test_help_does_not_probe_the_environment(self):
        result = self.run_check("--help")
        self.assertEqual(result.returncode, 0, result.stdout)
        for option in ("--offline", "--containers", "--assistant"):
            self.assertIn(option, result.stdout)
        self.assertFalse(self.log.exists())


if __name__ == "__main__":
    unittest.main()
