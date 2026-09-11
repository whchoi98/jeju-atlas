# 제주 전용 AgentCore 구성

2026-09-11 **`Jeju3dAgentCore`가 `CREATE_COMPLETE`**이며 전용 Guide·Tools의 실제 호출을
검증했습니다. **공개 ECS `jeju-3d:12`가 전용 Guide·카탈로그·라우터로 전환됐습니다.**
`Jeju3dApp` `UPDATE_COMPLETE`, PRIMARY `COMPLETED`, 정상 태스크 2개와
독립성 검사 24개 통과를 [최신 배포 기록](mobility-independence-2026-09-11.md)에 남겼습니다.
공개 브라우저·공개 AI 개인정보 최종 결과는 별도로 추가합니다.

## 전용 리소스

| 구성 | 실제 식별자·역할 |
|---|---|
| Guide Runtime | `JejuAtlas_Guide-2sFw9YBI8V` — 버전 1 READY; Python·Strands·HTTP·SSE |
| Tools Runtime | `JejuAtlas_Tools-Nh0YFIFC7c` — 버전 1 READY; MCP 도구 |
| HTTP Gateway | `jeju-atlas-tools-ddvut90uxw` |
| Gateway 대상 | `JejuAtlasTools`; `/JejuAtlasTools/invocations` |
| Memory | `JejuAtlas_Memory-xH3L1d4DjN`; 4개 전략 ACTIVE |
| 코드·의존성·카탈로그 버킷 | `jeju-3d-data-061525506239-ap-northeast-2` |
| 인증 | 웹→Guide와 Guide→Gateway 모두 IAM; 대상 호출은 Gateway IAM 역할 |

[완료된 스택 출력](../.local/atlas-agent-outputs.json).
Gateway는 HTTP Runtime 대상 구성입니다. 새 MCP 클라이언트는 대상 이름이 들어간
`/JejuAtlasTools/invocations`에 연결하며 집계형 `/mcp` 엔드포인트를 사용하지 않습니다.

```text
현재 공개 웹 연결:
브라우저 → CloudFront → HTTPS ALB → Private ECS Fargate
  → IAM → JejuAtlas_Guide (Strands)
      → 서울 Global CRIS: 일반 질문 Sol / 일정 계획 Astra
      → IAM → 전용 HTTP Gateway /JejuAtlasTools/invocations
          → JejuAtlas_Tools → 전용 카탈로그·공식 상세 S3 읽기
      → JejuAtlas_Memory
```

모델 설정은 일반 질문 `global.openai.gpt-5.6-sol`, 일정 계획
`global.openai.gpt-6-astra`입니다. Strands가 도구 사용·메모리·스트리밍을 실행합니다.
도구는 `find_places`, `place_detail`, `route`, `weather`, `sun_times`, `layer`,
`festivals`, `plan_day`이며, 경로 BFF의 Valhalla 도보/차량 계산은 별도 구성입니다.

## 소스와 아티팩트 소유권

`agent/guide/`와 `agent/tools/`는 이 저장소의 일반 소스 디렉터리입니다.
초기 복사는 검증 커밋 `9d4ae864369eb62fddfb9b346d6e25722c946aa1`의 읽기 전용 자료에서
수행했고 [출처 manifest](../agent/source-provenance.json)에 기록했습니다.
빌드·배포·실행 중 참조 디렉터리의 파일·환경·Runtime을 가져오는 방식은 사용하지 않습니다.

[의존성 manifest](../agent/dependency-artifacts.json)는 전용 버킷에 저장한 Python 의존성
아카이브의 객체 버전·SHA-256을 고정합니다. 이후 빌드는 이 소유 사본과 로컬 소스만
결합합니다. 새 실행 역할·Gateway·Memory·로그·배포 아티팩트를 사용하며,
이 독립화 작업에서 기존 공유 스택·메모리·역할·코드를 추가 변경하지 않았습니다.

전용 카탈로그 키는 `catalog/catalog.sqlite`입니다. 초기 복사는 6,724곳과 원본 hash를
유지했습니다. OpenStreetMap 6,587곳과 시드 137곳의 근거 수준은 그대로이며,
복사가 기본 좌표·주소·소개를 공식 검증값으로 바꾸지는 않습니다.
[카탈로그 복사 확인](../.local/independence/catalog-import-applied.json)

## 공식 상세와 제공처 키

Tools는 전용 버킷의 `place-details/latest.json`을 읽습니다. 제공처·언어·조회 시각을
보존하고, 기본 ID·좌표를 바꾸거나 연결된 기록 전체를 검증 완료로 승격하지 않습니다.
웹 task 12와 수집 작업 `jeju-3d-data:4`도 같은 소유 카탈로그를 사용합니다.
[실제 연결과 IAM 감사](../.local/independence/final-aws-audit.json)의 검사 대상 역할 4개에
참조 프로젝트 리소스 grant가 없음을 확인했습니다.

TourAPI·VisitJeju 키는 별도 수집 태스크의 SSM 권한 경계에 남습니다.
웹·Guide·Tools 아카이브에 키를 포함하지 않으며 AgentCore API-key/OAuth Credential
Provider로 등록하지 않았습니다. 허용된 사진만 기존 CloudFront S3 OAC로 제공합니다.
[공식 상세·사진 이용조건](official-details-olle.md)

## 관측 로그와 개인정보

전용 Guide의 실제 한국어 호출은 **17.553초**, 영어 호출은 **25.434초**에 오류 없이
SSE `done`으로 끝났습니다. 별도의 공개 웹 AI 요청도 26.651초에 완료했습니다.
[공개 AI 검사](../.local/guide-privacy-live.json)는 로그·트레이스 1,066건에서
질문·답변 유출이 없고 모델·도구·토큰 메타데이터가 유지됨을 확인했습니다.

검사 구간의 로그·트레이스 **8,260건**에서 입력 표식·질문·답변 유출은 검출되지 않았습니다.
**Sol/Astra 모델·도구 이름·토큰 메타데이터는 유지됩니다.**
[관측 검사](../.local/independence/native-telemetry-verification.json)

Runtime 서비스가 자동 생성한 다음 두 로그 그룹에 **14일 보관**을 적용했습니다.
CloudFormation에 같은 로그 그룹을 중복 선언하지 않습니다.

- `/aws/bedrock-agentcore/runtimes/JejuAtlas_Guide-2sFw9YBI8V-DEFAULT`
- `/aws/bedrock-agentcore/runtimes/JejuAtlas_Tools-Nh0YFIFC7c-DEFAULT`

`configure-logs`는 완료된 스택의 Runtime·아티팩트·역할 소유권을 확인하고 이 두 그룹만
처리합니다. [보관 적용 결과](../.local/atlas-agent-log-retention.json).
이 검사는 해당 관측 구간에 한하며 과거 로그 전체 삭제나 미래 요청의 무유출 보장을 뜻하지 않습니다.

## Memory와 배포 명령

`SEMANTIC`, `USER_PREFERENCE`, `SUMMARIZATION`, `EPISODIC` 전략 4개가 ACTIVE입니다.
단기 이벤트의 `eventExpiryDuration`은 **30일**입니다. 이 값만으로 추출된 장기 기억이
모두 30일 후 삭제된다고 해석하지 않습니다. 기존 공유 Memory는 가져오지 않았으며,
브라우저의 기기 자료 삭제도 서버 Memory 삭제와 별개입니다.

```bash
python3 scripts/deploy-atlas-agent.py build
python3 scripts/deploy-atlas-agent.py publish
python3 scripts/deploy-atlas-agent.py plan
# 생성된 변경 집합 검토 후
python3 scripts/deploy-atlas-agent.py apply
python3 scripts/deploy-atlas-agent.py status
python3 scripts/deploy-atlas-agent.py configure-logs
```

기존 `scripts/deploy-guide-models.py` CLI는 폐기됐고 AWS 연결 전에 중단합니다.
상세 절차는 [agent/README.md](../agent/README.md)를 참고합니다.

## 이전 공유 구성의 위치

`AgentCore-Ohmyjeju-default`의 Agent 22·Tools 12와 `OhmyjejuGateway`는
[2026-09-10 기록](commercial-completion-audit-2026-09-10.md)의 공유 구성입니다.
전환 전 task 11이 사용하던 구성이며 현재 task 12의 호출 대상이 아닙니다.
기존 공유 스택·소스는 추가 변경하지 않았습니다. 첫 전용 Core의 로그 중복 생성과
앱 Rules 오류에 따른 자동 롤백·재시도는
[실패 시도 이력](mobility-independence-2026-09-11.md#실패-시도와-복구-이력)에 별도로 보존합니다.
