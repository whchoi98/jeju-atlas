#!/usr/bin/env python3
"""Private terminal input and scoped .env use for the AgentCore workshop."""
import argparse
from datetime import datetime, timezone
import getpass
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import warnings

TOKEN_ENV = "AWS_BEARER_TOKEN_BEDROCK"
REGION_ENV = "ATLAS_BEDROCK_REGION"
EXPIRY_ENV = "ATLAS_BEDROCK_KEY_EXPIRES_AT"
INTEGRATIONS = {
    "kakao": "KAKAO_REST_API_KEY",
    "tourapi": "TOURAPI_SERVICE_KEY",
    "visitjeju": "VISIT_JEJU_API_KEY",
}
EXPORTED = {TOKEN_ENV, REGION_ENV, EXPIRY_ENV, *INTEGRATIONS.values()}


def private_path(value):
    path = Path(os.path.abspath(value))
    for entry in (path, *path.parents):
        if entry.is_symlink():
            raise ValueError("Use a regular .env path without symlinks")
    if path.exists():
        info = path.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError("Use a regular, unshared .env file")
        if info.st_size > 65536:
            raise ValueError(".env exceeds the workshop input limit")
    return path


def read_env(path):
    """Read dotenv as data; never evaluate expansions, substitutions or code."""
    path = private_path(path)
    values = {}
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)", line)
        if not match or match[1] in values:
            raise ValueError(f"Invalid or duplicate .env entry on line {number}; values are hidden")
        name, raw = match.groups()
        try:
            if raw.startswith('"'):
                value = json.loads(raw)
            elif raw.startswith("'"):
                if len(raw) < 2 or not raw.endswith("'"):
                    raise ValueError()
                value = raw[1:-1]
            else:
                value = re.sub(r"\s+#.*$", "", raw).strip()
            if not isinstance(value, str) or any(c in value for c in "\x00\r\n"):
                raise ValueError()
        except (ValueError, json.JSONDecodeError):
            raise ValueError(f"Invalid .env value on line {number}; values are hidden") from None
        values[name] = value
    return values


def write_env(path, updates):
    path = private_path(path)
    values = read_env(path) if path.exists() else {}
    values.update(updates)
    if any(not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key)
           or not isinstance(value, str) or any(c in value for c in "\x00\r\n")
           for key, value in values.items()):
        raise ValueError("Use single-line .env values with valid names")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".env-input-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write("# Private workshop settings. Do not source, print, commit or package this file.\n")
            for name, value in values.items():
                stream.write(f"{name}={json.dumps(value, ensure_ascii=False)}\n")
        private_path(path)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return path


def expiration(value):
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if result.tzinfo is None:
            raise ValueError()
        return result.astimezone(timezone.utc)
    except (ValueError, TypeError, AttributeError):
        raise ValueError("Enter the actual key expiration with a timezone, for example YYYY-MM-DDTHH:MM:SSZ") from None


def model_values(values):
    region = values.get(REGION_ENV, "")
    if not re.fullmatch(r"[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+", region):
        raise ValueError("Set ATLAS_BEDROCK_REGION to the region where the short-term key was issued")
    token = values.get(TOKEN_ENV, "")
    if not token or any(c.isspace() for c in token):
        raise ValueError("Enter a Bedrock short-term API key in the private terminal")
    if expiration(values.get(EXPIRY_ENV, "")) <= datetime.now(timezone.utc):
        raise ValueError("The recorded Bedrock key has expired; configure a fresh key")
    return {name: values[name] for name in (REGION_ENV, TOKEN_ENV, EXPIRY_ENV)}


def status(path):
    path = private_path(path)
    values = read_env(path) if path.exists() else {}
    try:
        model_values(values)
        ready, reason = True, None
    except ValueError as error:
        ready, reason = False, str(error)
    result = {
        "envFile": str(path), "exists": path.exists(), "authMode": "api-key",
        "bedrockKeyPresent": bool(values.get(TOKEN_ENV)),
        "callerRegion": values.get(REGION_ENV, "") if re.fullmatch(
            r"[a-z]{2}(?:-[a-z0-9]+)+-[0-9]+", values.get(REGION_ENV, "")) else "",
        "expiresAt": "",
        "readyForModelCheck": ready, "modelAccessVerified": False,
        "integrations": {provider: bool(values.get(name)) for provider, name in INTEGRATIONS.items()},
    }
    try:
        result["expiresAt"] = expiration(values.get(EXPIRY_ENV, "")).isoformat()
    except ValueError:
        pass
    if ready:
        result["minutesRemaining"] = int(
            (expiration(values[EXPIRY_ENV]) - datetime.now(timezone.utc)).total_seconds() // 60
        )
    if reason:
        result["next"] = reason
    return result


def configure(path, integrations=False):
    if not sys.stdin.isatty():
        raise ValueError("Run configure in your own interactive Bash terminal; do not pipe keys or send them to an AI")
    path = private_path(path)
    current = read_env(path) if path.exists() else {}
    updates = {}
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        try:
            if integrations:
                for provider, name in INTEGRATIONS.items():
                    value = getpass.getpass(f"{provider} key (hidden; Enter keeps existing or skips): ")
                    if value:
                        updates[name] = value
            else:
                selected = input(f"Bedrock key issuing region [{current.get(REGION_ENV, '')}]: ").strip()
                updates[REGION_ENV] = selected or current.get(REGION_ENV, "")
                token = getpass.getpass("Bedrock short-term API key (hidden; Enter keeps existing): ")
                updates[TOKEN_ENV] = token or current.get(TOKEN_ENV, "")
                expiry = input(f"Actual key expiry, ISO 8601 UTC [{current.get(EXPIRY_ENV, '')}]: ").strip()
                updates[EXPIRY_ENV] = expiry or current.get(EXPIRY_ENV, "")
                model_values(updates)
        except getpass.GetPassWarning:
            raise ValueError("This terminal cannot hide input; use an interactive VSCode Bash terminal") from None
    write_env(path, updates)
    return status(path)


def run_command(path, command):
    if not command:
        raise ValueError("Provide a command after --")
    values = read_env(path)
    model_values(values)
    environment = dict(os.environ)
    environment.update({key: value for key, value in values.items() if key in EXPORTED})
    environment["ATLAS_BEDROCK_AUTH"] = "api-key"
    environment["ATLAS_BEDROCK_LOCAL_KEY"] = "1"
    return subprocess.run(command, env=environment).returncode


def default_path():
    parent = os.environ.get("ATLAS_CLI_PARENT")
    if not parent:
        raise ValueError("Source your participant activate.sh, or pass --env-file explicitly")
    return Path(parent) / ".env"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    for action in ("configure", "status", "run", "publish", "cleanup"):
        command = commands.add_parser(action)
        command.add_argument("--env-file", type=Path)
        if action == "configure":
            command.add_argument("--integrations", action="store_true", help="Enter optional provider keys after deployment")
        if action == "run":
            command.add_argument("command", nargs=argparse.REMAINDER)
        if action in {"publish", "cleanup"}:
            command.add_argument("--project", type=Path, required=True)
            command.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    try:
        path = args.env_file or default_path()
        if args.action == "configure":
            result = configure(path, args.integrations)
        elif args.action == "status":
            result = status(path)
        elif args.action == "run":
            command = args.command[1:] if args.command[:1] == ["--"] else args.command
            raise SystemExit(run_command(path, command))
        else:
            from key_binding import cleanup, publish
            operation = publish if args.action == "publish" else cleanup
            result = operation(args.project, path, execute=args.execute)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (OSError, ValueError, EOFError) as error:
        print("Workshop environment: " + str(error), file=sys.stderr)
        raise SystemExit(2) from None
    except KeyboardInterrupt:
        print("\nInput cancelled; existing .env kept.", file=sys.stderr)
        raise SystemExit(130) from None


if __name__ == "__main__":
    main()
