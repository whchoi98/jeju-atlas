# 12 · 서비스 검증과 문제 해결

배포 계획·이미지 빌드·스택 완료·실제 사용자 응답을 각각 확인합니다.
교재 제작자가 수행한 로컬 검사 결과를 자신의 AWS 배포 결과로 복사하지 않습니다.

## 자동 검사

```bash
cd "$ATLAS_REPO"
python3 workshop/scripts/lab.py run check --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run verify --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run verify-assets --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run verify-terrain --config "$ATLAS_CONFIG" --execute
```

`check`는 로컬 소스 검사입니다. `verify` 계열은 실제 AWS와 HTTP를 확인합니다.
HTTPS 단계 이전에는 전체 운영 검사를 통과했다고 기대하지 않습니다.
현재 코드·이미지·검증 결과의 시점을 함께 기록합니다.

## 실제 화면

| 항목 | 확인 |
|---|---|
| 첫 지도 | 대표 아이콘만 먼저 표시, 필요할 때 카테고리·전체 장소 표시 |
| 탐색 | 협재해변 등 대표 장소·카테고리·주변 검색·상세 연계 |
| 지형 | 2D/3D·배율·시점 공유·한라산/성산 등의 탐색 |
| 둘러보기 | 제주 한 바퀴와 올레길 코스별 이동 |
| 경로 | 같은 출발/도착의 도보·차량 거리·예상 시간·고도 단면 |
| 여행 | 경유지·체류 시간·순서 편집·GPX·저장/복원 |
| 언어 | 한국어/English 토글과 UI·질문·답변 언어 |
| PWA | 앱 셸과 저장 코스 오프라인 확인, 온라인 API 구분 |

지형·도로·위성 자료의 시점을 구분합니다.
정밀 측량·실시간 교통·실시간 위성 영상이라고 설명하지 않습니다.

## 실제 AI 질문

아래 질문을 한 번씩 수행하고 완료 여부를 기록합니다.
실제 모델 호출이며 계정 비용과 앱 한도에 포함됩니다.

```text
아이와 함께 방문할 장소를 추천하고 편의 정보가 확인되는지 알려 주세요.
한라산 근처 맛집을 추천하고 확인된 이용시간과 출처를 알려 주세요.
성산일출봉 근처 맛집을 알려 주세요.
Recommend family-friendly places in Jeju and distinguish verified facilities from unknown information.
```

확인할 항목:

- 답변 전 생각 중 상태, 실제 사용 도구 표시, 답변 완료 이벤트가 있습니다.
- Markdown·이모지·후속 질문·추천 장소 지도 연계가 작동합니다.
- 기준 장소가 맞고 이름이 비슷한 다른 장소를 중심으로 잡지 않습니다.
- 공식 자료가 없으면 미확인으로 설명합니다.
- 한국어/English 선택이 답변에 반영됩니다.
- 브라우저를 닫거나 요청을 취소했을 때 서버가 무한 작업을 지속하지 않습니다.

Memory는 같은 사용자·세션 범위의 기록과 보관 정책으로 확인합니다.
다른 참가자의 actor/session 식별자를 사용하지 않습니다.

## 문제 구분

| 현상 | 확인 순서 |
|---|---|
| 현재 페이지 요청 불허/403 | ApplicationUrl, Domain Alias, origin/Host, cookie·검증 헤더 |
| 502/504 | origin TLS, ALB target, 상태·연결/응답 제한 |
| Runtime READY인데 답 없음 | 모델 권한·endpoint, 도구 Gateway, turn timeout·SSE 완료 |
| 도구는 보이나 결과 없음 | 카탈로그·공식 snapshot, schema·정확한 장소 anchor |
| 사진·시간이 비어 있음 | 실제 수집·match·라이선스·미디어 OAC, 미확인 값을 생성하지 않음 |
| 429 | 일일/시간/동시 한도와 이전 요청 종료 여부 |
| 새 배포 후 자산 404 | 불변 이미지의 자산 manifest·S3 게시·CloudFront 캐시 |

Codex에는 오류 코드·상태·소유 자원 식별자·관련 코드만 제공하고
secret 값·AWS 자격 증명·원문 사용자 대화 전체를 붙이지 않습니다.

## 복구 기준

ECS deployment circuit breaker와 자동 rollback 설정을 확인합니다.
웹·라우터는 같은 task definition의 digest 쌍으로 되돌아가야 합니다.
수동 rollback 연습은 **이 실습에서 생성하고 확인한 이전 이미지**를 진행자와 승인한 뒤 진행합니다.
원본 `docs/rollback.md`에 있는 운영 digest를 실습의 승인 이미지로 복사하지 않습니다.
새 릴리스 한 개만 만든 상태에서는 “이전 버전 복구 실증 완료”로 기록하지 않습니다.

- [ ] 자동 검사와 실제 화면 결과를 구분해 기록했습니다.
- [ ] 한영 AI가 완료되고 확인된 정보·미확인 정보를 구분합니다.
- [ ] 실패 원인과 안전한 재개 지점을 설명합니다.
- [ ] 복구 구성 확인과 실제 복구 실험을 구분합니다.

Codex 카드: [12 · 검증](../prompts/12-validation.md)

다음: [13 · 정리](13-cleanup.md)
