# Agentic AI 코딩 어시스턴트 사용 안내

Codex, Claude Code, Kiro CLI 중 **사전에 준비한 하나**를 Agentic AI 코딩 어시스턴트로 사용합니다.\
선택한 어시스턴트에서 같은 구현과 배포 프롬프트를 수행합니다.

CLI 전환이나 로그인 설정 자체를 본 실습 과제로 만들지 않습니다.\
AgentCore CLI는 프로젝트 생성, 실행, 배포와 호출을 맡습니다.

## 같은 Bash에서 활성화하고 시작

01장에서 출력한 본인의 절대 `activationPath`를 불러옵니다.\
명령은 EC2 VSCode Server의 Bash에, 프롬프트는 AI 대화창에 붙여 넣습니다.\
AI가 실행한 `export`나 `cd`는 사용자의 다른 터미널을 바꾸지 않습니다.

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
source /home/ec2-user/my-project/jeju-atlas/workshop/.local/labs/team01/activate.sh
python3 -B "$ATLAS_REPO/workshop/scripts/core.py" doctor --assistant "$ATLAS_ASSISTANT"
}
```
첫 시작은 `$ATLAS_CLI_PARENT`입니다.\
아직 없는 `$ATLAS_CLI`로 이동하지 않습니다.\
구현 프롬프트가 그 아래에 실제 AgentCore 프로젝트를 만들고 이어서 작업합니다.

### Codex: auto-review와 on-request

```bash
cd -- "${ATLAS_CLI_PARENT:?먼저 01장의 activate.sh를 source하세요}" && {
codex -C "${ATLAS_CLI_PARENT:?}" --sandbox workspace-write -a on-request -c 'approvals_reviewer="auto_review"'
}
```
`on-request`는 승인 요청 시점을, `auto_review`는 해당 요청의 검토자를 정합니다.\
샌드박스와 조직 정책은 계속 적용됩니다.

시작 후 `/status`와 설정에서 실제 적용을 확인합니다.\
관리 설정이 금지하거나 설치 버전이 지원하지 않으면 진행자가 수업 전에 호환 상태를 맞추며, 자동 검토 거부를 성공으로 기록하지 않습니다.

이 명령은 사용자 설정 파일 전체를 덮어쓰지 않고 이번 실행의 값을 지정합니다.\
제공된 환경이 Bedrock provider를 쓸 때만 [Codex Bedrock 설정](codex-bedrock.md)을 사전에 적용합니다.\
이 가이드의 별도 provider와 모델을 모든 참가자에게 강제하지 않습니다.

### Claude Code: auto mode

```bash
cd -- "${ATLAS_CLI_PARENT:?}" && {
claude --permission-mode auto
}
```
진행자가 확인한 코딩 모델과 로그인을 그대로 사용하고, 화면의 권한 모드가 **Auto**인지 확인합니다.\
세션 모델은 JejuGuide Runtime의 Sonnet 4.6과 별개입니다.

2026-09-24 공식 문서 기준으로 auto 지원 모델은 provider마다 다릅니다.\
Anthropic API의 Sonnet 4.6을 지원하더라도 Bedrock 연결에서 같은 조합을 지원한다는 뜻은 아닙니다.\
진행자가 사용하는 provider, 모델과 조직 설정에서 실제로 확인합니다.

지원되지 않으면 Manual로 시작할 수 있으므로 auto 적용으로 표시하지 않습니다.\
모델 변경이 필요한 환경은 수업 전에 준비하고, 수업 중에는 배정된 도구의 일반 승인 흐름으로 진행한 사실을 기록합니다.\
권한 검사를 모두 끄는 옵션을 대체 명령으로 쓰지 않습니다.

#### ultracode를 유지하는 경우

Claude Code에서 이미 `ultracode`를 사용 중이라면 현재 설정을 유지합니다.\
03~08장 요청 끝에는 다음 Claude Code용 문구가 포함되어 있습니다.

```text
Claude Code 요청: 검증 워크플로 없이 진행
```

별도 검증 에이전트나 전체 검증 워크플로를 추가하지 않도록 요청하는 문구입니다.\
교재와 배포 명령에 필요한 검사, 해당 장의 스택 완료와 응답 확인은 유지합니다.
오류가 생기면 관련 부분만 확인하고, 생략한 검사를 통과로 기록하지 않습니다.

`ultracode`는 검증을 포함한 여러 워크플로를 구성할 수 있으므로 요청 범위를 명확히 적습니다.\
위 문구는 CLI 설정을 끄는 명령이 아니며, 새로운 세션에 `ultracode`를 켜도록 요구하지 않습니다.
자세한 동작은 [Claude Code 워크플로 안내](https://code.claude.com/docs/en/workflows#let-claude-decide-with-ultracode)를 참고합니다.

### Kiro CLI

```bash
cd -- "${ATLAS_CLI_PARENT:?}" && {
kiro-cli chat
}
```
준비된 로그인과 모델, 기존 도구 권한을 사용합니다.\
교재의 Kiro 탭은 같은 프롬프트를 복사하는 선택이며 CLI 설정을 변경하지 않습니다.

## 프롬프트 두 개로 이어 가기

1. [03장 구현 프롬프트](../prompts/03-codex.md): 기존 소스와 참가자 환경을 확인하고 프로젝트와 검색 도구를 구현합니다.
2. [04장 배포 프롬프트](../prompts/04-agentcore-cli.md): 명시한 참가자 범위에서 키 게시, 모델 호출, 배포와 실제 응답을 확인합니다.

AI는 저장소의 `skills/jeju-atlas-install/SKILL.md`를 읽고 기존 작업을 재사용합니다.\
설치 경로를 다시 묻거나 같은 프로젝트를 `create`하지 않습니다.

키는 사용자의 별도 Bash에서 `workshop_env.py configure`로 입력하고, AI는 상태만 조회하거나 helper로 사용합니다.\
`.env`를 읽어 대화에 출력하도록 요청하지 않습니다.

프로젝트 지침은 Codex의 `AGENTS.md`, Claude Code의 `CLAUDE.md`에서 참조하는 `AGENTS.md`, Kiro의 `.kiro/steering/workshop.md`에 같은 작업 범위를 적습니다.\
기존 지침과 사용자 변경을 먼저 읽고 보존합니다.\
자동 권한 모드에서도 어떤 계정과 프로젝트의 배포를 요청하는지 프롬프트에 명시합니다.

## 재개와 도구 전환

새 Bash마다 활성화를 반복합니다.\
프로젝트를 이미 생성했다면 다음 위치에서 선택한 CLI를 다시 시작할 수 있습니다.

```bash
cd -- "${ATLAS_CLI:?먼저 01장의 activate.sh를 source하세요}" && {
test -f "${ATLAS_CLI:?}/agentcore/agentcore.json" && cd -- "$ATLAS_CLI"
}
```
Codex에서는 같은 옵션으로 `-C "$ATLAS_CLI"`를 사용합니다.\
다른 도구로 바꾸면 현재 세션을 종료하고 같은 프로젝트와 `RESULTS.md`를 이어서 읽습니다.

동시에 여러 CLI가 같은 파일을 수정하지 않습니다.\
다른 CLI를 점검할 때는 `core.py doctor --assistant codex|claude|kiro` 중 실제 값 하나를 사용합니다.

05장 이후 앱은 `ATLAS_APP="$ATLAS_REPO/workshop/.local/labs/$ATLAS_TEAM/app"`입니다.\
기본 CLI 프로젝트와 앱 사본을 구분하고, 앱 URL은 `lab.py url`로 실제 스택에서 조회합니다.\
HUD는 [선택 설치 가이드](hud-setup.md)를 따르며 누락 때문에 본 실습을 지연하지 않습니다.
Claude Code의 HUD, `aws-core`, `aws-agents`와 기타 플러그인은
[사전 구성의 선택 설치](preconfiguration.md#선택-claude-code-hud와-플러그인)에서 준비합니다.

## 공식 자료

- [Codex 설정: approval_policy와 approvals_reviewer](https://developers.openai.com/codex/config-reference/)
- [Codex CLI](https://developers.openai.com/codex/cli/)
- [Claude Code permission modes](https://code.claude.com/docs/en/permission-modes)
- [Claude Code CLI flags](https://code.claude.com/docs/en/cli-reference)
- [Kiro CLI](https://kiro.dev/docs/cli/)

2026-09-24 공식 문서로 명령과 권한 모드 조건을 대조했습니다.\
도구 버전 출력만으로 로그인, auto 모드 적용과 실제 모델 호출까지 검증되지는 않습니다.
