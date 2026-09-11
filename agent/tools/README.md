# 제주 아틀라스 전용 Tools

`main.py`는 FastMCP `JejuAtlasTools`에 기존 8개 도구를 등록합니다. 로직은
`atlas_tools`, SQLite 카탈로그는 같은 패키지의 `catalog.py`와 `place_extra.py`,
기본 시드는 `data/jeju_pois.json`을 사용합니다. 참조 저장소를 탐색하거나
동기화 스크립트를 실행하지 않습니다.

데이터 선택 순서는 명시적인 `ATLAS_CATALOG_PATH`, `ATLAS_CATALOG_BUCKET`의
`catalog/catalog.sqlite`, 패키지의 시드입니다. 선택적으로
`ATLAS_CATALOG_S3_KEY`, `ATLAS_CATALOG_CACHE_DIR`(기본 `/tmp/atlas`),
`ATLAS_CATALOG_REFRESH_S`를 사용할 수 있습니다. 다른 앱의 `CATALOG_BUCKET`,
`CATALOG_CACHE_DIR` 및 기존 프로젝트의 환경변수는 사용하지 않습니다.
`ATLAS_DETAILS_BUCKET`은 `place-details/latest.json` 공식 상세 자료를 읽으며,
레이어·축제는 `ATLAS_SNAPSHOT_DIR`, 패키지 `data/snapshots`,
전용 카탈로그 버킷의 `snapshots` 순서로 읽습니다.

기존 시드의 `Ohmyjeju Curation`/오마이제주 출처 표기는 실제 데이터 제공자를
뜻하므로 유지합니다. 시드는 미검증 자료이며 공식 상세는 각 필드의 출처·시각을
따로 제시합니다. 데이터가 누락되면 이를 확인된 정보로 만들지 않습니다.

외부 공급자 키는 전용 런타임에 명시적으로 제공된 환경변수만 우선 사용합니다.
`ATLAS_SECRETS_SSM_PREFIX`는 현재 배포에서 설정하지 않으며, 이 경우 SSM
클라이언트를 생성하거나 Parameter Store를 조회하지 않습니다. 이전 프로젝트의
키·버킷·SSM 정책은 이 패키지에 포함하지 않습니다. 권한은
`infra/agentcore.yaml`에서 전용 리소스에 맞춰 정의합니다.

키가 없을 때 기존 카탈로그·스냅샷·직선 fallback 의미를 유지합니다.
Agent 도구의 직선 fallback은 도로 경로가 아닙니다. 앱의 실제 도보·차량 경로는
별도의 Valhalla BFF(`/api/routes`)에서 제공하며 이 패키지의 의존성이 아닙니다.

질문·도구 인자·공급자 응답·예외 본문은 telemetry에 저장하지 않습니다.
`atlas_tools/privacy.py`는 Guide와 같은 운영 필드 허용 목록을 적용합니다.

패키지 설치는 프로젝트 루트에서
`UV_PROJECT_ENVIRONMENT="$PWD/.local/atlas-tools-venv" uv sync --project agent/tools --frozen --no-dev`
로 확인할 수 있습니다. 빌드·회귀 테스트는 참조 저장소 가상환경에 의존하지 않습니다.
