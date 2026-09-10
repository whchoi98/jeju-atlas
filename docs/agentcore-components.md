# 실제 AgentCore 구성

2026-09-10 서울 리전의 `AgentCore-Ohmyjeju-default` 스택과 서비스 API에서 확인했습니다.

| 구성 | 실제 구현 |
|---|---|
| Agent Runtime | `Ohmyjeju_OhmyjejuAgent` — HTTP, Python, Strands Agent, SSE 답변 |
| Tools Runtime | `Ohmyjeju_OhmyjejuTools` — MCP 서버 |
| Gateway | `OhmyjejuGateway`와 Tools Runtime 대상 1개 |
| Memory | `Ohmyjeju_OhmyjejuAgentMemory`, ACTIVE |
| 인증 | Fargate의 Runtime 호출과 Agent의 Gateway 호출에 AWS IAM 사용 |
| 관측 | Runtime 실행 로그·도구/응답 이벤트, Fargate 진단 로그·CloudWatch 알람 |

Strands는 AgentCore 안에서 도구 호출과 대화를 실행하는 개발 프레임워크입니다.
모델 선택, 도구 사용, 대화/메모리 연결과 스트리밍 처리에 실제로 사용됩니다.

```text
브라우저의 한영 선택
  → CloudFront / Public ALB
  → Private ECS Fargate (서명 세션·공통 사용량 제한)
  → AgentCore HTTP Runtime (Strands)
      → 서울 Bedrock Global CRIS
          일반 질문: global.openai.gpt-5.6-sol
          일정 계획: global.openai.gpt-6-astra
      → AgentCore Gateway → MCP Tools Runtime
      → AgentCore Memory
```

도구 8개는 `find_places`, `place_detail`, `route`, `weather`, `sun_times`,
`layer`, `festivals`, `plan_day`입니다. `layer`가 주차·충전·도로 상태를 다룹니다.

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

배포 확인 자료: `.local/agentcore-components.json`,
`.local/guide-model-status.json`.
