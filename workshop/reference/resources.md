# 본 실습과 심화 실습의 자원

00~04장은 120분 본 실습입니다. 기존 VPC, NAT Gateway, Subnet과 VSCode Server를 사용하고
AgentCore CLI로 새 Strands Runtime을 생성합니다. 05장 이후의 전체 Atlas 배포는 선택 과정입니다.

## 본 실습

| 기술 또는 자원 | 참가자가 하는 일 |
|---|---|
| VSCode Server | 준비된 EC2 터미널과 편집기 사용 |
| Codex, Kiro CLI, Claude Code | 하나를 선택해 코드와 테스트 작성 |
| AgentCore CLI 0.28.1 | Strands 프로젝트 생성, dev, deploy, invoke, status, logs |
| Python과 Strands | 제주 장소 JSON 검색 도구와 응답 규칙 구현 |
| Bedrock | 진행자가 확인한 모델을 IAM 인증으로 호출 |
| AgentCore Runtime | 참가자 이름의 JejuGuide 배포와 응답 확인 |
| CloudFormation과 CDK bootstrap | CLI 배포가 사용하는 스택과 준비된 아티팩트 기반 확인 |

본 실습의 모델 호출과 Runtime은 실제로 확인해야 합니다.
코드만 생성했거나 READY 상태만 확인했다면 원격 응답까지 성공한 것으로 기록하지 않습니다.
Gateway와 별도 Memory는 06장의 심화 과정에서 다룹니다.
모델 없는 Warmup 번들은 독립 검증을 위한 참고 모듈이며 본 실습의 결과물을 대신하지 않습니다.

## 심화 과정의 전체 자원

아래 표는 저장소의 인프라와 앱을 연결한 목록입니다.
참가자 계정에 모두 배포되었다는 의미는 아닙니다.
현재 논리 자원과 유형의 수는 `workshop/scripts/check_content.py`에서 확인합니다.
`Parameters.VpcId.Type: AWS::EC2::VPC::Id` 같은 입력 타입은 VPC 생성 자원으로 세지 않습니다.

공유 VPC, NAT, Subnet과 CDK bootstrap은 유지합니다.
실습 이름으로 만든 자원은 실제 ARN과 소유 태그를 기록하고,
Retain 설정의 자원은 스택 삭제 후에도 남아 있는지 확인합니다.

## 기반, 저장소, 비밀값

| 리소스 / 기술 | 기존 파일, 식별 지점 | 실습 장 | 기대 검증 | 공유 / 실습 소유 |
| --- | --- | --- | --- | --- |
| CloudFormation, 변경 세트, IAM capability, 리전 간 출력 전달 | `infra/*.yaml`, `scripts/deploy.py`의 `plan`, `apply`, `status`, `stack_client` | `02-aws-environment.md`, `05-foundation-and-data.md`, `12-validation.md` | 렌더링한 계정, 이름, 리전과 변경 목록 대조. `apply` 접수 후 스택 완료 및 서비스 상태를 따로 확인 | 실습 스택. 기존 공유 스택 변경은 범위 밖 |
| 기존 VPC, Public/Private Subnet, IGW, 라우트 테이블, NAT Gateway, EIP | `infra/application.yaml`의 **Parameters**, `infra/data.yaml`의 **Parameters**, `scripts/deploy.py: assert_network` | `02-aws-environment.md`, `13-cleanup.md` | 같은 VPC의 정상 서브넷, Public 기본 경로의 IGW, Private 기본 경로의 정상 NAT, Public IP 비활성, AZ 배치 확인. 변경 세트에 네트워크 생성, 교체가 없어야 함 | 공유. 해당 네트워크를 생성하는 Resources 없음 |
| AWS 관리 CloudFront origin-facing prefix list, 기존 VPC endpoints | `infra/application.yaml: CloudFrontPrefixListId`, `scripts/deploy.py: assert_network`, `README.md` | `02-aws-environment.md`, `09-https-edge.md` | prefix list의 AWS 소유자, 이름 확인. 기존 endpoint가 있다면 정책, 경로 확인; 원본 코드의 NAT 전제도 충족 | 공유/AWS 관리. endpoint 생성 선언 없음 |
| `AWS::ECR::Repository`. `Repository` | `infra/bootstrap.yaml`, `scripts/deploy.py: build_push`, `Dockerfile`, `Dockerfile.data`, `Dockerfile.routing` | `05-foundation-and-data.md`, `07-routing.md`, `11-operations.md` | 불변 태그, digest URI, AES256, push scan 설정, 미태그 이미지 수명주기 확인. 웹, 라우터, 수집 이미지는 같은 팀 저장소의 서로 다른 아티팩트 | 실습, 보존 |
| ECR 이미지 검사 / Amazon Inspector | `infra/bootstrap.yaml: ImageScanningConfiguration`, `Dockerfile.routing`, `docs/mobility-independence-2026-09-11.md` | `05-foundation-and-data.md`, `07-routing.md`, `12-validation.md` | **세 이미지 digest별** 검사 방식, 상태, 시각, 발견 항목 확인. push 성공이나 로컬 패키지 버전 확인만으로 검사 완료를 선언하지 않음 | 저장소는 실습. Inspector/enhanced scanning은 계정 설정 확인 대상이며 생성 선언 없음 |
| `AWS::S3::Bucket`. `DetailsBucket`, `AssetsBucket` | `infra/data.yaml`, `infra/static.yaml` | `05-foundation-and-data.md`, `09-https-edge.md`, `10-enrichment.md`, `13-cleanup.md` | 버전 관리, 암호화, Block Public Access, BucketOwnerEnforced 확인. 데이터 버킷의 `catalog/`, `agent/`, `snapshots/`, `place-details/`, `media/` 객체는 별도 확인 | 두 버킷 모두 실습, 보존. 각 prefix는 별도 버킷이 아님 |
| `AWS::S3::BucketPolicy`. `DetailsBucketPolicy`, `AssetsBucketPolicy` | `infra/data.yaml`, `infra/static.yaml` | `09-https-edge.md`, `12-validation.md` | HTTP 거절, 정확한 배포 ARN의 CloudFront만 `media/*` 또는 `assets/*` 읽기. 직접 익명 S3와 `releases/*` manifest 공개 차단 확인 | 실습. 외부 지형 버킷 정책은 수정하지 않음 |
| `AWS::CloudFront::OriginAccessControl`. `MediaOriginAccessControl`, `AssetsOriginAccessControl` | `infra/data.yaml`, `infra/static.yaml`, `infra/application.yaml` | `09-https-edge.md` | `always`/`sigv4` 서명과 S3 origin 연결 확인. `/media/*`, `/assets/*` 내용, MIME, checksum 검증 | 실습. 앱은 다른 실습 스택의 OAC ID를 입력으로 소비 |
| 릴리스별 정적 자산과 SHA-256 manifest | `scripts/publish-assets.py`, `scripts/deploy.py: require_asset_manifest`, `scripts/verify-shared-assets.py` | `08-web.md`, `09-https-edge.md`, `12-validation.md` | 실제 이미지에서 추출한 자산을 먼저 게시하고 manifest를 마지막에 기록. 현재, 이전 HTML이 참조하는 파일의 HTTP 응답, hash 확인 | 실습 버킷의 릴리스 공유 자산. 과거 객체를 빌드마다 삭제하지 않음 |
| `AWS::SecretsManager::Secret`. `SessionSecret`, `OriginSecret` | `infra/application.yaml`, `server/sessions.mjs` | `08-web.md`, `09-https-edge.md`, `13-cleanup.md` | 세션 서명 키와 ALB 검증 키 분리. ECS 비밀 주입 및 CloudFormation 동적 참조 연결을 값 노출 없이 확인 | 실습, 보존. 제공처 API 키와도 별개 |
| SSM Parameter Store SecureString | `scripts/fetch-place-details.py: KEY_PATHS`, `infra/data.yaml: WorkerRole`, `infra/application.yaml: KakaoRestApiKeyParameter` | `02-aws-environment.md`, `10-enrichment.md`, `13-cleanup.md` | TourAPI, VisitJeju 키는 수집 역할만 사용. 선택한 카카오 REST 키는 참가자 전용 `kakao-rest-api-key`를 ECS secrets로 주입하고 실행 역할은 해당 ARN만 읽음. 브라우저, Guide, Tools에 제공처 키를 보내지 않음 | 사전 준비한 팀 전용 항목. 기존 YAML에 `AWS::SSM::Parameter` 생성 리소스 없음 |
| `AWS::DynamoDB::Table`. `GuideQuota`, `VisitorPresence` | `infra/application.yaml`, `server/admission.mjs`, `server/api.mjs` | `08-web.md`, `11-operations.md`, `13-cleanup.md` | on-demand, 암호화, `expiresAt` TTL, 삭제 보호 확인. 여러 웹 태스크의 조건부 입장, 동시 실행 lease, 중복 request ID 거절 검사 | 실습, 보존. AI 요청 상태와 현재/누적 접속 집계. 장소 카탈로그 DB와는 별개 |

## 심화 Atlas AgentCore

| 리소스 / 기술 | 기존 파일, 식별 지점 | 실습 장 | 기대 검증 | 공유 / 실습 소유 |
| --- | --- | --- | --- | --- |
| `AWS::IAM::Role`. `MemoryRole`, `GuideRole`, `ToolsRole`, `GatewayRole` | `infra/agentcore.yaml` | `06-atlas-agentcore.md`, `12-validation.md` | 서비스 신뢰 관계, SourceAccount, 자기 코드, 데이터, Gateway, Memory, Runtime ARN 대조. 이전 프로젝트 ARN grant가 없어야 함 | 실습 |
| `AWS::BedrockAgentCore::Runtime`. `GuideRuntime`, `ToolsRuntime` | `infra/agentcore.yaml`, `agent/guide/main.py`, `agent/tools/main.py`, `scripts/deploy-atlas-agent.py` | `06-atlas-agentcore.md` | S3 key, VersionId, SHA-256과 배포물 대조, 실제 Runtime `READY` 확인. `PYTHON_3_14`, Guide의 HTTP/SSE, Tools의 MCP 확인 | 실습. **두 Runtime 모두 `NetworkMode: PUBLIC`**; Private ECS와 구분 |
| `AWS::BedrockAgentCore::Gateway`. `Gateway` | `infra/agentcore.yaml` | `06-atlas-agentcore.md` | `AuthorizerType: AWS_IAM`, 자기 Gateway 역할, URL 확인. 생성 상태와 도구 접근 성공을 따로 기록 | 실습 |
| `AWS::BedrockAgentCore::GatewayTarget`. `ToolsTarget` | `infra/agentcore.yaml`, `agent/guide/mcp_client/client.py` | `06-atlas-agentcore.md` | `Http.AgentcoreRuntime.Arn`, `GATEWAY_IAM_ROLE`, 실제 대상 이름의 `/<target-name>/invocations`에서 도구 목록 확인 | 실습. 원본 대상은 `JejuAtlasTools`; 집계형 `/mcp`로 추정하지 않음 |
| IAM / SigV4 호출 경로 | `server/guide.mjs: createAgentInvoker`, `agent/guide/mcp_client/client.py`, `agent/guide/atlas_agent/identity.py` | `06-atlas-agentcore.md`, `08-web.md`, `12-validation.md` | ECS 역할의 AWS SDK → Guide → `aws_iam_streamablehttp_client` → Gateway → Tools 확인. 브라우저는 세션/CSRF 사용; AWS 키, Runtime ARN을 받지 않음 | 실습 역할. Codex 로그인과 무관 |
| `AWS::BedrockAgentCore::Memory`. `Memory` | `infra/agentcore.yaml`, `agent/guide/memory/session.py` | `06-atlas-agentcore.md`, `13-cleanup.md` | 자기 Memory ID, 네 전략의 상태, namespace, IAM 조회 범위 확인. 단기 이벤트 저장과 장기 추출, 회상을 별도 관측 | 실습, 보존. 이전 사용자 자료를 가져오지 않음 |
| Semantic / User Preference 전략 | `infra/agentcore.yaml: SemanticMemoryStrategy, UserPreferenceMemoryStrategy`, `agent/guide/memory/session.py: retrieval_namespaces` | `06-atlas-agentcore.md` | 사실 `/users/{actorId}/facts`, 선호 `/users/{actorId}/preferences` 저장, 조회 경로 일치. 서로 다른 actor의 조회 경계 확인 | 위 Memory 내부 전략 두 개 |
| Summary / Episodic 전략 | `infra/agentcore.yaml: SummaryMemoryStrategy, EpisodicMemoryStrategy`, `agent/guide/memory/session.py` | `06-atlas-agentcore.md` | 요약 `/summaries/{actorId}/{sessionId}`, 경험 `/episodes/{actorId}/{sessionId}`, reflection `/episodes/{actorId}` 확인. 추출 대기 중을 성공으로 처리하지 않음 | 위 Memory 내부 전략 두 개 |
| Strands Agents, Bedrock Converse, 규칙 기반 Global CRIS 모델 선택 | `agent/guide/model/load.py`, `agent/guide/atlas_agent/routing.py`, `infra/agentcore.yaml` | `06-atlas-agentcore.md`, `12-validation.md` | 일반 질문 `global.openai.gpt-5.6-sol`, 일정 `global.openai.gpt-6-astra`, `auto` 설정과 inference-profile/foundation-model 권한 대조. 계정 접근성, 모델 메타데이터는 별도 실측 | 모델, 프로필은 서비스 제공 자원. 코드가 모델이나 접근 허가를 생성하지 않음 |
| 프리페치, 도구 예산, 구조화 지도 응답 | `agent/guide/main.py`, `agent/guide/atlas_agent/prefetch.py`, `agent/guide/atlas_agent/tool_budget.py`, `agent/guide/atlas_agent/derive.py`, `agent/guide/atlas_contracts/mapresponse_v2.py` | `06-atlas-agentcore.md`, `08-web.md` | 규칙 분류에는 추가 모델 호출 없음. 기본 `derive`의 실제 도구 결과 기반 지도, Pydantic 한도, 취소, 실패 fallback, 반복 호출 제한 확인 | 실습 코드. “한 질문 = 항상 모델 한 번” 보장 없음 |
| FastMCP / streamable HTTP / MCP 도구 8개 | `agent/tools/main.py`, `agent/tools/atlas_tools/` | `06-atlas-agentcore.md`, `10-enrichment.md` | `find_places`, `place_detail`, `route`, `weather`, `sun_times`, `layer`, `festivals`, `plan_day` 목록, 스키마 확인. 데이터 유무, `source`, `stale`, `fallback` 확인 | 실습 Tools. 목록 존재는 제공처 연결 성공과 다름 |
| Python, uv 잠금, 배포 ZIP, CRT/OTel 의존성 | `agent/guide/pyproject.toml`, `agent/guide/uv.lock`, `agent/tools/pyproject.toml`, `agent/tools/uv.lock`, `agent/dependency-artifacts.json`, `scripts/deploy-atlas-agent.py` | `01-setup.md`, `05-foundation-and-data.md`, `06-atlas-agentcore.md` | 잠금 파일에서 참가자용 의존성을 새로 준비하고 Runtime Python/플랫폼 호환성, ZIP 경로, hash 확인. 원본 `build`의 사설 S3 fetch는 오프라인 빌드가 아님 | 새 아티팩트는 실습. 운영 manifest는 참가자의 다운로드 권한 증거가 아님 |
| CLI 입문 Runtime과 Atlas 스택 구분 | `workshop/IMPLEMENTATION_PLAN.md`, `infra/agentcore.yaml` | `04-agentcore-cli.md`, `06-atlas-agentcore.md`, `13-cleanup.md` | 입문 프로젝트와 Atlas의 별도 이름, 관리 도구, 출력, 정리 목록 대조. CLI 명령은 04장의 검증된 인터페이스 사용 | 둘 다 실습, 수명주기 별도. 이 YAML 목록이 입문 프로젝트를 선언하지 않음 |

Memory의 `EventExpiryDuration: 30`은 단기 이벤트 설정이다. 추출된 모든 장기 기억이 30일 뒤 삭제된다는 뜻도, 브라우저 자료 삭제가 서버 Memory를 지운다는 뜻도 아니다.

## 웹 컴퓨팅, 로드 밸런싱

| 리소스 / 기술 | 기존 파일, 식별 지점 | 실습 장 | 기대 검증 | 공유 / 실습 소유 |
| --- | --- | --- | --- | --- |
| `AWS::EC2::SecurityGroup`. `AlbSecurityGroup`, `TaskSecurityGroup`, `AlbTlsSecurityGroup` | `infra/application.yaml` | `08-web.md`, `09-https-edge.md` | ALB 80/443은 CloudFront prefix list만, 앱 8080은 ALB SG만 허용. TLS SG는 `HasOriginCertificate` 조건. HTTP/TLS prefix 규칙 분리 이유와 실제 SG quota 확인 | 실습 SG, 공유 VPC에 배치 |
| `AWS::EC2::SecurityGroupIngress`. `AlbToTaskIngress` | `infra/application.yaml` | `08-web.md` | Task SG TCP 8080 source가 팀 ALB SG인지 확인. 8002 공개 규칙은 없어야 함 | 실습 |
| `AWS::ElasticLoadBalancingV2::LoadBalancer`. `LoadBalancer` | `infra/application.yaml` | `08-web.md` | internet-facing ALB의 Public Subnet, 두 AZ, SG, 대상 확인. 인터넷 직접 접근과 CloudFront 경유 구분 | 실습 ALB. 서브넷/IGW는 공유 |
| `AWS::ElasticLoadBalancingV2::TargetGroup`. `TargetGroup` | `infra/application.yaml`, `server/server.mjs` | `08-web.md`, `11-operations.md` | IP target, 8080, `/readyz`, 정상 target 수 확인. `/healthz`만으로 전체 의존성 성공을 판단하지 않음 | 실습 |
| `AWS::ElasticLoadBalancingV2::Listener`. `Listener`, `TlsListener` | `infra/application.yaml` | `08-web.md`, `09-https-edge.md` | 기본 응답 403, TLS 인증서, 정책 확인. `TlsListener`는 `HasOriginCertificate`일 때만 생성 | 실습 |
| `AWS::ElasticLoadBalancingV2::ListenerRule`. `OriginRule`, `TlsOriginRule` | `infra/application.yaml` | `09-https-edge.md` | 원본 검증 헤더가 일치하는 요청만 전달. `TlsOriginRule`도 `HasOriginCertificate` 조건 | 실습. 비밀값을 보고서에 복사하지 않음 |
| `AWS::ECS::Cluster`. `Cluster` | `infra/application.yaml` | `08-web.md` | 팀 클러스터, 서비스 연결 확인. 템플릿의 Container Insights는 `disabled` | 실습. EKS/EC2 노드 클러스터가 아님 |
| `AWS::IAM::Role`. `ExecutionRole`, `TaskRole` | `infra/application.yaml` | `08-web.md`, `12-validation.md` | 이미지, 로그, 세션 비밀 주입과 S3 읽기, Guide 호출, quota 쓰기 역할 분리. 교차 팀 접근 확인 | 실습 |
| `AWS::ECS::TaskDefinition`. `TaskDefinition` | `infra/application.yaml`, `Dockerfile`, `Dockerfile.routing` | `07-routing.md`, `08-web.md` | Linux ARM64/Fargate/awsvpc, digest, 비루트, 읽기 전용 root, `/tmp`, capability 제거 확인. `RoutingEnabled`이면 같은 task에 routing 컨테이너 추가 | 실습 revision. 라우터는 별도 ECS 서비스가 아님 |
| `AWS::ECS::Service`. `Service` | `infra/application.yaml` | `08-web.md`, `11-operations.md` | Private ENI, `AssignPublicIp: DISABLED`, running/desired/pending, 실제 AZ, target health, circuit breaker 확인. ECS Exec 비활성 | 실습. NAT와 라우트는 공유 |
| `AWS::ApplicationAutoScaling::ScalableTarget`. `ScalableTarget` | `infra/application.yaml`, `scripts/deploy.py: preserved_desired_count` | `08-web.md`, `11-operations.md` | 설정 최소/최대, 실제 desired count 확인. 원본 범위는 최소 2, 최대 4이며 배포 중 현재 용량을 임의 축소하지 않음 | 실습 대상. 참조한 서비스 연결 역할은 신규 IAM 선언이 아님 |
| `AWS::ApplicationAutoScaling::ScalingPolicy`. `CpuScalingPolicy`, `MemoryScalingPolicy` | `infra/application.yaml`, `scripts/verify-autoscaling.py` | `11-operations.md`, `12-validation.md` | CPU 60%, 메모리 70% 목표와 cooldown 확인. 정책 존재, 실제 확장, 복원을 따로 기록 | 실습. 확장 실험은 실제 자원 변경 |
| Node HTTP BFF, SQLite, AWS SDK v3 | `server/server.mjs`, `server/api.mjs`, `server/catalog.mjs`, `package.json` | `05-foundation-and-data.md`, `08-web.md` | `node:sqlite` 읽기 전용 스키마 검증, S3 ETag 갱신, 원자적 교체, 마지막 정상본 보존, API 계약 확인 | 실습 코드/캐시. RDS, OpenSearch, Knowledge Base 생성 없음 |
| HMAC 세션, CSRF, SSE, 분산 admission | `server/sessions.mjs`, `server/admission.mjs`, `server/guide.mjs`, `server/api.mjs` | `08-web.md`, `12-validation.md` | 서명 쿠키, `X-Atlas-CSRF`, actor/대화 바인딩, request ID, 16 KiB 본문, 2,000자 질문, 8초 heartbeat, 90초 BFF 제한 확인. 불명확한 실패를 자동 재과금 호출하지 않음 | 실습. 한도 사용 여부와 제한값은 실습 설정에서 확인. 요청 충돌과 중복 실행 방지는 별도 |
| 준비 상태와 종료 처리 | `server/server.mjs`, `server/api.mjs`, `infra/application.yaml`, `tests/server-signals.test.mjs` | `11-operations.md`, `12-validation.md` | SIGTERM 이후 새 요청 거절, 스트림 정리, 앱 115초/ECS stop 120초/ALB deregistration 120초 대조 | 실습. 로컬 종료 테스트와 실제 ECS 교체 증거는 별도 |

## HTTPS, 캐시, 엣지

| 리소스 / 기술 | 기존 파일, 식별 지점 | 실습 장 | 기대 검증 | 공유 / 실습 소유 |
| --- | --- | --- | --- | --- |
| 사용자 DNS, viewer ACM 인증서 입력 | `infra/application.yaml: ViewerDomainName, ViewerCertificateArn`, `scripts/deploy.py: assert_domain` | `02-aws-environment.md`, `09-https-edge.md` | 실제 DNS 관리 권한, hostname의 CloudFront 연결, **us-east-1** 인증서 `ISSUED`, SAN 일치 확인. 기본 CloudFront 인증서 사용은 사용자 도메인 FULL parity와 구분 | 공유/사전 준비. DNS 생성 리소스 없음 |
| `AWS::CertificateManager::Certificate`. `Certificate` | `infra/origin.yaml`, `scripts/deploy.py: assert_origin_tls` | `09-https-edge.md`, `13-cleanup.md` | **서울 리전** origin 인증서 DNS 검증, SAN, 상태 확인. 원본 도메인 제약은 팀 사본에서 검토 | 새로 발급하면 실습, 보존. 기존 제공 인증서는 공유이며 재발급, 삭제하지 않음 |
| `AWS::IAM::Role`. `OriginHostRole` | `infra/origin-routing.yaml` | `09-https-edge.md` | Lambda와 edgelambda 신뢰, 자기 지역별 로그 쓰기 범위 확인 | 실습 |
| `AWS::Lambda::Function`. `OriginHostFunction` | `infra/origin-routing.yaml` | `09-https-edge.md` | us-east-1의 Node.js 22/x86_64 함수. 예상 ALB, HTTPS 443, origin-request 확인 후 인증서의 canonical Host만 설정; 본문 수집 없음 | 실습. ARM64 ECS와 아키텍처가 다름 |
| `AWS::Lambda::Version`. `OriginHostVersion` | `infra/origin-routing.yaml`, `scripts/deploy.py: assert_origin_tls` | `09-https-edge.md`, `13-cleanup.md` | 숫자로 게시된 버전 ARN, revision, ALB, hostname 일치. `$LATEST` 대신 게시 버전 사용. 연결 해제, 엣지 복제본 정리 대기 확인 | 실습, 보존 |
| `AWS::CloudFront::Distribution`. 앱 `Distribution` | `infra/application.yaml` | `08-web.md`, `09-https-edge.md` | `Deployed`, HTTPS redirect, HTTP/2, 3, origin, behavior 순서, alias/WAF/인증서 연결 확인. 조건별 실제 구성 대조 | 실습. 원본 HTTP 기본 단계와 FULL 원본 HTTPS 단계를 구분 |
| `AWS::CloudFront::CachePolicy`. `CachePolicy`, `CatalogCachePolicy`, `TerrainCachePolicy` | `infra/application.yaml` | `09-https-edge.md` | HTML 재검증; catalog 기본 60초, query 포함, cookie 제외; DEM 기본 7일, 최대 30일, 사용자별 키 제외 확인 | 실습 정책 |
| `AWS::CloudFront::CachePolicy`. `MediaCachePolicy`, `AssetsCachePolicy` | `infra/application.yaml` | `09-https-edge.md` | 각각 `HasDetails`, `HasSharedAssets` 조건. content-addressed media/assets 장기 캐시, 사용자 정보, 세션 미전달 확인 | 실습 정책 |
| AWS 관리 `CachingDisabled` | `infra/application.yaml`의 `/api/*` | `09-https-edge.md`, `12-validation.md` | `/api/catalog/*` 우선 분리와 설정, 경로, 고도, AI의 비캐시/no-store 확인. SSE compression 비활성 확인 | AWS 관리 정책 ID 참조. 신규 리소스 아님 |
| `AWS::CloudFront::OriginRequestPolicy`. `ApiOriginRequestPolicy`, `HostOnlyOriginRequestPolicy` | `infra/application.yaml` | `09-https-edge.md` | private API의 cookie, query, Origin, Content-Type, Accept, CSRF 전달. Host-only 정책은 `UseCanonicalHost`일 때 공개 ALB 요청에 사용 | 실습 |
| `AWS::CloudFront::ResponseHeadersPolicy`. `ResponseHeadersPolicy`, `TerrainResponseHeadersPolicy` | `infra/application.yaml` | `09-https-edge.md` | 보안 헤더, HSTS, DEM CORS, Timing-Allow-Origin, 기본 `no-store` 확인. API 자격 증명 CORS와 DEM 공개 CORS 구분 | 실습 |
| `AWS::CloudFront::Function`. `TerrainBrowserCacheFunction` | `infra/application.yaml`, `tests/terrain-cache-function.test.mjs`, `scripts/verify-terrain-cache.py` | `09-https-edge.md` | viewer-response의 정상/304 브라우저 TTL 1일, 오류 `no-store`, 원본 PNG hash 확인. origin-request Lambda@Edge와 별개 | 실습. 서울 DEM 복제본을 만들지 않음 |
| canonical Host / DNS origin 두 모드 | `infra/application.yaml`, `infra/origin-routing.yaml`, `scripts/deploy.py: assert_origin_tls` | `09-https-edge.md` | canonical-host는 ALB DNS에 접속하며 Host를 인증서 이름으로 고정. 기본, catalog, private API의 세 ALB behavior에만 함수 연결, assets/media/terrarium 제외. dns 모드는 별도 ALB CNAME 검증 | 도메인, 인증서 권한은 공유/사전 준비, 함수와 연결은 실습 |
| `AWS::CloudFront::OriginRequestPolicy`. 프로브 `RequestPolicy` | `infra/tls-probe.yaml` | `09-https-edge.md`, `13-cleanup.md` | Host, Origin, Content-Type, Accept, CSRF와 세션/query 보존 확인 | 임시 실습 |
| `AWS::CloudFront::Distribution`. 프로브 `Distribution` | `infra/tls-probe.yaml`, `scripts/verify-tls-probe.py`, `scripts/deploy.py: delete_tls_probe` | `09-https-edge.md`, `13-cleanup.md` | 독립 CloudFront URL로 TLS 검증. `ProbeEnabled`는 **생성 조건이 아니라 Enabled 속성 선택**. 비활성 상태 전파 후 자기 프로브만 삭제 | 임시 실습. WAF, origin secret, 함수 버전은 입력 참조 |
| `AWS::WAFv2::WebACL`. `WebAcl` | `infra/edge.yaml` | `09-https-edge.md`, `11-operations.md` | us-east-1/CLOUDFRONT, 앱 WebACLId 연결, 정규화한 `/api/`만 IP rate limit, CommonRuleSet 및 `SizeRestrictions_BODY` Count 확인. request sampling 비활성 | 실습. API rate 규칙에서 타일 제외가 모든 WAF 규칙 면제를 뜻하지 않음 |

## 공식 데이터 작업, 관측

| 리소스 / 기술 | 기존 파일, 식별 지점 | 실습 장 | 기대 검증 | 공유 / 실습 소유 |
| --- | --- | --- | --- | --- |
| `AWS::EC2::SecurityGroup`. `WorkerSecurityGroup` | `infra/data.yaml` | `10-enrichment.md` | `HasWorker` 조건, HTTPS egress, 기존 Private Subnet/NAT 사용 확인 | 실습 SG, 네트워크는 공유 |
| `AWS::IAM::Role`. `WorkerExecutionRole`, `WorkerRole`, `ScheduleRole` | `infra/data.yaml` | `10-enrichment.md` | 이미지/로그, catalog 읽기, 상세/media 쓰기, 두 SSM 읽기, 지정 task `RunTask`, 지정 역할 `PassRole` 분리. 모두 `HasWorker` 조건 | 실습 |
| `AWS::ECS::TaskDefinition`. `WorkerTask` | `infra/data.yaml`, `Dockerfile.data`, `scripts/fetch-place-details.py` | `10-enrichment.md` | `HasWorker`일 때 ARM64 Fargate 수집기 생성. 실제 task exit code, `collection_complete`, provider 실패, 갱신 건수 동시 확인 | 실습. 상시 ECS Service를 추가하지 않음 |
| `AWS::Scheduler::Schedule`. `RefreshSchedule` | `infra/data.yaml`, `infra/data-settings.json` | `10-enrichment.md`, `13-cleanup.md` | `HasWorker`일 때 생성. 상태는 별도 `ScheduleState`; YAML 기본값은 DISABLED. Asia/Seoul 03:00, task 1개, retry 0, Public IP 없음 확인 | 실습. 정상 첫 실행을 확인한 뒤 활성화 |
| 수집 실행 한도, 동시 갱신 보호 | `scripts/fetch-place-details.py` | `10-enrichment.md` | task 설정 최대 900곳/900초, 종료 여유, operation별 상한, 완전한 페이지 목록만 매칭, ETag 조건부 latest 갱신 확인. 보존 기록의 `fetched_at` 유지 | 실습 코드/데이터. 하루에 전체 장소 갱신을 보장하지 않음 |
| `AWS::Logs::LogGroup`. `LogGroup`, `WorkerLogs`, `EdgeAccessLogs`, `OriginLogs` | `infra/application.yaml`, `infra/data.yaml`, `infra/edge.yaml`, `infra/origin-routing.yaml` | `11-operations.md`, `13-cleanup.md` | 앱/worker/origin 14일, edge 기본 14일(입력으로 30일 가능) 확인. `WorkerLogs`는 `HasWorker` 조건. 내용, 정책, 보관을 따로 확인 | 모두 실습, 보존 |
| Runtime 및 지역별 Lambda@Edge 로그 관리 | `scripts/deploy-atlas-agent.py: configure_logs`, `scripts/deploy.py: prepare_edge_log_groups` | `06-atlas-agentcore.md`, `09-https-edge.md`, `13-cleanup.md` | Runtime ID, 역할, 코드 소유권 확인 후 로그 보관 적용. origin 배포기가 추가 준비한 여러 리전의 로그 목록도 기록 | 실습이지만 일부는 **CloudFormation 밖에서 관리**. 기존 중앙 추적 저장소는 공유 |
| `AWS::Logs::DeliverySource`. `CloudFrontDeliverySource` | `infra/edge.yaml` | `09-https-edge.md`, `11-operations.md` | 입력 `DistributionArn`과 ACCESS_LOGS source 일치 | 실습. distribution을 소유하지 않음 |
| `AWS::Logs::DeliveryDestination`. `CloudFrontDeliveryDestination` | `infra/edge.yaml` | `11-operations.md` | 정확한 로그 그룹 ARN과 JSON 출력 확인 | 실습 |
| `AWS::Logs::Delivery`. `CloudFrontAccessDelivery` | `infra/edge.yaml` | `11-operations.md`, `12-validation.md` | 표준 로그 V2 전달, 실제 유입, 명시한 11개 `RecordFields` 확인. IP, URI, query, cookie, user-agent, 본문이 기본 필드로 되돌아오지 않아야 함 | 실습. Firehose나 S3 access-log 버킷 생성 선언 없음 |
| `AWS::SNS::Topic`. `Notifications`, `EdgeNotifications` | `infra/operations.yaml`, `infra/edge.yaml` | `11-operations.md`, `13-cleanup.md` | 서울/버지니아 topic 분리, 알람 액션 연결. 담당자가 수신 경로를 준비하고 실제 수신 확인 | 실습. **구독 생성 리소스 없음** |
| `AWS::SNS::TopicPolicy`. `NotificationPolicy`, `EdgeNotificationPolicy` | `infra/operations.yaml`, `infra/edge.yaml` | `11-operations.md` | SourceAccount, 자기 알람 ARN 범위, 데이터 알람 ARN의 팀 이름 확인. 데이터 스택이 topic 정책을 덮어쓰지 않음 | 실습. 데이터 스택은 서울 topic ARN을 입력으로 재사용 |
| `AWS::Logs::MetricFilter`. `GuideFailureMetric`, `CatalogStateMetric`, `OfficialDetailsStateMetric` | `infra/operations.yaml`, `server/api.mjs` | `11-operations.md` | 실제 JSON 이벤트의 오류, 숫자 stale 추출 확인. 공식 상세 필터는 `MonitorOfficialDetails`; catalog와 상세 heartbeat 별도 평가 | 실습. 원본 로그 그룹은 앱 스택 소유 |
| `AWS::CloudWatch::Alarm`. `HealthyTargetsAlarm`, `Alb5xxAlarm`, `Target5xxAlarm`, `TargetLatencyAlarm`, `CpuHighAlarm`, `MemoryHighAlarm`, `QuotaWriteThrottleAlarm` | `infra/operations.yaml` | `11-operations.md` | ALB/TG full name, ECS service, DynamoDB 차원, threshold, missing-data 확인. ALB p95는 **응답 헤더 지연**이며 SSE 완료 시간이 아님 | 실습 |
| `AWS::CloudWatch::Alarm`. `GuideFailuresAlarm`, `CatalogStaleAlarm`, `OfficialDetailsStaleAlarm` | `infra/operations.yaml`, `server/api.mjs`, `server/official-details.mjs` | `11-operations.md` | 예상 4xx/취소와 운영 오류, catalog 나이와 provider별 `fetched_at` 나이 구분. 공식 상세 알람은 `MonitorOfficialDetails` 조건 | 실습 |
| `AWS::Logs::MetricFilter`. `ProviderFailuresMetric`, `CollectionFailuresMetric`, `CollectionCompletionsMetric` | `infra/data.yaml` | `10-enrichment.md`, `11-operations.md` | 모두 `HasWorker`. 제공처 실패 수, 작업 실패, 완료를 각각 추출. 갱신 0건인 완료도 완료로 집계 | 실습 |
| `AWS::CloudWatch::Alarm`. `ProviderFailuresAlarm`, `CollectionFailuresAlarm`, `CollectionMissingAlarm` | `infra/data.yaml` | `11-operations.md` | 앞의 둘은 `HasWorker`. 완료 누락은 **worker가 있고 일정이 ENABLED인 `HasScheduledWorker`**일 때만 생성; 48개 완료 시간 구간 평가. 통지 ARN 공란은 액션만 끔 | 실습. `INSUFFICIENT_DATA`를 정상으로 처리하지 않음 |
| `AWS::CloudWatch::Alarm`. `CloudFront5xxAlarm` | `infra/edge.yaml` | `11-operations.md` | us-east-1 CloudFront 지표, distribution 차원, `Region=Global`, 정상/오류 액션 확인 | 실습 |
| `AWS::CloudWatch::Dashboard`. `OperationsDashboard`, `EdgeDashboard` | `infra/operations.yaml`, `infra/edge.yaml` | `11-operations.md` | 실제 ALB/ECS/quota/guide/catalog와 CloudFront/WAF/log 유입 지표 확인. 빈 그래프도 원인 확인 | 실습 |
| OpenTelemetry / AWS OTel distro / X-Ray | `agent/guide/pyproject.toml`, `infra/agentcore.yaml`, `agent/guide/atlas_agent/privacy.py`, `agent/tools/atlas_tools/privacy.py`, `scripts/verify-guide-privacy.py` | `06-atlas-agentcore.md`, `11-operations.md`, `12-validation.md` | `opentelemetry-instrument`, 콘텐츠 캡처 비활성, export 전 원문/인자 제거 확인. 관측 구간의 모델, 도구, 토큰 메타데이터와 질문/답변 미노출 확인 | 실습 계측, telemetry 권한. 별도 X-Ray Group, collector, 중앙 Trail 배포 선언 없음 |

## 지도, 라우팅, 데이터, 사용자 화면

| 리소스 / 기술 | 기존 파일, 식별 지점 | 실습 장 | 기대 검증 | 공유 / 실습 소유 |
| --- | --- | --- | --- | --- |
| TypeScript, Vite, Node, npm lock, Docker 다단계 빌드 | `package.json`, `package-lock.json`, `vite.config.ts`, `Dockerfile`, `scripts/check.mjs` | `01-setup.md`, `08-web.md`, `12-validation.md` | 현재 검사기는 Node **24 계열 24.18.1 이상** 요구. 잠금 설치, 타입 검사, 빌드, ARM64 이미지 확인. 프런트 빌드 의존성과 서버 의존성 구분 | 로컬/실습 아티팩트 |
| Codex, Kiro CLI, Claude Code, AgentCore CLI | `workshop/IMPLEMENTATION_PLAN.md` | `01-setup.md`, `03-codex.md`, `04-agentcore-cli.md` | 계획의 `@aws/agentcore` 0.28.1과 실제 설치 버전, 스키마 대조. Codex 작업 인증과 배포 모델 설정 분리. 최종 명령은 해당 장, 실제 도움말에서 확인 | 로컬 도구. 웹 런타임 의존성이 아님 |
| MapLibre GL JS, WebGL, Web Worker, raster/DEM, hillshade | `src/map.ts`, `src/catalog-map.ts`, `src/places.ts`, `package.json` | `08-web.md`, `12-validation.md` | 실제 지형, 위성/고도, 2D/3D, 배율 전환, 대표 명소, 분류별 GPU 장소 레이어/cluster, Worker 파일, WebGL 복구 확인 | 실습 프런트, 외부 SDK 의존성 |
| Terrarium DEM / Mapzen, AWS Terrain Tiles | `src/map.ts`, `infra/application.yaml`, `scripts/verify-terrain-cache.py` | `08-web.md`, `09-https-edge.md` | 로컬은 공개 S3, 배포 브라우저는 같은 CloudFront의 `/terrarium/*` 사용. PNG 바이트, 표고 표본, 출처 표시 확인 | **외부 공개 데이터셋**. 팀 S3/OAC 원본이 아니며 ALB 검증 헤더 미전달 |
| Esri World Imagery | `src/map.ts`의 ArcGIS World_Imagery URL, attribution | `08-web.md`, `12-validation.md` | 실제 브라우저 타일 요청, 출처 표시, 제공처 실패 UI 확인. 교육/공개 배포 조건은 별도 확인 | 외부 서비스. 실시간 영상, 자체 촬영, 무제한 재배포를 주장하지 않음 |
| Valhalla 3.8.3, ARM64, loopback | `Dockerfile.routing`, `routing/runtime.py`, `routing/entrypoint.py`, `routing/healthcheck.py` | `07-routing.md`, `12-validation.md` | pinned 엔진/그래프 호환, `/status`의 tiles/version/actions, `/route`, `/height` 확인. 비루트/read-only/메모리 제한, 시작 시 다운로드 없음, 좌표 로그 미노출 확인 | 실습 이미지. 같은 task의 `127.0.0.1:8002`; 공개 데모 라우터 아님 |
| OSM PBF, Geofabrik, osmium, 그래프/admin SQLite, SHA-256 | `scripts/build-routing-data.py`, `Dockerfile.routing-builder`, `routing/runtime.py` | `05-foundation-and-data.md`, `07-routing.md` | 제한 크기 HTTPS 다운로드, MD5/SHA-256, OSM 시각, 제주 bbox, 동일 엔진 빌드 확인. `valhalla_tiles.tar`, `admin.sqlite`, HGT 필수; `timezones.sqlite`는 있으면 hash 확인 | 외부 OSM 원자료, 실습 빌드 결과. 원자료 ODbL 출처 유지 |
| Skadi HGT 고도 | `scripts/build-routing-data.py`, `routing/runtime.py`, `server/routing.mjs` | `07-routing.md`, `12-validation.md` | `elevation_data/N33/N33E126.hgt` 크기, hash, 출처와 `/height` 표본 확인. 원본 수정일, 다운로드일, OSM 시각을 분리 | 외부 DEM 기반 실습 아티팩트. Terrarium 표시용 PNG와 별도 |
| 웹 경로/고도 BFF, 안내, GPX | `server/routing.mjs`, `server/api.mjs`, `shared/routing-types.ts`, `src/route-client.ts`, `src/routing.ts`, `src/trip.ts` | `07-routing.md`, `08-web.md`, `12-validation.md` | 도보/차량 2~12곳, 200m snap 제한, 제주 좌표, 세션/CSRF, ferry/연결 불가 표시, 거리, 예상 시간, 구간 안내, GPX 확인. 실패를 직선/0분으로 바꾸지 않음 | 실습. AI quota와 별도, actor당 분당 60회는 **프로세스별** 제한 |
| Guide의 `route`/`plan_day`와 선택적 Kakao adapter | `agent/tools/atlas_tools/routing.py`, `agent/tools/atlas_tools/planner.py`, `agent/tools/atlas_tools/external/keys.py`, `infra/agentcore.yaml` | `06-atlas-agentcore.md`, `07-routing.md` | Guide 도구는 Valhalla BFF와 다른 경로. 키 없는 기본 구성의 직선 fallback, `duration_s: null`, 경고 확인. 이를 실제 도로 안내로 승격하지 않음 | 코드 존재. 현재 Atlas 템플릿은 Kakao 키/SSM 접근을 Tools에 주입하지 않음 |
| 3D 명소 탐색, 실제 경로 재생, 거리 측정, 고도 단면 | `src/scenes.ts`, `src/map.ts`, `src/measurement.ts`, `src/elevation-profile.ts` | `08-web.md`, `12-validation.md` | 12개 명소, 회전/위에서/실제 1×, 경로선 재생, 중단, 여러 점 직선 측정, 취소, 초기화 확인. 단면은 화면 배율과 독립; 결측을 0m로 채우지 않음 | 실습 프런트. 표고는 DEM 표본, 이동 시간은 교통 미반영 예상치 |
| 올레길 GeoJSON, 코스 manifest, 카메라 둘러보기 | `public/data/olle-routes.json`, `public/data/olle-*.geojson`, `src/tours.ts`, `src/map.ts` | `08-web.md`, `10-enrichment.md`, `12-validation.md` | 커밋된 manifest의 18개 사용 가능/11개 비활성 항목, 14, 21코스 일부 구간, 분리 geometry, 조회 시각, OSM 수정 시각, ODbL 확인. 선택 시 로드, Escape/지도 조작 중단 | 저장소 배포 자산, 외부 OSM 출처. 현재 공식 전체 GPX라는 주장은 없음 |
| 샘플 카탈로그, 기본 필드 근거, 선택적 OSM 확장 | `agent/tools/data/jeju_pois.json`, `server/catalog.mjs`, `scripts/audit-catalog.mjs`, `shared/api-types.ts` | `05-foundation-and-data.md`, `10-enrichment.md` | 137개 `source: sample` 시드의 ID, 좌표, 출처 유지. 샘플만/OSM 추가 구성별 실제 건수, schema, hash 기록. 과거 운영 6,724곳을 새 설치 기대 건수로 고정하지 않음 | 시드는 저장소 자산, 생성 SQLite는 실습. 운영 비공개 DB를 전제하지 않음 |
| TourAPI, VisitJeju, requests/boto3 수집, 파싱, 매칭 | `scripts/fetch-place-details.py`, `scripts/place_detail_sources.py`, `server/official-details.mjs`, `agent/tools/atlas_tools/official_details.py` | `10-enrichment.md`, `12-validation.md` | 제공처, 원문/언어, `fetched_at`, 유일한 이름/카테고리/거리 매칭, 기본 ID/좌표 보존, 실패 시 정상본 유지 확인. 한영 자료가 없는 항목은 원문 언어 표시 | 제공처는 외부, 수집 snapshot은 실습. 키 유효성은 이용 허가/전체 필드 검증과 다름 |
| 사진 권리 필터, 원본 바이트 미러, 필드별 evidence | `scripts/place_detail_sources.py`, `scripts/fetch-place-details.py`, `server/catalog.mjs`, `src/field-evidence.ts`, `docs/data-quality.md` | `10-enrichment.md`, `12-validation.md` | 사진별 license/credit/origin URL, 허용 목록, KOGL-3 썸네일 미생성 확인. KOGL-2/4, NC, 불명확 사진 차단. VisitJeju API 사진은 별도 권리 근거 없이 자동 게시하지 않음 | 실습 필터/미러, 권리는 제공처 조건. `source_reported`/`parsed`/`unverified`를 `reviewed`로 바꾸지 않음 |
| 날씨, 일출 계산, 선택적 snapshot 도구 | `server/weather.mjs`, `agent/tools/atlas_tools/weather.py`, `agent/tools/atlas_tools/sun.py`, `agent/tools/atlas_tools/layers.py`, `agent/tools/atlas_tools/festivals.py`, `agent/tools/atlas_tools/snapshots.py` | `06-atlas-agentcore.md`, `08-web.md`, `10-enrichment.md` | 웹 Open-Meteo 현재/3일 예보, Tools의 KMA 선택 경로/Open-Meteo fallback, httpx, astral 계산, 출처/시각 확인. layer/festivals snapshot 없으면 `no_data`/stale 확인 | 외부 서비스, 로컬 계산. 현 수집 Scheduler가 주차/EV/도로/축제 feed까지 생성한다고 주장하지 않음 |
| 선택적 제공처/키 해석 코드 | `agent/tools/atlas_tools/external/`, `agent/tools/README.md`, `infra/agentcore.yaml` | `06-atlas-agentcore.md`, `10-enrichment.md` | Kakao, KMA, JejuHub adapter 및 NAVER/ITS/EV 키 이름의 존재와 실제 설정, IAM, 호출 연결을 구분. 이름만으로 활성 통합을 추가하지 않음 | 선택 코드. 현재 배포의 제공처 키는 별도 수집 작업 경계 |
| 검색, 장소 상세, 근거, 여행 저장/공유 | `src/catalog-ui.ts`, `src/catalog-map.ts`, `src/explore.ts`, `src/trip.ts`, `src/saved-data.ts`, `src/saved-data-ui.ts` | `08-web.md`, `12-validation.md` | 분류/주변 검색, 사진/정보 제공처 탭, 출발/도착, 체류/순서, 즐겨찾기, URL fragment 공유, 백업 검토 후 복원, 삭제, 저장 실패, 탭 충돌 확인 | 브라우저 로컬 자료. 기기 삭제와 서버 Memory 정리는 별개 |
| 한영 UI, 모바일, 키보드, reduced motion | `src/i18n.ts`, `src/locales/en.ts`, `src/main.ts`, `src/guide.ts`, `src/scenes.ts`, `src/style.css` | `08-web.md`, `12-validation.md` | 언어 선택 기억, 문서 언어, 요청 locale, 영문 원문 fallback, 모바일 서랍, focus, Escape, 동작 감소, 탭 비활성/그래픽 손실 시 재생 중단 확인 | 실습 프런트/브라우저 |
| AI 상태, 실제 도구 표시, 안전한 GFM, 추천 질문 | `src/guide.ts`, `src/guide-stream.ts`, `src/guide-request.ts`, `src/guide-markdown.ts`, `src/guide-context.ts`, `server/guide-grounding.mjs` | `08-web.md`, `12-validation.md` | SSE 상태/텍스트/지도/done/error, 취소, 제한된 세션 복구, 출처/미확인 시설 구분. unified/remark/rehype의 HTML, 이미지, URL 방어와 시간 범위 `~` 표시 확인. 추천 질문 선택만으로 모델 호출하지 않음 | 실습 UI/BFF. 제어된 SSE 검사는 실제 모델 검증과 별도 |
| NanumSquare, 로컬 Twemoji SVG | `public/fonts/README.md`, `public/fonts/OFL-NanumSquare.txt`, `public/emoji/README.md`, `public/emoji/LICENSE-GRAPHICS.txt`, `src/guide-emoji.ts`, `index.html` | `01-setup.md`, `08-web.md`, `12-validation.md` | NanumSquare 원본 Regular/Bold WOFF와 preload, 로컬 제공, OFL 고지, 고정 UI SVG, CC BY 고지 확인. 임의 Markdown 외부 이미지와 구분 | 저장소 자산. 글꼴, 그래픽별 라이선스 유지 |
| PWA, Service Worker, Cache API, manifest | `src/pwa.ts`, `scripts/build-pwa.mjs`, `public/manifest.webmanifest` | `08-web.md`, `12-validation.md` | 앱 셸 revision, 설치, 저장 코스 오프라인 표시, 여러 탭/진행 작업 중 업데이트 보호 확인. API, 지도 타일, 외부 사진 사전 캐시 없음 | 브라우저 로컬 자원. 오프라인 지도, AI, 도로 계산 보장 없음 |
| 출처 manifest, 로컬 회귀, 스키마 검사 | `agent/source-provenance.json`, `tests/`, `scripts/check.mjs`, `infra/schemas/agentcore/README.md`, `infra/schemas/agentcore/*.json` | `03-codex.md`, `12-validation.md` | 현재 소스/잠금/배포물과 증거 연결. cfn-lint에 저장된 네 AgentCore schema 적용. 실제 실행/실패/skip와 모델 호출 유무 기록 | 로컬 검증. 출처 hash와 AWS 배포 성공은 별개 |

## 조건과 제외 범위

`HasDetails`는 상세 버킷 이름, `HasSharedAssets`는 자산 버킷 도메인, `RoutingEnabled`는 라우팅 이미지 URI의 존재를 검사한다. 해당 값이 채워졌다는 사실만으로 객체, 그래프, OAC 권한이 검증되지는 않는다. `HasWebAcl`과 `HasViewerDomain`은 distribution 속성 연결 조건이다. `HasOriginCertificate`는 TLS listener 준비이며 `UseOriginTls` 전환 완료와 다르다.

소스 범위에 다음 배포를 추가하지 않는다.

- **AgentCore Browser, Code Interpreter, Bedrock Knowledge Bases, online evaluations**: 이 YAML과 실행 연결에 생성 근거 없음. 브라우저 회귀 테스트는 AgentCore Browser가 아니며, Memory 검색도 Knowledge Base 배포가 아니다.
- **GuardDuty 배포**: ECS 실행 역할의 AWS 관리 sidecar 저장소 읽기 grant와 과거 계정 관측만 있다. `AWS::GuardDuty::*` 선언은 없다. 계정에서 자동 삽입된다면 리허설 때 실제 동작, 추가 용량을 확인하며 임의로 켜거나 끄지 않는다.
- **Inspector 활성화 완료**: ECR `ScanOnPush`만으로 계정 enhanced scanning/지속 검사 활성화를 입증하지 않는다. 과거 “발견 0건”은 새 이미지 결과가 아니다.
- **API Gateway, Route 53 hosted zone/record, NAT/VPC endpoint, RDS, OpenSearch, Kinesis/Firehose, 별도 KMS key, AWS Budgets**: 이 템플릿들의 생성 리소스가 아니다. 지원 기능이나 ARN 이름으로 추측하지 않는다.
- **AgentCore API-key/OAuth credential provider**: Gateway target의 `GATEWAY_IAM_ROLE`과 구분한다. 관광정보 키는 수집 작업의 SSM 경계, 선택한 카카오 REST 키는 웹 ECS의 비밀 주입 경계에 있으며 AgentCore credential provider를 생성하지 않는다.

`scripts/check.mjs`는 Node/Python 회귀, cfn-lint, npm audit, 앱 빌드를 실행한다. npm audit는 패키지 registry 통신이 필요하고 결과/빌드 파일을 작성하므로 “완전 오프라인, 읽기 전용”이라고 부르지 않는다. `scripts/verify.py`와 live 브라우저, 개인정보, 복구 도구는 별도의 클라우드/네트워크 검사다. 교재 작성 중의 소스 검토만으로 이 검사들이 통과했다고 표시하지 않는다.
