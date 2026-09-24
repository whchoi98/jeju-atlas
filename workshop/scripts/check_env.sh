#!/usr/bin/env bash
# Standalone EC2 preflight: no installs, participant setup, .env reads or model calls.
# Keep collecting failures so a participant can fix the environment in one pass.
set -uo pipefail

usage() {
  printf '%s\n' \
    'Usage: bash workshop/scripts/check_env.sh [--offline] [--containers] [--assistant claude|codex|kiro]' \
    '' \
    'Check Node >=24.18.1 within major 24, npm, uv, helper Python >=3.12,' \
    'Python 3.12 located by uv for the Runtime, AWS CLI, and npm @aws/agentcore 0.28.1.' \
    '  --offline       Skip the AWS STS credential check; local version checks still run.' \
    '  --containers    Require usable Docker; otherwise Docker issues are warnings.' \
    '  --assistant     Check only the selected coding assistant with --version.' \
    '  --help          Show this help without running checks.' \
    '' \
    'STS is read-only, with connection/read timeouts and one attempt.' \
    'Probes also use a 15-second timeout when the timeout utility is installed.' \
    'No tools are installed, no .env is read, and no assistant login is attempted.' \
    'Exit: 0 = no required failures (review skips/warnings), 1 = failures, 2 = bad options.'
}

failures=0
warnings=0
skips=0
offline=false
containers=false
assistant=''
node_available=false
uv_ready=false
cli_version=0.28.1

while (($#)); do
  case "$1" in
    --offline) offline=true; shift ;;
    --containers) containers=true; shift ;;
    --assistant)
      if [[ $# -lt 2 ]]; then
        printf '%s\n' 'Choose --assistant claude, codex, or kiro.' >&2
        exit 2
      fi
      case "$2" in
        claude|codex|kiro) assistant="$2"; shift 2 ;;
        *) printf '%s\n' 'Choose --assistant claude, codex, or kiro.' >&2; exit 2 ;;
      esac
      ;;
    -h|--help) usage; exit 0 ;;
    *) printf '%s\n' 'Unknown option; use --help.' >&2; exit 2 ;;
  esac
done

ok() { printf '  [OK] %s\n' "$1"; }
fail() { failures=$((failures + 1)); printf '  [FAIL] %s\n' "$1"; }
warn() { warnings=$((warnings + 1)); printf '  [WARN] %s\n' "$1"; }
skip() { skips=$((skips + 1)); printf '  [SKIP] %s\n' "$1"; }
info() { printf '  [INFO] %s\n' "$1"; }
container_problem() {
  if "$containers"; then fail "$1"; else warn "$1"; fi
}

timeout_binary="$(command -v timeout 2>/dev/null || true)"
probe() {
  if [[ -n "$timeout_binary" ]]; then
    "$timeout_binary" --kill-after=2s 15s "$@"
  else
    "$@"
  fi
}

version_at_least() {
  # Limit digits before shell arithmetic; never evaluate arbitrary command output.
  [[ "$1" =~ ^([0-9]{1,4})\.([0-9]{1,4})\.([0-9]{1,4})$ ]] || return 1
  local major=$((10#${BASH_REMATCH[1]}))
  local minor=$((10#${BASH_REMATCH[2]}))
  local patch=$((10#${BASH_REMATCH[3]}))
  ((major > $2 || (major == $2 && minor > $3) ||
    (major == $2 && minor == $3 && patch >= $4)))
}

check_node() {
  local output version
  if ! command -v node >/dev/null 2>&1; then
    fail 'Node.js: missing; need >=24.18.1 within major 24.'
    return
  fi
  node_available=true
  if output="$(probe node --version 2>/dev/null)" &&
      [[ "$output" =~ ^v([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
    version="${BASH_REMATCH[1]}"
    if [[ "$version" == 24.* ]] && version_at_least "$version" 24 18 1; then
      ok "Node.js $version"
    else
      fail "Node.js $version; need >=24.18.1 within major 24."
    fi
  else
    fail 'Node.js: --version failed or is not a stable version; need >=24.18.1 within major 24.'
  fi
}

check_version() {
  local name="$1" pattern="$2" output
  if command -v "$name" >/dev/null 2>&1 &&
      output="$(probe "$name" --version 2>&1)" && [[ "$output" =~ $pattern ]]; then
    ok "$name ${BASH_REMATCH[1]}"
    return 0
  fi
  fail "$name: missing or --version failed; check installation and PATH."
  return 1
}

python_version() {
  local output
  [[ -n "$1" && -x "$1" ]] || return 1
  output="$(probe "$1" --version 2>&1)" || return 1
  [[ "$output" =~ ^Python\ ([0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4})$ ]] || return 1
  printf '%s\n' "${BASH_REMATCH[1]}"
}

check_python() {
  local candidate version name helper='' helper_version='' runtime='' runtime_version=''
  if candidate="$(command -v python3.12 2>/dev/null)" &&
      version="$(python_version "$candidate")" && version_at_least "$version" 3 12 0; then
    helper="$candidate"
    helper_version="$version"
  fi

  # uv-managed Python need not have a python3.12 shim on PATH. This never downloads.
  if "$uv_ready" &&
      candidate="$(UV_OFFLINE=true probe uv python find --no-python-downloads 3.12 2>/dev/null)" &&
      [[ "$candidate" == /* && "$candidate" != *$'\n'* ]] &&
      version="$(python_version "$candidate")" && [[ "$version" == 3.12.* ]]; then
    runtime="$candidate"
    runtime_version="$version"
    if [[ -z "$helper" ]]; then
      helper="$runtime"
      helper_version="$runtime_version"
    fi
  fi

  if [[ -z "$helper" ]]; then
    for name in python3.11 python3 python3.13 python3.14; do
      if candidate="$(command -v "$name" 2>/dev/null)" &&
          version="$(python_version "$candidate")" && version_at_least "$version" 3 12 0; then
        helper="$candidate"
        helper_version="$version"
        break
      fi
    done
  fi
  if [[ -n "$helper" ]]; then
    ok "Python helper $helper_version ($helper)"
  else
    fail 'Python helper: no usable Python >=3.12; prepare Python with uv python install 3.12.'
  fi
  if [[ -n "$runtime" ]]; then
    ok "Python runtime $runtime_version ($runtime; located by uv)"
  else
    fail 'Python runtime: uv must find Python 3.12; prepare with uv python install 3.12.'
  fi
}

check_docker() {
  local output
  if ! command -v docker >/dev/null 2>&1; then
    container_problem 'Docker: not installed (required only with --containers).'
    return
  fi
  if output="$(probe docker --version 2>&1)" &&
      [[ "$output" =~ ^Docker\ version\ ([0-9]+\.[0-9]+\.[0-9]+)(,|[[:space:]]|$) ]]; then
    ok "Docker ${BASH_REMATCH[1]}"
  else
    container_problem 'Docker: --version failed; check the Docker installation.'
  fi
  if probe docker info >/dev/null 2>&1; then
    ok 'Docker access: docker info succeeded in the current shell.'
    if command -v systemctl >/dev/null 2>&1 &&
        ! probe systemctl is-active --quiet docker >/dev/null 2>&1; then
      info 'Docker systemd service is inactive/unavailable; the current Docker context is usable.'
    fi
  else
    container_problem 'Docker access: docker info failed/timed out; check the daemon, context and socket permissions. Re-login after a group change.'
  fi
}

check_aws() {
  local output aws_ready=false
  if ! command -v aws >/dev/null 2>&1; then
    fail 'AWS CLI: missing; install it and check PATH.'
  elif output="$(probe aws --version 2>&1)" &&
      [[ "$output" =~ ^aws-cli/([0-9]+\.[0-9]+\.[0-9]+)([[:space:]]|$) ]]; then
    ok "AWS CLI ${BASH_REMATCH[1]}"
    aws_ready=true
  else
    fail 'AWS CLI: --version failed or returned unrecognized output.'
  fi
  if "$offline"; then
    skip 'AWS credentials: --offline; STS was not called and credentials are not verified.'
  elif ! "$aws_ready"; then
    skip 'AWS credentials: AWS CLI is unavailable; STS was not called.'
  elif AWS_PAGER='' AWS_CLI_AUTO_PROMPT=off AWS_MAX_ATTEMPTS=1 \
      AWS_METADATA_SERVICE_TIMEOUT=2 AWS_METADATA_SERVICE_NUM_ATTEMPTS=1 \
      probe aws sts get-caller-identity --cli-connect-timeout 5 --cli-read-timeout 5 \
      >/dev/null 2>&1; then
    ok 'AWS credentials: STS get-caller-identity succeeded.'
  else
    # Do not echo AWS errors: they can include credential-process output or identity.
    fail 'AWS credentials: STS failed/timed out; check the EC2 role or selected credentials and network.'
  fi
}

check_agentcore() {
  local binary version
  if ! binary="$(command -v agentcore 2>/dev/null)"; then
    fail "AgentCore: missing; prepare npm @aws/agentcore@$cli_version."
    return
  fi
  if ! "$node_available"; then
    fail "AgentCore: Node.js is needed to verify npm @aws/agentcore $cli_version."
    return
  fi
  # Starting even `agentcore --version` can initialize config/telemetry. Read only
  # the installed manifest and verify its bin points to the executable on PATH.
  if version="$(probe node --input-type=commonjs - "$binary" 2>/dev/null <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
try {
  const entry = fs.realpathSync(process.argv[2]);
  if (!fs.statSync(entry).isFile()) process.exit(1);
  let directory = path.dirname(entry);
  for (let depth = 0; depth < 8; depth++) {
    const manifest = path.join(directory, "package.json");
    if (fs.existsSync(manifest)) {
      if (fs.statSync(manifest).size > 1024 * 1024) process.exit(1);
      const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
      const bin = pkg.bin && pkg.bin.agentcore;
      if (pkg.name === "@aws/agentcore" && typeof pkg.version === "string" &&
          /^\d+\.\d+\.\d+$/.test(pkg.version) && typeof bin === "string" &&
          fs.realpathSync(path.resolve(directory, bin)) === entry) {
        process.stdout.write(pkg.version);
        process.exit(0);
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
} catch (_) {
  // Report a fixed diagnostic in Bash; no file contents or raw errors.
}
process.exit(1);
NODE
  )"; then
    if [[ "$version" == "$cli_version" ]]; then
      ok "AgentCore: npm @aws/agentcore $version (package metadata verified)."
    else
      fail "AgentCore: npm @aws/agentcore $version found; this workshop requires $cli_version."
    fi
  else
    fail "AgentCore: cannot verify npm @aws/agentcore $cli_version; check the package and PATH (the Python starter CLI is different)."
  fi
}

check_assistant() {
  local binary output
  if [[ -z "$assistant" ]]; then
    skip 'Assistant: none selected; use --assistant claude, codex, or kiro.'
    return
  fi
  binary="$assistant"
  [[ "$assistant" != kiro ]] || binary=kiro-cli
  if command -v "$binary" >/dev/null 2>&1 &&
      output="$(probe "$binary" --version 2>&1)" &&
      [[ "$output" =~ ([0-9]+\.[0-9]+\.[0-9]+) ]]; then
    ok "Assistant $binary ${BASH_REMATCH[1]} (version check only)."
  else
    fail "Assistant $binary: missing or --version failed; check installation and PATH."
  fi
}

# Parse OS metadata as data, not shell code. Never load a repository .env.
os_name=Linux
if [[ -r /etc/os-release ]]; then
  while IFS='=' read -r key value; do
    if [[ "$key" == PRETTY_NAME ]]; then
      os_name="${value#\"}"
      os_name="${os_name%\"}"
      break
    fi
  done < /etc/os-release
fi
architecture="$(probe uname -m 2>/dev/null)" || architecture=unknown
printf '[OS] %s / %s\n' "$os_name" "$architecture"

check_node
check_version npm '^([0-9]+\.[0-9]+\.[0-9]+)$'
if check_version uv '^uv ([0-9]+\.[0-9]+\.[0-9]+)([[:space:]]|$)'; then uv_ready=true; fi
check_python
check_docker
check_aws
check_agentcore
check_assistant
printf '[SUMMARY] %s required failure(s), %s warning(s), %s skipped check(s).\n' \
  "$failures" "$warnings" "$skips"
((failures == 0))
