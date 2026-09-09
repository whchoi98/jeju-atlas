# 제주 아틀라스 · JEJU ATLAS

실제 제주 고도·위성 지도와 운영 장소 카탈로그, 여행 코스, AI 가이드를 연결한 한국어 앱입니다.

**배포 주소: [제주 아틀라스 열기](https://d2mznud99i2mdr.cloudfront.net)**

[AWS 배포 결과와 검증 기록](docs/deployment.md)

- 제주 전역과 한라산·성산일출봉·우도 등 12개 지형 바로가기
- 운영 S3 카탈로그의 6,724곳 검색·분류·주변 탐색과 GPU 클러스터
- 기본 정보와 보강 정보를 구분한 장소 상세, 사진·요일별 이용시간·편의·인허가 상태·출처
- 2D/3D 전환, 위성/고도 지도 전환, 실제 높이 1×~2× 조절
- 장소로 이동, 제주 한 바퀴 자동 둘러보기, 현재 시점 공유
- 즐겨찾기, 코스 순서·체류시간 편집, 직선 연결선, 브라우저 저장과 코스 공유
- Open-Meteo 날씨·3일 예보와 기존 Ohmyjeju AgentCore AI 가이드
- 설치형 PWA, 저장한 코스 오프라인 확인, 모바일·키보드·reduced motion 지원

## 실행

Node.js **24.18.1 이상**과 npm이 필요합니다. 서버는 Node의 SQLite 기능을 사용합니다.

```bash
npm ci
npm run build
npm run dev
```

API 서버를 별도 터미널에서 실행하면 Vite가 `/api`를 로컬 8097 포트로 전달합니다.

```bash
CATALOG_BUCKET=ohmyjeju-catalog-061525506239-prod \
AWS_REGION=ap-northeast-2 \
HOST=127.0.0.1 PORT=8097 NODE_ENV=development \
PUBLIC_ORIGIN=http://localhost:5173 \
node server/server.mjs
```

해당 S3 객체를 읽을 수 있는 AWS 역할이 필요합니다. 읽기 전용 로컬 카탈로그 파일이 있으면 `CATALOG_BUCKET` 대신 `CATALOG_LOCAL_PATH=/absolute/path/catalog.sqlite`를 지정할 수 있습니다. 로컬 AI는 런타임·사용량 테이블·세션 키를 명시적으로 구성한 경우에만 켜집니다.

정적 빌드를 실제 배포 서버로 확인하려면:

```bash
npm run build
HOST=127.0.0.1 PORT=8097 \
CATALOG_LOCAL_PATH=/absolute/path/catalog.sqlite \
PUBLIC_ORIGIN=http://127.0.0.1:8097 \
node server/server.mjs
```

`http://127.0.0.1:8097`에서 엽니다. `/healthz`는 배포 버전이 포함된 JSON을 반환합니다.

## 배포 구조

```mermaid
flowchart LR
    Browser["브라우저"] -->|HTTPS| CF["CloudFront"]
    CF -->|HTTP · 검증 헤더| SG["CloudFront Prefix List SG"]
    SG --> ALB["Public ALB · 2개 AZ"]
    ALB -->|TCP 8080 · ALB SG만 허용| ECS["Private ECS Fargate · ARM64"]
    ECS -->|기존 기본 경로| NAT["기존 NAT Gateway"]
    ECS -->|읽기 전용·ETag 확인| Catalog["기존 운영 S3 카탈로그"]
    ECS -->|IAM·서버 사용자 식별| Agent["기존 Ohmyjeju AgentCore"]
    ECS -->|조건부 일일 카운터| Quota["DynamoDB · AI 호출 한도"]
    CF -->|"/terrarium/* · HTTPS · 고도 캐시"| DEM["Mapzen / AWS Terrain Tiles"]
    Browser -->|위성 영상| Esri["Esri World Imagery"]
```

서울 리전의 기존 `cc-on-bedrock-vpc`를 사용합니다. Public ALB는 AWS 관리 CloudFront 원본 Prefix List만 수신하며, 일치하는 원본 검증 헤더가 없는 요청은 403으로 거절합니다. Fargate는 Private 서브넷에 배치하고 Public IP를 할당하지 않습니다.

새 VPC·서브넷·NAT Gateway·라우트 테이블·공유 보안 그룹·DNS 레코드를 만들거나 변경하지 않습니다. 기존 ECR/CloudWatch VPC Endpoint도 사용 가능합니다.

| 항목 | 구성 |
|---|---|
| Registry 스택 | `Jeju3dRegistry` |
| 앱 스택 | `Jeju3dApp` |
| ECR / ECS 클러스터 / 서비스 | `jeju-3d` |
| Fargate | Linux ARM64, 0.25 vCPU, 512 MiB, 기본 태스크 1개 |
| 컨테이너 | UID/GID 1000, 읽기 전용 루트 파일시스템, Linux capabilities 제거 |
| 앱 IAM 역할 | 지정 S3 카탈로그 객체 읽기, 지정 AI 런타임 호출, 전용 할당량 테이블 UpdateItem |
| 실행 IAM 역할 | 전용 ECR·로그 및 세션 서명 키 주입 |
| 파일시스템 | 루트 읽기 전용, `/tmp` 볼륨만 카탈로그 갱신용 쓰기 허용 |
| 배포 이미지 | SHA-256 digest 고정, 불변 ECR 태그 |
| 로그 | `/ecs/jeju-3d`, 14일 보관 |
| 실패 처리 | ECS deployment circuit breaker / rollback |

사용자→CloudFront는 HTTPS이며 HTTP는 HTTPS로 리다이렉트합니다. **CloudFront→ALB는 HTTP**입니다. 현재 계정의 Hosted Zone과 실제 공개 DNS 위임이 일치하지 않아 기본 CloudFront 주소를 사용합니다. 원본 구간까지 TLS를 적용하려면 공개 검증이 가능한 도메인과 서울 리전 ACM 인증서로 ALB HTTPS 리스너와 CloudFront origin policy를 함께 변경해야 합니다.

## 이미지 보안

빌드와 최종 컨테이너는 Alpine 3.24와 배포판의 Node 24 패키지를 사용합니다. 최종 이미지에는 서버에 필요한 AWS SDK만 남기며 npm·yarn·컴파일러·개발 헤더는 포함하지 않습니다.

Alpine Node는 OpenSSL 공유 라이브러리를 사용합니다. Dockerfile은 `libssl3`/`libcrypto3`를 보안 수정 버전 `3.5.8-r0` 이상으로 업데이트합니다. 기본 이미지 digest와 Node 패키지 버전도 고정하며, 빌드한 최종 이미지를 ECR Inspector로 검사합니다.

## 최초 배포와 재배포

현재 스크립트는 계정 `061525506239` 및 `ap-northeast-2`로 범위를 고정합니다. 다른 계정에 실수로 배포하는 것을 막기 위한 검사입니다.

로컬 요구 사항: AWS 역할/자격 증명, Docker ARM64 빌드, Python 3.9 이상 및 boto3/requests, `cfn-lint`. Python은 유지보수 중인 3.10 이상을 권장합니다.

```bash
python3 scripts/deploy.py network
python3 scripts/deploy.py plan-bootstrap
```

`.local/bootstrap-change-set.json`에서 전용 ECR 저장소 생성 내용을 검토한 다음:

```bash
python3 scripts/deploy.py apply-bootstrap
python3 scripts/deploy.py status-bootstrap
```

Registry 스택이 `CREATE_COMPLETE`가 되면:

```bash
python3 scripts/deploy.py build-push
python3 scripts/deploy.py plan-app
```

`.local/app-change-set.json`에서 앱 변경 내용을 검토한 다음:

```bash
python3 scripts/deploy.py apply-app
python3 scripts/deploy.py status-app
```

`CREATE_COMPLETE` 또는 `UPDATE_COMPLETE`와 CloudFront 배포 완료를 확인합니다.

```bash
python3 scripts/verify.py
```

기존 앱을 재배포할 때는 `build-push` → `plan-app` → 변경 내용 검토 → `apply-app` → `status-app` → `verify.py` 순서로 실행합니다. 필요한 경우 다음 명령으로 HTML 캐시만 무효화합니다.

```bash
python3 scripts/deploy.py invalidate
```

`dist/assets`의 파일명은 콘텐츠 hash를 포함합니다. HTML은 재검증하고, hash가 붙은 JS/CSS/worker는 장기 캐시합니다. 지도 뷰의 상태는 URL fragment에 저장하여 공유하며 CloudFront cache key에는 포함되지 않습니다.

원본 검증 값은 Secrets Manager에서 생성합니다. 스크립트·이미지·출력 파일에 값을 저장하지 않습니다. ECR 로그인 정보는 별도 임시 Docker 설정에만 전달하고 이미지 푸시 후 삭제합니다.

원본 검증 값을 교체할 때는 CloudFront origin header와 ALB listener rule도 함께 업데이트해야 합니다. Secrets Manager의 값 변경만으로 이미 적용된 CloudFormation 동적 참조가 자동 갱신되지는 않습니다.

## 고도 타일 캐시

운영 앱의 고도 타일은 같은 CloudFront 도메인의 `/terrarium/{z}/{x}/{y}.png`에서 받습니다. 별도 캐시 동작이 공개 Mapzen S3 원본에 HTTPS로 연결하므로 고도 요청은 ALB/Fargate를 거치지 않습니다. ALB 원본 검증 헤더는 고도 원본에 전달하지 않습니다.

- 엣지 캐시 기본 TTL: **7일**, 최소 0초, 최대 30일. 원본이 캐시 헤더를 제공하면 캐시 정책 범위 안에서 반영합니다.
- 정상 PNG 및 304 응답의 브라우저 캐시: **1일**.
- 오류 응답: **`Cache-Control: no-store`**, 기존 CloudFront 오류 캐시 TTL 0초.
- CloudFront Functions가 정상 응답의 브라우저 TTL을 설정합니다. 오류에는 함수가 실행되지 않을 수 있어 응답 헤더 정책의 기본값부터 `no-store`로 둡니다.
- 캐시 키에 쿠키·쿼리·사용자별 헤더를 포함하지 않습니다.
- 원본과 같은 PNG 바이트를 제공하며 지형 해상도와 고도 값은 변경하지 않습니다.

로컬 Vite 개발 및 `localhost`/`127.0.0.1` 정적 미리보기는 공개 S3에 직접 연결합니다. 운영 주소에서 실행하는 브라우저 검사는 고도 요청이 CloudFront 도메인을 사용하는지 별도로 확인합니다. 위성 영상은 기존 Esri 서비스에서 받습니다.

서울 S3에 데이터를 복제하지 않고 기존 공개 데이터셋을 캐시합니다. 추가 고정 서버 비용은 없으며, 고도 타일의 CloudFront 전송·HTTPS 요청과 응답 함수 실행량에 따라 비용이 늘어납니다. 검증 호스트의 캐시 적중 지연 측정은 실제 사용자 FPS나 전체 페이지 로딩 시간 측정과 구분합니다.

## 장소 카탈로그와 출처

참고 프로젝트 `/home/ec2-user/my-project/agentcore-cli`의 최신 서비스 구현과 운영 S3 카탈로그를 연결했습니다. 참고 프로젝트와 카탈로그 원본은 수정하지 않습니다.

```text
s3://ohmyjeju-catalog-061525506239-prod/catalog/catalog.sqlite
```

확인 당시 6,724곳은 **OpenStreetMap 6,587곳 + 큐레이션 시드 137곳**입니다. 137곳의 장소 이름은 실제 장소를 바탕으로 하지만 기본 좌표·주소·소개는 공식 대조 검증값으로 취급하지 않습니다. 주간 보강으로 연결된 사진·요일별 시간·인허가 정보는 기본 필드와 출처를 나눠 보여 줍니다.

사진에는 credit/license를 표시하며 KOGL-3·KOGL-4 사진의 원본 비율과 바이트를 유지합니다. 없는 전화·시간·소개를 생성하지 않습니다. `business_status=open`은 **인허가상의 영업/정상 상태**이며, 현재 시각에 문을 열었다는 의미로 표시하지 않습니다.

서버는 S3 ETag를 10분마다 확인합니다. 검증된 새 SQLite 파일로 교체하고, 원본 장애 시 마지막 정상 파일을 유지하면서 갱신 지연을 알립니다. 브라우저의 API 응답에는 출처와 데이터 기준일을 남깁니다.

## AI와 저장

AI는 기존 Ohmyjeju AgentCore 런타임을 사용합니다. 브라우저는 AWS 자격 증명이나 런타임 ARN을 받지 않으며 서버가 IAM으로 호출합니다.

- 서명된 HttpOnly/Secure/SameSite 쿠키에서 사용자 식별자를 만들고 다른 사용자와 메모리를 분리합니다.
- 대화 ID는 사용자와 만료 시각에 묶인 서명 토큰입니다. 클라이언트가 actor/user ID를 지정할 수 없습니다.
- 전체 AI 호출은 **한국 날짜 기준 하루 30회**, 사용자별 시간당 5회, 최대 2개 동시 요청으로 제한합니다.
- 일일 카운터는 `jeju-3d-guide-quota`에 원자적으로 기록합니다. 저장소 오류 시 AI 호출을 시작하지 않습니다.
- 90초 제한과 8초 heartbeat를 사용합니다. API·AI 응답은 캐시하지 않습니다.
- 모델·AgentCore 사용료는 별도이며 호출당 토큰·도구 사용량에 따라 달라집니다.

즐겨찾기와 코스는 이 브라우저의 localStorage에 저장합니다. 코스 공유 주소의 fragment에 순서·좌표·체류 시간·출처를 넣습니다. 연결선과 거리는 직선 기준이며 도로 내비게이션을 의미하지 않습니다.

PWA는 현재 빌드의 앱 셸만 저장합니다. API 응답·고도 타일·외부 사진을 서비스 워커로 사전 저장하지 않습니다. 오프라인에서는 저장한 코스를 확인할 수 있고 지도·새 장소 조회·AI에는 연결이 필요합니다.

## 검증

```bash
node --test --test-concurrency=1 tests/*.test.mjs
python3 -m unittest discover -s tests -p '*_test.py'
npm run build
cfn-lint infra/bootstrap.yaml infra/application.yaml
python3 scripts/verify-terrain-cache.py --rounds 3
```

실제 Chromium 검증은 별도 Playwright 설치와 WebGL2 가능한 브라우저를 사용합니다.

```bash
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
CHROME_EXECUTABLE=/absolute/path/to/chrome \
node scripts/browser-check.mjs http://127.0.0.1:8097 browser-local
```

새 기능 통합 검사는 다음 명령으로 실행합니다. `--live-guide`는 실제 AI를 한 번 호출하므로 운영 사용량에 포함됩니다.

```bash
node scripts/browser-guide-check.mjs http://127.0.0.1:8097 guide-browser-local
node scripts/browser-guide-check.mjs https://d2mznud99i2mdr.cloudfront.net guide-browser-production --live-guide
```

브라우저 검사는 실제 고도·위성 타일, 지도 시점, 검색, 분류, 2D/3D, 고도 배율, 지형 지도, 자동 둘러보기, 공유 복원, 모바일 조작을 확인합니다. 결과와 스크린샷은 `.local/`에 저장합니다.

운영 검증 `scripts/verify.py`는 HTTPS, HTTP 리다이렉트, CloudFront 캐시, ALB Target Health, ECS 안정화, Private ENI, Prefix List/SG, 원본 헤더 일치, 기존 NAT 경로를 실제 AWS API 및 HTTP로 확인합니다. 헤더 값 자체는 출력하지 않습니다.

`verify-terrain-cache.py`는 제주 샘플 5개의 원본/CloudFront PNG 해시, 브라우저 TTL, CORS, 캐시 적중, 다운로드 지연, 없는 타일의 오류 캐시 금지를 확인합니다. 결과는 `.local/terrain-cache-verification.json`에 저장합니다.

## 비용과 운영 범위

730시간/월, 기본 태스크 1개, 서울 리전 On-Demand 단가 기준:

| 항목 | 월 기준 |
|---|---:|
| Fargate 0.25 vCPU / 0.5 GiB ARM64 | 약 $8.29 |
| ALB 시간당 비용 | 약 $16.43 |
| ALB 공인 IPv4 최소 2개 | 약 $7.30 |
| 고정성 비용 합계 | 약 $32.02 |

ALB LCU, CloudFront 요청·전송, ECR, 로그, Secrets Manager, NAT 추가 데이터 처리량은 별도입니다. 소규모 사용은 **월 $35–45 정도**로 예상하며 실제 사용량·세금·할인·크레딧에 따라 달라집니다. 기존 NAT Gateway의 시간당 비용을 새로 추가하지 않습니다.

고도 캐시 도입 후 타일 전송도 이 계정의 CloudFront 사용량에 포함됩니다. 2026-09-09 AWS Price List API 기준 아시아 태평양 그룹의 첫 10TB 구간은 $0.12/GB, HTTPS 요청은 $1.20/100만 건, CloudFront Functions는 무료 구간 초과 시 $0.10/100만 실행입니다. 예를 들어 **추가 100GB + HTTPS 100만 건 + 함수 100만 실행은 약 $13.30**이며, 무료 구간·할인·세금은 미반영입니다.

카탈로그·AI 기능은 세션 키 보관, S3 읽기, DynamoDB 요청, AgentCore·모델 호출 요금이 추가됩니다. 새 카탈로그 버킷이나 AI 런타임을 만들지 않습니다. 일일 호출 상한은 요청 횟수 상한이며 고정 금액 예산을 뜻하지 않습니다. 할당량 테이블은 만료되는 카운터만 저장하므로 PITR 백업을 켜지 않습니다.

태스크 1개를 사용하는 기본 구성입니다. 배포 시 일시적으로 2개 태스크가 실행될 수 있습니다. 상시 다중 태스크 이중화는 구성하지 않았습니다. CloudWatch 앱 로그는 활성화하지만 비용을 고려해 CloudFront/ALB 요청 로그와 별도 KMS 키는 만들지 않습니다.

인프라 보안 검사에서 오류는 없어야 합니다. 기본 CloudFront 인증서/TLS 정책, HTTP origin, 요청 로그 비활성화, AWS 기본 암호화, 전용 리소스 이름, ECR 인증의 필수 wildcard, HTTPS outbound에 관한 cfn-nag 경고는 이 구성의 의도된 범위입니다.

## 데이터 출처와 한계

- 지도 엔진: [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/)
- 고도: [Mapzen / AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
- 고도 데이터 원저작자: [Tilezen attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)
- 위성 영상: [Esri World Imagery](https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer)
- 장소 정보 참고: [Visit Jeju](https://www.visitjeju.net/)

고도 타일은 CloudFront를 통해 공개 S3 원본에서 받고, 위성 타일은 브라우저가 Esri에 직접 요청합니다. 운영용 S3 복제본이나 대량 다운로드 데이터셋은 만들지 않았습니다. 외부 데이터 서비스와 인터넷 연결이 필요합니다. 영상은 실시간 촬영 영상이 아니며, 지역별 촬영 시점과 해상도가 다릅니다. DEM 기반 지형으로 건물 사진측량, 개별 바위의 정밀 모델, 도보 내비게이션을 제공하지 않습니다.

제주 지역 고도에 쓰이는 전 지구 SRTM/GMTED2010 데이터는 USGS, ETOPO1은 NOAA에 출처를 표시합니다. 위성 영상에는 Esri 서비스 메타데이터의 현재 제공자 문구(Esri, Vantor, Earthstar Geographics 및 GIS User Community)를 표시합니다.

기본 고도 배율은 1.5×이며 화면에 표시됩니다. 설정의 `1× 실제 높이`를 선택하면 데이터의 실제 비율로 볼 수 있습니다. DEM 격자 해상도 때문에 정상의 표고와 지도에서 샘플링한 고도는 다를 수 있습니다.

## 파일 구성

```text
src/                    지도·장소·한국어 UI
public/                 정적 자산
server/                 정적 HTTP·SQLite 카탈로그·날씨·보호된 AI API
shared/api-types.ts     브라우저·서버 응답 계약
tests/                  HTTP·SQLite·세션·AI·날씨·배포 검사
infra/                  CloudFormation 템플릿
scripts/                계획·배포·AWS 검증·브라우저 검증
docs/                   설계·구현 계획·배포 결과
.local/                 생성된 결과·검증 자료 (Git 제외)
```

## 정리

서비스가 더 이상 필요하지 않을 때 앱 스택을 삭제하면 CloudFront, ALB, ECS 및 앱 전용 보안 그룹이 정리됩니다. CloudFront 비활성화·삭제는 시간이 걸릴 수 있습니다. ECR 저장소와 CloudWatch 로그 그룹은 실수로 삭제하지 않도록 `Retain`으로 설정되어 있으므로 별도 보관 여부를 결정해야 합니다. 기존 VPC·서브넷·NAT는 이 앱 스택의 소유 리소스가 아닙니다.
