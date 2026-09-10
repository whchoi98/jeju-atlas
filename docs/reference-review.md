# AgentCore 참고 프로젝트 검토

확인일: 2026-09-10. 제주 아틀라스 기준 커밋: `84be279`.

사용자가 지정한 `../agentcore-cli`는 `product-01-contracts-bff` 브랜치의
`5aefdbd`입니다. 최신 서비스 구현은 같은 저장소의 `../agentcore-cli-main`
작업 폴더, `main`의 `9e42038`에서 확인했습니다. 카탈로그 원본을 보존합니다.
이후 사용자가 요청한 모델 변경은 `../agentcore-cli-astra-sol`의 별도 작업
브랜치에서 구현하고, 기존 Agent 런타임의 모델 코드·설정에 한정해 배포합니다.

## 적용 판단

| 참고 코드 | 확인한 내용 | 제주 아틀라스 적용 판단 |
|---|---|---|
| `product/web/routes_chat.py`, `sessions.py`, `auth.py` | 서버가 서명한 사용자·대화 식별, 스트리밍 호출 계약 | 이미 연계한 기존 AgentCore와 서명 세션을 유지합니다. 만료 복구는 모델 호출 전 거절된 경우에만 한 번 허용합니다. |
| `product/agent/Ohmyjeju/app/OhmyjejuAgent/ohmyjeju_agent/tool_budget.py` | 에이전트 도구 호출 예산 | 도구 사용 상태는 실제 이벤트로 표시합니다. 공유 런타임 설정을 아틀라스 배포에서 임의로 바꾸지 않습니다. |
| `product/web/frontend/src/lib/markdown.ts`, `ui/chat.ts`, `api/chat.ts` | 마크다운, 도구 상태, 대화 흐름 | 이미 구현한 안전한 마크다운·이모지·생각중·추천 질문을 유지하고 오류·취소·만료 회귀 검사를 재사용합니다. |
| `product/web/ratelimit.py` | DynamoDB의 사용자별·전체 사용량 카운터 | 여러 Fargate 태스크에서 한도를 공유하는 구조를 가져옵니다. 아틀라스에는 원자적 입장 처리와 만료되는 동시 실행 잠금도 필요합니다. |
| `product/infra/lib/ohmyjeju-waf-stack.ts` | CloudFront용 WAF, 요청 빈도 제한, 관리형 규칙 | 아틀라스 전용 WebACL로 적용합니다. 지도 타일 요청이 사용자 API 제한에 섞이지 않도록 범위를 제한합니다. |
| `product/infra/lib/service-alarms.ts` | ALB 오류, 비정상 대상, CPU 알람과 SNS | 전용 알람·대시보드로 적용합니다. 구독자가 없는 SNS는 알림 전달이 검증된 것으로 취급하지 않습니다. |
| `product/infra/lib/stage.ts` | 운영 태스크 최소 2개, CPU 자동 확장, 데이터 보호 | 이중화와 확장 상한을 가져옵니다. Python 워커 4개·2 vCPU·4 GiB 설정은 Node 서버에 그대로 복사하지 않고 부하 측정으로 결정합니다. |
| `product/infra/lib/edge-policies.ts` | 정적 자산·HTML·사진의 다른 캐시 정책 | 기존 고도 타일 캐시와 개인정보가 섞이지 않는 API 정책을 보존합니다. HTML·서비스 워커 갱신도 검사합니다. |
| `product/infra/lib/canonical-host-function.js` | 사용자 도메인으로 페이지 이동 | 참고 앱의 Kakao 등록 도메인 제약을 위한 코드입니다. MapLibre 앱에는 같은 강제 리다이렉트가 필수는 아닙니다. 현재 두 주소에서 정상 동작하는 구성을 유지합니다. |
| `product/data/runner_enrich.py`, `product/data/README.md` | 공개 데이터 보강, 스냅샷 갱신과 출처 | 기존 S3 읽기 연계를 유지합니다. 상업 이용 가능한 사진, 필드별 확인 여부, 갱신 지연을 별도로 검증합니다. |
| `scripts/product-load-test.py` | 동일 조건의 병렬 요청과 지연 측정 | 아틀라스 API에 맞는 모델 호출 없는 부하 검사로 가져옵니다. 측정한 환경과 요청 수를 결과에 남깁니다. |

## 그대로 가져오면 안 되는 항목

- 워크숍용 `data/jeju_pois.json`의 137건은 공식 검증된 기본 정보로 승격하지 않습니다.
  보강된 사진·이용시간·인허가 정보와 원래 이름·좌표·주소·소개는 출처가 다릅니다.
- 참고 코드의 사진 허용 목록에는 상업 이용을 제한하는 라이선스도 포함되어 있습니다.
  출처 표기만으로 상업 이용 조건을 충족했다고 판단하지 않습니다.
- 참고 서비스의 예산·호출 한도·태스크 크기는 아틀라스의 승인된 운영 예산이 아닙니다.
- 참고 배포 문서에 설명된 placeholder 이미지 전환 방식은 가져오지 않습니다.
  아틀라스는 CloudFormation에서도 검증한 실제 이미지 digest를 유지합니다.
- Kakao 키, 참고 서비스 세션 키, `.env*`, 자격 증명 파일은 가져오지 않습니다.
  AWS 역할은 지정 카탈로그 읽기와 지정 런타임 호출에만 사용합니다.

## 현재 운영 설정에서 발견한 차이

`jeju-atlas.whchoi.net`과 기존 CloudFront 주소는 모두 정상 HTTP 응답을
반환했습니다. 사용자 도메인과 us-east-1 ACM 인증서는 실제 CloudFront에는
등록되어 있지만 아틀라스 배포 템플릿에는 없었습니다. 다음 배포에서 이를
누락하지 않도록 명시적인 배포 매개변수로 관리해야 합니다.

현재 계정의 `whchoi.net` Hosted Zone은 공개 DNS에 위임된 Zone과 다릅니다.
CloudFront에서 ALB까지 TLS를 추가할 때는 실제 DNS 관리 위치를 확인해야 하며,
이 계정의 같은 이름 Zone에 레코드를 추가한 것만으로 설정이 끝났다고
판단해서는 안 됩니다.

상용 운영 보강의 완료 기준과 남은 의존성은
[상용 운영 설계](superpowers/specs/2026-09-10-commercial-readiness.md)에 기록합니다.

## 추가 요청: Global CRIS와 언어 선택

서울 계정에서 `global.openai.gpt-5.6-sol`과 `global.openai.gpt-6-astra`가
모두 ACTIVE임을 확인했습니다. 두 모델의 도구 호출을 실제로 검사했으며,
기존 Strands Bedrock 모델을 유지할 수 있습니다. `reasoning.effort`는
동작하고 `reasoning_effort`는 이 Converse 경로에서 거부되었습니다.

가이드 Fargate는 모델을 직접 실행하지 않고 기존 AgentCore로 중계합니다.
해당 런타임을 Sol/Astra로 전환하면 아틀라스의 Fargate 경로에도 적용됩니다.
참고 프로젝트의 `payload.prompt_for_locale`과 시스템 프롬프트는 이미
한국어/영어 계약을 갖고 있으므로, 아틀라스 토글에서 `locale`을 전달해
이 계약을 재사용합니다.
