# 06. 실제 제주 가이드 AgentCore 배포

이 장은 120분 본 실습 이후에 선택하는 심화 자료입니다.

저장소의 `agent/guide`와 `agent/tools`로 Guide, Tools, Gateway, Memory를 배포합니다.\
기본 과정에서 만든 CLI 프로젝트와 별도 소유 스택으로 배포합니다.\
Guide는 **01장에서 처음 입력한 것과 같은 Bedrock API 키**를 사용합니다.

## 구성

| 구성 | 역할 |
|---|---|
| Guide | Strands, 한영 질문, 도구 예산, 스트리밍, 구조화 응답 |
| Tools | 장소, 주변 검색, 공식 상세, 날씨, 코스 등의 MCP 도구 |
| Gateway | IAM 인증으로 자기 Tools Runtime에 연결 |
| Memory | facts, preferences, summaries, episodes, 30일 event 만료 |
| 모델 | Global Sonnet 4.6, 서울(`ap-northeast-2`) 호출 리전 |
| 관측 | 메타데이터 중심 OTel, 입력, 답변 내용 capture 비활성화 |

AgentCore는 관리형 `PUBLIC` 네트워크와 IAM 인바운드 인증을 사용합니다.\
Guide의 Bedrock 모델 호출만 API 키의 Bearer 인증을 사용합니다.\
Gateway, Memory와 AWS 제어 작업은 계속 IAM으로 인증합니다.

ECS를 Private Subnet에 배치하는 설정과 구분합니다.\
`JejuAtlasTools`는 각 Gateway 안의 대상 이름이며 같은 Gateway를 공유하는 뜻이 아닙니다.

## 시작 전 준비

[05장의 심화 작업 폴더 준비](05-foundation-and-data.md#심화-작업-폴더-준비)와 Data 스택 생성, 카탈로그 게시를 완료한 Bash에서 이어 갑니다.\
`ATLAS_PYTHON`은 사전 구성에서 확인한 `helperPython`을 사용합니다.\
새 Bash에서는 기존 `activate.sh`로 경로와 도구를 복원합니다.

`Prepare the participant workspace first`가 나오면 05장의 준비 상태를 확인합니다.\
이미 있는 app은 보존하고 `lab.py prepare`를 반복하지 않습니다.

키는 01장의 원본 **`$ATLAS_CLI_PARENT/.env`**에서 가져옵니다.\
키를 다시 입력하거나 app에 `.env`를 복사하지 않습니다.\
`agent-key`가 파일을 데이터로 읽으며 `source .env`를 실행하지 않습니다.

이 장은 선택한 **서울 리전(`ap-northeast-2`)**에서 배포하고 모델을 호출합니다.\
아래 1번의 `model-region`이 참가자 설정의 `bedrockCallerRegion`을 서울로 저장합니다.\
원본 `.env`의 `ATLAS_BEDROCK_REGION`도 이 값과 같아야 `agent-key`가 진행합니다.

리전이 다르면 원본 파일 경로와 키를 사용할 수 있는 리전을 확인합니다.\
리전 설정만 바꿔 키의 사용 가능 범위가 바뀌는 것은 아닙니다.\
이미 배포한 IAM Guide는 [기존 IAM Guide 전환](#기존-iam-guide를-같은-api-키로-전환)으로 이어갑니다.

## 새 의존성 ZIP

커밋된 `uv.lock`에서 ARM64/Python 3.14 wheel을 설치해 새 ZIP을 만듭니다.\
운영 버킷의 기존 ZIP은 필요하지 않습니다.

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
"$ATLAS_PYTHON" -B workshop/scripts/lab.py deps-build --config "$ATLAS_CONFIG" --execute &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py deps-publish --config "$ATLAS_CONFIG" --execute
}
```
build는 로컬 파일, 공개 패키지 다운로드를, publish는 소유 S3만 사용합니다.\
소유 태그, 비공개 설정, 버전 관리를 확인하고 새 객체 버전과 SHA-256을 `agent/dependency-artifacts.json`에 기록합니다.\
가짜 VersionId를 넣지 않습니다.

같은 의존성 잠금 버전으로 만든 소유 ZIP이 이미 게시되어 있으면 재사용합니다.\
명령 사이의 `&&`는 앞 명령이 실패했을 때 다음 명령을 실행하지 않게 합니다.

ZIP의 Python 실행 파일은 빌드 호스트 가상환경 경로를 사용하지 않도록 정규화합니다.\
원래 빌드 환경을 제거한 뒤에도 launcher가 실행되는지 로컬 재배치 검사로 확인합니다.

## 앱 코드 패키징, 배포

**계획 생성 → 실제 배포 시작 → 스택 완료 확인 → 로그 설정** 순서로 진행합니다.\
아래 네 단계를 각각 실행하고, 출력에 적힌 다음 진행 조건을 확인합니다.

### 1. 코드 빌드와 게시, 배포 계획 생성

**서울 호출 리전 저장 → 같은 키 연결 → 코드 빌드 → 게시 → 계획 생성** 순서입니다.

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
"$ATLAS_PYTHON" -B workshop/scripts/lab.py model-region \
  --config "$ATLAS_CONFIG" --caller-region ap-northeast-2 &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py agent-key --config "$ATLAS_CONFIG" --execute &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run agent-build --config "$ATLAS_CONFIG" --execute &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run agent-publish --config "$ATLAS_CONFIG" --execute &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run agent-plan --config "$ATLAS_CONFIG" --execute
}
```
`agent-key --execute`는 소유 core 세션과 app, 현재 AWS 계정을 확인합니다.\
원본 `.env`의 리전과 설정이 일치하면 같은 키를 다음 공유 자원에 게시하거나 기존 연결을 재사용합니다.

| 04장과 함께 사용하는 자원 | 이름과 범위 |
|---|---|
| SSM SecureString | `/jeju-atlas-lab-team01/bedrock-api-key` |
| IAM managed policy | `/jeju-atlas/AtlasCliTeam01-bedrock-key`, 위 파라미터 한 개의 `ssm:GetParameter` |

정책을 참가자 app의 `GuideRole.ManagedPolicyArns`에 연결합니다.\
GuideRole의 Bedrock 모델 IAM 권한은 확장하지 않습니다.

helper는 app의 기존 `agent/guide/model/load.py`, 새 `agent/guide/model/workshop_auth.py`와 `infra/agentcore.yaml`을 반영합니다.\
변경할 기존 로컬 파일은 비공개 `app/.local` 아래에 백업합니다.\
직접 수정한 사용자 로더는 덮어쓰지 않고 중단하며, 오류 시 원본 소스와 기존 app 상태를 보존합니다.

`--execute`를 빼면 키를 읽거나 AWS를 호출하지 않는 로컬 미리보기입니다.\
선택 옵션 `--env-file "$ATLAS_CLI_PARENT/.env"`도 01장의 원본 참가자 파일만 가리켜야 합니다.

키 연결 뒤 코드 ZIP을 빌드하고 S3 게시와 CloudFormation 변경 세트 생성을 수행합니다.\
`model-region`의 `modelAccessVerified: false`는 설정 저장 시 모델을 호출하지 않았다는 뜻입니다.

**실제 Runtime 배포는 아직 시작하지 않습니다. 기다려도 다음 단계가 자동 실행되지 않습니다.**

마지막 `agent-plan` 출력의 `status`가 `CREATE_COMPLETE`이면 **배포 계획 준비 완료**입니다.\
새 배포는 `resources`에서 Runtime 두 개, Memory, Gateway/target와 각 역할을 확인합니다.\
기존 Guide 전환은 같은 스택의 코드, Guide 역할과 환경 변경을 확인한 뒤 2번으로 진행합니다.

기존 Runtime이나 Memory 교체, 다른 프로젝트 변경이 있으면 적용하지 않습니다.\
`PENDING`이나 오류가 나오면 아래 [중단된 위치에서 재개](#중단된-위치에서-재개)를 먼저 확인합니다.

### 2. 실제 배포 시작

1번의 계획 생성이 성공하고 변경 대상이 본인 자원임을 확인한 뒤 실행합니다.

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run agent-apply --config "$ATLAS_CONFIG" --execute
}
```
`"execution": "started"`가 나오면 실제 스택 배포를 시작한 것입니다.\
배포 완료를 뜻하지 않으므로 3번에서 상태를 조회합니다.\
배포가 진행 중일 때는 `agent-apply`를 다시 실행하지 않습니다.

### 3. 스택 완료까지 상태 조회

아래 블록은 상태 조회만 수행합니다.\
처음 한 번 실행하고, 배포 진행 중이면 잠시 기다린 뒤 **이 블록만 다시 실행**합니다.

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run agent-status --config "$ATLAS_CONFIG" --execute
}
```

| 마지막 `agent-status` 출력 | 의미와 다음 단계 |
|---|---|
| `NOT_CREATED` | 해당 스택이 없습니다. 1번의 마지막 `agent-plan` 출력과 현재 참가자 설정을 확인합니다. 기다리거나 로그 설정을 반복하지 않습니다. |
| `REVIEW_IN_PROGRESS` | 스택 자원을 생성하기 전입니다. 계획이 `CREATE_COMPLETE`인지 확인한 뒤 2번의 `agent-apply`를 실행합니다. |
| `CREATE_IN_PROGRESS`, `UPDATE_IN_PROGRESS`, `UPDATE_COMPLETE_CLEANUP_IN_PROGRESS` | 배포가 진행 중입니다. 기다린 뒤 3번의 `agent-status`만 다시 실행합니다. |
| `CREATE_COMPLETE`, `UPDATE_COMPLETE` | 스택 배포가 완료되었습니다. 출력 자원을 확인한 뒤 4번으로 진행합니다. |
| `CREATE_FAILED`, `UPDATE_FAILED` 또는 `ROLLBACK`이 포함된 상태 | 실패 원인과 CloudFormation 스택 이벤트를 확인합니다. 로그 설정으로 넘어가지 않습니다. |

**`agent-plan`의 `CREATE_COMPLETE`는 계획 준비 완료이고, `agent-status`의 `CREATE_COMPLETE`는 스택 생성 완료입니다.**\
조회 명령의 종료 코드가 0이어도 스택이 완료된 것은 아닙니다.

스택 완료 후 `agent-status`가 참가자 app의 `.local/atlas-agent-outputs.json`을 작성합니다.\
두 Runtime ARN, Gateway, Memory, 카탈로그가 내 자원인지 확인하고 다음 단계로 진행합니다.

### 4. 완료 후 로그 보관 설정

3번의 스택 상태가 **`CREATE_COMPLETE` 또는 `UPDATE_COMPLETE`일 때만** 실행합니다.

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run agent-configure-logs --config "$ATLAS_CONFIG" --execute
}
```
이 명령은 스택 출력, 코드 버킷, 실행 역할을 대조하고 내 Runtime 로그 두 개에만 14일 보관을 적용합니다.\
기존 Ohmyjeju나 운영 Atlas 로그를 변경하지 않습니다.

`Complete the independent stack before configuring runtime logs`가 나오면 3번의 상태 조회로 돌아갑니다.\
빌드와 게시 전체를 다시 수행하거나 로그 설정만 반복하지 않습니다.

## 모델 설정

```text
ATLAS_MODEL_FAST=global.anthropic.claude-sonnet-4-6
ATLAS_MODEL_DEEP=global.anthropic.claude-sonnet-4-6
ATLAS_MODEL_ROUTING=auto
ATLAS_THINKING=disabled
ATLAS_THINKING_DEEP=disabled
```

배포된 Bedrock 호출용 ID이며 Codex의 모델 설정을 바꾸는 값이 아닙니다.\
배포 리전과 모델 호출 리전은 모두 서울(`ap-northeast-2`)입니다.\
`lab.py model-region --caller-region ap-northeast-2`로 저장한 값을 `BedrockCallerRegion` 매개변수와 `ATLAS_BEDROCK_REGION` 환경 변수로 Runtime에 전달합니다.

키 관련 Runtime 환경에는 **`ATLAS_BEDROCK_AUTH=api-key`**와 **`ATLAS_BEDROCK_API_KEY_SSM_ARN`**만 전달합니다.\
키 원문은 Runtime 환경, 템플릿, 코드 ZIP이나 로그에 넣지 않습니다.\
모델 로더는 SSM SecureString을 복호화해 읽고 Bedrock 요청에만 Bearer 인증을 사용합니다.

키 조회나 인증이 실패해도 IAM 모델 인증으로 대체하지 않습니다.\
Gateway, Memory, 제어 작업과 Runtime 인바운드 호출의 IAM 인증은 유지합니다.

정상 진행에는 별도 모델 사전 호출이나 IAM 정책 시뮬레이터를 추가하지 않습니다.\
실제 호출 오류가 나면 키의 사용 가능 리전, 모델 권한과 오류를 확인합니다.\
운영 원본의 모델이나 IAM/SCP를 오류 회피 목적으로 변경하지 않습니다.

과거 IAM 모델 호출에서 발생한 서울 SCP 거부는 당시 검증 기록으로 보존합니다.\
현재 실습 계정에서 같은 API 키로 호출한 결과와 구분합니다.

실제 여행 질문과 도구, Memory 동작은 웹을 연결한 뒤 12장에서 확인합니다.\
Runtime READY만으로 여행 답변까지 검증됐다고 기록하지 않습니다.

## 중단된 위치에서 재개

| 중단된 지점 | 이어서 할 작업 |
|---|---|
| `agent-key` 오류 | core 세션과 app 소유, 계정, 원본 `.env` 경로와 리전, 사용자 로더 여부를 확인합니다. 원본 소스와 app을 보존하고 불일치를 해결합니다. |
| `agent-build` 또는 `agent-publish` 오류 | 첫 오류부터 해결하고 실패한 명령 이후만 이어 갑니다. 소스와 잠금 버전이 그대로라면 성공한 빌드를 반복하지 않습니다. |
| `agent-plan` 오류 | 마지막 오류와 필요한 입력을 확인합니다. API 키 연결이 반영된 소스와 게시물이 그대로이면 `agent-plan`부터 재개합니다. |
| `agent-plan`의 `PENDING` | 변경 세트 생성 대기 시간이 끝난 상태입니다. 아래 안내에 따라 기존 변경 세트 상태를 확인합니다. |
| 계획 준비 완료, 아직 `agent-apply` 미실행 | 2번에서 실제 배포를 시작합니다. 1번 전체를 다시 실행하지 않습니다. |
| 배포 시작 후 진행 중 | 3번의 상태 조회만 반복합니다. 새 계획이나 배포를 중복 실행하지 않습니다. |
| 스택 완료, 로그 설정만 미완료 | 3번으로 완료 상태와 출력을 확인한 뒤 4번부터 이어 갑니다. |

`PENDING`이면 `agent-plan`이 출력한 `changeSetId`의 변경 세트를 CloudFormation 콘솔에서 확인합니다.\
변경 세트 상태가 `CREATE_COMPLETE`, 실행 상태가 `AVAILABLE`이고 변경 대상이 본인 자원일 때 2번으로 진행합니다.\
계속 생성 중이면 해당 변경 세트 상태만 다시 확인하고, `FAILED`이면 표시된 실패 이유를 해결합니다.\
이때 스택의 `REVIEW_IN_PROGRESS`만으로 계획 준비 완료를 판단하지 않습니다.

### 서울 리전 설정 후 계획 재개

과거 `Provide an explicit organizer-verified Bedrock caller region` 오류로 중단했다면 키 연결이 반영된 산출물인지 먼저 확인합니다.\
`agent-key` 적용 전 빌드라면 [1번](#1-코드-빌드와-게시-배포-계획-생성)의 `model-region → agent-key → agent-build → agent-publish → agent-plan`을 수행합니다.\
IAM 로더로 만든 ZIP을 그대로 다시 계획하지 않습니다.

서울 설정과 원본 `.env` 리전이 일치하고 같은 키 연결을 반영해 게시했다면 소스, 역할과 환경 설정을 확인합니다.\
모두 그대로이면 `agent-plan`부터 재개합니다.\
계획이 `CREATE_COMPLETE`이고 변경 대상이 본인 자원이면 [2번](#2-실제-배포-시작)으로 진행합니다.\
`PENDING`이면 기존 변경 세트 상태를 확인합니다.

### 기존 IAM Guide를 같은 API 키로 전환

소스 루트에서 helper를 갱신한 뒤 기존 app에 키 연결을 적용합니다.\
`lab.py prepare`, 의존성 ZIP 재빌드, 스택 재생성과 키 재입력은 필요하지 않습니다.\
기존 소유 의존성 ZIP과 참가자 설정을 유지합니다.

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
git pull --ff-only origin main &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py model-region \
  --config "$ATLAS_CONFIG" --caller-region ap-northeast-2 &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py agent-key --config "$ATLAS_CONFIG" --execute &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run agent-build --config "$ATLAS_CONFIG" --execute &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run agent-publish --config "$ATLAS_CONFIG" --execute &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run agent-plan --config "$ATLAS_CONFIG" --execute
}
```

소스 갱신이나 helper가 실패하면 그 위치에서 멈추고 원본 소스와 app을 보존합니다.\
삭제, reset, 재준비로 사용자 변경을 덮어쓰지 않습니다.

역할, Runtime 환경과 소스 변경은 재배포해야 적용됩니다.\
계획 준비가 완료되면 [2번 apply](#2-실제-배포-시작)와 [3번 status](#3-스택-완료까지-상태-조회)를 각각 수행합니다.\
스택이 완료된 뒤에만 [4번 로그 설정](#4-완료-후-로그-보관-설정)으로 이어갑니다.

### SSM 키 값만 갱신

만료 등으로 키를 갱신할 때는 [원본 키 갱신 절차](../reference/keys-and-integrations.md#만료되거나-리전을-바꿨을-때)를 따릅니다.\
같은 파라미터 ARN의 키 값만 바뀌면 공유 정책을 재사용하며 소스 재빌드나 재배포가 필요하지 않습니다.\
역할, Runtime 환경이나 소스가 바뀌면 해당 변경을 다시 배포합니다.

새로 생성되는 모델 클라이언트는 갱신된 SSM 버전을 읽습니다.\
진행 중인 요청이나 이미 생성된 모델 인스턴스가 자동으로 바뀐다고 보장하지 않습니다.

게시 후 소스가 바뀌면 해당 코드의 build → publish → plan을 다시 수행합니다.\
의존성 staging이 존재하면 덮어쓰지 않고, 로그 확인 후 해당 참가자의 로컬 staging만 정리합니다.\
생성 실패 후 남은 Memory는 소유 ID부터 확인합니다.

공유 키를 정리할 때는 기본 JejuGuide 역할과 심화 GuideRole **양쪽에서 정책 연결이 해제될 때까지** 기다립니다.\
기존 IAM 연결 검사가 조기 삭제를 차단합니다.\
[키 자원 정리](../reference/keys-and-integrations.md#키-자원-정리)의 순서를 따릅니다.

- [ ] 두 Runtime과 Gateway, Memory가 완료되었습니다.
- [ ] Guide의 공유 SSM 정책과 API 키 인증 환경이 배포에 반영되었습니다.
- [ ] 웹에 전달할 출력이 내 자원만 가리킵니다.
- [ ] 로그 보관과 내용 capture 설정을 확인했습니다.

하단 프롬프트로 진행하면 본문 명령을 중복 실행하지 않아도 됩니다.\
[프롬프트 진행 안내](00-orientation.md#하단-프롬프트로-진행하는-방법)를 참고하고 이미 완료한 작업은 유지합니다.

Agentic AI 코딩 어시스턴트 프롬프트: [06, 실제 AgentCore](../prompts/06-atlas-agentcore.md)

다음: [07, 실제 경로와 고도](07-routing.md)
