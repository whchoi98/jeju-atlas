# 부하·복구 검증 범위

최신 배포와 남은 항목은 [운영 검증 종합 기록](commercial-completion-audit-2026-09-10.md)을
기준으로 합니다. HTTP 부하, 단일 태스크 교체, 이전 이미지 롤백은 서로 다른 검사입니다.

## 최종 HTTP 부하 관측

2026-09-10 **20:34 UTC**, `https://jeju-atlas.whchoi.net`의
`release-20260910T202150Z`를 검사했습니다.

| 항목 | 관측값 |
|---|---:|
| 독립 HTTP 세션 | 50 |
| 측정 GET | 500 |
| 오류 / HTTP 200 | 0 / 500 |
| p50 | 41.702ms |
| p95 | 275.421ms |
| 최대 | 502.158ms |

근거: 최종 부하 결과 (`.local/history/jeju-3d/load-final-commercial.json`, 로컬 자료).
워밍업 6건은 측정에서 제외했습니다. 서울 검사 호스트라는 전제의 임시 목표
오류 0건·p95 ≤ 1,000ms를 통과했습니다. 호스트 위치는 스크립트가 자동 판별하지 않습니다.
이 결과는 짧은 HTTP 검사이며 장시간 수용 용량·사용자 기기의 FPS·AI 완료 지연을
측정한 것이 아닙니다. [이전 릴리스](commercial-release-2026-09-10.md)의 82ms대 p95는
과거 관측값이며 이번 결과와 단순 비교해 빨라졌다고 주장하지 않습니다.

## 부하 검사 재실행

저장소 루트에서 Python 3와 `requests`를 사용합니다.

```bash
python3 scripts/load-check.py https://jeju-atlas.whchoi.net \
  --output .local/load-check.json
```

기본 동작은 `/healthz` 사전 확인, 6건 워밍업, **50개 세션 × 10 GET**입니다.
각 세션은 `한라산`, `협재`, `성산`, `가족`, `카페`의 고정 카탈로그 검색
5건(`limit=12`)과 `/api/config` 5건을 번갈아 요청합니다.
`--sessions`는 1~100, `--no-warmup`은 워밍업 생략입니다. 모델을 호출하지 않습니다.

상태 코드·오류 수·경로별 지연과 nearest-rank 백분위수, 경과 시간 기준 RPS를 기록합니다.
health/config의 서비스·릴리스·설정, 실제 비어 있지 않은 검색 결과까지 확인하므로
임시 JSON을 반환하는 HTTP 200은 통과하지 않습니다.

## 태스크 교체와 관측

읽기 전용 관측에도 배포된 리소스를 확인할 AWS 권한과 `boto3`가 필요합니다.

```bash
# 읽기 전용 관측: StopTask 없음
python3 scripts/recovery-check.py https://jeju-atlas.whchoi.net \
  --output .local/recovery-observe.json

# 운영자가 태스크 1개 교체를 의도한 경우에만 실행
python3 scripts/recovery-check.py https://jeju-atlas.whchoi.net \
  --replace-one --output .local/recovery-replace.json
```

`--replace-one`은 AWS 상태를 변경합니다. 검사 대상은 계정 `061525506239`,
서울 리전 `Jeju3dApp`의 실제 출력이며 URL은 `ApplicationUrl` 또는
`CloudFrontUrl`과 일치해야 합니다. `--outputs`로 지정한 파일은 배포 출력과
비교하는 용도이며 리소스 식별을 덮어쓰지 못합니다.

태스크를 중지하기 직전까지 아래 조건을 재확인합니다.

- 소유한 클러스터·서비스·태스크 정의·ALB·타깃 그룹과 CloudFormation 리소스 일치.
- 태그·태스크 그룹·Private IP와 ALB 타깃 일치.
- 두 AZ에 정상 실행 태스크와 정상 타깃이 최소 2개, pending 0개.
- 완료된 primary 배포 1개, running=desired, 정상 공개 health/config.

관측은 최종 확인과 중지 요청 전에 시작합니다. `StopTask`는 한 번만 시도하고,
응답 유실·중단으로 결과가 불명확해도 다른 태스크를 선택하거나 재시도하지 않습니다.
실행 직전 확인과 실제 중지 사이를 ECS가 원자적으로 잠그지는 못하므로
동시 배포·수동 태스크 조작 중에는 실행하지 않습니다.

health/config는 약 1초 주기로, AWS 상태는 별도 주기로 관측합니다.
`--duration`은 기본 300초, 허용 1~300초이며 느린 응답을 무한 대기열에 쌓지 않습니다.
최종 공개 응답과 서비스 상태 확인을 포함하므로 전체 실행 시간은 관측 시간보다 길 수 있습니다.
성공 조건은 HTTP 오류 0건과 마지막에 두 AZ 정상 타깃 최소 2개입니다.
교체 모드에서는 선택한 이전 태스크 종료·새 정상 태스크 ARN·서비스 안정화도 요구합니다.
`stop.outcome`이 불명확하면 AWS 상태부터 확인하며 같은 중지를 반복하지 않습니다.

실제 단일 태스크 교체는 **이전 릴리스 `release-20260910T144230Z`**에서
2026-09-10 14:56~14:58 UTC에 통과했습니다.
당시 관측 자료 (`.local/history/jeju-3d/recovery-commercial.json`, 로컬 자료)는 현재 이미지의 교체 검증이나
이전 이미지로 되돌리는 운영 롤백의 증거가 아닙니다.

## 이전 이미지 롤백 검증

현재 이미지 `18fb0b…` → 이전 이미지 `0ef30e…` → 현재 이미지의
**실제 Docker 이미지 로컬 예행연습**이 통과했습니다. 모델 호출 0회,
readiness·공식 상세·공유 자산 참조와 읽기 전용 자료 불변을 확인했습니다.
예행연습 결과 (`.local/history/jeju-3d/release-rollback-final-rehearsal.json`, 로컬 자료)

공개 공유 자산은 3개 이미지에 필요한 19개 파일의 SHA-256을 검증했습니다.
AWS 롤백은 **검토 가능한 계획까지 준비했으며 실행하지 않았습니다.**
[롤백 절차](rollback.md)와 [최신 운영 검증](commercial-completion-audit-2026-09-10.md)을
참조하고 실제 적용 직전 기준 상태·승인 이미지·변경 목록을 다시 확인해야 합니다.

## 출력과 로컬 회귀 검사

두 검사 도구는 `--output`이 필수이며 지정한 JSON 결과 파일만 작성합니다.
응답 본문·쿠키·CSRF 증명·질문·AWS 오류 원문 대신 고정 오류 코드,
릴리스·집계 지연·태스크 ARN을 기록합니다. 성공 시 0, 실패·거절 시 1로 종료합니다.

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s tests -p 'load_recovery_test.py' -v
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s tests -p 'rollback_release_test.py' -v
```

이 테스트는 제어된 응답으로 500 GET·워밍업 제외·임시 응답 거절,
잘못된 계정·소유권·AZ·진행 중 배포, 불명확한 중지·관측 실패와 재시도 제한을 검사합니다.
테스트 자체는 AWS·모델을 호출하지 않습니다.
