# 제주 아틀라스 | Jeju Atlas

[![Node.js](https://img.shields.io/badge/Node.js-24-43853d)](package.json)
[![AWS](https://img.shields.io/badge/AWS-ECS_Fargate-FF9900)](docs/architecture.md)
[![AgentCore](https://img.shields.io/badge/AI-Bedrock_AgentCore-0972D3)](agent/README.md)
[![Workshop](https://img.shields.io/badge/Workshop-120_min-232F3E)](workshop/README.md)

[한국어](README.md) | [English](README.en.md)

제주의 실제 고도와 위성 지도에서 장소를 찾고, 여행 코스를 만들고, AI 가이드에게 질문하는 웹/PWA 서비스입니다.
지도 표현은 MapLibre, 장소 검색은 카카오 Local, 실제 도보와 차량 경로는 Valhalla가 담당합니다.

[서비스 열기](https://jeju-atlas.whchoi.net/) | [120분 워크숍](https://jeju-atlas.whchoi.net/workshop/) | [문서](docs/README.md) | [변경 이력](CHANGELOG.md)

![제주 아틀라스에서 한라산을 확대한 실제 3D 지도 화면](docs/images/app-terrain-ko.webp)

*앱 화면은 2026-09-13 운영 서비스의 한국어 UI를 캡처했습니다.*

## 개요

TypeScript와 Vite로 만든 화면을 Node.js API 서버와 연결합니다.
AWS에서는 CloudFront, WAF, Public ALB와 Private ECS Fargate를 사용하며 기존 VPC와 NAT Gateway를 재사용합니다.
AI 가이드는 전용 Bedrock AgentCore Runtime에서 Strands로 실행합니다.

마지막 검증 배포는 `release-20260912T153512Z`, ECS 태스크 정의 `jeju-3d:26`입니다.
2026-09-12에 태스크 2개와 ALB 대상의 정상 상태, 운영 검사 99개를 확인했습니다.
수치는 해당 배포의 기록이며 현재 상태 조회를 대신하지 않습니다.
[배포 기록](workshop/DEPLOYMENT.md)에서 확인 범위를 볼 수 있습니다.

## 주요 기능

| 영역 | 구현 내용 |
|---|---|
| 3D 지도 | 실제 고도, 위성 영상, 지형 음영, 2D/3D 전환, 높이 조절 |
| 장소 탐색 | 이름과 분류 검색, 지도 범위 검색, 목록과 지도 위치 연결 |
| 저장 | 즐겨찾기 검색과 분류, 최근 검색과 열람 기록, 자주 쓰는 장소 5곳 고정 |
| 여행 코스 | 출발과 도착 검색, 경유지와 체류시간, 전체 순서 뒤집기 |
| 실제 이동 경로 | Valhalla의 도보/차량 거리와 예상 시간, 구간 안내, GPX |
| AI 가이드 | 한국어/영어, 스트리밍 마크다운, 사용 도구 표시, 추천 질문 |
| 장소 상세 | 제공된 사진, 이용시간, 편의 정보, 출처와 조회 시각 |
| 둘러보기 | 제주 한 바퀴와 확보된 올레길 구간의 3D 재생 |
| PWA | 앱 설치, 저장한 코스와 앱 화면의 오프라인 열람 |
| 접속 집계 | 최근 90초의 접속 세션과 누적 최초 접속 세션 표시 |

기본 지도는 대표 지형 명소부터 표시합니다. 장소 마커는 선택한 검색 결과를 사용합니다.
카카오 조회는 한 번에 15건, 최대 45건이며 넓은 범위의 모든 장소를 한꺼번에 표시하지 않습니다.

## 실제 화면

### 장소 검색

성산일출봉 검색 결과와 선택한 장소를 지도에서 함께 확인하는 화면입니다.

![카카오 장소 검색 결과와 성산일출봉·우도 주변 위성 지도](docs/images/app-search-ko.webp)

### 도보·차량 경로 비교

같은 출발·도착 지점의 도보와 차량 이동 거리·예상 시간을 비교하고, 실제 도로 경로를 지도에 표시합니다.

![도보와 차량 경로 비교, 이동 시간과 지도에 표시된 여행 경로](docs/images/app-routing-ko.webp)

### 모바일

390px 너비의 모바일 화면에서 3D 지도를 살펴보고, 아래 패널을 펼쳐 장소를 검색한 모습입니다.

| 3D 지도 | 장소 탐색 |
| :---: | :---: |
| <img src="docs/images/app-mobile-map-ko.webp" alt="모바일에서 한라산을 확대한 3D 지도" width="320"> | <img src="docs/images/app-mobile-search-ko.webp" alt="모바일 장소 탐색 패널의 성산일출봉 검색 결과" width="320"> |

## 아키텍처

```mermaid
flowchart LR
    User["웹 / PWA"] --> Edge["CloudFront + WAF"]
    Edge --> Host["Lambda@Edge"]
    Host --> ALB["Public ALB"]
    ALB --> App["Private Fargate<br/>Node.js API"]
    Edge --> Static["Private S3<br/>정적 자산 / 사진"]
    App --> Router["Valhalla<br/>같은 태스크의 경로 엔진"]
    App --> Data["S3 / SQLite / DynamoDB"]
    App --> Kakao["Kakao Local API"]
    App --> Guide["AgentCore Guide<br/>Strands"]
    Guide --> Models["Bedrock Global CRIS<br/>Sol / Astra"]
    Guide --> Tools["Gateway / Tools Runtime"]
    Guide --> Memory["AgentCore Memory"]
```

ALB는 CloudFront 원본 Prefix List와 검증 헤더를 확인합니다.
Fargate에는 Public IP를 할당하지 않습니다.
AgentCore Runtime은 IAM 인증을 사용하는 관리형 PUBLIC 네트워크 구성이며 Private Fargate와 구분합니다.
[전체 구성과 데이터 흐름](docs/architecture.md)을 참고하세요.

## 시작하기

Node 24 계열 24.18.1 이상, npm과 Python이 필요합니다.
Python 3.10 이상을 권장하며, AgentCore 워크숍 Runtime은 Python 3.14를 사용합니다.

```bash
git clone https://github.com/whchoi98/jeju-atlas.git
cd jeju-atlas
npm ci
mkdir -p .local
python3 workshop/scripts/catalog_seed.py --output .local/catalog-standalone.sqlite
npm run build

HOST=127.0.0.1 PORT=8097 NODE_ENV=development \
PUBLIC_ORIGIN=http://localhost:8097 \
CATALOG_LOCAL_PATH="$PWD/.local/catalog-standalone.sqlite" \
node server/server.mjs
```

브라우저에서 `http://localhost:8097`을 엽니다. 원격 EC2에서는 해당 포트를 로컬로 전달합니다.
이 경로는 Git에 포함된 137개 시드로 화면을 확인하는 로컬 실행입니다.
카탈로그 생성기는 기존 파일을 덮어쓰지 않으므로 재실행할 때는 생성 단계를 건너뜁니다.

AI, 카카오 조회와 실제 경로는 별도 Runtime, 키와 경로 엔진 설정이 있어야 사용할 수 있습니다.
운영 카탈로그, 공식 API 응답과 경로 그래프는 Git에 포함되지 않습니다.

Vite 개발 화면을 사용할 때는 두 터미널에서 실행합니다.
`.env.example`의 기본 `PUBLIC_ORIGIN`은 `http://localhost:5173`입니다.

```bash
cp .env.example .env
# 터미널 1
node --env-file=.env server/server.mjs
# 터미널 2
npm run dev
```

Python 검사 환경, 포트 설정과 카탈로그 확인은
[로컬 개발 안내](docs/onboarding.md)에 정리했습니다.

## 120분 AgentCore CLI 워크숍

VPC, NAT Gateway, Subnet과 VSCode Server가 제공된 EC2에서 시작합니다.
Codex/Kiro CLI/Claude Code 중 준비된 도구 하나를 사용합니다.
제주 검색 도구를 구현하고 AgentCore CLI로 생성, 로컬 실행, 배포와 호출을 확인합니다.
AgentCore CLI 0.28.1, 언어 의존성, CDK bootstrap과 모델 권한은 진행자가 사전에 확인합니다.

참가자 EC2에는 전체 Git 소스가 필요합니다. 교재 ZIP에는 실행 스크립트와 데이터가 없습니다.
01장의 `core.py prepare`가 참가자 `activate.sh`를 만들고, `core.py doctor`가
Node 24, Python 3.14, 선택한 AI CLI와 본 실습 의존성을 확인합니다.
누락 도구는 `workshop/.local/toolchain/`에 설치하며 시스템 도구와 Claude 인증을 유지합니다.
새 Bash마다 활성화한 뒤 참가자 폴더에서 AI CLI를 엽니다.
워크숍 Runtime은 Sonnet 4.6을 사용하고, Claude Code는 `claude --model claude-sonnet-4-6`으로 고정합니다.
실제 모델 검사는 doctor와 분리하며 배포 리전과 주최자가 확인한 Bedrock 호출 리전을 구분합니다.
심화 앱과 교재 접속에는 참가자 App 스택의 기본 CloudFront HTTPS URL을 사용합니다.
ACM 발급과 DNS/사용자 도메인 등록은 워크숍 준비 사항이 아닙니다.

| 구분 | 구성 |
|---|---|
| 본 실습 | 00~04장, 110분 |
| 여유 시간 | 10분 |
| 심화 자료 | 05~13장, 전체 Atlas 인프라와 운영 |
| 결과물 | 실제 모델과 제주 검색 도구를 사용하는 참가자 전용 Runtime |
| 교재 | Markdown, HTML, 다운로드 ZIP, 오프라인 PWA |

120분은 수업 편성 기준입니다. 실제 계정에서의 배포 리허설 완료를 뜻하지 않습니다.
기본 Runtime과 심화 과정의 Guide/Tools/Gateway/Memory는 별도 배포입니다.

![맥북 형태의 명령 실행 박스](docs/images/workshop-terminal.png)

셸 명령은 터미널 창, AI 프롬프트는 Codex, Kiro CLI, Claude Code 입력 박스로 구분합니다.
본문은 1366px 화면에서 약 1020px까지 사용합니다.

![AI CLI별 프롬프트 입력 구분](docs/images/workshop-ai-input.png)

[실습 안내](workshop/README.md) | [진행자 준비](workshop/reference/facilitator.md) | [다운로드 안내](workshop/reference/offline-start.md)

## 환경 설정

| 설정 | 용도 |
|---|---|
| `CATALOG_LOCAL_PATH` 또는 `CATALOG_BUCKET` | 로컬 SQLite 또는 소유 S3 카탈로그 |
| `DETAILS_BUCKET` | 공식 상세 스냅샷 |
| `PUBLIC_ORIGIN` | 브라우저에서 사용하는 실제 앱 origin |
| `ROUTING_URL` | 같은 태스크 또는 로컬 환경의 Valhalla |
| `ROUTING_DATA_UPDATED_AT` | 실제 경로 데이터의 기준 시각 |
| `KAKAO_REST_API_KEY` | 서버 전용 카카오 조회 키. 운영에서는 SSM 주입 |
| `GuideLimitsEnabled` | 운영 템플릿의 AI 한도 사용 여부 |

모든 운영 설정은 [배포 절차](docs/runbooks/deploy.md)와 [.env.example](.env.example)을 함께 확인합니다.
운영 스크립트는 소유 계정과 서울 리전에 고정되어 있습니다.
다른 계정에는 원본 운영 배포기를 바로 실행하지 말고 워크숍의 참가자별 절차를 사용합니다.

## 데이터 범위

- Git의 137개 장소 파일은 실습용 시드입니다. 기본 좌표, 주소와 소개의 정확성을 공식 검증한 자료가 아닙니다.
- 운영의 6,724건은 별도 카탈로그 스냅샷입니다. 카카오 전체 장소 수와 같지 않습니다.
- 공식 보강은 해당 항목의 근거입니다. 일부 필드의 매칭을 장소 전체 검증으로 해석하지 않습니다.
- 실시간 교통, 카카오 평점과 리뷰 전체를 제공한다고 가정하지 않습니다.
- 새 지도 타일, 장소 조회, 날씨와 AI 답변은 온라인 기능입니다.

[데이터 품질](docs/data-quality.md) | [공식 상세와 올레길](docs/official-details-olle.md)

## 프로젝트 구조

```text
jeju-atlas/
├── src/                 # 지도와 사용자 화면
├── server/              # Node.js API
├── shared/              # 클라이언트/서버 계약
├── public/              # 정적 자산, 글꼴과 출처
├── agent/guide/         # Strands Guide
├── agent/tools/         # MCP Tools
├── routing/             # Valhalla 실행과 검증
├── infra/               # CloudFormation
├── scripts/             # 빌드, 배포와 운영 검사
├── tests/               # 앱과 인프라 회귀 검사
├── workshop/            # 120분 교재와 심화 자료
├── docs/                # 아키텍처, API와 운영 절차
├── AGENTS.md            # 저장소 작업 지침
├── CHANGELOG.md
├── CONTRIBUTING.md
└── SECURITY.md
```

## 검사

```bash
npm run check
npm run workshop:check
# Playwright와 Chromium을 준비한 환경에서 추가 실행
WORKSHOP_BROWSER_TEST=1 npm run workshop:check
```

전체 검사에는 boto3, requests와 cfn-lint도 필요합니다.
실제 배포, 모델 호출과 공개 서비스 검사는 별도이며 로컬 통과로 대신하지 않습니다.
[기여 안내](CONTRIBUTING.md)에 검사 범위와 변경 기록 작성 방법이 있습니다.

## 문서와 문의

[문서 목록](docs/README.md) | [구현 참조](docs/reference/INDEX.md) | [API](docs/api-reference.md) | [배포](docs/runbooks/deploy.md) | [복구](docs/runbooks/rollback.md) | [보안](SECURITY.md)

- 유지관리: [@whchoi98](https://github.com/whchoi98)
- 일반 문의와 버그: [GitHub Issues](https://github.com/whchoi98/jeju-atlas/issues)
- 민감한 정보가 포함된 보고: [보안 보고 안내](SECURITY.md)

루트 코드 라이선스 파일은 아직 선언되어 있지 않습니다.
데이터, 사진, 지도, 폰트와 이모지는 각각의 출처와 이용 조건을 확인해야 합니다.
[폰트](public/fonts/README.md), [이모지](public/emoji/README.md), [Agent 출처](agent/source-provenance.json)를 참고하세요.
