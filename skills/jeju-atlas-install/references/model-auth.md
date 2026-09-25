# 모델 인증과 키 전달

[스킬 본문](../SKILL.md)에서 모델 설정, 검사, 배포와 키 갱신을 수행할 때 읽는다.\
아래 명령은 현재 참가자 `activate.sh`를 source한 Bash에서 실행한다.\
`ATLAS_PYTHON`은 사전 구성에서 확인한 `helperPython`과 같은 실행 파일을 사용한다.

각 명령의 첫 줄에서 실패를 차단하는 `cd`로 실제 작업 폴더에 이동한다.\
기본 진행은 키 입력, 설정, SSM 연결과 배포 후 최종 응답 1회다.\
별도 모델 검사, IAM 정책 시뮬레이터와 로컬 응답 확인은 정상 흐름에 추가하지 않는다.

## 세 가지 인증을 구분한다

| 대상 | 사용하는 인증과 범위 |
|---|---|
| Agentic AI 코딩 어시스턴트 | Codex, Claude Code, Kiro CLI 각각의 사전 검증된 모델, provider와 기존 로그인 |
| AWS 제어와 Runtime 호출 | 실습 EC2의 IAM. STS, CDK bootstrap, SSM/IAM 변경, 배포와 `agentcore invoke` |
| Gateway와 Memory | 심화 Runtime 역할의 IAM |
| JejuGuide와 심화 Guide 모델 | 01장에서 처음 입력한 같은 Bedrock API 키. 모델은 `global.anthropic.claude-sonnet-4-6` |

한 Bedrock 키로 모든 Agentic AI 코딩 어시스턴트가 인증된다고 가정하지 않는다.\
키 helper는 Runtime과 선택 모델 검사에 사용한다.\
`workshop_env.py run --`으로 `codex`, `claude`, `kiro-cli`를 실행하지 않는다.

API 키는 배포와 invoke용 IAM을 대체하지 않으며 정책 거부를 우회하는 수단도 아니다.\
06장의 생성 Guide에는 같은 키 연결을 적용한다.\
직접 수정한 사용자 로더를 helper가 거부하면 기존 파일을 보존하고 차이를 확인한다.

## 숨김 입력과 상태

사용자가 자신의 대화형 Bash에서 실행한다.

```bash
cd -- "${ATLAS_CLI_PARENT:?참가자 활성화 파일을 먼저 불러오세요}" || exit 1
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/workshop_env.py" configure &&
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/workshop_env.py" status
```

기본 저장 위치는 `$ATLAS_CLI_PARENT/.env`다. helper는 다음 값을 관리한다.

단기 또는 장기 Bedrock API 키를 같은 입력과 Bearer 인증으로 사용한다.\
추가 키 유형 선택이나 만료 시각을 입력받지 않는다.

| 이름 | 입력 내용 |
|---|---|
| `AWS_BEARER_TOKEN_BEDROCK` | 숨김 입력한 Bedrock API 키 |
| `ATLAS_BEDROCK_REGION` | 단기키의 발급 리전 또는 장기키 권한으로 모델을 호출할 수 있는 리전 |

배포 리전 `ap-northeast-2`와 모델 호출 리전은 별도로 다룬다.\
06장은 사용자가 선택한 서울 `ap-northeast-2`를 모델 호출에도 사용한다.\
`status`는 키 존재 여부와 모델 호출 리전만 확인하며 키 값을 보여주지 않는다.

입력 누락을 해결한 뒤 Runtime 설정과 배포를 진행한다.\
실제 키 유효성은 Bedrock 호출 결과로 확인하며 별도 사전 호출을 추가하지 않는다.

에이전트는 `.env`를 직접 열거나 source하지 않는다.\
키는 프롬프트, 명령 인자, shell history, 코드, 로그, 배포 ZIP과 `RESULTS.md`에 넣지 않는다.

입력 helper가 대화형 터미널을 요구하면 참가자가 그 터미널에서 입력하도록 안내한다.\
키를 AI에게 보내는 방식으로 대체하지 않는다.

## 기본 Runtime 설정

AgentCore 프로젝트가 만들어진 뒤 설정한다.

```bash
cd -- "${ATLAS_CLI:?생성된 AgentCore 프로젝트 경로를 확인하세요}" || exit 1
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/model_config.py" \
  --project "$ATLAS_CLI" --env-file "$ATLAS_CLI_PARENT/.env"
```

helper는 생성된 모델 로더, Python 3.12, `PYTHON_3_12`, 모델 인증 방식과 호출 리전을 맞춘다.\
Runtime 설정에 키 원문을 넣지 않는다.

사용자 로더나 의존성 설정을 발견해 중단하면 그 차이를 검토하며 덮어쓰지 않는다.\
로컬 설정 완료는 키 전달, 배포와 응답 성공과 다르다.

## 선택 진단: 별도 모델 요청과 로컬 Runtime

정상 진행에서는 이 절을 건너뛰고 아래 SSM 연결로 이어간다.\
배포 Runtime의 모델 호출이 실패하거나 사용자가 사전 모델 진단을 요청한 경우에만 현재 승인 범위에서 다음 검사를 수행한다.\
이전 결과를 덮어쓰지 않는 새 보고서 경로를 사용한다.

```bash
cd -- "${ATLAS_CLI_PARENT:?참가자 활성화 파일을 먼저 불러오세요}" || exit 1
atlas_model_report="$ATLAS_CLI_PARENT/evidence/model-check-$(date -u +%Y%m%dT%H%M%SZ)-$$.json"
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/model_check.py" \
  --env-file "$ATLAS_CLI_PARENT/.env" \
  --report "$atlas_model_report" --execute
```

이 명령은 해당 키로 실제 Converse 요청을 한 번 수행한다.\
`--execute`가 없으면 계획이며 성공한 모델 호출로 기록하지 않는다.\
doctor, 빌드나 일반 테스트 안에서 실행하지 않는다.

실패하면 오류 분류, 리전, 키 만료와 권한을 확인하고 원인이 바뀌기 전에 반복 호출하지 않는다.\
IAM/SCP를 완화하거나 임의의 다른 리전, 모델이나 인증으로 바꿔 성공을 만들지 않는다.

로컬 재현이 필요한 오류가 있거나 사용자가 로컬 실행을 선택한 경우에만 다음을 실행한다.\
프로젝트 폴더에서 자식 프로세스에만 키를 전달한다.

```bash
cd -- "${ATLAS_CLI:?생성된 AgentCore 프로젝트 경로를 확인하세요}" || exit 1
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/workshop_env.py" run -- \
  agentcore dev --runtime JejuGuide --port 8080 --skip-deploy --no-traces --no-browser --logs
```

이 서버는 별도 터미널이나 관리 가능한 자식 프로세스로 유지한다.\
`run`은 지정한 자식의 환경에만 값을 넣으며 부모 셸이나 Agentic AI 코딩 어시스턴트 로그인을 바꾸지 않는다.\
로컬 질문은 해당 오류를 확인할 최소 횟수만 수행한다.

원격 배포와 최종 응답은 [기본 CLI 실습](deploy.md#기본-cli-실습)을 따른다.\
별도 모델 검사와 로컬 실행을 생략했다면 생략으로 기록하고 배포를 계속한다.

## 원격 Runtime의 SSM 연결

먼저 로컬 계획을 만든다.\
이 계획은 키를 읽거나 AWS에 접근하지 않는다.

```bash
cd -- "${ATLAS_CLI:?생성된 AgentCore 프로젝트 경로를 확인하세요}" || exit 1
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/workshop_env.py" publish --project "$ATLAS_CLI"
```

독립 랩의 새 설치는 공통 내부 ID `team01`과 프로젝트 `AtlasCliTeam01`을 사용한다.\
팀명을 입력받지 않는다. 아래는 그 기본 대상이며, 재개 시 실제 이름은 기존 소유 설정에서 계산한다.

| 항목 | 대상 |
|---|---|
| SSM SecureString | `/jeju-atlas-lab-team01/bedrock-api-key`, 배포 계정의 서울 리전 |
| IAM managed policy 경로와 이름 | `/jeju-atlas/AtlasCliTeam01-bedrock-key` |
| policy 권한 | 위 parameter 하나에 대한 `ssm:GetParameter` |
| 소유 태그 | 참가자, 프로젝트와 `workshop-bedrock-key` 용도 |

현재 STS 계정, 저장된 참가자 계정, `default` 배포 대상과 소유 범위를 대조한다.\
대상이 일치하면 현재 대화에서 승인된 키 게시와 정책 생성을 이어서 적용한다.

```bash
cd -- "${ATLAS_CLI:?생성된 AgentCore 프로젝트 경로를 확인하세요}" || exit 1
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/workshop_env.py" publish --project "$ATLAS_CLI" --execute
```

helper가 키를 SecureString에 게시하고 기본 Runtime의 `additionalPolicies`에 전용 policy를 연결한다.\
06장의 심화 Guide도 같은 SSM 파라미터와 policy를 사용한다.

키 관련 Runtime 환경에는 `ATLAS_BEDROCK_AUTH=api-key`와 `ATLAS_BEDROCK_API_KEY_SSM_ARN`만 전달한다.\
호출 리전은 비밀이 아닌 설정이며 키 원문은 Runtime 환경이나 배포 파일에 넣지 않는다.\
다른 참가자의 태그나 수정된 policy가 발견되면 보존하고 불일치를 해결한다.

게시만으로 Runtime이 배포되는 것은 아니다.\
같은 프로젝트에서 배포 계획을 검토하고 적용한 뒤 새 Runtime 세션의 실제 응답을 확인한다.\
키 파일 복사만으로 원격 호출이 된다고 기록하지 않는다.

## 키 갱신과 정리

실제 호출에서 키 만료가 확인되면 `configure`로 원본 `.env`의 키와 리전을 갱신한다.\
승인된 동일 참가자 범위에서 `publish --execute` 또는 심화용 `agent-key --execute`를 사용한다.\
둘은 같은 SSM 파라미터를 갱신하므로 키를 따로 입력하거나 두 게시 명령을 모두 수행할 필요는 없다.

같은 ARN의 키 값만 바뀌면 공유 policy를 재사용하며 소스 재빌드와 재배포가 필요하지 않다.\
새로 생성되는 모델 클라이언트는 갱신된 SSM 버전을 읽는다.\
진행 중인 요청이나 이미 생성된 모델 인스턴스가 자동으로 바뀐다고 보장하지 않는다.

리전, 역할, 로더나 Runtime 환경도 바뀌었다면 해당 변경을 배포한다.\
심화 Guide는 원본 `.env` 리전과 설정의 `bedrockCallerRegion`이 같아야 한다.

키 정리가 요청되면 기본 JejuGuide 역할과 심화 GuideRole **양쪽의 policy 연결 해제**를 확인한다.\
기본 Runtime만 삭제한 상태에서 공유 키를 지우지 않는다.

심화 Guide를 배포하지 않았다면 기본 역할의 연결 해제를 확인한다.

같은 기본 프로젝트에서 `agentcore remove agent --name JejuGuide --yes --json`으로 로컬 정의를 제거한다.\
`agentcore deploy --target default --dry-run`을 검토한 뒤 `deploy`로 삭제를 적용한다.\
심화 Guide의 정리 또는 policy 연결 해제도 실제로 완료된 **뒤에만** 다음을 진행한다.

```bash
cd -- "${ATLAS_CLI:?정리할 기존 AgentCore 프로젝트 경로를 확인하세요}" || exit 1
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/workshop_env.py" cleanup --project "$ATLAS_CLI" &&
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/workshop_env.py" cleanup --project "$ATLAS_CLI" --execute
```

helper의 기존 IAM 연결 검사는 policy가 역할, 사용자나 그룹에 붙어 있으면 조기 삭제를 차단한다.\
소유 태그도 확인하며 기본 `.env`, 공유 bootstrap, 네트워크와 다른 프로젝트는 유지한다.\
로컬 정의나 폴더만 삭제하고 AWS 정리 완료로 보고하지 않는다.

## 외부 연동과 심화 Guide

첫 배포 뒤 필요할 때만 `configure --integrations`로 외부 키를 입력한다.\
이 키의 심화 앱 전달은 [외부 연동](deploy.md#배포-후-외부-연동)을 따른다.

06장의 Guide는 **01장에서 처음 입력한 같은 API 키**를 `lab.py agent-key`로 연결한다.\
기존 core 세션과 참가자 app을 사용하고 키 재입력이나 `.env` 복사를 요구하지 않는다.\
사용자가 선택한 모델 호출 리전은 서울 `ap-northeast-2`다.

```bash
cd -- "${ATLAS_REPO:?참가자 활성화 파일을 먼저 불러오세요}" || exit 1
"$ATLAS_PYTHON" -B workshop/scripts/lab.py model-region \
  --config "$ATLAS_CONFIG" --caller-region ap-northeast-2 &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py agent-key --config "$ATLAS_CONFIG" --execute
```

`--execute`가 없으면 키를 읽거나 AWS를 호출하지 않는 로컬 미리보기다.\
선택 옵션 `--env-file "$ATLAS_CLI_PARENT/.env"`는 반드시 01장의 원본 참가자 파일을 가리켜야 한다.

실행 시 helper가 소유 core 세션과 app, 현재 AWS 계정을 검증한 뒤 원본 `.env`를 데이터로 읽는다.\
파일의 `ATLAS_BEDROCK_REGION`과 설정의 `bedrockCallerRegion`이 같아야 진행한다.\
불일치하면 원본 경로와 키의 사용 가능 리전을 확인하고 기존 상태를 보존한다.

04장의 같은 SSM `/jeju-atlas-lab-team01/bedrock-api-key`에 키를 게시하거나 기존 연결을 재사용한다.\
같은 `/jeju-atlas/AtlasCliTeam01-bedrock-key` policy를 `GuideRole.ManagedPolicyArns`에 연결한다.\
권한은 해당 파라미터 한 개의 `ssm:GetParameter`이며 Bedrock 모델 IAM 권한을 넓히지 않는다.

helper는 app의 기존 `agent/guide/model/load.py`, 새 `agent/guide/model/workshop_auth.py`와 `infra/agentcore.yaml`을 반영한다.\
변경할 기존 파일은 비공개 `app/.local`에 백업한다.\
직접 수정한 사용자 로더는 덮어쓰지 않고 중단하며, 오류 시 원본 소스와 app 상태를 보존한다.

키 관련 Runtime 환경은 `ATLAS_BEDROCK_AUTH=api-key`와 `ATLAS_BEDROCK_API_KEY_SSM_ARN`만 사용한다.\
키 원문을 Runtime 환경이나 배포 파일에 넣지 않는다.\
새 모델 클라이언트는 SecureString을 읽어 Bedrock에만 Bearer 인증을 사용하고 IAM 모델 인증으로 대체하지 않는다.

Gateway, Memory, 제어 작업과 Runtime 인바운드 호출의 IAM/SigV4는 유지한다.\
과거 IAM 서울 호출의 SCP 거부는 당시 실패 기록으로 보존하며 현재 API 키 호출 성공으로 바꿔 기록하지 않는다.

정상 순서는 `model-region → agent-key → agent-build → agent-publish → agent-plan`이다.\
이어서 계획 완료 후 `agent-apply`, 스택 완료까지 `agent-status`, 완료 후 로그 설정을 각각 수행한다.\
상세 명령과 완료 조건은 [전체 앱 배포](deploy.md#전체-앱)를 따른다.

이미 배포된 IAM Guide는 소스 루트에서 `git pull --ff-only origin main` 뒤 같은 연결과 코드 재배포를 수행한다.\
`lab.py prepare`, 의존성 ZIP 재빌드, 스택 재생성과 키 재입력은 하지 않는다.\
소스 갱신이나 helper 오류를 reset, 삭제나 재준비로 우회하지 않는다.

배포 상태는 실제 모델 응답 성공과 구분한다.\
웹 최종 응답은 12장이나 전체 앱 완료 단계에서 확인한다.\
Runtime 직접 호출과 추가 스트리밍 검사는 오류 진단 또는 사용자 요청 시에만 수행한다.
