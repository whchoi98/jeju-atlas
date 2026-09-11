# 카탈로그·이동 경로·전용 가이드 통합

기준: 2026-09-11 `jeju-atlas/mobility-3d` 구현과 네이티브 검증.
전용 `Jeju3dAgentCore`는 배포 완료했고 이동 기능은 실제 로컬 그래프·HGT로 8/8 검사했습니다.
**공개 ECS `jeju-3d:12`가 전용 Guide·카탈로그·라우터로 전환됐으며 정상 태스크 2개를 확인했습니다.**
두 공개 호스트의 health/config/routes/elevation은 모두 200이고 AWS 독립성 검사 24개가 통과했습니다.
공개 브라우저 8/8, 운영 인프라 91개, Node 299개·Python 190개 통과(선택적 검사 3개 건너뜀)와 공개 AI 개인정보 검사를 완료했습니다.
상태와 근거는 [최신 전환 기록](mobility-independence-2026-09-11.md)을 기준으로 합니다.

## 소유 데이터와 출처

- 실행 기준 카탈로그는 전용 버킷의 `catalog/catalog.sqlite`입니다.
  `s3://jeju-3d-data-061525506239-ap-northeast-2/catalog/catalog.sqlite`
- 초기 복사는 6,724곳과 기존 SHA-256을 유지합니다. OpenStreetMap 6,587곳과
  큐레이션 시드 137곳의 기본 출처·검증 한계도 그대로 유지합니다.
- 137곳의 이름은 실제 장소를 바탕으로 하지만 기본 좌표·주소·소개는 공식 대조 검증값이 아닙니다.
  공식 기록 연결·S3 복사만으로 시드 전체를 검증 완료로 표시하지 않습니다.
- 기본 필드와 공식 상세·사진·시간·시설의 출처를 분리합니다. `field_evidence`,
  `hours_source`, 조회·관측 시각, 사진 credit/license를 보존합니다.
  이용시간 문구에서 파싱한 반복 요일 행은 각 요일 운영·휴무일의 독립 검증이 아닙니다.
- 인허가 `business_status=open`은 해당 인허가 기록의 상태이며 현재 영업 여부가 아닙니다.
  없는 필드는 생성하지 않고 OpenStreetMap·ODbL 표기를 유지합니다.

[복사 검증](../.local/independence/catalog-import-applied.json) · [데이터 품질](data-quality.md)

`agent/guide/`, `agent/tools/`는 검증된 소스의 초기 읽기 전용 복사 이후 이 프로젝트가
소유합니다. 후속 빌드·실행은 참조 저장소 경로를 읽지 않습니다.
의존성도 [전용 아티팩트 manifest](../agent/dependency-artifacts.json)로 고정합니다.

## 화면과 경로 계산

검색·카테고리·현재 지도·주변 탐색은 카탈로그 API를 사용합니다. 초기 지도에는 대표 명소만
표시하고, 사용자가 선택한 검색·분류에 따라 GPU 장소 레이어를 켭니다.
상세에는 제공처별 한영 기록·주소·연락처·소개·이용 정보·허용 사진과 근거를 표시합니다.

여행은 최대 12곳의 순서·체류 시간을 보존하며 **실제 도보/차량 경로**를 비교합니다.
거리·예상 시간은 BFF가 반환한 경로 결과를 사용하고, 체류 시간은 계획 합계에 더합니다.
구간 안내·GPX·이동 수단을 포함한 공유, 상세의 출발/도착 지정과 명시적 위치 요청을 지원합니다.
실패한 경로를 직선이나 0분으로 바꾸지 않으며 새 경로·수단 변경 시 이전 형상을 제거합니다.
직선 정렬·지도 거리 재기는 도로 이동 거리와 구분합니다.

Valhalla 3.8.3은 동일 ECS 작업의 loopback `127.0.0.1:8002`에 연결합니다.
OSM 그래프 기준은 **2026-09-10T20:21:06Z**, 단면의 Skadi HGT 출처 객체는
**2016-04-23**입니다. 예상 시간은 실시간 교통을 반영하지 않습니다.
명소 관찰 중심점과 실제 입구·도로는 다를 수 있으며 끝점 연결 차이와 200m 스냅 제약을
안내합니다. 배편이 필요한 구간은 도보/차량만의 경로로 제공하지 않습니다.

12개 명소의 3D 관찰·회전·위에서 보기, 실제 경로 미리보기와 고도 단면을 제공합니다.
단면은 화면 고도 배율과 독립적인 DEM 표본입니다. 결측을 0m로 채우거나 누락 구간의
전체 상승량을 단정하지 않습니다. 정상 표고·정밀 측량·현재 건축물·사진측량 모델과 구분합니다.
한국어/English·NanumSquare·모바일·키보드·동작 감소 설정을 유지합니다.

## API 계약과 보호

정식 타입은 [shared/api-types.ts](../shared/api-types.ts)와
[shared/routing-types.ts](../shared/routing-types.ts)에 있습니다.

| API | 핵심 계약 |
|---|---|
| `GET /api/config` | 버전·기능·한도, 서명 쿠키와 세션에 묶인 CSRF 증명. `routing.enabled/modes/source/csrf_token` 포함 |
| `GET /api/catalog/status` | 건수·분류·출처·기준일·신선도 |
| `GET /api/catalog/search` | 검색·분류·좌표·반경·페이지 조건, `{items,total,has_more}` |
| `GET /api/catalog/points` | bbox·분류로 제한한 컴팩트 GeoJSON |
| `GET /api/catalog/places/{id}` | `encodeURIComponent(id)`로 조회하는 기본·보강·공식 상세 |
| `GET /api/weather` | 선택 좌표의 Open-Meteo 현재 날씨·3일 예보·출처·시각 |
| `POST /api/routes` | `{mode:'walk'|'car',locale:'ko'|'en',stops:{lng,lat}[]}`; 2~12곳 |
| `POST /api/elevation` | `{coordinates:[lng,lat][]}`; 2~256개, 같은 순서의 `elevations_m`과 출처, 결측은 null |
| `POST /api/guide` | `{message,request_id,locale,conversation_id?}`; SSE `session/status/text/map/done/error` |

위치 입력은 `126.15 ≤ lng ≤ 126.98`, `33.1 ≤ lat ≤ 33.6` 범위로 검증합니다.
경로·고도 POST는 서명 쿠키와 `X-Atlas-CSRF`를 검증하고 앱 프로세스에서
actor당 분당 **60회**를 함께 제한합니다. 경로 엔진 주소·옵션은 사용자 입력으로 받지 않습니다.
이 요청들은 AI 모델이나 AI 사용량을 소모하지 않습니다.

AI는 한국 날짜 기준 전체 하루 **30회**, 사용자별 시간당 **5회**, 전체 동시 **2회**로
제한합니다. DynamoDB의 원자적 입장·실행 잠금·요청 ID로 여러 웹 태스크를 조정합니다.
UUID4 `request_id`와 언어·질문은 한 번의 제출과 허용된 인증 복구 동안 유지합니다.
본문은 16KB, 질문은 2,000자, 스트림은 90초 제한·8초 heartbeat입니다.
카탈로그 공개 GET과 달리 설정·경로·고도·AI는 비공개 `no-store`입니다.

브라우저가 actor ID·런타임 ARN·AWS 자격 증명을 지정하거나 받지 않습니다.
Guide는 올바른 Origin 또는 유효한 세션·CSRF 조합을 확인하며,
경로·고도는 canonical Origin에서도 세션·증명이 필요합니다.
모델 호출 전의 정확한 `invalid_conversation`, `session_required`, `csrf_invalid`만
동일 질문으로 총 한 번 복구합니다. 네트워크·5xx·SSE 오류·사용량 초과는 재전송하지 않습니다.

## 전용 AgentCore 연결

전용 Guide는 `JejuAtlas_Guide-2sFw9YBI8V`, Tools는 `JejuAtlas_Tools-Nh0YFIFC7c`입니다.
Guide는 IAM으로 전용 HTTP Gateway의 `/JejuAtlasTools/invocations`를 호출합니다.
이전 Gateway나 집계형 `/mcp` 주소는 새 연결의 기본값이 아닙니다.
일반 질문 Sol·일정 Astra의 Global CRIS 설정, 전용 Memory 4개 전략을 사용합니다.
[리소스·메모리·로그 구성](agentcore-components.md)

일반 질문에는 지도 중심을 자동 추가하지 않고, 현재 지도·선택 장소·내 코스를 직접 참조한
질문에만 맥락을 붙입니다. 명소 별칭은 카탈로그의 확인된 전체 이름과 대조합니다.
같은 ID의 시설·시간·공식 상세를 별도로 표시하고 모델이 만든 시설 정보와 혼합하지 않습니다.
범위 없는 가족·실내 추천의 카탈로그 참고 후보는 명시적으로 구분합니다.

화면은 안전한 GFM 마크다운, 생각 중 상태·실제 사용 도구·추가 모델 호출 없는 후속 질문을
지원합니다. 원시 HTML·위험한 링크·임의 외부 이미지를 마크다운에서 허용하지 않습니다.
대화 토큰은 사용자와 유휴 14분에 묶이며 기기 자료 삭제와 서버 Memory 삭제는 별개입니다.

전용 Guide의 한국어 **17.553초**, 영어 **25.434초** 호출은 정상 `done`으로 종료됐습니다.
관측 8,260건에서 입력 표식·질문·답변 유출은 검출되지 않았고 모델·도구·토큰 메타데이터는
유지됐습니다. Runtime 서비스가 자동 생성한 전용 로그 두 개에 `configure-logs`로
14일 보관을 적용했습니다. [네이티브 근거](mobility-independence-2026-09-11.md#네이티브-검증)

## 저장·검증·공개 전환

여행·즐겨찾기는 브라우저 저장과 검토 후 가져오기/삭제를 사용합니다. 코스 공유 fragment는
방문 순서·좌표·체류 시간·출처·이동 수단을 포함합니다. PWA는 앱 셸만 캐시하며
API·지도 타일·사진을 사전 저장하지 않습니다. 오프라인 지도나 경로 계산을 약속하지 않습니다.

실제 로컬 경로·HGT 통합은 [네이티브 브라우저 8/8 보고서](../.local/browser-mobility-native-rate60/report.json)에
있습니다. 해당 브라우저 검사는 모델 호출 0회이며 AI 호출 검증과 별도입니다.
공개 릴리스 `release-20260911T013430Z`의 웹·라우터 이미지 쌍과 전용 연결을 배포했습니다.
공개 API의 검증 지점쌍은 차량 4,571m / 예상 410.673초,
도보 3,885m / 예상 2,770.64초입니다. [공개 응답](../.local/mobility-live-api.json).
웹·라우터 최종 ECR 스캔은 각각 발견 0건이며, 실제 연결·IAM은
[독립성 감사](../.local/independence/final-aws-audit.json)에서 확인했습니다.
[공개 브라우저](../.local/browser-mobility-live-release-20260911T013430Z-observed-config/report.json)는
8/8 통과했으며 실제 경로·고도 POST 16회가 모두 200이었습니다.
[공개 AI 검사](../.local/guide-privacy-live.json)는 26.651초에 답변을 완료하고 관련
로그·트레이스 1,066건의 원문 비기록과 메타데이터 보존을 확인했습니다.
[최종 전체 검사](../.local/checks.json)의 Node 299개·Python 190개 통과(선택적 검사 3개 건너뜀),
스키마·의존성·빌드가 모두 통과했습니다.

2026-09-09~10의 공유 Ohmyjeju 연결·문제 재현·수정 시간은
[초기 배포 이력](deployment.md#초기-배포-이력--2026-09-10-0209-utc까지의-과거-기록)과
[이전 운영 기록](commercial-completion-audit-2026-09-10.md)의 역사 자료입니다.
후속 배포는 `scripts/deploy-atlas-agent.py`를 사용하며 폐기된 공유 Runtime CLI를 실행하지 않습니다.
