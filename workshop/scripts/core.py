#!/usr/bin/env python3
"""Prepare and diagnose the 00–04 course. No installs, AWS calls or model calls."""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
CLI_VERSION = "0.28.1"
PYTHON_VERSION = "3.12"
REGION = "ap-northeast-2"
CLI_CONFIG = {
    "disableDependencyManagement": True,
    "disableTransactionSearch": True,
    "telemetry": {"enabled": False},
}
SOURCE_FILES = (
    "AGENTS.md", "package.json", ".nvmrc", "workshop/course.json",
    "workshop/scripts/core.py", "workshop/scripts/install_core.sh",
    "workshop/scripts/start.sh", "workshop/scripts/check_env.sh",
    "workshop/scripts/workshop_env.py", "workshop/scripts/key_binding.py",
    "workshop/.env.example",
    "workshop/requirements-core.txt", "workshop/scripts/lab.py",
    "workshop/scripts/lab_config.py", "workshop/scripts/lab_workspace.py",
    "workshop/scripts/lab_cloudfront.py", "workshop/scripts/ec2_context.py",
    "workshop/scripts/model_config.py", "workshop/scripts/model_check.py",
    "agent/tools/data/jeju_pois.json",
)


def safe_path(value):
    if not str(value).strip() or not re.fullmatch(r"[A-Za-z0-9_./-]+", str(value)):
        raise ValueError("Use an explicit path with ASCII letters/digits, /, ., _ and - only")
    path = Path(os.path.abspath(value))
    for ancestor in (path, *path.parents):
        if ancestor.is_symlink():
            raise ValueError("Symlinked workshop paths are not supported: " + str(ancestor))
    return path


def read_json(path):
    path = safe_path(path)
    if not path.is_file() or path.stat().st_size > 1024 * 1024:
        raise ValueError("Required regular JSON file is missing or too large: " + str(path))
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        raise ValueError("Invalid JSON: " + str(path)) from None


def check_source(repo):
    repo = safe_path(repo)
    for name in SOURCE_FILES:
        if not safe_path(repo / name).is_file():
            raise ValueError("Full Jeju Atlas source required; missing " + str(repo / name))
    if read_json(repo / "package.json").get("name") != "jeju-atlas":
        raise ValueError("This directory is not the Jeju Atlas source")
    if read_json(repo / "workshop/course.json").get("coreChapterCount") != 5:
        raise ValueError("Use the source for the five-chapter core course")
    version = (repo / ".nvmrc").read_text().strip()
    if not re.fullmatch(r"24\.\d+\.\d+", version) or tuple(map(int, version.split("."))) < (24, 18, 1):
        raise ValueError(".nvmrc must pin Node 24.18.1 or later within major 24")
    data = read_json(repo / "agent/tools/data/jeju_pois.json")
    if (not isinstance(data, list) or len(data) != 137
            or any(not isinstance(item, dict) or item.get("source") != "sample" or not item.get("id")
                   for item in data)):
        raise ValueError("Expected the 137-place sample seed with IDs and source=sample")
    return repo


def names(participant, project):
    if (not re.fullmatch(r"[a-z][a-z0-9]{2,9}", participant)
            or re.search(r"prod|shared|live|reference|default", participant)
            or participant in {"main", "jeju3d", "jejuatlas", "ohmyjeju"}):
        raise ValueError("Use a unique participant: 3–10 lowercase letters/digits, e.g. team01")
    if (not re.fullmatch(r"AtlasCli[A-Za-z0-9]{1,15}", project)
            or re.search(r"prod|shared|live|reference|default", project[8:], re.I)):
        raise ValueError("Use AtlasCli + 1–15 letters/digits, e.g. AtlasCliTeam01")


def paths(repo, participant, project):
    names(participant, project)
    local = safe_path(repo / "workshop/.local")
    parent = safe_path(local / "labs" / participant)
    return local, parent, safe_path(parent / project), safe_path(local / "toolchain")


def owner(repo, participant, project, assistant="claude"):
    if not isinstance(assistant, str) or assistant not in {"claude", "codex", "kiro"}:
        raise ValueError("Choose codex, kiro, or claude")
    return {"format": "jeju-atlas-core-session/v1", "repo": str(repo),
            "participant": participant, "project": project, "assistant": assistant}


def tool_owner(repo):
    return {"format": "jeju-atlas-core-toolchain/v1", "repo": str(repo)}


def check_toolchain(repo):
    repo = check_source(repo)
    directory = safe_path(repo / "workshop/.local/toolchain")
    if not directory.is_dir():
        raise ValueError("Run core.py prepare before installing the private toolchain")
    check_owned(directory, tool_owner(repo))
    return {"toolchainPath": str(directory), "nodeVersion": (repo / ".nvmrc").read_text().strip(),
            "pythonVersion": PYTHON_VERSION, "agentcoreVersion": CLI_VERSION}


def check_owned(directory, expected):
    safe_path(directory)
    if directory.exists():
        if not directory.is_dir():
            raise ValueError("Expected an owned directory; preserve the existing path: " + str(directory))
        actual = read_json(directory / ".owner.json")
        if actual != expected:
            # Report field names only; arbitrary metadata values are not log data.
            fields = [key for key in expected if not isinstance(actual, dict) or actual.get(key) != expected[key]]
            if isinstance(actual, dict) and actual.keys() - expected.keys():
                fields.append("unexpected fields")
            raise ValueError(
                "Existing directory belongs to another setup; differing fields: "
                + ", ".join(fields) + ". Preserve it: " + str(directory)
                + ". Review .owner.json with the facilitator; do not delete the directory or edit its owner."
            )


def write_new(path, text):
    safe_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as stream:
        stream.write(text)


def json_text(value):
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def activation_text(repo, participant, project, assistant="claude"):
    # All paths and names are validated before shell quoting. This file queries
    # only the non-secret participant configuration, never AWS or login files.
    return '''# Generated by workshop/scripts/core.py. Source in a separate Bash terminal.
if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s\\n' 'Use Bash and source this file.' >&2
  return 2 2>/dev/null || exit 2
fi
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  printf '%s\\n' 'Use source ./activate.sh; executing it cannot restore the parent shell.' >&2
  exit 2
fi
_atlas_core_restore() {
  local repo=__REPO__ participant=__PARTICIPANT__ project=__PROJECT__
  local tools="$repo/workshop/.local/toolchain" helper account node_version
  helper="$(command -v python3)" || return
  if [[ -x "$tools/helpers/bin/python3" ]]; then helper="$tools/helpers/bin/python3"; fi
  account="$("$helper" -B "$repo/workshop/scripts/core.py" account \\
    --repo "$repo" --participant "$participant" --project-name "$project")" || return
  node_version="$(cat "$repo/.nvmrc")" || return
  export ATLAS_REPO="$repo" ATLAS_TEAM="$participant" ATLAS_PROJECT="$project"
  export ATLAS_ASSISTANT=__ASSISTANT__
  export ATLAS_REGION=ap-northeast-2 ATLAS_ACCOUNT="$account"
  export ATLAS_CONFIG="$repo/workshop/.local/$participant.json"
  export ATLAS_CLI_PARENT="$repo/workshop/.local/labs/$participant"
  export ATLAS_CLI="$ATLAS_CLI_PARENT/$project" ATLAS_TOOLCHAIN="$tools"
  export AGENTCORE_CONFIG_DIR="$ATLAS_CLI_PARENT/cli-config"
  export AGENTCORE_TELEMETRY_DISABLED=1
  export AWS_REGION=ap-northeast-2 AWS_DEFAULT_REGION=ap-northeast-2
  export UV_PYTHON_INSTALL_DIR="$tools/python" UV_CACHE_DIR="$tools/cache/uv"
  export npm_config_cache="$tools/cache/npm" ATLAS_PYTHON="$helper"
  export PATH="$tools/helpers/bin:$tools/node-v$node_version/bin:$tools/agentcore/node_modules/.bin:$PATH"
  cd -- "$repo" || return
}
_atlas_core_restore
_atlas_core_result=$?
unset -f _atlas_core_restore
return "$_atlas_core_result"
'''.replace("__REPO__", shlex.quote(str(repo))).replace(
        "__PARTICIPANT__", shlex.quote(participant)).replace(
        "__PROJECT__", shlex.quote(project)).replace("__ASSISTANT__", shlex.quote(assistant))


def check_session(repo, participant, project):
    repo = check_source(repo)
    local, parent, destination, tools = paths(repo, participant, project)
    assistant = read_json(parent / ".owner.json").get("assistant")
    for directory, expected in ((tools, tool_owner(repo)), (parent, owner(repo, participant, project, assistant))):
        if not directory.is_dir():
            raise ValueError("Prepare the core session first: " + str(directory))
        check_owned(directory, expected)
    config = read_json(parent / "cli-config/config.json")
    if (config.get("disableDependencyManagement") is not True
            or config.get("disableTransactionSearch") is not True
            or not isinstance(config.get("telemetry"), dict)
            or config["telemetry"].get("enabled") is not False):
        raise ValueError("CLI config must disable dependency management, Transaction Search and telemetry")
    activation = safe_path(parent / "activate.sh")
    if not activation.is_file() or activation.read_text() != activation_text(repo, participant, project, assistant):
        raise ValueError("Activation file differs from this source/session; preserve it and review before reuse")
    return local, parent, destination, tools


def read_account(repo, participant, project):
    local, _, _, _ = check_session(repo, participant, project)
    path = safe_path(local / (participant + ".json"))
    if not path.exists():
        return ""
    config = read_json(path)
    account = config.get("accountId", "")
    if (config.get("participant") != participant or config.get("region") != REGION
            or not isinstance(account, str) or not re.fullmatch(r"\d{12}", account)
            or account == "000000000000"):
        raise ValueError("Saved EC2 configuration does not match this participant/account/region")
    return account


def node_activation_text(repo):
    return '''# Generated by workshop/scripts/core.py. Source in your Bash terminal.
if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s\\n' 'Use Bash and source this file.' >&2
  return 2 2>/dev/null || exit 2
fi
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  printf '%s\\n' 'Use source ./activate-node.sh; executing it cannot restore the parent shell.' >&2
  exit 2
fi
_atlas_node_restore() {
  local repo=__REPO__ node_version
  python3 -B "$repo/workshop/scripts/core.py" tools --repo "$repo" >/dev/null || return
  node_version="$(cat "$repo/.nvmrc")" || return
  export PATH="$repo/workshop/.local/toolchain/node-v$node_version/bin:$PATH"
}
_atlas_node_restore
_atlas_node_result=$?
unset -f _atlas_node_restore
return "$_atlas_node_result"
'''.replace("__REPO__", shlex.quote(str(repo)))


def prepare_tools(repo):
    """Prepare Node activation without accessing any participant directory."""
    repo = check_source(repo)
    tools = safe_path(repo / "workshop/.local/toolchain")
    check_owned(tools, tool_owner(repo))
    activation = safe_path(tools / "activate-node.sh")
    text = node_activation_text(repo)
    if activation.exists() and (not activation.is_file() or activation.read_text() != text):
        raise ValueError("Node activation file differs; preserve it and review before reuse: " + str(activation))
    if not tools.exists():
        tools.mkdir(parents=True, exist_ok=False)
        write_new(tools / ".owner.json", json_text(tool_owner(repo)))
    if not activation.exists():
        write_new(activation, text)
    return {"activationPath": str(activation), "toolchainPath": str(tools),
            "createdAwsResources": False, "installedTools": False}


def change_assistant(repo, participant, project, assistant):
    """Replace only verified generated metadata, rolling back a failed write."""
    _, parent, _, _ = check_session(repo, participant, project)
    updated = {
        "activate.sh": activation_text(repo, participant, project, assistant),
        ".owner.json": json_text(owner(repo, participant, project, assistant)),
    }
    originals = {}
    for name in updated:
        path = safe_path(parent / name)
        info = path.stat()
        if not path.is_file() or info.st_nlink != 1:
            raise ValueError("Preserve and review linked session metadata: " + str(path))
        originals[name] = (path.read_bytes(), info.st_mode & 0o777)

    stage = Path(tempfile.mkdtemp(prefix=".assistant-update-", dir=parent))
    replaced = []
    remove_stage = True
    try:
        for name, text in updated.items():
            content, mode = originals[name]
            (stage / (name + ".before")).write_bytes(content)
            (stage / (name + ".before")).chmod(mode)
            write_new(stage / name, text)
            (stage / name).chmod(mode)
        for name, (content, _) in originals.items():
            path = safe_path(parent / name)
            if path.stat().st_nlink != 1 or path.read_bytes() != content:
                raise ValueError("Session metadata changed during preparation; preserve it: " + str(path))
        for name in updated:
            os.replace(stage / name, parent / name)
            replaced.append(name)
    except BaseException:
        try:
            for name in reversed(replaced):
                os.replace(stage / (name + ".before"), parent / name)
        except OSError:
            remove_stage = False
            raise OSError("Could not restore session metadata; original files preserved in " + str(stage)) from None
        raise
    finally:
        if remove_stage:
            shutil.rmtree(stage)


def prepare(repo, participant, project=None, assistant=None):
    repo = check_source(repo)
    default_project = "AtlasCli" + participant[:1].upper() + participant[1:]
    _, parent, _, tools = paths(repo, participant, project if project is not None else default_project)
    check_owned(tools, tool_owner(repo))
    previous = read_json(parent / ".owner.json") if parent.is_dir() else {}
    if not isinstance(previous, dict):
        raise ValueError("Expected session owner metadata; preserve and review " + str(parent / ".owner.json"))
    if project is None:
        project = previous.get("project", default_project)
    if assistant is None:
        assistant = previous.get("assistant", "codex")
    local, parent, destination, tools = paths(repo, participant, project)
    expected = owner(repo, participant, project, assistant)
    # The assistant is a preference within the same verified session. Directory
    # identity, generated activation and CLI configuration still have to match.
    previous_assistant = previous.get("assistant", assistant)
    check_owned(parent, owner(repo, participant, project, previous_assistant))
    if parent.exists():
        check_session(repo, participant, project)
        if previous_assistant != assistant:
            change_assistant(repo, participant, project, assistant)
    directories = ((tools, tool_owner(repo)), (parent, owner(repo, participant, project, assistant)))
    for directory, metadata in directories:
        if not directory.exists():
            directory.mkdir(parents=True, exist_ok=False)
            write_new(directory / ".owner.json", json_text(metadata))
    if not (parent / "activate.sh").exists():
        write_new(parent / "cli-config/config.json", json_text(CLI_CONFIG))
        write_new(parent / "activate.sh", activation_text(repo, participant, project, assistant))
    return {"activationPath": str(parent / "activate.sh"), "projectPath": str(destination),
            "toolchainPath": str(tools), "assistant": expected["assistant"],
            "createdAwsResources": False, "installedTools": False}


def run_capture(command, env):
    return subprocess.run(command, env=env, capture_output=True, text=True, timeout=15)


def npm_agentcore(binary):
    if not binary:
        raise ValueError("npm @aws/agentcore 0.28.1 is not on PATH")
    entry = Path(binary).resolve()
    for directory in list(entry.parents)[:6]:
        manifest = directory / "package.json"
        if manifest.is_file():
            value = json.loads(manifest.read_text())
            if (value.get("name") == "@aws/agentcore" and value.get("version") == CLI_VERSION
                    and value.get("bin", {}).get("agentcore")
                    and (directory / value["bin"]["agentcore"]).resolve() == entry
                    and entry.is_file()):
                return CLI_VERSION
            break
    raise ValueError("Use npm @aws/agentcore 0.28.1; a Python starter CLI or other version is not supported")


def check_project(repo, participant, project):
    _, _, destination, _ = check_session(repo, participant, project)
    account = read_account(repo, participant, project)
    if not account:
        raise ValueError("Run chapter 02 init-ec2 and confirm the saved EC2 account first")
    targets = read_json(destination / "agentcore/aws-targets.json")
    if (not isinstance(targets, list)
            or [item for item in targets if isinstance(item, dict) and item.get("name") == "default"]
            != [{"name": "default", "account": account, "region": REGION}]):
        raise ValueError("The default AWS target must match the saved EC2 account and ap-northeast-2")
    spec = read_json(destination / "agentcore/agentcore.json")
    runtimes = spec.get("runtimes", [])
    runtime = next((item for item in runtimes if item.get("name") == "JejuGuide"), {})
    if (spec.get("name") != project or len(runtimes) != 1
            or any(runtime.get(key) != value for key, value in {
                "build": "CodeZip",
                "runtimeVersion": "PYTHON_3_12", "networkMode": "PUBLIC",
            }.items())
            or not isinstance(runtime.get("codeLocation"), str)
            or Path(runtime["codeLocation"]) != Path("app/JejuGuide")
            or runtime.get("protocol", "HTTP") != "HTTP"
            or runtime.get("authorizerType", "AWS_IAM") != "AWS_IAM"):
        raise ValueError("Expected this project's single JejuGuide Python 3.12/PUBLIC/IAM CodeZip Runtime")
    for name in ("main.py", "model/load.py", "pyproject.toml", "data/jeju_pois.json"):
        if not safe_path(destination / "app/JejuGuide" / name).is_file():
            raise ValueError("Missing JejuGuide file: " + name)
    seed = read_json(destination / "app/JejuGuide/data/jeju_pois.json")
    if seed != read_json(repo / "agent/tools/data/jeju_pois.json"):
        raise ValueError("Use the unchanged sample JSON copied from the source repository")
    tests = safe_path(destination / "app/JejuGuide/tests")
    if not tests.is_dir() or not any(tests.glob("test*.py")):
        raise ValueError("Add model-free search tests before deployment; an empty unittest run is not proof")
    from model_config import check_model
    check_model(destination, spec)
    return str(destination)


def doctor(repo, assistant, env=None, project=False):
    env = dict(os.environ if env is None else env)
    if assistant not in {"codex", "kiro", "claude"}:
        raise ValueError("Choose codex, kiro, or claude")
    repo = Path(repo)
    checks = []

    def check(name, action, hint):
        try:
            observed = action()
            checks.append({"name": name, "ok": True, "observed": str(observed)})
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
            checks.append({"name": name, "ok": False, "reason": str(error)[:500], "next": hint})

    def probe(command):
        result = run_capture(command, env=env)
        output = (result.stdout + result.stderr).strip()
        if result.returncode:
            raise ValueError(output[:500] or "Command failed: " + command[0])
        return output

    def version(name):
        binary = shutil.which(name, path=env.get("PATH", ""))
        if not binary:
            raise ValueError(name + " is not on PATH")
        output = probe([binary, "--version"])
        if name == "node":
            match = re.search(r"\bv(\d+)\.(\d+)\.(\d+)\b", output)
            if not match or match[1] != "24" or tuple(map(int, match.groups())) < (24, 18, 1):
                raise ValueError("Need Node >=24.18.1 within major 24; found " + output)
        return binary + ": " + output[:160]

    def session():
        participant, name = env.get("ATLAS_TEAM", ""), env.get("ATLAS_PROJECT", "")
        local, parent, destination, _ = check_session(repo, participant, name)
        expected = {
            "ATLAS_REPO": str(repo), "ATLAS_CLI_PARENT": str(parent), "ATLAS_CLI": str(destination),
            "ATLAS_CONFIG": str(local / (participant + ".json")), "ATLAS_REGION": REGION,
            "AGENTCORE_CONFIG_DIR": str(parent / "cli-config"),
            "AGENTCORE_TELEMETRY_DISABLED": "1", "AWS_REGION": REGION, "AWS_DEFAULT_REGION": REGION,
        }
        missing = [key for key, value in expected.items() if env.get(key) != value]
        if missing:
            raise ValueError("Restore the participant activation file; mismatched/unset: " + ", ".join(missing))
        return str(parent / "activate.sh")

    def python_runtime():
        binary = shutil.which("uv", path=env.get("PATH", ""))
        if not binary:
            raise ValueError("uv is required to locate Python 3.12")
        path = probe([binary, "python", "find", "--no-python-downloads", PYTHON_VERSION])
        output = probe([path, "--version"])
        if not re.search(r"\bPython 3\.12\.\d+\b", output):
            raise ValueError("Expected Python 3.12; found " + output)
        return path + ": " + output

    install_hint = "Run bash workshop/scripts/install_core.sh, then source your participant activate.sh again"
    check("source", lambda: check_source(repo), "Obtain the full Git source, not just the handbook ZIP")
    check("session", session, "Run core.py prepare and source its absolute activationPath in this Bash terminal")
    for name in ("node", "npm", "uv", "aws", {"codex": "codex", "kiro": "kiro-cli", "claude": "claude"}[assistant]):
        check(name, lambda name=name: version(name),
              install_hint if name in {"node", "npm"} else "Use the facilitator-provided " + name + " path")
    check("python3.12", python_runtime, install_hint)
    check("helper-packages", lambda: probe([
        sys.executable, "-B", "-c",
        "import sys\n"
        "if sys.version_info < (3, 12): sys.exit('Use the Python 3.12+ helpers from activate.sh')\n"
        "import json,boto3,requests; print(json.dumps({'boto3':boto3.__version__,'requests':requests.__version__}))",
    ]), install_hint)
    # Read the npm package's metadata instead of starting an AgentCore command,
    # which can initialize global config/telemetry even during tool discovery.
    check("agentcore", lambda: npm_agentcore(shutil.which("agentcore", path=env.get("PATH", ""))), install_hint)
    if project:
        check("project", lambda: check_project(repo, env.get("ATLAS_TEAM", ""), env.get("ATLAS_PROJECT", "")),
              "Review the saved EC2 account, default target, JejuGuide source/data and search tests")
    return {"course": "00-04", "assistant": assistant, "helperPython": sys.executable,
            "checks": checks, "passed": all(item["ok"] for item in checks),
            "awsChecked": False, "modelInvoked": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    for action in ("prepare", "prepare-tools", "account", "doctor", "source", "tools"):
        command = commands.add_parser(action)
        command.add_argument("--repo", type=Path, default=ROOT)
        if action in {"prepare", "account"}:
            command.add_argument("--participant", required=True)
            command.add_argument("--project-name", required=action == "account")
        if action == "prepare":
            command.add_argument("--assistant", choices=["codex", "kiro", "claude"])
        if action == "doctor":
            command.add_argument("--assistant", choices=["codex", "kiro", "claude"], required=True)
            command.add_argument("--project", action="store_true", help="Also check the chapter 04 project boundary")
    args = parser.parse_args()
    try:
        if args.action == "prepare":
            result = prepare(args.repo, args.participant, args.project_name, args.assistant)
        elif args.action == "prepare-tools":
            result = prepare_tools(args.repo)
        elif args.action == "account":
            print(read_account(args.repo, args.participant, args.project_name))
            return
        elif args.action == "source":
            result = {"source": str(check_source(args.repo))}
        elif args.action == "tools":
            result = check_toolchain(args.repo)
        else:
            result = doctor(args.repo, args.assistant, project=args.project)
        print(json_text(result), end="")
        if result.get("passed") is False:
            raise SystemExit(1)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print("Core workshop: " + str(error), file=sys.stderr)
        raise SystemExit(2) from None


if __name__ == "__main__":
    main()
