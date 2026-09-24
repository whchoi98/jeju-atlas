# 03. Agentic AI 코딩 어시스턴트로 제주 가이드 구현

이 장은 30분입니다.\
준비된 참가자 폴더에서 Agentic AI 코딩 어시스턴트 하나를 열고 [구현 프롬프트](../prompts/03-codex.md)를 한 번 전달합니다.\
AI가 AgentCore 프로젝트 생성, 제주 검색 도구 구현과 필요한 의존성 준비를 이어서 수행합니다.

## 선택한 Agentic AI 코딩 어시스턴트 실행

01장의 활성화가 적용된 Bash에서 **선택한 명령 하나만** 실행합니다.\
시작 위치는 `$ATLAS_CLI_PARENT`입니다.\
그 아래의 프로젝트는 AI가 생성하므로 아직 `$ATLAS_CLI` 폴더가 없어도 됩니다.

Codex는 workspace-write와 on-request를 유지하면서 auto-review를 권장합니다.

```bash
cd -- "${ATLAS_CLI_PARENT:?먼저 01장의 activate.sh를 source하세요}" && {
codex -C "$ATLAS_CLI_PARENT" --sandbox workspace-write -a on-request \
  -c 'approvals_reviewer="auto_review"'
}
```
Claude Code는 진행자가 검증한 코딩 모델 설정에서 auto mode를 권장합니다.

```bash
cd "$ATLAS_CLI_PARENT" && claude --permission-mode auto
```

Kiro CLI를 선택했다면 다음으로 시작합니다.

```bash
cd "$ATLAS_CLI_PARENT" && kiro-cli chat
```

자동 검토 모드는 설치 버전, 요금제, 모델과 provider 조합으로 수업 전에 검증합니다.\
지원되지 않으면 해당 도구의 일반 승인 모드로 진행하고 그 상태를 기록합니다.\
수업 중 모델이나 provider를 자동 변경하거나 권한 검사를 우회하지 않습니다.

자세한 안내는 [Agentic AI 코딩 어시스턴트 환경](../reference/ai-cli-environments.md)에 있습니다.\
JejuGuide의 Bedrock 모델 설정과 Agentic AI 코딩 어시스턴트의 모델 설정은 별개입니다.\
기존 로그인은 유지하며 긴 설정 변경이나 HUD 설치는 이 장에 넣지 않습니다.

## 구현 프롬프트 한 번 전달

아래에 표시되는 [구현 카드](../prompts/03-codex.md)를 AI 대화창에 붙여넣습니다.\
키는 전달하지 않습니다.\
AI는 설치 스킬과 저장소 지침을 읽고, 준비된 경로와 참가자 설정을 찾아 다음 작업을 수행합니다.

| AI가 할 일 | 참가자가 확인할 결과 |
|---|---|
| EC2 신원과 참가자 범위 확인 | 실제 계정, 서울 배포 대상과 프로젝트 경로 |
| AgentCore CLI로 생성 | `JejuGuide`, Strands, Bedrock, Python 3.12 CodeZip |
| 137개 원본 샘플 복사 | 기존 파일이 있으면 비교하고 변경 보존 |
| 이름과 카테고리 검색 구현 | 정확한 이름 우선, 최대 5개, 빈 입력 검증 |
| 한국어 응답 규칙 연결 | 도구 결과와 시드 출처만 사용, 없는 정보는 미확인 |
| 배포 설정 확인 | `agentcore validate`의 설정 결과, 변경 파일과 남은 문제 |

프로젝트 생성에는 `agentcore create --framework Strands --model-provider Bedrock`을 사용하며 전체 옵션은 프롬프트에 들어 있습니다.\
이미 생성된 프로젝트에서는 `create`를 반복하지 않습니다.

Memory는 `none`, 네트워크 모드는 `PUBLIC`, Runtime 호출 인증은 IAM입니다.\
PUBLIC은 익명 호출을 허용한다는 뜻이 아닙니다.

모델 설정은 `model_config.py --project "$ATLAS_CLI" --env-file "$ATLAS_CLI_PARENT/.env"`로 적용합니다.\
helper가 키를 노출하지 않고 생성된 로더와 Python 3.12 설정을 준비합니다.

모델은 `global.anthropic.claude-sonnet-4-6`을 사용합니다.\
별도 테스트 작성과 종합 검증은 기본 경로에서 생략합니다.

## 구현 결과 확인

AI가 알려 준 변경 파일을 VSCode에서 확인합니다.\
`app/JejuGuide/`의 검색 도구, 모델 로더, `agentcore/aws-targets.json`이 주요 확인 위치입니다.\
최초 의존성 설치 후에는 잠금 파일을 보존합니다.

검색 로직에 오류가 있거나 동작을 바꾼 경우에만 해당 입력의 테스트를 추가합니다.\
문제가 없으면 테스트 작성, 전체 테스트 실행과 별도 검증 프롬프트를 건너뛰고 배포로 이동합니다.\
생략한 검사를 통과했다고 기록하지 않습니다.

제공된 137건의 `source=sample`을 유지하고 영업시간이나 좌표를 새로 추측하지 않습니다.\
생성된 세션별 Agent와 스트리밍 진입점도 유지합니다.

결과는 `$ATLAS_CLI_PARENT/RESULTS.md`에 기록합니다.\
설명만 받고 끝내지 않고 변경 파일과 필요한 설정 결과를 확인한 뒤 같은 AI 대화에서 04장의 배포 프롬프트로 이어갑니다.\
설치 오류가 남으면 [사전 구성](../reference/preconfiguration.md)의 해당 항목부터 재개합니다.

필수 프롬프트 1: [제주 가이드 구현](../prompts/03-codex.md)

다음: [04. AgentCore CLI로 실행하고 배포하기](04-agentcore-cli.md)
