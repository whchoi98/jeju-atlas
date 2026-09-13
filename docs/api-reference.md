# API 경로와 인증

실제 계약은 `shared/` 타입과 `server/api.mjs`, 각 서버 모듈이 기준입니다.
이 프로젝트에 Swagger나 자동 생성 OpenAPI 엔드포인트가 있다고 가정하지 않습니다.

## 읽기 경로

| 메서드 | 경로 | 역할 |
|---|---|---|
| GET | `/healthz` | 서버 상태와 릴리스 |
| GET | `/readyz` | 배포 준비 상태 |
| GET | `/api/config` | 기능 설정, 브라우저 세션과 요청 증명 |
| GET | `/api/catalog/status` | 카탈로그 상태와 출처별 수량 |
| GET | `/api/catalog/search` | `q`, `category`, 범위와 페이지 조건의 검색 |
| GET | `/api/catalog/points` | 지도에 표시할 장소 좌표 |
| GET | `/api/catalog/places/:id` | 같은 ID의 상세와 근거 |
| GET | `/api/presence` | 현재와 누적 접속 집계 |

```bash
curl --fail http://localhost:8097/healthz
curl --fail http://localhost:8097/api/catalog/status
```

`/api/config`의 요청 토큰은 브라우저 세션에 묶여 있습니다.
설정 응답과 사용자별 API 응답을 공유 캐시에 저장하지 않습니다.

## POST 경로

| 경로 | 역할 |
|---|---|
| `/api/guide` | AI 응답 스트림 |
| `/api/kakao/search` | 카카오 이름과 분류 검색 |
| `/api/kakao/detail` | 선택 증명으로 상세 조회 |
| `/api/kakao/reopen` | 같은 카카오 장소 ID 다시 확인 |
| `/api/routes` | 도보/차량 경로 계산 |
| `/api/elevation` | 고도 표본 |
| `/api/presence/heartbeat` | 현재 세션의 접속 확인 |

POST 요청은 경로별 입력 검증과 세션/요청 증명을 적용합니다.
브라우저 클라이언트의 `/api/config` 초기화와 `X-Atlas-CSRF` 처리를 사용합니다.
토큰을 코드에 고정하거나 다른 사용자에게 복사하지 않습니다.

AI 스트림은 상태, 텍스트, 지도 결과와 종료/오류 이벤트를 구분합니다.
HTTP 200만으로 응답 완료를 판단하지 않고 종료 이벤트와 실제 답변을 확인합니다.
이미 실행했을 수 있는 요청을 네트워크 오류만 보고 자동 재실행하지 않습니다.

카카오 결과는 최신 카탈로그 전체 복사본이 아닙니다.
검색 범위와 분류, 페이지 제한을 유지하며 저장했던 장소도 같은 ID로 다시 확인합니다.
