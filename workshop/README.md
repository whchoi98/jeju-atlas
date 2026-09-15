# AgentCore CLI로 만드는 제주 AI 가이드

준비된 EC2의 VSCode Server에서 제주 여행 에이전트를 구현합니다.
Codex, Kiro CLI, Claude Code 중 하나로 코드를 작성하고,
AgentCore CLI로 로컬 실행, AWS 배포와 호출 결과를 확인합니다.

본 실습은 00장부터 04장까지입니다. 실습 110분과 대기 시간 10분을 합쳐
120분으로 편성했습니다. 05장 이후는 제주 아틀라스 전체 서비스를 배포하는
심화 자료이며 본 실습 시간에 포함하지 않습니다.

## 준비된 환경

VPC, NAT Gateway, Subnet과 EC2의 VSCode Server는 제공된 환경을 사용합니다.
참가자는 환경을 새로 만들지 않고 VSCode Server의 터미널에서 시작합니다.
Codex, Kiro CLI, Claude Code 중 준비된 도구 하나만 사용합니다.
도구를 바꿔도 실습 폴더와 AWS 계정은 유지합니다.

진행자는 전체 Git 소스와 적용 버전, AgentCore CLI 0.28.1, Node 24.18.1 이상인 24 계열,
Python 3.14, uv, AWS CLI, boto3/requests,
CDK bootstrap과 실습 역할의 모델 호출 권한을 확인합니다.
설치와 로그인은 별개이므로 선택한 AI CLI로 대화를 시작할 수 있는지도 확인합니다.
[진행자 준비](reference/facilitator.md)에 확인 항목과 지연 시 대응을 정리했습니다.

01장은 전체 소스 확인, 참가자 `activate.sh` 생성과 `core.py doctor`로 시작합니다.
새 Bash마다 활성화 파일을 불러오고, 그 Bash에서 참가자 폴더의 Claude를 새로 엽니다.
누락 도구는 `workshop/.local/toolchain/`에 설치하며 시스템 Node/Python과 로그인 설정을
교체하지 않습니다. Docker는 심화 과정에서만 필요합니다.
교재 ZIP에는 실행 소스가 없으므로 Git clone와 미반영 수정 패치를 별도로 준비합니다.

## 120분 진행표

| 경과 시간 | 할 일 | 확인할 결과 |
|---|---|---|
| 0~5분 | [00. 실습 목표](chapters/00-orientation.md) | 만들 에이전트와 완료 기준 이해 |
| 5~15분 | [01. 준비된 환경 확인](chapters/01-setup.md) | VSCode 터미널과 사용할 AI CLI 확인 |
| 15~25분 | [02. 계정과 작업 폴더](chapters/02-aws-environment.md) | 참가자 이름과 배포 대상 확인 |
| 25~60분 | [03. AI CLI로 에이전트 구현](chapters/03-codex.md) | AgentCore 프로젝트, 제주 검색 도구와 테스트 |
| 60~110분 | [04. 실행과 배포](chapters/04-agentcore-cli.md) | 로컬 응답, Runtime 배포와 실제 모델 응답 |
| 110~120분 | 지연 대응과 결과 정리 | 배포 상태와 남은 자원 기록 |

결과물은 실제 모델과 제주 검색 도구를 사용하는 참가자 전용 Runtime입니다.
모델은 Sonnet 4.6으로 고정합니다. Runtime은 `global.anthropic.claude-sonnet-4-6`,
Claude Code는 `claude --model claude-sonnet-4-6`을 사용합니다.
배포 리전과 주최자가 확인한 Bedrock 호출 리전을 구분합니다.
코드 생성, 로컬 테스트, READY 상태, 실제 응답 완료를 각각 확인합니다.
권한 오류나 서비스 지연으로 원격 호출을 마치지 못했다면 배포 완료로 표시하지 않습니다.
이 시간표는 수업 설계이며, 120분 클라우드 리허설을 완료했다는 기록은 아닙니다.
현재 기록된 참가자 서울 Converse 호출은 SCP 명시적 거부로 실패했습니다.
읽기 전용 doctor와 실제 `model_check.py --execute`는 별도이며 실패를 통과로 표시하지 않습니다.

## AI 코딩 도구 사용

코딩 도구에는 이번 단계의 목적, 수정할 폴더, 입력과 출력, 검사 방법을 전달합니다.
답변을 읽은 뒤 실제 변경 파일과 실행 결과를 확인합니다.
각 장의 프롬프트 카드는 세 AI CLI에서 공통으로 사용합니다.
[도구별 실행 방법](reference/ai-cli-environments.md)을 확인하세요.
Codex 등의 개발 도구 인증과 배포된 에이전트의 Bedrock 권한은 별개입니다.
키나 로그인 파일을 프롬프트에 넣지 않습니다.

## 심화 실습

| 장 | 내용 |
|---|---|
| [05](chapters/05-foundation-and-data.md) | ECR과 S3, 장소 카탈로그 |
| [06](chapters/06-atlas-agentcore.md) | Atlas Guide, Tools, Gateway, Memory |
| [07](chapters/07-routing.md) | Valhalla 경로 데이터와 고도 |
| [08](chapters/08-web.md) | 3D 웹과 Private Fargate |
| [09](chapters/09-https-edge.md) | CloudFront 기본 HTTPS, WAF와 OAC |
| [10](chapters/10-enrichment.md) | 공식 장소 정보와 사진 |
| [11](chapters/11-operations.md) | 로그, 알람과 운영 설정 |
| [12](chapters/12-validation.md) | 전체 서비스 검증 |
| [13](chapters/13-cleanup.md) | 전체 실습 자원 정리 |

기본 과정의 Runtime은 AgentCore CLI가 관리합니다.
심화 과정의 Atlas Guide와 Tools는 별도의 CloudFormation 스택이 관리합니다.
심화 과정을 시작할 때 이 경계를 먼저 확인합니다.
참가자 앱과 교재는 실제 App 스택 출력의 기본 `*.cloudfront.net` HTTPS URL로 접속합니다.
사용자 도메인 등록, ACM 발급과 DNS/Route 53 설정은 실습에 포함하지 않습니다.
기존 운영 도메인 인프라는 그대로 유지합니다.

## 교재 열기

```bash
cd -- "${ATLAS_REPO:?실제 저장소를 지정하거나 activate.sh를 source하세요}" &&
npm run workshop:build
```

`workshop/site/index.html`을 브라우저에서 엽니다.
PC로 옮길 때는 `workshop/site/` 전체를 복사하거나 다음 명령으로 ZIP을 만듭니다.

```bash
npm run workshop:package
```

ZIP은 `workshop/.local/downloads/jeju-atlas-workshop-handbook.zip`에 생성됩니다.
PC에서는 교재를 읽고 명령은 EC2의 VSCode Server 터미널에서 실행합니다.
[PC에서 교재 열기](reference/offline-start.md)에 파일 구성을 설명했습니다.

## 작업 위치와 검증

참가자는 `workshop/.local/labs/<참가자>/` 안에서 작업합니다.
기존 제주 아틀라스 배포와 다른 프로젝트는 변경하지 않습니다.
읽음 표시는 학습 기록이며 AWS 배포 성공을 뜻하지 않습니다.

```bash
(
  set -e
  cd -- "${ATLAS_REPO:?}"
  uv --no-config pip install --python "${ATLAS_PYTHON:?}" -r workshop/requirements.txt
  npm ci
  npm run workshop:check
)
```

위 명령은 교재 유지관리용이며 선택한 프로젝트 전용 Python 환경에서 실행합니다.
참가자 준비 판정은 01장의 `core.py doctor`, 배포 전 파일/대상 판정은
`core.py doctor --assistant "$ATLAS_ASSISTANT" --project`를 사용합니다.
[검증 기록](VALIDATION.md)은 로컬 확인과 클라우드 리허설 여부를 구분합니다.
[자원 목록](reference/resources.md)과 [공식 CLI 문서 검토](reference/official-guide-review.md)도 확인할 수 있습니다.
