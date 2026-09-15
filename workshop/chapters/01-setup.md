# 01. 준비된 환경 확인

이 장은 10분입니다. VSCode Server의 **별도 Bash 터미널**에서 실습 소스와
도구를 확인합니다. VPC, NAT Gateway, Subnet과 VSCode Server를 새로 만들지 않습니다.
AI CLI의 대화창에 `cd`, `export`, `source`를 입력하는 단계가 아닙니다.
AI의 Bash 도구가 실행한 `export`는 사용자의 다른 터미널에 전달되지 않습니다.

## 사용할 AI CLI 선택

Codex, Kiro CLI, Claude Code 중 준비된 도구 하나를 선택합니다.
같은 파일을 여러 CLI에서 동시에 수정하지 않습니다.

| 도구 | 버전 확인 | 실행 |
|---|---|---|
| Codex | `codex --version` | `codex` |
| Kiro CLI | `kiro-cli --version` | `kiro-cli chat` |
| Claude Code | `claude --version` | `claude --model claude-sonnet-4-6` |

아래 예시는 Claude Code입니다. Codex는 `--assistant codex`, Kiro CLI는
`--assistant kiro`로 바꿉니다. 사전검사는 선택한 도구의 버전만 확인합니다.
로그인과 실제 대화 가능 여부는 진행자가 별도로 확인합니다.
설치된 도구를 다시 설치하거나 기존 인증 파일을 교체하지 않습니다.
Claude Code가 이미 응답했다면 인증 설정을 다시 바꾸지 않습니다.
워크숍 Claude Code는 Sonnet 4.6을 명시합니다. 떠 있는 `sonnet` 별칭을 사용하지 않습니다.
이 선택은 배포 Runtime의 Bedrock 모델 설정과 별개이며 Codex 세션의 모델은 바꾸지 않습니다.

## 1. 전체 소스와 참가자 위치 확인

진행자가 전달한 **EC2의 실제 저장소 경로**를 사용합니다. 아래 경로는 예시입니다.
`/home/ec2-user/claude-lab` 같은 기존 프로젝트 안에 설치하지 않습니다.
`team01`, `AtlasCliTeam01`도 배정된 이름으로 바꿉니다.
참가자 이름은 소문자와 숫자 3~10자, 프로젝트 이름은 `AtlasCli` 뒤에 영문과 숫자 1~15자입니다.

```bash
(
  set -e
  repo=/home/ec2-user/my-project/jeju-atlas
  test -f "$repo/workshop/scripts/core.py" || {
    printf '%s\n' '전체 실습 소스가 없습니다. 진행자에게 소스 전달을 요청하세요.' >&2
    exit 1
  }
  python3 -B "$repo/workshop/scripts/core.py" prepare \
    --participant team01 --project-name AtlasCliTeam01 --assistant claude
)
```

준비기는 Python 3.9 이상의 표준 라이브러리로 실행됩니다.
소스와 137개 장소 데이터를 확인하고 참가자용 `activate.sh`, CLI 설정을 만듭니다.
AWS 자원과 AgentCore 프로젝트는 아직 만들지 않습니다.
같은 준비를 반복해도 기존 프로젝트는 보존하며, 소유자가 다른 폴더나 설정이
변경된 폴더는 덮어쓰지 않습니다.

파일이 없으면 여기서 멈춥니다. 교재 ZIP에는 이 스크립트와 실행 소스가 없습니다.
[진행자 준비](../reference/facilitator.md)의 Git clone 또는 수정 패치 전달 절차가 필요합니다.

## 2. 같은 Bash에서 환경 활성화와 사전검사

첫 명령의 경로는 준비기가 출력한 `activationPath`를 사용합니다.

```bash
source /home/ec2-user/my-project/jeju-atlas/workshop/.local/labs/team01/activate.sh &&
python3 -B "$ATLAS_REPO/workshop/scripts/core.py" doctor --assistant "$ATLAS_ASSISTANT"
```

`passed: true`가 다음 장의 시작 조건입니다. 실패 시 `checks`의 누락 항목과
`next`를 진행자에게 전달합니다. 검사기는 설치, AWS 조회와 모델 호출을 하지 않습니다.

| 검사 | 필요한 상태 |
|---|---|
| 소스와 세션 | 전체 저장소, 샘플 137건, 참가자 변수와 전용 CLI 설정 |
| Node와 npm | Node 24.18.1 이상인 24 계열, 실행 가능한 npm. `.nvmrc`는 24.21.0 |
| Runtime Python | uv가 Python 3.14를 찾고 해당 실행 파일이 동작함 |
| helper Python | 현재 `python3`에서 boto3와 requests import 성공 |
| AgentCore | **npm 패키지 `@aws/agentcore` 0.28.1**. Python starter toolkit과 다름 |
| 개발 도구 | uv, AWS CLI와 선택한 AI CLI 하나 |

Node 20이나 Python 3.9만 있는 환경은 이 상태로 본 실습을 진행할 수 없습니다.
진행자가 [전용 도구 설치](../reference/facilitator.md)를 마친 뒤 같은 활성화와 검사를 반복합니다.
시스템 Node/Python, 전역 npm, Claude 로그인 파일과 셸 시작 파일은 교체하지 않습니다.

Docker는 05장 이후의 컨테이너 실습에서 사용합니다.
기존 `lab.py doctor`는 Docker와 cfn-lint도 요구하는 **심화 과정용**입니다.
본 실습은 위의 `core.py doctor`를 사용합니다.

## 새 터미널을 열었을 때

새 Bash마다 위의 `source .../activate.sh`와 사전검사를 다시 실행합니다.
활성화는 원본 저장소로 이동하고 참가자 경로와 전용 도구 PATH를 복원합니다.
`ATLAS_CLI`가 비어 있어도 `cd "$ATLAS_CLI"`가 성공할 수 있으므로
변수를 수동으로 추측하거나 빈 경로에서 AI CLI를 시작하지 않습니다.
[도구별 실행 방법](../reference/ai-cli-environments.md)을 따릅니다.

프롬프트: [환경 확인](../prompts/01-setup.md)

다음: [02. 계정과 작업 폴더](02-aws-environment.md)
