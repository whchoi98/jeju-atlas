# 진행자 준비 가이드

본 실습의 종료 목표는 **참가자가 구현한 제주 검색 도구와 실제 응답하는 AgentCore Runtime**입니다.\
핵심 100분과 여유 20분을 편성합니다.\
EC2 설치, CLI 로그인과 패키지 다운로드 준비는 수업 전에 끝내며 05~14장의 전체 웹 구축은 별도 일정입니다.

## 수업 전에 준비

[EC2 사전 구성](preconfiguration.md)을 참가자와 같은 환경에서 수행합니다.\
전체 Git 소스와 필요한 패치를 전달하고 실제 커밋과 수정 상태를 기록합니다.\
이미 있는 소스와 `workshop/.local`을 지우거나 다른 EC2의 venv를 그대로 복사하지 않습니다.

```bash
cd /home/ec2-user/my-project/jeju-atlas && {
bash workshop/scripts/start.sh --assistant codex
source /home/ec2-user/my-project/jeju-atlas/workshop/.local/labs/team01/activate.sh
bash "$ATLAS_REPO/workshop/scripts/check_env.sh" --assistant "$ATLAS_ASSISTANT"
}
```
다른 도구를 쓰는 참가자는 `--assistant claude` 또는 `--assistant kiro`를 지정합니다.\
`start.sh`는 참가자 준비, 필요한 core 도구 설치와 로컬 doctor를 묶습니다.

Docker 설치는 사전 구성의 dnf/systemctl/usermod 절차를 사용합니다.\
새 로그인 셸의 `docker info`까지 확인하며 CodeZip 기본 과정에서는 선택 항목입니다.

| 항목 | 확인 기준 |
|---|---|
| 소스 | 전체 저장소, `core.py`, `start.sh`, `workshop_env.py`, 설치 스킬과 장소 JSON |
| Node | 24.18.1 이상인 24 계열, `.nvmrc`와 실제 PATH 확인 |
| Python | uv가 찾는 Runtime Python 3.12, helper의 boto3/requests |
| AgentCore CLI | npm `@aws/agentcore` 0.28.1, create/dev/deploy/invoke 문법 |
| Agentic AI 코딩 어시스턴트 | 한 도구의 실제 대화, 기존 로그인과 모델, 권한 모드 |
| Codex | `on-request`와 `auto_review`, workspace-write의 실제 적용 |
| Claude Code | `--permission-mode auto`, provider/모델 지원과 화면의 Auto 표시 |
| AWS | EC2 identity와 STS 계정 일치, 서울 CDK bootstrap |
| 배포 권한 | Runtime, CloudFormation, 실행 역할과 PassRole, bootstrap 자산 |
| 키 게시 권한 | 소유 SSM 파라미터와 태그 조회/쓰기, 전용 IAM 정책 생성/조회/연결 |
| 모델 키 | 발급 리전, 실제 만료 시각과 허용된 Sonnet 4.6 호출 |
| 의존성 | 생성 프로젝트의 npm/uv 설치와 Python 3.12용 CodeZip 패키징 |
| 전체 앱 선택 | Docker와 같은 helper Python의 PyYAML/cfn-lint |

기본 모델은 `global.anthropic.claude-sonnet-4-6`입니다.\
Claude Code의 코딩 모델과는 별도이며, auto 모드 지원 때문에 Runtime 모델을 바꾸지 않습니다.\
[Agentic AI 코딩 어시스턴트 환경](ai-cli-environments.md)의 공식 조건을 참고해 코딩 CLI를 사전 검증합니다.

Codex의 [별도 Bedrock 설정](codex-bedrock.md)과 [HUD](hud-setup.md)는 선택 준비입니다.\
이를 모든 참가자의 필수 설치 과제로 추가하지 않습니다.

## 랩 분리와 공통 식별자

본 교재는 참가자마다 AWS 자원 범위가 분리된 독립 랩을 제공하는 운영 방식입니다.\
진행자는 랩별 계정과 배포 대상이 분리되어 공통 이름을 사용할 수 있는지 확인합니다.\
참가자에게 고유한 팀명을 만들거나 코드의 `team01`을 치환하도록 요청하지 않습니다.

`team01`은 공통 내부 실습 ID이고 `AtlasCliTeam01`은 기본 프로젝트 이름입니다.\
이미 만들어 둔 설정과 자원은 그대로 재사용합니다.

## 검증과 HUD 운영

참가자 기본 경로에서는 시간 소요가 큰 검증 프롬프트를 생략합니다.\
필요한 계정과 계획 확인, 배포 명령의 성공 여부와 예시 응답 한 번만 확인합니다.\
전체 테스트와 브라우저, 한영 응답, 경로 및 Memory/Gateway 검증은 오류가 있거나 요청한 경우에만 범위를 좁혀 수행합니다.

진행자의 행사 전 리허설과 공개 교재 게시 검증은 별도 운영 작업입니다.\
참가자에게 그대로 반복하도록 요구하지 않습니다.\
HUD는 희망자만 설치하며 기본 이미지나 본 실습의 필수 완료 조건에 넣지 않습니다.

## 키와 계정 준비

참가자에게 Bedrock 콘솔의 **단기키 발급 리전과 실제 만료 시각**을 안내합니다.\
키는 수업 직전에 본인 터미널의 `workshop_env.py configure`로 입력합니다.

발급자의 권한과 만료 조건이 적용되므로 수업 종료까지 유효해야 합니다.\
키 원문을 공용 문서, 프롬프트, 제출물이나 설치 스킬에 기록하지 않습니다.

배포 인증에는 EC2 IAM 역할을 계속 사용합니다.\
키 발급 리전과 서울 배포 리전을 구분하고, 모델 키가 AWS 배포 권한까지 제공한다고 안내하지 않습니다.

참가자 Runtime은 IAM으로 호출되며 모델에만 Bearer 키를 사용합니다.\
SSM 경로와 정책은 참가자별 이름과 소유 태그로 분리합니다.

카카오, TourAPI와 VISIT JEJU 키는 처음에 요구하지 않습니다.\
[배포 후 선택 연동](keys-and-integrations.md)에서 `.env`에 추가하고 전체 앱을 만든 참가자만 10장의 반영 절차를 수행합니다.

## 리허설

행사와 같은 EC2 종류, 역할, CLI 버전과 설정으로 다음을 한 차례 수행하고 각 단계의 경과 시간을 기록합니다.\
이미 완성된 운영 앱을 참가자의 결과물로 대신하지 않습니다.

1. 새 소스 또는 실제 전달할 패치에서 사전 준비와 doctor 실행
2. 03장 프롬프트로 Python 3.12 프로젝트와 검색 도구 구현
3. 짧은 실제 키 인증 모델 요청, 로컬 `agentcore dev` 응답
4. 키 게시와 AgentCore 배포 계획, 배포 완료, 새 원격 세션 응답
5. Runtime 제거 반영, 정책 연결 해제와 키 자원 정리 또는 유지 인계

설치, 코드 검사, Runtime READY와 모델 응답 완료를 나눠 기록합니다.\
호출이 실패하면 모델과 발급 리전, 오류 분류, 재개 위치만 남기고 키를 기록하지 않습니다.

패키징 실패 시 실제 `uv.lock`, Python 버전, CodeZip 진입점과 CLI 로그부터 확인합니다.\
진행 중인 배포를 중복 실행하거나 실패를 숨기도록 프롬프트를 바꾸지 않습니다.

## 수업 중 확인 시점

| 시점 | 확인할 것 | 지연 시 처리 |
|---|---|---|
| 시작 전 | 설치와 로그인, 패키지 캐시 | 설치 완료 환경으로 준비한 후 수업 시작 |
| 15분 | doctor와 `.env` 입력 | 누락 항목을 한 번에 수집, 키는 본인 터미널에서만 수정 |
| 25분 | EC2 계정과 입력 상태 | 진단이 필요한 경우에만 작은 실제 요청 실행 |
| 55분 | 검색 도구 구현 결과 | UI나 전체 인프라로 범위를 넓히지 않고 핵심 도구 마무리 |
| 80분 | Runtime 배포 상태 | 실행 중인 배포 상태 조회, 새 deploy 중복 실행 금지 |
| 100분 | 원격 응답과 출처, RESULTS.md | 남은 문제를 최대 20분 여유에서 처리 |
| 120분 | 실제 완료 범위와 자원 담당자 | 실패 단계와 재개 명령, 남은 자원 인계 |

수업 중 복사하는 핵심 프롬프트는 구현과 배포 두 개입니다.\
단계별 재승인을 반복하도록 추가하지 않고, 전달한 요청과 계정의 승인 범위에서 진행하도록 안내합니다.\
도구의 실제 승인 요청이나 자동 검토 거부는 원인을 확인합니다.

## 종료와 재개

`RESULTS.md`에는 소스/도구 버전, 수정 파일, 테스트, Runtime 상태, 실제 응답, 키 만료 시각, 남은 자원과 담당자를 기록합니다.\
실패한 단계와 미실행 단계를 통과로 표시하지 않습니다.\
기본 Runtime의 SSM 키/정책도 정리 목록에 넣습니다.

기존 폴더에서는 `create`와 `prepare`를 반복하기 전에 소유 설정과 기록을 읽습니다.\
[설치 스킬](../../skills/jeju-atlas-install/SKILL.md)의 재개 절차와 [키 갱신](keys-and-integrations.md)을 사용합니다.\
전체 앱의 부분 사본은 [PyYAML 복구](preconfiguration.md#pyyaml-누락으로-이미-사본-생성이-중단됐다면)를 따릅니다.

## 이전 관찰 기록

2026-09-15의 다른 EC2 설치에서는 Node 20, Runtime Python과 helper/AgentCore 부재가 확인되었습니다.\
같은 날짜의 서울 IAM Converse 요청은 SCP 명시적 거부로 실패했습니다.

이는 당시의 관찰이며 현재 참가자 또는 새 단기키의 성공/실패를 대신하지 않습니다.\
날짜가 있는 [검증 기록](../VALIDATION.md)과 [공개 배포 기록](../DEPLOYMENT.md)을 보존합니다.
