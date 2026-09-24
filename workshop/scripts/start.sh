#!/usr/bin/env bash
# Explicit local preparation, including any missing private tool installations.
set -euo pipefail

usage() {
  printf '%s\n' 'Usage: bash workshop/scripts/start.sh [--assistant codex|claude|kiro] [--participant team01] [--project-name AtlasCliTeam01]'
}

assistant=codex
participant=team01
project=""
while (($#)); do
  case "$1" in
    --assistant|--participant|--project-name)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] ||
        { usage >&2; exit 2; }
      case "$1" in
        --assistant) assistant="$2" ;;
        --participant) participant="$2" ;;
        --project-name) project="$2" ;;
      esac
      shift 2
      ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
if [[ -z "$project" ]]; then project="AtlasCli${participant^}"; fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo="$(cd -- "$script_dir/../.." && pwd -P)"
# prepare runs on the EC2's Python 3.9+ standard library. It validates names,
# source and ownership before the installer is allowed to write or download.
session="$(python3 -B "$script_dir/core.py" prepare --repo "$repo" \
  --participant "$participant" --project-name "$project" --assistant "$assistant")"
activation_path="$(python3 -B -c 'import json,sys; print(json.load(sys.stdin)["activationPath"])' <<< "$session")"

bash "$script_dir/install_core.sh" --repo "$repo"
source "$activation_path"

# CodeZip does not need Docker. Report daemon access for later container labs
# without requiring sudo, starting a container, or changing group membership.
if docker_version="$(docker --version 2>/dev/null)" \
    && timeout 15 docker info --format '{{.ServerVersion}}' >/dev/null 2>&1; then
  printf 'Docker preflight: %s; daemon accessible.\n' "$docker_version"
else
  printf '%s\n' 'Docker preflight: unavailable or daemon access failed; check Docker before container labs. Core CodeZip can continue.'
fi

"$ATLAS_PYTHON" -B "$script_dir/core.py" doctor --repo "$repo" --assistant "$assistant"

printf '\nactivationPath: %s\nenvFile: %s\n' "$activation_path" "$ATLAS_CLI_PARENT/.env"
printf '\nNext, in your Bash terminal:\nsource %q\n' "$activation_path"
printf '%s\n' '"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/workshop_env.py" configure'
