# Codex 환경 설정과 Bedrock 연결

진행자가 별도의 Codex Bedrock provider를 제공할 때 사용하는 선택 설정 예시입니다.\
이미 로그인한 CLI로 실습할 수 있다면 이 설정을 추가하지 않습니다.\
진행자가 수업 전에 사용자 설정과 AWS 인증을 준비하고, 참가자는 01장에서 적용 상태를 확인합니다.

이 설정은 코드를 작성하는 Codex용이며 워크숍의 JejuGuide Runtime 설정과 구분합니다.\
Node, Python, 보조 패키지와 npm AgentCore CLI는 [사전 구성](preconfiguration.md)에서 먼저 준비합니다.

## 설정 파일 위치

사용자 설정 파일은 기본적으로 `~/.codex/config.toml`입니다.\
이미 `CODEX_HOME`을 사용하는 환경은 그 디렉터리의 `config.toml`을 사용합니다.\
현재 위치는 VSCode Server의 Bash 터미널에서 확인합니다.

```bash
cd -- "$HOME" && {
printf '%s\n' "${CODEX_HOME:-$HOME/.codex}/config.toml"
}
```
provider 설정은 사용자 수준 파일에 둡니다.\
프로젝트의 `.codex/config.toml`만 편집하는 방식으로 provider 연결을 준비하지 않습니다.

기존 파일을 백업한 뒤 아래 항목을 병합하고, 인증 파일이나 다른 설정 전체를 덮어쓰지 않습니다.\
이 안내를 적용하려고 `HOME`이나 `CODEX_HOME`을 다른 경로로 바꾸지 않습니다.

## 사용할 TOML 설정

아래는 워크숍에 제공된 설정을 그대로 보존한 예시입니다.\
TOML 파일 내용이므로 셸 명령이나 AI 프롬프트로 실행하지 않습니다.

```toml
model = "openai.gpt-6-astra"
model_provider = "amazon-bedrock"
openai_base_url = "https://bedrock-mantle.us-west-2.api.aws/openai/v1"
model_reasoning_effort = "max"
model_context_window = 1048576
approvals_reviewer = "auto_review"

[model_providers.amazon-bedrock.aws]
region = "us-west-2"
```

앞의 여섯 항목은 TOML 최상위 키입니다.\
기존 `[tui]`나 다른 테이블 아래에 그대로 붙이면 소속이 달라지므로 최상위 영역에서 같은 키를 수정합니다.

`[model_providers.amazon-bedrock.aws]`가 이미 있다면 테이블을 중복 선언하지 않고 그 안의 `region`을 수정합니다.\
HUD, 플러그인과 다른 사용자 설정은 유지합니다.

| 항목 | 값과 확인할 의미 |
|---|---|
| `model` | 제공된 모델 ID `openai.gpt-6-astra`. 사용할 계정의 모델 지원과 접근 권한 확인 |
| `model_provider` | 내장 provider `amazon-bedrock` |
| `openai_base_url` | 제공된 Mantle URL. 실제 Bedrock endpoint 선택은 provider 설정과 함께 확인 |
| `model_reasoning_effort` | 요청한 추론 강도 `max`. 설치된 CLI와 모델의 지원 확인 |
| `model_context_window` | Codex의 컨텍스트 창 설정 `1048576`. provider의 실제 지원 한도를 늘리는 설정은 아님 |
| `approvals_reviewer` | `auto_review`가 승인 요청을 자동 검토. 승인 정책과 샌드박스는 별도 |
| `model_providers.amazon-bedrock.aws.region` | Codex의 Bedrock 리전 `us-west-2` |

OpenAI의 일반 설정 참조는 `openai_base_url`을 기본 `openai` provider의 주소 재정의로 설명합니다.\
이 예시는 제공된 값을 유지하며, `amazon-bedrock`에서의 실제 endpoint는 설치 버전과 AWS provider의 리전 해석으로 확인합니다.\
설정 파일의 값만으로 이 키가 해당 provider의 주소를 바꿨다고 단정하지 않습니다.

일반 설정 참조의 reasoning 값 목록과 설치 버전의 지원 범위가 다를 수 있습니다.\
2026-09-16의 유지관리 환경에서는 Codex CLI 0.154.0에 위 값들을 명령행 override로 전달한 읽기 전용 `features list`가 종료 0으로 끝났습니다.\
이 결과는 지정 모델의 가용성이나 실제 Bedrock 요청 성공을 확인한 기록은 아닙니다.

## Codex와 Runtime의 리전 구분

| 대상 | 모델 또는 설정 | 리전 확인 |
|---|---|---|
| 코딩 도구 Codex | 위 TOML의 `openai.gpt-6-astra`, `amazon-bedrock` | provider의 `aws.region = "us-west-2"` |
| 기본 JejuGuide Runtime | `global.anthropic.claude-sonnet-4-6` | 서울 배포와 주최자가 확인한 Bedrock 호출 리전을 구분 |
| Claude Code | `claude --permission-mode auto` | 해당 도구의 기존 인증과 환경을 따름 |
| Atlas 앱과 인프라 | 참가자 `ATLAS_CONFIG`, `aws-targets.json`과 소유 스택 | 기존 참가자 배포 리전 유지 |

Codex를 연결하기 위해 `AWS_REGION`, `ATLAS_REGION`, `ATLAS_BEDROCK_REGION`이나 `aws-targets.json`을 `us-west-2`로 일괄 변경하지 않습니다.\
Codex가 응답해도 Runtime 역할의 Sonnet 호출 권한까지 확인된 것은 아닙니다.\
HUD는 현재 Codex 세션을 표시하며, 배포된 AgentCore 모델을 선택하지 않습니다.

## AWS 인증 준비

진행자는 해당 사용자에게 배정된 AWS 인증 방식과 Mantle 접근 권한을 확인합니다.\
내장 Bedrock provider는 AWS 인증 설정을 사용하며, 지원되는 Bedrock bearer token이나 AWS 자격 증명 체인에 관한 세부 순서는 공식 provider 안내를 따릅니다.\
이 TOML 예시에 access key, secret key, bearer token을 추가하거나 인증 파일을 공유하지 않습니다.

STS 조회와 일반 AWS CLI 실행 성공만으로 지정 모델의 Mantle 호출 권한을 판정하지 않습니다.\
Codex의 인증과 모델 접근 확인은 같은 사용자와 provider 리전에서 별도로 수행합니다.\
권한 오류가 있으면 실제 오류를 보존하고 주최자에게 확인하며 IAM/SCP를 우회하지 않습니다.

## 설정 확인

01장의 활성화 파일을 불러와 `ATLAS_PYTHON`이 준비된 Bash에서 실행합니다.\
선택한 키만 검사하므로 전체 설정이나 인증 내용을 출력하지 않습니다.\
이 파서는 Python 3.11 이상이 필요하며 워크숍의 helper Python 3.12 이상를 사용할 수 있습니다.

```bash
cd -- "$HOME" && {
"${ATLAS_PYTHON:?01장의 활성화 파일을 먼저 불러오세요}" - \
  "${CODEX_HOME:-$HOME/.codex}/config.toml" <<'PY'
import json
import sys
import tomllib
from pathlib import Path

with Path(sys.argv[1]).open("rb") as stream:
    config = tomllib.load(stream)
expected = {
    "model": "openai.gpt-6-astra",
    "model_provider": "amazon-bedrock",
    "openai_base_url": "https://bedrock-mantle.us-west-2.api.aws/openai/v1",
    "model_reasoning_effort": "max",
    "model_context_window": 1048576,
    "approvals_reviewer": "auto_review",
}
for key, value in expected.items():
    if config.get(key) != value:
        raise SystemExit("설정 위치 또는 값 확인: " + key)
region = config.get("model_providers", {}).get("amazon-bedrock", {}).get("aws", {}).get("region")
if region != "us-west-2":
    raise SystemExit("설정 확인: model_providers.amazon-bedrock.aws.region")
print(json.dumps({
    "requestedSettingsMatch": True,
    "model": expected["model"],
    "provider": expected["model_provider"],
    "region": region,
    "modelInvoked": False,
}))
PY
}
```
이어 설치 버전과 읽기 전용 설정 로딩을 확인합니다.

```bash
cd -- "$HOME" && {
command codex --version
command codex features list
}
```
`features list`는 모델 요청을 보내는 검사가 아닙니다.\
`core.py doctor`도 Codex의 모델, endpoint, AWS 인증과 실제 응답을 검사하지 않습니다.\
명령행의 `-c`, `--model`, `--profile` 또는 관리 설정이 적용되면 이 파일과 유효 설정이 다를 수 있으므로, 새 Codex 세션에서 모델과 provider 상태도 확인합니다.

## 새 세션과 HUD에서 확인

설정 변경 후에는 같은 환경을 사용하는 새 Codex 세션을 엽니다.\
03장에서 프로젝트를 생성한 뒤 기존 실행 옵션을 유지합니다.

```bash
cd -- "${ATLAS_CLI:?먼저 01장의 activate.sh를 source하세요}" && {
test -f "${ATLAS_CLI:?03장에서 만든 프로젝트 경로를 확인하세요}/agentcore/agentcore.json" &&
command codex -C "$ATLAS_CLI" --sandbox workspace-write -a on-request -c 'approvals_reviewer="auto_review"'
}
```
Codex 대화에서 `/status`로 선택한 모델과 실행 상태를 확인합니다.\
HUD를 사용할 때는 [HUD 가이드](hud-setup.md)의 절대 실행 경로로 같은 프로젝트를 엽니다.

`-a on-request`는 검토가 필요한 시점을 정하고 `auto_review`는 그 요청의 검토자를 정합니다.\
자동 검토가 켜져도 workspace 경계와 관리 정책, 검토 거부는 그대로 적용됩니다.

실제 응답 확인은 진행자가 정한 짧은 요청으로 별도 수행하며 모델 호출 비용과 권한이 필요합니다.\
TOML 검사, 설정 로딩, 상태 표시와 실제 모델 응답을 각각 기록합니다.\
예상 답변이나 다른 참가자의 성공 결과를 자신의 연결 성공으로 기록하지 않습니다.

## 문제 해결과 인계

| 현상 | 먼저 확인할 내용 |
|---|---|
| TOML 중복 키 또는 값 불일치 | 최상위 키 위치, 기존 테이블과의 중복, 숫자와 문자열 형식 |
| 알 수 없는 설정 또는 `max` 거부 | 설치된 Codex 버전과 해당 버전의 지원 범위. 제공값을 임의로 다른 모델이나 강도로 바꾸지 않음 |
| 다른 모델이나 provider 표시 | 실제 설정 파일 위치, 명령행 override, profile과 관리 설정, 새 세션 여부 |
| endpoint 또는 리전이 예상과 다름 | 내장 Bedrock provider의 실제 해석, `aws.region`, 의도하지 않은 환경 override |
| 인증 실패 또는 접근 거부 | 배정된 AWS 인증, Mantle와 모델 권한, 실제 오류. 다른 계정으로 우회하지 않음 |
| 자동 검토가 거부됨 | 요청 범위, sandbox와 관리 정책. `auto_review`를 무조건 허용으로 해석하지 않음 |

진행자는 CLI 버전, 적용 파일, 검사한 키, 실제 호출 여부와 남은 제한을 기록합니다.\
교재의 예시 추가만으로 참가자 설정 파일이 바뀌거나 모델 연결이 완료되지는 않습니다.

공식 참고: [Codex 기본 설정](https://developers.openai.com/codex/config-basic/), [설정 참조](https://developers.openai.com/codex/config-reference/), [모델과 Amazon Bedrock provider](https://developers.openai.com/codex/models), [자동 승인 검토](https://developers.openai.com/codex/concepts/sandboxing/auto-review).
