# Source from Bash: source ./activate.sh
# This file contains no credentials and never reads an environment/credential file.
ATLAS_CLI_WORKSPACE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
export ATLAS_CLI_WORKSPACE
export AGENTCORE_CONFIG_DIR="$ATLAS_CLI_WORKSPACE/.cli-config"
export AGENTCORE_TELEMETRY_DISABLED=1
export AGENTCORE_DISABLE_KEYCHAIN=1
export AWS_REGION=ap-northeast-2
export AWS_DEFAULT_REGION=ap-northeast-2
export AWS_EC2_METADATA_DISABLED=true
export UV_CACHE_DIR="$ATLAS_CLI_WORKSPACE/.cache/uv"
export npm_config_cache="$ATLAS_CLI_WORKSPACE/.cache/npm"
export OTEL_SDK_DISABLED=true
export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=false
export OTEL_TRACES_EXPORTER=none
export OTEL_METRICS_EXPORTER=none
export OTEL_LOGS_EXPORTER=none
export CDK_DISABLE_CLI_TELEMETRY=true
