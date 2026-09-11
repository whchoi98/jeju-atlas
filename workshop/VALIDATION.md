# 워크숍 제작 검증

검증일: 2026-09-11. 이 기록은 로컬 제작·검사 결과입니다.
추가 AWS 스택 배포, 실제 모델 호출, provider key 등록, 클라우드 삭제는 수행하지 않았습니다.
챕터의 클라우드 명령은 참가자가 자신의 계정에서 실행하고 결과를 기록하는 절차입니다.

## 구성과 콘텐츠

- Markdown 14개 챕터와 Codex 프롬프트 카드 14개.
- 개요·챕터·참고 문서의 정적 HTML 21페이지와 다운로드 가능한 프롬프트 카드.
- 기존 인프라 자원 선언 94개·유형 41개에 대한 챕터와 검증 매핑.
- NanumSquare와 라이선스 포함, 외부 Markdown 요청 없이 파일/HTTP로 읽는 HTML.
- 검색·코드 복사·학습 진도·테마·키보드·모바일·인쇄 동작.

## 실행한 검사

```bash
PATH=/tmp/jeju-node24/bin:$PATH WORKSHOP_BROWSER_TEST=1 npm run workshop:check
PATH=/tmp/jeju-node24/bin:$PATH npm run check
```

작업 호스트의 Node 24.21.0을 사용했습니다.
워크숍 검사는 Python 경계·카탈로그·실행 제어, CLI 준비기,
HTML 생성·내비게이션·브라우저 및 자원/명령 매핑을 확인합니다.
초기 구성은 Python 36개·CLI 준비기 9개·사이트 18개, 총 63개를 통과했습니다.
EC2·오프라인·세 AI CLI 보강 후에는 Python 48개·CLI 준비기 9개·사이트 20개,
총 77개를 통과했으며 건너뛴 검사는 없습니다.
실제 HTML을 데스크톱·모바일, file/HTTP에서 확인했고 브라우저 오류나 외부 리소스 요청이 없었습니다.

참가자용으로 변환한 별도 앱에서도 `npm ci`와 `npm run check`를 수행했습니다.
Node 299개 통과·1개 선택 검사 생략, Python 190개 통과·2개 선택 검사 생략,
CloudFormation 검사·npm audit·production build를 통과했습니다.
원본 앱에도 같은 기존 검사를 실행하여 기능 회귀가 없음을 확인했습니다.

## AgentCore CLI

`@aws/agentcore` 0.28.1의 실제 create/validate/package/dev와 HTTP 호출을 확인했습니다.
최종 준비기를 통해 만든 `AtlasCliVerify03`도 CLI validate, Node 의존성 설치,
CDK synth와 소유 자원 guard를 통과했습니다.
합성 결과의 Runtime·역할·정책은 실습 소유 범위이고 모델 호출 권한은 없습니다.

입문 모듈의 구체적인 도구 버전과 최초 검증은 `cli/VALIDATION.md`에 있습니다.
부모 통합 과정에서는 참가자 이름의 경계 검사와 준비기 회귀 검사를 추가로 보완했습니다.
CloudFormation 합성 성공은 실제 AWS 권한·배포·원격 호출 검증이 아닙니다.

## 실제 Atlas 코드 패키징

Guide/Tools의 공개 잠금 파일에서 ARM64/Python 3.14 의존성을 새로 설치했습니다.
각각 수천 개의 SDK 파일을 ZIP으로 묶고 기존 Atlas 소스를 실제로 overlay하여
약 49 MB / 26 MB의 Runtime ZIP을 생성했습니다.
ZIP 크기·경로·CRC·소스 digest와 console launcher의 재배치 가능성을 확인했습니다.
프로덕션 의존성 ZIP이나 원본 참조 프로젝트를 복사하지 않았습니다.

이 파일을 S3에 게시하거나 Runtime으로 배포한 것은 아닙니다.
`deps-publish`, `agent-publish`, `agent-plan/apply/status`의 실제 결과는 참가자 계정에서 확인해야 합니다.

## 데이터와 설치 순서

카탈로그 준비기는 샘플 137건의 출처를 유지하고 Node/Python 양쪽 reader와 검증했습니다.
실제 Overpass 요청으로 OSM 행을 추가하는 경로도 확인했으며 수량은 요청 시점에 따라 달라집니다.
공식 API 보강은 실제 키와 실행 결과가 필요하며 제작 중 임의의 운영 정보를 채우지 않았습니다.

초기 데이터 버킷은 Distribution 없이 비공개로 생성하도록 조정했습니다.
실제 Distribution 연결 조건, 빈 공식 snapshot 초기화, SSM 경로,
정확한 hostname/인증서 검증과 소유 계정 경계를 회귀 검사로 확인했습니다.

## 정리 검증

삭제 전에 내 Schedule을 끄고 내 collector family만 종료·대기하는 흐름을 모킹된 AWS 경계에서 검사했습니다.
다른 family의 작업은 중지하지 않으며, 재시도 때 이전 보존 자원 ID를 잃지 않습니다.
실제 AWS 삭제는 수행하지 않았습니다. 공유 네트워크·인증서·CDK bootstrap과
보존 S3/ECR/Memory/로그의 실물 상태는 수강 계정에서 확인해야 합니다.

## 검증 자료

실행 로그·JSON·패키지·스크린샷은 `workshop/.local/`에 보관합니다.
이 폴더는 Git과 정적 사이트에서 제외합니다.
원본 `agentcore-cli`와 기존 제주 운영 AWS 설정은 변경하지 않았습니다.
게시 대상 소스·생성 HTML에 Gitleaks 검사를 실행해 비밀값 탐지 0건을 확인했습니다.

## EC2·오프라인·AWS 색상·AI CLI 보강

사용자가 지정한 공식 GitHub와 AWS Runtime CLI 시작 가이드를 직접 대조했습니다.
실습 EC2의 IMDSv2 identity와 primary NIC VPC, STS 계정, 두 AZ subnet·NAT를
읽기 전용으로 조회하고 생성된 복사본의 `run network`까지 통과했습니다.
실행 EC2의 VPC가 기존 제주 배포 VPC와 다르므로 Name 태그 검색을 기본 경로로 사용하지 않습니다.
실제 식별자는 Git 제외 파일 `workshop/.local/ec2-current-verification.json`에 보관합니다.

Codex CLI 0.136.0, Kiro CLI 2.21.2, Claude Code 2.1.197의 설치 버전과 도움말을 확인했습니다.
새 로그인·모델 호출·전역 CLI 재설치는 수행하지 않았습니다.
`doctor --assistant`는 선택한 도구만 요구하고, 생성 작업 공간에는 공통 AGENTS,
Claude Code import, Kiro steering 지침이 포함됩니다.

제주 앱과 워크숍에 AWS 네이비·오렌지·액션 블루를 적용했습니다.
위성·지형 원본, 카테고리 의미 구분, 나눔스퀘어와 기능·레이아웃을 유지했습니다.
PWA 색상·아이콘, 주요 화면의 텍스트 대비와 데스크톱·모바일을 확인했습니다.
이번에는 소스와 교재를 변경했으며 운영 앱을 재배포하지 않았습니다.

PC용 ZIP은 생성 HTML·정적 자산·글꼴/라이선스·공통 프롬프트 카드만 허용합니다.
페이지 누락, symlink, `.env`·`.local`·예상 밖 파일을 거부하는 검사를 추가했습니다.
압축 해제한 `jeju-atlas-workshop/index.html`이 진입점이며 명령은 EC2에서 실행합니다.
