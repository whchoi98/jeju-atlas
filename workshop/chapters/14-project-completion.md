# 14. Codex로 프로젝트 완성하기

이 장은 120분 본 실습 이후에 선택하는 심화 자료입니다.\
새 계정의 빈 작업 공간에서 준비를 시작하거나, 앞 장의 코드와 AWS 구성을 이어서 점검합니다.\
결과물은 구성 요소별 구현안, 수정한 코드 또는 IaC, 검사 결과와 다음 작업 기록입니다.

45분은 작업 범위를 정하고 첫 수정과 검사를 진행하는 편성 시간입니다.\
전체 서비스 구현과 AWS 배포에 걸리는 시간은 남은 작업에 따라 별도로 잡습니다.

05~12장을 진행하면서 이 장을 사용할 수 있으며, 원격 자원 정리는 13장으로 돌아갑니다.\
이미 정리한 환경에서는 코드와 로컬 검사를 진행하고 원격 검증은 미실행으로 남깁니다.

## 시작 상태와 작업 위치

기본 시작 유형은 **워크숍 참가자 작업**입니다.\
소스, `team01.json`이나 `ATLAS_*` 변수를 미리 준비하지 않아도 통합 프롬프트를 전달할 수 있습니다.\
프롬프트 안에 원본 저장소 URL과 초기화 순서가 포함되어 있습니다.

유지관리 작업일 때만 목적과 실제 checkout을 따로 명시합니다.\
Node 24, Python 3.12, 보조 패키지와 npm AgentCore CLI 설치는 [사전 구성](../reference/preconfiguration.md)으로 먼저 처리합니다.

빈 환경에서는 프롬프트가 이 단계를 완료하고, 준비된 환경은 재사용합니다.\
전체 앱에는 PyYAML과 cfn-lint도 필요하므로 앱 사본을 만들기 전에 따로 확인합니다.

| 시작 상태 | 프롬프트가 진행할 작업 | 얻는 결과 |
|---|---|---|
| 현재 폴더에 소스 없음 | 쓰기 가능한 새 하위 폴더에 알려진 Git 저장소 clone | 실제 `ATLAS_REPO` |
| 참가자와 설정 없음 | 공통 실습 ID team01 적용, core.py prepare와 활성화 | 참가자 경로, `ATLAS_CONFIG`, `ATLAS_CLI` |
| EC2 계정 설정 없음 | lab.py init-ec2 --identity-only로 IMDSv2와 STS 대조 | 현재 EC2에 묶인 로컬 JSON |
| 전체 앱 사본 없음 | 기존 네트워크 discover, 참가자 prepare와 info | 실제 `ATLAS_APP` |
| 기존 작업 있음 | 소유 바인딩과 준비 단계 확인 후 재사용 | 기존 코드와 설정 보존 |
| 명시적 유지관리 | 지정된 checkout의 지침과 변경 확인 | 해당 저장소에서 수정 |

`/home/ec2-user/claude-lab` 같은 시작 폴더에 소스가 없어도 그 안의 기존 작업을 덮어쓰지 않습니다.\
프롬프트가 사용할 원본은 다음 저장소입니다.

```text
https://github.com/whchoi98/jeju-atlas.git
```

파일이 없는 `ATLAS_CONFIG`는 만들어야 할 결과이며 사용자에게 받을 필수 입력이 아닙니다.\
독립 랩에서는 공통 실습 ID `team01`을 자동으로 사용합니다.\
팀명 선택이나 치환을 요청하지 않고, 기존 설정이 있으면 그대로 이어 씁니다.

새 셸에서는 생성된 실제 `activationPath`를 다시 불러옵니다.\
도구의 자식 셸에서 설정한 환경이 다른 셸에도 남아 있다고 가정하지 않습니다.

읽기 전용 AWS 조회가 실패하거나 실제 EC2가 서울 리전이 아니면 해당 조건만 보고합니다.\
계정이나 리전을 추측해 채우지 않으며 독립적인 로컬 준비는 계속합니다.

준비 절차는 [01장](01-setup.md), [02장](02-aws-environment.md), [05장](05-foundation-and-data.md)에 연결됩니다.\
교재 ZIP과 실행 소스는 [다운로드 안내](../reference/offline-start.md)에서 구분합니다.

## 목표 구성을 코드와 연결하기

프롬프트는 아래 요청 경로를 현재 구현과 대조하도록 구성했습니다.\
새 자원 추가가 필요한지 판단하기 전에 실제 코드, 스택 출력과 소유권을 확인합니다.

```text
웹/PWA → CloudFront + WAF
  ├─ OAC → 비공개 S3: 정적 자산과 사진
  └─ Public ALB: 원본 Prefix List + 검증 헤더
       → Private ECS Fargate: Node.js API + Valhalla
          ├─ S3: 카탈로그와 공식 상세
          ├─ DynamoDB: 요청 조정과 접속 집계
          ├─ Kakao Local API
          └─ IAM → Guide Runtime(Strands)
                     ├─ Bedrock
                     ├─ HTTP Gateway → Tools Runtime(MCP) → S3
                     └─ AgentCore Memory
```

Prefix List는 ALB Security Group에서 CloudFront 원본 서버의 접근을 허용하는 조건입니다.\
원본 검증 헤더와 함께 확인합니다.

참가자는 09장의 기본 CloudFront HTTPS URL을 사용하고 원본 ALB는 HTTP와 기존 접근 제한을 유지합니다.\
운영 유지관리의 도메인과 원본 HTTPS 설정은 해당 운영 runbook을 따릅니다.

| 구성 | 확인할 코드와 설정 | 구현안에 넣을 완료 조건 |
|---|---|---|
| AgentCore CLI | `agentcore.json`, `aws-targets.json`, 실제 CLI 소스 폴더 | 로컬 실행, 배포 계획, Runtime 상태와 실제 호출을 구분 |
| Guide와 Tools | `agent/guide/`, `agent/tools/`, `infra/agentcore.yaml` | 한영 응답, 도구 계약, 스트리밍, 취소와 실패 처리 |
| Gateway와 Memory | `infra/agentcore.yaml`, Guide 클라이언트 | 실제 target 경로, IAM, actor/session 격리와 보존 범위 |
| CloudFront와 ALB | `infra/application.yaml`, `infra/edge.yaml` | 정상 경유 접근, 직접 접근 차단, API 캐시와 헤더 전달 |
| Fargate와 Valhalla | `Dockerfile*`, `server/`, `routing/` | 이미지 digest, readiness, 실제 경로와 종료 처리 |
| S3 | `infra/data.yaml`, `infra/static.yaml`, `server/catalog.mjs` | 비공개 접근, OAC, 읽기 전용 스냅샷과 출처 |
| DynamoDB | `infra/application.yaml`, `server/admission.mjs`, `server/presence.mjs` | 중복 실행 방지, 여러 Task의 집계, TTL 지연 처리 |
| 관측과 복구 | `infra/operations.yaml`, 관련 배포와 검증 스크립트 | 오류 추적, 알람, 안정화 확인과 복구 증거 |
| 웹과 PWA | `src/`, `shared/`, 앱과 교재 빌더 | 모바일, 저장 범위, 앱과 교재의 독립 캐시 |

각 행은 검토할 범위입니다.\
표에 있다는 이유로 새 스택을 만들거나 이미 정상인 자원을 교체하지 않습니다.\
CLI 입문 Runtime과 전체 Atlas의 CloudFormation 관리 경계를 유지합니다.

## 통합 프롬프트 전달

[통합 프롬프트 원본](../prompts/14-project-completion.md)을 열거나, HTML 교재 아래의 **Agentic AI 코딩 어시스턴트 프롬프트 카드**에서 Codex 복사 버튼을 누릅니다.\
원본 Markdown에서는 `ai-prompt` 블록 안의 내용만 전달합니다.\
설명과 셸 명령은 프롬프트 복사 영역에 포함하지 않습니다.

1. 현재 사용할 수 있는 작업 공간의 Agentic AI 코딩 어시스턴트에 통합 프롬프트를 붙여 넣습니다.
2. 새 계정이면 기본 참가자 초기화를 진행합니다. 팀명은 전달하지 않아도 됩니다.
3. 유지관리 목적이나 이미 승인한 원격 작업이 있다면 그 범위를 명시합니다.
4. 소스 확보, 실제 경로와 로컬 설정 생성 결과를 먼저 확인합니다.
5. 첫 수정과 검사를 확인하고 저장된 준비 기록으로 같은 작업을 이어 갑니다.

프롬프트 원본은 `workshop/prompts/14-project-completion.md` 하나로 관리합니다.\
빌더가 해당 입력을 장 HTML에 포함하고, 다운로드 카드와 ZIP에도 같은 원본을 넣습니다.\
Kiro CLI와 Claude Code를 선택해도 목적, 수정 범위와 완료 기준은 같습니다.

## 실행 결과 확인

첫 보고에서 다음 형식으로 현재 구현과 작업 순서를 확인합니다.

| 결과 | 확인할 내용 |
|---|---|
| 구현안 | 현재 구현, 부족한 점, 수정 파일, 의존성과 검증 방법 |
| 요청 경로 | 브라우저부터 API, Guide, 도구와 저장소까지의 계약 |
| 작업 단위 | 재현할 문제 하나, 변경할 범위와 완료 조건 |
| 실제 변경 | 기존 작업 보존, 참가자 또는 운영 소유권에 맞는 파일 |
| 검사 기록 | 실행 위치, 명령, 종료 상태와 실패 또는 생략 사유 |
| 인계 | 남은 차단, 다음 재개 위치, 자원 유지 또는 정리 결정 |

기본 완성 작업에서는 종합 검증을 생략합니다.\
오류가 있거나 사용자가 전체 확인을 요청한 경우에만 아래 기존 wrapper 검사를 선택합니다.\
다음 명령은 자기 앱 사본의 검사이며 AWS 배포와 모델 호출 검증은 포함하지 않습니다.

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" &&
(
  set -e
  cd -- "${ATLAS_REPO:?원본 도구 경로를 확인하세요}"
  "${ATLAS_PYTHON:?}" workshop/scripts/lab.py run check \
    --config "${ATLAS_CONFIG:?참가자 설정 경로를 확인하세요}" --execute
)
```
유지관리 저장소에서는 `npm run check`와 `npm run workshop:check`를 실행합니다.\
교재 UI를 바꿨다면 준비된 브라우저 환경에서 `WORKSHOP_BROWSER_TEST=1 npm run workshop:check`도 실행합니다.\
참가자 앱 사본에는 전체 교재 검사 도구가 없을 수 있으므로 원본 유지관리 검사와 구분합니다.

실제 AWS의 추가 검증이 필요한 경우에만 [12장](12-validation.md)의 해당 문제와 자기 스택 URL을 사용합니다.\
스택 완료, ECS/Target 안정화, Runtime READY, 도구 호출과 실제 답변 완료를 각각 기록합니다.\
현재 기록된 모델 접근 실패를 모의 검사 통과로 해결했다고 표시하지 않습니다.

## 막혔을 때의 재개 지점

| 현상 | 먼저 확인할 내용 |
|---|---|
| PyYAML 누락으로 앱 사본 생성 중단 | 같은 helper Python에 전체 requirements 설치, import yaml 확인, binding 없는 부분 사본 백업 후 같은 설정으로 재준비 |
| 없는 경로와 team01.json을 반복해서 요구 | 최신 프롬프트의 0~1단계부터 실행. 저장소 URL, 기본 참가자 유형과 설정 생성 절차 사용 |
| 다른 저장소 파일을 수정하려 함 | 작업 유형, `ATLAS_APP`/`ATLAS_CLI`, 실제 Git 최상위와 원본 읽기 경계 |
| agentcore 명령이나 옵션이 다름 | 실행 파일 위치, npm CLI 버전과 설치 버전의 도움말 |
| Runtime은 준비됐지만 모델 요청 실패 | Runtime 역할, 모델과 호출 리전, 실제 오류 기록 |
| 403 또는 스트리밍 중단 | CloudFront 경로, 원본 헤더, 세션/CSRF, ALB와 서버 timeout |
| 두 Task에서 중복 요청 또는 집계 차이 | DDB 조건부 쓰기, 재시도, 최근 활동 시각과 논리적 만료 |
| S3 게시 후 교재가 그대로임 | `/workshop/`의 실제 origin과 ECS 이미지 안의 교재 버전 |
| 정리 후 원격 검증이 실패함 | 13장의 삭제 결과를 확인하고 로컬 완료와 원격 미실행을 분리 |

접근 오류를 해결하려고 IAM/SCP를 우회하거나 계정과 참가자를 바꾸지 않습니다.\
원격 입력이 필요한 항목은 차단 원인과 담당자를 남기고 독립적인 코드 작업을 계속합니다.

## 완료와 다음 단계

- [ ] 작업 대상과 현재 AWS 구성에 맞는 구현안을 남겼습니다.
- [ ] 첫 수정의 변경 파일과 필요한 실행 결과를 확인했습니다.
- [ ] 소스/IaC 검사, AWS 배포와 실제 서비스 검증 상태를 구분했습니다.
- [ ] 남은 차단, 재개 위치와 자원 인계 또는 정리 결정을 기록했습니다.

본 장의 읽음 표시와 로컬 교재 검사는 전체 프로젝트 완성 기록이 아닙니다.\
남은 구현은 같은 계획으로 이어 가고, 추가 진단이 필요한 경우에만 [12장](12-validation.md), 자원 정리는 [13장](13-cleanup.md)에서 마무리합니다.

관련 자료: [공식 CLI 문서 대조](../reference/official-guide-review.md), [AWS 자원 매핑](../reference/resources.md), [구현 참조 색인](../../docs/reference/INDEX.md), [배포 절차](../../docs/runbooks/deploy.md).
