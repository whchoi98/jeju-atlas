# Codex, Kiro CLI, Claude Code 사용 안내

Codex, Kiro CLI, Claude Code 중 EC2에 준비된 도구 하나로 같은 구현 과제를 수행합니다.
선택한 도구의 설치와 로그인 상태를 확인하고 기존 인증을 사용합니다.
세 도구를 차례로 실행해야 하는 과제가 아닙니다.

## Bash와 AI 대화창 구분

교재의 터미널 박스는 VSCode Server의 별도 **Bash 터미널**에서 실행합니다.
프롬프트 카드는 Claude 등의 대화 입력창에 붙여넣습니다.
AI가 Bash 도구에서 실행한 `cd`나 `export`는 사용자의 다른 터미널을 바꾸지 않습니다.
브라우저의 교재에서 Claude 버튼을 선택해도 EC2의 CLI나 모델 설정이 바뀌지는 않습니다.

기존 `/home/ec2-user/claude-lab`에서 작업 중인 Claude는 그대로 두고
새 VSCode Bash 터미널을 엽니다. 이 Bash에서 환경을 불러오고 새 CLI를 실행합니다.
같은 파일을 두 세션에서 동시에 수정하지 않습니다.

## 새 터미널에서 복원하고 Claude 열기

먼저 01장에서 출력한 **본인의 절대 경로** `activationPath`를 사용합니다.
경로와 `team01`은 실제 준비 결과에 맞게 바꿉니다.

```bash
source /home/ec2-user/my-project/jeju-atlas/workshop/.local/labs/team01/activate.sh &&
python3 -B "$ATLAS_REPO/workshop/scripts/core.py" doctor --assistant "$ATLAS_ASSISTANT"
```

사전검사가 통과하고 03장에서 프로젝트를 생성한 뒤 다음을 실행합니다.

```bash
test -f "${ATLAS_CLI:?activate.sh를 먼저 source하세요}/agentcore/agentcore.json" &&
cd -- "$ATLAS_CLI" &&
claude --model claude-sonnet-4-6
```

이 순서로 열어야 Claude가 같은 PATH, Python, 참가자 변수와 CLI 설정을 상속합니다.
Claude 안에서 현재 폴더의 `agentcore/agentcore.json`을 읽는지 확인합니다.
`ATLAS_CLI`가 빈 상태의 `cd "$ATLAS_CLI"`는 성공하면서 원래 폴더에 남을 수 있습니다.
기존 프로젝트에 머문 채 실습을 시작하지 않습니다.

| 선택한 도구 | 실행 명령 | 프로젝트 지침 |
|---|---|---|
| Codex | `codex -C "$ATLAS_CLI" --sandbox workspace-write -a on-request` | `AGENTS.md` |
| Kiro CLI | `$ATLAS_CLI`에서 `kiro-cli chat` | `.kiro/steering/workshop.md` |
| Claude Code | `$ATLAS_CLI`에서 `claude --model claude-sonnet-4-6` | `CLAUDE.md` |

도구를 바꾸려면 현재 도구를 종료한 뒤 같은 프로젝트에서 다음 도구를 실행합니다.
별도 프로젝트를 새로 생성하거나 동시에 같은 파일을 수정하지 않습니다.
처음 선택은 `core.py prepare --assistant claude|codex|kiro`에 저장됩니다.
다른 도구를 잠시 사용하려면 활성화 후 Bash에서 `export ATLAS_ASSISTANT=codex`
같이 선택을 바꾸고 사전검사를 반복합니다. 새 Bash에서는 저장한 선택이 복원됩니다.

05장 이후 심화 앱을 편집할 때는 활성화 후 Bash에서 다음 경로도 복원합니다.
AWS 작업은 계속 원본 저장소의 lab.py와 본인 설정을 사용합니다.

```bash
export ATLAS_APP="${ATLAS_REPO:?}/workshop/.local/labs/${ATLAS_TEAM:?}/app"
```

접속 주소는 `lab.py url --config "$ATLAS_CONFIG"`가 실제 App 스택에서 조회합니다.
AI가 사용자 도메인이나 인증서 발급을 새 실습 단계로 추가하지 않도록 합니다.

## 공통 과제 전달

[03장 프롬프트](../prompts/03-codex.md)를 그대로 전달합니다.
기대 결과는 Strands 기반 제주 검색 도구, 응답 규칙과 테스트입니다.
명령 실행 전에는 현재 폴더와 AWS 대상이 맞는지 확인합니다.
코딩 도구의 답변에서 실제 변경 파일과 검사 결과를 확인하고 다음 단계로 갑니다.

`AGENTS.md`에는 작업 폴더, 참가자 이름, 계정과 리전, 수정할 파일과 검사 방법을 적습니다.
Claude Code의 `CLAUDE.md`에는 `@AGENTS.md`를 넣어 공통 지침을 참조합니다.
Kiro의 steering 파일에도 같은 작업 경계를 적습니다.
프로젝트가 생성한 기본 지침을 지우기 전에 실제 내용을 읽습니다.
Claude Code는 특정 모델 ID `claude-sonnet-4-6`을 사용합니다.
`sonnet` 별칭은 이후 다른 모델을 가리킬 수 있으므로 이 워크숍 명령에 사용하지 않습니다.
이 설정을 Codex나 Kiro CLI의 모델 설정에 복사하지 않습니다.

## 인증과 권한

AI CLI의 로그인은 진행자가 수업 전에 확인합니다.
로그인되지 않았다면 해당 도구의 공식 절차로 본인에게 배정된 계정을 사용합니다.
인증 파일을 다른 사용자에게 복사하거나 키를 프롬프트에 넣지 않습니다.

Claude Code의 대화와 읽기 전용 Bash 도구가 동작해도 실습 도구가 준비됐다는 뜻은 아닙니다.
`core.py doctor`는 선택한 CLI의 버전만 검사하며 로그인과 실제 모델 호출을 검사하지 않습니다.
코딩 도구가 사용하는 모델과 배포된 제주 가이드의 Bedrock 모델은 다릅니다.
이 과제는 코딩 도구의 provider나 모델을 바꾸라는 요청이 아닙니다.
Bedrock 호출은 현재 EC2의 실습 역할과 배포 Runtime의 실행 역할로 확인합니다.
Bedrock 모델 ID는 `global.anthropic.claude-sonnet-4-6`이며 Claude Code의 모델 ID와
구분합니다. `model_check.py --execute`는 실제 호출이고 `core.py doctor`는 로컬 검사입니다.

## 오류를 수정할 때

전체 작업을 다시 요청하기보다 실패한 명령, 오류 메시지, 관련 파일을 전달합니다.
예를 들어 “검색 결과가 없을 때 테스트가 실패합니다. 이 함수와 테스트만 확인해 주세요”라고 요청합니다.
프로젝트 밖의 파일 변경, 다른 계정 사용, 실패를 성공으로 표시하는 우회는 하지 않습니다.

## 공식 문서

- [Codex CLI](https://developers.openai.com/codex/cli/)
- [Codex 프로젝트 지침](https://developers.openai.com/codex/guides/agents-md/)
- [Kiro CLI](https://kiro.dev/docs/cli/)
- [Claude Code](https://code.claude.com/docs/en/overview)

명령이 교재와 다르면 설치 버전의 도움말을 확인합니다.
업데이트와 재인증이 필요한 경우에는 진행자가 수업 전에 조정합니다.
