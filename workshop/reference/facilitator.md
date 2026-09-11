# 진행자 준비·운영 가이드

이 워크숍은 별도의 AgentCore CLI 입문 Runtime과 실제 Jeju Atlas 전체 구성을 다룬다. 전체 구성의 기준은 `workshop/IMPLEMENTATION_PLAN.md`, 리소스별 증거는 `workshop/reference/resources.md`다. **FULL 과정은 사전 준비와 이틀의 실습 시간을 확보하고, AWS 전파·인증서·데이터 빌드 대기를 별도로 관리한다.** 120분 안에 새 계정의 전체 배포·검증·정리를 끝내는 일정으로 안내하지 않는다.

진행자는 팀별로 `준비됨 / 진행 중 / 미검증 / 차단됨 / 정리 대기`를 기록한다. 로컬 빌드 통과, CloudFormation 완료, 실제 서비스 검증은 각각 다른 체크포인트다. 기존 `docs/`의 성공 건수·운영 ARN·과거 가격·비공개 `.local/...` 보고서를 참가자 결과로 복사하지 않는다.

## 행사 전 팀·계정·네트워크 준비

한 팀에는 하나의 참가자 식별자, 예상 AWS 계정, 사용할 프로필 또는 역할, 자원 이름 공간, 담당자를 배정한다. 같은 계정을 쓰는 팀은 VPC뿐 아니라 서비스 한도와 비용도 공유한다. 팀 이름이 다르다는 이유만으로 계정 수준 격리가 확보됐다고 설명하지 않는다.

| 준비 항목 | 진행자가 확보할 내용 | 시작 조건 |
| --- | --- | --- |
| 팀 실행 경계 | 예상 계정 ID, 선택 프로필/역할, 팀 식별자, 실습 이름, 담당자·정리 기한 | 실제 caller 계정과 구성의 계정 일치. 프로필 이름만으로 판정하지 않음 |
| 이름과 소유권 | ECR·S3·ECS·ALB·IAM·DynamoDB·Runtime·Gateway·Memory·SSM·로그·캐시 정책·WAF·SNS·DNS 이름 | 두 팀의 렌더링 결과를 비교해 충돌 없음. 계정·리전·팀 태그와 실제 ARN/ID 장부 준비 |
| 기존 네트워크 | 서울의 기존 VPC, Public Subnet 두 AZ, Private Subnet 두 AZ, 라우트 테이블·IGW·NAT ID | Public 기본 경로는 IGW, Private 기본 경로는 정상 NAT. Private public-IP 자동 할당 비활성 |
| 실제 네트워크 사용 가능성 | 서브넷 가용 주소, NAT 상태·출구 접근, DNS, 필요 endpoint 정책, prefix list | ECR·S3·로그·외부 제공처 접근이 가능한 환경. endpoint만 있다는 이유로 NAT 전제 생략 금지 |
| CloudFront ALB 접근 | 서울의 AWS 관리 `com.amazonaws.global.cloudfront.origin-facing` prefix list | 소유자·이름·리전과 SG quota 확인. 원본처럼 HTTP/TLS SG를 분리할 여유 확보 |
| 배포 권한 | CloudFormation 변경 세트, 범위가 제한된 IAM 생성/PassRole, 해당 서비스 제어·아티팩트 게시·관측 권한 | 조직 SCP·permission boundary까지 확인. 권한 실패를 공유 기반 수정으로 해결하지 않음 |
| 로컬 실행 환경 | Node 24 계열 24.18.1 이상, Python·uv, AWS CLI, Docker ARM64 빌드 환경, cfn-lint, WebGL 브라우저 | 잠금 파일 설치, 기본 컨테이너 실행, 디스크 여유·다운로드 경로·브라우저 그래픽 확인 |
| 수업 도구 | Codex 작업 환경, 04장에서 검증한 AgentCore CLI 버전·스키마 | 계획의 `@aws/agentcore` 0.28.1과 설치본 대조. 인증 상태를 배포 모델 접근 허가로 해석하지 않음 |

기존 `scripts/deploy.py`는 계정·VPC·서브넷·도메인·이름이 운영 환경에 고정되어 있다. 여러 YAML의 `AllowedPattern`/`AllowedValues`, 수집기의 계정 검사, IAM ARN과 로그 prefix에도 같은 경계가 있다. **원본 저장소에서 운영 배포기를 그대로 실행하는 방식은 참가자 설치 절차가 아니다.**

실행은 부모 작업이 구현하는 `workshop/scripts/lab.py`의 검증된 격리 사본과 각 장의 확정 명령을 따른다. 이 가이드는 아직 확인하지 않은 helper 옵션을 정의하지 않는다. 격리 준비가 공유 VPC/NAT를 생성·교체하거나 기존 인증서를 변경해야 한다면 필수 환경이 없는 상태로 처리하고 해당 팀의 클라우드 단계를 보류한다.

리전 배치는 다음처럼 확인한다.

| 위치 | 소스 기준 배치 |
| --- | --- |
| `ap-northeast-2` | ECR·데이터/자산 S3·ALB·Private ECS·Secrets Manager·SSM·DynamoDB·AgentCore·Scheduler·운영 알람·origin ACM |
| `us-east-1` | viewer ACM, CLOUDFRONT 범위 WAF, Lambda@Edge 게시 함수/버전, CloudFront 표준 로그 V2와 엣지 지표·알람 |
| 전역 서비스와 스택 위치 구분 | CloudFront는 전역 서비스지만 원본 앱·TLS 프로브의 선언은 서울 CloudFormation 스택에 포함된다. `scripts/deploy.py: stack_client`는 `edge`, `origin-routing` 스택만 us-east-1로 보낸다 |
| 추가 실행 리전 | 원본 origin 배포기가 준비하는 지역별 Lambda@Edge 로그 그룹. 두 주 리전의 스택 목록만으로 정리 대상을 찾지 않는다 |

## FULL HTTPS와 모델·제공처 접근

FULL HTTPS에는 팀이 사용할 수 있는 사용자 도메인과 인증서가 필요하다. 실제 공개 DNS를 관리하는 주체를 행사 전에 확인한다. 같은 이름의 Route 53 hosted zone이 계정에 있다는 사실만으로 그 zone이 공개 위임되었다고 판단하지 않는다. 이 실습 자산은 DNS zone/record를 생성하지 않는다.

viewer hostname은 CloudFront에 연결하고, 그 이름을 포함하는 **us-east-1 ACM 인증서**가 `ISSUED`여야 한다. ALB에는 **ap-northeast-2 인증서**가 필요하다. 기존 제공 인증서의 ARN·소유자·사용 허가를 장부에 남기고, 별도 발급하는 경우에만 실습 소유·보존 자원으로 기록한다. DNS 검증과 인증서 발급은 수업 시작 전에 끝내는 편성으로 준비한다.

FULL의 canonical-host 경로는 `infra/origin-routing.yaml`의 게시된 Lambda@Edge 버전으로 검증한다. CloudFront는 ALB DNS에 HTTPS로 연결하고 함수는 Host를 인증서 이름으로 고정한다. 별도 origin CNAME 없이도 이 모드를 사용할 수 있지만 사용자 도메인과 두 리전 인증서 요구가 사라지는 것은 아니다. `dns` 모드를 선택하면 인증서가 포함하는 별도 origin hostname이 ALB로 직접 연결되어야 한다.

TLS listener 준비, 독립 TLS 프로브 검증, 실제 앱의 `OriginTlsEnabled` 전환을 분리한다. 소스의 조건이 참이거나 변경 세트가 실행됐다는 이유만으로 TLS 검증 완료를 표시하지 않는다. 인증서/도메인이 없는 팀은 기본 CloudFront URL 단계를 진행할 수 있으나 사용자 도메인·canonical Host FULL parity는 미검증으로 남긴다.

Atlas 모델은 `infra/agentcore.yaml`, `agent/guide/model/load.py`, `agent/guide/atlas_agent/routing.py`의 Global CRIS 설정을 유지한다.

- 일반 질문: `global.openai.gpt-5.6-sol`
- 일정·코스 계획: `global.openai.gpt-6-astra`
- 서울 endpoint, `auto` 규칙 분류, 해당 inference-profile/foundation-model ARN 권한

이 문자열은 저장소의 설정이지 모든 참가자 계정에서 사용 가능하다는 보장이 아니다. 진행자는 제공 모델 접근·조직 정책·Global CRIS 허용 범위·호출 quota를 확인하고, 승인한 소수의 실제 호출로 별도 리허설한다. 서울 endpoint 설정을 모든 모델 처리가 서울에 한정된다는 약정으로 설명하지 않는다. 접근이 없으면 원인을 기록하며 모델을 임의 교체하고 같은 과정이 검증됐다고 표시하지 않는다. Codex 인증은 이 Bedrock 실행 설정과 별개다.

| 데이터·자산 | 접근·이용조건 준비 | 교재에서 보존할 근거 |
| --- | --- | --- |
| TourAPI / VisitJeju | 행사 용도의 API 접근·허용량 확인. 팀 전용 SSM SecureString으로 입력 | 제공처 ID·언어·조회 시각·원문 URL·매칭 방법. API 성공은 모든 필드의 독립 검토가 아님 |
| 사진 | 사진별 선언된 license·credit·원본 URL 확인. 코드의 허용 필터 유지 | TourAPI의 Type1/Type3 처리, KOGL-3 원본 유지·썸네일 미생성. VisitJeju API 키만으로 사진 게시 허용을 추정하지 않음 |
| 샘플·OSM/Geofabrik | `agent/tools/data/jeju_pois.json`, OSM 출처·ODbL 고지, 제한된 import 범위 | 시드는 `sample`, OSM은 원본 ID/출처 유지. 다운로드 시각과 데이터 기준 시각 분리 |
| Terrarium / Skadi HGT | `src/map.ts`, `scripts/build-routing-data.py`에 기록한 공개 원본·attribution 확인 | DEM 제공처·원본 수정일·hash. 최신 현장 측량이나 현재 건물 표고라는 주장 없음 |
| Esri World Imagery | 외부 타일 서비스의 수업 규모·공개 배포·표시·캐시 이용조건 확인 | `src/map.ts`의 출처 표시 유지. 무제한/오프라인 재배포 허가를 추정하지 않음 |
| Open-Meteo | 코드에서 사용하는 endpoint의 행사 용도·호출량 조건 확인 | 웹과 Tools의 source/time/fallback 표시. 키 없는 구현이 모든 용도에서 무료라는 뜻은 아님 |
| NanumSquare / Twemoji | 저장소의 WOFF/SVG와 각 license 파일 유지 | `public/fonts/OFL-NanumSquare.txt`, `public/emoji/LICENSE-GRAPHICS.txt`, 화면 attribution |
| 가져온 소스·의존성 | `agent/source-provenance.json`, 잠금 파일, 배포할 패키지의 이용조건 확인 | 초기 복사 커밋과 변경 소유권. 출처 hash를 별도의 재배포 허가로 해석하지 않음 |

제공처 키를 코드·JSON 설정·HTML·명령 인자·슬라이드에 넣지 않는다. 입력은 값이 출력되지 않는 팀 범위 secret/parameter 경로로 처리한다. 원본 수집 경로는 `/jeju-atlas/tourapi-service-key`, `/jeju-atlas/visitjeju-api-key`이므로 팀 사본의 코드와 IAM 경로가 함께 바뀌어야 한다. metadata·경로·권한만 보고하고 키 자체를 검증 자료에 담지 않는다.

Kakao·KMA·JejuHub adapter, NAVER/ITS/EV 키 이름은 소스에 있으나 현재 Atlas 템플릿이 모든 제공처를 연결하는 것은 아니다. FULL 범위를 맞춘다는 이유로 Guide/Tools에 제공처 키나 추가 SSM grant를 배포하지 않는다. `layer`·`festivals`의 선택 snapshot이 없다면 정상적인 `no_data`/stale 경로를 설명한다.

## 새 빌드와 선택 제공 아티팩트

기본 경로는 새 clone과 커밋된 잠금·샘플·소스로 시작한다. 진행자가 검증한 아티팩트를 제공하면 긴 빌드 대기를 줄일 수 있지만, 학생이 새로 빌드한 것으로 기록하지 않는다. 어느 경로든 생산 환경의 `.local`, 배포 출력, Memory, 자격 증명 또는 `.env`를 복사하지 않는다. `agentcore-cli` 저장소나 worktree도 수정하지 않는다.

| 대상 | 새 설치 경로 | 선택 제공 시 검증 |
| --- | --- | --- |
| 웹 의존성·이미지 | `package-lock.json`으로 설치, 현재 `Dockerfile`로 ARM64 빌드 | 소스 revision·이미지 digest·Inspector/ECR 검사 결과. 현재/이전 릴리스 자산 manifest |
| Guide/Tools 의존성 | 각각의 `pyproject.toml`·`uv.lock`에서 준비한 Runtime 호환 의존성과 자체 소스 결합 | Python 3.14/대상 플랫폼, lock·ZIP SHA-256, 파일 안전성, 팀 버킷 key·VersionId |
| 장소 카탈로그 | 137개 sample 시드에서 생성. 선택적으로 범위를 제한한 OSM 추가 | schema·건수·ID·좌표·출처·시각·hash. 6,724건의 과거 운영 DB를 필수 입력으로 요구하지 않음 |
| 도로 그래프·고도 | `scripts/build-routing-data.py`의 공개 PBF/HGT fetch·제주 그래프 build·검증 | 동일 Valhalla 3.8.3/base digest, `source.json`, graph/admin/HGT hash. 선택 timezone DB도 검증 |
| 올레길·글꼴·UI 자산 | 커밋된 `public/data/`, `public/fonts/`, `public/emoji/` 사용 | 출처·라이선스·파일 identity 유지. 일부/비활성 코스를 임의 완성하지 않음 |
| 공식 상세·허용 사진 | 승인한 제공처 접근으로 제한 수집, 독립 snapshot/media 게시 | 제공처·언어·조회일·매칭·사진 권리·hash·보존 정책. 제공자의 자료 공유 권한도 확인 |
| 선택 layer/festival snapshot | 소스 계약에 맞는 자료가 있을 때만 별도 준비 | 현재 저장소의 상세 수집기가 이 feed를 만든다고 가정하지 않음. 미제공/오래된 상태 명시 |

`agent/dependency-artifacts.json`은 운영 계정의 사설 S3 객체 버전을 가리킨다. 원본 `scripts/deploy-atlas-agent.py build`는 그 객체를 읽을 수 있으며 시작부터 AWS 계정을 확인한다. 따라서 이 명령을 오프라인 의존성 생성기로 안내하지 않는다. `bootstrap-dependencies`도 기존 아카이브의 일회성 import 기능이지 잠금 파일을 새로 설치하는 기능이 아니다. 새 참가자 경로의 의존성 생성·게시·manifest 연결은 격리 helper 구현을 확인한다.

라우팅은 manifest 검증 외에 `routing/runtime.py`의 실제 이미지 입력 검사를 거친다. 데이터 빌더의 검증에서는 `admin.sqlite`가 선택 파일 목록에 있지만 실행 이미지는 이를 필수로 요구한다. `build-routing-data.py verify`만 통과한 자료를 완성된 런타임 이미지로 간주하지 않는다.

초기 공식 상세 객체도 준비해야 한다. 수집 역할은 `GetObject`만 허용되므로 빈 버킷의 없는 `place-details/latest.json`이 404 대신 접근 거절로 보일 수 있다. 팀 배포 주체가 올바른 초기 상태를 준비하고, 빈 snapshot은 “아직 공식 상세 없음”으로 표시한다. 실제 수집이 생성한 기록·실패 수를 확인하기 전에는 공식 상세 완료로 승격하지 않는다.

## 첫 설치와 배포기 사용 경계

원본 배포기에는 첫 설치 순환 의존성이 있다. `plan-data`는 앱 출력의 `DistributionArn`을 요구한다. 한편 `plan-app`은 전용 AgentCore 출력과 소유 카탈로그를 요구하며, AgentCore 코드 게시에는 데이터 버킷이 먼저 필요하다. **기존 운영 출력을 가져와 이 순환을 숨기지 않는다.** 격리 helper의 저장소 부트스트랩·정책 후속 연결이 이 순서를 해결하는지 새 이름 공간에서 리허설해야 한다.

진행 순서의 확인 기준은 다음과 같다. 각 단계의 실제 명령은 구현된 helper와 해당 장을 따른다.

1. 계정·이름·공유 네트워크를 확인하고 격리 사본을 준비한다. 원본 경계·도메인·IAM 문자열이 팀 값으로 올바르게 반영됐는지 검토한다.
2. 팀 데이터 저장소·ECR과 sample 카탈로그·의존성을 준비한다. CLI 입문 프로젝트와 공개 도로 자료 다운로드는 독립 작업으로 진행할 수 있다.
3. 팀 코드로 Atlas Guide·Tools·Gateway·Memory를 만들고 실제 출력·READY·전략 상태를 확인한다. 입문 Runtime 출력을 Atlas Guide 출력 대신 사용하지 않는다.
4. 라우터를 먼저 빌드·게시하고 웹 이미지와 digest 쌍을 만든다. 앱을 배포하고 Private task·ALB·CloudFront를 확인한다.
5. 앱 distribution ARN으로 static/data policy와 OAC·WAF·로그 전달을 연결한다. 자산은 이미지 manifest까지 준비한 뒤 behavior를 활성화한다. origin 인증서·함수·프로브 검증 후 FULL TLS로 전환한다.
6. 제한된 첫 수집을 확인하고 operations topic·data 알람 액션을 연결한다. 일정 활성화는 독립 단계로 관리한다. 실제 기능·관측 검증 후 역순 정리를 시작한다.

`scripts/deploy.py`의 `main()`에 선언된 인터페이스는 **위치 인자 `action` 하나**다. 다음은 원본 API의 참고표이며, 운영 원본에서 실행하라는 명령 모음이 아니다. `--profile`, `--region`, `--stack`, `--dry-run` 같은 옵션을 임의로 덧붙이지 않는다.

| 확인된 action | 원본 동작과 대기 경계 |
| --- | --- |
| `network` | AWS 계정·기존 네트워크 조회 후 로컬 결과 작성. 단순 오프라인 검사 아님 |
| `plan-<kind>` | cfn-lint·AWS 사전 검사·변경 세트 생성 및 검토 자료 작성. **클라우드 쓰기**이며 실행은 하지 않음 |
| `apply-<kind>` | 검토한 변경 세트 실행 요청. 앱 정상화까지 기다리는 명령 아님 |
| `status-<kind>` | 스택 상태/이벤트 조회; 완료 상태면 로컬 출력 저장 |
| `build-push`, `build-data-push`, `build-routing-push` | 검사·Docker 빌드·ECR 게시. routing은 웹 빌드보다 먼저 준비. 웹은 static 스택이 있으면 자산 게시도 수행 |
| `invalidate` | 앱 CloudFront의 `/`, `/index.html`만 무효화 요청 |
| `plan-tls-probe-disable` | 자기 프로브의 Enabled=false 변경 세트 생성. `apply-tls-probe` 후 실제 비활성 `Deployed` 상태 확인 필요 |
| `delete-tls-probe` | 앱 distribution과 다르고, 비활성·배포 완료된 자기 임시 프로브만 삭제 요청 |

`<kind>`의 실제 목록은 `bootstrap`, `app`, `origin`, `edge`, `operations`, `data`, `origin-routing`, `tls-probe`, `static`이다. 이 배포기에는 모든 스택을 정리하는 일반 `delete` action이 없다.

Atlas 전용 배포기는 별도 `scripts/deploy-atlas-agent.py`이며 확인된 action은 `bootstrap-dependencies`, `build`, `publish`, `plan`, `apply`, `status`, `configure-logs`다. 실행은 격리 사본에서만 연결한다. 폐기된 `scripts/deploy-guide-models.py`를 새 Atlas의 모델 전환 절차로 사용하지 않는다.

## 이틀 진행안과 AWS 대기

아래 시각은 진행자가 배정할 실습·대기 블록이다. AWS 완료 시간의 보장이 아니다. 인증서·모델 허가·네트워크는 사전 준비하고, fresh 그래프 빌드·이미지 다운로드 속도는 리허설 결과로 일정을 조정한다. 두 날의 점심 외에 팀 진행 상황에 맞춰 휴식을 둔다.

| 시각 | 장·활동 | 대기 동안 할 일 / 다음 단계 진입 조건 |
| --- | --- | --- |
| 1일 09:00–10:00 | 00–03: 범위·환경·계정·Codex | 팀 소유권표·예산·검증 상태 작성. 미준비 네트워크는 진행자가 별도 처리 |
| 1일 10:00–11:30 | 04–05: CLI 입문, ECR·저장소·의존성 | Runtime/스택 대기 중 잠금 파일·변경 목록 검토. 완료 출력 확인 후 사용 |
| 1일 11:30–12:00 | 05: sample 카탈로그, 07 입력 다운로드 시작 | 출처·schema·건수 점검. 공개 다운로드/빌드가 남으면 별도 상태로 유지 |
| 1일 13:00–14:30 | 06: Atlas AgentCore | Runtime·Gateway target·Memory 전략 준비 대기 중 SigV4/namespace/권한 검토 |
| 1일 14:30–16:00 | 07: 그래프·HGT·라우팅 이미지 | 긴 빌드 중 manifest·GPX·fallback 차이 학습. 실제 엔진 검증 전 완료 표시 금지 |
| 1일 16:00–17:00 | 08: 웹 이미지·Private ECS 배포 | rolling task·ALB target·CloudFront 전파 대기. 다음 날 시작 전 digest·서비스 상태 재확인 |
| 2일 09:00–10:30 | 09: static/media OAC·WAF·FULL TLS | 인증서/SAN·캐시 정책 검토. 프로브·함수 association·distribution 전파 후 실제 HTTPS 확인 |
| 2일 10:30–12:00 | 10: 제한 수집·사진·한영 상세 | 수집기 최대 실행 예산과 종료 여유를 확보. exit code·partial·보존 기록·사진을 함께 확인 |
| 2일 13:00–14:00 | 11: 로그·알람·SNS·사용량 | 로그 전달과 여러 평가 구간을 기다리며 차원·필터 검토. SNS 실제 수신과 알람 상태 구분 |
| 2일 14:00–15:30 | 12: 기능·브라우저·AI·privacy 검증 | 팀별 모델 호출 시간 분산. 실제 소스/도구/모델·관측 구간 기록 |
| 2일 15:30–17:00 | 13: 정리·잔여 자원 인계 | CloudFront 비활성·삭제, Lambda@Edge 연결 해제/복제 정리가 끝나지 않으면 담당자·후속 확인 시각 기록 |

수집 완료 누락 알람의 **48시간 평가 창**은 수업 중 즉시 실증할 수 있는 짧은 테스트가 아니다. 초기 지표에는 과거 이벤트 소급 집계도 없다. 필터·설정 검증과 실제 시간 창 관측을 나눠 기록한다. 인증서 검증, CloudFront 전파, Lambda@Edge 복제 자원 정리가 블록을 넘으면 다음 체크포인트로 인계하며, 완료 상태를 만들기 위해 대기·검사를 생략하지 않는다.

## 여러 팀의 quota·비용 관리

행사 전에 팀 수, 동시에 실행할 웹/수집 task 수, 모델 질문 횟수, 허용 운영 시간, 예산 책임자, 알림 수신자를 정한다. 요율은 준비 시점의 해당 리전·아키텍처·서비스 조건으로 확인하고 조회일·가정을 남긴다. 기존 `docs/capacity-cost.md`의 과거 요율이나 다른 크기의 task 견적을 고정 참가비·월 총액으로 재사용하지 않는다.

| 사용량 축 | 진행자가 볼 지표·한도 | 운영 방식 |
| --- | --- | --- |
| Fargate·ALB·네트워크 | 팀별 task CPU/RAM·running/desired·배포 추가 task·수집 task, ALB/LCU·공인 IPv4·NAT 처리량 | 정상 수뿐 아니라 `MaximumPercent: 200`의 rolling 여유와 수집 동시 실행까지 합산. 원본 routing 설정의 0.5 vCPU/1 GiB는 측정 출발점이며 확정 용량 아님 |
| 계정 서비스 quota | Fargate vCPU·ENI/서브넷 IP·ALB/TG·SG/prefix 규칙·CloudFront·WAF·IAM·AgentCore 한도 | 팀 수를 곱해 리허설. 입문 Runtime과 Atlas Guide/Tools를 별도 계산. 계정 한도 변경은 담당자 사전 준비 |
| 모델·AgentCore·Memory | Runtime 사용량, 모델 입력/출력·reasoning 토큰, 도구 호출, Memory 이벤트/추출·검색 | 전체 하루 30회·actor 시간당 5회·전체 동시 2회는 **한 팀 앱의 입장 제한**. 직접 Runtime 호출·CLI 입문 호출은 이 BFF 제한을 통과하지 않음 |
| CloudFront·WAF·함수 | 요청·전송·캐시 적중·오류, WAF 요청·규칙, Functions/Lambda@Edge 실행 | DEM hit/miss와 ALB 원본 요청 구분. 제공처·타일 무제한 부하나 자동 AI 반복을 과제에 넣지 않음 |
| 저장·보존 | S3 현재/이전 버전·요청, ECR 이미지, Secrets Manager, DynamoDB 요청, Memory 잔여 | 미태그 ECR 수명주기·S3 noncurrent 만료만으로 전체 보관 자원이 사라지지 않음 |
| 관측 | CloudWatch 로그 유입/보관·조회·알람·대시보드, telemetry/X-Ray, SNS | 사용자 원문 없는 필요한 관측만 수집. 실제 수신자가 있는 경보 경로와 담당자 확인 |
| 외부 제공처 | TourAPI/VisitJeju 및 선택 외부 서비스의 호출·실패·제한 | 팀별 실행 시각 분산, 작업의 bounded 옵션과 실패 보존 사용. provider 제한을 반복 재시도로 우회하지 않음 |

계정 예산/비용 알림은 진행자가 별도로 준비할 운영 장치다. 현재 템플릿에 AWS Budgets 리소스나 금액 상한에 따른 자동 중지 기능은 없다. 비용 알림, 호출 횟수 제한, 실제 청구 상한을 같은 것으로 설명하지 않는다.

클라우드 단계 시작 전, 점심 전후, 당일 종료 전에 팀별 남은 사용량과 예약 작업 상태를 확인한다. 남은 모델 호출을 무작정 소진하지 않고 한국어/영어·일반/계획 검증에 배정한다. 한 요청에 여러 모델·도구 왕복이 있을 수 있으므로 요청 수만으로 비용을 확정하지 않는다. 기존 NAT를 새로 만들지 않아도 수업의 추가 전송·처리량은 비용 검토에 포함한다.

## 정리 순서와 남는 자원

정리는 `workshop/chapters/13-cleanup.md`와 검증된 helper의 소유권 검사에 따라 진행한다. 삭제 전 장부에는 계정·리전·팀·실제 ARN/ID·생성 주체·보존 여부가 있어야 한다. 원본 운영 자원 이름이나 단순 prefix 검색 결과를 삭제 목록으로 사용하지 않는다. CLI 입문 프로젝트와 Atlas CloudFormation 스택의 정리 경로도 따로 관리한다.

| 대상 | 정리·보존 확인 |
| --- | --- |
| 예약 수집 | 먼저 자기 `RefreshSchedule`의 새 실행을 막고 이미 실행 중인 자기 worker의 종료 상태 확인. 일정 비활성 전환에 따른 조건부 알람 삭제도 검토 목록에 포함 |
| 임시 TLS 프로브 | 자기 앱 distribution과 다른지 확인. 비활성 전파 후 프로브 stack 삭제·완료 확인. `delete-tls-probe`의 “삭제 요청” 출력은 완료 증거가 아님 |
| 앱·CloudFront·엣지 연결 | 앱 트래픽을 종료하고 distribution의 Lambda@Edge/WAF/OAC 및 log delivery 참조를 의존성에 맞춰 해제. 비활성/삭제 전파를 기다린 뒤 사용 중인 관련 자원 정리 |
| ECS·ALB·팀 IAM | 앱/worker 서비스·task·target·SG의 종료/제거 확인. 팀 역할만 정리하며 계정의 서비스 연결 역할·공유 보안 기능은 임의 삭제하지 않음 |
| `GuideQuota` | Retain 및 삭제 보호가 있다. 보존할지 결정한 뒤 소유자가 명시적으로 보호 해제·삭제 절차 수행. TTL은 테이블 삭제 기능이 아님 |
| `SessionSecret`, `OriginSecret` | Retain으로 남는다. 자기 secret의 보존 또는 삭제 예약과 회복 기간을 기록. 공유 인증/제공처 자격 증명 전체를 폐기하지 않음 |
| SSM 제공처 parameter | CloudFormation 밖에서 준비한 팀 전용 항목을 장부로 확인해 정리. 조직 제공 공유 parameter는 유지 |
| `DetailsBucket`, `AssetsBucket` | 둘 다 Retain. 삭제를 선택하면 현재 객체·모든 버전·delete marker·미완료 업로드까지 확인. 데이터 버킷의 30일 noncurrent 만료는 현재 데이터 전체 만료가 아니며 static 버킷에는 자동 만료 정책이 없음 |
| ECR `Repository` | Retain. 자기 웹/라우터/수집 digest와 필요 보존본을 확인. 미태그 7일 규칙으로 태그가 있는 이미지·저장소가 자동 정리되지 않음 |
| AgentCore Memory | Retain. 이벤트와 추출된 장기 기억을 포함한 자료 소유권·보존 결정을 기록. Runtime 삭제, 브라우저 삭제, 이벤트 30일 설정으로 전체 Memory 삭제를 대신하지 않음 |
| Guide/Tools/Gateway/Target | Atlas stack의 실제 자원만 정리. 입문 CLI Runtime·아티팩트는 CLI 프로젝트의 별도 목록으로 처리 |
| origin 인증서·함수 버전 | 새로 만든 `Certificate`, `OriginHostVersion`은 Retain. 사용 중인 참조 해제·복제본 정리 대기 후 별도 처리. 제공받은 viewer/origin 인증서는 공유 소유자에게 반환 |
| 로그·관측 | 앱/worker/edge/origin LogGroup은 Retain. Runtime 서비스가 만든 로그와 배포기가 여러 리전에 준비한 origin 로그도 점검. 보관 기간과 그룹 삭제 여부를 따로 기록 |
| DNS·공유 기반 | 진행자가 추가한 팀 DNS alias만 소유자 절차로 정리. 기존 zone·검증 CNAME·공유 인증서·VPC·서브넷·NAT·EIP·라우트·endpoint·중앙 추적 경로 유지 |
| 로컬 자료 | 팀 사본·개인 브라우저 저장/서비스 워커·선택 다운로드·이미지와 증거를 구분. 원본 저장소와 다른 프로젝트는 정리 범위 밖 |

특히 Lambda@Edge의 연결 해제·복제본 정리는 수업 종료와 동시에 끝난다고 약속하지 않는다. 남은 ARN, 상태, 마지막 확인 시각, 담당자, 다음 확인 시각을 인계한다. 스택 `DELETE_COMPLETE`만으로 Retain 자원·서비스 생성 로그·SSM까지 모두 없어졌거나 비용이 즉시 0이 됐다고 선언하지 않는다.

## 로컬 검증과 클라우드 리허설 구분

진행자는 수업 전에 **새 팀 이름 공간 하나에서 준비부터 정리까지** 리허설한다. 이 문서의 소스 조사와 교재 빌드는 그 클라우드 리허설을 대신하지 않는다. 지원하지 않는 로컬 플랫폼·자료·권한 때문에 건너뛴 검사는 범위와 이유를 남긴다.

| 증거 수준 | 확인할 내용 | 증명하지 못하는 내용 |
| --- | --- | --- |
| 소스·템플릿 검사 | 리소스/조건/권한 범위, 잠금 파일, 실제 argparse, 네 AgentCore registry schema를 사용하는 cfn-lint | 현재 서비스 가용성·계정 quota·배포 완료 |
| 로컬 회귀·앱 빌드 | Node/Python 테스트, 생성 HTML/자산, 샘플 provenance, 격리·오류 거절, mock HTTP/SSE | 실제 AgentCore 모델 답변·제공처 응답·AWS 역할 권한 |
| 실제 로컬 라우터·브라우저 | 자신의 그래프/HGT·Valhalla HTTP·GPX·고도·취소·저장·한영 UI | Private Fargate 실행·NAT 접근·CloudFront 배포. 외부 타일을 받는 브라우저 검사를 완전 오프라인이라고 부르지 않음 |
| AWS 제어면·아티팩트 | 예상 계정·실제 stack/resource·READY·전략 상태·image digest·scan·두 AZ task·정책 | 생성 상태만으로 공개 웹 전체 기능·모델 처리 완료 |
| 실제 데이터/HTTP/브라우저 | 두 viewer 사용 시 양쪽의 health/readiness/catalog, route/elevation POST, OAC 차단/허용, TLS·cache·PWA·모바일·사진 | 조회 HTTP 부하만으로 AI 지연·장시간 수용량·사용자 FPS 보장 |
| 실제 모델·도구·Memory·privacy | 허용된 질문의 locale/모델 route·실제 도구·SSE 정상 종료, 자기 Memory 저장/조회, 지정 시간 구간 로그/trace | 단일 성공으로 미래 응답 전체의 정확성·무유출·고정 비용 보장 |
| 복구·정리 | 실제 이미지 로컬 호환성, 선택한 팀의 클라우드 교체/복구, 자원 제거·보존 장부 | 로컬 롤백 성공을 실제 클라우드 롤백 수행으로 표시할 수 없음 |

참고 검사 경로는 `scripts/check.mjs`, `scripts/verify.py`, `scripts/verify-terrain-cache.py`, `scripts/verify-shared-assets.py`, `scripts/verify-tls-probe.py`, `scripts/verify-guide-privacy.py`, `scripts/browser-mobility-check.mjs`, `scripts/browser-mobility-live-check.mjs`, `scripts/browser-bilingual-live-check.mjs`다. 실제 실행 대상·출력 경로·옵션은 해당 스크립트와 장의 확정 명령을 확인한다. `npm run check`는 npm audit 통신과 빌드/결과 파일 작성을 포함한다.

`scripts/recovery-check.py`와 `scripts/verify-autoscaling.py`의 변경 실험, `scripts/rollback-release.py`의 실제 적용은 조회 검사와 구분한다. 격리되지 않은 기존 운영 대상·고정 승인 이미지 목록을 참가자 리허설에 사용하지 않는다. Guide 모듈 import도 설정에 따라 MCP 세션을 열 수 있으므로 오프라인 테스트는 구성된 의존성을 명시적으로 격리해야 한다.

검증 결과에는 팀/계정/리전, 소스 revision 또는 digest, 웹·라우터·worker digest, 코드 ZIP hash/VersionId, 데이터 출처·기준일, 실행 명령과 시작/종료 시각, 기대/실제 결과, 실패·skip·남은 제약을 남긴다. 쿠키·CSRF proof·키·질문/답변 원문이 포함된 dump는 공용 보고서에 넣지 않는다. 교재에서는 코드 경로를 사용하며 과거 `.local/...` 증거를 클릭 가능한 공개 링크로 만들지 않는다.

## 부모 작업과 리허설에서 확인할 공백

| 확인 대상 | 현재 소스의 근거와 필요한 후속 확인 |
| --- | --- |
| 격리 helper 인터페이스 | `workshop/scripts/lab.py`의 구현·도움말·테스트와 장 예제를 일치시켜야 한다. 이 가이드의 단계 설명은 helper 기능 완료 선언이 아님 |
| 첫 설치 저장소 순환 | `scripts/deploy.py: infrastructure_parameters, atlas_agent_parameters`의 앱 ↔ 데이터/AgentCore 순환을 fresh 경로에서 해결했는지 확인 |
| 사설 의존성 manifest | 원본 Agent build는 운영 객체를 fetch할 수 있다. 커밋된 uv lock에서 새 의존성을 만드는 참가자 경로와 Runtime 호환성을 검증 |
| 운영 값 잔존 | `infra/*.yaml`, `scripts/deploy.py`, `scripts/fetch-place-details.py`의 계정·도메인·이름·IAM 범위 확인. 특히 `infra/application.yaml`의 `MEDIA_ORIGIN`, `server/catalog.mjs` 기본 media origin, `server/server.mjs`의 상세 media origin은 서로 다른 운영 도메인을 포함하므로 팀 사본의 실제 사진 URL도 검증 |
| 데이터 가용성과 권리 | 비공개 운영 catalog·상세·사진·선택 snapshot은 새 clone에 없다. sample 건수·새 매칭·부분 실패·미제공 자료를 실제대로 표시 |
| 모델·제공처·계정 서비스 | Global CRIS 접근, provider 이용조건·quota, enhanced scanning, 계정 관리 GuardDuty 동작은 코드만으로 확정할 수 없음 |
| 긴 관측·삭제 대기 | 48시간 완료 누락 창, Memory 추출, log delivery·SNS 수신, Lambda@Edge 복제 정리·Retain 자원은 관측/인계 기록 필요 |

지원 근거가 없는 AgentCore Browser·Code Interpreter·Knowledge Bases·online evaluations나 GuardDuty 배포를 과정 성과에 추가하지 않는다. 로컬 준비만 끝낸 팀, 부분 배포 팀, FULL 검증 팀을 같은 완료 상태로 집계하지 않는다.
