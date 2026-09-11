# Codex · Kiro CLI · Claude Code 환경

기본 시작점은 **Codex가 설치된 EC2**입니다. Kiro CLI 또는 Claude Code를 추가로 선택해
같은 실습을 진행할 수 있습니다. 교재는 PC에서 읽고 명령·AI CLI는 EC2에서 실행합니다.
개발 도구를 바꾸어도 배포 대상은 그 EC2의 계정·VPC와 기존 참가자 이름입니다.

## 공통 경계

| 항목 | 세 도구가 함께 지키는 내용 |
|---|---|
| 실행 폴더 | 실제 Atlas는 `$ATLAS_APP`, CLI 입문은 `$ATLAS_CLI` |
| AWS 대상 | `init-ec2`로 확인한 EC2 계정·primary VPC |
| 배포 명령 | 같은 `lab.py`와 기존 AgentCore CLI |
| 데이터·모델 | 샘플 provenance와 실제 Atlas Sol/Astra 설정 유지 |
| 지침 | `AGENTS.md`, `CLAUDE.md`, `.kiro/steering/workshop.md` |
| 키 | 도구 대화에 넣지 않고 본인 터미널의 숨김 입력 사용 |

한 폴더의 같은 파일을 여러 AI CLI가 동시에 수정하지 않습니다.
도구를 전환할 때 이전 작업을 마치고 `git status`와 변경 내용을 확인합니다.
지침 파일은 작업 안내이며 IAM 권한 경계를 대신하지 않습니다.

## 설치·인증 상태 확인

이미 설치된 도구는 재설치하거나 인증을 교체하지 않습니다.

```bash
codex --version
codex login status

kiro-cli --version
kiro-cli whoami

claude --version
claude auth status
```

사용할 도구의 명령만 확인해도 됩니다. `whoami`나 인증 상태에 사용자 식별 정보가 포함되면
그 출력을 그대로 교재·Git·대화에 게시하지 않습니다.
설치 버전 확인은 로그인·모델 호출 성공을 보장하지 않습니다.

이번 환경에서는 Codex CLI 0.136.0, Kiro CLI 2.21.2, Claude Code 2.1.197의
버전과 도움말을 읽기 전용으로 확인했습니다. 로그인·모델 호출은 실행하지 않았습니다.

## Kiro CLI가 없는 경우

EC2 운영체제와 아키텍처가 [Kiro 설치 요건](https://kiro.dev/docs/cli/installation/)을 충족하는지 확인합니다.
설치가 필요한 경우에만 공식 설치기를 사용합니다.

```bash
curl -fsSL https://cli.kiro.dev/install -o /tmp/kiro-cli-install.sh
# 다운로드한 공식 설치기를 확인한 뒤 실행합니다.
bash /tmp/kiro-cli-install.sh
export PATH="$HOME/.local/bin:$PATH"
kiro-cli --version
```

이미 인증되어 있으면 로그인하지 않습니다. 인증이 필요한 경우:

```bash
kiro-cli login
kiro-cli whoami
```

Kiro 계정 로그인과 AWS 배포 권한은 별도입니다.
Kiro 로그인 결과만으로 EC2의 AWS 역할이나 배포 계정이 바뀌지 않습니다.
[Kiro 시작 가이드](https://kiro.dev/docs/cli/getting-started/)를 참고합니다.

## Claude Code가 없는 경우

기존 설치가 없을 때 [공식 설치 문서](https://code.claude.com/docs/en/setup)에 따라 준비합니다.

```bash
curl -fsSL https://claude.ai/install.sh -o /tmp/claude-code-install.sh
# 공식 설치기를 확인한 뒤 실행합니다.
bash /tmp/claude-code-install.sh
claude --version
```

기존 인증이 있으면 그대로 사용합니다. 최초 인증은 `claude`를 실행한 후 제공되는 흐름을 따릅니다.
Codex·Kiro의 인증 파일이나 provider 키를 Claude Code 설정으로 복사하지 않습니다.

### Claude Code를 Bedrock으로 사용하는 선택 경로

AWS 기반 인증을 쓰는 실습에서는 EC2 역할에 **Claude Code용 Anthropic 모델 권한**도 필요합니다.
이는 배포될 제주 가이드의 OpenAI Sol/Astra ID와 다릅니다.
진행자가 허용한 Anthropic model/inference-profile ID를 확인한 후 별도 subshell에서 실행합니다.

```bash
# 진행자가 승인한 Anthropic 모델 ID를 먼저 지정합니다.
read -r -p "Claude Code용 Bedrock 모델 ID: " ATLAS_CLAUDE_MODEL
(
  cd "$ATLAS_APP"
  export CLAUDE_CODE_USE_BEDROCK=1
  export AWS_REGION=ap-northeast-2
  export ANTHROPIC_MODEL="${ATLAS_CLAUDE_MODEL:?모델 ID가 필요합니다}"
  claude
)
```

이 선택 경로의 AWS 호출 계정도 EC2 계정과 같아야 합니다.
다른 계정 profile을 설정하거나 애플리케이션의 `ATLAS_MODEL_FAST/DEEP`를 바꾸지 않습니다.
지원 모델·권한·조직 정책은 [Claude Code Bedrock 문서](https://code.claude.com/docs/en/amazon-bedrock)를 확인합니다.

## 같은 실습 폴더에서 도구 선택

02~03장에서 `$ATLAS_APP`을 준비한 뒤 **한 도구만 선택**합니다.

```bash
# Codex
codex -C "$ATLAS_APP" --sandbox workspace-write -a on-request
```

```bash
# Kiro CLI
cd "$ATLAS_APP"
kiro-cli chat
```

```bash
# Claude Code
cd "$ATLAS_APP"
claude
```

CLI 입문 실습에서는 위 폴더를 `$ATLAS_CLI`로 바꿉니다.
Kiro의 trust-all-tools나 승인·sandbox 우회 옵션을 공통 설치 방법으로 사용하지 않습니다.

새로 준비한 앱·CLI 프로젝트에는 세 도구의 로컬 지침이 포함됩니다.
Claude Code는 `CLAUDE.md`의 `@AGENTS.md`를 읽고,
Kiro는 `.kiro/steering/workshop.md`의 항상 적용되는 지침을 읽습니다.
기존 작업 공간이 있다면 덮어쓰지 말고 지침 파일만 검토하여 추가합니다.

근거: [Kiro setup/steering](https://kiro.dev/docs/cli/setup/),
[Claude Code 메모리·프로젝트 지침](https://code.claude.com/docs/en/memory).

## 선택한 도구로 환경 검사

```bash
cd "$ATLAS_REPO"
python3 workshop/scripts/lab.py doctor --assistant codex --config "$ATLAS_CONFIG"
python3 workshop/scripts/lab.py doctor --assistant kiro --config "$ATLAS_CONFIG"
python3 workshop/scripts/lab.py doctor --assistant claude --config "$ATLAS_CONFIG"
```

사용할 환경의 한 명령을 실행합니다. 다른 두 AI CLI가 설치되어 있어야 할 필요는 없습니다.
공통 AWS 도구·Node·Python·Docker·AgentCore CLI 요구 사항은 같습니다.
`--aws`를 추가하면 EC2 바인딩과 기존 네트워크도 읽기 전용으로 확인합니다.

HTML 챕터 아래의 **AI CLI 프롬프트 카드 전체**를 선택한 도구에 전달합니다.
세 도구 모두 같은 변경 계획·실행 결과를 기록하고, 로컬 검사와 실제 배포를 구분합니다.
