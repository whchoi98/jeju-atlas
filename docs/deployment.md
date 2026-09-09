# 제주 아틀라스 배포 결과

최초 배포: **2026-09-09 16:56 UTC**

고도 타일 캐시 업데이트 완료: **2026-09-09 17:30 UTC**

운영 카탈로그·여행 코스·AI·PWA 업데이트 완료: **2026-09-09 19:05 UTC**

최종 인프라 검증: **2026-09-09 19:07 UTC**

**서비스:** https://d2mznud99i2mdr.cloudfront.net

**상태 확인:** https://d2mznud99i2mdr.cloudfront.net/healthz

## 생성한 앱 리소스

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
| Task Definition | `jeju-3d:3` |
| 배포 용량 | ARM64, 0.25 vCPU, 512 MiB, 1개 태스크 |
| ALB SG | `sg-06eb051b85d92d155` |
| Task SG | `sg-05884348204666b85` |
| 로그 그룹 | `/ecs/jeju-3d` |
| ECR | `061525506239.dkr.ecr.ap-northeast-2.amazonaws.com/jeju-3d` |
| 릴리스 | `release-20260909T185508Z` |
| 읽기 전용 카탈로그 | `ohmyjeju-catalog-061525506239-prod/catalog/catalog.sqlite` |
| AI 호출 한도 테이블 | `jeju-3d-guide-quota` |
| AI 런타임 | 기존 `Ohmyjeju_OhmyjejuAgent-7fiRWV5uVi` 재사용 |

배포 이미지:

```text
061525506239.dkr.ecr.ap-northeast-2.amazonaws.com/jeju-3d@sha256:204ff4b0127910ba6e82542115b08ff7b587ddec4b7da4ed10772309c658ec98
```

## 재사용한 네트워크

VPC: **`cc-on-bedrock-vpc` — `vpc-0dfa5610180dfa628`**

| 역할 | AZ | 서브넷 | 기존 기본 경로 |
|---|---|---|---|
| ALB Public | `ap-northeast-2a` | `subnet-08486a1e618b1991e` | `igw-0119eaa5d417c8839` |
| ALB Public | `ap-northeast-2b` | `subnet-0c161777c4031c320` | `igw-0119eaa5d417c8839` |
| ECS Private | `ap-northeast-2a` | `subnet-07b1e65682847dce9` | `nat-00b8a70dc184a4d0c` |
| ECS Private | `ap-northeast-2b` | `subnet-095297380cd45e1eb` | `nat-08379e076e2e6e234` |

확인 당시 실행 태스크의 ENI는 `eni-0f85f80c450a86678`, Private IP는 `10.100.28.81`이며 Public IP는 없습니다. 태스크 교체 시 ENI/IP는 변경될 수 있습니다.

새 VPC, 서브넷, NAT Gateway, EIP, 라우트 테이블은 생성하지 않았습니다. 기존 네트워크 스택과 라우팅을 변경하지 않았습니다.

## 접근 경로

1. 브라우저는 CloudFront에 HTTPS로 접속합니다. HTTP 접속은 HTTPS로 리다이렉트합니다.
2. ALB TCP 80은 AWS 관리 Prefix List `pl-22a6434b` (`com.amazonaws.global.cloudfront.origin-facing`)만 허용합니다.
3. CloudFront의 원본 검증 헤더 값이 일치할 때만 ALB가 태스크에 전달합니다. 기본 리스너 응답은 403입니다.
4. ECS TCP 8080은 ALB 보안 그룹만 허용합니다. 태스크는 비루트 사용자와 읽기 전용 루트 파일시스템으로 실행하며, `/tmp`만 SQLite 캐시용 쓰기 볼륨입니다.
5. 태스크 역할은 지정된 S3 카탈로그 객체 읽기, 지정된 AgentCore 런타임과 DEFAULT 엔드포인트 호출, 전용 할당량 테이블 조건부 업데이트만 허용합니다.

**CloudFront→ALB 구간은 HTTP입니다.** 현재 계정의 Hosted Zone이 실제 공개 DNS에 위임되어 있지 않아 기본 CloudFront 주소를 사용했습니다. 원본 구간 HTTPS에는 공개 검증이 가능한 도메인과 서울 리전의 신뢰된 ACM 인증서가 필요합니다.

고도 요청 `/terrarium/*`는 별도 동작으로 **CloudFront→기존 공개 S3 원본(HTTPS)** 경로를 사용합니다. ALB/Fargate를 통과하지 않고 ALB 원본 검증 헤더도 전달하지 않습니다. 위성 영상은 기존 Esri 경로를 유지합니다.

`/api/catalog/*`는 공개 카탈로그용 60초 캐시이며 쿠키를 전달하지 않습니다. 나머지 `/api/*`는 CachingDisabled로 세션과 Origin을 전달합니다. AI·세션 응답은 `no-store`입니다.

## 카탈로그·가이드 추가

- 실제 운영 S3의 **6,724곳**을 검색·분류·주변 탐색합니다. OpenStreetMap 6,587곳과 큐레이션 시드 137곳의 출처를 유지합니다.
- 137건의 기본 이름·좌표·주소·소개를 공식 대조 검증값으로 취급하지 않습니다. 공식 소스와 매칭된 사진·시간·인허가 등 보강 필드의 출처를 따로 표시합니다.
- 사진 credit/license, 요일별 이용시간, 편의·메뉴·인허가 상태, 관측·갱신일을 제공합니다. 없는 값을 생성하지 않으며 인허가 `open`을 현재 시각의 “영업 중”으로 표시하지 않습니다.
- 지도는 GPU 클러스터와 페이지당 40개 목록을 사용합니다. 6천 개 이상의 DOM 마커를 생성하지 않습니다.
- 즐겨찾기·코스 순서·체류시간을 브라우저에 저장하고 공유 주소로 복원합니다. 직선 연결선과 도로 경로를 구별합니다.
- 선택 지점의 Open-Meteo 날씨·3일 예보와 기존 Ohmyjeju AI 가이드를 연결합니다.
- PWA 앱 셸과 저장한 코스를 오프라인에서 볼 수 있습니다. API·지도 타일·외부 사진은 서비스 워커 사전 저장 대상이 아닙니다.

카탈로그 파일은 S3 ETag를 10분마다 확인해 검증된 파일로 교체합니다. 읽기 실패 시 마지막 정상 파일과 갱신 지연 상태를 유지합니다. 참조 프로젝트, 원본 S3 카탈로그와 보강 파이프라인은 변경하지 않았습니다.

AI는 서명된 HttpOnly/Secure/SameSite 쿠키와 사용자에 묶인 대화 토큰을 사용합니다. 한국 날짜 기준 전체 하루 30회, 사용자별 시간당 5회, 최대 2개 동시 요청·90초 제한을 적용합니다. DynamoDB 한도 기록에 실패하면 모델 호출을 시작하지 않습니다. 모델 비용은 호출 내용과 사용량에 따라 별도 발생합니다.

## 고도 캐시 적용 결과

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

## 검증 결과

| 검사 | 결과 |
|---|---|
| TypeScript + Vite 빌드 | 성공 |
| Node 24 HTTP·SQLite·세션·가이드·날씨·고도 함수 검사 | 66개 통과 |
| 고도 응답 함수 검사 | 200·206·304·403·404·500·503 상태 통과 |
| CloudFormation 최초 배포 재계획 회귀 검사 | 1개 통과 |
| cfn-lint | 오류 없음 |
| cfn-nag | 실패 0건, 개발 구성에 따른 경고는 README에 명시 |
| npm 런타임 의존성 audit | 취약점 0건 |
| 최종 이미지 ECR Inspector | 검사 완료, 취약점 0건 |
| 실제 공개 주소의 브라우저 검사 | 11개 통과 |
| 카탈로그·코스·실제 AI·PWA·모바일 통합 검사 | 9개 통과 |
| 실제 AWS/HTTP 인프라 검사 | 44개 통과 |
| 고도 캐시 HTTP 검사 | PNG 일치·15회 적중·304·오류 no-store 통과 |

브라우저는 실제 DEM과 위성 타일을 받아 한라산의 고도를 샘플링했습니다. 검색, 장소 분류, 2D/3D, 고도 배율, 지형 색상, 자동 둘러보기, 공유 URL 복원, 모바일 장소 서랍과 선택 정보 표시를 확인했습니다. 위성/고도 데이터 출처를 화면에 표시하며 영상이 실시간이라고 주장하지 않습니다.

인프라 검사는 CloudFront `Deployed`, ECS steady state, 컨테이너 및 ALB Target Health, Private ENI, Public IP 비활성화, SG/Prefix List, 원본 검증 값 일치, 기존 NAT 경로, HTTP→HTTPS, 정적 자산의 CloudFront cache hit, 존재하지 않는 파일의 404를 확인했습니다. 일반 인터넷 출발지에서 ALB 직접 접속은 TCP 단계에서 차단되었습니다.

최종 검증 자료:

- [인프라 검사 JSON](../.local/verification.json)
- [기존 3D 기능 운영 브라우저 검사 JSON](../.local/browser-after-guide/report.json)
- [카탈로그·실제 AI·PWA 운영 브라우저 검사](../.local/guide-browser-production/report.json)
- [카탈로그·여행·PWA 로컬 통합 브라우저 검사](../.local/guide-browser-local/report.json)
- [고도 캐시 검사와 지연 측정 JSON](../.local/terrain-cache-verification.json)
- [ECR 검사 JSON](../.local/image-scan.json)
- [데스크톱 위성 지도](../.local/browser-terrain-cache/desktop-satellite.png)
- [데스크톱 고도 지도](../.local/browser-terrain-cache/desktop-terrain.png)
- [모바일 지도](../.local/browser-terrain-cache/mobile-map.png)
- [모바일 장소 선택](../.local/browser-terrain-cache/mobile-place.png)
- [서비스 카탈로그 지도](../.local/guide-browser-production/catalog-overview.png)
- [공식 보강 사진과 장소 상세](../.local/guide-browser-production/official-detail.png)
- [여행 코스 편집](../.local/guide-browser-production/trip-planner.png)
- [실제 AI 가이드 응답](../.local/guide-browser-production/live-guide.png)
- [오프라인 저장 코스](../.local/guide-browser-production/offline-trip.png)
- [모바일 여행 코스](../.local/guide-browser-production/mobile-trip.png)

`.local`은 실제 검증 기록으로 워크스페이스에 보관하며 Git에는 포함하지 않습니다. 최초 배포의 미사용 테스트 이미지 2개는 정리했으며, 현재 이미지와 이전 정상 릴리스 이미지는 보존했습니다.

## 운영 비용과 범위

월 730시간, 태스크 1개 기준 고정성 비용은 약 **$32.02**, 소규모 트래픽을 포함한 예상 비용은 **월 $35–45**입니다. 세금·할인·크레딧 미반영이며 실제 트래픽에 따라 달라집니다. 기존 NAT의 시간당 비용이 추가되지는 않으며 추가 처리량은 별도입니다.

고도 캐시 사용에 따른 CloudFront 전송·HTTPS 요청·함수 실행료가 추가됩니다. 2026-09-09 조회한 아시아 태평양 구간 단가에서 100GB 전송 + HTTPS 100만 건 + 함수 100만 실행의 예시는 **약 $13.30 추가**이며 무료 구간·할인·세금 미반영입니다. 사용량 예시이며 월간 사용량 예측은 아닙니다.

상시 다중 태스크 이중화는 구성하지 않았습니다. 서비스는 두 Private 서브넷에 배치 가능하고 배포 시 일시적으로 태스크가 늘어날 수 있습니다. 재배포, 검증, 이미지 보안 및 삭제 시 보관 리소스는 [README](../README.md)를 참고하세요.

카탈로그·AI 업데이트는 별도 세션 키 보관, 소량의 S3 읽기와 DynamoDB 요청, AgentCore·모델 사용료가 추가됩니다. 기존 카탈로그 버킷과 AI 런타임을 재사용합니다. 하루 30회는 요청 횟수 상한이며 고정 금액 예산은 아닙니다.
