# AgentCore CLI 역할과 실행 흐름

03장과 04장에서 수행한 작업을 이해하기 위한 학습 참고입니다.\
이 랩은 npm `@aws/agentcore` 0.28.1로 프로젝트를 생성하고 AWS에 배포한 뒤 원격으로 호출합니다.\
이미 완료한 명령을 복습 목적으로 다시 실행할 필요는 없습니다.

## 누가 어떤 일을 하는가

| 구성 요소 | 이 랩에서 맡는 역할 |
|---|---|
| 참가자 | 구현 목표와 작업 범위를 전달하고 키를 비공개로 입력하며 결과를 확인 |
| Agentic AI 코딩 어시스턴트 | Codex, Claude Code, Kiro CLI 중 하나로 검색 코드를 작성하고 필요한 명령 실행 |
| AgentCore CLI | 프로젝트 생성, 설정 확인, 배포 준비, AWS 배포, Runtime 상태 조회와 호출 |
| AgentCore Runtime | 배포된 `JejuGuide` 코드를 AWS에서 실행하고 요청 처리 |
| Amazon Bedrock | `JejuGuide`가 요청한 모델 추론 수행 |

참가자가 전달하는 03장 구현 프롬프트와 04장 배포 프롬프트 안에 AgentCore CLI 명령이 들어 있습니다.\
코딩 어시스턴트는 프롬프트에 따라 코드를 수정하고 `agentcore` 명령을 실행합니다.\
터미널에 Python 보조 스크립트와 CDK 로그가 함께 보여도 프로젝트 생성과 Runtime 배포의 중심 명령은 AgentCore CLI입니다.

## 04장까지 이어지는 핵심 흐름

**프로젝트 생성 → 검색 코드 구현 → 설정 확인 → 배포 준비 확인 → AWS 배포 → 상태 조회 → 원격 호출**

| 단계 | 실제 명령 | 역할과 결과 해석 |
|---|---|---|
| 03장 생성 | `agentcore create` | Strands, Bedrock, Python, CodeZip 옵션으로 로컬 프로젝트를 생성합니다. AWS Runtime 배포는 이후 단계입니다. |
| 03장과 04장 설정 | `agentcore validate --json` | 설정 형식과 스키마를 확인합니다. 검색 결과나 모델 응답의 정확성을 확인한 것은 아닙니다. |
| 04장 배포 준비 | `agentcore deploy --target default --dry-run` | CDK 빌드, CloudFormation 합성과 배포 선행 조건을 확인합니다. 실제 Runtime 배포 완료를 뜻하지 않습니다. |
| 04장 배포 | `agentcore deploy --target default` | 현재 프로젝트의 변경을 지정한 AWS 대상으로 배포합니다. 이어서 Runtime 상태를 확인합니다. |
| 04장 상태 | `agentcore status --target default --runtime JejuGuide --json` | Runtime 상태를 조회합니다. READY는 실행 준비 상태이며 모델 답변 성공과는 별도입니다. |
| 04장 호출 | `agentcore invoke "질문" --runtime JejuGuide --target default --json` | 배포된 Runtime으로 질문을 보냅니다. 완성된 응답, 실제 검색 도구 사용과 자료 출처를 확인합니다. |

`create`의 전체 옵션은 [03장 프롬프트](../prompts/03-codex.md), 배포와 호출의 전체 명령은 [04장 프롬프트](../prompts/04-agentcore-cli.md)에 있습니다.\
기존 프로젝트에서 `create`를 반복하거나 진행 중인 배포를 다시 시작하지 않습니다.

### 배포 명령에 제약 파일을 전달하는 이유

CLI 0.28.1의 CodeZip 빌더는 `uv.lock`을 직접 읽지 않습니다.\
이 랩에서는 `uv export --locked`로 만든 `runtime-constraints.txt`를 `UV_CONSTRAINT`로 계획과 배포 명령에 동일하게 전달합니다.\
이 과정은 잠금 버전을 배포 의존성에 적용하기 위한 준비이며, 실제 배포 명령은 `agentcore deploy`입니다.

## 명령과 연결되는 주요 파일

아래 경로는 참가자 프로젝트인 `$ATLAS_CLI`를 기준으로 합니다.

| 파일 또는 폴더 | 학습할 내용 |
|---|---|
| `app/JejuGuide/` | Runtime에서 실행할 Python 코드, 모델 로더, 검색 도구와 샘플 데이터 |
| `agentcore/agentcore.json` | Runtime 이름, CodeZip, Python 버전, 네트워크와 환경 설정 |
| `agentcore/aws-targets.json` | `default` 배포 대상의 AWS 계정과 리전 |
| `agentcore/cdk/` | CLI가 AWS 배포를 진행할 때 사용하는 CDK 프로젝트 |
| `agentcore/deployed-state.json` | 배포 후 CLI가 기록하는 대상별 자원 상태와 식별 정보 |

검색 로직은 코딩 어시스턴트가 `app/JejuGuide/` 아래에 구현합니다.\
AgentCore CLI는 그 코드와 설정을 바탕으로 배포 작업을 수행합니다.\
참가자의 `.env`는 프로젝트 바깥의 `$ATLAS_CLI_PARENT`에 두며 배포 ZIP에 넣지 않습니다.

## CDK와 보조 스크립트가 함께 보이는 이유

| 도구 | 담당하는 준비 또는 연동 |
|---|---|
| `start.sh`, `core.py` | 실습 폴더, 선택한 도구, Python/Node 경로와 활성화 준비 |
| `lab.py init-ec2 --identity-only` | 현재 EC2와 STS의 계정을 대조하고 참가자 설정 저장 |
| `workshop_env.py configure` | 모델 호출 리전과 단기 또는 장기 Bedrock API 키의 비공개 입력 |
| `workshop_env.py publish --execute` | 소유 SSM 파라미터와 IAM 읽기 정책을 준비하고 Runtime 설정에 ARN 연결 |
| `cdk_bootstrap.py` | 해당 계정과 서울 리전의 CDK 배포 기반을 읽기 전용으로 확인 |
| `cdk bootstrap` | 계정과 리전에 필요한 CDK 자산 저장소와 배포 역할을 처음 준비 |

CDK bootstrap은 Runtime마다 반복하는 단계가 아니라 계정과 리전의 사전 준비입니다.\
준비된 환경에서는 AgentCore CLI가 `agentcore/cdk/`의 CDK 프로젝트를 통해 CloudFormation 배포를 진행합니다.\
공유 VPC와 bootstrap 준비, 참가자 Runtime 배포의 승인 범위를 구분합니다.

**주의할 명령 조합:** CLI 0.28.1은 bootstrap이 필요한 경우 `deploy --dry-run --yes`에서도 bootstrap을 실제로 생성하거나 갱신할 수 있습니다.\
이 랩은 [사전 구성의 CDK 준비](preconfiguration.md#5-cdk-bootstrap-준비)를 먼저 완료하고, 04장에서는 `--yes`를 붙여 bootstrap 오류를 우회하지 않습니다.

## 정상 진행에서는 생략하는 명령

| 명령 | 사용할 때 |
|---|---|
| `agentcore dev` | Runtime 소스나 진입점 오류를 로컬에서 진단할 필요가 있을 때 |
| `agentcore logs` | 원격 호출이 실패해 해당 Runtime의 로그를 확인할 때 |
| `agentcore remove agent` | 참가자가 자원 정리를 요청했을 때. 로컬 정의 제거 후 별도 배포로 AWS 변경 반영 |

기본 과정은 배포 후 예시 응답 한 번까지 확인합니다.\
추가 모델 호출, 전체 테스트와 로컬 실행을 학습 참고를 읽었다는 이유로 반복하지 않습니다.

## 설명할 수 있으면 이해한 내용

- 코딩 어시스턴트가 작성한 코드와 AgentCore CLI가 수행한 배포 작업을 구분할 수 있습니다.
- `create`, `validate`, `deploy`, `status`, `invoke`의 목적과 결과를 설명할 수 있습니다.
- 배포 대상 계정과 리전이 어디에 기록되는지 찾을 수 있습니다.
- `validate` 통과, Runtime READY, 실제 응답 완료를 각각 구분할 수 있습니다.
- Bedrock 모델 호출용 API 키와 AWS 배포 및 Runtime 호출용 IAM 인증을 구분할 수 있습니다.

돌아가기: [03장 구현](../chapters/03-codex.md), [04장 배포와 결과 보기](../chapters/04-agentcore-cli.md)

관련 자료: [CLI 명령과 공식 가이드 대조](official-guide-review.md), [키와 인증 방식](keys-and-integrations.md)
