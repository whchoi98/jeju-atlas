# Codex, Kiro CLI, Claude Code 사용 안내

세 도구는 EC2의 VSCode Server에 설치되어 있습니다.
이번 과정에서는 설치를 반복하지 않고 하나를 골라 같은 구현 과제를 수행합니다.
세 도구를 차례로 실행해야 하는 과제가 아닙니다.

## 실행 위치

03장에서 AgentCore CLI로 생성한 `$ATLAS_CLI` 폴더를 엽니다.
코딩 도구가 현재 위치의 `agentcore/agentcore.json`을 읽는지 먼저 확인합니다.

| 선택한 도구 | 실행 명령 | 프로젝트 지침 |
|---|---|---|
| Codex | `codex -C "$ATLAS_CLI" --sandbox workspace-write -a on-request` | `AGENTS.md` |
| Kiro CLI | `$ATLAS_CLI`에서 `kiro-cli chat` | `.kiro/steering/workshop.md` |
| Claude Code | `$ATLAS_CLI`에서 `claude` | `CLAUDE.md` |

도구를 바꾸려면 현재 도구를 종료한 뒤 같은 프로젝트에서 다음 도구를 실행합니다.
별도 프로젝트를 새로 생성하거나 동시에 같은 파일을 수정하지 않습니다.

## 공통 과제 전달

[03장 프롬프트](../prompts/03-codex.md)를 그대로 전달합니다.
기대 결과는 Strands 기반 제주 검색 도구, 응답 규칙과 테스트입니다.
명령 실행 전에는 현재 폴더와 AWS 대상이 맞는지 확인합니다.
코딩 도구의 답변에서 실제 변경 파일과 검사 결과를 확인하고 다음 단계로 갑니다.

`AGENTS.md`에는 작업 폴더, 참가자 이름, 계정과 리전, 수정할 파일과 검사 방법을 적습니다.
Claude Code의 `CLAUDE.md`는 공통 지침을 참조하도록 작성합니다.
Kiro의 steering 파일에도 같은 작업 경계를 적습니다.
프로젝트가 생성한 기본 지침을 지우기 전에 실제 내용을 읽습니다.

## 인증과 권한

AI CLI의 로그인은 진행자가 수업 전에 확인합니다.
로그인되지 않았다면 해당 도구의 공식 절차로 본인에게 배정된 계정을 사용합니다.
인증 파일을 다른 사용자에게 복사하거나 키를 프롬프트에 넣지 않습니다.

코딩 도구가 사용하는 모델과 배포된 제주 가이드의 Bedrock 모델은 다릅니다.
이 과제는 코딩 도구의 provider나 모델을 바꾸라는 요청이 아닙니다.
Bedrock 호출은 현재 EC2의 실습 역할과 배포 Runtime의 실행 역할로 확인합니다.

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
