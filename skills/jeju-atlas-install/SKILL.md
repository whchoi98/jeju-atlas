---
name: jeju-atlas-install
description: "Use when preparing, installing, deploying, or resuming Jeju Atlas on Linux EC2, including AgentCore CLI workshop setup and full web app installation errors. 제주 아틀라스 설치·실습·복구 요청에 사용한다."
---

# 제주 아틀라스 설치

기존 워크숍 도구로 요청받은 범위를 실행하고, 재개 가능한 기록을 남긴다.
기본 응답은 한국어다. 실행 요청은 명령 목록이나 계획 설명으로 끝내지 않는다.

이 패키지의 `references/`는 이 파일을 기준으로 읽는다. 스킬을 다른 EC2의
사용자 스킬 경로에 복사해도 사용할 수 있다. 전체 저장소는 별도로 찾고,
저장소 경로를 스킬의 설치 위치와 같다고 가정하지 않는다.

## 범위 선택

| 요청 | 실행 범위 | 읽을 참조 |
|---|---|---|
| 설치 준비, 개발 환경 | 전체 소스, 전용 도구, 참가자 환경과 사전 점검 | [준비](references/prepare.md) |
| 기본 CLI 실습 | JejuGuide 구현·빌드, 승인된 키 게시·배포·최종 응답 | [기본 CLI 실습](references/deploy.md#기본-cli-실습), [모델 인증](references/model-auth.md) |
| 전체 웹 설치 | Guide/Tools, 경로 엔진, 웹과 참가자 AWS 스택 | [전체 앱](references/deploy.md#전체-앱), [모델 인증](references/model-auth.md) |
| 이어서, 복구 | 기존 기록과 실제 상태를 대조한 뒤 미완료 단계 | 아래 재개 절과 해당 단계의 참조 |

도구 설치는 수업 전에 끝낸다. 본 실습은 00–04장 **100분 + 여유 20분**이며,
05–14장 전체 앱 구축은 별도 심화 과정으로 같은 시간 안의 완료를 약속하지 않는다.
HUD는 선택 사항이며 설치·실행·진단 없이 본 실습을 완료할 수 있다.

기본 흐름은 준비 → 구현·필요한 빌드 → 배포 → 상태와 최종 응답 1회 확인이다.
경로·계정·키 상태·설정 스키마 등 해당 단계에 필요한 짧은 확인만 수행한다.
테스트 생성·전체 테스트 모음·브라우저·한영 응답·전체 검증은 기본으로 생략한다.
별도 모델 검사와 로컬 응답도 오류 진단 또는 사용자의 추가 확인 요청이 있을 때만 수행한다.
`core.py doctor --project`는 테스트 파일을 요구하므로 선택한 전체 검사에서만 사용한다.
기본 과정에 테스트 파일을 만들게 하거나 선택 검사를 완료 조건으로 추가하지 않는다.

범위가 정해지지 않은 “설치해 줘”는 로컬 준비부터 진행한다.
AWS 변경과 유료 호출의 승인이 불명확하면 로컬 준비와 변경 계획을 먼저 완료하고
필요한 입력·승인 범위만 한 번 확인한다. 같은 대화에서 승인된 계정·프로젝트·범위는
재승인을 요구하지 않는다. **스킬 이름을 언급하거나 과거 기록에 `authorization`이
있다는 이유만으로 새 외부 작업이 승인된 것으로 해석하지 않는다.**
공유 CDK bootstrap, 네트워크, 계정 전체 설정, 다른 서비스의 변경과 삭제는
참가자 앱 설치 승인에 자동 포함되지 않는다.

## 소스와 실습 작업 위치

1. 현재 폴더와 바로 아래에서 `workshop/scripts/core.py`, `workshop/scripts/lab.py`,
   `agent/tools/data/jeju_pois.json`이 있는 전체 소스를 찾고 적용되는 `AGENTS.md`를 읽는다.
   없으면 사용자 지정 위치 또는 `~/my-project/jeju-atlas`에
   `https://github.com/whchoi98/jeju-atlas.git`을 clone한다.
   새 helper와 이 패키지가 실제로 포함됐는지 확인한다. 교재 ZIP은 설치 소스가 아니다.
   기존 폴더를 덮어쓰거나 수정 사항을 자동 reset/stash하지 않는다.
2. `workshop/.local/completion-context.json`, 참가자 설정, `labs/*/RESULTS.md`와
   `activate.sh`를 먼저 확인한다. 여러 기존 프로젝트에서 재개 대상을 식별할 수 없을 때만 묻는다.
3. 참가자마다 AWS 자원 범위가 분리된 독립 랩을 전제로 한다.
   새 설치는 공통 내부 ID `team01`과 프로젝트 `AtlasCliTeam01`을 자동 사용한다.
   실제 팀 배정이 아니므로 팀명·새 ID·이름 변경을 요청하지 않는다.
   재개 시에는 기본값으로 바꾸지 않고 기존 참가자 값·프로젝트 이름·소유 설정을 유지한다.
4. 선택한 Agentic AI 코딩 어시스턴트 하나와 사전 검증된 모델·provider·인증을 사용한다.
   현재 대화가 되는 도구에 재로그인을 요구하지 않는다.
   실제 계정과 네트워크는 EC2 identity와 STS로 대조하며 다른 profile로 자동 전환하지 않는다.

## 설치에서 유지할 조건

- Node는 24 계열의 24.18.1 이상, Runtime Python은 3.12,
  npm `@aws/agentcore`는 0.28.1이다. 보조 Python은 3.12 이상을 허용한다.
  `.nvmrc`, `core.py`, requirements와 잠금 파일을 확인하고 Python starter CLI와 구분한다.
- 사전 준비는 `start.sh`가 참가자 준비·전용 도구 설치·`core.py doctor`를 수행한다.
  이 기본 진단이 성공했으면 반복하지 않는다. 환경이 바뀌거나 명령이 실패할 때만 다시 확인한다.
  **출력된 절대 `activationPath`를 같은 Bash에서 source**한 뒤 후속 작업을 한다.
  새 셸마다 다시 활성화하며, 활성화가 cwd를 저장소로 바꾼다는 점에 유의한다.
  셸 명령의 첫 줄에서 확인한 실제 작업 폴더로 `cd`하고, 활성화 뒤에도 필요한 폴더로 이동한다.
- 프로젝트가 아직 없으면 Agentic AI 코딩 어시스턴트는 `$ATLAS_CLI_PARENT`에서 시작한다.
  에이전트가 AgentCore CLI로 `$ATLAS_CLI`를 만든다. 존재하는 프로젝트에는 `create`를 반복하지 않는다.
  심화 앱은 `lab.py`와 별도 참가자 `app/`을 사용한다.
- 키는 사용자가 `workshop_env.py configure`의 숨김 입력으로 넣는다.
  기본 파일은 `$ATLAS_CLI_PARENT/.env`이며 Runtime 코드·ZIP 밖에 둔다.
  에이전트는 `status`, `run`, `publish` 등 지정 helper를 사용하고 `.env`를 직접 읽거나 source하지 않는다.
- JejuGuide 모델은 `global.anthropic.claude-sonnet-4-6`이다.
  Agentic AI 코딩 어시스턴트의 모델 고정이나 공통 인증키를 뜻하지 않는다. Bedrock 단기키는
  Runtime·모델 검사에 쓰며 배포·STS·CDK bootstrap·Runtime 호출용 IAM을 대체하지 않는다.
- 카카오·관광공사·VISIT JEJU 키는 첫 배포 뒤 선택적으로 추가한다.
  기본 Runtime의 키 전달을 심화 Guide에 자동 적용된 것으로 보고하지 않는다.
- 참가자 웹은 실제 App 스택의 기본 CloudFront HTTPS URL을 사용하고 기존 VPC/Subnet/NAT를 재사용한다.
  설치 편의를 위한 ACM·사용자 도메인·DNS 작업이나 원본 운영 계정·배포기 사용을 추가하지 않는다.
- 변경 계획의 계정과 참가자 자원을 대조한 뒤 승인 범위에서 적용한다.
  진행 중인 apply/deploy는 상태를 조회하며 중복 실행하지 않는다.
  같은 정책 거부나 실패한 유료 요청은 원인이 바뀌기 전 반복하지 않는다.

## 기존 작업 재개

기록은 탐색 단서다. 현재 파일·receipt·읽기 전용 AWS 상태와 맞춰 확인한다.

| 기록·파일 | 확인할 내용 |
|---|---|
| `completion-context.json` | 실제 소스, 참가자 app/CLI, 활성화·증거 경로와 마지막 단계 |
| 참가자 `RESULTS.md`, `evidence/` | 최신 결과, 정정 기록, 미완료 검사 |
| 앱 `.local/checks.json`, `verification.json` | 검사 시각·코드와 실패 항목 |
| 앱 `.local/image.json`, `release-pairs/` | 배포된 web/routing digest와 게시 자산 |
| CLI `scripts/agentcore-package.py` | 기존 lock·launcher 보정 wrapper가 있으면 유지 |

기존 app에 `lab.py prepare`를 반복하지 않는다. `lab.py info`의 심화용 legacy `cli/`
경로 대신 활성화의 `$ATLAS_CLI`와 실제 `agentcore/agentcore.json`을 확인한다.
완료한 데이터·빌드는 재사용하되 소스가 바뀐 산출물과 필요한 확인만 갱신한다.
선택 검사의 미실행 기록을 재개 시 자동으로 처리할 필수 작업으로 바꾸지 않는다.
오류가 있으면 실패한 명령과 원인을 확인하고 관련 진단만 수행한다.
기존 참가자 사본에만 있는 API 키 지원이나 사용자 로더를 일반 clone으로 대체하지 않는다.
키 만료는 [갱신 절차](references/model-auth.md#키-갱신과-정리)로 처리하고 배포를 무작정 다시 만들지 않는다.

## 완료와 인계

기본 실습은 `$ATLAS_CLI_PARENT/RESULTS.md`, 심화 앱은 해당 참가자의 기존 기록에 남긴다.
`completion-context.json`이 있으면 필요한 필드만 갱신한다.

- 소스 경로·커밋·추가 변경, 활성화와 app/CLI 경로, 선택한 인증 방식.
- 실행한 명령·종료 상태, 실제 배포와 최종 응답 결과. 검사를 실행했다면 그 결과.
- 조회한 App URL, Runtime·이미지·아티팩트 식별자와 최신 증거 경로.
- 미완료 필수 항목, 생략한 선택 검사, 필요한 외부 입력과 중복 생성 없이 이어갈 명령.

비밀값은 기록하지 않는다. 계정 식별자와 원본 증거는 Git 제외 `.local`에 둔다.
준비 완료, AWS 배포 완료, 실제 모델·웹 동작 완료를 구분한다.
키 없는 선택 기능, 자료 부족, 생략·시간초과는 통과로 계산하지 않는다.
필수 배포·최종 응답 실패가 남으면 완료로 선언하지 않는다.
선택 검사를 생략한 경우 확인 범위를 명시하며, 생략 자체로 기본 실습 완료를 보류하지 않는다.
