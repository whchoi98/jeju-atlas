#!/usr/bin/env bash
# Explicit facilitator action. Installs only inside an owned workshop toolchain.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo="$(cd -- "$script_dir/../.." && pwd -P)"
if [[ $# == 2 && "$1" == --repo ]]; then
  repo="$2"
elif [[ $# != 0 ]]; then
  printf '%s\n' 'Usage: bash workshop/scripts/install_core.sh [--repo /absolute/source/path]' >&2
  exit 2
fi
settings="$(python3 -B "$script_dir/core.py" tools --repo "$repo")"
tools="$(python3 -B -c 'import json,sys; print(json.load(sys.stdin)["toolchainPath"])' <<< "$settings")"
node_version="$(python3 -B -c 'import json,sys; print(json.load(sys.stdin)["nodeVersion"])' <<< "$settings")"
python_version="$(python3 -B -c 'import json,sys; print(json.load(sys.stdin)["pythonVersion"])' <<< "$settings")"
cli_version="$(python3 -B -c 'import json,sys; print(json.load(sys.stdin)["agentcoreVersion"])' <<< "$settings")"

[[ "$(uname -s)" == Linux ]] || { printf '%s\n' 'This installer supports Linux EC2.' >&2; exit 2; }
case "$(uname -m)" in
  aarch64|arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) printf '%s\n' 'Use an ARM64 or x86_64 Linux EC2.' >&2; exit 2 ;;
esac
for tool in uv curl tar sha256sum awk; do
  command -v "$tool" >/dev/null || { printf 'Facilitator prerequisite missing: %s\n' "$tool" >&2; exit 2; }
done

# Refuse links or incompatible partial installations. Never replace system bins.
node_dir="$tools/node-v$node_version"
for directory in "$node_dir" "$tools/helpers" "$tools/agentcore" "$tools/python" "$tools/cache"; do
  [[ ! -L "$directory" ]] || { printf 'Refusing symlink: %s\n' "$directory" >&2; exit 2; }
done
if [[ -e "$node_dir" ]]; then
  [[ -x "$node_dir/bin/node" && "$("$node_dir/bin/node" --version)" == "v$node_version" ]] ||
    { printf 'Preserve and inspect the existing Node directory: %s\n' "$node_dir" >&2; exit 2; }
else
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
  mv -- "$stage/node-v$node_version-linux-$arch" "$node_dir"
  rm -rf -- "$stage"
  trap - EXIT
fi

export PATH="$node_dir/bin:$PATH"
export UV_PYTHON_INSTALL_DIR="$tools/python" UV_CACHE_DIR="$tools/cache/uv"
export npm_config_cache="$tools/cache/npm"
# --no-bin is essential: do not add/replace python or python3 in ~/.local/bin.
uv --no-config python install --no-bin "$python_version"
runtime_python="$(uv --no-config python find --managed-python --no-python-downloads "$python_version")"
if [[ -e "$tools/helpers" ]]; then
  [[ -x "$tools/helpers/bin/python3" ]] ||
    { printf '%s\n' 'Existing helpers directory is incomplete; preserve it for inspection.' >&2; exit 2; }
  "$tools/helpers/bin/python3" -B -c 'import sys; assert sys.version_info[:2] == (3, 14)'
else
  uv --no-config venv --python "$runtime_python" "$tools/helpers"
fi
uv --no-config pip install --python "$tools/helpers/bin/python3" \
  -r "$repo/workshop/requirements-core.txt"

stage="$(mktemp -d "$tools/.agentcore-install-XXXXXXXX")"
trap 'rm -rf -- "$stage"' EXIT
if [[ -e "$tools/agentcore" ]]; then
  # Keep the current CLI usable if a reinstall fails. Use its saved lock in
  # staging, then publish only the completed installation.
  node -e 'const p=require(process.argv[1]); if(p.dependencies?.["@aws/agentcore"]!==process.argv[2]) process.exit(2)' \
    "$tools/agentcore/package.json" "$cli_version"
  [[ -f "$tools/agentcore/package-lock.json" ]] ||
    { printf '%s\n' 'AgentCore lock is missing; preserve the directory for inspection.' >&2; exit 2; }
  cp -- "$tools/agentcore/package.json" "$tools/agentcore/package-lock.json" "$stage/"
  npm --prefix "$stage" ci --ignore-scripts --no-audit --no-fund
else
  npm --prefix "$stage" install --save-exact --ignore-scripts --no-audit --no-fund \
    "@aws/agentcore@$cli_version"
fi
if [[ -e "$tools/agentcore" ]]; then
  # A completed matching installation already exists; leave its files in place.
  # The staged npm ci above verifies that the saved lock can still be installed.
  rm -rf -- "$stage"
else
  mv -- "$stage" "$tools/agentcore"
fi
trap - EXIT

printf '\nPrivate core tools prepared: %s\n' "$tools"
printf '%s\n' 'Source your participant activate.sh again, then run core.py doctor --assistant claude (or your selected CLI).'
