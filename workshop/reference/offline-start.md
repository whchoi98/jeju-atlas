# PC에서 교재 열기

PC에서는 교재를 읽고 명령은 EC2의 VSCode Server 터미널에서 실행합니다.\
PC에 AWS 키나 CLI 로그인 파일을 복사할 필요가 없습니다.

**교재 ZIP은 실행 소스 묶음이 아닙니다.**\
EC2에는 전체 Git 저장소와 필요한 수정 패치를 별도로 전달해야 합니다.

## 내려받을 파일

`workshop/site/` 전체 또는 다음 ZIP을 내려받습니다.

```text
workshop/.local/downloads/jeju-atlas-workshop-handbook.zip
```

ZIP을 압축 해제한 뒤 `jeju-atlas-workshop/index.html`을 엽니다.\
`chapters`, `reference`, `assets`, `prompts` 폴더를 함께 유지합니다.\
HTML 하나만 복사하면 글꼴, 스타일과 탐색 기능이 빠집니다.

VSCode Server 파일 탐색기에서 ZIP을 내려받거나 진행자가 안내한 파일 전송 방법을 사용합니다.\
운영 사이트의 다운로드 파일은 별도 배포가 끝난 버전일 수 있으므로 이번에 생성한 로컬 교재의 제목과 120분 진행표를 확인합니다.

## 시간표와 프롬프트

본 실습은 00~04장의 100분과 여유 시간 20분입니다.\
05장 이후는 선택하는 심화 자료입니다.\
각 장의 프롬프트 복사 버튼으로 내용을 복사해 선택한 Agentic AI 코딩 어시스턴트에 전달합니다.

Codex, Kiro CLI, Claude Code 중 준비된 도구 하나를 사용합니다.\
셸 명령은 별도 Bash 터미널에, 프롬프트 카드는 해당 AI의 대화창에 전달합니다.

## EC2의 실행 소스 준비

`/home/ec2-user/my-project/jeju-atlas`는 이 교재의 참가자 경로 예시입니다.\
이미 다른 경로에 전체 소스가 있으면 실제 경로를 사용합니다.

저장소가 없는 EC2에서는 실습 시작 전에 다음 명령으로 전체 소스를 받습니다.\
이미 지정한 경로에 받았다면 clone을 반복하지 않습니다.

```bash
cd -- "$HOME" && {
mkdir -p /home/ec2-user/my-project
git clone https://github.com/whchoi98/jeju-atlas.git \
  /home/ec2-user/my-project/jeju-atlas
}
```
필요한 수정 패치와 전용 도구 설치는 [진행자 준비](facilitator.md)를 따릅니다.\
기존 Claude 프로젝트 폴더는 보존합니다.

01장의 core.py prepare가 출력한 `activationPath`를 기록하고 새 Bash마다 `source /절대/경로/activate.sh`로 환경을 복원합니다.\
ATLAS_REPO가 비어 있거나 core.py가 없으면 교재 다운로드만으로 해결된 상태가 아닙니다.

## Python 스크립트가 없을 때

준비기 파일명은 `workshop/scripts/core.py`입니다.\
`core.py` 하나만 별도로 만들거나 복사하면 연결된 모듈과 장소 데이터가 빠질 수 있으므로 전체 실행 소스와 현재 경로부터 확인합니다.

| 확인한 위치 | Python 파일과 실행 방법 |
|---|---|
| 원본 Git 저장소의 `workshop/scripts/` | `core.py`, `lab.py`, `model_config.py`, `model_check.py` 등 실행 도구 |
| `workshop/site/` 또는 `dist/workshop/` | 생성한 HTML 교재. 준비 도구를 실행하는 폴더가 아님 |
| 다운로드한 교재 ZIP | 읽기용 HTML과 프롬프트. `scripts/`와 Python 실행 소스 제외 |
| `ATLAS_APP/workshop/` | 참가자 앱의 공개 교재 빌드에 필요한 일부 파일만 복사됨. 준비 명령은 원본 `ATLAS_REPO` 사용 |

원본 저장소가 이미 있다면 실제 경로를 지정해 다음을 실행합니다.\
이 명령은 파일과 샘플 데이터만 확인하며 설치, AWS 조회와 모델 호출은 하지 않습니다.

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" &&
(
  set -e
  repo="${ATLAS_REPO:?원본 Git 저장소의 실제 경로를 지정하세요}"
  test -f "$repo/workshop/scripts/core.py"
  python3 -B "$repo/workshop/scripts/core.py" source --repo "$repo"
)
```
Git 작업 폴더에서 파일이 없으면 `git status --short -- workshop/scripts`로 작업 중 삭제나 변경을 확인합니다.\
변경 파일을 덮어쓰는 reset이나 강제 갱신을 하지 않습니다.

원본 소스가 없는 경우에는 기존 폴더를 유지하고 새 경로에 전체 저장소를 받습니다.\
아래 경로가 이미 존재하면 다른 빈 경로를 지정합니다.

```bash
cd -- "$HOME" &&
(
  set -e
  dst=/home/ec2-user/my-project/jeju-atlas-source
  test ! -e "$dst" && test ! -L "$dst"
  GIT_TERMINAL_PROMPT=0 git clone https://github.com/whchoi98/jeju-atlas.git "$dst"
  python3 -B "$dst/workshop/scripts/core.py" source --repo "$dst"
)
```
확인 뒤 [01장](../chapters/01-setup.md)의 prepare와 활성화를 새 원본 경로에서 진행합니다.\
Node 24, Python 3.12, 보조 패키지와 npm AgentCore CLI 설치는 [사전 구성](preconfiguration.md)에서 먼저 완료합니다.\
전체 앱은 PyYAML 확인 후 사본을 만듭니다.

심화 참가자 사본 준비는 Git 추적 파일을 사용하므로 `.git`이 있는 clone을 사용합니다.\
[실행 소스 저장소](https://github.com/whchoi98/jeju-atlas)와 [공개 core.py 원본](https://github.com/whchoi98/jeju-atlas/blob/main/workshop/scripts/core.py)을 참고하세요.

2026-09-16 확인에서 공개 `main`의 준비기와 주요 helper 파일은 이 저장소의 파일과 일치했습니다.\
이 기록은 참가자의 현재 EC2 폴더를 검사한 결과를 대신하지 않습니다.

## 교재 다시 만들기

EC2의 원본 저장소 루트에서 실행합니다.

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" &&
(
  set -e
  cd -- "${ATLAS_REPO:?참가자 activate.sh를 먼저 source하세요}"
  npm ci
  npm run workshop:build
  npm run workshop:package
)
```
ZIP과 `.zip.sha256` 파일이 같은 폴더에 생성됩니다.\
묶음에는 교재와 정적 자산, 프롬프트 카드만 포함됩니다.

참가자 설정, 데이터베이스, 로그인 파일과 배포 상태는 포함하지 않습니다.\
`workshop/scripts/core.py`, 설치 스크립트와 장소 JSON도 이 묶음에는 포함되지 않습니다.

## 오프라인 사용

파일로 연 교재는 인터넷 없이 읽을 수 있습니다.\
HTTPS 사이트에서는 저장 완료 후 PWA로 설치해 읽을 수도 있습니다.\
참가자가 배포한 교재의 주소는 실제 App 스택에서 조회한 기본 CloudFront URL 뒤의 `/workshop/`입니다.

`lab.py url --config "$ATLAS_CONFIG"`의 `workshopUrl`을 사용합니다.\
ACM 발급이나 DNS/사용자 도메인 등록은 필요하지 않습니다.\
AWS 명령과 실제 모델 호출은 연결된 EC2 터미널에서 수행해야 합니다.

교재가 오프라인으로 열린다고 모델이나 AWS 실습도 오프라인으로 실행되는 것은 아닙니다.\
원본 운영 URL은 별도 배포된 교재이며, 로컬 패치만 적용해도 그 사이트가 갱신되는 것은 아닙니다.

| 위치 | 역할 |
|---|---|
| PC의 교재 | 읽기, 검색, 명령과 프롬프트 복사 |
| EC2의 원본 저장소 | 실습 스크립트와 데이터 원본 |
| EC2의 참가자 폴더 | Agentic AI 코딩 어시스턴트가 수정하고 AgentCore CLI가 배포할 프로젝트 |

읽음 표시는 브라우저 기록입니다.\
실습 완료는 터미널 결과와 AWS 상태로 확인합니다.
