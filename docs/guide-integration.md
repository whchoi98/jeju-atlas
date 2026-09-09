# 서비스 카탈로그·여행 가이드 통합 설계

기준: 사용자 요청 및 2026-09-09 운영 S3 카탈로그 확인.

## 데이터와 참조 프로젝트

- 참조 리포: `/home/ec2-user/my-project/agentcore-cli`, 최신 구현은 해당 저장소의 `main` 브랜치.
- 루트 작업 트리는 `product-01-contracts-bff`이므로 최신 데이터 구현은 `git show main:...`으로 읽는다. 참조 프로젝트·시크릿 파일·운영 카탈로그는 수정하지 않는다.
- 운영 카탈로그: `s3://ohmyjeju-catalog-061525506239-prod/catalog/catalog.sqlite`.
- 확인 당시 6,724개 장소: OpenStreetMap 6,587건 + 큐레이션 137건. `place_extra` 3,153건, 사진 223건, 요일별 시간 178건.
- 큐레이션 137건의 기본 이름·좌표·주소·소개는 워크숍 시드이며 공식 대조 검증으로 간주하지 않는다.
- 큐레이션 중 TourAPI 상세 45, 비짓제주 42, LOCALDATA 상태 19, 사진 41, 요일별 시간 22는 사용자 설명의 보강 수치이다. 매칭 집합은 겹칠 수 있다.
- 기본 필드와 보강 필드의 출처를 구별한다. 사진의 credit/license, 영업시간의 hours_source, 보강 출처·관측일을 보존한다. 인허가 `business_status=open`을 현재 시각의 “영업 중”으로 표시하지 않는다.
- OpenStreetMap 기여자 및 ODbL 표기를 유지한다.

## 구현 범위

1. **전체 카탈로그 탐색:** 검색, 분류, 현재 지도 범위, 주변 거리 검색. 목록은 페이지로 받고 지도는 GPU 클러스터/점 레이어로 표시한다.
2. **장소 상세:** 제공된 주소·소개, 사진과 이용허락·출처, 요일별 시간, 편의 정보, 인허가 상태, 메뉴, 갱신일. 없는 정보를 생성하지 않는다.
3. **여행 코스:** 즐겨찾기·방문 순서·체류 시간, 순서 변경, 가까운 순서 정렬, 3D 지도 연결선, 브라우저 저장·공유. 직선거리와 도로 이동 경로를 구별한다.
4. **날씨:** 현재 선택 지점의 키 없는 Open-Meteo 조회, 출처·예보 기준 시각, 실패 시 오류 안내. 조작 중 반복 요청을 줄인다.
5. **AI 가이드:** 현재 카탈로그를 사용하는 기존 Ohmyjeju AgentCore 런타임 재사용. 서버에서 IAM 호출하고 결과를 검증한다. 서명 쿠키로 사용자 분리, 서명된 대화 ID, 스트리밍 상태, 하루 30회 전체 호출 상한.
6. **PWA:** 앱 셸과 저장한 코스. API·지도 타일·외부 사진은 서비스 워커에 사전 저장하지 않는다.

기존 MapLibre 3D 지형, 실제 고도 데이터, 7일 엣지/1일 브라우저 고도 캐시, 기존 VPC·서브넷·NAT·ALB 보안 경로를 유지한다.

## 서버와 리소스

- Node 24의 SQLite 읽기 전용 연결로 6MB 운영 카탈로그를 사용한다. S3 ETag를 10분마다 확인하고 검증된 새 파일로 교체한다. 원본 장애 시 마지막 정상 파일과 갱신 지연 상태를 제공한다.
- `/tmp` 전용 쓰기 볼륨에 카탈로그를 보관한다. 컨테이너 루트는 읽기 전용이며 UID/GID 1000을 유지한다.
- 태스크 역할: 선택한 카탈로그 S3 객체 읽기, 선택한 Ohmyjeju 런타임 호출, 전용 일일 할당량 테이블 조건부 업데이트만 허용한다.
- 별도 세션 서명 키와 작은 DynamoDB 온디맨드 할당량 테이블을 만든다. 기존 서비스의 사용자·일정 테이블을 수정하지 않는다.
- 카탈로그 GET 경로는 공개 정보용 60초 캐시. 사용자 API·AI 응답은 `no-store`, 쿠키 전달, POST 지원.
- AI는 최대 2개 동시 요청·요청당 90초, 하루 30회(한국 날짜 기준)에서 시작한다. 호출 실패도 이미 시작된 호출 수에 포함한다.
- 기존 런타임: `arn:aws:bedrock-agentcore:ap-northeast-2:061525506239:runtime/Ohmyjeju_OhmyjejuAgent-7fiRWV5uVi`.

## API 계약

응답 타입은 `shared/api-types.ts`에 정의한다.

- `GET /api/config`: 기능, 버전, AI 한도; 세션 쿠키 발급. ARN·시크릿은 반환하지 않는다.
- `GET /api/catalog/status`: 건수·분류·출처·갱신일·오래된 캐시 여부.
- `GET /api/catalog/search?q=&category=&lat=&lng=&radius_m=&limit=&offset=`: `{items,total,has_more}`.
- `GET /api/catalog/points?bbox=w,s,e,n&category=`: GeoJSON FeatureCollection(컴팩트 속성). 제주 범위·개수 상한 검사.
- `GET /api/catalog/places/{encodeURIComponent(id)}`: 기본 필드 및 보강 데이터.
- `GET /api/weather?lat=&lng=`: 현재 날씨와 3일 예보.
- `POST /api/guide`: `{message,conversation_id?}`. SSE `session`, `status`, `text`, `map`, `done`, `error`. 본문 16KB, 메시지 2,000자 제한. 사용자/actor ID는 클라이언트 입력을 받지 않는다.

## 검증과 배포 순서

- 읽기 전용 SQLite 픽스처로 검색·좌표 제한·출처·누락 필드·사진 이용허락을 검사한다.
- 실제 HTTP로 세션 위조, 다른 사용자 대화 ID, 잘못된 Origin, 과도한 본문, 할당량, 스트리밍 오류를 검사한다.
- 브라우저에서 실제 6천 건 이상 카탈로그, 세부 보강 정보, 지도 클러스터, 즐겨찾기, 코스/공유, 날씨, 실제 AI 1회, PWA를 검사한다.
- CloudFormation 변경 집합을 검토하고 기존 네트워크 변경이 없음을 확인한다. 이미지 보안 검사 후 배포한다.
- 인프라·고도 캐시 기존 검사를 유지하고 새 권한 범위를 검사한다.
