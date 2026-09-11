# 제주 아틀라스 저장소와 GitHub 업로드

작업 기준 경로는 `/home/ec2-user/my-project/jeju-atlas`다. 최신 지도·카탈로그·한영 AI·올레길·이동 경로·3D 탐색·전용 AgentCore 소스와 테스트, 설계 및 배포 문서를 이 경로의 `main`에 통합했다.

## 통합 범위

| 위치 | 내용 | Git 포함 |
|---|---|---|
| `src/`, `public/`, `shared/` | 지도 UI·정적 자산·API 계약 | 포함 |
| `server/` | 웹 서버·카탈로그·AI·경로 API | 포함 |
| `agent/` | 전용 Guide/Tools 소스·의존성 잠금·출처 | 포함 |
| `routing/`, `Dockerfile*` | Valhalla 실행·데이터 검증·이미지 빌드 | 포함 |
| `infra/`, `scripts/` | CloudFormation·배포·운영 검증 | 포함 |
| `tests/`, `docs/` | 회귀 검사·설계·배포·분리 점검 기록 | 포함 |
| `.env.example`, `.nvmrc`, `.gitleaks.toml` | 비밀값 없는 설정 예제·Node 버전·비밀값 검사 규칙 | 포함 |
| `.local/` | 최신 카탈로그·경로 데이터·Python 환경·빌드 및 검증 결과 | 제외 |
| `.local/history/jeju-3d/` | 이전 작업 디렉터리의 운영·검증 기록 | 제외 |
| `.local/separation-audit-20260911/` | AWS·IAM·Git 분리 점검 원본 증거 | 제외 |
| `.local/directory-consolidation-20260911/` | 디렉터리 통합 전후 검증 자료 | 제외 |
| `node_modules/`, `dist/` | 설치 의존성과 생성 빌드 | 제외 |
| `.env*`, 자격 증명·키·데이터 아카이브 | 로컬 설정과 비공개 실행 자료 | 제외, `.env.example`만 포함 |

과거 문서에 나오는 `jeju-3d-mobility`는 통합 전 작업 경로다. 해당 시점의 감사·배포 증거는 원래 내용을 보존했다. 최신 실행 자료는 새 디렉터리에 복사했고 로컬 환경의 이전 경로 연결은 새 경로로 옮겼다.

`agent/tools/data/jeju_pois.json`의 137건은 출처가 기록된 샘플 시드다. 운영 카탈로그 SQLite와 수집한 사진·공공 API 응답은 Git에 넣지 않는다. 공식 매칭 결과와 샘플 기본 필드의 구분은 [데이터 품질 기록](data-quality.md)을 따른다.

## Git 이력과 독립성

이 저장소에는 실제 `.git/` 디렉터리가 있으며 다른 작업 디렉터리의 Git 메타데이터나 object alternates에 의존하지 않는다. 기존 제주 저장소의 모든 브랜치 커밋은 통합 기준 커밋 `fdd1708`에서 도달 가능하다.

이전 브랜치들도 보존했다. 종전 `main`의 위치는 `archive/main-before-consolidation`으로 보관한다. 기존 `jeju-3d`, `jeju-3d-mobility` 폴더는 복구용으로 남겨 두었으며 이후 작업은 이 디렉터리에서 진행한다.

`agentcore-cli`와 그 worktree의 파일·Git 이력은 이 작업의 변경 대상이 아니다. Agent 소스는 이전에 한 번 복사하여 이 저장소에서 독립 관리하고 있다. AWS 리소스 이름 `Jeju3d*`, `jeju-3d`는 운영 식별자이므로 로컬 폴더명 변경에 맞춰 바꾸지 않았다.

## 로컬 실행

```bash
cd /home/ec2-user/my-project/jeju-atlas
# nvm을 사용하는 환경에서는 nvm install && nvm use
npm ci
npm run build
npm run dev
```

다른 터미널에서 API 서버를 실행한다.

```bash
cd /home/ec2-user/my-project/jeju-atlas
cp .env.example .env
# CATALOG_LOCAL_PATH를 준비한 카탈로그로 지정하거나 소유 S3 버킷을 설정
node --env-file=.env server/server.mjs
```

이 EC2 작업 디렉터리에는 기존 로컬 자료가 복사되어 있다. GitHub에서 새로 clone한 환경에는 `.local/`이 없으므로 카탈로그·경로 데이터를 별도로 준비해야 한다. AWS 기반 조회·AI는 해당 리소스에 접근할 역할과 별도 운영 설정이 필요하다. 재현 절차는 [README](../README.md), [Agent 설명](../agent/README.md), [라우터 설명](../routing/README.md)을 따른다.

전체 소스 검사는 다음과 같다. Python의 `boto3`, `requests`와 `cfn-lint`도 설치된 환경에서 실행한다. 로컬 테스트·템플릿 검사·npm audit·빌드를 수행하며 AWS 배포나 모델 호출은 실행하지 않는다.

```bash
npm run check
```

## GitHub에 올리기

GitHub 원격 저장소는 아직 연결하지 않았다. 사용할 소유자와 공개 범위를 선택해 빈 저장소를 준비한 뒤 실제 주소로 연결한다.

```bash
cd /home/ec2-user/my-project/jeju-atlas
git status
git branch --show-current
git remote add origin git@github.com:<OWNER>/jeju-atlas.git
git push -u origin main
```

기존 GitHub 저장소에 연결할 때는 그 저장소의 이력을 먼저 확인한다. 최초 업로드에 `--force`나 `--mirror`는 필요하지 않다. 이 저장소의 `main`에는 기존 제주 작업 이력이 포함되어 있으므로 나머지 보관 브랜치를 별도로 올리지 않아도 해당 커밋이 전달된다.

`.local/`, `.env`, `node_modules/`, 데이터베이스, 경로 타일, 의존성 ZIP·wheel 등은 `.gitignore`로 제외했다. `git add -f`로 제외 규칙을 우회하거나 폴더 전체를 압축해 업로드하지 않는다. 현재 스냅샷과 모든 Git 브랜치 이력에 대한 비밀값 검사는 `.local/directory-consolidation-20260911/`에 기록한다.

Gitleaks 기본 규칙을 사용하며, `tests/api.test.mjs`의 합성 세션 서명값 하나만 정확한 파일 경로와 문자열이 모두 일치할 때 제외한다. 테스트 디렉터리나 과거 커밋 전체를 제외하지 않는다.

```bash
gitleaks git --config=.gitleaks.toml --log-opts="--all --full-history" --redact=100 .
```

이 저장소의 인프라 설정은 현재 배포 계정·리전에 맞춰져 있다. 다른 AWS 계정에서 사용하려면 계정 식별자·도메인·리소스·IAM 설정을 검토해야 한다. 디렉터리 통합과 GitHub 업로드 자체는 기존 AWS 배포를 변경하지 않는다.
