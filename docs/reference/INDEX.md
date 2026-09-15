# Implementation reference / 구현 참조

<a href="#english">English</a> · <a href="#korean">한국어</a>

<a id="english"></a>
## English

### Overview

Use this index to connect implementation layers to their existing guides.
Start with [architecture](../architecture.md) and [local onboarding](../onboarding.md).
Most existing implementation guides are in Korean; their code pointers and
commands apply to both language versions of the application.

### Components

| Layer | Code pointers | Guide |
|---|---|---|
| Browser and map | [main.ts](../../src/main.ts), [map.ts](../../src/map.ts), [Vite config](../../vite.config.ts) | [Architecture](../architecture.md) |
| HTTP, sessions, and contracts | [server.mjs](../../server/server.mjs), [api.mjs](../../server/api.mjs), [shared types](../../shared/api-types.ts) | [API reference](../api-reference.md) |
| Catalog and visitor evidence | [catalog.mjs](../../server/catalog.mjs), [official-details.mjs](../../server/official-details.mjs), [sample generator](../../workshop/scripts/catalog_seed.py) | [Data quality](../data-quality.md), [official details](../official-details-olle.md) |
| Kakao discovery | [discovery.mjs](../../server/discovery.mjs), [kakao.mjs](../../server/kakao.mjs), [selection contracts](../../shared/kakao-discovery-types.ts) | [API reference](../api-reference.md), [discovery release record](../kakao-discovery-release-2026-09-12.md) |
| Guide and MCP Tools | [guide.mjs](../../server/guide.mjs), [Guide entrypoint](../../agent/guide/main.py), [Tools entrypoint](../../agent/tools/main.py) | [Agent sources](../../agent/README.md), [AgentCore components](../agentcore-components.md) |
| Road routing | [routing.mjs](../../server/routing.mjs), [runtime.py](../../routing/runtime.py), [routing contracts](../../shared/routing-types.ts) | [Valhalla runtime](../../routing/README.md) |
| Browser persistence | [saved-data.ts](../../src/saved-data.ts), [browsing-history.ts](../../src/browsing-history.ts) | [Map experience design](../superpowers/specs/2026-09-12-kakao-map-experience.md) |
| Request coordination and presence | [admission.mjs](../../server/admission.mjs), [presence.mjs](../../server/presence.mjs) | [AI limits and presence record](../ai-presence-release-2026-09-12.md) |
| Deployment and recovery | [deploy.py](../../scripts/deploy.py), [application.yaml](../../infra/application.yaml), [rollback-release.py](../../scripts/rollback-release.py) | [Deploy](../runbooks/deploy.md), [rollback](../runbooks/rollback.md) |
| Workshop and PWA packaging | [course.json](../../workshop/course.json), [reader builder](../../workshop/scripts/build.mjs), [public packager](../../scripts/build-workshop-public.mjs), [app PWA builder](../../scripts/build-pwa.mjs) | [Workshop](../../workshop/README.md), [offline handbook](../../workshop/reference/offline-start.md) |
| Core participant setup | [source/session checker](../../workshop/scripts/core.py), [private tool installer](../../workshop/scripts/install_core.sh) | [Chapter 01](../../workshop/chapters/01-setup.md), [source transfer and facilitator setup](../../workshop/reference/facilitator.md) |
| Workshop Sonnet verification | [model configuration](../../workshop/scripts/model_config.py), [explicit real-model check](../../workshop/scripts/model_check.py) | [Account and caller region](../../workshop/chapters/02-aws-environment.md), [official references](../../workshop/reference/official-guide-review.md) |
| Workshop CloudFront access | [owned URL helper](../../workshop/scripts/lab_cloudfront.py), [participant copy adapter](../../workshop/scripts/lab_workspace.py) | [Default HTTPS and edge](../../workshop/chapters/09-https-edge.md) |

### Key decisions

Design records already live in [specs](../superpowers/specs/) and
[implementation plans](../superpowers/plans/). They describe the intended design;
the current code establishes the implemented behavior. In particular:

- [Origin HTTPS](../superpowers/specs/2026-09-10-origin-https.md) records the
  CloudFront-to-origin boundary.
- [Mobility and 3D](../superpowers/specs/2026-09-10-mobility-3d.md) covers the
  road-routing and map interaction design.
- [AI limits and presence](../superpowers/specs/2026-09-12-unlimited-ai-presence.md)
  separates usage-cap configuration from request coordination.
- [Map experience](../superpowers/specs/2026-09-12-kakao-map-experience.md) covers
  search, saved places, and trip endpoints.

Dated release and audit documents retain their original observations. They are
not a substitute for checking current deployments or provider data.

### Cross-references

[Documentation index](../README.md) · [Repository guidance](../../AGENTS.md) ·
[Contributing](../../CONTRIBUTING.md) · [Repository history](../repository.md)

<a id="korean"></a>
## 한국어

### 개요

구현 계층과 기존 안내 문서를 연결하는 색인입니다.
[아키텍처](../architecture.md)와 [로컬 온보딩](../onboarding.md)부터 읽습니다.
기존 구현 안내는 대부분 한국어이며, 코드 위치와 명령은 앱의 두 언어 버전에
동일하게 적용됩니다.

### 구성 요소

| 계층 | 코드 위치 | 안내 |
|---|---|---|
| 브라우저와 지도 | [main.ts](../../src/main.ts), [map.ts](../../src/map.ts), [Vite 설정](../../vite.config.ts) | [아키텍처](../architecture.md) |
| HTTP, 세션과 계약 | [server.mjs](../../server/server.mjs), [api.mjs](../../server/api.mjs), [공유 타입](../../shared/api-types.ts) | [API 안내](../api-reference.md) |
| 카탈로그와 방문 정보 근거 | [catalog.mjs](../../server/catalog.mjs), [official-details.mjs](../../server/official-details.mjs), [시드 생성기](../../workshop/scripts/catalog_seed.py) | [데이터 품질](../data-quality.md), [공식 상세](../official-details-olle.md) |
| 카카오 검색 | [discovery.mjs](../../server/discovery.mjs), [kakao.mjs](../../server/kakao.mjs), [선택 계약](../../shared/kakao-discovery-types.ts) | [API 안내](../api-reference.md), [검색 배포 기록](../kakao-discovery-release-2026-09-12.md) |
| Guide와 MCP Tools | [guide.mjs](../../server/guide.mjs), [Guide 진입점](../../agent/guide/main.py), [Tools 진입점](../../agent/tools/main.py) | [Agent 소스](../../agent/README.md), [AgentCore 구성](../agentcore-components.md) |
| 실제 도로 경로 | [routing.mjs](../../server/routing.mjs), [runtime.py](../../routing/runtime.py), [경로 계약](../../shared/routing-types.ts) | [Valhalla 실행](../../routing/README.md) |
| 브라우저 저장 | [saved-data.ts](../../src/saved-data.ts), [browsing-history.ts](../../src/browsing-history.ts) | [지도 경험 설계](../superpowers/specs/2026-09-12-kakao-map-experience.md) |
| 요청 조정과 접속 집계 | [admission.mjs](../../server/admission.mjs), [presence.mjs](../../server/presence.mjs) | [AI 한도와 접속 집계 기록](../ai-presence-release-2026-09-12.md) |
| 배포와 복구 | [deploy.py](../../scripts/deploy.py), [application.yaml](../../infra/application.yaml), [rollback-release.py](../../scripts/rollback-release.py) | [배포](../runbooks/deploy.md), [복구](../runbooks/rollback.md) |
| 워크숍과 PWA 패키징 | [course.json](../../workshop/course.json), [교재 빌더](../../workshop/scripts/build.mjs), [공개 패키저](../../scripts/build-workshop-public.mjs), [앱 PWA 빌더](../../scripts/build-pwa.mjs) | [워크숍](../../workshop/README.md), [오프라인 교재](../../workshop/reference/offline-start.md) |
| 본 실습 참가자 준비 | [소스와 세션 검사](../../workshop/scripts/core.py), [전용 도구 설치기](../../workshop/scripts/install_core.sh) | [01장](../../workshop/chapters/01-setup.md), [소스 전달과 진행자 준비](../../workshop/reference/facilitator.md) |
| 워크숍 Sonnet 검증 | [모델 설정](../../workshop/scripts/model_config.py), [명시적 실제 호출](../../workshop/scripts/model_check.py) | [계정과 호출 리전](../../workshop/chapters/02-aws-environment.md), [공식 문서 대조](../../workshop/reference/official-guide-review.md) |
| 워크숍 CloudFront 접속 | [소유 스택 URL 조회](../../workshop/scripts/lab_cloudfront.py), [참가자 사본 변환](../../workshop/scripts/lab_workspace.py) | [기본 HTTPS와 엣지](../../workshop/chapters/09-https-edge.md) |

### 주요 결정

기존 설계 기록은 [명세](../superpowers/specs/)와
[구현 계획](../superpowers/plans/)에 있습니다. 이 문서는 의도한 설계를
설명하며 실제 구현 동작은 현재 코드에서 확인합니다.

- [원본 HTTPS](../superpowers/specs/2026-09-10-origin-https.md)는
  CloudFront와 원본 사이의 경계를 기록합니다.
- [이동 경로와 3D](../superpowers/specs/2026-09-10-mobility-3d.md)는
  도로 경로와 지도 상호작용 설계를 다룹니다.
- [AI 한도와 접속 집계](../superpowers/specs/2026-09-12-unlimited-ai-presence.md)는
  사용 한도 설정과 요청 조정을 구분합니다.
- [지도 경험](../superpowers/specs/2026-09-12-kakao-map-experience.md)은
  검색, 저장 장소와 코스의 출발·도착을 다룹니다.

날짜가 있는 배포와 감사 문서는 당시 관찰을 보존합니다.
현재 배포나 제공처 데이터를 확인하는 절차를 대신하지 않습니다.

### 관련 문서

[문서 목록](../README.md) · [저장소 작업 지침](../../AGENTS.md) ·
[기여 안내](../../CONTRIBUTING.md) · [저장소 이력](../repository.md)
