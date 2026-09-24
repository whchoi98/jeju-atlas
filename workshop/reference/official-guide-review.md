# AgentCore CLI 명령과 공식 문서

본 실습은 npm 패키지 `@aws/agentcore` 0.28.1의 코드 기반 Strands 흐름을 사용합니다.\
기본 create 동작에 의존하지 않고 framework, model-provider, language와 build를 지정합니다.

2026-09-24 개편은 Node 24와 Python 3.12를 사용합니다.\
0.28.1 생성 기본값은 Python 3.14이므로 `model_config.py --env-file ...`이 Runtime, `.python-version`과 pyproject의 Python 조건을 3.12로 맞춥니다.

CLI 스키마의 `PYTHON_3_12`를 확인했습니다.\
아래 날짜가 있는 생성 기록은 당시 결과를 그대로 보존합니다.

0.28.1의 CLI/CDK CodeZip 빌더는 `uv pip install -r pyproject.toml`을 사용하며 `uv.lock`을 직접 읽지 않습니다.\
04장 프롬프트는 `uv export --locked`로 제약을 내보내고 계획과 배포에 `UV_CONSTRAINT`를 전달합니다.

로컬 uv 0.10.9에서 같은 설치 인자로 잠금 버전이 적용되는 것을 확인했습니다.\
이 확인은 실제 Runtime 배포나 모델 호출 검증을 대신하지 않습니다.

기본 모델 인증은 [비공개 .env와 Bedrock 단기키](keys-and-integrations.md)입니다.\
원격에서는 키 원문 대신 SSM ARN과 읽기 정책을 연결하며 AWS 배포 인증은 IAM입니다.\
Claude Code는 [현재 Agentic AI 코딩 어시스턴트 안내](ai-cli-environments.md)의 `--permission-mode auto`를 사용하고 지원되는 코딩 모델은 진행자가 확인합니다.

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

2026-09-12 로컬 점검에서 0.28.1의 create와 deploy 도움말을 읽고, Strands/Bedrock/CodeZip 프로젝트를 의존성 설치 없이 생성했습니다.\
생성된 경로는 `app/JejuGuide/`이며 Runtime은 `PYTHON_3_14`, HTTP입니다.

이 점검은 실제 AWS 배포나 모델 호출 결과가 아닙니다.\
[검증 기록](../VALIDATION.md)에서 확인 범위를 구분합니다.

예전의 모델 없는 Warmup 번들은 `workshop/cli/`에 참고용으로 남아 있습니다.\
03~04장의 기본 과정을 그 번들로 대체하지 않습니다.\
05장 이후 Atlas의 Guide, Tools, Gateway와 Memory는 별도 심화 배포입니다.

## 공식 문서

- [Amazon AgentCore CLI 저장소](https://github.com/aws/agentcore-cli)
- [Runtime CLI 시작 가이드](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-cli.html)
- [Strands SDK](https://strandsagents.com/latest/documentation/docs/)
- [Codex CLI](https://developers.openai.com/codex/cli/)
- [Kiro CLI](https://kiro.dev/docs/cli/)
- [Claude Code](https://code.claude.com/docs/en/overview)

공식 문서는 계속 갱신됩니다.\
수업 중 새 버전으로 바꾸기보다, 진행자가 검증한 버전의 `agentcore <명령> --help`와 생성 파일을 기준으로 진행합니다.\
CLI 설치, 로컬 테스트, 배포 상태와 실제 응답 성공은 각각 확인해야 합니다.

## Sonnet 4.6과 세 리전 구분

2026-09-15 공식 문서를 대조했습니다.\
당시 Runtime 모델은 `global.anthropic.claude-sonnet-4-6`이며 Claude Code 실행에도 Sonnet 4.6을 명시했습니다.\
Runtime 고정은 유지하고 현재 코딩 CLI의 auto 모드와 모델 조건은 위 개편 안내를 따릅니다.

| 구분 | 의미와 워크숍 처리 |
|---|---|
| 배포 리전 | AgentCore Runtime과 참가자 스택의 위치. `aws-targets.json`과 `ATLAS_REGION`은 서울 유지 |
| Bedrock 호출 리전 | SDK가 요청하는 Bedrock Runtime endpoint. 주최자가 확인한 `ATLAS_BEDROCK_REGION`을 명시 |
| 실제 추론 목적지 | Global 추론 프로필이 선택하는 처리 위치. 호출 리전과 같다고 가정하지 않음 |

Boto3는 클라이언트에 지정한 `region_name`으로 해당 서비스 endpoint를 선택합니다.\
따라서 코드에서 Bedrock 클라이언트만 다른 허용 리전을 사용하도록 구성할 수 있습니다.\
이는 권한 부여나 모델 가용성 확인이 아니며, Runtime 배포 리전을 자동으로 바꾸지 않습니다.

Global 추론 프로필에는 별도의 목적지 및 SCP 조건이 적용되므로 주최자가 정책을 검토해야 합니다.\
이 교재는 IAM/SCP 변경 명령이나 다른 리전 순회 호출을 제공하지 않습니다.

Converse에도 `bedrock:InvokeModel` 권한이 필요합니다.\
참가자의 실제 서울 호출에서 확인된 AccessDeniedException과 SCP 명시적 거부는 실패입니다.

이 결과로 특정 다른 리전이 성공한다고 결론 내릴 수 없습니다.\
`model_check.py`는 명시한 리전에서 작은 실제 요청을 한 번만 수행하고 결과를 기록합니다.

- [Bedrock cross-Region inference](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html)
- [Inference profile prerequisites](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html)
- [Converse API와 권한](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html)
- [Boto3 Session/client region_name](https://boto3.amazonaws.com/v1/documentation/api/latest/reference/core/session.html)
- [Claude Code 모델 고정](https://code.claude.com/docs/en/model-config)
