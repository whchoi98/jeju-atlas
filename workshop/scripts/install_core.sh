#!/usr/bin/env bash
# Explicit setup action. Reuses compatible tools; installs into the owned toolchain.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo="$(cd -- "$script_dir/../.." && pwd -P)"
usage() {
  printf '%s\n' 'Usage: bash workshop/scripts/install_core.sh [--repo /absolute/source/path] [--node-only]'
}
node_only=0
while (($#)); do
  case "$1" in
    --repo)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] ||
        { usage >&2; exit 2; }
      repo="$2"
      shift 2
      ;;
    --node-only) node_only=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
bootstrap_python="$(command -v python3)"
settings="$("$bootstrap_python" -B "$script_dir/core.py" tools --repo "$repo")"
tools="$("$bootstrap_python" -B -c 'import json,sys; print(json.load(sys.stdin)["toolchainPath"])' <<< "$settings")"
node_version="$("$bootstrap_python" -B -c 'import json,sys; print(json.load(sys.stdin)["nodeVersion"])' <<< "$settings")"
python_version="$("$bootstrap_python" -B -c 'import json,sys; print(json.load(sys.stdin)["pythonVersion"])' <<< "$settings")"
cli_version="$("$bootstrap_python" -B -c 'import json,sys; print(json.load(sys.stdin)["agentcoreVersion"])' <<< "$settings")"

[[ "$(uname -s)" == Linux ]] || { printf '%s\n' 'This installer supports Linux EC2.' >&2; exit 2; }
case "$(uname -m)" in
  aarch64|arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) printf '%s\n' 'Use an ARM64 or x86_64 Linux EC2.' >&2; exit 2 ;;
esac
if (( ! node_only )); then
  command -v uv >/dev/null || { printf '%s\n' 'Prerequisite missing: uv' >&2; exit 2; }
fi

matches_agentcore() {
  # Inspect npm metadata without launching the CLI or initializing login/config.
  "$bootstrap_python" -B - "$script_dir" "$1" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
from core import npm_agentcore
try:
    npm_agentcore(sys.argv[2])
except (OSError, ValueError, KeyError, TypeError, AttributeError):
    raise SystemExit(1) from None
PY
}

node_npm_ready() {
  [[ -x "$1/bin/npm" ]] &&
    PATH="$1/bin:$PATH" "$1/bin/npm" --version >/dev/null 2>&1
}

# Refuse links or incompatible partial installations. Never replace system bins.
node_dir="$tools/node-v$node_version"
for directory in "$node_dir" "$tools/helpers" "$tools/agentcore" "$tools/python" "$tools/cache"; do
  [[ ! -L "$directory" ]] || { printf 'Refusing symlink: %s\n' "$directory" >&2; exit 2; }
done
if [[ -e "$node_dir" ]]; then
  [[ -x "$node_dir/bin/node" && "$("$node_dir/bin/node" --version)" == "v$node_version" ]] ||
    { printf 'Preserve and inspect the existing Node directory: %s\n' "$node_dir" >&2; exit 2; }
  if (( node_only )) && ! node_npm_ready "$node_dir"; then
    printf 'Preserve and inspect the existing Node directory; npm is unavailable: %s\n' "$node_dir" >&2
    exit 2
  fi
  printf 'Reusing Node %s: %s\n' "$node_version" "$node_dir/bin/node"
elif node_binary="$(command -v node)" \
    && detected_node="$("$node_binary" --version 2>/dev/null)" \
    && [[ "$detected_node" =~ ^v24\.([0-9]+)\.([0-9]+)$ ]] \
    && (( 10#${BASH_REMATCH[1]} > 18 || (10#${BASH_REMATCH[1]} == 18 && 10#${BASH_REMATCH[2]} >= 1) )) \
    && command -v npm >/dev/null && npm --version >/dev/null 2>&1; then
  printf 'Reusing Node %s and npm from PATH: %s\n' "$detected_node" "$node_binary"
else
  for tool in curl tar sha256sum awk; do
    command -v "$tool" >/dev/null || { printf 'Prerequisite missing: %s\n' "$tool" >&2; exit 2; }
  done
  stage="$(mktemp -d "$tools/.node-install-XXXXXXXX")"
  trap 'rm -rf -- "$stage"' EXIT
  archive="node-v$node_version-linux-$arch.tar.gz"
  base="https://nodejs.org/dist/v$node_version"
  curl -q --fail --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 15 --max-time 600 --output "$stage/$archive" "$base/$archive"
  curl -q --fail --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 15 --max-time 60 --output "$stage/SHASUMS256.txt" "$base/SHASUMS256.txt"
  awk -v name="$archive" '$2 == name {print}' "$stage/SHASUMS256.txt" > "$stage/selected.sha256"
  if ! (cd -- "$stage" && sha256sum --check selected.sha256); then
    printf '%s\n' 'Node checksum verification failed; no Node installation was published.' >&2
    exit 1
  fi
  tar -xzf "$stage/$archive" -C "$stage"
  [[ "$("$stage/node-v$node_version-linux-$arch/bin/node" --version)" == "v$node_version" ]]
  if (( node_only )) && ! node_npm_ready "$stage/node-v$node_version-linux-$arch"; then
    printf '%s\n' 'Node npm check failed; no Node installation was published.' >&2
    exit 2
  fi
  mv -- "$stage/node-v$node_version-linux-$arch" "$node_dir"
  rm -rf -- "$stage"
  trap - EXIT
fi

if (( node_only )); then
  printf '\n%s\n' 'Node.js and npm prepared (Node-only).'
  printf '%s\n' 'Source the activationPath printed by start.sh in your Bash terminal to use Node and npm.'
  exit 0
fi

export PATH="$node_dir/bin:$tools/agentcore/node_modules/.bin:$PATH"
export UV_PYTHON_INSTALL_DIR="$tools/python" UV_CACHE_DIR="$tools/cache/uv"
export npm_config_cache="$tools/cache/npm"
# --no-bin is essential: do not add/replace python or python3 in ~/.local/bin.
uv --no-config python install --no-bin "$python_version"
runtime_python="$(uv --no-config python find --managed-python --no-python-downloads "$python_version")"
if [[ -e "$tools/helpers" ]]; then
  [[ -x "$tools/helpers/bin/python3" ]] ||
    { printf '%s\n' 'Existing helpers directory is incomplete; preserve it for inspection.' >&2; exit 2; }
  "$tools/helpers/bin/python3" -B -c \
    'import sys; sys.exit(0 if sys.version_info >= (3, 12) else "Existing helpers need Python 3.12+; preserve the directory for inspection.")'
else
  uv --no-config venv --python "$runtime_python" "$tools/helpers"
fi
uv --no-config pip install --python "$tools/helpers/bin/python3" \
  -r "$repo/workshop/requirements-core.txt"

if [[ -e "$tools/agentcore" ]]; then
  "$bootstrap_python" -B - "$script_dir" "$tools/agentcore/package.json" "$cli_version" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
from core import read_json
try:
    if read_json(sys.argv[2]).get("dependencies", {}).get("@aws/agentcore") != sys.argv[3]:
        raise ValueError("AgentCore dependency version differs")
except (OSError, ValueError, KeyError, TypeError, AttributeError):
    raise SystemExit("Preserve and inspect the existing AgentCore directory.") from None
PY
  [[ -f "$tools/agentcore/package-lock.json" ]] ||
    { printf '%s\n' 'AgentCore lock is missing; preserve the directory for inspection.' >&2; exit 2; }
  matches_agentcore "$tools/agentcore/node_modules/.bin/agentcore" ||
    { printf '%s\n' 'Existing AgentCore installation is incomplete; preserve it for inspection.' >&2; exit 2; }
fi
agentcore_binary="$(command -v agentcore || true)"
if matches_agentcore "$agentcore_binary"; then
  printf 'Reusing npm @aws/agentcore %s: %s\n' "$cli_version" "$agentcore_binary"
else
  stage="$(mktemp -d "$tools/.agentcore-install-XXXXXXXX")"
  trap 'rm -rf -- "$stage"' EXIT
  npm --prefix "$stage" install --save-exact --ignore-scripts --no-audit --no-fund \
    "@aws/agentcore@$cli_version"
  [[ -f "$stage/package-lock.json" ]] && matches_agentcore "$stage/node_modules/.bin/agentcore" ||
    { printf '%s\n' 'AgentCore installation is incomplete; no CLI installation was published.' >&2; exit 2; }
  mv -- "$stage" "$tools/agentcore"
  trap - EXIT
fi

printf '\nCore tools prepared: %s\n' "$tools"
printf '%s\n' 'Source your participant activate.sh again, then run core.py doctor with your selected --assistant.'
