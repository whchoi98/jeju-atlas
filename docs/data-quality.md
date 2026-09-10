# 카탈로그 상업 이용·필드 근거 상태

확인일: 2026-09-10. 기준은 `.local/reference-catalog.sqlite`이며, 원본 S3 및 참조
프로젝트를 수정하지 않고 현재 서버 어댑터로 읽었습니다.

**현재 스냅샷에서 비상업용으로 표시된 사진은 0건입니다.** 이번 변경은 현재
사진을 비상업용으로 분류해 제거하는 작업이 아닙니다. 이후 스냅샷에 제한 사진이나
알 수 없는 라이선스가 들어와도 상업용 응답에 노출되지 않도록 필터를 강화했습니다.
현재 사진 1,173건은 모두 유지됩니다.

## 재현

Node 24에서 실행합니다. 표준 출력에만 JSON을 쓰며 스냅샷·캐시·보고서 파일을
생성하거나 수정하지 않습니다. AWS·모델·외부 제공자 호출도 하지 않습니다.

```sh
node scripts/audit-catalog.mjs .local/reference-catalog.sqlite
node --test tests/catalog.test.mjs tests/guide-facts.test.mjs
```

이 작업 환경에서는 `node` 대신 `/tmp/jeju-node24/bin/node`를 사용했습니다.
인자를 생략하면 저장소의 `.local/reference-catalog.sqlite`를 읽습니다.
동일한 파일과 어댑터 구현은 동일한 JSON을 출력합니다. 출력에 실행 시각이나
임시 경로를 넣지 않습니다. 잘못된 SQLite 파일은 성공 보고서 대신 종료 코드 1을
반환합니다.

## 실제 스냅샷 결과

| 항목 | 결과 |
| --- | --- |
| 크기 | 5,996,544바이트 |
| 스키마 | `meta.schema_version = 2` |
| 빌드 시각 | `2026-09-08T21:48:10+00:00` |
| SHA-256 | `5fb97978a7a74b487c7850042c25f08242654c8946d2003374c894a3843a0b00` |
| 전체 장소 | 6,724 |
| 기본 출처 OpenStreetMap | 6,587 |
| 기본 출처 `sample` | 137 |
| 큐레이션 보강 출처만 있는 시드 | 72 |
| 복수 보강 출처가 있는 시드 | 65 |
| 사진이 있는 장소 | 원자료 223 / 서비스 응답 223 |
| 사진 항목 | 원자료 1,173 / 서비스 응답 1,173 |
| 상업용 필터로 제외된 현재 사진 | 0 |
| 비상업용 라이선스 사진 | 0 |
| 크레딧·원본 URL 누락 사진 | 각각 0 |
| `reviewed` 근거가 있는 장소·필드 | 각각 0 |
| `reviewed` 근거가 없는 장소 | 6,724 |

`reviewed`가 없다는 것은 이 스냅샷에 독립 검토를 입증하는 필드별 근거가 없다는
뜻입니다. 장소가 허구이거나 정보가 틀렸다는 판정이 아닙니다. 시드의 실재 장소
이름도 유지하며, 시드를 삭제하거나 비슷한 OSM 장소로 자동 교체하지 않습니다.

| 사진 라이선스 | 항목 | 해당 라이선스 사진이 있는 장소 | 서비스 항목 |
| --- | ---: | ---: | ---: |
| KOGL-1 | 365 | 57 | 365 |
| KOGL-3 | 808 | 171 | 808 |
| KOGL-2·KOGL-4·NC·미지원 | 0 | 0 | 0 |

서로 다른 라이선스가 함께 있는 장소가 있으므로 장소 열의 합은 223이 아닙니다.
KOGL-3의 원자료 및 서비스 응답에서 파생 썸네일은 모두 0건입니다.

| 정보 종류 | 결과 |
| --- | ---: |
| 요일별 시간 배열이 있는 장소 | 178 |
| `tourapi_usetime` 파싱값인 장소 | 178 |
| 동일 시간대를 7일에 반복한 시간표 | 178 |
| 기본 `hours` 문자열이 있는 장소 | 150 |
| 편의 필드가 없는 장소 | 6,237 |
| 편의 필드가 모두 `unknown`인 장소 | 41 |
| 명시된 yes/no/limited 값이 있는 장소 | 446 |
| 원문 LOCALDATA 관측 시각 | 2,979 |
| facts 응답에 원문 그대로 보존되는 LOCALDATA 시각 | 2,979 |
| facts 변환 중 소실된 현재 출처 시각 | 0 |
| 인허가 상태가 있는 장소 | 2,834 |

LOCALDATA의 시각은 제공처 레코드 수정일에서 온 값입니다. 장소 운영을 직접
확인한 시각으로 바꾸어 해석하지 않습니다. 전체 스냅샷 빌드·다운로드 시각도
각 필드의 관측 시각이나 검토 시각이 아닙니다.

## 상업용 사진 정책

`server/catalog.mjs`는 사진 자체의 인정된 라이선스, 비어 있지 않은 크레딧,
안전한 절대 HTTP(S) 원본 URL을 요구합니다. 표시 URL도 안전한 URL이어야 합니다.
인정된 사진에 대해 스냅샷에 없는 별도 허가 증명 필드를 요구하지 않습니다.

허용 목록은 `KOGL-1`, `KOGL-3`, `CC-BY-4.0`, `CC-BY-SA-2.0`,
`CC-BY-SA-3.0`, `CC-BY-SA-4.0`, `CC0`, `PD`입니다. `KOGL-2`,
`KOGL-4`, NC 유형, 알 수 없는 값 및 사진 권리의 근거가 되지 않는 일반적인
`unrestricted`·`curated` 표기는 기본 차단합니다. 보강 데이터의 `sources[].license`
값은 이 사진 필터와 별개로 보존합니다.

- KOGL-3은 저장된 원본/미러 URL을 유지하고 `thumb_url`을 null로 반환합니다.
  이미지 변환·재인코딩·새 썸네일 생성은 하지 않습니다.
- `/media/...` 표시 URL은 기존 `mediaOrigin`에 대해서만 절대 주소로 해석합니다.
- 원본 URL만 제공된 유효한 사진은 그 URL로 표시할 수 있습니다.
- `status().photos_count`는 원자료 메타값을 그대로 사용하지 않고, 실제 필터를
  통과한 사진이 있는 장소를 셉니다. 개별 사진의 총수가 아닙니다.
- 라이선스·크레딧·출처 값은 유지합니다. 선언된 권리를 검사하는 필터이며,
  사진별 권리 진술의 정확성이나 미러의 원본 바이트 동일성을 재검증한 결과는 아닙니다.

공식 이용조건:

- [공공누리 1유형](https://www.kogl.or.kr/info/licenseType1.do)
- [공공누리 2유형](https://www.kogl.or.kr/info/licenseType2.do)
- [공공누리 3유형](https://www.kogl.or.kr/info/licenseType3.do)
- [공공누리 4유형](https://www.kogl.or.kr/info/licenseType4.do)
- [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- [CC BY-SA 2.0](https://creativecommons.org/licenses/by-sa/2.0/),
  [3.0](https://creativecommons.org/licenses/by-sa/3.0/),
  [4.0](https://creativecommons.org/licenses/by-sa/4.0/)
- [CC0](https://creativecommons.org/publicdomain/zero/1.0/)
- [OpenStreetMap 저작권·ODbL](https://www.openstreetmap.org/copyright)

## 공유 타입 계약

기존 필드의 이름·값·좌표를 바꾸지 않는 선택적 추가 필드입니다.
`CatalogPlace`와 `GuidePlaceInfo`에 `field_evidence`, `PlaceDetail`과
`GuidePlaceInfo`에 `registration_note`를 추가하는 계약입니다.
`PlaceDetail`은 `CatalogPlace`의 `field_evidence`를 상속합니다.

```ts
field_evidence?: Record<string, {
  state: 'unknown' | 'unverified' | 'source_reported' | 'parsed' | 'reviewed';
  source: string | null;
  observed_at: string | null;
  evidence_url: string | null;
}>;
registration_note?: string | null;
```

| 상태 | 현재 어댑터의 의미 |
| --- | --- |
| `unknown` | 값이 없거나 해당 필드의 제공 출처를 특정할 수 없음 |
| `unverified` | 제공된 큐레이션 기본값 등으로, 독립 검토 완료 근거 없음 |
| `source_reported` | 기본 OSM 데이터 또는 시간·메뉴·사진의 필드/항목에 명시된 제공 출처가 있음. 검토 완료와 다름 |
| `parsed` | `tourapi_usetime`처럼 원문에서 파생한 값 |
| `reviewed` | 타입상 예약된 상태. 현재 스냅샷에서 어댑터가 생성하지 않음 |

기본 필드 경로는 `name`, `name_en`, `category`, `lat`, `lng`, `address`,
`summary`, `tags`, `url`, `phone`, `hours`, `region`, `avg_stay_min`입니다.
값이 있는 `sample` 기본 필드는 `unverified`, OSM 기본 필드는
`source_reported`, 없는 값은 `unknown`입니다. OSM 근거 URL은 해당
OSM ID의 원문 링크이며 별도로 온라인 대조 조회했다는 뜻이 아닙니다.

상세에는 `hours_week`, `facilities`, `facilities.parking` 등 편의 필드별 경로,
`overview`, `business_status`, `menu`, `tips`, `menu.0.name`,
`menu.0.price_krw`, `photos.0` 등의 경로를 제공합니다.
메뉴·사진은 항목 자체의 `source`가 있을 때만 그 항목의 제공 출처를 표시합니다.
모든 현재 필드별 `observed_at`은 null입니다. 레코드 전체의 출처 시각을
필드별 시각으로 추정해 채우지 않으며, 원래 시각은 `sources[]`에 보존합니다.

예를 들어 시드 장소에 TourAPI 보강이 있어도:

```json
{
  "lat": {
    "state": "unverified",
    "source": "sample",
    "observed_at": null,
    "evidence_url": null
  },
  "facilities.parking": {
    "state": "unknown",
    "source": null,
    "observed_at": null,
    "evidence_url": null
  },
  "hours_week": {
    "state": "parsed",
    "source": "tourapi_usetime",
    "observed_at": null,
    "evidence_url": null
  }
}
```

`parking: "yes"` 같은 원래 편의 값은 이 때문에 지워지지 않습니다.
`sources`가 복수 제공처를 포함해도 평면적인 편의 사전의 필드 소유자를
복원할 수 없으므로 근거 상태는 `unknown`입니다. 공식 제공처가 있다는 이유로
시드·편의·소개를 검토 완료로 승격하지 않습니다.

## 시간·편의·인허가 해석

- `unknown`, 누락, null은 미확인입니다. `no`나 false로 바꾸지 않습니다.
- 주차가능·아이동반 같은 기본 태그는 현재 시설을 직접 확인한 증거가 아닙니다.
- `kid_friendly`는 제공처의 유모차 플래그나 큐레이션 값에서 왔을 수 있습니다.
  `wheelchair`도 VisitJeju의 광범위한 `장애인` 태그에서 왔을 수 있습니다.
  전반적인 아동 적합성·무장애 접근성을 보증하지 않습니다.
- `tourapi_usetime`의 반복 시간표로 매일 개장, 휴무일, 입장 마감,
  현재 영업 중 여부를 확정하지 않습니다. 식별 가능한 `hours_source`가 없으면
  시간 배열이 있어도 해당 근거는 `unknown`입니다.
- ISO 시각과 유효한 `YYYY-MM-DD HH:mm:ss` 원문을 그대로 보존합니다.
  존재하지 않는 날짜와 잘못된 시각은 거부하며, 없는 시간대를 붙이지 않습니다.
- `registration_note`는 인허가 상태가 있는 경우
  “연결된 인허가 자료의 상태이며, 장소 전체의 운영 여부나 현재 시각의 영업 여부를
  확정하지 않습니다.”를 제공합니다. 원래 `business_status`는 그대로 유지합니다.

## 검증과 남은 경계

테스트는 실제 임시 SQLite를 사용해 제한 사진·원본 누락 필터, 유효 사진 보존,
필터 후 사진 가용 수, 근접한 동명 OSM 후보가 있어도 시드 ID·이름·좌표 유지,
필드별 미확인 상태, 날짜 보존, 감사 CLI의 결정성·읽기 전용 동작을 확인합니다.
실제 스냅샷도 같은 어댑터와 감사 스크립트로 읽었습니다.

이 변경은 사진 제공 및 카탈로그/facts 근거 표시의 경계입니다. AI 추천 후보 자격과
스트리밍 문장 검증은 `guide-grounding.mjs` 및 가이드 처리 담당 범위에서 별도로
조정해야 합니다. 카탈로그에 존재하거나 답변에 이름이 등장했다는 이유로
`reviewed`라고 해석해서는 안 됩니다.
