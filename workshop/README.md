# AgentCore CLI로 만드는 제주 AI 가이드

**EC2 사전 준비를 마친 뒤 100~120분** 동안 제주 여행 에이전트를 구현하고 배포합니다.\
핵심은 AgentCore CLI와 Codex, Claude Code, Kiro CLI 중 선택한 도구 하나입니다.\
참가자는 환경을 활성화하고 Bedrock 단기키를 입력한 후, **구현 프롬프트와 배포 프롬프트 두 개**로 작업을 이어 갑니다.

첫 결과물은 137개 시드를 검색하는 `JejuGuide`와 참가자 전용 AgentCore Runtime입니다.\
카카오, 관광공사와 VISIT JEJU 키는 첫 배포에 필요하지 않습니다.\
3D 웹과 전체 AWS 인프라를 만드는 05~14장은 추가 시간의 선택 과정입니다.

## 실습 전에 준비할 것

진행자는 [EC2 사전 점검과 설치](reference/preconfiguration.md)를 먼저 끝냅니다.\
Amazon Linux EC2와 VSCode Server, 기존 VPC/Subnet/NAT, 실습 IAM 역할을 사용합니다.

Node **24.18.1 이상인 24 계열**, uv와 **Python 3.12**, npm **AgentCore CLI 0.28.1**, 선택한 Agentic AI 코딩 어시스턴트의 설치와 로그인, CDK bootstrap과 배포 권한을 확인합니다.\
Docker도 사전 준비하되 기본 CodeZip 과정에서는 필수로 요구하지 않습니다.

전체 Git 소스를 사용합니다.\
`workshop/scripts/core.py`가 없으면 [읽기용 교재와 EC2 실행 소스 구분](reference/offline-start.md#python-스크립트가-없을-때)을 확인합니다.

설치 이슈와 재개 절차는 [설치 스킬](../skills/jeju-atlas-install/SKILL.md)에 모았습니다.\
진행자는 [준비 가이드](reference/facilitator.md)에 같은 계정의 실제 리허설 결과를 기록합니다.

## 시작 전에 전체 소스 받기

처음 사용하는 EC2의 Bash 터미널에서 **수업 전에 한 번** 실행합니다.\
이미 이 경로에 전체 저장소를 받았다면 참가자 시작 명령으로 이동합니다.

```bash
cd -- "$HOME" && {
mkdir -p /home/ec2-user/my-project
git clone https://github.com/whchoi98/jeju-atlas.git \
  /home/ec2-user/my-project/jeju-atlas
}
```
## 참가자 시작 명령

사전 구성에서 `start.sh`를 이미 실행했다면 다시 설치하지 않고 활성화부터 시작합니다.\
참가자마다 독립된 랩을 사용하므로 팀명을 선택하거나 바꾸지 않습니다.\
시작 도구가 공통 실습 ID `team01`과 프로젝트 `AtlasCliTeam01`을 자동으로 사용합니다.\
아래는 Codex를 선택한 참가자의 EC2 Bash 명령입니다.

```bash
cd /home/ec2-user/my-project/jeju-atlas && {
bash workshop/scripts/start.sh --assistant codex &&
source /home/ec2-user/my-project/jeju-atlas/workshop/.local/labs/team01/activate.sh &&
python3 "$ATLAS_REPO/workshop/scripts/workshop_env.py" configure &&
codex -C "$ATLAS_CLI_PARENT" --sandbox workspace-write -a on-request -c 'approvals_reviewer="auto_review"'
}
```
키 입력은 본인 터미널에서 숨김 처리되고 `$ATLAS_CLI_PARENT/.env`에 저장됩니다.\
키 원문을 프롬프트나 화면 출력으로 전달하지 않습니다.\
Claude Code는 같은 참가자 폴더에서 **`claude --permission-mode auto`**, Kiro CLI는 **`kiro-cli chat`**을 사용합니다.

[Agentic AI 코딩 어시스턴트 환경](reference/ai-cli-environments.md)에 도구별 실행과 권한 모드 확인을 정리했습니다.\
기존 인증과 코딩 모델을 유지하며 지원 여부는 수업 전에 확인합니다.

이후 [03장 구현 프롬프트](prompts/03-codex.md), [04장 배포 프롬프트](prompts/04-agentcore-cli.md)를 순서대로 전달합니다.\
프롬프트에는 실제 구현과 배포, 필요한 계정 확인과 짧은 결과 기록이 포함됩니다.\
계정 확인은 읽기 전용으로 진행하고, 배포 프롬프트의 승인 범위에서 자원을 만듭니다.

## 100~120분 진행표

| 경과 시간 | 단계 | 확인 결과 |
|---|---|---|
| 0~5분 | [00. 목표](chapters/00-orientation.md) | 결과물과 종료 기준 |
| 5~15분 | [01. 환경과 키](chapters/01-setup.md) | 활성화, 사전검사, 숨김 `.env` 입력 |
| 15~25분 | [02. 계정과 모델](chapters/02-aws-environment.md) | EC2 대상과 발급 리전, 입력 상태 |
| 25~55분 | [03. 구현](chapters/03-codex.md) | AgentCore 프로젝트와 검색 도구 |
| 55~100분 | [04. 배포와 결과 보기](chapters/04-agentcore-cli.md) | 키 연결, Runtime 배포, 예시 응답과 인계 |
| 100~120분 | 여유 시간 | 지연 대응, 실제 상태와 남은 자원 정리 |

설치 시간은 위 표에 포함하지 않습니다.\
핵심 작업 100분 안에 결과와 정리 담당자를 기록하고 최대 20분을 여유로 사용합니다.\
이는 수업 편성 기준이며 새 EC2에서 120분 안에 끝나는 클라우드 리허설을 완료했다는 기록은 아닙니다.

Runtime 모델은 `global.anthropic.claude-sonnet-4-6`입니다.\
서울 배포 리전과 **단기키 발급 리전인 Bedrock 호출 리전**을 구분합니다.\
모델 호출에는 키를 사용하고 AWS 배포와 Runtime 호출 인증에는 EC2 IAM 역할을 사용합니다.

배포 상태와 실제 응답 완료를 확인하고, 추가로 실행한 검사는 별도로 기록합니다.\
SCP 거부, 키 만료나 배포 실패를 다른 계정의 성공으로 대신하지 않습니다.

## 기본 경로에서 생략할 작업

별도 모델 사전 검사, 로컬 실행 반복, 전체 테스트, 한영 응답 비교와 브라우저 종합 검증은 기본 진행에서 생략합니다.\
필요한 빌드와 배포 명령의 오류 확인, 계정과 계획 확인, 최종 예시 응답 한 번만 수행합니다.\
문제가 생기거나 특정 기능을 바꾼 경우에만 [선택 진단](chapters/12-validation.md)의 해당 항목을 실행합니다.

HUD는 설치하지 않아도 실습을 완료할 수 있습니다.\
원하는 참가자만 [선택 설치](reference/hud-setup.md)를 진행하며, 생략한 검증과 HUD를 완료 조건으로 요구하지 않습니다.

## 배포 후 선택 연동

[키와 선택 연동](reference/keys-and-integrations.md)에서 필요한 값만 추가합니다.

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
python3 "$ATLAS_REPO/workshop/scripts/workshop_env.py" configure --integrations
}
```
`.env` 이름은 `KAKAO_REST_API_KEY`, `TOURAPI_SERVICE_KEY`, `VISIT_JEJU_API_KEY`입니다.\
입력하지 않은 기능은 미연결 상태로 두고 시드 검색을 계속 사용합니다.

전체 앱을 준비한 뒤 [10장](chapters/10-enrichment.md)의 SSM 게시와 앱/worker 반영을 진행합니다.\
키를 입력했다는 사실만으로 기능이 연결됐다고 표시하지 않습니다.

## 심화 자료

| 장 | 내용 |
|---|---|
| [05](chapters/05-foundation-and-data.md) | ECR과 S3, 장소 카탈로그 |
| [06](chapters/06-atlas-agentcore.md) | Atlas Guide, Tools, Gateway, Memory |
| [07](chapters/07-routing.md) | Valhalla 경로 데이터와 고도 |
| [08](chapters/08-web.md) | 3D 웹과 Private Fargate |
| [09](chapters/09-https-edge.md) | CloudFront 기본 HTTPS, WAF와 OAC |
| [10](chapters/10-enrichment.md) | 외부 키와 공식 장소 정보 |
| [11](chapters/11-operations.md) | 로그, 알람과 운영 설정 |
| [12](chapters/12-validation.md) | 선택: 오류나 변경이 있는 기능만 진단 |
| [13](chapters/13-cleanup.md) | 전체 실습 자원 정리 |
| [14](chapters/14-project-completion.md) | 설치 스킬과 통합 프롬프트로 전체 앱 완성 |

기본 Runtime과 전체 앱의 Guide/Tools는 별도 배포입니다.\
14장의 45분은 범위 정리와 첫 수정 검사 시간이며 전체 앱 구축 시간이 아닙니다.

참가자 앱은 실제 App 스택의 기본 CloudFront HTTPS URL을 사용합니다.\
사용자 도메인, ACM과 DNS 설정은 실습 준비에 추가하지 않습니다.

Codex의 [Bedrock provider 설정](reference/codex-bedrock.md)과 [HUD 준비](reference/hud-setup.md)는 필요할 때 진행자가 사전에 적용하는 선택 자료입니다.

## 교재 유지관리

다음은 교재 작성자의 명령이며 참가자 본 실습의 필수 명령이 아닙니다.\
전체 helper requirements와 루트 npm 의존성이 준비된 저장소에서 실행합니다.

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
npm run workshop:check
npm run workshop:package
npm run build
}
```
HTML은 `workshop/site/index.html`, ZIP은 `workshop/.local/downloads/jeju-atlas-workshop-handbook.zip`에 생성됩니다.\
[PC 다운로드 안내](reference/offline-start.md)와 [검증 기록](VALIDATION.md)을 확인합니다.\
읽음 표시, 로컬 검사, AWS 배포와 실제 모델 응답 성공은 서로 다른 결과입니다.
