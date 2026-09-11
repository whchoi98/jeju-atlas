# 새 Clone에서 카탈로그 만들기

저장소 루트에서 실행합니다. Python 3.9 이상과 **FTS5 trigram을 지원하는 SQLite**, POSIX 파일 시스템(Linux/WSL 등)이 필요합니다. Python 표준 라이브러리만 사용하며 AWS 계정·공급자 키·기존 S3 객체·원본 카탈로그·`agentcore-cli` 디렉터리는 필요하지 않습니다.

```bash
python3 workshop/scripts/catalog_seed.py \
  --output .local/workshop/catalog/sample.sqlite
```

현재 커밋된 `agent/tools/data/jeju_pois.json`의 **137개 샘플 전체**를 넣습니다. 이름·좌표·주소·소개는 독립적으로 검증한 정보가 아닙니다. `places.source=sample`, 소개의 `미검증 샘플` 표시, `place_extra.sources`의 `curated` 출처와 미검증 안내를 함께 보존합니다. 샘플의 `parking`·`kid_friendly` 값은 시설 정보로 가져오지 않습니다. 전화·URL·영업시간·사진·공식 보강 정보는 비워 둡니다.

표준 출력은 JSON 요약 한 개입니다. `count`, `by_source`, `by_category`, `dropped`, 실제 파일의 `sha256`, `bytes`, `path`를 확인합니다. 장소 행이나 키를 출력하지 않습니다. `sample_sha256`은 사용한 커밋 샘플 파일의 해시입니다.

출력 부모 디렉터리는 자동 생성합니다. **기존 파일은 종류와 관계없이 덮어쓰지 않습니다.** 다시 만들 때는 `sample-v2.sqlite`처럼 새 경로를 지정하세요. 경로의 심볼릭 링크·`..` 이동을 거부하며, 동시 생성 충돌이나 쓰기 실패 시에도 기존 파일을 보호합니다. 완성된 파일만 같은 디렉터리에서 원자적으로 공개하므로 POSIX 하드 링크를 지원하는 로컬 파일 시스템을 사용하세요.

## 선택: 공개 OpenStreetMap 자료 추가

```bash
python3 workshop/scripts/catalog_seed.py \
  --output .local/workshop/catalog/with-osm.sqlite \
  --osm
```

공개 Overpass에 이름이 있는 카페·식당·주차장·시장·박물관·갤러리·관광지·전망대·해변을 조회합니다. 샘플 137개에 실제 응답의 유효한 OSM 요소만 추가합니다. **라이브 건수는 조회 시점·응답·검증 결과에 따라 달라지며 제주 전체 목록이 아닙니다.**

| 제한 | 동작 |
| --- | --- |
| 경계 | 위도 `33.1–33.6`, 경도 `126.15–126.98`; Node/Python 카탈로그와 동일 |
| 크기·개수 | JSON 최대 8 MiB, 최대 1,000개 요소 검사; 서버에서 1,001개까지 받아 한도 도달 감지 |
| 시간 | Overpass 실행 25초, HTTP 소켓 타임아웃 및 응답 읽기 기한 35초 |
| 재시도 | 연결 오류·HTTP 429/500/502/503/504에 총 3회 이내; 대기 최대 5초, 더 긴 `Retry-After` 요청이면 종료 |
| 품질 | 잘못된 ID·좌표·이름·태그, 경계 밖 요소, 폐기 태그, 미지원·모호한 분류는 제외 |

`osm:node/123`, `osm:way/123`, `osm:relation/123`처럼 유형까지 포함한 ID로 중복을 제거합니다. 서로 다른 ID는 유지합니다. 이름·좌표가 같은 샘플과 OSM도 자동 병합하지 않아 샘플에 OSM 전화번호나 출처가 섞이지 않습니다.

`places.source=OpenStreetMap`, 보강 출처는 `osm`/`ODbL`입니다. URL은 해당 OSM 요소의 고유 링크를 사용합니다. 전화와 `opening_hours`는 응답 태그가 있을 때만 원문으로 저장하며, 주간 시간표나 현재 영업 상태를 추정하지 않습니다. way/relation 좌표는 경계 상자 중심이므로 출입구 좌표라고 해석하지 마세요. `natural=peak`를 오름으로 추정하지 않으며 `tourism=gallery`는 문화시설로 분류합니다. `맛집`은 앱의 카테고리 이름이지 품질 검증 표시가 아닙니다.

`meta.attribution`과 `osm_provenance`에 OpenStreetMap 기여자 표기, 저작권 안내 및 ODbL 링크, 응답 해시·기준 시각·조회 시각·한도를 기록합니다. 배포할 때 출처와 이용허락 표기를 유지하세요. 샘플의 `curated`는 출처 분류이며 사진 이용허락이나 공식 검증을 뜻하지 않습니다.

Overpass 오류·불완전 응답·크기 초과 시 종료 코드가 0이 아니며 성공 JSON을 출력하지 않습니다. 샘플만 필요하면 새 출력 경로로 `--osm` 없이 실행합니다.

## 오프라인 OSM fixture 재생

```bash
python3 workshop/scripts/catalog_seed.py \
  --output .local/workshop/catalog/fixture.sqlite \
  --osm --osm-file /tmp/jeju-overpass.json
```

파일은 Overpass의 원래 `elements` 배열 형식이어야 합니다. `node`는 `lat`/`lon`, `way`·`relation`은 `center.lat`/`center.lon`을 사용합니다. `--osm-file`에는 `--osm`이 필요하고 네트워크를 사용하지 않습니다. 동일한 크기·개수·경계 검사를 적용합니다.

파일 입력은 `osm_provenance.input=file`, `retrieved_at=null`로 구분하고 원본 진위를 확인하지 않았다는 안내를 남깁니다. 테스트의 합성 fixture를 실제 OSM 조회 결과나 검증된 장소 목록으로 소개하지 마세요.

## 호환성 확인과 후속 공식 보강

생성물은 `meta.schema_version=2`이며 `places`, `place_extra`, `meta`, 외부 콘텐츠 방식의 `places_fts`를 포함합니다. FTS5 trigram과 `rid` 연결, `name_norm`·`tags_text`, 카테고리 및 위경도 B-tree 인덱스를 생성합니다. 기존 두 리더는 RTree를 사용하지 않습니다.

```bash
python3 -B -m unittest discover \
  -s workshop/tests -p test_catalog_seed.py -v
```

테스트는 임시 파일만 사용해 SQLite 무결성·출처·시설 공백·한국어 검색·응답 제한·원자적 출력을 확인합니다. PATH의 Node가 v24 이상이면 저장소의 실제 `server/catalog.mjs`로 검색·지도 포인트·상세 근거도 검사합니다. 별도 Node 바이너리는 `NODE_BINARY` 환경 변수로 지정할 수 있으며, 사용할 수 없으면 해당 검사는 명시적으로 건너뜁니다.

Node 상세 응답에서 샘플 기본 필드는 `unverified`, OSM 기본 필드는 `source_reported`, 없는 정보는 `unknown`으로 표시됩니다. `built_at`·`updated_at`은 빌드 시각/날짜이며 현장 확인일이 아닙니다. 모든 기본 필드의 관측일을 빌드 날짜로 채우지 않습니다.

후속 데이터 보강 장에서는 실습 전용 사본의 `scripts/fetch-place-details.py`를 통해 TourAPI/VisitJeju 자료를 별도 공식 상세 스냅샷으로 연결합니다. 공급자 접근 권한과 키 준비는 그 단계에서 다룹니다. 원래 샘플/OSM 필드와 공식 상세를 구분하고, 공급자 ID·원문 URL·실제 수집 시각·이용허락을 보존하세요. 공식 제공 자료도 대조 검토 전에는 `source_reported`이며, 수집 성공만으로 `reviewed`가 되지 않습니다. 사진은 해당 사진의 이용허락·크레딧·원본 URL이 확인된 경우에만 추가합니다.

참고: [Overpass 출력 형식](https://dev.overpass-api.de/overpass-doc/en/targets/formats.html), [공용 서버 제한](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html), [OSM 저작권 안내](https://www.openstreetmap.org/copyright), [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
