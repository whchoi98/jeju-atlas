# 06. 실제 제주 가이드 AgentCore 배포

이 장은 120분 본 실습 이후에 선택하는 심화 자료입니다.

저장소의 `agent/guide`와 `agent/tools`로 Guide, Tools, Gateway, Memory를 배포합니다.\
기본 과정에서 만든 CLI 프로젝트와 별도 소유 스택으로 배포합니다.

## 구성

| 구성 | 역할 |
|---|---|
| Guide | Strands, 한영 질문, 도구 예산, 스트리밍, 구조화 응답 |
| Tools | 장소, 주변 검색, 공식 상세, 날씨, 코스 등의 MCP 도구 |
| Gateway | IAM 인증으로 자기 Tools Runtime에 연결 |
| Memory | facts, preferences, summaries, episodes, 30일 event 만료 |
| 모델 | Global Sonnet 4.6, 주최자가 확인한 Bedrock 호출 리전 |
| 관측 | 메타데이터 중심 OTel, 입력, 답변 내용 capture 비활성화 |

AgentCore는 관리형 `PUBLIC` 네트워크와 IAM 인증을 사용합니다.\
ECS를 Private Subnet에 배치하는 설정과 구분합니다.\
`JejuAtlasTools`는 각 Gateway 안의 대상 이름이며 같은 Gateway를 공유하는 뜻이 아닙니다.

## 시작 전 준비

[05장의 심화 작업 폴더 준비](05-foundation-and-data.md#심화-작업-폴더-준비)와 Data 스택 생성, 카탈로그 게시를 완료한 Bash에서 이어 갑니다.\
`Prepare the participant workspace first`가 나오면 05장의 작업 사본 준비부터 마칩니다.

이 심화 Runtime은 IAM으로 모델을 호출하며, 01장의 `.env` API 키 설정이 자동 적용되지 않습니다.\
주최자가 Sonnet과 선택한 호출 리전에 맞는 Runtime 역할 권한을 검토해야 합니다.\
검토한 호출 리전을 아직 심화 설정에 기록하지 않았다면 아래 명령을 한 번 실행합니다.

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
read -r -p "주최자가 확인한 심화 Runtime의 Bedrock 호출 리전: " atlas_bedrock_region &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py model-region \
  --config "$ATLAS_CONFIG" --caller-region "$atlas_bedrock_region"
}
```
이 명령은 참가자 설정의 `bedrockCallerRegion`만 저장합니다.\
모델을 호출하거나 IAM을 변경하지 않으며, 이미 기록한 리전은 다시 입력할 필요가 없습니다.\
`modelAccessVerified: false`는 이 명령이 모델 호출을 검증하지 않았다는 뜻입니다.

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

같은 소스와 잠금 버전으로 만든 소유 의존성 ZIP이 이미 게시되어 있으면 재사용합니다.\
명령 사이의 `&&`는 앞 명령이 실패했을 때 다음 명령을 실행하지 않게 합니다.

ZIP의 Python 실행 파일은 빌드 호스트 가상환경 경로를 사용하지 않도록 정규화합니다.\
원래 빌드 환경을 제거한 뒤에도 launcher가 실행되는지 로컬 재배치 검사로 확인합니다.

## 앱 코드 패키징, 배포

**계획 생성 → 실제 배포 시작 → 스택 완료 확인 → 로그 설정** 순서로 진행합니다.\
아래 네 단계를 각각 실행하고, 출력에 적힌 다음 진행 조건을 확인합니다.

### 1. 코드 빌드와 게시, 배포 계획 생성

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run agent-build --config "$ATLAS_CONFIG" --execute &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run agent-publish --config "$ATLAS_CONFIG" --execute &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run agent-plan --config "$ATLAS_CONFIG" --execute
}
```
이 블록은 코드 ZIP을 만들고 S3에 게시한 뒤 CloudFormation 변경 세트를 생성합니다.\
**실제 Runtime 배포는 아직 시작하지 않습니다. 기다려도 다음 단계가 자동 실행되지 않습니다.**

마지막 `agent-plan` 출력의 `status`가 `CREATE_COMPLETE`이면 **배포 계획 준비 완료**입니다.\
계획의 `resources`에서 새 Runtime 두 개, Memory, Gateway/target와 각 역할을 확인한 뒤 2번으로 진행합니다.\
기존 Runtime, Memory 교체나 다른 프로젝트 변경이 있으면 적용하지 않습니다.\
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
배포 대상은 서울에 유지하고 `BedrockCallerRegion` 매개변수로 별도 `ATLAS_BEDROCK_REGION`을 Runtime에 전달합니다.\
이 장의 [시작 전 준비](#시작-전-준비)에서 `lab.py model-region`으로 주최자가 확인한 값을 기록합니다.

계정의 모델 접근, 서비스 가용성, Global CRIS IAM 정책을 확인해야 합니다.\
목록 조회만으로 호출 성공을 보장하지 않습니다.\
`agent/guide/model/load.py`의 BedrockModel과 모델별 reasoning 설정을 확인합니다.

기존 설정을 확인하지 않고 모델 ID만 교체하지 않습니다.\
준비기는 참가자 사본의 모델 기본값과 Runtime 환경만 Sonnet으로 바꿉니다.\
운영 원본의 모델과 IAM/SCP는 변경하지 않습니다.

기존 GuideRole의 모델 권한도 자동 확장하지 않습니다.\
EC2에서의 Converse 성공이 Runtime 역할의 권한을 대신하지 않습니다.\
현재 기록된 서울 실측은 SCP 명시적 거부이며 성공한 호출 리전은 아직 배정되지 않았습니다.

실제 여행 질문과 도구, Memory 동작은 웹을 연결한 뒤 12장에서 확인합니다.\
Runtime READY만으로 여행 답변까지 검증됐다고 기록하지 않습니다.

## 중단된 위치에서 재개

| 중단된 지점 | 이어서 할 작업 |
|---|---|
| `agent-build` 또는 `agent-publish` 오류 | 첫 오류부터 해결하고 실패한 명령 이후만 이어 갑니다. 소스와 잠금 버전이 그대로라면 성공한 빌드를 반복하지 않습니다. |
| `agent-plan` 오류 | 마지막 오류와 필요한 입력을 확인합니다. 원인을 해결한 뒤 소스와 게시물이 그대로이면 `agent-plan`부터 재개합니다. |
| `agent-plan`의 `PENDING` | 변경 세트 생성 대기 시간이 끝난 상태입니다. 아래 안내에 따라 기존 변경 세트 상태를 확인합니다. |
| 계획 준비 완료, 아직 `agent-apply` 미실행 | 2번에서 실제 배포를 시작합니다. 1번 전체를 다시 실행하지 않습니다. |
| 배포 시작 후 진행 중 | 3번의 상태 조회만 반복합니다. 새 계획이나 배포를 중복 실행하지 않습니다. |
| 스택 완료, 로그 설정만 미완료 | 3번으로 완료 상태와 출력을 확인한 뒤 4번부터 이어 갑니다. |

`PENDING`이면 `agent-plan`이 출력한 `changeSetId`의 변경 세트를 CloudFormation 콘솔에서 확인합니다.\
변경 세트 상태가 `CREATE_COMPLETE`, 실행 상태가 `AVAILABLE`이고 변경 대상이 본인 자원일 때 2번으로 진행합니다.\
계속 생성 중이면 해당 변경 세트 상태만 다시 확인하고, `FAILED`이면 표시된 실패 이유를 해결합니다.\
이때 스택의 `REVIEW_IN_PROGRESS`만으로 계획 준비 완료를 판단하지 않습니다.

`Provide an explicit organizer-verified Bedrock caller region` 오류는 [시작 전 준비](#시작-전-준비)의 호출 리전 기록부터 확인합니다.\
명령을 실행했다는 사실만으로 성공했다고 판단하지 않고 마지막 출력과 종료 상태를 확인합니다.

게시 후 소스가 바뀌면 해당 코드의 build → publish → plan을 다시 수행합니다.\
의존성 staging이 존재하면 덮어쓰지 않고, 로그 확인 후 해당 참가자의 로컬 staging만 정리합니다.\
생성 실패 후 남은 Memory는 소유 ID부터 확인합니다.\
모델 접근 오류는 계정과 Runtime 역할, 모델 접근 설정을 확인하고 IAM/SCP를 임의로 변경하지 않습니다.

- [ ] 두 Runtime과 Gateway, Memory가 완료되었습니다.
- [ ] 웹에 전달할 출력이 내 자원만 가리킵니다.
- [ ] 로그 보관과 내용 capture 설정을 확인했습니다.

Agentic AI 코딩 어시스턴트 프롬프트: [06, 실제 AgentCore](../prompts/06-atlas-agentcore.md)

다음: [07, 실제 경로와 고도](07-routing.md)
