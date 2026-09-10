# 제주 아틀라스 운영 보강 배포 기록

확인일: 2026-09-10 UTC.
서비스: `jeju-atlas.whchoi.net` 및 기존 CloudFront 주소.

## 배포된 버전

| 대상 | 결과 |
|---|---|
| 웹 릴리스 | `release-20260910T144230Z` |
| 이미지 digest | `sha256:7f189f39dfe466b3429f9bf2631c75594c0a316b4c53e5e5ed8bb8a1cf2e1115` |
| ECS 태스크 정의 | `jeju-3d:8`, Linux ARM64, 태스크당 0.25 vCPU·512 MiB |
| 서비스 용량 | 최소 2·최대 4, 서로 다른 2개 AZ, Public IP 없음 |
| Agent Runtime | 버전 18, READY, Strands |
| Tools Runtime | 버전 9, READY, MCP 도구 8개 |
| 모델 | 서울 Global CRIS: 일반 질문 Sol, 일정·코스 Astra |
| 언어 | 한국어/English 토글, 선택 기억, UI와 AI 요청 연동 |
| 운영 스택 | `Jeju3dEdge`, `Jeju3dOperations`, `Jeju3dOrigin` 생성 완료 |

기존 VPC·Public/Private 서브넷·NAT Gateway를 재사용했습니다.
사용자 도메인·인증서를 먼저 CloudFormation 기준 상태에 등록한 뒤 배포했습니다.
기존 이미지가 새 준비 상태 경로 때문에 비정상 처리되지 않도록 `/healthz`로
이미지를 먼저 교체하고 안정화 후 ALB를 `/readyz`로 전환했습니다.

## 검증 결과

- Node 회귀 테스트 **211개**, 최종 배포 스크립트 테스트 **34개** 통과.
- Agent·라우터·명소·프리페치 테스트 **284개** 통과.
- 제어된 브라우저 검사 **15개** 통과. 한영 선택, 저장 복원·삭제, 여러 탭,
  저장 거부, 서비스 재개, WebGL 복구, PWA 업데이트를 포함합니다.
- npm 취약점 **0건**, ECR 이미지 검사 완료 후 취약점 집계 **0건**.
- 운영 인프라·HTTP 검사 **57개** 통과. 두 도메인과 요청 증명, Private 배치,
  원본 우회 차단, WAF, 카탈로그, 이미지 버전을 확인했습니다.
- 운영 브라우저 실제 AI: 한국어 맛집 **15.297초**, 영어 일정 **37.471초**,
  각 요청 한 번으로 정상 완료. 정확한 성산일출봉 기준점과 미검증 편의 정보
  표현을 확인했습니다.

### 같은 조건의 조회 부하

서울 실행 호스트, 워밍업 제외, 50세션 × 10 GET = 500요청입니다.
모델 호출·브라우저 FPS·장기 지속 부하의 측정값은 아닙니다.

| 시점 | 오류 | p50 | p95 |
|---|---:|---:|---:|
| 배포 전 | 0/500 | 44.377 ms | 82.077 ms |
| 배포 후 | 0/500 | 44.647 ms | 82.577 ms |

측정된 조회 지연은 비슷하며, 이 변경의 용량 효과는 이중화와 복구 능력입니다.
이 결과만으로 최대 동시 AI 사용자 수나 장기 SLA를 확정하지 않습니다.

### 한 태스크 교체 검사

두 AZ의 정상 태스크를 확인하고 **정확히 한 태스크**의 교체를 요청했습니다.
약 **96.865초** 후 새 태스크와 두 AZ의 정상 상태를 확인했습니다.
교체 중 상태·설정 GET **198개 모두 성공**했고, 추가 교체나 불명확한 중지
요청의 재시도는 하지 않았습니다.

## 운영 제어

- 여러 태스크가 DynamoDB의 일일·시간별 한도, 실행 잠금과 요청 ID를 공유합니다.
- 전체 하루 30회, 사용자 시간당 5회, 전체 동시 2회 한도를 유지합니다.
- 결과가 불명확한 요청을 자동으로 다시 모델에 보내지 않습니다.
- 종료 시 새 요청을 막고 진행 중 답변을 기다립니다. 앱 115초, ECS 120초,
  ALB 등록 해제 120초의 여유를 둡니다.
- WAF 빈도 제한은 API 경로에 적용합니다. 지도 타일은 해당 제한에서 제외됩니다.
- CloudFront 로그는 쿠키·IP·사용자 에이전트·질문 쿼리·URI를 제외한 필드만
  실제로 저장하는 것을 확인했습니다. 보관 기간은 14일입니다.
- 카탈로그 상태와 14일 초과 갱신 지연, 가이드 오류, ALB·태스크 오류,
  CPU·메모리·DynamoDB 쓰기 제한 알람을 구성했습니다.

## 데이터와 사용자 자료

원본 카탈로그 6,724건(OSM 6,587 + 시드 137)의 ID·이름·좌표를 변경하지
않았습니다. 상업 이용 제한 사진을 걸러내는 정책과 필드별 확인 수준을
추가했습니다. 현재 사진 1,173건은 허용 목록 안에 있어 유지됩니다.

요일별 반복 시간·개별 인허가 상태를 실제 운영 보장으로 해석하지 않습니다.
시드 정보와 가족·주차 태그는 미검증으로 표시하고 AI에도 같은 규칙을 적용합니다.
여행 자료는 브라우저 저장 방식이며, 내보내기·검토 후 복원·기기 삭제가
서버 Memory 삭제를 뜻하지 않습니다.

## 남아 있는 운영 의존성

1. **원본 HTTPS**: 서울 ACM 인증서와 ALB HTTPS 리스너는 준비되어 있습니다.
   실제 DNS 관리 영역에 다음 CNAME을 게시해야 합니다.

   ```text
   jeju-atlas-origin.whchoi.net
       CNAME jeju-3d-alb-1953229828.ap-northeast-2.elb.amazonaws.com
   ```

   게시와 인증서 검증 후 `infra/production.json`의 `OriginTlsEnabled`를
   `"true"`로 바꾸고 검토·배포합니다. 현재 CloudFront→ALB는 HTTP입니다.
   현재 계정의 동명 Hosted Zone은 공개 DNS에 위임되지 않아 대신 수정하지 않았습니다.
2. **알림 전달**: SNS 주제와 알람은 생성됐지만 구독자는 없습니다.
   운영 담당 수신 경로와 실제 수신 확인이 필요합니다.
3. **운영 정책**: 예상 트래픽·월 예산·AI 예산·사업자/개인정보 문의처가
   아직 정해지지 않았습니다. 현재 보호 한도는 상용 트래픽 용량 약정이 아닙니다.

이 의존성까지 해결되기 전에는 상용 운영 준비 전체가 완료된 것으로 표시하지 않습니다.

## 증거와 복구 자료

`.local/checks.json`, `.local/release-image-scan.json`, `.local/verification.json`,
`.local/parent-final-ui-check/report.json`, `.local/bilingual-production/report.json`,
`.local/load-before-commercial.json`, `.local/load-after-commercial.json`,
`.local/recovery-commercial.json`, `.local/operations-live-checks.json`.

변경 전 앱 템플릿·매개변수·이미지는 `.local/before-commercial-release/`,
Agent 전체 템플릿 이력은 `.local/guide-model-history/`에 보관합니다.
프로젝트 원본 카탈로그와 Memory 데이터는 이 배포에서 삭제하거나 재작성하지 않았습니다.
