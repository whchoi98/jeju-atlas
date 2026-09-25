# 기본 실습과 전체 앱 배포

[스킬 본문](../SKILL.md)에서 선택한 배포·재개 범위에 해당하는 절만 읽는다.
모델 작업 전 [모델 인증](model-auth.md)을 읽고 현재 대화의 외부 작업 승인을 확인한다.
준비가 남았으면 [사전 준비](prepare.md)를 수행한다.
저장소 문서 경로는 발견한 `$ATLAS_REPO` 기준이다.
셸 작업은 첫 줄에서 실제 저장소·부모·프로젝트 폴더로 `cd`한 뒤 실행한다.
새 셸에서는 절대 활성화 파일을 source하고 명령에 맞는 작업 폴더로 다시 이동한다.

독립 랩의 새 설치는 내부 ID `team01`, 프로젝트 `AtlasCliTeam01`을 자동 사용한다.
팀명을 선택하거나 새 ID를 만들게 하지 않으며 재개 시 기존 값을 보존한다.
HUD, 전체 테스트·브라우저·한영 응답 등 추가 검증은 필요할 때만 선택한다.

## 기본 CLI 실습

본 실습은 00–04장 100분과 여유 20분이다. 결과물은 검색 도구와 실제 모델을 사용하는
참가자 전용 JejuGuide Runtime이다. 전체 지도 앱 구축은 이 시간의 완료 기준에 포함하지 않는다.

세부 구현·명령은 전체 소스의 다음 카드에서 읽는다.
설치된 스킬 폴더를 기준으로 이 경로들을 찾지 않는다.

| 카드 경로 | 적용할 내용 |
|---|---|
| `workshop/prompts/02-aws-environment.md` | EC2 신원·STS 계정, 참가자 설정과 키 상태 |
| `workshop/prompts/03-codex.md` | AgentCore 생성, 샘플 기반 검색 도구, Python 3.12와 설정 스키마 |
| `workshop/prompts/04-agentcore-cli.md` | SSM 연결, 배포 계획·적용·상태와 최종 응답 1회 |

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
   의존성 자동 관리·Transaction Search·telemetry 비활성화 설정을 유지한다.
3. 03장 카드대로 `agent/tools/data/jeju_pois.json`의 137개 `source=sample` 장소와
   `search_jeju_places`를 연결한다. 원본 ID·좌표·출처를 유지하고 없는 영업시간·사진·전화번호는
   미확인으로 답한다. 생성된 진입점, 세션별 Agent와 스트리밍 처리를 유지한다.
4. `model_config.py --project "$ATLAS_CLI" --env-file "$ATLAS_CLI_PARENT/.env"`로
   Python 3.12·모델·인증·호출 리전을 설정한다. `uv.lock`과 npm lock을 우선 재사용한다.
   Python 3.12 전환 등으로 갱신이 필요하면 차이를 검토하고 필요한 범위만 갱신한다.
   실제 패키징 오류가 없는데 보정 wrapper를 새로 만들지 않는다.
5. 배포 전 `agentcore validate --json`으로 설정 스키마를 확인한다.
   기본 진행에는 테스트 파일 생성·검색 테스트·`core.py doctor --project`를 넣지 않는다.
   별도 모델 검사와 로컬 응답 확인도 생략하고 배포로 이어간다.
6. `workshop_env.py publish --project "$ATLAS_CLI"`의 로컬 계획을 확인한다.
   키 게시·SSM·전용 IAM policy 생성이 승인돼 있으면 `--execute`로 적용한다.
   [.env와 SSM 연결](model-auth.md#원격-runtime의-ssm-연결)을 따른다.
7. 같은 `$ATLAS_CLI`에서 필요한 빌드를 포함한 배포 계획·적용을 수행하고 상태·최종 응답을 확인한다.

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

CLI 0.28.1의 CodeZip 빌더가 `uv.lock`을 직접 읽지 않으므로 제약 파일을 빌드 환경에
전달한다. lock이 현재 pyproject와 맞지 않으면 차이를 검토해 필요한 갱신을 하고
제약 파일을 다시 만든다. 오류가 있을 때 해당 의존성만 진단한다.
계정과 참가자 범위를 대조하고 같은 제약으로 승인된 변경만 적용한다.

```bash
cd -- "${ATLAS_CLI:?생성된 AgentCore 프로젝트 경로를 확인하세요}" || exit 1
UV_CONSTRAINT="$ATLAS_CLI_PARENT/evidence/runtime-constraints.txt" agentcore deploy --target default &&
agentcore status --target default --runtime JejuGuide --json
```

Runtime이 준비되면 04장 카드대로 질문을 한 번 호출하고 도구 사용·샘플 출처·응답 완료를 확인한다.
`READY`만으로 모델 응답 성공이라 기록하지 않는다.
이미 진행 중인 배포는 상태를 조회한다. 키 게시와 긴 패키징 전에
`cdk_bootstrap.py --expected-account "$ATLAS_ACCOUNT"`의 읽기 전용 확인을 수행한다.
준비되지 않았으면 사전 구성의 진행자용 CDK bootstrap 절차로 안내한다.
기존 코드와 제약 파일은 유지하며 `deploy --dry-run --yes`로 자동 생성을 우회 실행하지 않는다.
새 공유 bootstrap의 생성이나 갱신은 Runtime 배포 승인에 자동 포함되지 않는다.

`$ATLAS_CLI_PARENT/RESULTS.md`에 실행한 필수 확인·배포·최종 답변과 생략한 선택 검사를
구분해 기록한다. 별도 삭제 요청에는 [키·Runtime 정리](model-auth.md#키-갱신과-정리)를 따른다.

### 필요할 때만 추가하는 진단

실패한 명령과 오류가 있으면 관련 진단만 선택한다.
사용자가 전체 검증을 요청한 경우에는 그 범위의 검사를 추가한다.

- 검색 도구 문제: 정상·빈 입력·결과 없음·category·limit 중 해당 동작을 모델 없이 확인한다.
- 모델 호출 문제: [선택 모델 진단](model-auth.md#선택-진단-별도-모델-요청과-로컬-runtime)이나 로컬 Runtime으로 원인을 확인한다.
- 전체 프로젝트 검사 요청: 테스트 파일이 있는지 확인한 뒤
  `core.py doctor --assistant "$ATLAS_ASSISTANT" --project`와 요청한 테스트를 실행한다.
  필요한 테스트가 없으면 선택한 검사 범위에서만 작성한다.

`Ran 0 tests`, 미실행, 시간초과와 실패를 통과로 기록하지 않는다.
선택 검사를 생략한 상태에서도 배포와 최종 응답이 확인되면 기본 실습을 마칠 수 있다.

## 전체 앱

05–14장의 별도 심화 과정이며 100~120분 안의 완료를 약속하지 않는다.
기존 VPC/Public·Private Subnet/NAT를 재사용하고,
컨테이너·전체 Python 의존성·PyYAML·cfn-lint를 준비한다.
전체 소스의 `workshop/scripts/lab.py`로 참가자 사본과 설정을 관리한다.
기본 CLI 프로젝트와 심화 앱·Guide/Tools/Gateway/Memory 배포는 별도로 유지한다.

`lab.py info --config "$ATLAS_CONFIG"`와 기존 기록에서 실제 `app/` 경로를 확인한다.
app이 없을 때만 `lab.py prepare`를 사용하고 기존 app은 재생성하지 않는다.
기본 실습의 identity-only 설정만 있으면 심화 네트워크 검색을 추가하되 참가자 계정은 유지한다.
원본 운영 배포 스크립트를 새 계정에 직접 실행하지 않는다.

작업 순서는 기존 네트워크 확인 → ECR·Data → 카탈로그·의존성 →
Guide·Tools·Gateway·Memory → Valhalla → 웹 앱 →
실제 Distribution을 사용하는 WAF·정적 S3 연결 → 모니터링이다.
`workshop/chapters/05-foundation-and-data.md`부터 `14-project-completion.md`까지의
해당 단계와 `workshop/prompts/14-project-completion.md`를 읽는다.
`lab.py`의 계획과 참가자 소유 계정·리소스 이름을 확인한 뒤 승인된 단계만 `--execute`로 적용한다.

전체 앱의 Guide는 현재 코드의 IAM 모델 인증을 먼저 확인한다.
사용자가 API 키 인증을 요청했다면 실제 Guide에 필요한 키 전달과 최소 IAM 권한,
로더·갱신·배포·웹 스트리밍을 구현·검사한다. 기본 CLI helper가 이를 대신했다고 보고하지 않는다.
기존 참가자 사본에만 있는 지원 코드와 배포 설정을 보존한다.
Agent 의존성은 lock 변경만으로 배포 ZIP이 갱신되지 않으므로
`agent/dependency-artifacts.json`과 실제 배포 번들을 대조한다.

배포 뒤에는 내 App 스택의 기본 CloudFront HTTPS URL을 조회한다.
ACM 발급·사용자 도메인·DNS를 추가하지 않는다.
기본 확인은 필요한 경로·계정·설정, 빌드·배포 상태, 실제 HTTPS 접속과 웹 최종 응답 1회다.
한영 답변·브라우저 자동화·PWA·교재·전체 경로 및 통합 검증은 기본으로 생략한다.
오류가 있으면 해당 카탈로그·경로·Gateway·Memory 등 관련 기능만 진단하며,
사용자가 추가 검증을 요청하면 지정한 범위를 수행한다.
검사는 참가자 사본에서 실행하고 소스·이미지·실제 확인 기록이 같은 변경을 가리키게 한다.
전체 앱의 성공은 기본 Runtime의 성공과 별도로 기록한다.

## 배포 후 외부 연동

첫 배포 뒤 사용자가 선택한 제공처만 추가한다. 기본 실습에는 이 키들이 필요하지 않다.
사용자가 자신의 Bash에서 입력한다.

```bash
cd -- "${ATLAS_CLI_PARENT:?참가자 활성화 파일을 먼저 불러오세요}" || exit 1
python3 "$ATLAS_REPO/workshop/scripts/workshop_env.py" configure --integrations
```

| provider | `.env` 변수 | 용도 |
|---|---|---|
| `kakao` | `KAKAO_REST_API_KEY` | 카카오 장소 검색 |
| `tourapi` | `TOURAPI_SERVICE_KEY` | 관광공사 TourAPI |
| `visitjeju` | `VISIT_JEJU_API_KEY` | VISIT JEJU 연동 |

`VISIT_JEJU_API_KEY`는 워크숍 입력 별칭이다. `lab.py set-secret --provider visitjeju`가
이 값을 읽어 해당 제공처의 SSM parameter로 전달하며, 앱의 직접 환경변수 이름으로 가정하지 않는다.
입력을 건너뛰면 기존 값은 유지하며, 없는 키는 선택 기능 미설정으로 기록한다.
심화 앱에서는 해당 제공처의 게시 계획을 먼저 확인한다. 카카오 예시:

```bash
cd -- "${ATLAS_REPO:?참가자 활성화 파일을 먼저 불러오세요}" || exit 1
python3 "$ATLAS_REPO/workshop/scripts/lab.py" set-secret \
  --config "$ATLAS_CONFIG" --provider kakao --env-file "$ATLAS_CLI_PARENT/.env"
```

선택 기능과 이 참가자 SSM 게시 승인이 있으면 적용한다.

```bash
cd -- "${ATLAS_REPO:?참가자 활성화 파일을 먼저 불러오세요}" || exit 1
python3 "$ATLAS_REPO/workshop/scripts/lab.py" set-secret \
  --config "$ATLAS_CONFIG" --provider kakao --env-file "$ATLAS_CLI_PARENT/.env" --execute
```

`tourapi`, `visitjeju`도 선택한 provider만 같은 방식으로 처리한다.
SSM 저장 이후 실제 앱·수집기·역할·배포 설정이 그 parameter를 사용하는지 확인하고,
필요한 배포·수집과 기능 검사를 수행한다. 저장만으로 기능 연결 완료라고 하지 않는다.
키가 없으면 시드로 가능한 첫 배포를 진행하고 해당 연동은 선택 미완료로 남긴다.
공식 자료의 출처·조회 시각·사진 크레딧·라이선스와 검증 범위를 유지한다.
