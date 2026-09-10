# 제주 아틀라스 엣지 보호와 운영

2026-09-10 운영 보강 배포에서 `Jeju3dEdge`(버지니아)와
`Jeju3dOperations`(서울)를 생성하고 WAF 연결·로그 수집·알람 구성을
확인했습니다. 해당 릴리스의 증거는 [운영 보강 기록](commercial-release-2026-09-10.md)에 있습니다.
최신 웹 릴리스 `release-20260910T180902Z`의 인프라·HTTP 61개와
공개 서비스의 사진·AI·올레길 검증은
[최종 배포 확인](details-olle-release-2026-09-10.md)에 기록했습니다.

## 배포된 구성과 연결

| 스택 | 역할 |
|---|---|
| `Jeju3dEdge`, `us-east-1` | 기존 CloudFront의 WAF, 표준 로그 V2, 엣지 알람·대시보드·SNS |
| `Jeju3dOperations`, `ap-northeast-2` | ALB·ECS·가이드·카탈로그·할당량 알람, 대시보드·SNS |
| `Jeju3dApp`, `ap-northeast-2` | 앱과 CloudFront, 최소 2개·최대 4개 태스크, 준비 상태·종료 처리 |
| `Jeju3dData`, `ap-northeast-2` | 비공개 공식 상세·허용 사진, 한국 03:00 Private Fargate 수집 |

엣지·운영 스택은 기존 VPC·서브넷·NAT·앱 실행 역할·카탈로그를 소유하거나
변경하지 않습니다. 앱의 `DistributionArn`을 엣지에 전달하고, 반환된
`WebAclArn`을 앱의 `DistributionConfig.WebACLId`에 연결한 상태입니다.
리전 간 연결은 명시적 매개변수를 사용합니다.

운영 스택은 앱의 `ClusterName`, `ServiceName`, `LogGroupName`,
`GuideQuotaTableName`, `AlbFullName`, `TargetGroupFullName` 출력을 사용합니다.
ALB·Target Group 지표 차원에는 ARN이나 표시 이름 대신
`app/이름/ID`, `targetgroup/이름/ID` 형식의 전체 이름을 전달합니다.

## 엣지 보호와 로그

- 빈도 제한은 정규화한 `/api/` 경로에 IP별 5분당 2,000회로 적용합니다.
  고도 타일 경로는 이 규칙에서 제외합니다.
- AWS CommonRuleSet을 사용하되 `SizeRestrictions_BODY`는 Count로 처리합니다.
  앱의 16 KB 입력 한도보다 작은 관리 규칙의 8 KB 기준으로 정상 입력을 차단하지 않습니다.
- WAF 요청 샘플링과 원문 WAF 로깅은 비활성화했습니다.
- CloudFront 표준 로그 V2는 아래 필드만 JSON으로 저장하며 보관 기간은 14일입니다.

```text
date time sc-status sc-bytes time-taken time-to-first-byte x-edge-location
x-edge-result-type x-edge-response-result-type x-edge-detailed-result-type
cache-behavior-path-pattern
```

마지막 필드는 `/api/*` 같은 설정된 경로 패턴입니다. 실제 URI·쿼리·IP·쿠키·
사용자 에이전트·요청 본문·임의 헤더는 저장 필드에서 제외합니다.
`RecordFields`를 생략하면 기본 필드로 돌아가므로 허용 목록을 유지해야 합니다.
로그 그룹은 스택 삭제 시 보존되며 이벤트 보관 기간은 계속 적용됩니다.

CloudFront 배포당 로그 전달 소스는 하나를 사용합니다. 전달 설정 권한은
배포 주체에 있으며 앱 태스크에 부여하지 않습니다. CloudFront 지표는
버지니아 리전에서 `Region=Global`로 조회하고, WAF 지표에는 이 차원을 넣지 않습니다.

## 알람과 카탈로그 상태

| 대상 | 현재 기준 |
|---|---|
| 정상 ALB 타깃 | 최소 2개; 1분 구간 3회 연속 미달 또는 누락 시 알람 |
| ALB·타깃 5xx | 각각 5분간 10건 이상 |
| 타깃 응답 헤더 지연 | `TargetResponseTime` p95 2초 초과 |
| 가이드 오류 | 5분간 3건 이상 |
| CPU / 메모리 | 각각 80% / 85% 이상 15분 |
| DynamoDB 쓰기 제한 | `WriteThrottleEvents` 발생; 정상 한도 초과 거절은 제외 |
| 카탈로그 | 최근 1분 구간 3개 중 2개에서 갱신 지연·사용 불가·신호 누락 |

가이드 지표는 `guide_stream_error`와 HTTP 상태 500 이상인 `guide_rejected`를
집계합니다. 사용자 취소와 정상 4xx·할당량 거절은 운영 장애로 세지 않습니다.
ALB 헤더 지연은 SSE 답변 전체가 끝나는 시간이나 AI 완료 지연이 아닙니다.

앱은 초기화 직후와 태스크별 60초마다 아래 숫자 상태를 이미 기록합니다.

```json
{"event":"catalog_status","stale":0}
```

`stale: 0`은 사용 가능한 정상 스냅샷이며 `built_at`이 유효하고 14일 이내라는
뜻입니다. 갱신 지연·사용 불가·14일 초과·미래 시각·시각 누락이나 오류는
`stale: 1`입니다. 로그에는 저장 경로·URL·세션·질문·답변을 넣지 않습니다.
지표에 기본 0을 채우지 않아 다른 로그가 신호 누락을 가릴 수 없습니다.
파일 확인 주기는 10분이며, 오래된 마지막 정상 카탈로그의 제공과 `/readyz`
판정은 이 신선도 알람과 구분합니다.

## 알림과 남은 운영 작업

지역별 SNS 주제와 CloudWatch 발행 정책은 배포됐지만 구독자는 없습니다.
운영 수신 경로를 연결하고 실제 수신을 확인해야 담당자에게 알림이 전달됩니다.
알림에는 운영 알람 메타데이터만 담습니다.

원본 HTTPS에 필요한 공개 DNS 전환, 운영 연락처·예산 등 남은 사항은
[운영 보강 기록](commercial-release-2026-09-10.md#남아-있는-운영-의존성)을 따릅니다.
운영 스택 배포를 이 항목의 해결이나 모든 알람의 현재 정상 상태로 해석하지 않습니다.

## 검증과 변경 시 확인

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'operations_infra_test.py' -v
cfn-lint infra/edge.yaml infra/operations.yaml
```

위 명령은 로컬 검사입니다. 실제 배포 후에는 `scripts/verify.py`의
인프라·HTTP 결과와 로그 전달 상태, 허용 필드, 두 AZ 정상 타깃, 카탈로그
신호, 알람 차원·대시보드를 확인합니다. 새 이미지의 CDN·AI·브라우저
결과는 그 릴리스의 운영 증거에 별도로 남깁니다.

기준 템플릿: [edge.yaml](../infra/edge.yaml), [operations.yaml](../infra/operations.yaml).
운영 확인 자료: [로그·알람 검사](../.local/operations-live-checks.json),
[인프라·HTTP 검사](../.local/verification.json).
`.local` 파일은 재검사로 바뀔 수 있으므로 실행 시각과 릴리스를 함께 확인합니다.
