# 01 · 개발 도구와 CLI 설치

도구가 준비된 실습 터미널을 만듭니다. 이 장에서는 AWS 자원을 생성하지 않습니다.
Docker를 사용할 수 있는 ARM64 Linux 호스트를 권장합니다.
x86 호스트는 ARM64 컨테이너 실행 지원을 진행자와 확인합니다.

## 저장소와 Node

제공받은 저장소 루트에서 시작합니다. 현재 EC2 경로는
`/home/ec2-user/my-project/jeju-atlas`이며 다른 호스트에서는 clone한 경로를 사용합니다.

```bash
export ATLAS_REPO="$PWD"
git status --short
cat .nvmrc
```

Node 24.18.1 이상인 **Node 24 계열**이 필요합니다.
nvm이 준비된 호스트에서는 다음과 같이 검증 버전을 선택합니다.

```bash
nvm install
nvm use
node --version
npm ci
```

nvm이 없다면 진행자가 준비한 Node 24를 PATH에 넣습니다.
다른 프로젝트의 시스템 Node를 임의로 교체하지 않습니다.

## Python·uv·AWS CLI·Docker

Python 3.12 이상, uv, AWS CLI v2, Git, Docker를 확인합니다.
CLI Runtime의 로컬 실행과 패키지는 Python 3.14를 사용합니다.

```bash
python3 --version
uv --version
aws --version
git --version
docker version
docker buildx ls
```

`docker version`은 Server 정보까지 나와야 합니다.
CloudShell에 컨테이너 빌드 환경이 있다고 가정하지 말고 제공된 빌드 호스트를 사용합니다.

```bash
uv venv workshop/.venv --python 3.12
uv pip install --python workshop/.venv/bin/python -r workshop/requirements.txt
source workshop/.venv/bin/activate
python --version
cfn-lint --version
uv python install 3.14
```

이후 `python3`는 활성화한 환경에서 실행합니다.
실제 Guide/Tools 의존성은 ARM64/Python 3.14용으로 따로 빌드합니다.

## AgentCore CLI와 Codex

이 과정은 **npm 패키지 `@aws/agentcore` 0.28.1**을 사용합니다.
설정은 `agentcore/agentcore.json`, `agentcore/aws-targets.json`입니다.
예전 Python starter toolkit의 `agentcore configure` 흐름과 혼동하지 않습니다.

기존 전역 CLI를 바꾸지 않고 로컬 도구 폴더에 설치합니다.

```bash
npm install --prefix workshop/.local/tools @aws/agentcore@0.28.1 @openai/codex
export PATH="$ATLAS_REPO/workshop/.local/tools/node_modules/.bin:$PATH"
agentcore --version
codex --version
agentcore create --help
codex --help
```

AgentCore CLI는 `0.28.1`이어야 합니다. 다른 `agentcore`가 잡히면
`command -v agentcore`와 PATH를 확인합니다. Codex의 실제 설치 버전도 기록합니다.
근거: [Codex CLI](https://developers.openai.com/codex/cli/),
[Amazon AgentCore CLI](https://github.com/aws/agentcore-cli).

## Codex 로그인

```bash
codex login
codex login status
```

원격 EC2에서 브라우저 연결이 어려우면 다음 방법을 사용합니다.

```bash
codex login --device-auth
```

인증 파일을 읽거나 저장소에 복사하지 않습니다.
공공 API 키·AWS 액세스 키를 Codex 대화에 붙여 넣지 않습니다.
AWS 인증은 다음 장에서 별도로 확인합니다.

## 확인과 복구

| 상황 | 확인 |
|---|---|
| Node SQLite 오류 | `node --version`이 Node 24인지 확인 |
| `agentcore configure`만 보임 | 예전 CLI가 먼저 잡히는지 확인 |
| Python 3.14 미설치 | 공개 다운로드 접근과 `uv python install 3.14` 확인 |
| Docker 권한 오류 | daemon·실습 사용자 권한을 진행자가 조정 |
| Codex 로그인 실패 | Codex 인증과 AWS 역할 문제를 구분 |

- [ ] 도구 버전을 확인했습니다.
- [ ] AgentCore CLI 0.28.1을 선택했습니다.
- [ ] Codex에 로그인했습니다.

Codex 카드: [01 · 도구 점검](../prompts/01-setup.md)

다음: [02 · AWS 계정과 기존 네트워크](02-aws-environment.md)
