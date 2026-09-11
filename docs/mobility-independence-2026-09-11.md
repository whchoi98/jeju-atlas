# 이동 경로·3D 탐색과 전용 AgentCore 전환

기준: 2026-09-11, `jeju-atlas/mobility-3d` 작업 공간의 코드와 아래 검증 기록.
**공개 웹의 전용 Agent·카탈로그·경로 엔진 전환이 배포 완료됐습니다.**
`Jeju3dApp`은 `UPDATE_COMPLETE`, ECS `jeju-3d:12`는 PRIMARY `COMPLETED`이며
desired 2 / running 2, 웹·라우터 컨테이너 HEALTHY를 확인했습니다.
공개 브라우저 8/8, 운영 인프라 91개, 최종 Node 299개·Python 190개 통과(선택적 검사 3개 건너뜀)와 공개 AI 개인정보 검사를 완료했습니다.

## 배포와 검증 상태

| 구분 | 확인 상태 |
|---|---|
| 공개 웹 | `release-20260911T013430Z` / `jeju-3d:12`; 전용 Guide·카탈로그·라우터 연결 |
| 앱 스택·서비스 | `Jeju3dApp` `UPDATE_COMPLETE`; PRIMARY `COMPLETED`, desired/running 2/2 |
| 전용 AgentCore | `Jeju3dAgentCore` — `CREATE_COMPLETE` |
| 전용 데이터 | `Jeju3dData` — `UPDATE_COMPLETE`; `jeju-3d-data:4`도 소유 카탈로그 사용 |
| 이동 기능 | 실제 로컬 Valhalla·HGT·웹 BFF의 브라우저 검사 8/8 통과 |
| 전용 AI | 한국어·영어 실제 호출에서 정상 SSE `done` 확인 |
| 공개 API | 사용자 도메인·CloudFront 주소에서 health/config/routes/elevation 모두 200 |
| AWS 독립성 | 24개 검사 모두 true; 실제 웹·수집 태스크의 소유 리소스 연결 확인 |
| 공개 브라우저 | 8/8, 실제 route/elevation POST 16회 모두 200 |
| 공개 AI | 26.651초에 정상 완료, 관련 로그·트레이스 원문 비기록 확인 |
| 최종 소스 | Node 299개·Python 190개 통과, 선택적 검사 3개 건너뜀; 스키마·의존성·빌드 통과 |

공개 서비스의 이전 상태는 [2026-09-10 운영 기록](commercial-completion-audit-2026-09-10.md)에
보존합니다. 전환 전 task 11의 공유 Agent 연결 상태와 아래 현재 상태를 구분합니다.

## 현재 이미지와 공개 API

| 구성 | 배포 digest |
|---|---|
| 웹 | `sha256:92f16ae2e460aa6dce5cef37689cff5a63996df8002f51894f3c6be577130734` |
| 라우터 | `sha256:bae4b2b84b99d8c55b2c973b1f3a89da505f6d15e1d9b27bf46665b4a7d8b5da` |
| 수집 작업 | `sha256:296ef7d4113b7db8bd3afa739feb84fa7c6e29d35a0d2e7b09935d38ea8f0842` |

웹과 라우터 최종 ECR 스캔의 발견 건수는 각각 **0건**입니다.
웹 스캔 (`.local/mobility-web-image-scan.json`, 로컬 자료) ·
라우터 최종 보안 스캔 (`.local/mobility-routing-security-scan.json`, 로컬 자료).
`mobility-routing-image-scan.json`은 보안 수정 전의 다른 이미지 기록이므로 현재 결과로 사용하지 않습니다.

두 주소 `https://jeju-atlas.whchoi.net`, `https://d2mznud99i2mdr.cloudfront.net`에서
`/healthz`, `/api/config`, `/api/routes`, `/api/elevation`의 200 응답을 확인했습니다.
동일 검증 지점쌍의 결과:

| 수단 | 경로 거리 | 예상 이동 시간 | 형상 좌표 수 |
|---|---:|---:|---:|
| 차량 | 4,571m | 410.673초 | 221 |
| 도보 | 3,885m | 2,770.64초 | 202 |

시간은 경로 엔진의 이동 예상치이며 HTTP 응답 지연 측정값이 아닙니다.
고도 검증 좌표의 표본은 1,931m와 94m였으며 정상의 공식 표고·정밀 측량값을 뜻하지 않습니다.
공개 API 원문 (`.local/mobility-live-api.json`, 로컬 자료)

## 전용 리소스와 독립성

| 구성 | 배포된 식별자 |
|---|---|
| Guide Runtime | `JejuAtlas_Guide-2sFw9YBI8V`, 버전 1 READY |
| Tools Runtime | `JejuAtlas_Tools-Nh0YFIFC7c`, 버전 1 READY |
| HTTP Gateway | `jeju-atlas-tools-ddvut90uxw` |
| Gateway 대상 | `JejuAtlasTools`, `/JejuAtlasTools/invocations` |
| Memory | `JejuAtlas_Memory-xH3L1d4DjN`; 4개 전략 ACTIVE |
| 전용 버킷 | `jeju-3d-data-061525506239-ap-northeast-2` |

근거: 완료된 스택 출력 (`.local/atlas-agent-outputs.json`, 로컬 자료).
Guide의 Gateway 연결은 IAM 인증이며, HTTP Gateway의 Runtime 대상 경로를 사용합니다.
집계형 `/mcp` 경로나 이전 Gateway 이름을 새 구성에 적용하지 않습니다.
일반 질문은 `global.openai.gpt-5.6-sol`, 일정 계획은 `global.openai.gpt-6-astra`를
사용하는 서울 Global CRIS 설정을 유지합니다.

최종 AWS 독립성 감사 (`.local/independence/final-aws-audit.json`, 로컬 자료)의 **24개 검사가 모두 true**입니다.
두 Runtime의 코드 S3·Gateway·Memory·역할, 실제 웹 `jeju-3d:12`와 수집 작업
`jeju-3d-data:4`의 소유 카탈로그 연결을 확인했습니다. 검사한 Guide·Tools·웹·수집 역할
4개에 원본 프로젝트 리소스를 가리키는 IAM grant는 없었습니다.
현재 Core는 CloudFormation 관리 리소스 9개와 서비스 자동 생성 Runtime 로그 그룹 2개입니다.

`agent/guide/`, `agent/tools/`는 이 저장소가 소유한 일반 소스 디렉터리입니다.
초기 읽기 전용 복사는 검증 커밋 `9d4ae864369eb62fddfb9b346d6e25722c946aa1`에
근거하며 [복사 출처](../agent/source-provenance.json)에 기록했습니다.
이후 빌드·배포·실행은 참조 프로젝트 디렉터리를 사용하지 않습니다.
이 독립화 작업에서 원본 코드와 기존 공유 AgentCore 리소스를 추가 변경하지 않았으며,
기존 사용자 메모리도 전용 Memory에 가져오지 않았습니다.

Python 의존성도 [dependency-artifacts.json](../agent/dependency-artifacts.json)의
전용 S3 객체·버전·SHA-256으로 고정합니다. 원본 Runtime의 아카이브를 매번 가져오는
구성이 아닙니다. 소스·의존성·배포 아카이브와 IAM 역할의 경계는
[AgentCore 구성](agentcore-components.md)을 참고합니다.

## 카탈로그와 출처

전용 데이터 위치:

```text
s3://jeju-3d-data-061525506239-ap-northeast-2/catalog/catalog.sqlite
```

초기 복사에서 5,996,544바이트·6,724곳을 유지했고 원본과 복사본의 SHA-256이 같습니다.

```text
5fb97978a7a74b487c7850042c25f08242654c8946d2003374c894a3843a0b00
```

복사·해시 검증 (`.local/independence/catalog-import-applied.json`, 로컬 자료).
구성은 OpenStreetMap 6,587곳과 큐레이션 시드 137곳입니다. 137곳의 이름은 실제 장소를
바탕으로 하지만 기본 좌표·주소·소개를 공식 대조 검증값으로 취급하지 않습니다.
복사하거나 공식 보강 자료를 연결한 사실만으로 기본 필드를 검증 완료로 승격하지 않습니다.
사진·시간·시설·인허가는 항목별 출처와 `field_evidence`를 유지합니다.

## 이동 경로와 지형 기능

- 최대 12곳의 방문 순서로 도보·차량 경로 거리와 예상 시간을 비교합니다. 체류 시간을
  더한 계획 시간, 구간 안내, GPX와 이동 수단을 포함한 코스 공유를 제공합니다.
- 장소 상세에서 출발·도착을 지정하고, 지도 중심·사용자가 허용한 현재 위치를 사용할 수 있습니다.
  경로 연결 실패·배편 필요·좌표와 경로 끝점의 차이를 표시하며 임의 직선으로 대체하지 않습니다.
- 실제 DEM·위성 지형에서 주요 명소 12곳의 관찰·회전·위에서 보기·실제 배율 복원을 지원합니다.
  경로 3D 미리보기, 고도 단면과 오르막·내리막, 여러 점 직선 측정·취소·초기화를 제공합니다.
- 한국어/English, NanumSquare, 모바일과 키보드 조작을 유지합니다. 새 경로·수동 조작·
  동작 감소 설정·페이지 비활성화·그래픽 연결 손실에서 자동 이동을 중지합니다.

경로는 전용 이미지에 고정한 Valhalla 3.8.3과 OSM 그래프를 사용합니다.
**OSM 기준 시각은 `2026-09-10T20:21:06Z`**입니다.
고도 단면은 Skadi `N33E126.hgt`의 원본 높이를 사용하며 출처 객체의 수정 시각은
**2016-04-23**입니다. 이 날짜는 현재 영상 촬영일이나 현장 측량일을 뜻하지 않습니다.
데이터 manifest (`.local/routing-data/source.json`, 로컬 자료)

고도는 DEM 표본값으로 정상의 공식 표고·정밀 측량값과 다를 수 있습니다.
단면은 화면 고도 배율과 독립적이며 결측을 0m로 채우지 않습니다.
도보·차량 시간은 실시간 교통을 반영하지 않은 추정치입니다.
사진측량 건물·실시간 영상·대중교통 배차·로드뷰 제공을 주장하지 않습니다.

## 네이티브 검증

이동 기능 보고서 (`.local/browser-mobility-native-rate60/report.json`, 로컬 자료)는
2026-09-11 01:22~01:26 UTC의 로컬 실제 그래프·HGT 검사입니다. **8/8 통과**했으며
모델을 구성하거나 호출하지 않았습니다.

| 검사 | 결과 |
|---|---|
| 실제 도보·차량 기준 경로 | 통과 |
| 데스크톱 경로·GPX·고도·3D | 통과 |
| 모바일·공유 복원 | 통과 |
| 상세 출발/도착·위치 권한 거절 | 통과; 권한 상태는 브라우저로 제어 |
| 연결 불가 시 직선 대체 금지 | 통과 |
| 12곳 코스 공유 | 통과 |
| 12곳 순차 편집과 요청 한도 | 통과; 분당 60회 설정 |
| 늦은 응답 취소 | 통과; 전송 지연을 제어 |

전용 Guide 실제 호출은 별도로 검사했습니다.

| 언어 | 완료 시간 | 결과 |
|---|---:|---|
| 한국어 | 17.553초 | 오류 없이 `done` |
| 영어 | 25.434초 | 오류 없이 `done` |

근거: 한국어 (`.local/independence/guide-ko-live.json`, 로컬 자료),
영어 (`.local/independence/guide-en-live.json`, 로컬 자료).
각 시간은 한 번의 네이티브 호출 관측값이며 공개 웹 전체의 지연 보장이 아닙니다.

해당 검사 구간의 로그·트레이스 **8,260건**에서 입력 표식·질문·답변 원문 유출 검사는
모두 false였습니다. Sol/Astra 모델·토큰 수·도구 메타데이터는 유지됐습니다.
관측 검사 (`.local/independence/native-telemetry-verification.json`, 로컬 자료).
전체 과거 로그가 삭제됐거나 모든 미래 요청을 검증했다는 의미는 아닙니다.

## 운영 명령과 현재 용량

새 AgentCore CLI는 다음 순서를 사용합니다. 계획 내용을 검토한 뒤 적용합니다.

```bash
python3 scripts/deploy-atlas-agent.py build
python3 scripts/deploy-atlas-agent.py publish
python3 scripts/deploy-atlas-agent.py plan
python3 scripts/deploy-atlas-agent.py apply
python3 scripts/deploy-atlas-agent.py status
python3 scripts/deploy-atlas-agent.py configure-logs
```

Runtime 로그 그룹은 서비스가 자동 생성합니다. CloudFormation에 중복 선언하지 않고,
`configure-logs`가 전용 Runtime 두 개의 소유권을 확인한 뒤 14일 보관을 적용했습니다.
적용 결과 (`.local/atlas-agent-log-retention.json`, 로컬 자료).
폐기된 `scripts/deploy-guide-models.py` CLI는 AWS 연결 전에 종료합니다.

공개 task 12의 설정은 작업당 **512 CPU units(0.5 vCPU)·1,024 MiB**,
라우터 컨테이너 메모리 상한 **512 MiB**입니다.
경로 엔진은 같은 작업의 `127.0.0.1:8002`로만 연결하며 외부 포트를 열지 않습니다.
경로·고도 요청 제한은 앱 프로세스에서 서명된 actor당 분당 60회이며,
AI의 전체 하루 30회·사용자별 시간당 5회·전체 동시 2회 제한과 별도입니다.

## 실패 시도와 복구 이력

최종 서비스 성공 상태와 별도로 첫 시도의 실패 기록을 보존합니다.

- 첫 Core 생성은 Runtime 서비스가 자동 생성한 로그 그룹을 CloudFormation에서도
  선언해 충돌했고 자동 롤백됐습니다. actors 0명인 실패 Memory를 확인한 뒤 해당
  Memory의 삭제와 실패 스택 정리만 진행했습니다. 실패 시도의 로그는 14일 보관으로
  남기고 중복 로그 선언을 제거해 재생성했습니다.
  빈 Memory 확인 (`.local/independence/failed-memory-inventory.json`, 로컬 자료) ·
  정리 요청 기록 (`.local/independence/failed-create-cleanup.json`, 로컬 자료).
  정리 상태 기록의 `DELETING`은 삭제 완료 증거로 해석하지 않습니다.
- 첫 앱 적용은 CloudFormation Rules의 숫자 리터럴 `Equals` 비교 오류로 실패·롤백됐습니다.
  문자열 비교로 수정하고 회귀 검사를 거친 재시도에서 `UPDATE_COMPLETE`가 됐습니다.
  첫 계획 (`.local/mobility-app-plan.log`, 로컬 자료) · 재시도 계획 (`.local/mobility-app-plan-retry.log`, 로컬 자료).

이 과정에서 기존 참조 스택·소스는 추가 변경하지 않았습니다. 자동 롤백 이력은 승인된
이전 릴리스로 수동 롤백을 수행한 기록과 구분합니다.

## 최종 검증과 완료 감사

| 요구 사항 | 직접 확인한 근거 |
|---|---|
| 도보·차량 거리/시간과 실제 형상 | 두 공개 호스트 API, 공개 브라우저 지도·GPX 대조 |
| 12곳 코스와 체류 포함 시간 | 실제 로컬 12곳 연속 편집 22회 정상; 공개 체류 변경 시 추가 계산 0회 |
| 출발/도착·지도 중심·현재 위치 | 실제 카탈로그 상세 버튼, 브라우저 위치 권한 거절·제주 범위 검증 |
| 구간 안내·GPX·공유 | 공개 도보/차량 각 26/15 안내, GPX 전체 형상 해시, 모바일 모드 복원 |
| 주요 관광지 3D | 12개 명소 선택·회전·실제 배율·위에서 보기; 공개 한라산 DEM |
| 경로 3D·고도 단면 | 공개 128개 실제 높이 표본, 경로 이동·중지, 단면 위치 연동 |
| 다중 점 거리 재기 | 공개 지도 측정·마지막 점 취소·초기화 |
| 운영 배포·언어·모바일·회귀 | ECS task 12 건강 상태, 공개 브라우저 8/8, 인프라·HTTP 91개 |
| 참조 프로젝트와 독립 | 실제 AWS 연결·코드·IAM·카탈로그 감사 24/24 |

공개 브라우저 최종 보고서 (`.local/browser-mobility-live-release-20260911T013430Z-observed-config/report.json`, 로컬 자료).
두 호스트의 최종 경로·고도 POST 16회 모두 200이었고 CNAME 403은 없었습니다.
초기 검증기의 중복 config 요청은 검증기에서 수정했으며 앱·서버 수정으로 우회하지 않았습니다.

공개 AI 검사 (`.local/guide-privacy-live.json`, 로컬 자료)는 영어 일정 질문을 26.651초에 완료했습니다.
도구 4개 사용과 정상 `done`을 확인했고, 관련 로그·트레이스 1,066건에서 입력 표식·질문·
답변 원문 유출 없이 모델·도구·토큰 메타데이터가 남는 것을 확인했습니다.

운영 경로 소규모 부하 검사 (`.local/mobility-public-routing-load.json`, 로컬 자료)는 동시 클라이언트 2개,
총 60회 요청에서 오류 0회, p50 43.659ms, p95 101.102ms, 최장 116.691ms였습니다.
이 관측은 해당 요청·부하 범위에 대한 값이며 모든 트래픽의 지연 보장이 아닙니다.

최종 소스 검사 (`.local/checks.json`, 로컬 자료)는 Node 299개·Python 190개 통과(선택적 검사 3개 건너뜀), CloudFormation 스키마,
의존성 보안 검사, 운영 빌드에 통과했습니다. 검사 도중 소스 변경은 없었습니다.

```text
sourceDigest: 2ce1107066a689ad438ec5a1e9b8fb6b5aa242b224f78fb4d4bf81700923167c
PWA shell: ba79f8bbdb7e8672
```

운영 검증 (`.local/verification.json`, 로컬 자료) 91개도 통과했습니다. 새로운 승인 롤백 항목에는
현재 웹·라우터 두 digest와 OSM 기준 시각을 함께 기록했습니다. 운영 롤백을 실행한 것은 아닙니다.

선택적으로 건너뛴 검사는 별도 실행 플래그가 필요한 Trip 브라우저 검사 1개와
현재 작업 공간에 사본이 없는 과거 제공처 fixture 검사 2개입니다. Trip 화면은 실제
네이티브·공개 브라우저 각 8/8 검사에서 별도로 검증했습니다. 총 수집된 검사는
Node 300개(299 통과, 1 건너뜀), Python 192개(190 통과, 2 건너뜀)이며 실패는 없습니다.
