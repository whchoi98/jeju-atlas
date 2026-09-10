# 실제 AgentCore 구성

2026-09-10 서울 리전 `AgentCore-Ohmyjeju-default`의 현재 구성입니다.
**Agent 버전 22, Tools 버전 12가 배포되어 READY**입니다.
관측 콘텐츠 제거 후 실제 Astra 영어 요청도 확인했습니다. 전체 배포 범위와
남은 운영 항목은 [최신 운영 검증](commercial-completion-audit-2026-09-10.md),
웹 이미지·태스크는 [배포 현황](deployment.md)을 기준으로 합니다.

| 구성 | 실제 구현 |
|---|---|
| Agent Runtime | `Ohmyjeju_OhmyjejuAgent` — 버전 22, READY; HTTP, Python, Strands Agent, SSE 답변 |
| Tools Runtime | `Ohmyjeju_OhmyjejuTools` — 버전 12, READY; MCP 서버, 정확한 이름 우선 검색과 Atlas 공식 상세 S3 읽기 |
| Gateway | `OhmyjejuGateway`와 Tools Runtime 대상 1개 |
| Memory | `Ohmyjeju_OhmyjejuAgentMemory`, ACTIVE |
| 인증 | Fargate의 Runtime 호출과 Agent의 Gateway 호출에 AWS IAM 사용 |
| 관측 | 질문·답변 콘텐츠를 제거한 Runtime 메타데이터, Fargate 진단 로그·CloudWatch 알람 |

Strands는 AgentCore 안에서 도구 호출과 대화를 실행하는 개발 프레임워크입니다.
모델 선택, 도구 사용, 대화/메모리 연결과 스트리밍 처리에 실제로 사용됩니다.

```text
브라우저의 한영 선택
  → CloudFront → HTTPS / Public ALB
  → Private ECS Fargate (서명 세션·공통 사용량 제한)
  → AgentCore HTTP Runtime (Strands)
      → 서울 Bedrock Global CRIS
          일반 질문: global.openai.gpt-5.6-sol
          일정 계획: global.openai.gpt-6-astra
      → AgentCore Gateway → MCP Tools Runtime
          → 기존 카탈로그 조회
          → Atlas S3 place-details/latest.json (읽기 전용)
      → AgentCore Memory
```

도구 8개는 `find_places`, `place_detail`, `route`, `weather`, `sun_times`,
`layer`, `festivals`, `plan_day`입니다. `layer`가 주차·충전·도로 상태를 다룹니다.

장소 자체의 정보는 정확한 이름을 우선해 검색한 후 `place_detail`로 읽습니다.
‘성산일출봉, 제한 3개’ 검색에서 상업시설 이름이 명소를 밀어내던 문제를
실제 카탈로그로 재현하고 수정했습니다. 카테고리·반경 조건과 근처 검색에서
기준 장소를 제외하는 동작은 유지합니다.

## 공식 상세와 제공처 키의 경계

Tools와 웹 태스크는 Atlas 전용 비공개 S3의
`place-details/latest.json`을 `s3:GetObject`로 읽습니다. 제공처·언어·조회 시각과
출처를 유지해 상세 정보에 합치며, 카탈로그 기본 ID·이름·좌표를 덮어쓰거나
공식 기록이 붙었다는 이유만으로 시드 정보를 검증 완료로 승격하지 않습니다.

TourAPI·VisitJeju API 키는 SSM SecureString에 보관하며, **전용 데이터 수집
태스크 역할만 읽습니다.** 웹·Agent·Tools에는 제공처 키 읽기 권한을 주지
않고, **AgentCore API-key/OAuth Credential Provider로 등록하지 않았습니다.**
수집 작업이 제공처를 조회해 스냅샷을 발행하고, 웹·Tools는 발행된 자료를 읽습니다.
키 값은 브라우저 응답·소스·로그에 포함하지 않습니다.

상업 이용이 허용된 `media/` 객체만 CloudFront S3 OAC로 제공합니다.
사진 이용조건·언어별 상세·수집 갱신 정책은
[공식 장소 상세와 올레길](official-details-olle.md)을 참고합니다.

## 관측 로그와 개인정보

Agent 22·Tools 12에는 모델·도구 관측 필드에 질문·답변 콘텐츠를 싣지 않도록 한
수정이 배포됐습니다. 2026-09-10 20:27 UTC에 시작한 실제 **Astra 영어 일정 요청은
53.433초**에 완료됐습니다. 검사 시간대의 관측 이벤트 2,275건에서 입력 표식,
질문, 답변 일부가 검출되지 않았으며 **모델·도구 이름과 토큰 수는 남아 있습니다.**
이는 해당 요청·시간 구간의 검사 결과이며 모든 과거 로그의 삭제를 확인한 것은 아닙니다.
[실제 개인정보 관측 검사](../.local/guide-privacy-live.json)

다음 두 CloudWatch Runtime 로그 그룹에 **14일 보관**을 적용했습니다.

- `/aws/bedrock-agentcore/runtimes/Ohmyjeju_OhmyjejuAgent-7fiRWV5uVi-DEFAULT`
- `/aws/bedrock-agentcore/runtimes/Ohmyjeju_OhmyjejuTools-BzugIP8Xga-DEFAULT`

근거: [보관 기간 적용 결과](../.local/runtime-log-retention-applied.json).
이 보관 정책은 아래 AgentCore Memory의 단기 이벤트·장기 기억과 구분합니다.

## 대화 기억과 보관

Memory 전략 4개가 모두 ACTIVE입니다.

- `SEMANTIC`: 사용자와 관련된 사실
- `USER_PREFERENCE`: 사용자 선호
- `SUMMARIZATION`: 대화 요약
- `EPISODIC`: 이전 경험과 맥락

단기 이벤트의 `eventExpiryDuration`은 **30일**입니다. 이 값만으로 추출된
장기 기억까지 모두 30일 후 삭제된다고 해석하지 않습니다. 브라우저의 저장 자료
삭제 기능도 서버의 Memory 삭제와 별개입니다.

별도 AgentCore Browser·Code Interpreter·Policy Engine·Evaluator 리소스는
현재 확인한 스택에 없습니다. OAuth/API-key Credential Provider를 별도로
연결한 구성도 아닙니다.

버전 확인 자료: [런타임 상태](../.local/guide-model-status.json).
Memory·Gateway 구성 자료: [AgentCore 구성](../.local/agentcore-components.json).
