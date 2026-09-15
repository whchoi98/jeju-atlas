# 진행자 준비 가이드

본 실습은 AgentCore CLI와 AI 코딩 도구로 실제 모델을 호출하는 제주 에이전트를 만드는 120분 과정입니다.
00~04장의 실습 110분과 여유 10분을 사용합니다.
05장 이후의 전체 웹 인프라 배포는 별도 일정으로 진행합니다.

## 이미 제공된 환경

VPC, NAT Gateway, Subnet과 EC2의 VSCode Server는 제공된 환경을 사용합니다.
Codex, Kiro CLI, Claude Code 중 선택한 도구 하나의 설치와 인증을 확인합니다.
이 항목을 참가자가 다시 설치하는 과제로 넣지 않습니다.
참가자별 VSCode 접속과 터미널 실행을 확인하고 사용할 AI CLI 하나를 정합니다.

2026-09-15 참가자 실측에서는 Amazon Linux 2023 ARM64의 Claude Code 2.1.272가
대화와 Bash 도구 호출에 성공했지만, 저장소와 AgentCore CLI, Python 3.14,
boto3가 없고 Node가 20 계열이어서 01장을 진행할 수 없었습니다.
아래 준비는 수업 전에 수행합니다. AI CLI 응답 여부를 전체 준비 완료로 기록하지 않습니다.
후속 실측에서는 공개 원격 clone과 STS가 성공했고 참가자 저장소는
`/home/ec2-user/my-project/jeju-atlas`, 여유 디스크는 95GB였습니다.
이미 clone한 환경에서는 소스를 다시 받지 않고 해당 경로의 변경 상태와 패치 적용을 확인합니다.

## 수업 전에 추가로 확인할 항목

네트워크와 편집기 설치만으로 다음 항목까지 준비되었다고 가정하지 않습니다.
진행자가 수업 전에 직접 확인하고 결과를 남깁니다.

| 항목 | 확인 내용 |
|---|---|
| AI CLI 인증 | 선택한 도구에서 대화를 시작할 수 있는지 확인 |
| 전체 소스 | 실제 EC2 저장소 경로, 적용한 커밋/패치, core.py와 장소 JSON 존재 |
| AgentCore CLI | npm 패키지 0.28.1과 create, dev, deploy, invoke 도움말 확인 |
| 언어 도구 | Node 24.18.1 이상인 24 계열, npm, Python 3.14, uv와 AWS CLI 실행 |
| 본 실습 helper | 선택한 Python의 boto3와 requests. 설치 입력은 workshop/requirements-core.txt |
| 교재 유지관리 | 전체 workshop check에는 workshop/requirements.txt와 루트 npm 의존성도 필요 |
| 패키지 다운로드 | npm과 Python 패키지 저장소 접근, 충분한 디스크, 배포용 wheel 다운로드 확인 |
| EC2 계정 | IMDSv2 계정과 STS caller 일치, 다른 profile로 우회하지 않음 |
| 기존 네트워크 | init-ec2 --identity-only가 현재 EC2의 VPC를 확인하는지 검사. 전체 서브넷 검사는 심화에서 수행 |
| CDK bootstrap | 대상 계정과 서울 리전의 기존 bootstrap 상태 확인, CLI 요구 버전 충족 |
| 배포 권한 | 참가자 Runtime, 실행 역할, CloudFormation과 bootstrap 자산 사용 권한 |
| 모델 권한 | 선택한 Bedrock 추론 프로필과 실제 모델 호출을 같은 실행 역할 구성으로 확인 |
| 이름 충돌 | 팀 이름과 프로젝트 이름이 다른 팀 또는 운영 서비스와 겹치지 않음 |

CLI의 최초 패키지 설치 시간을 참가자 실습으로 넘기지 않습니다.
행사 전에 같은 버전으로 프로젝트 생성과 의존성 설치를 실행해 다운로드 경로와 캐시를 확인합니다.
모델은 Sonnet 4.6, Bedrock ID는 `global.anthropic.claude-sonnet-4-6`으로 고정합니다.
Claude Code는 `claude --model claude-sonnet-4-6`으로 시작하며 떠 있는 별칭을 사용하지 않습니다.
모델이나 호출 리전을 즉석에서 바꾸지 않습니다. 이 코딩 세션의 Codex 모델도 변경하지 않습니다.

### 확인된 실제 호출 실패

2026-09-15 참가자 EC2에서 AWS CLI Converse를 실제 실행했습니다.
호출 리전 `ap-northeast-2`, 위 Sonnet 모델 요청은 `bedrock:InvokeModel`에 대한
SCP 명시적 거부로 `AccessDeniedException`을 반환했습니다. **실패한 실제 결과**이며
설치 검사나 모델 목록 조회 성공으로 대체하지 않습니다.
참가자 호스트, 계정/ARN, 자격 증명과 원본 오류 기록은 공개 교재에 포함하지 않습니다.

주최자는 배포 리전과 별도로 허용된 Bedrock 호출 리전, Global 추론 프로필의 SCP 조건,
EC2 역할과 Runtime 실행 역할을 확인합니다. Global 프로필의 실제 추론 목적지는
호출 리전과 같다고 가정할 수 없습니다. 다른 리전이 허용된다고 추측하거나 순회 호출하지 않습니다.
이 절차는 IAM/SCP를 수정하지 않습니다.

주최자가 확인한 값을 참가자 Bash의 `ATLAS_BEDROCK_REGION`에 지정한 뒤
[02장](../chapters/02-aws-environment.md)의 `model_check.py --execute`를 한 번 실행합니다.
실제 응답과 `passed: true`가 확인돼야 04장의 모델 실행으로 넘어갑니다.
현재 서울 결과는 실패이며, 다른 호출 리전의 성공 결과는 아직 없습니다.
정책 거부가 계속되면 결과를 보존하고 주최자에게 넘깁니다.

`model_config.py`는 Runtime 모델과 호출 리전만 설정합니다.
`aws-targets.json`, `ATLAS_REGION`, `AWS_REGION`의 배포 리전은 서울로 유지합니다.
설정 파일을 쓴 사실, Runtime READY, 실제 모델 응답은 각각 다른 확인입니다.

## 1. 참가자 EC2에 전체 소스 전달

실행 소스의 원격은 `https://github.com/whchoi98/jeju-atlas.git`입니다.
교재 ZIP에는 준비기, 검사기와 Runtime 소스가 없으므로 Git 소스를 사용합니다.
수업에는 진행자가 검증한 커밋을 배정하고 실제 `git rev-parse HEAD`를 기록합니다.

이미 `/home/ec2-user/my-project/jeju-atlas`에 clone한 경우, 먼저 기존 소스 변경을 확인합니다.
아래 명령은 변경이 있으면 중단하며 참가자 `.local` 상태와 인증을 지우지 않습니다.

```bash
(
  set -e
  repo=/home/ec2-user/my-project/jeju-atlas
  test -d "$repo/.git"
  test -z "$(git -C "$repo" status --porcelain --untracked-files=all)" || {
    printf '%s\n' '기존 소스 변경이 있습니다. 보존한 뒤 별도 깨끗한 clone을 사용하세요.' >&2
    exit 1
  }
  git -C "$repo" fetch origin main
  git -C "$repo" merge --ff-only origin/main
  git -C "$repo" rev-parse HEAD
  python3 -B "$repo/workshop/scripts/core.py" source --repo "$repo"
)
```

이전 임시 패치나 참가자 수정이 있어 자동 갱신할 수 없다면 기존 폴더를 보존합니다.
새 소스가 필요할 때는 다음처럼 별도 폴더로 clone합니다. 원래 폴더의 코드, `.local`,
도구와 검사 기록을 삭제하거나 자동으로 옮기지 않습니다.

```bash
(
  set -e
  dst=/home/ec2-user/my-project/jeju-atlas-current
  test ! -e "$dst" && test ! -L "$dst"
  GIT_TERMINAL_PROMPT=0 git clone https://github.com/whchoi98/jeju-atlas.git "$dst"
  git -C "$dst" rev-parse HEAD
  python3 -B "$dst/workshop/scripts/core.py" source --repo "$dst"
)
```

별도 clone을 선택했다면 아래 설치 명령과 활성화 경로도 그 실제 경로로 바꿉니다.
기존 참가자 Runtime 프로젝트를 계속 수정하려면 원래 프로젝트 경로를 명시하고
새 소스의 model_config.py를 사용합니다. 기존 프로젝트를 다시 생성하지 않습니다.
임시 환경/CloudFront 패치를 이미 받은 사용자는 같은 내용을 다시 적용하지 않습니다.
새 Git 커밋에는 환경 준비, CloudFront 기본 도메인과 Sonnet 보완을 함께 포함합니다.

| 경로 | 용도 |
|---|---|
| 검증한 Git 소스 | 준비기, 모델 검사기, Runtime 설정, 데이터와 교재 소스 |
| core.py prepare | 참가자 환경만 준비. 실제 JejuGuide는 03장에서 생성 |
| model_config.py | 참가자 Sonnet 모델과 명시적 호출 리전 설정. IAM 변경 없음 |
| model_check.py --execute | 참가자 EC2에서 실행하는 작은 실제 Converse 검사 |
| lab.py prepare | 심화 앱을 참가자 전용 사본으로 준비 |
| workshop/cli/prepare.py | 모델 없는 Warmup 참고 모듈. 본 실습 결과를 대신하지 않음 |
| 교재 ZIP | 읽기용. 실행 소스와 참가자 상태는 포함하지 않음 |

## 2. 전용 도구 경로 준비와 설치

위 소스를 받은 참가자 EC2에서 실행합니다. `team01`과 프로젝트 이름은 배정값입니다.
이 준비 명령은 시스템 Python 3.9로도 실행되며, 아직 AWS를 조회하지 않습니다.

```bash
python3 -B /home/ec2-user/my-project/jeju-atlas/workshop/scripts/core.py prepare \
  --participant team01 --project-name AtlasCliTeam01 --assistant claude
```

준비기가 출력한 `activationPath`를 기록합니다. 설치는 진행자의 명시적 작업입니다.

```bash
bash /home/ec2-user/my-project/jeju-atlas/workshop/scripts/install_core.sh
```

설치기는 Linux ARM64와 x86_64에서 기존 Python 3.9 이상, uv, curl, tar,
sha256sum과 awk를 사용합니다. 참가자 실측의 uv 0.12.15를 그대로 사용할 수 있으며,
원본 호스트에서는 uv 0.10.9로 같은 플래그를 실행했습니다.
이 선행 도구가 없다면 진행자가 검증한 실행 파일 경로를 먼저 제공합니다.

| 전용 경로: 저장소의 workshop/.local/toolchain 아래 | 설치 내용 |
|---|---|
| node-v24.21.0 | `.nvmrc` 버전의 공식 Node Linux archive. 공식 SHASUMS256.txt로 검사 |
| python | uv 관리 Python 3.14.3. `--no-bin`으로 사용자 공용 bin 등록 방지 |
| helpers | Python 3.14 venv와 boto3 1.42.86, requests 2.32.5 |
| agentcore | npm @aws/agentcore 0.28.1과 로컬 package-lock.json |
| cache | 이 도구 환경의 npm/uv 다운로드 캐시 |

`sudo`, 전역 npm prefix 변경, `uv python install --default`, 시스템 Python 교체,
셸 시작 파일 수정과 Claude 재로그인은 사용하지 않습니다.
기존 소유 폴더와 잠금 파일은 재사용하고, 다른 설치나 맞지 않는 설정은 덮어쓰지 않습니다.
다운로드 실패 후에는 오류를 확인하고 같은 설치기를 재실행합니다.
공식 Node, GitHub의 Python 배포물, npm registry와 Python package index에 접근할 수 있어야 합니다.
다른 EC2의 venv를 그대로 복사하는 대신 해당 EC2에서 설치기를 실행합니다.

## 3. 활성화, 사전검사와 Claude 재개

설치가 끝나도 부모 Bash의 PATH는 자동으로 바뀌지 않습니다.
준비기가 출력한 활성화 파일을 **같은 Bash에서 source**합니다.

```bash
source /home/ec2-user/my-project/jeju-atlas/workshop/.local/labs/team01/activate.sh &&
python3 -B "$ATLAS_REPO/workshop/scripts/core.py" doctor --assistant "$ATLAS_ASSISTANT"
```

모든 검사와 `passed: true`를 확인합니다. 기본 검사는 Docker, 다른 두 AI CLI,
모델 접근 권한과 실제 배포를 요구하거나 확인하지 않습니다.
Node 20, Python 3.14 부재, helper import 실패와 잘못된 AgentCore 배포판은 실패로 보고합니다.
누락 항목은 한 번에 출력되므로 첫 오류만 고치고 준비 완료로 처리하지 않습니다.

새 Bash마다 같은 `source`를 실행합니다. 03장에서 프로젝트를 만든 후 Claude는
`test -f "${ATLAS_CLI:?}/agentcore/agentcore.json" && cd -- "$ATLAS_CLI" && claude --model claude-sonnet-4-6`으로 엽니다.
자세한 화면과 입력 구분은 [AI CLI 환경](ai-cli-environments.md)을 따릅니다.
루트의 `npm ci`와 교재 빌드는 00~04장 참가자 사전검사의 필수 단계가 아닙니다.
참가자 Runtime의 의존성은 04장에서 `app/JejuGuide`와 `agentcore/cdk`에 설치합니다.

## 리허설

진행자는 본 실습과 같은 역할, CLI 버전, 프로젝트 설정으로 한 차례 배포합니다.
생성, 구현, 패키징, 로컬 모델 응답, 배포, 원격 응답과 정리 시간을 각각 기록합니다.
실습용 계정에서 수행한 결과만 사용하고 제주 아틀라스 운영 배포 기록을 대신 복사하지 않습니다.

CLI 설정은 core.py prepare가 참가자별 `cli-config/config.json`에 준비합니다.
`disableDependencyManagement`와 `disableTransactionSearch`를 true로 설정해
수업 중 전역 도구나 계정 단위 관측 설정이 바뀌지 않게 합니다.
수업용 프로젝트는 별도로 만들고, 작성이 끝난 에이전트를 참가자 결과물로 대신 배포하지 않습니다.
설치 및 로컬 사전검사 성공과 이 클라우드 리허설의 성공은 별도로 기록합니다.

## 수업 중 확인 시점

| 경과 시간 | 확인할 내용 | 늦어진 경우 |
|---|---|---|
| 15분 | VSCode와 선택한 AI CLI 실행 | 준비된 예비 세션으로 전환 |
| 25분 | 계정과 참가자 경로 확인 | 권한 또는 메타데이터 문제를 진행자가 확인 |
| 60분 | Strands 프로젝트와 검색 도구 작성 | 현재 코드와 실패한 테스트 하나에 집중 |
| 75분 | 로컬 테스트와 모델 응답 | 모델 권한과 도구 결과를 구분해 점검 |
| 95분 | Runtime 배포 상태 | 같은 deploy를 다시 시작하지 않고 진행 중인 배포 확인 |
| 105분 | 원격 호출 시작 | 현재 상태와 원인을 기록하고 남은 시간에 해결 가능한지 판단 |
| 120분 | 결과와 남은 자원 기록 | 실패한 단계를 완료로 표시하지 않고 후속 담당자 지정 |

AWS 서비스 지연이나 권한 오류가 있으면 120분 안에 원격 응답을 보장할 수 없습니다.
여유 시간은 오류를 숨기기 위한 시간이 아닙니다. `RESULTS.md`에 실제 결과를 남깁니다.
이 교재의 120분 편성과 로컬 문서 검증을 클라우드 리허설 성공으로 설명하지 않습니다.

## 심화 과정 운영

심화 과정은 기존 에셋의 ECR, S3, Guide/Tools/Gateway/Memory, Valhalla,
Private Fargate, CloudFront, WAF, 공식 데이터와 운영 알람을 다룹니다.
별도의 시간, 공공 API 권한과 ARM64 컨테이너 빌드 환경을 준비합니다.
도메인 등록, ACM 발급, DNS/Route 53 변경 권한은 준비 사항이 아닙니다.
참가자 앱과 교재는 실제 App 스택의 기본 CloudFront HTTPS 주소를 사용합니다.
CloudFront에서 ALB까지는 HTTP이며 기존 원본 검증 헤더와 Prefix List 제한을 유지합니다.
기본 Runtime은 AgentCore CLI가, 심화 Atlas는 전용 CloudFormation 스택이 관리합니다.
두 배포의 소유권과 정리 결과를 분리해 기록합니다.

App 배포 후 참가자 환경에서 URL을 조회합니다. 직접 hostname을 정하거나 예시 값을 입력하지 않습니다.

```bash
python3 "${ATLAS_REPO:?}/workshop/scripts/lab.py" url --config "${ATLAS_CONFIG:?}"
```

이 조회에는 STS/EC2 확인과 참가자 App 스택의 CloudFormation 읽기 권한이 필요합니다.
URL이 없어도 운영 도메인이나 다른 Distribution으로 대체하지 않습니다.
Origin 인증서, Host 함수와 TLS probe 스택은 새로 만들지 않으며 기존 운영 자원도 정리하지 않습니다.

공유 VPC, NAT Gateway, Subnet, CDK bootstrap과 VSCode Server는 정리하지 않습니다.
학생이 만든 Runtime과 스택, 로그와 아티팩트는 해당 학생의 결과 기록을 보고 정리합니다.
