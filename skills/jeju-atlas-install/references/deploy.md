# 기본 실습과 전체 앱 배포

[스킬 본문](../SKILL.md)에서 선택한 배포와 재개 범위에 해당하는 절만 읽는다.\
모델 작업 전 [모델 인증](model-auth.md)을 읽고 현재 대화의 외부 작업 승인 범위를 적용한다.\
준비가 남았으면 [사전 준비](prepare.md)를 수행한다.

저장소 문서 경로는 발견한 `$ATLAS_REPO` 기준이다.\
셸 작업은 첫 줄에서 실패를 차단하는 `cd`로 실제 저장소, 부모 또는 프로젝트 폴더에 이동한다.\
새 셸에서는 절대 활성화 파일을 source하고 명령에 맞는 작업 폴더로 다시 이동한다.

helper는 사전 구성의 `helperPython`과 같은 `"$ATLAS_PYTHON" -B`를 사용한다.\
독립 랩의 새 설치는 내부 ID `team01`, 프로젝트 `AtlasCliTeam01`을 자동 사용한다.\
팀명을 선택하거나 새 ID를 만들게 하지 않으며 재개 시 기존 값을 보존한다.

HUD, 전체 테스트, 브라우저와 한영 응답 등 추가 검증은 필요할 때만 선택한다.\
별도 모델 사전 호출이나 IAM 정책 시뮬레이터를 정상 진행에 추가하지 않는다.

## 기본 CLI 실습

본 실습은 00–04장 100분과 여유 20분이다.\
결과물은 검색 도구와 실제 모델을 사용하는 참가자 전용 JejuGuide Runtime이다.\
전체 지도 앱 구축은 이 시간의 완료 기준에 포함하지 않는다.

세부 구현과 명령은 전체 소스의 다음 카드에서 읽는다.\
설치된 스킬 폴더를 기준으로 이 경로들을 찾지 않는다.

| 카드 경로 | 적용할 내용 |
|---|---|
| `workshop/prompts/02-aws-environment.md` | EC2 신원과 STS 계정, 참가자 설정과 키 상태 |
| `workshop/prompts/03-codex.md` | AgentCore 생성, 샘플 기반 검색 도구, Python 3.12와 설정 스키마 |
| `workshop/prompts/04-agentcore-cli.md` | SSM 연결, 배포 계획, 적용, 상태와 최종 응답 1회 |

카드 안의 승인 문구는 참고 문서다. 사용자가 실제로 전달한 요청의 승인 범위를 적용한다.

1. 현재 참가자의 `activate.sh`를 source하고 `start.sh`의 기본 doctor 결과를 재사용한다.
   환경 변경이나 실패가 있을 때만 해당 도구를 다시 확인한다.
   STS와 EC2 identity를 대조한다. `$ATLAS_CONFIG`가 없을 때만
   `lab.py init-ec2 --identity-only --participant "$ATLAS_TEAM" --config "$ATLAS_CONFIG"`로
   로컬 설정을 만들고 다시 활성화해 계정을 반영한다. 기존 대상의 계정을 자동 교체하지 않는다.
2. `$ATLAS_CLI`가 없을 때 부모 폴더에서 AgentCore CLI로 생성한다.
   프로젝트는 `$ATLAS_PROJECT`, Runtime은 `JejuGuide`, Strands/Bedrock/Python,
   `CodeZip`, `PUBLIC`, IAM 호출 인증을 사용한다. 기존 프로젝트는 이어서 수정한다.
   `default` 대상은 실제 실습 계정과 `ap-northeast-2`이며,
   의존성 자동 관리, Transaction Search와 telemetry 비활성화 설정을 유지한다.
3. 03장 카드대로 `agent/tools/data/jeju_pois.json`의 137개 `source=sample` 장소와
   `search_jeju_places`를 연결한다. 원본 ID, 좌표와 출처를 유지하고 없는 영업시간, 사진과 전화번호는
   미확인으로 답한다. 생성된 진입점, 세션별 Agent와 스트리밍 처리를 유지한다.
4. `model_config.py --project "$ATLAS_CLI" --env-file "$ATLAS_CLI_PARENT/.env"`로
   Python 3.12, 모델, 인증과 호출 리전을 설정한다. `uv.lock`과 npm lock을 우선 재사용한다.
   Python 3.12 전환 등으로 갱신이 필요하면 차이를 검토하고 필요한 범위만 갱신한다.
   실제 패키징 오류가 없는데 보정 wrapper를 새로 만들지 않는다.
5. 배포 전 `agentcore validate --json`으로 설정 스키마를 확인한다.
   기본 진행에는 테스트 파일 생성, 검색 테스트와 `core.py doctor --project`를 넣지 않는다.
   별도 모델 검사와 로컬 응답 확인도 생략하고 배포로 이어간다.
6. `workshop_env.py publish --project "$ATLAS_CLI"`의 로컬 계획을 확인한다.
   현재 대화에서 승인된 키 게시, SSM과 전용 IAM policy 생성을 `--execute`로 적용한다.
   [.env와 SSM 연결](model-auth.md#원격-runtime의-ssm-연결)을 따른다.
7. 같은 `$ATLAS_CLI`에서 필요한 빌드를 포함한 배포 계획과 적용을 수행하고 상태와 최종 응답을 확인한다.

```bash
cd -- "${ATLAS_CLI:?생성된 AgentCore 프로젝트 경로를 확인하세요}" || exit 1
(
  set -e
  mkdir -p "$ATLAS_CLI_PARENT/evidence"
  cd "$ATLAS_CLI/app/JejuGuide"
  uv export --python 3.12 --locked --no-dev --no-emit-project --no-hashes \
    --output-file "$ATLAS_CLI_PARENT/evidence/runtime-constraints.txt"
  cd "$ATLAS_CLI"
  UV_CONSTRAINT="$ATLAS_CLI_PARENT/evidence/runtime-constraints.txt" agentcore deploy --target default --dry-run
)
```

CLI 0.28.1의 CodeZip 빌더가 `uv.lock`을 직접 읽지 않으므로 제약 파일을 빌드 환경에 전달한다.\
lock이 현재 pyproject와 맞지 않으면 차이를 검토해 필요한 갱신을 하고 제약 파일을 다시 만든다.\
오류가 있을 때 해당 의존성만 진단한다.

계정과 참가자 범위를 대조하고 같은 제약으로 승인된 변경만 적용한다.

```bash
cd -- "${ATLAS_CLI:?생성된 AgentCore 프로젝트 경로를 확인하세요}" || exit 1
UV_CONSTRAINT="$ATLAS_CLI_PARENT/evidence/runtime-constraints.txt" agentcore deploy --target default &&
agentcore status --target default --runtime JejuGuide --json
```

Runtime이 준비되면 04장 카드대로 질문을 한 번 호출하고 도구 사용, 샘플 출처와 응답 완료를 확인한다.\
`READY`만으로 모델 응답 성공이라 기록하지 않는다.\
이미 진행 중인 배포는 상태를 조회한다.

키 게시와 긴 패키징 전에 `cdk_bootstrap.py --expected-account "$ATLAS_ACCOUNT"`의 읽기 전용 확인을 수행한다.\
준비되지 않았으면 사전 구성의 진행자용 CDK bootstrap 절차로 안내한다.

기존 코드와 제약 파일은 유지하며 `deploy --dry-run --yes`로 자동 생성을 우회 실행하지 않는다.\
새 공유 bootstrap의 생성이나 갱신은 Runtime 배포 승인에 자동 포함되지 않는다.

`$ATLAS_CLI_PARENT/RESULTS.md`에 실행한 필수 확인, 배포, 최종 답변과 생략한 선택 검사를 구분해 기록한다.\
별도 삭제 요청에는 [키와 Runtime 정리](model-auth.md#키-갱신과-정리)를 따른다.

### 필요할 때만 추가하는 진단

실패한 명령과 오류가 있으면 관련 진단만 선택한다.\
사용자가 전체 검증을 요청한 경우에는 그 범위의 검사를 추가한다.

- 검색 도구 문제: 정상, 빈 입력, 결과 없음, category와 limit 중 해당 동작을 모델 없이 확인한다.
- 모델 호출 문제: [선택 모델 진단](model-auth.md#선택-진단-별도-모델-요청과-로컬-runtime)이나 로컬 Runtime으로 원인을 확인한다.
- 전체 프로젝트 검사 요청: 테스트 파일이 있는지 확인한 뒤
  `core.py doctor --assistant "$ATLAS_ASSISTANT" --project`와 요청한 테스트를 실행한다.
  필요한 테스트가 없으면 선택한 검사 범위에서만 작성한다.

`Ran 0 tests`, 미실행, 시간초과와 실패를 통과로 기록하지 않는다.\
선택 검사를 생략한 상태에서도 배포와 최종 응답이 확인되면 기본 실습을 마칠 수 있다.

## 전체 앱

05–14장의 별도 심화 과정이며 100~120분 안의 완료를 약속하지 않는다.\
기존 VPC, Public Subnet, Private Subnet과 NAT를 재사용한다.\
컨테이너, 전체 Python 의존성, PyYAML과 cfn-lint를 준비한다.

전체 소스의 `workshop/scripts/lab.py`로 참가자 사본과 설정을 관리한다.\
기본 CLI 프로젝트와 심화 app, Guide/Tools/Gateway/Memory 배포는 별도로 유지한다.

`lab.py info --config "$ATLAS_CONFIG"`와 기존 기록에서 실제 `app/` 경로를 확인한다.\
app이 없을 때만 `lab.py prepare`를 사용하고 기존 app은 재생성하지 않는다.

기본 실습의 identity-only 설정만 있으면 심화 네트워크 검색을 추가하되 참가자 계정은 유지한다.\
원본 운영 배포 스크립트를 새 계정에 직접 실행하지 않는다.

먼저 기존 네트워크, ECR과 Data, 카탈로그와 의존성을 준비한다.\
이어서 Guide/Tools/Gateway/Memory → Valhalla → 웹 앱을 배포한다.\
실제 Distribution을 사용하는 WAF와 정적 S3 연결을 완료한 뒤 모니터링을 설정한다.

`workshop/chapters/05-foundation-and-data.md`부터 `14-project-completion.md`까지 해당 단계를 읽는다.\
전체 완료 요청에는 `workshop/prompts/14-project-completion.md`도 적용한다.\
`lab.py`의 계획과 참가자 소유 계정, 리소스 이름을 확인한 뒤 승인된 단계를 `--execute`로 이어 간다.

### 06장 Guide 연결과 배포

Guide는 **01장에서 처음 입력한 같은 Bedrock API 키**를 사용한다.\
기본 CLI의 SSM 연결에 이어 `lab.py agent-key`로 심화 app에 연결한다.\
키 재입력이나 `.env` 복사를 요구하지 않는다.

선택한 배포 리전과 모델 호출 리전은 서울 `ap-northeast-2`다.\
원본 `$ATLAS_CLI_PARENT/.env`의 `ATLAS_BEDROCK_REGION`과 설정의 `bedrockCallerRegion`이 같아야 한다.\
05장의 app과 Data 스택, 카탈로그 및 소유 의존성 ZIP 준비가 완료된 상태에서 실행한다.

```bash
cd -- "${ATLAS_REPO:?참가자 활성화 파일을 먼저 불러오세요}" || exit 1
"$ATLAS_PYTHON" -B workshop/scripts/lab.py model-region \
  --config "$ATLAS_CONFIG" --caller-region ap-northeast-2 &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py agent-key --config "$ATLAS_CONFIG" --execute &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run agent-build --config "$ATLAS_CONFIG" --execute &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run agent-publish --config "$ATLAS_CONFIG" --execute &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run agent-plan --config "$ATLAS_CONFIG" --execute
```

`agent-key`는 `--execute`가 없으면 키를 읽거나 AWS를 호출하지 않는 로컬 미리보기다.\
실행 시 소유 core 세션과 app, 현재 AWS 계정을 검증하고 원본 `.env`를 데이터로 읽는다.\
선택 옵션 `--env-file "$ATLAS_CLI_PARENT/.env"`도 반드시 그 원본 파일을 가리켜야 한다.

04장의 같은 SSM `/jeju-atlas-lab-team01/bedrock-api-key`와 `/jeju-atlas/AtlasCliTeam01-bedrock-key` managed policy를 게시하거나 재사용한다.\
정책은 해당 파라미터 한 개의 `ssm:GetParameter`만 허용하며 `GuideRole.ManagedPolicyArns`에 연결한다.\
Bedrock 모델 IAM 권한은 넓히지 않는다.

helper가 app의 기존 `agent/guide/model/load.py`, 새 `agent/guide/model/workshop_auth.py`와 `infra/agentcore.yaml`을 반영한다.\
변경할 기존 로컬 파일은 비공개 `app/.local`에 백업한다.\
직접 수정한 사용자 로더는 덮어쓰지 않고 중단하며, 오류 시 소스와 app 상태를 보존한다.

키 관련 Runtime 환경에는 `ATLAS_BEDROCK_AUTH=api-key`와 `ATLAS_BEDROCK_API_KEY_SSM_ARN`만 전달한다.\
키 원문은 Runtime 환경이나 배포 파일에 넣지 않는다.\
로더는 SecureString을 읽어 Bedrock에만 Bearer 인증을 사용하며 IAM 모델 인증으로 대체하지 않는다.

Gateway, Memory, 제어 작업과 Runtime 인바운드 IAM/SigV4는 유지한다.\
과거 IAM 서울 호출의 SCP 거부는 당시 실패 기록으로 남긴다.

`agent-plan`의 `CREATE_COMPLETE`는 변경 세트 준비 완료다.\
`PENDING`이면 기존 `changeSetId`가 `CREATE_COMPLETE`와 `AVAILABLE`인지 확인하고 새 계획을 중복 생성하지 않는다.\
대상이 본인 자원이고 기존 Runtime이나 Memory 교체가 없을 때 다음 단계를 실행한다.

```bash
cd -- "${ATLAS_REPO:?참가자 활성화 파일을 먼저 불러오세요}" || exit 1
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run agent-apply --config "$ATLAS_CONFIG" --execute
```

`execution: started`는 배포 시작이며 완료가 아니다.\
이어서 별도 상태 조회를 수행한다.

```bash
cd -- "${ATLAS_REPO:?참가자 활성화 파일을 먼저 불러오세요}" || exit 1
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run agent-status --config "$ATLAS_CONFIG" --execute
```

`CREATE_IN_PROGRESS`, `UPDATE_IN_PROGRESS`, `UPDATE_COMPLETE_CLEANUP_IN_PROGRESS`이면 상태 조회만 반복한다.\
`NOT_CREATED`는 마지막 계획과 참가자 설정, `REVIEW_IN_PROGRESS`는 계획 준비 완료와 apply 실행 여부를 확인한다.\
실패나 `ROLLBACK` 상태는 스택 이벤트와 원인을 확인하고 후속 로그 설정을 중단한다.

스택이 `CREATE_COMPLETE` 또는 `UPDATE_COMPLETE`이고 출력 자원이 본인 것일 때만 로그를 설정한다.\
조회 명령의 종료 코드 0이나 계획의 `CREATE_COMPLETE`를 스택 완료로 계산하지 않는다.

```bash
cd -- "${ATLAS_REPO:?참가자 활성화 파일을 먼저 불러오세요}" || exit 1
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run agent-configure-logs --config "$ATLAS_CONFIG" --execute
```

`Complete the independent stack` 오류는 상태 조회로 돌아가 해결한다.\
`Runtime READY`와 실제 모델 응답 성공은 구분한다.\
06장 배포에 모델 사전 호출이나 IAM 정책 시뮬레이터를 추가하지 않는다.

### 기존 IAM Guide 재개

이미 배포한 IAM Guide는 소스 루트에서 helper를 갱신한다.

```bash
cd -- "${ATLAS_REPO:?참가자 활성화 파일을 먼저 불러오세요}" || exit 1
git pull --ff-only origin main
```

갱신 뒤 위의 `model-region → agent-key → agent-build → agent-publish → agent-plan` 순서를 수행한다.\
계획 준비 완료 후 apply와 status를 각각 실행하고 스택 완료 후 로그 설정으로 이어 간다.\
역할, Runtime 환경과 소스가 바뀌므로 기존 IAM 코드 ZIP을 재사용하지 않는다.

`lab.py prepare`, 의존성 ZIP 재빌드, 스택 재생성과 키 재입력은 하지 않는다.\
기존 참가자 사본과 소유 의존성 ZIP을 유지한다.\
소스 갱신이나 helper 오류를 reset, 삭제나 재준비로 우회하지 않는다.

키 연결이 이미 반영된 소스와 게시물이 그대로이면 성공한 빌드와 게시를 반복하지 않는다.\
같은 SSM ARN의 키 값만 갱신하면 공유 policy를 재사용하며 소스 재빌드나 재배포는 필요하지 않다.\
새 모델 클라이언트는 갱신된 SSM 버전을 읽지만 진행 중인 요청이나 기존 모델 인스턴스의 변경을 보장하지 않는다.

역할, Runtime 환경이나 소스가 달라지면 해당 변경을 다시 배포한다.\
의존성 자체를 변경했다면 lock만으로 배포 ZIP이 갱신되지 않으므로 `agent/dependency-artifacts.json`과 실제 번들을 대조한다.

공유 키 정리는 기본 JejuGuide 역할과 심화 GuideRole 양쪽의 policy 연결 해제가 완료된 뒤에 수행한다.\
기존 IAM 연결 검사가 조기 삭제를 차단하므로 이를 우회하지 않는다.\
세부 절차는 [키 갱신과 정리](model-auth.md#키-갱신과-정리)를 따른다.

### 웹 연결과 완료 확인

배포 뒤에는 내 App 스택의 기본 CloudFront HTTPS URL을 조회한다.\
ACM 발급, 사용자 도메인이나 DNS를 추가하지 않는다.

기본 확인은 필요한 경로, 계정과 설정, 빌드와 배포 상태, 실제 HTTPS 접속과 웹 최종 응답 1회다.\
한영 답변, 브라우저 자동화, PWA, 교재, 전체 경로와 통합 검증은 기본으로 생략한다.

오류가 있으면 해당 카탈로그, 경로, Gateway나 Memory 등 관련 기능만 진단한다.\
사용자가 추가 검증을 요청하면 지정한 범위를 수행한다.

검사는 참가자 사본에서 실행하고 소스, 이미지와 실제 확인 기록이 같은 변경을 가리키게 한다.\
전체 앱의 성공은 기본 Runtime의 성공과 별도로 기록한다.

## 배포 후 외부 연동

첫 배포 뒤 사용자가 선택한 제공처만 추가한다.\
기본 실습에는 이 키들이 필요하지 않다.\
사용자가 자신의 Bash에서 입력한다.

```bash
cd -- "${ATLAS_CLI_PARENT:?참가자 활성화 파일을 먼저 불러오세요}" || exit 1
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/workshop_env.py" configure --integrations
```

| provider | `.env` 변수 | 용도 |
|---|---|---|
| `kakao` | `KAKAO_REST_API_KEY` | 카카오 장소 검색 |
| `tourapi` | `TOURAPI_SERVICE_KEY` | 관광공사 TourAPI |
| `visitjeju` | `VISIT_JEJU_API_KEY` | VISIT JEJU 연동 |

`VISIT_JEJU_API_KEY`는 워크숍 입력 별칭이다.\
`lab.py set-secret --provider visitjeju`가 이 값을 읽어 해당 제공처의 SSM parameter로 전달한다.\
앱의 직접 환경변수 이름으로 가정하지 않는다.

입력을 건너뛰면 기존 값은 유지하며, 없는 키는 선택 기능 미설정으로 기록한다.\
심화 앱에서는 해당 제공처의 게시 계획을 먼저 확인한다. 카카오 예시:

```bash
cd -- "${ATLAS_REPO:?참가자 활성화 파일을 먼저 불러오세요}" || exit 1
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/lab.py" set-secret \
  --config "$ATLAS_CONFIG" --provider kakao --env-file "$ATLAS_CLI_PARENT/.env"
```

선택 기능과 이 참가자 SSM 게시 승인이 있으면 적용한다.

```bash
cd -- "${ATLAS_REPO:?참가자 활성화 파일을 먼저 불러오세요}" || exit 1
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/lab.py" set-secret \
  --config "$ATLAS_CONFIG" --provider kakao --env-file "$ATLAS_CLI_PARENT/.env" --execute
```

`tourapi`, `visitjeju`도 선택한 provider만 같은 방식으로 처리한다.\
SSM 저장 이후 실제 앱, 수집기, 역할과 배포 설정이 그 parameter를 사용하는지 확인한다.\
필요한 배포, 수집과 기능 검사를 수행하며 저장만으로 기능 연결 완료라고 하지 않는다.

키가 없으면 시드로 가능한 첫 배포를 진행하고 해당 연동은 선택 미완료로 남긴다.\
공식 자료의 출처, 조회 시각, 사진 크레딧, 라이선스와 검증 범위를 유지한다.
