# 공식 상세·올레길 테마 배포 확인

서비스: `jeju-atlas.whchoi.net` 및 기존 CloudFront 주소.
최종 웹 배포 완료: 2026-09-10 18:17 UTC.

| 대상 | 확인 결과 |
|---|---|
| 웹 릴리스 | `release-20260910T180902Z` |
| 웹 이미지 | `sha256:0ef30ebd2d916a26fcc53eeee47a92c5483c55aef408c836e5a49c25880f671b` |
| ECS | `jeju-3d:10`, 정상 2개 태스크, 서로 다른 AZ, Private·Public IP 없음 |
| AgentCore | Agent 20 / Tools 11, READY |
| 모델 | 서울 Global CRIS, 일반 질문 Sol / 일정 Astra |
| 데이터 작업 | `jeju-3d-data:2`, 이미지 `sha256:35d0f71856d6d7f98b6e9f459fc339993d5e16a77e1891693f4f821adf8b2644` |
| PWA 셸 | `2f858f2fde54df67` |

## 적용 기능

- 제주 한 바퀴와 **18개 올레길 경로 항목**을 선택합니다. 14·21코스는
  각각 약 4.64km·1.30km의 일부 구간이며 이름에도 표시했습니다.
  자료가 없는 11개 항목은 비활성화했습니다. 실제 OSM 선을 따라 재생하며,
  분리된 구간을 임의로 연결하지 않습니다.
- **344곳·700개 제공처/언어 기록**을 별도 공식 상세로 연결했습니다.
  시드 중 94곳을 포함합니다. 사진은 제공처 기록 기준 707장,
  중복 URL 제외 689개입니다. 원본 카탈로그의 ID·이름·좌표는 유지합니다.
- 갤러리·제공처 탭·주소·전화·소개·이용 정보·출처·조회일과 영문 자료를 표시합니다.
  API 키는 데이터 작업만 SSM SecureString에서 읽고 웹·Tools는 S3 스냅샷만 읽습니다.
- 정확한 장소 이름이 검색 제한에 밀리지 않도록 수정했습니다.
  성산일출봉의 시간·휴무·요금 질문이 `find_places` → `place_detail`을 사용해
  **27.404초**, 한 번의 요청으로 완료됐습니다.
- `11~2월`, `06:00~18:00`의 물결표를 취소선으로 처리하던 표시를 수정했습니다.
  이중 물결표 취소선·표·링크·HTML 안전 처리는 유지합니다.

## 검증

| 검사 | 결과 |
|---|---|
| Node / Python 전체 검사 | 240 / 105개 통과 |
| 참조 프로젝트 검색·상세 관련 검사 | 132개 통과; 부모 검증 49개도 통과 |
| 기존 사용 흐름 브라우저 검사 | 15개 통과 |
| 상세 화면의 제공처·언어·사진 유무·키보드 | 9개 통과 |
| 최종 공개 서비스 올레길 | 8개 통과 |
| 최종 공개 서비스 사진·한영 상세·모바일·실제 AI | 6개 통과 |
| 최종 인프라·HTTP·권한·미디어 | 61개 통과 |
| npm / 웹·데이터 이미지 ECR 검사 | 발견 항목 0건 |

실제 사진은 CloudFront에서 JPEG로 응답했고 직접 S3 요청은 403이었습니다.
공식 상세와 계절별 시간·휴무일·요금·출처를 실제 브라우저와 AI로 확인했습니다.

자동 확장 검사에서는 기존 메모리 정책에 의해 **2→4개 정상 태스크**로
확장됐습니다. 원래 정책 복원 후 3개까지 자동 축소됐고, **2개 복구는 명시적으로
수행**했습니다. HTTP 34회 모두 성공했습니다. 초기 관측 시 AWS 활동이 아직
`InProgress`여서 실패로 기록됐으나 이후 읽기 전용 감사에서 `Successful`을
확인했습니다. 원본 기록을 보존했고 검사 도구의 판정 시점도 수정했습니다.

## 실제 예약 수집과 제한

한국 시각 03:00 일정이 활성화됐으며 UTC 18:00에 실제 태스크가 시작됐습니다.
수집기와 GuardDuty 모두 종료 코드 0입니다. 900곳을 시도했고 신규 매칭은
0곳이어서 기존 상세를 보존했습니다. 비짓제주 일부 연결 실패와 음식점 목록의
총건수 불일치는 기록하고, 불완전한 목록으로 새 매칭을 확정하지 않았습니다.

갱신 정책·사진 이용조건·경로 출처는 [구현 설명](official-details-olle.md)에 있습니다.
원본 HTTPS에 필요한 공개 DNS, 알림 수신자, 운영 예산·사업자 연락처는
[남은 운영 의존성](commercial-release-2026-09-10.md#남아-있는-운영-의존성)입니다.
UTC 18:26 재확인에서도 원본 DNS는 없고 SNS 구독자는 0명이었습니다.
상용 운영 준비 전체를 완료했다고 표시하지 않습니다.

참조 프로젝트 코드는 `jeju-atlas/astra-sol`의 **`32a1ec4`**로 기록했습니다.
해당 코드로 서비스 배포와 검증을 완료했으며, 참조 프로젝트 `main` 병합은
자동 승인 심사의 명시적 승인 요구로 대기 중입니다.

## 증거

`.local/checks.json`, `.local/verification.json`,
`.local/details-olle-final-web-image-scan.json`, `.local/data-image-final-scan.json`,
`.local/details-olle-commercial-ui/report.json`, `.local/parent-rich-detail-final/report.json`,
`.local/olle-final/report.json`, `.local/official-details-final/report.json`,
`.local/data-worker-final-smoke.json`, `.local/data-scheduled-run.json`,
`.local/official-details-scheduled-validation.json`, `.local/native-autoscaling-final-audit.json`,
`.local/final-operating-dependencies.json`.

`.local`은 워크스페이스의 실제 검증 기록이며 Git에 포함하지 않습니다.
