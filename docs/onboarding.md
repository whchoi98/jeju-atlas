# Local development / 로컬 개발

<a href="#english">English</a> · <a href="#korean">한국어</a>

<a id="english"></a>
## English

### Prerequisites

Use Node 24.18.1 or newer within the Node 24 line, npm, and Python.
[.nvmrc](../.nvmrc) pins Node 24.21.0; use `nvm install` and `nvm use` if nvm is
available. Check `node --version` before installing dependencies. The release
checker rejects other Node major versions.

The sample generator and handbook packager use the Python standard library.
The full root check additionally needs `boto3`, `requests`, and `cfn-lint`.
Guide/Tools have separate environments described in the [Agent guide](../agent/README.md);
the AgentCore CLI workshop has its own [prerequisites](../workshop/README.md).

For full root and workshop checks, create a Python environment and install the
shared [check dependencies](../workshop/requirements.txt), including PyYAML:

```bash
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install -r workshop/requirements.txt
```

### Prepare a fresh clone

Run the following from the repository root:

```bash
npm ci
mkdir -p .local
python3 workshop/scripts/catalog_seed.py --output .local/catalog-standalone.sqlite
npm run build
```

The seed command creates a SQLite catalog from the 137 committed sample places
without calling a provider. It refuses to replace an existing file: on a
previously prepared checkout, reuse that file and skip the generator.
The seed is not a verified production dataset. See [data quality](data-quality.md).

The build creates `dist/`, including the public workshop and its downloadable
handbook. The API server expects this directory even when Vite serves the
development UI.

### Start the API and Vite

Create `.env` once; retain an existing local configuration:

```bash
cp .env.example .env
```

In the first terminal:

```bash
node --env-file=.env server/server.mjs
```

In the second terminal:

```bash
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api` to `http://127.0.0.1:8097`.
Both processes are needed; `npm run dev` starts only Vite. When working over
SSH, forward the browser-facing port. If Vite chooses another port, update
`PUBLIC_ORIGIN` in `.env` and restart the API.

To browse the built app without Vite, set `PUBLIC_ORIGIN=http://localhost:8097`
in `.env`, restart the API, and open `http://localhost:8097`.
`npm run preview` also needs the separate API and a matching `PUBLIC_ORIGIN`.
`npm run server` does not automatically load `.env`; the explicit command above does.

### Verify the local catalog

```bash
curl --fail http://localhost:8097/healthz
curl --fail http://localhost:8097/readyz
curl --fail http://localhost:8097/api/catalog/status
```

Expect a running server, a ready catalog, and 137 sample places on the fresh
seed path. `/healthz` alone does not verify the catalog or optional integrations.
Browser features initialize sessions through `/api/config`; see the
[API reference](api-reference.md).

| Optional feature | Required configuration or resource |
|---|---|
| S3 catalog | `CATALOG_BUCKET` instead of the local seed path, with read access |
| Official details | `DETAILS_LOCAL_PATH` or `DETAILS_BUCKET` with a matching snapshot |
| Kakao discovery | Server-side `KAKAO_REST_API_KEY`, `GUIDE_QUOTA_TABLE`, catalog, and `PUBLIC_ORIGIN` |
| AI Guide | `GUIDE_RUNTIME_ARN`, `GUIDE_QUOTA_TABLE`, and `PUBLIC_ORIGIN` |
| Road routing | `ROUTING_URL`, `ROUTING_DATA_UPDATED_AT`, and `PUBLIC_ORIGIN` |
| Shared visitor counts | `PRESENCE_TABLE` and `PUBLIC_ORIGIN` |

AWS features need the corresponding permissions. Production API startup also
requires `ATLAS_SESSION_SECRET`; development creates a temporary signing key.
Keep actual secret values outside Git. Optional integrations are not enabled
by generating the seed. Map tiles and new provider responses require a network.

### Checks and next steps

```bash
npm run check
npm run workshop:check
```

The root check runs Node tests, Python deployment tests, CloudFormation lint,
`npm audit`, and the production build in sequence. It stops on the first failed
step and writes `.local/checks.json`. `npm audit` needs registry access.
Set `ATLAS_PYTHON` when the root check, workshop check, or public-workshop build
must use a specific Python interpreter; direct `python3` commands still use the PATH.

Workshop browser checks are opt-in with `WORKSHOP_BROWSER_TEST=1` and require
Playwright/Chromium. Follow [workshop instructions](../workshop/README.md) for
the full command. Local checks do not deploy AWS resources or invoke a model.

Use [CONTRIBUTING.md](../CONTRIBUTING.md) for change review, the
[implementation index](reference/INDEX.md) to locate code and design records,
and [deployment](runbooks/deploy.md) for existing production operations.

<a id="korean"></a>
## 한국어

### 준비 사항

Node 24 계열의 24.18.1 이상, npm과 Python을 사용합니다.
[.nvmrc](../.nvmrc)는 Node 24.21.0을 지정합니다. nvm이 설치되어 있다면
`nvm install`과 `nvm use`로 맞춥니다. 의존성 설치 전에 `node --version`을
확인합니다. 릴리스 검사기는 다른 Node 주 버전을 허용하지 않습니다.

시드 생성기와 교재 패키저는 Python 표준 라이브러리를 사용합니다.
전체 루트 검사에는 `boto3`, `requests`, `cfn-lint`가 추가로 필요합니다.
Guide/Tools의 별도 환경은 [Agent 안내](../agent/README.md), AgentCore CLI
워크숍의 준비 사항은 [워크숍 안내](../workshop/README.md)를 따릅니다.

전체 루트 검사와 워크숍 검사에는 Python 환경을 만들고 PyYAML을 포함한
[공통 검사 의존성](../workshop/requirements.txt)을 설치합니다.

```bash
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install -r workshop/requirements.txt
```

### 새 clone 준비

저장소 루트에서 실행합니다.

```bash
npm ci
mkdir -p .local
python3 workshop/scripts/catalog_seed.py --output .local/catalog-standalone.sqlite
npm run build
```

시드 명령은 제공처를 호출하지 않고 Git에 포함된 샘플 장소 137개로 SQLite
카탈로그를 만듭니다. 기존 파일을 덮어쓰지 않으므로 이미 준비한 작업 폴더에서는
해당 파일을 재사용하고 생성 단계를 건너뜁니다. 시드는 검증된 운영 데이터가
아닙니다. [데이터 품질](data-quality.md)을 참고하세요.

빌드는 공개 워크숍과 다운로드 교재를 포함하는 `dist/`를 생성합니다.
Vite로 개발 화면을 실행할 때도 API 서버는 이 디렉터리가 필요합니다.

### API와 Vite 실행

`.env`는 처음 한 번 생성합니다. 기존 로컬 설정이 있다면 그대로 사용합니다.

```bash
cp .env.example .env
```

첫 번째 터미널에서 실행합니다.

```bash
node --env-file=.env server/server.mjs
```

두 번째 터미널에서 실행합니다.

```bash
npm run dev
```

`http://localhost:5173`을 엽니다. Vite는 `/api`를
`http://127.0.0.1:8097`로 전달합니다. `npm run dev`는 Vite만 시작하므로
두 프로세스가 모두 필요합니다. SSH 환경에서는 브라우저에서 접속할 포트를
전달합니다. Vite가 다른 포트를 선택하면 `.env`의 `PUBLIC_ORIGIN`을 바꾸고
API를 다시 시작합니다.

Vite 없이 빌드한 앱을 보려면 `.env`의 `PUBLIC_ORIGIN`을
`http://localhost:8097`로 바꾸고 API를 다시 시작한 뒤 같은 주소를 엽니다.
`npm run preview`도 별도 API와 일치하는 `PUBLIC_ORIGIN`이 필요합니다.
`npm run server`는 `.env`를 자동으로 읽지 않으므로 위의 명시적 실행 명령을 사용합니다.

### 로컬 카탈로그 확인

```bash
curl --fail http://localhost:8097/healthz
curl --fail http://localhost:8097/readyz
curl --fail http://localhost:8097/api/catalog/status
```

새 시드 경로에서는 서버 실행, 카탈로그 준비 상태와 샘플 장소 137개를 확인합니다.
`/healthz`만으로 카탈로그나 선택 기능의 준비 상태까지 확인할 수는 없습니다.
브라우저 기능은 `/api/config`로 세션을 초기화합니다.
[API 안내](api-reference.md)를 참고하세요.

| 선택 기능 | 필요한 설정 또는 자원 |
|---|---|
| S3 카탈로그 | 로컬 시드 경로 대신 읽기 권한이 있는 `CATALOG_BUCKET` |
| 공식 상세 | 일치하는 스냅샷의 `DETAILS_LOCAL_PATH` 또는 `DETAILS_BUCKET` |
| 카카오 검색 | 서버 전용 `KAKAO_REST_API_KEY`, `GUIDE_QUOTA_TABLE`, 카탈로그와 `PUBLIC_ORIGIN` |
| AI Guide | `GUIDE_RUNTIME_ARN`, `GUIDE_QUOTA_TABLE`, `PUBLIC_ORIGIN` |
| 실제 도로 경로 | `ROUTING_URL`, `ROUTING_DATA_UPDATED_AT`, `PUBLIC_ORIGIN` |
| 공유 접속 집계 | `PRESENCE_TABLE`, `PUBLIC_ORIGIN` |

AWS 기능에는 해당 자원에 접근할 권한이 필요합니다. 운영 API 시작에는
`ATLAS_SESSION_SECRET`도 필요하며, 개발 환경은 임시 서명 키를 생성합니다.
실제 비밀값은 Git에 넣지 않습니다. 시드 생성만으로 선택 기능이 활성화되지는
않습니다. 지도 타일과 새로운 제공처 응답은 네트워크가 필요합니다.

### 검사와 다음 단계

```bash
npm run check
npm run workshop:check
```

루트 검사는 Node 테스트, Python 배포 테스트, CloudFormation 검사,
`npm audit`, 운영 빌드를 차례로 실행합니다. 첫 실패에서 중단하고
`.local/checks.json`에 결과를 기록합니다. `npm audit`는 레지스트리 접근이
필요합니다. 루트 검사, 워크숍 검사나 공개 워크숍 빌드에서 특정 Python을
사용하려면 `ATLAS_PYTHON`을 지정합니다. 직접 실행하는 `python3` 명령은 계속 PATH를 따릅니다.

워크숍 브라우저 검사는 Playwright/Chromium이 준비된 환경에서
`WORKSHOP_BROWSER_TEST=1`로 별도 활성화합니다. 전체 명령은
[워크숍 안내](../workshop/README.md)를 따릅니다.
로컬 검사는 AWS 자원을 배포하거나 모델을 호출하지 않습니다.

변경 검토는 [CONTRIBUTING.md](../CONTRIBUTING.md), 코드와 설계 기록 탐색은
[구현 참조 색인](reference/INDEX.md), 기존 운영 작업은
[배포 절차](runbooks/deploy.md)를 참고하세요.
