# 제주 아틀라스 엣지 보호와 운영

현재 기준은 웹 `release-20260910T202150Z` / `jeju-3d:11`입니다.
인프라·HTTP 78개가 통과했으며 최신 증거와 미해결 항목은
[운영 검증 종합 기록](commercial-completion-audit-2026-09-10.md)에 모읍니다.
초기 배포 과정은 [과거 운영 보강 기록](commercial-release-2026-09-10.md)에 보존합니다.

## 배포된 구성과 연결

| 스택 | 역할 |
|---|---|
| `Jeju3dEdge`, `us-east-1` | 기존 CloudFront의 WAF, 표준 로그 V2, 엣지 알람·대시보드·SNS |
| `Jeju3dOperations`, `ap-northeast-2` | ALB·ECS·가이드·카탈로그·할당량 알람, 대시보드·SNS |
| `Jeju3dApp`, `ap-northeast-2` | 앱과 CloudFront, 최소 2개·최대 4개 태스크, 준비 상태·종료 처리 |
| `Jeju3dData`, `ap-northeast-2` | 비공개 공식 상세·허용 사진, 한국 03:00 Private Fargate 수집 |
| `Jeju3dOriginRouting`, `us-east-1` | 게시된 원본 Host 함수 `jeju-3d-origin-host:1` |
| `Jeju3dStatic`, `ap-northeast-2` | 비공개 공유 자산 버킷·OAC, 롤링 배포의 이전 파일 유지 |

엣지·운영 스택은 기존 VPC·서브넷·NAT·앱 실행 역할·카탈로그를 소유하거나
변경하지 않습니다. 앱의 `DistributionArn`을 엣지에 전달하고, 반환된
`WebAclArn`을 앱의 `DistributionConfig.WebACLId`에 연결한 상태입니다.
리전 간 연결은 명시적 매개변수를 사용합니다.

운영 스택은 앱의 `ClusterName`, `ServiceName`, `LogGroupName`,
`GuideQuotaTableName`, `AlbFullName`, `TargetGroupFullName` 출력을 사용합니다.
ALB·Target Group 지표 차원에는 ARN이나 표시 이름 대신
`app/이름/ID`, `targetgroup/이름/ID` 형식의 전체 이름을 전달합니다.

## 원본 HTTPS와 공유 자산

**2026-09-10 19:38 UTC부터 원본 HTTPS가 배포된 상태**입니다.
`OriginTlsMode=canonical-host`에서 CloudFront는 ALB DNS로 연결하고
Lambda@Edge가 Host를 `jeju-atlas.whchoi.net`으로 고정합니다.
함수는 기본 동작과 `/api/catalog/*`, `/api/*`의 `origin-request`에만
연결하며 `IncludeBody=false`입니다. 별도 원본 DNS 게시 대기는 없습니다.
ALB의 CloudFront Prefix List 제한과 원본 검증 헤더는 유지합니다.

`/assets/*`는 `jeju-3d-assets-061525506239-ap-northeast-2`의 OAC
`E2W270OBXMQ1S2`를 사용합니다. `/assets/*`, `/media/*`, `/terrarium/*`는
Host 함수를 거치지 않습니다. 3개 이미지의 공유 자산 19개에 대해 HTTP 200과
SHA-256 일치, S3 직접 접근 차단, 매니페스트 비공개를
확인했습니다 (`.local/history/jeju-3d/shared-assets-verification.json`, 로컬 자료).

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

Agent 22·Tools 12는 질문·답변 콘텐츠를 관측 로그에서 제거한 버전입니다.
실제 Astra 영어 요청의 관측 구간에서 입력 표식·질문·답변 일부가 검출되지 않았고,
모델·도구 이름과 토큰 수는 유지됐습니다. 두 Runtime CloudWatch 로그 그룹에
14일 보관을 적용했습니다. [검사 범위와 Memory 보관](agentcore-components.md#관측-로그와-개인정보)은 별도로 확인합니다.

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
| 공식 상세 | 카탈로그와 독립된 지표; 최근 1분 구간 3개 중 2개에서 stale·사용 불가·신호 누락 |
| 제공처 목록 실패 | `source_lists.provider_failures` 5분 합계가 0 초과 |
| 수집 작업 실패 | `collection_failed`가 5분 안에 1건 이상 |
| 일일 수집 완료 누락 | 활성 스케줄에서 최근 48개 완료 시간 구간에 `collection_complete`가 없음 |

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

### 공식 상세와 수집 작업

`OfficialDetailsEnabled=true`일 때 앱의 숫자 heartbeat를 별도로 집계합니다.

```json
{"event":"official_details_status","stale":0}
```

공식 제공처 기록의 실제 `fetched_at` 나이와 사용 가능 여부로 판단합니다.
스냅샷의 `generated_at`만 갱신해 14일 초과 기록을 새 자료로 취급하지 않습니다.
`OfficialDetailsStale`에는 기본 0이나 사용자별 차원을 넣지 않아 카탈로그·다른 로그가
공식 상세 신호 누락을 가릴 수 없습니다.

수집 이미지 `data-release-20260910T195513Z`는 `jeju-3d-data:3`에 배포됐고
실제 실행은 **exit code 0**, `collection_complete` 1건을 남겼습니다.
제공처 실패와 완료는 별도로 집계합니다. 갱신 0건으로 기존 자료를 보존한 실행도
완료 이벤트가 있으면 완료 1회입니다. 완료 누락 알람은 시간별 완료 수에
`FILL(..., 0)`을 적용한 48/48 판정이며, 비활성 스케줄에서는 생성하지 않습니다.
처음 만든 지표는 과거 로그를 소급 집계하지 않으므로 초기 상태를 함께 확인해야 합니다.

2026-09-10 **20:35 UTC 관측**:

| 알람 | 관측 상태 |
|---|---|
| `Jeju3dOperations-official-details-stale` | `OK`; 실제 `stale=0` 지표 확인 |
| `Jeju3dData-provider-failures` | `ALARM`; `ProviderFailures` 합계 3 |
| `Jeju3dData-collection-failed` | `OK` |
| `Jeju3dData-collection-missing` | `INSUFFICIENT_DATA`; 정상 판정으로 간주하지 않음 |

실패 3건은 VisitJeju C4의 목록 건수 불일치·식별 충돌과 C1 연결 오류입니다.
해당 실행은 `partial=true`로 완료했고 마지막 정상 자료를 유지했습니다.
수집 완료나 웹 정상 응답만으로 제공처 장애가 해소됐다고 판단하지 않습니다.
근거: 실제 실행 (`.local/history/jeju-3d/data-health-smoke.json`, 로컬 자료),
필터·heartbeat 검증 (`.local/history/jeju-3d/data-health-metric-verification.json`, 로컬 자료),
알람·지표 관측 (`.local/history/jeju-3d/data-health-live-alarms.json`, 로컬 자료).

## 알림과 남은 운영 작업

지역별 SNS 주제와 CloudWatch 발행 정책은 배포됐지만 구독자는 없습니다.
운영 수신 경로를 연결하고 실제 수신을 확인해야 담당자에게 알림이 전달됩니다.
알림에는 운영 알람 메타데이터만 담습니다.

데이터 스택의 `DataNotificationsTopicArn`은 빈 값 또는 기존 소유 토픽
`arn:aws:sns:ap-northeast-2:061525506239:jeju-3d-operations-alarms`만 받습니다.
실제 데이터 알람의 Alarm/OK 액션은 이 토픽에 연결됐습니다. 발행 정책은
운영 스택이 소유하며 같은 계정·리전의 데이터 알람 ARN 3개만 추가 허용합니다.
수집 태스크에 SNS 발행 권한이나 새 구독자를 추가하지 않습니다.

남은 운영자 입력은 **알림 수신자·월 예산과 경보 기준·사업자/서비스 연락처**입니다.
`main` 병합에는 명시적 승인이 필요합니다. 제공처 장애와 알람 상태를 포함한
[최신 운영 검증](commercial-completion-audit-2026-09-10.md)을 기준으로 후속 작업을 결정합니다.

## 검증과 변경 시 확인

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'operations_infra_test.py' -v
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'data_health_infra_test.py' -v
cfn-lint infra/edge.yaml infra/operations.yaml infra/data.yaml infra/origin-routing.yaml infra/static.yaml
```

위 명령은 로컬 검사입니다. 실제 배포 후에는 `scripts/verify.py`의
인프라·HTTP 결과와 로그 전달 상태, 허용 필드, 두 AZ 정상 타깃, 카탈로그
신호, 알람 차원·대시보드를 확인합니다. 새 이미지의 CDN·AI·브라우저
결과는 그 릴리스의 운영 증거에 별도로 남깁니다.

기준 템플릿: [edge.yaml](../infra/edge.yaml), [operations.yaml](../infra/operations.yaml), [data.yaml](../infra/data.yaml).
운영 확인 자료: 로그·알람 검사 (`.local/history/jeju-3d/operations-live-checks.json`, 로컬 자료),
인프라·HTTP 검사 (`.local/history/jeju-3d/verification.json`, 로컬 자료).
`.local` 파일은 재검사로 바뀔 수 있으므로 실행 시각과 릴리스를 함께 확인합니다.
