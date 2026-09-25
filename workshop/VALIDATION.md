# 120분 워크숍 검증 기록

## 2026-09-25, 06장 서울 호출 리전과 계획 재개 명령

06장의 최초 실행 명령에서 `model-region --caller-region ap-northeast-2`로
서울 호출 리전을 저장하도록 했습니다. 빌드와 게시 후 리전 누락으로 중단된
경우에는 `model-region`과 `agent-plan` 두 명령만 실행하는 재개 절을 추가했습니다.
별도 리전 입력 프롬프트를 제거하고 공통 프롬프트에도 같은 흐름을 반영했습니다.

워크숍 269개와 공개 교재 검사 2개를 통과했습니다.
6개 Bash 블록의 구문과 입력 프롬프트 부재를 확인했습니다.
AWS 없는 대체 실행기로 최초 실행 및 재개 순서, 서울 리전 전달,
실패 시 후속 명령 중단을 5가지 경우로 확인했습니다.
1366px/390px 브라우저에서 명령 6개와 세 도구용 프롬프트 복사,
재개 링크, 서울 리전 지정, 인쇄와 오프라인 이동을 확인했습니다.

교재는 27페이지이며 다운로드 ZIP은 56파일입니다.
이번 확인에서 참가자 Runtime 배포, IAM 변경이나 모델 호출은 수행하지 않았습니다.
전체 앱 회귀 검사는 문서 변경에서 반복하지 않았습니다.
증거는 `workshop/.local/publication-ch06-seoul-20260925T051357Z/`에 보관했습니다.

## 2026-09-25, 06장 배포 단계와 중단 후 재개

06장과 공통 프롬프트에서 계획 생성, 실제 적용, 스택 상태 조회,
로그 설정을 네 단계로 구분했습니다. 계획의 `CREATE_COMPLETE`와
스택의 `CREATE_COMPLETE`를 구분하고, `NOT_CREATED`, `REVIEW_IN_PROGRESS`,
계획 대기, 배포 진행 중과 실패 상태에 맞춰 재개하도록 안내합니다.

워크숍 269개 검사와 공개 교재 검사 2개를 통과했습니다.
6개 Bash 블록의 구문을 확인하고, AWS를 호출하지 않는 대체 실행기로
의존성 및 앱 빌드 블록의 정상 실행과 첫 실패 후 중단을 5가지 경우로 확인했습니다.
1366px/390px 브라우저에서 네 단계, 명령 6개와 세 도구용 프롬프트 복사,
재개 링크, 인쇄와 오프라인 이동을 확인했습니다.
27페이지 교재와 56파일 다운로드 ZIP을 생성했습니다.

심화 모델 호출 리전을 저장하는 기존 명령도 배포 전에 안내합니다.
이번 수정은 교재와 프롬프트이며 참가자 스택, 역할, 모델 호출은 실행하지 않았습니다.
전체 앱 회귀 검사는 이번 문서 변경에서 반복하지 않았습니다.
공개 사이트 반영 결과는 [배포 기록](DEPLOYMENT.md)에 남깁니다.
증거는 `workshop/.local/publication-ch06-flow-20260925T045000Z/`에 보관했습니다.

05:01 UTC에는 공개 사이트의 57개 파일과 진입 경로 2개가 검증 이미지와
일치하는지 확인했습니다. 공개 6장에서도 1366px/390px 명령 및 프롬프트 복사,
상태별 재개 링크, 인쇄와 오프라인 이동을 통과했습니다.

## 2026-09-25, AgentCore CLI 역할 학습 참고

04장 하단에 핵심 명령 표를 추가하고 참고 자료 메뉴 마지막에
`AgentCore CLI 역할과 실행 흐름`을 연결했습니다. 명령 6개와 주요 경로 5개,
코딩 어시스턴트, Runtime, CDK와 보조 스크립트의 역할을 설명합니다.

워크숍 269개 검사와 전체 저장소 검사를 통과했습니다.
PWA 검사는 고정 페이지 수 대신 과정에 선언된 전체 경로의 생성과 캐시 저장을 확인합니다.
1366px/390px 브라우저에서 04장 하단 연결, 참고 메뉴 마지막 항목, 내용과 인쇄,
오프라인 이동을 확인했습니다. 교재는 27페이지, 다운로드 ZIP은 56파일입니다.

새 학습 자료는 명령을 추가 실행하는 단계가 아닙니다.
이 확인에서 참가자 Runtime 배포나 모델 호출은 수행하지 않았습니다.
증거는 `workshop/.local/publication-cli-learning-20260925T041356Z/`에 보관했습니다.

## 2026-09-25, CDK 조회에서 실제 생성으로 이어지는 안내

사전 구성 5절을 조회, 서울 리전에서 실제 생성, 완료 확인으로 구분했습니다.
페이지 상단에 생성 단계 바로가기를 두고, `missing/ready: false` 출력 예시에서
5-2의 명령 블록 전체를 실행하도록 연결했습니다.

워크숍 269개 검사와 전체 저장소 검사를 통과했습니다.
1366px/390px 브라우저에서 생성 바로가기, 5-2 생성과 5-3 완료 안내,
bootstrap 명령 3개를 포함한 명령 20개 복사와 오프라인 이동을 확인했습니다.
실제 계정의 CDK 자원을 생성하거나 기존 bootstrap 동작을 변경한 작업은 아닙니다.
증거는 `workshop/.local/publication-bootstrap-guide-20260925T034202Z/`에 보관했습니다.

## 2026-09-25, 새 계정 CDK 준비와 단기·장기 API 키

CDKToolkit과 기본 버전 파라미터를 읽기 전용으로 확인하는 준비기를 추가했습니다.
현재 계정 일치, bootstrap 버전 30 이상과 준비 상태를 키 게시와 패키징 전에 확인합니다.
키 입력은 단기 또는 장기 Bedrock API 키와 모델 호출 리전 두 항목으로 통일했습니다.

| 확인 | 실제 결과 |
|---|---|
| bootstrap 회귀 검사 | 37개 통과. 계정 불일치, 부재, 구버전, 부분 상태, 생성 중 상태, 권한 거부, 시간 초과, 오류 비공개 처리 포함 |
| 키 입력 관련 검사 | bootstrap과 키 입력/게시/모델 설정의 선택 검사 66개 통과 |
| 워크숍 전체 검사 | Python 216개, CLI 준비기 9개, Node/브라우저 44개, 총 269개 통과 |
| 전체 저장소 검사 | Node 683개 통과/5개 생략, Python 203개 통과/2개 생략, CloudFormation lint, npm audit 취약점 0건, production build 통과 |
| 실제 터미널 | 합성 값으로 호출 리전과 숨김 API 키 두 항목만 입력, `.env` 0600과 기존 값 보존 |
| 실제 브라우저 | 1366px/390px, bootstrap 명령 3개를 포함해 명령 20개 복사, 장기키 안내와 페이지 연결, 오프라인 이동 확인 |
| CLI 근거 | 설치된 AgentCore 0.28.1의 최소 bootstrap 버전 30, CDK CLI 2.1126.0의 표준 템플릿 버전 32 확인 |

bootstrap 상태 검사는 가짜 AWS 클라이언트로 검증했습니다. 참가자가 보고한 다른 계정에
접근하거나 CDKToolkit을 생성한 결과가 아닙니다. 실제 API 키 인증과 모델 요청도 수행하지 않았습니다.
`deploy --dry-run --yes`가 bootstrap을 실행할 수 있는 분기를 확인해 읽기 전용 우회 명령으로 안내하지 않습니다.
증거는 `workshop/.local/publication-bootstrap-20260925T024207Z/`에 보관했습니다.

## 2026-09-25, 준비 흐름 연결과 키 입력 간소화

00장은 목표와 준비 상태별 이동, 사전 구성은 설치와 점검, 01장은 기존 환경 활성화와
키 입력을 담당하도록 정리했습니다. 준비를 마친 참가자는 01장으로 바로 이동합니다.
키 입력에서는 수동 만료 시각을 제거하고 발급 리전과 숨김 단기키만 받습니다.

| 확인 | 실제 결과 |
|---|---|
| 키 입력 회귀 검사 | Python 3.14.3과 3.9.25에서 각각 29개 통과 |
| 워크숍 검사 | Python 179개, CLI 준비기 9개, Node/브라우저 44개, 총 232개 통과 |
| 전체 저장소 검사 | Node 683개 통과/5개 생략, Python 203개 통과/2개 생략, CloudFormation lint, npm audit 취약점 0건, production build 통과 |
| 실제 터미널 | 합성 키로 리전과 키 두 항목만 입력, 키 화면 출력 없음, `.env` 권한 0600 |
| 이전 입력과 호환 | 기존 만료 시각 값은 보존하되 입력 조건, 상태 출력과 자식 프로세스 전달에서 제외 |
| 실제 브라우저 | 1366px/390px에서 00장 분기, 사전 구성에서 01장 직접 이동, 명령 17개 복사와 오프라인 이동 확인 |
| 교재 | 26페이지, ZIP 55파일, 공개 ZIP 861,799바이트 |

입력 확인은 편집 EC2의 가상 터미널과 합성 값으로 수행했습니다.
실제 키 유효성이나 모델 접근 성공을 확인한 결과는 아니며, 추가 모델 사전 호출은 도입하지 않았습니다.
검사와 화면 증거는 `workshop/.local/publication-flow-20260925T014625Z/`에 보관했습니다.

## 2026-09-25, 기존 실습 재개와 어시스턴트 전환

같은 `team01` 세션에 Codex가 저장된 상태에서 Claude Code로 준비하면
소유권 오류가 나는 상황을 재현했습니다. 같은 세션에서는 어시스턴트 선택만
변경하고, Node 전용 설치는 참가자 폴더와 독립적으로 실행하도록 수정했습니다.

| 확인 | 실제 결과 |
|---|---|
| 준비기 회귀 검사 | 54개 통과. 도구 전환, 저장된 프로젝트 재개, 파일 보존, 변경된 소유 정보 거부, 메타데이터 쓰기 실패 복구 포함 |
| 워크숍 전체 검사 | Python 173개, CLI 준비기 9개, Node/브라우저 44개, 총 226개 통과 |
| 전체 저장소 검사 | Node 683개 통과/5개 생략, Python 203개 통과/2개 생략, CloudFormation lint, npm audit 취약점 0건, production build 통과 |
| 이전 배포본과 호환 | 이전 준비기가 만든 Codex 세션에서 공식 Node 다운로드와 체크섬 확인 후 Claude 활성화 성공 |
| 실제 Node 설치 | uv 없는 PATH와 Node 20.20.1에서 Node 24.21.0/npm 11.19.0 준비 |
| 참가자 상태 보존 | Node 전용 단계는 기존 세션 파일 동일, 도구 전환은 프로젝트와 `.env` 내용 및 권한 유지 |
| 실제 브라우저 | 1366px/390px에서 명령 18개 복사, 사전 구성과 01장 사이의 도구 선택 유지, 오프라인 이동 확인 |
| 로컬 교재 | 26페이지, ZIP 55파일, 863,661바이트 |

이전 소스 호환 재현은 편집 EC2의 임시 폴더에서 수행했습니다.
참가자가 사용 중인 다른 EC2를 원격으로 수정하거나 참가자 Runtime을 배포한 결과는 아닙니다.
준비기와 브라우저 확인에서 AWS 제어 API와 실제 모델 호출은 실행하지 않았습니다.
공개 사이트 반영 결과는 [배포 기록](DEPLOYMENT.md)에 별도로 남깁니다.
검사와 재현 증거는 `workshop/.local/publication-resume-20260925T004650Z/`에 보관했습니다.

## Sonnet 4.6 실제 호출 상태

소스 검증은 워크숍 Python 86개, Warmup 9개, Node/브라우저 41개, 총 136개를 통과했습니다.
전체 저장소 검사는 Node 683개 통과/선택 5개 생략, Python 202개 통과/선택 2개 생략,
CloudFormation lint, npm audit(취약점 0건), production build를 통과했습니다.
이 수치에는 네트워크를 모킹한 모델 검사 테스트가 포함되며 실제 모델 접근 성공을 뜻하지 않습니다.

참가자가 실제 AWS CLI Converse 결과를 전달했습니다. 모델은
`global.anthropic.claude-sonnet-4-6`, 호출 리전은 `ap-northeast-2`이며
`bedrock:InvokeModel`에 대한 SCP 명시적 거부로 `AccessDeniedException`을 반환했습니다.
**이 실제 호출은 실패입니다.** 모델 응답을 받은 것으로 기록하지 않습니다.
정확한 정책 조건과 성공한 다른 호출 리전은 아직 확인되지 않았습니다.

참가자의 호스트·계정·ARN과 원본 기록은 공개 자료에서 제외했습니다.
편집 호스트에서 참가자 호출을 대신 수행하거나 다른 리전을 순회하지 않았습니다.
읽기 전용 doctor, 모킹된 테스트, Runtime 설정 완료는 이 실패를 해결한 증거가 아닙니다.

`model_check.py --execute`는 지정한 호출 리전에 최대 출력 16토큰의 고정 Converse 요청을
한 번만 보내고 성공 응답 또는 실패를 별도 `.local` 보고서에 기록합니다.
`model_config.py`는 Sonnet 모델과 명시적 호출 리전을 설정하지만 IAM/SCP는 바꾸지 않습니다.
배포 리전은 계속 서울이며 호출 리전은 주최자의 정책 및 실측 확인 후 지정합니다.
Claude Code 예시는 `claude --model claude-sonnet-4-6`으로 고정하고 이 Codex 세션의 모델은 유지했습니다.

기존 서비스의 정적 교재 게시 후보도 별도로 검사했습니다.
현재 운영 이미지에서 변경된 경로 58개는 모두 `/app/dist/workshop/` 아래였고,
비워크숍 파일의 내용/권한/소유자/링크 및 이미지 실행 설정은 동일했습니다.
게시 도구는 기존 TaskDefinition/Service의 Modify와 ImageUri 변경만 허용합니다.
이 절의 후보 검증은 실제 게시 완료 기록과 구분합니다.

## 2026-09-15 CloudFront 기본 도메인 추가 보완

참가자의 추가 요구에 따라 심화 앱과 교재 접속은 실제 App 스택 출력의 기본
`*.cloudfront.net` HTTPS 주소만 사용합니다. ACM 발급, 사용자 도메인/DNS/Route 53 등록,
origin Host 함수와 TLS probe 단계 및 해당 정리 대상은 제외했습니다.
브라우저에서 CloudFront까지는 기본 인증서의 HTTPS, CloudFront에서 ALB까지는
기존 검증 헤더와 Prefix List로 제한된 HTTP입니다. 운영 도메인의 원본 템플릿,
설정, 배포기와 앱 소스는 변경하지 않았습니다.

| 확인 | 실제 결과 |
|---|---|
| 워크숍 검사 | Python 74개, Warmup 9개, Node/브라우저 41개, 총 124개 통과. 생략 없음 |
| CloudFront 회귀 검사 | 9개 포함. 소유 스택 URL, 잘못된/빈 출력, 기본 인증서, 사용자 도메인 거부, 삭제 제외와 검증 인자 확인 |
| 참가자 앱 사본 | Node 683개 통과/선택 5개 생략, Python 197개 통과/선택 2개 생략 |
| 참가자 사본 후속 검사 | CloudFormation lint, npm audit(취약점 0건), 앱 및 공개 교재 빌드 통과 |
| 실제 09장 화면 | 1366px/390px에서 본문 넘침과 브라우저 오류 없음, Claude 선택 정상, 외부 HTTP 요청 0건 |
| 셸 구문 | 활성 장/참고 문서의 Bash 71개 블록 통과 |
| 배포 전제 제거 | 활성 장/프롬프트/참고 문서에 도메인 설정과 인증서/probe 실행 명령 없음 |
| 추가 패치 | 기존 환경 패치 위에 적용하여 변경 파일 62개 해시 일치 확인 |
| 기존 참가자 상태 | 추가 패치 후 activate.sh, CLI 설정과 별도 참가자 메모 보존. 기존 활성화 파일 재실행 성공 |
| 교재 빌드/패키징 | workshop:check/build/package 종료 0. ZIP 21페이지, 49파일, 737,943바이트 |

생성된 참가자 검증기에서 고정 운영 NAT ID와 사용자 도메인 검사, 빈 `https://` 별칭을
제거하고 실제 참가자 구성으로 검사하도록 했습니다. 고도 검사에는 실제 스택 URL,
자산 검사에는 참가자의 불변 이미지 URI를 전달합니다. 공개 미디어 주소는 App 스택이
생기기 전에는 비어 있고, 이후 실제 CloudFront 출력으로 설정합니다.

참가자 전체 검사에서 처음 발견한 Runtime 준비 오류와 도메인 오류의 보고 순서를
조정한 뒤 전체 검사를 다시 통과했습니다. 운영 원본과 기존 테스트의 단언은 완화하지 않았습니다.
Vite의 기존 큰 청크 안내와 선택 검사 생략은 실제 AWS 실행 결과가 아닙니다.

실행과 결과는 `workshop/.local/cloudfront-participant-validation.json`,
해당 사본의 `.local/checks.json`, `cloudfront-reader-review/results.json`,
`cloudfront-handoff-verification.json`에 기록했습니다.

| 전달 파일 | SHA-256 |
|---|---|
| jeju-atlas-cloudfront-default.patch | b2e82fad6ffb505f16b88f2f9d32cf8b08b8bb38f1d8afe75c19ff5980f40c4e |
| jeju-atlas-workshop-handbook.zip | 0569cb32e94a52324aed915bf9bc73d8dfd9dfe5cf737c4b120de564936733c8 |

추가 패치는 아래 환경 패치가 적용된 소스에 사용합니다. 사용자 확인 경로는
`/home/ec2-user/my-project/jeju-atlas`이며 전용 도구는 그 아래
`workshop/.local/toolchain/`에 유지합니다. 두 패치 모두 실행 소스를 위한 것이고
교재 ZIP은 읽기용입니다.

실제 AWS 자원 생성/변경, 운영 배포, 모델 호출과 Git push는 수행하지 않았습니다.
실제 참가자 Distribution은 아직 조회한 것으로 기록하지 않습니다.
배포 후 `lab.py url --config "$ATLAS_CONFIG"`가 계정/스택/Project 태그와 실제
CloudFormation 출력을 확인하여 주소를 반환합니다.

## 2026-09-15 본 실습 준비 보완

이 절은 원본 호스트의 로컬 수정과 검증 기록입니다. 운영 교재 배포와 Git push,
AWS 자원 생성/변경, 모델 호출은 수행하지 않았습니다.

참가자가 전달한 두 번째 EC2는 Amazon Linux 2023 ARM64,
`/home/ec2-user/claude-lab`에서 Claude Code 2.1.272의 대화와 Bash 도구가
동작하는 환경입니다. 그러나 저장소와 ATLAS_REPO, AgentCore CLI, Python 3.14,
boto3가 없고 Node가 20.20 계열이어서 기존 01장에서 중단됐습니다.
이 실측과 원본 호스트의 검증을 같은 실행 결과로 취급하지 않습니다.

| 검사 | 실제 결과 |
|---|---|
| 신규 core 성공/실패 경로 | 15개 통과. 소스/helper 누락, 잘못된 버전, 선택한 CLI만 요구, 경로와 소유권, 새 Bash 복원, CLI 설정, 체크섬, npm 실패 시 부분 설치 방지, 프로젝트 대상과 데이터 검사 |
| 전체 workshop Python | 65개 통과 |
| 기존 Warmup 준비기 | 9개 통과. JejuGuide 모델 호출과는 별개 |
| Node 리더/PWA/브라우저 | 41개 통과, 생략 0개 |
| 본문 Bash | 31개 블록과 설치 스크립트의 Bash 구문 검사 통과 |
| 전체 명령 | workshop:check, workshop:build, workshop:package 종료 0 |
| 전용 도구 설치 | 원본 ARM64와 새 임시 소스 경로에서 설치 성공. Node 24.21.0, Python 3.14.3, boto3 1.42.86, requests 2.32.5, npm AgentCore 0.28.1 |
| 설치 후 doctor | 두 전용 환경에서 passed=true, awsChecked=false, modelInvoked=false |
| 실제 npm CLI | 자격 증명/metadata를 비활성화한 임시 경로에서 Strands/Bedrock/CodeZip create와 합성 계정의 validate 성공 |
| 소스 전달 | 공개 GitHub를 인증 없이 새 clone하고 bead20a 기준 패치 적용. 변경 파일 53개의 SHA-256, source 검사와 prepare 실행 확인 |
| 교재 ZIP | 21페이지, 49파일, 735,770바이트. 실행 소스/도구 설치물은 포함하지 않음 |

원본 검증에서는 uv 0.10.9와 Claude Code 2.1.263의 버전 명령을 사용했습니다.
참가자의 uv 0.12.15와 Claude Code 2.1.272 환경에서의 수정본 실행 결과는
참가자가 설치 후 별도로 확인합니다. 시스템 실행 파일과 로그인 설정은 바꾸지 않았습니다.

실제 CLI가 생성하는 `codeLocation`은 `app/JejuGuide/`입니다.
배포 전 검사에서 끝의 `/`를 허용하도록 실제 출력으로 회귀 검사를 추가했습니다.
CLI create의 의존성 설치는 생략했고 Runtime 서버나 모델은 실행하지 않았습니다.

검사 명령은 원본의 검증용 참가자 `activate.sh`를 source한 Bash에서 실행했습니다.

```bash
WORKSHOP_BROWSER_TEST=1 PYTHONDONTWRITEBYTECODE=1 npm run workshop:check
npm run workshop:build
npm run workshop:package
```

처음 샌드박스 실행에서는 기존 Node 자식 출력 검사와 Chromium의
`setsockopt: Operation not permitted`가 실패했습니다. 테스트 코드는 완화하지 않았고
같은 검사를 승인된 호스트 실행 환경에서 다시 실행해 모두 통과했습니다.

전달 패치는 실행 소스, 수정 본문/프롬프트와 생성 리더를 포함합니다.
이 유지관리 검증 기록과 구현 계획, `.local` 상태, 도구 설치물은 패치에 넣지 않았습니다.
다음 파일은 원본의 `workshop/.local/downloads/`에 있습니다.

| 산출물 | SHA-256 |
|---|---|
| jeju-atlas-core-readiness.patch | a5f3c68e58b5022cb88fdb2c1cc01f8da3dae0764fca885c72caf27ef12e0afa |
| jeju-atlas-workshop-handbook.zip | ec3d50f2fd90f30d6b62378ae0864f8ccf876519a818ce3a6e8fa46829a0254a |

운영 URL은 여전히 별도 배포된 버전입니다. IAM, CDK bootstrap,
실제 Runtime 배포와 모델 응답은 이번 검사의 완료 범위가 아닙니다.

## 이전 교재 배포와 개편 기록

이후 운영 교재에 본문 폭과 터미널/AI 입력 화면 구분을 반영하고 공개 배포를 완료했습니다.
최신 상태와 실제 브라우저 검사는 [워크숍 배포 기록](DEPLOYMENT.md)에 있습니다.
아래 개편 단계의 기록과 참가자용 에이전트 리허설 여부는 구분해서 읽습니다.

2026-09-12 교재를 00~04장 본 실습 110분과 여유 시간 10분으로 개편했습니다.
VPC, NAT Gateway, Subnet, VSCode Server와 세 Agentic AI 코딩 어시스턴트가 준비된 환경을 기준으로 합니다.
본문, 프롬프트와 HTML 메뉴에서 엠대시와 가운데점을 제거했습니다.

## 이번에 확인한 범위

| 검사 | 결과 |
|---|---|
| 워크숍 Python | 50개 확인. Node 24 경로 때문에 생략된 1개는 지정 경로로 별도 통과 |
| 기존 Warmup 준비기 | 9개 통과. 기본 과정의 실제 모델 응답 검사와는 별개 |
| HTML 생성, 시간표, 링크, PWA 로직 | 37개 통과 |
| CLI 직접 실행 | 정상 교재 생성은 종료 0, 누락 문서는 종료 1과 해당 파일명 확인 |
| 기본 시간표 | 본 실습 110분, 여유 10분, 합계 120분 |
| AgentCore CLI | 0.28.1의 create/deploy 도움말, Strands/Bedrock/CodeZip 생성과 validate 성공 확인 |

Node의 자식 프로세스 출력 캡처에 EPERM이 발생해 기존 CLI 캡처 검사는 직접 실행으로 대조했습니다.
검사 코드를 완화하지 않았습니다. 별도 파일/HTTP 브라우저 검사는 이번 개편에서 실행하지 않았습니다.
실행 기록은 `workshop/.local/rewrite-120/`에 보관합니다.

새 Strands 프로젝트를 로컬에 생성했으며 의존성 설치, 모델 호출과 AWS 배포는 수행하지 않았습니다.
120분 시간표는 수업 설계입니다. 진행자는 실제 계정과 역할로 리허설한 시간을 별도로 기록해야 합니다.
본 실습, 심화 실습과 운영 서비스의 성공 기록을 서로 대신 사용하지 않습니다.
운영 웹이나 AWS 자원을 배포하지 않았고 원본 앱 코드는 변경하지 않았습니다.
커밋, 스테이징과 브랜치 변경도 하지 않았습니다.

아래는 이전 교재 제작 당시의 기록입니다. 이번 실습을 수행한 결과로 해석하지 않습니다.

# 2026-09-11 제작 당시 기록

검증일: 2026-09-11. 이 기록은 로컬 제작, 검사 결과입니다.
추가 AWS 스택 배포, 실제 모델 호출, provider key 등록, 클라우드 삭제는 수행하지 않았습니다.
챕터의 클라우드 명령은 참가자가 자신의 계정에서 실행하고 결과를 기록하는 절차입니다.

## 구성과 콘텐츠

- Markdown 14개 챕터와 Agentic AI 코딩 어시스턴트 프롬프트 카드 14개.
- 개요, 챕터, 참고 문서의 정적 HTML 21페이지와 다운로드 가능한 프롬프트 카드.
- 기존 인프라 자원 선언 94개, 유형 41개에 대한 챕터와 검증 매핑.
- NanumSquare와 라이선스 포함, 외부 Markdown 요청 없이 파일/HTTP로 읽는 HTML.
- 검색, 코드 복사, 학습 진도, 테마, 키보드, 모바일, 인쇄 동작.

## 실행한 검사

```bash
PATH=/tmp/jeju-node24/bin:$PATH WORKSHOP_BROWSER_TEST=1 npm run workshop:check
PATH=/tmp/jeju-node24/bin:$PATH npm run check
```

작업 호스트의 Node 24.21.0을 사용했습니다.
워크숍 검사는 Python 경계, 카탈로그, 실행 제어, CLI 준비기,
HTML 생성, 내비게이션, 브라우저 및 자원/명령 매핑을 확인합니다.
초기 구성은 Python 36개, CLI 준비기 9개, 사이트 18개, 총 63개를 통과했습니다.
EC2, 오프라인, 세 Agentic AI 코딩 어시스턴트 보강 후에는 Python 48개, CLI 준비기 9개, 사이트 20개,
총 77개를 통과했으며 건너뛴 검사는 없습니다.
실제 HTML을 데스크톱, 모바일, file/HTTP에서 확인했고 브라우저 오류나 외부 리소스 요청이 없었습니다.

참가자용으로 변환한 별도 앱에서도 `npm ci`와 `npm run check`를 수행했습니다.
Node 299개 통과, 1개 선택 검사 생략, Python 190개 통과, 2개 선택 검사 생략,
CloudFormation 검사, npm audit, production build를 통과했습니다.
원본 앱에도 같은 기존 검사를 실행하여 기능 회귀가 없음을 확인했습니다.

## AgentCore CLI

`@aws/agentcore` 0.28.1의 실제 create/validate/package/dev와 HTTP 호출을 확인했습니다.
최종 준비기를 통해 만든 `AtlasCliVerify03`도 CLI validate, Node 의존성 설치,
CDK synth와 소유 자원 guard를 통과했습니다.
합성 결과의 Runtime, 역할, 정책은 실습 소유 범위이고 모델 호출 권한은 없습니다.

입문 모듈의 구체적인 도구 버전과 최초 검증은 `cli/VALIDATION.md`에 있습니다.
기존 검증에서는 참가자 이름의 경계 검사와 준비기 회귀 검사를 추가로 보완했습니다.
CloudFormation 합성 성공은 실제 AWS 권한, 배포, 원격 호출 검증이 아닙니다.

## 실제 Atlas 코드 패키징

Guide/Tools의 공개 잠금 파일에서 ARM64/Python 3.14 의존성을 새로 설치했습니다.
각각 수천 개의 SDK 파일을 ZIP으로 묶고 기존 Atlas 소스를 실제로 overlay하여
약 49 MB / 26 MB의 Runtime ZIP을 생성했습니다.
ZIP 크기, 경로, CRC, 소스 digest와 console launcher의 재배치 가능성을 확인했습니다.
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

삭제 전에 내 Schedule을 끄고 내 collector family만 종료, 대기하는 흐름을 모킹된 AWS 경계에서 검사했습니다.
다른 family의 작업은 중지하지 않으며, 재시도 때 이전 보존 자원 ID를 잃지 않습니다.
실제 AWS 삭제는 수행하지 않았습니다. 공유 네트워크, 인증서, CDK bootstrap과
보존 S3/ECR/Memory/로그의 실물 상태는 수강 계정에서 확인해야 합니다.

## 검증 자료

실행 로그, JSON, 패키지, 스크린샷은 `workshop/.local/`에 보관합니다.
이 폴더는 Git과 정적 사이트에서 제외합니다.
원본 `agentcore-cli`와 기존 제주 운영 AWS 설정은 변경하지 않았습니다.
게시 대상 소스, 생성 HTML에 Gitleaks 검사를 실행해 비밀값 탐지 0건을 확인했습니다.

## EC2, 오프라인, AWS 색상, Agentic AI 코딩 어시스턴트 보강

사용자가 지정한 공식 GitHub와 AWS Runtime CLI 시작 가이드를 직접 대조했습니다.
실습 EC2의 IMDSv2 identity와 primary NIC VPC, STS 계정, 두 AZ subnet, NAT를
읽기 전용으로 조회하고 생성된 복사본의 `run network`까지 통과했습니다.
실행 EC2의 VPC가 기존 제주 배포 VPC와 다르므로 Name 태그 검색을 기본 경로로 사용하지 않습니다.
실제 식별자는 Git 제외 파일 `workshop/.local/ec2-current-verification.json`에 보관합니다.

Codex CLI 0.136.0, Kiro CLI 2.21.2, Claude Code 2.1.197의 설치 버전과 도움말을 확인했습니다.
새 로그인, 모델 호출, 전역 CLI 재설치는 수행하지 않았습니다.
`doctor --assistant`는 선택한 도구만 요구하고, 생성 작업 공간에는 공통 AGENTS,
Claude Code import, Kiro steering 지침이 포함됩니다.

제주 앱과 워크숍에 AWS 네이비, 오렌지, 액션 블루를 적용했습니다.
위성, 지형 원본, 카테고리 의미 구분, 나눔스퀘어와 기능, 레이아웃을 유지했습니다.
PWA 색상, 아이콘, 주요 화면의 텍스트 대비와 데스크톱, 모바일을 확인했습니다.
이번에는 소스와 교재를 변경했으며 운영 앱을 재배포하지 않았습니다.

PC용 ZIP은 생성 HTML, 정적 자산, 글꼴/라이선스, 공통 프롬프트 카드만 허용합니다.
페이지 누락, symlink, `.env`, `.local`, 예상 밖 파일을 거부하는 검사를 추가했습니다.
압축 해제한 `jeju-atlas-workshop/index.html`이 진입점이며 명령은 EC2에서 실행합니다.
