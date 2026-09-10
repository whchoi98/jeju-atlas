# 제주 아틀라스 배포 현황과 초기 기록

## 최신 배포 확인 범위

서비스 주소는 `https://jeju-atlas.whchoi.net`이며 기존 CloudFront 주소도 유지합니다.
현재 용량 설정은 **최소 2개·최대 4개 태스크**입니다. 최신 버전과 증거는
[운영 검증 종합 기록](commercial-completion-audit-2026-09-10.md)을 기준으로 합니다.

| 현재 배포 | 확인 내용 |
|---|---|
| 웹 릴리스 | `release-20260910T202150Z` |
| 이미지 digest | `sha256:18fb0b1fa57b1ee5552eec9e9db34717c23319c28fc6e6e78bbfc45a939a54b9` |
| 태스크 정의 | `jeju-3d:11` |
| 원본 HTTPS | 2026-09-10 19:38 UTC 배포 완료, `OriginTlsEnabled=true`, `OriginTlsMode=canonical-host` |
| 원본 Host 함수 | us-east-1 `jeju-3d-origin-host:1` |
| Agent / Tools | 버전 22 / 12, READY — [구성 설명](agentcore-components.md) |
| 수집 이미지 | `data-release-20260910T195513Z`, `sha256:b21f3acd4f5b54054168993cb64de2f81d7ee1d2dba817e68389be57e56e665d` |
| 수집 태스크 | `jeju-3d-data:3`; 실제 실행 exit code 0, 부분 수집 완료 |
| 인프라·HTTP | 78개 통과 |
| 최종 회귀 검사 | Node 247개·Python 150개와 빌드 통과 |

근거: [인프라·HTTP](../.local/verification.json),
[최종 빌드 검사](../.local/operations-final-image-build.log),
[원본 TLS 전환 시각](../.local/origin-tls-status.log),
[수집 작업](../.local/data-health-smoke.json).

원본 함수는 기본 동작과 `/api/catalog/*`, `/api/*`에만 연결됩니다.
ALB DNS에 HTTPS로 연결하며 Host를 `jeju-atlas.whchoi.net`으로 고정하므로
**별도 원본 DNS 게시 대기는 해소됐습니다.**
`/assets/*`, `/media/*`, `/terrarium/*`에는 이 함수를 연결하지 않습니다.

공유 자산 버킷은 `jeju-3d-assets-061525506239-ap-northeast-2`,
OAC는 `E2W270OBXMQ1S2`이며 `/assets/*`로 제공합니다. 현재·이전 이미지
3개에 필요한 19개 자산의 HTTP 200·SHA-256 일치와 직접 S3 접근 차단·
매니페스트 비공개를 [검증했습니다](../.local/shared-assets-verification.json).

실제 Astra 영어 요청은 53.433초에 완료됐으며 검사 시간대 로그에 입력 표식·질문·
답변 일부가 검출되지 않았습니다. 모델·도구 이름과 토큰 수는 남습니다.
두 Runtime 로그 그룹에 14일 보관을 적용했습니다.
[개인정보 검사](../.local/guide-privacy-live.json) · [보관 정책](../.local/runtime-log-retention-applied.json)

최종 부하 검사는 50개 세션·500 GET, 오류 0건, p50 41.702ms·p95 275.421ms·
최대 502.158ms입니다. [측정 범위](load-recovery.md)는 HTTP 검사에 한정합니다.
공식 상세의 실제 `stale=0`은 확인했지만 제공처 실패 3건은 실제 `ALARM`이며,
완료 누락 알람은 20:35 UTC에 `INSUFFICIENT_DATA`였습니다.
[데이터 알람과 마지막 정상 자료 유지](operations.md#공식-상세와-수집-작업)를 함께 확인해야 합니다.

실제 이미지의 로컬 롤백 예행연습과 AWS 검토 가능 계획까지 준비했으며
**운영 롤백은 실행하지 않았습니다.** 운영 알림 수신자·월 예산과 경보 기준·
사업자/서비스 연락처가 남아 있고 `main` 병합은 명시적 승인 후 진행합니다.
기능·수집 범위는 [공식 장소 상세와 올레길](official-details-olle.md),
이전 릴리스의 결과는 [과거 공식 상세·올레길 기록](details-olle-release-2026-09-10.md)에 보존합니다.

## 초기 배포 이력 — 2026-09-10 02:09 UTC까지의 과거 기록

**이하의 태스크 1개, `jeju-3d:7`, 이미지·검사 수·비용은 당시 기록입니다.
현재 배포 상태나 후속 릴리스의 검증 결과로 해석하지 않습니다.**

최초 배포: **2026-09-09 16:56 UTC**

고도 타일 캐시 업데이트 완료: **2026-09-09 17:30 UTC**

운영 카탈로그·여행 코스·AI·PWA 업데이트 완료: **2026-09-09 19:05 UTC**

AI 가이드·대표 아이콘·카테고리 탐색 최종 수정 배포 완료: **2026-09-09 23:30 UTC**

대화 복구·마크다운·도구 표시·추천 말풍선·나눔스퀘어 배포 완료: **2026-09-10 01:39 UTC**

Origin 차이 처리·세션 요청 토큰 보완 배포 완료: **2026-09-10 02:08 UTC**

당시 인프라 검증: **2026-09-10 02:09 UTC**

**서비스:** https://d2mznud99i2mdr.cloudfront.net

**상태 확인:** https://d2mznud99i2mdr.cloudfront.net/healthz

### 당시 생성한 앱 리소스

| 항목 | 값 |
|---|---|
| AWS 계정 | `061525506239` |
| 리전 | `ap-northeast-2` |
| CloudFormation | `Jeju3dRegistry` — `CREATE_COMPLETE`, `Jeju3dApp` — `UPDATE_COMPLETE` |
| CloudFront | `E20RRTIO667ZDY` — `Deployed` |
| 고도 타일 경로 | `/terrarium/{z}/{x}/{y}.png` |
| 고도 캐시 정책 | `bab63f7f-ec61-476f-9894-3fb97d18623b` |
| 고도 응답 함수 | `jeju-3d-terrain-browser-cache` |
| ALB | `jeju-3d-alb` |
| ALB DNS | `jeju-3d-alb-1953229828.ap-northeast-2.elb.amazonaws.com` |
| Target Group | `jeju-3d-tasks` |
| ECS 클러스터 / 서비스 | `jeju-3d` / `jeju-3d` |
| Task Definition | `jeju-3d:7` |
| 배포 용량 | ARM64, 0.25 vCPU, 512 MiB, 1개 태스크 |
| ALB SG | `sg-06eb051b85d92d155` |
| Task SG | `sg-05884348204666b85` |
| 로그 그룹 | `/ecs/jeju-3d` |
| ECR | `061525506239.dkr.ecr.ap-northeast-2.amazonaws.com/jeju-3d` |
| 릴리스 | `release-20260910T020356Z` |
| 읽기 전용 카탈로그 | `ohmyjeju-catalog-061525506239-prod/catalog/catalog.sqlite` |
| AI 호출 한도 테이블 | `jeju-3d-guide-quota` |
| AI 런타임 | 기존 `Ohmyjeju_OhmyjejuAgent-7fiRWV5uVi` 버전 16, READY 재사용 |

당시 배포 이미지:

```text
061525506239.dkr.ecr.ap-northeast-2.amazonaws.com/jeju-3d@sha256:48b0b8783ba848665263df40667895fbd001fbaa0eeb44cbb50594767bd91e52
```

### 당시 재사용한 네트워크

VPC: **`cc-on-bedrock-vpc` — `vpc-0dfa5610180dfa628`**

| 역할 | AZ | 서브넷 | 기존 기본 경로 |
|---|---|---|---|
| ALB Public | `ap-northeast-2a` | `subnet-08486a1e618b1991e` | `igw-0119eaa5d417c8839` |
| ALB Public | `ap-northeast-2b` | `subnet-0c161777c4031c320` | `igw-0119eaa5d417c8839` |
| ECS Private | `ap-northeast-2a` | `subnet-07b1e65682847dce9` | `nat-00b8a70dc184a4d0c` |
| ECS Private | `ap-northeast-2b` | `subnet-095297380cd45e1eb` | `nat-08379e076e2e6e234` |

확인 당시 실행 태스크의 ENI는 `eni-01738ee83b09427ff`, Private IP는 `10.100.44.114`이며 Public IP는 없습니다. 태스크 교체 시 ENI/IP는 변경될 수 있습니다.

새 VPC, 서브넷, NAT Gateway, EIP, 라우트 테이블은 생성하지 않았습니다. 기존 네트워크 스택과 라우팅을 변경하지 않았습니다.

### 당시 접근 경로

1. 브라우저는 CloudFront에 HTTPS로 접속합니다. HTTP 접속은 HTTPS로 리다이렉트합니다.
2. ALB TCP 80은 AWS 관리 Prefix List `pl-22a6434b` (`com.amazonaws.global.cloudfront.origin-facing`)만 허용합니다.
3. CloudFront의 원본 검증 헤더 값이 일치할 때만 ALB가 태스크에 전달합니다. 기본 리스너 응답은 403입니다.
4. ECS TCP 8080은 ALB 보안 그룹만 허용합니다. 태스크는 비루트 사용자와 읽기 전용 루트 파일시스템으로 실행하며, `/tmp`만 SQLite 캐시용 쓰기 볼륨입니다.
5. 태스크 역할은 지정된 S3 카탈로그 객체 읽기, 지정된 AgentCore 런타임과 DEFAULT 엔드포인트 호출, 전용 할당량 테이블 조건부 업데이트만 허용합니다.

**당시 CloudFront→ALB 구간은 HTTP였습니다.** 당시에는 기본 CloudFront 주소를 사용했습니다. 이후 HTTPS 전환 상태는 [위 최신 배포 확인 범위](#최신-배포-확인-범위)를 참고합니다.

고도 요청 `/terrarium/*`는 별도 동작으로 **CloudFront→기존 공개 S3 원본(HTTPS)** 경로를 사용합니다. ALB/Fargate를 통과하지 않고 ALB 원본 검증 헤더도 전달하지 않습니다. 위성 영상은 기존 Esri 경로를 유지합니다.

`/api/catalog/*`는 공개 카탈로그용 60초 캐시이며 쿠키를 전달하지 않습니다. 나머지 `/api/*`는 CachingDisabled로 세션과 Origin을 전달합니다. AI·세션 응답은 `no-store`입니다.

### 당시 카탈로그·가이드 추가

- 실제 운영 S3의 **6,724곳**을 검색·분류·주변 탐색합니다. OpenStreetMap 6,587곳과 큐레이션 시드 137곳의 출처를 유지합니다.
- 137건의 기본 이름·좌표·주소·소개를 공식 대조 검증값으로 취급하지 않습니다. 공식 소스와 매칭된 사진·시간·인허가 등 보강 필드의 출처를 따로 표시합니다.
- 사진 credit/license, 요일별 이용시간, 편의·메뉴·인허가 상태, 관측·갱신일을 제공합니다. 없는 값을 생성하지 않으며 인허가 `open`을 현재 시각의 “영업 중”으로 표시하지 않습니다.
- 첫 지도에는 대표 명소만 표시하고 전체 카탈로그 점을 요청하지 않습니다. 카테고리·검색을 선택하면 관련 장소를 GPU 그림 아이콘으로 표시하며 목록은 페이지당 40개입니다. 협재해변 등 대표 아이콘을 카탈로그 상세로 연결합니다.
- 즐겨찾기·코스 순서·체류시간을 브라우저에 저장하고 공유 주소로 복원합니다. 직선 연결선과 도로 경로를 구별합니다.
- 선택 지점의 Open-Meteo 날씨·3일 예보와 기존 Ohmyjeju AI 가이드를 연결합니다.
- PWA 앱 셸과 저장한 코스를 오프라인에서 볼 수 있습니다. API·지도 타일·외부 사진은 서비스 워커 사전 저장 대상이 아닙니다.

카탈로그 파일은 S3 ETag를 10분마다 확인해 검증된 파일로 교체합니다. 읽기 실패 시 마지막 정상 파일과 갱신 지연 상태를 유지합니다. 참조 프로젝트, 원본 S3 카탈로그와 보강 파이프라인은 변경하지 않았습니다.

AI는 서명된 HttpOnly/Secure/SameSite 쿠키와 사용자에 묶인 대화 토큰을 사용합니다. 한국 날짜 기준 전체 하루 30회, 사용자별 시간당 5회, 최대 2개 동시 요청·90초 제한을 적용합니다. DynamoDB 한도 기록에 실패하면 모델 호출을 시작하지 않습니다. 모델 비용은 호출 내용과 사용량에 따라 별도 발생합니다.

일반 질문에는 초기 지도 중심을 자동으로 붙이지 않습니다. “아이와 함께…” 질문이 지도 중심 5km 안에서 빈 검색을 반복하던 원인을 수정했습니다. 지도·선택 장소·내 코스를 명시한 질문에는 맥락을 유지합니다.

추천에 카탈로그 편의 정보·출처·미확인 항목을 함께 표시합니다. 시간 문구에서 변환한 시간대에는 휴무일 미확인을 명시하고, 기본 시드를 공식 대조 검증으로 취급하지 않습니다. 긴 SSE 응답과 최신 답변 스크롤, 검색 범위 변경 시 이전 응답 취소도 보완했습니다.

범위가 없는 아이 동반·실내 추천은 실제 카탈로그 태그와 분류에서 후보를 먼저 조회해 전달합니다. 입력 2,000자·호출 한도를 유지하고, 결과가 부족할 때 제공하는 카탈로그 참고 장소는 AI 검색 결과와 구분합니다. 공개 주소에서 사용자 질문 “아이와 함께 방문할 장소를 추천하고 편의 정보가 확인되는지 알려 주세요.”에 **25.3초** 만에 김녕미로공원·넥슨컴퓨터박물관의 AI 추천과 편의 정보가 반환됨을 확인했습니다. 이 시간은 한 번의 검증 관측값입니다.

한라산 주변 검색은 카탈로그에서 확인한 `한라산국립공원` 이름으로 전달하여 동명이 유사한 시내 카페와 구분합니다. 참조 Agent의 기존 거리 확장과 음식 제한 처리를 유지합니다. 대화가 만료되면 모델 호출 전의 세션 오류에 한해 같은 질문을 한 번 복구하고, 사용 중인 대화는 유휴 14분 기준으로 토큰을 갱신합니다.

가이드 응답은 안전한 GFM 마크다운으로 표시합니다. 준비 중에는 AI 상태와 실제 사용 도구를 보여주며, 하단 추천 말풍선은 입력·대화에 맞춰 갱신되고 선택 시 입력창에 담깁니다. 페이지·폼·지도 라벨은 NAVER 원본 나눔스퀘어 두 글꼴을 자체 제공하고, UI 이모지는 작은 로컬 SVG로 표시합니다. 글꼴과 이모지는 PWA 앱 셸에 포함됩니다.

운영 가이드에서 반복된 `origin_forbidden`을 보완하기 위해 비공개 설정 응답에서 세션에 묶인 요청 토큰을 발급합니다. CloudFront는 `X-Atlas-CSRF` 헤더를 API에 전달하며, Origin이 없거나 달라도 유효한 서명 쿠키·토큰 조합을 확인합니다. 다른 세션·위조·만료 토큰은 모델 호출 전에 차단하고, CORS 허용 범위와 사용 한도는 유지합니다. 실제 브라우저에서 Origin을 `null`로 바꾼 조건으로 “성산일출봉 근처 맛집을 알려주세요.”를 요청해 **23.7초**에 정상 응답·지도·도구 표시를 확인했습니다.

### 당시 고도 캐시 적용 결과

- 엣지 기본 TTL **7일**(최소 0초, 최대 30일), 정상 타일 브라우저 TTL **1일**.
- 오류 응답은 `no-store`; 304 재검증은 정상 브라우저 TTL을 유지합니다.
- 쿠키·쿼리·사용자별 헤더 없이 타일 경로 단위로 캐시를 공유합니다.
- PNG 원본 바이트, 지형 해상도, 고도 값은 변경하지 않았습니다.
- 별도 서울 S3 복제본과 서버 증설 없이 기존 CloudFront를 확장했습니다.

2026-09-09 17:31 UTC에 서울 실행 환경에서 제주 고도 타일 **5개 × 3회**를 번갈아 다운로드했습니다.

| 측정 | 중앙값 |
|---|---:|
| 공개 S3에 직접 요청 | 200.449 ms |
| CloudFront 캐시 적중 | 4.758 ms |
| 다운로드 지연 감소 | 97.6% |
| 반복 요청 캐시 적중 | 15/15 |

각 타일의 SHA-256과 PNG 바이트가 원본과 같고, 304 재검증과 없는 타일의 404 `no-store`도 확인했습니다. 이 수치는 **검증 호스트에서 캐시가 적중한 샘플의 다운로드 지연**입니다. 사용자 기기의 FPS나 전체 페이지 로딩 시간 개선율을 의미하지 않으며, 캐시 미스는 원본 왕복이 필요합니다.

### 당시 검증 결과

| 검사 | 결과 |
|---|---|
| TypeScript + Vite 빌드 | 성공 |
| Node 24 HTTP·SQLite·세션·가이드·날씨·고도 함수 검사 | 149개 통과 |
| 고도 응답 함수 검사 | 200·206·304·403·404·500·503 상태 통과 |
| CloudFormation 최초 배포 재계획 회귀 검사 | 1개 통과 |
| cfn-lint | 오류 없음 |
| cfn-nag | 실패 0건, 개발 구성에 따른 경고는 README에 명시 |
| npm 런타임 의존성 audit | 취약점 0건 |
| 당시 이미지 ECR Inspector | 지속 검사 ACTIVE, 2026-09-10 02:04 UTC 검사 결과 발견 0건 |
| 실제 공개 주소의 브라우저 검사 | 11개 통과 |
| 카탈로그·코스·실제 AI·PWA·모바일 통합 검사 | 10개 통과 |
| 대표 아이콘·카테고리·현재 지도 목록·모바일 검사 | 공개 주소 7개 통과 |
| 질문 맥락·편의 표시·상세 연결·답변 스크롤 검사 | 제어된 SSE 5개 통과 |
| 지연된 지도 응답 경합 검사 | 범위 변경 후 이전 요청 취소·최신 40개 핀 유지 |
| 대화 만료·마크다운·생각 중·도구·추천 말풍선·모바일 검사 | 제어된 HTTP/SSE 브라우저 검사 10개 통과 |
| 나눔스퀘어 및 UI 이모지 | 공식 원본 WOFF 2개와 로컬 SVG 6개 로드 확인 |
| 실제 AWS/HTTP 인프라 검사 | 요청 증명 전달·위조 차단 포함 48개 통과 |
| 고도 캐시 HTTP 검사 | PNG 일치·15회 적중·304·오류 no-store 통과 |

브라우저는 실제 DEM과 위성 타일을 받아 한라산의 고도를 샘플링했습니다. 검색, 장소 분류, 2D/3D, 고도 배율, 지형 색상, 자동 둘러보기, 공유 URL 복원, 모바일 장소 서랍과 선택 정보 표시를 확인했습니다. 위성/고도 데이터 출처를 화면에 표시하며 영상이 실시간이라고 주장하지 않습니다.

인프라 검사는 CloudFront `Deployed`, ECS steady state, 컨테이너 및 ALB Target Health, Private ENI, Public IP 비활성화, SG/Prefix List, 원본 검증 값 일치, 기존 NAT 경로, HTTP→HTTPS, 정적 자산의 CloudFront cache hit, 존재하지 않는 파일의 404를 확인했습니다. 일반 인터넷 출발지에서 ALB 직접 접속은 TCP 단계에서 차단되었습니다.

당시 검증에 사용한 자료 경로입니다. 반복 검사로 갱신되는 파일은 실행 시각과
릴리스를 [운영 보강 기록](commercial-release-2026-09-10.md)과 대조해야 합니다.

- [인프라 검사 JSON](../.local/verification.json)
- [기존 3D 기능 운영 브라우저 검사 JSON](../.local/browser-after-guide-fix/report.json)
- [카탈로그·실제 AI·PWA 운영 브라우저 검사](../.local/guide-browser-fix-production/report.json)
- [대표 아이콘·분류·지도 목록 운영 검사](../.local/map-discovery-production/report.json)
- [카탈로그·여행·PWA 로컬 통합 브라우저 검사](../.local/guide-browser-fix-local/report.json)
- [가이드 화면 회귀 검사](../.local/guide-regression-local/report.json)
- [늦은 지도 응답 취소 검사](../.local/map-race-after/report.json)
- [대화 복구·GFM·도구·말풍선·모바일 검사](../.local/guide-session-local/report.json)
- [새 화면·여행·오프라인 로컬 검사](../.local/guide-browser-ui-local/report.json)
- [한라산 실제 응답 및 나눔스퀘어 운영 검사](../.local/hallasan-guide-production/report.json)
- [Origin 차이 조건의 성산일출봉 실제 응답 검사](../.local/seongsan-origin-proof-production/report.json)
- [고도 캐시 검사와 지연 측정 JSON](../.local/terrain-cache-verification.json)
- [ECR 검사 JSON](../.local/image-scan-origin-proof.json)
- [데스크톱 위성 지도](../.local/browser-terrain-cache/desktop-satellite.png)
- [데스크톱 고도 지도](../.local/browser-terrain-cache/desktop-terrain.png)
- [모바일 지도](../.local/browser-terrain-cache/mobile-map.png)
- [모바일 장소 선택](../.local/browser-terrain-cache/mobile-place.png)
- [대표 명소로 시작하는 지도](../.local/map-discovery-production/initial-representatives.png)
- [공식 보강 사진과 장소 상세](../.local/guide-browser-fix-production/official-detail.png)
- [여행 코스 편집](../.local/guide-browser-fix-production/trip-planner.png)
- [실제 AI 가이드 응답](../.local/guide-browser-fix-production/live-guide.png)
- [오프라인 저장 코스](../.local/guide-browser-fix-production/offline-trip.png)
- [모바일 여행 코스](../.local/guide-browser-fix-production/mobile-trip.png)

`.local`은 실제 검증 기록으로 워크스페이스에 보관하며 Git에는 포함하지 않습니다. 최초 배포의 미사용 테스트 이미지 2개는 정리했으며, 현재 이미지와 이전 정상 릴리스 이미지는 보존했습니다.

### 당시 운영 비용과 범위

당시 월 730시간, 태스크 1개 기준 고정성 비용 추정은 약 **$32.02**, 소규모 트래픽을 포함한 예시는 **월 $35–45**였습니다. 현재의 최소 2개 태스크·운영 스택·공식 데이터 수집 구성에 적용하는 견적이 아닙니다. 세금·할인·크레딧은 미반영이며 기존 NAT의 추가 처리량은 별도입니다.

고도 캐시 사용에 따른 CloudFront 전송·HTTPS 요청·함수 실행료가 추가됩니다. 2026-09-09 조회한 아시아 태평양 구간 단가에서 100GB 전송 + HTTPS 100만 건 + 함수 100만 실행의 예시는 **약 $13.30 추가**이며 무료 구간·할인·세금 미반영입니다. 사용량 예시이며 월간 사용량 예측은 아닙니다.

당시에는 상시 다중 태스크 이중화가 없었습니다. 이후 **최소 2개·최대 4개 태스크**와 두 AZ 배치, 한 태스크 교체 검증을 완료했습니다. 해당 시점의 증거는 [운영 보강 기록](commercial-release-2026-09-10.md)에 있으며, 새 릴리스의 검증 완료 여부는 별도로 확인합니다. 재배포와 보관 리소스는 [README](../README.md)를 참고하세요.

카탈로그·AI 업데이트는 별도 세션 키 보관, 소량의 S3 읽기와 DynamoDB 요청, AgentCore·모델 사용료가 추가됩니다. 기존 카탈로그 버킷과 AI 런타임을 재사용합니다. 하루 30회는 요청 횟수 상한이며 고정 금액 예산은 아닙니다.
