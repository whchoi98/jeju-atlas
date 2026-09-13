# AgentCore CLI 명령과 공식 문서

본 실습은 npm 패키지 `@aws/agentcore` 0.28.1의 코드 기반 Strands 흐름을 사용합니다.
기본 create 동작에 의존하지 않고 framework, model-provider, language와 build를 지정합니다.

## 이 교재에서 확인한 명령

| 명령 | 사용하는 목적 |
|---|---|
| `agentcore create --framework Strands --model-provider Bedrock` | 실제 모델을 호출하는 Python 프로젝트 생성 |
| `agentcore validate --json` | 프로젝트와 배포 대상 설정 검사 |
| `agentcore dev --skip-deploy` | AWS 자동 배포 없이 로컬 실행 |
| `agentcore dev "질문" --runtime JejuGuide --port 8080` | 로컬 서버 호출 |
| `agentcore deploy --target default --dry-run` | 배포 전 변경 내용 확인 |
| `agentcore deploy --target default` | 참가자 Runtime 배포 |
| `agentcore invoke "질문" --runtime JejuGuide --target default --json` | 배포한 Runtime 호출 |
| `agentcore status`와 `agentcore logs` | 상태와 오류 원인 확인 |
| `agentcore remove agent --name JejuGuide` | 로컬 정의 제거. 이후 deploy로 AWS 변경 적용 |

2026-09-12 로컬 점검에서 0.28.1의 create와 deploy 도움말을 읽고,
Strands/Bedrock/CodeZip 프로젝트를 의존성 설치 없이 생성했습니다.
생성된 경로는 `app/JejuGuide/`이며 Runtime은 `PYTHON_3_14`, HTTP입니다.
이 점검은 실제 AWS 배포나 모델 호출 결과가 아닙니다.
[검증 기록](../VALIDATION.md)에서 확인 범위를 구분합니다.

예전의 모델 없는 Warmup 번들은 `workshop/cli/`에 참고용으로 남아 있습니다.
03~04장의 기본 과정을 그 번들로 대체하지 않습니다.
05장 이후 Atlas의 Guide, Tools, Gateway와 Memory는 별도 심화 배포입니다.

## 공식 문서

- [Amazon AgentCore CLI 저장소](https://github.com/aws/agentcore-cli)
- [Runtime CLI 시작 가이드](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-cli.html)
- [Strands SDK](https://strandsagents.com/latest/documentation/docs/)
- [Codex CLI](https://developers.openai.com/codex/cli/)
- [Kiro CLI](https://kiro.dev/docs/cli/)
- [Claude Code](https://code.claude.com/docs/en/overview)

공식 문서는 계속 갱신됩니다. 수업 중 새 버전으로 바꾸기보다,
진행자가 검증한 버전의 `agentcore <명령> --help`와 생성 파일을 기준으로 진행합니다.
CLI 설치, 로컬 테스트, 배포 상태와 실제 응답 성공은 각각 확인해야 합니다.
