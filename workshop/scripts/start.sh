#!/usr/bin/env bash
# Explicit local preparation, including any missing private tool installations.
set -euo pipefail

usage() {
  printf '%s\n' 'Usage: bash workshop/scripts/start.sh [--assistant codex|claude|kiro] [--participant team01] [--project-name AtlasCliTeam01] [--repo /absolute/source/path] [--node-only]'
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo="$(cd -- "$script_dir/../.." && pwd -P)"
assistant=""
participant=team01
project=""
node_only=0
while (($#)); do
  case "$1" in
    --assistant|--participant|--project-name|--repo)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] ||
        { usage >&2; exit 2; }
      case "$1" in
        --assistant) assistant="$2" ;;
        --participant) participant="$2" ;;
        --project-name) project="$2" ;;
        --repo) repo="$2" ;;
      esac
      shift 2
      ;;
    --node-only) node_only=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
case "$assistant" in
  ""|codex|claude|kiro) ;;
  *) usage >&2; exit 2 ;;
esac

# prepare runs on the EC2's Python 3.9+ standard library. It validates names,
# source and ownership before the installer is allowed to write or download.
if (( node_only )); then
  # Node is shared by the coding assistants; do not create or inspect a session.
  session="$(python3 -B "$script_dir/core.py" prepare-tools --repo "$repo")"
else
  prepare_args=(prepare --repo "$repo" --participant "$participant")
  if [[ -n "$project" ]]; then prepare_args+=(--project-name "$project"); fi
  if [[ -n "$assistant" ]]; then prepare_args+=(--assistant "$assistant"); fi
  session="$(python3 -B "$script_dir/core.py" "${prepare_args[@]}")"
fi
activation_path="$(python3 -B -c 'import json,sys; print(json.load(sys.stdin)["activationPath"])' <<< "$session")"

installer_args=(--repo "$repo")
if (( node_only )); then installer_args+=(--node-only); fi
bash "$script_dir/install_core.sh" "${installer_args[@]}"
if (( node_only )); then
  # The parent Bash shell activates Node explicitly; no full-tool readiness probe.
  printf '\nactivationPath: %s\n' "$activation_path"
  printf '\nNext, in your Bash terminal:\nsource %q\n' "$activation_path"
  exit 0
fi
source "$activation_path"
printf 'Participant assistant: %s\n' "$ATLAS_ASSISTANT"

# CodeZip does not need Docker. Report daemon access for later container labs
# without requiring sudo, starting a container, or changing group membership.
if docker_version="$(docker --version 2>/dev/null)" \
    && timeout 15 docker info --format '{{.ServerVersion}}' >/dev/null 2>&1; then
  printf 'Docker preflight: %s; daemon accessible.\n' "$docker_version"
else
  printf '%s\n' 'Docker preflight: unavailable or daemon access failed; check Docker before container labs. Core CodeZip can continue.'
fi

"$ATLAS_PYTHON" -B "$script_dir/core.py" doctor --repo "$repo" --assistant "$ATLAS_ASSISTANT"

printf '\nactivationPath: %s\nenvFile: %s\n' "$activation_path" "$ATLAS_CLI_PARENT/.env"
printf '\nNext, in your Bash terminal:\nsource %q\n' "$activation_path"
printf '%s\n' '"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/workshop_env.py" configure'
