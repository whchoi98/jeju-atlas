# EC2 사전 점검과 설치

이 준비는 **100~120분 실습 전에** 끝냅니다.\
Amazon Linux 2023의 EC2와 VSCode Server, 기존 VPC와 NAT, 참가자용 AWS 역할을 사용합니다.\
Codex, Claude Code, Kiro CLI 중 하나는 설치와 로그인을 마쳐 둡니다.

명령은 EC2의 **Bash 터미널**에서 실행합니다.\
진행자가 전달한 전체 Git 소스의 루트가 작업 위치입니다.

읽기용 교재 ZIP에는 설치 스크립트가 없습니다.\
소스가 없으면 [EC2 실행 소스 준비](offline-start.md)를 먼저 진행합니다.

## 0. 전체 소스 받기

처음 사용하는 EC2에서는 사전 점검과 설치 명령보다 먼저 실행합니다.\
VSCode Server의 Bash 터미널에 다음 명령을 붙여 넣습니다.

```bash
cd -- "$HOME" && {
mkdir -p /home/ec2-user/my-project
git clone https://github.com/whchoi98/jeju-atlas.git \
  /home/ec2-user/my-project/jeju-atlas
}
```
이미 이 경로에 전체 저장소가 있으면 clone을 반복하지 않고 다음 단계로 이동합니다.\
이후 명령은 `/home/ec2-user/my-project/jeju-atlas`를 기준으로 실행합니다.

## 1. EC2 사전 점검

```bash assistant=codex
cd /home/ec2-user/my-project/jeju-atlas && {
bash workshop/scripts/check_env.sh --assistant codex
}
```

```bash assistant=claude
cd /home/ec2-user/my-project/jeju-atlas && {
bash workshop/scripts/check_env.sh --assistant claude
}
```

```bash assistant=kiro
cd /home/ec2-user/my-project/jeju-atlas && {
bash workshop/scripts/check_env.sh --assistant kiro
}
```
탭에서 사용할 도구를 선택한 뒤 표시된 명령을 그대로 복사합니다.\
선택은 이 페이지의 Node 설치, 도구 준비와 활성화 명령에도 함께 적용됩니다.\
처음 실행에서 실패가 나오면 아래 설치로 해결한 뒤 같은 명령을 다시 실행합니다.\
원하면 이 스크립트를 `~/check-env.sh`로 복사해 사용할 수 있습니다.

| 점검 | 본 실습 기준 |
|---|---|
| OS와 CPU | Linux EC2, x86_64 또는 ARM64 |
| Node.js와 npm | **Node 24.18.1 이상, 24 계열**. Node 20은 저장소 기준을 충족하지 않음 |
| Python과 uv | uv가 찾는 **Python 3.12**, 실행 가능한 uv |
| AgentCore CLI | npm **`@aws/agentcore` 0.28.1**, Python starter toolkit과 구분 |
| AWS | AWS CLI, 현재 실습 역할의 STS 조회 성공 |
| Agentic AI 코딩 어시스턴트 | 선택한 CLI 하나의 버전 확인. 로그인과 auto 모드는 별도 확인 |
| Docker | 설치, 데몬, **현재 셸의 `docker info` 성공**. 본 실습은 CodeZip이므로 선택 |

`[FAIL]`은 필수 항목 실패이며 종료 코드는 1입니다.\
Docker 누락은 기본 검사에서 `[WARN]`, `--containers`를 붙인 검사에서는 실패입니다.\
그룹 이름만으로 Docker 사용 가능 여부를 판단하지 않습니다.

`--offline`은 STS를 생략하고 `[SKIP]`을 표시합니다.\
이 결과로 AWS 인증 성공을 판정하지 않습니다.\
점검기는 설치, 키 읽기와 모델 호출을 하지 않습니다.

## 2. EC2 기본 도구 설치

### Node.js 24

사전 점검에서 `[FAIL] Node.js 20.20.2; need >=24.18.1 within major 24.`처럼 표시되면 먼저 실행합니다.\
이 저장소는 Node 24 계열 24.18.1 이상을 사용하며 `.nvmrc`의 설치 버전은 24.21.0입니다.\
아래 탭에서 사용할 도구를 선택하고 명령 전체를 복사합니다.

```bash assistant=codex
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
bash workshop/scripts/start.sh --assistant codex --node-only &&
source workshop/.local/labs/team01/activate.sh &&
node --version &&
npm --version
}
```

```bash assistant=claude
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
bash workshop/scripts/start.sh --assistant claude --node-only &&
source workshop/.local/labs/team01/activate.sh &&
node --version &&
npm --version
}
```

```bash assistant=kiro
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
bash workshop/scripts/start.sh --assistant kiro --node-only &&
source workshop/.local/labs/team01/activate.sh &&
node --version &&
npm --version
}
```

`--node-only`는 기존 Node 설치 상태를 확인하고 필요하면 프로젝트 전용 경로에 Node 24를 설치합니다.\
Python 3.12, uv와 AgentCore CLI를 설치하기 전에도 실행할 수 있습니다.\
시스템 Node와 기존 npm 전역 경로, 로그인 설정을 교체하지 않습니다.

출력에서 Node가 `v24.21.0` 또는 요구 조건을 충족하는 24 계열인지 확인합니다.\
새 Bash에서는 `activate.sh`를 다시 불러와 같은 Node를 사용합니다.\
이후 아래 Python과 Docker, AgentCore CLI 준비를 계속합니다.

### uv와 Python 3.12

```bash
cd -- "$HOME" && {
curl -LsSf https://astral.sh/uv/install.sh | sh
source ~/.bashrc
export PATH="$HOME/.local/bin:$PATH"
uv python install 3.12
uv python list --only-installed
}
```
uv가 설치한 Python과 시스템 `python3`는 경로가 다를 수 있습니다.\
다음 단계의 준비기가 전용 helper 환경을 만들고 활성화 파일로 같은 Python을 선택합니다.\
시스템 Python을 교체하지 않습니다.

### Docker

```bash
cd -- "$HOME" && {
sudo dnf install -y docker
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
}
```
그룹 변경 후 로그인 세션을 새로 시작합니다.\
실행 중이던 VSCode Server도 기존 그룹을 이어받을 수 있으므로 해당 세션을 갱신합니다.\
현재 터미널에서 바로 확인하려면 `newgrp docker`로 새 Bash를 열고 실행합니다.

```bash
cd -- "$HOME" && {
docker info >/dev/null && printf '%s\n' 'Docker 사용 가능'
}
```
이후 새 셸에서 참가자 `activate.sh`를 다시 불러옵니다.\
Docker는 컨테이너를 다루는 05~14장에 필요합니다.\
기본 CodeZip 실습만 할 때는 Docker 문제를 본 실습의 필수 통과 조건으로 넣지 않습니다.

### AgentCore CLI의 사용자 npm 경로

```bash
cd -- "$HOME" && {
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
grep -Fqx 'export PATH="$HOME/.npm-global/bin:$PATH"' ~/.bashrc || \
  echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
npm install -g @aws/agentcore@0.28.1
}
```
공식 설치는 npm의 `@aws/agentcore`입니다.\
이 교재는 생성 파일과 명령을 맞추기 위해 **0.28.1로 고정**합니다.

다른 버전이나 Python 배포판이 같은 `agentcore` 명령을 가리키면 다음 준비기가 검증된 전용 설치를 사용합니다.\
이미 호환되는 전역 설치가 있으면 재사용합니다.

AWS CLI와 선택한 Agentic AI 코딩 어시스턴트의 설치 또는 로그인이 빠졌다면 진행자가 이 단계에서 완료합니다.\
참가자의 로그인 파일을 다른 EC2에서 복사하지 않습니다.

## 3. Node 24와 참가자 도구 준비

전체 소스 루트에서 한 번 실행합니다.\
참가자마다 독립 랩을 사용하므로 팀명 입력과 변경 단계는 없습니다.\
준비기는 공통 실습 ID `team01`과 프로젝트 `AtlasCliTeam01`을 자동으로 사용합니다.

```bash assistant=codex
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
bash workshop/scripts/start.sh --assistant codex
}
```

```bash assistant=claude
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
bash workshop/scripts/start.sh --assistant claude
}
```

```bash assistant=kiro
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
bash workshop/scripts/start.sh --assistant kiro
}
```
준비기는 `core.py prepare`, `install_core.sh`, 활성화와 `core.py doctor`를 순서대로 실행합니다.\
호환되는 Node와 npm AgentCore CLI는 재사용하고, 누락되거나 맞지 않는 도구는 `workshop/.local/toolchain/`에 준비합니다.

Node는 `.nvmrc`의 24 계열 버전을 공식 체크섬으로 확인합니다.\
uv의 Python 3.12와 helper 패키지는 같은 도구 경로에서 관리합니다.

기존 참가자 프로젝트와 인증을 보존합니다.\
다른 소유자의 폴더나 수정된 활성화 파일은 덮어쓰지 않으므로 오류에 표시된 파일을 확인합니다.

`start.sh`는 AWS 자원을 만들거나 모델을 호출하지 않습니다.\
설치 과정에는 패키지 다운로드가 있으며 첫 설치 시간은 수업 시간 밖에 둡니다.

## 4. 활성화와 전체 앱용 Python 패키지 설치

`start.sh`의 자식 셸은 부모 터미널을 바꾸지 못합니다.\
출력된 절대 경로를 **현재 Bash에서** 불러옵니다.\
새 터미널에서도 같은 명령을 사용합니다.

```bash assistant=codex
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
source /home/ec2-user/my-project/jeju-atlas/workshop/.local/labs/team01/activate.sh
python3 -B "$ATLAS_REPO/workshop/scripts/core.py" doctor --assistant codex
bash "$ATLAS_REPO/workshop/scripts/check_env.sh" --assistant codex
}
```

```bash assistant=claude
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
source /home/ec2-user/my-project/jeju-atlas/workshop/.local/labs/team01/activate.sh
python3 -B "$ATLAS_REPO/workshop/scripts/core.py" doctor --assistant claude
bash "$ATLAS_REPO/workshop/scripts/check_env.sh" --assistant claude
}
```

```bash assistant=kiro
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
source /home/ec2-user/my-project/jeju-atlas/workshop/.local/labs/team01/activate.sh
python3 -B "$ATLAS_REPO/workshop/scripts/core.py" doctor --assistant kiro
bash "$ATLAS_REPO/workshop/scripts/check_env.sh" --assistant kiro
}
```
`core.py doctor`의 `passed: true`와 STS 점검 성공을 확인합니다.\
본 실습 helper에는 boto3와 requests가 필요하며 준비기가 설치합니다.

Runtime도 Python 3.12를 사용합니다.\
기존 환경의 helper가 더 새 Python이어도 Runtime용 Python 3.12를 별도로 찾을 수 있어야 합니다.

**05~14장 전체 앱 또는 교재 유지관리까지 하는 환경만** 다음을 추가합니다.

```bash assistant=codex
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
uv --no-config pip install --python "$ATLAS_PYTHON" -r "$ATLAS_REPO/workshop/requirements.txt"
"$ATLAS_PYTHON" -B -c 'import boto3, requests, yaml; print("helper imports OK")'
cfn-lint --version
bash "$ATLAS_REPO/workshop/scripts/check_env.sh" --assistant codex --containers
}
```

```bash assistant=claude
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
uv --no-config pip install --python "$ATLAS_PYTHON" -r "$ATLAS_REPO/workshop/requirements.txt"
"$ATLAS_PYTHON" -B -c 'import boto3, requests, yaml; print("helper imports OK")'
cfn-lint --version
bash "$ATLAS_REPO/workshop/scripts/check_env.sh" --assistant claude --containers
}
```

```bash assistant=kiro
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
uv --no-config pip install --python "$ATLAS_PYTHON" -r "$ATLAS_REPO/workshop/requirements.txt"
"$ATLAS_PYTHON" -B -c 'import boto3, requests, yaml; print("helper imports OK")'
cfn-lint --version
bash "$ATLAS_REPO/workshop/scripts/check_env.sh" --assistant kiro --containers
}
```
PyYAML 확인 전에 `lab.py prepare`로 앱 사본을 만들지 않습니다.\
시스템 pip에 설치하고 다른 venv에서 실행하는 혼선을 피하도록 `ATLAS_PYTHON`에 설치합니다.

## 5. 수업 시작 조건

진행자는 참가자의 소스 경로, 활성화 경로, 도구 버전, STS와 검사 결과를 기록합니다.\
다음 항목도 수업 전에 확인합니다.

- 해당 계정과 서울 리전의 CDK bootstrap, 참가자 Runtime과 IAM 역할 배포 권한
- Bedrock 단기키를 발급할 리전과 모델 사용 권한, 수업 종료까지 남은 유효 시간
- 선택한 코딩 CLI의 실제 대화와 권한 모드
- `npm`과 `uv` 의존성 설치 및 CodeZip 패키징 시간

코덱스는 `-a on-request -c 'approvals_reviewer="auto_review"'`, 클로드 코드는 `claude --permission-mode auto`를 권장합니다.\
키로는 `kiro-cli chat`으로 준비한 로그인과 도구 권한을 사용합니다.\
지원 모델과 조직 설정에 따라 auto 모드가 제한될 수 있으므로 [Agentic AI 코딩 어시스턴트 환경](ai-cli-environments.md)에서 실제 적용 상태를 확인합니다.\
HUD와 별도 Codex Bedrock provider 설정은 준비된 환경에서 사용하는 선택 자료입니다.

참가자는 [01장](../chapters/01-setup.md)에서 Bedrock 단기키를 숨김 입력합니다.\
키와 발급 리전, 실제 만료 시각은 참가자 `.env`에 저장합니다.\
카카오, 관광공사 TourAPI와 VISIT JEJU 키는 첫 배포 후 [선택 연동](keys-and-integrations.md)에서 추가합니다.

## PyYAML 누락으로 이미 사본 생성이 중단됐다면

같은 `ATLAS_PYTHON`에 전체 requirements를 설치하고 `import yaml`부터 확인합니다.\
`lab.py info --config "$ATLAS_CONFIG"`로 실제 앱 경로를 찾습니다.\
`.local/workshop-binding.json`이 있는 사본은 기존 소유 바인딩과 코드를 확인해 재사용합니다.

이번 오류로 중단됐고 binding이 없는 부분 사본은 같은 참가자 폴더 안에 백업해 둔 뒤 동일한 설정으로 다시 준비합니다.\
백업의 사용자 변경을 대조해 복구하며 참가자 이름을 바꾸거나 폴더를 삭제해 재시도하지 않습니다.

## 공식 자료와 확인 범위

- [uv Python 설치](https://docs.astral.sh/uv/guides/install-python/)
- [AgentCore CLI 시작](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-cli.html)
- [AgentCore CLI 소스](https://github.com/aws/agentcore-cli)

2026-09-24에 공식 설치 안내와 로컬 npm 0.28.1의 Python 3.12 스키마를 대조했습니다.\
로컬 도구 점검은 새 EC2의 설치 성공, AWS 배포 또는 실제 모델 호출 성공을 대신하지 않습니다.
