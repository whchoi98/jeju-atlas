# EC2 사전 점검과 설치

이 페이지에서는 **소스 받기, 도구 설치, 참가자 환경 준비와 점검**을 수업 전에 마칩니다.\
실습 목표와 시간표는 [00. 이번 실습에서 만들 것](../chapters/00-orientation.md)에서 확인합니다.

**준비를 마치면 [01. 환경 활성화와 Bedrock 키 입력](../chapters/01-setup.md)으로 바로 이동합니다.**\
이미 이 준비를 끝낸 환경도 01장부터 이어가면 됩니다.

진행자가 제공한 Amazon Linux 2023 EC2와 VSCode Server, 기존 VPC와 NAT, 참가자용 AWS 역할을 사용합니다.\
명령은 EC2의 **Bash 터미널**에서 실행합니다.\
Codex, Claude Code, Kiro CLI 중 사용할 도구 하나의 설치와 로그인도 이 단계에서 완료합니다.

## 0. 전체 소스 받기

저장소가 없는 EC2에서만 사전 점검과 설치 명령보다 먼저 실행합니다.\
VSCode Server의 Bash 터미널에 다음 명령을 붙여 넣습니다.

```bash
cd -- "$HOME" && {
mkdir -p /home/ec2-user/my-project &&
git clone https://github.com/whchoi98/jeju-atlas.git \
  /home/ec2-user/my-project/jeju-atlas
}
```
이미 이 경로에 전체 저장소가 있으면 **새 명령을 실행하기 전에 소스를 갱신합니다.**

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
git pull --ff-only origin main
}
```
갱신이 중단되면 기존 작업을 보존하고 오류를 진행자에게 전달합니다.\
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
선택한 탭은 다른 명령 묶음과 다음 페이지에서도 유지됩니다.\
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

## 2. 누락된 EC2 도구 설치

사전 점검에서 준비가 필요한 항목만 설치합니다.\
이미 기준을 충족한 항목은 3절의 참가자 환경 준비로 이어갑니다.

### Node.js 24

사전 점검에서 `[FAIL] Node.js 20.20.2; need >=24.18.1 within major 24.`처럼 표시되면 먼저 실행합니다.\
이 저장소는 Node 24 계열 24.18.1 이상을 사용하며 `.nvmrc`의 설치 버전은 24.21.0입니다.\
아래 탭에서 사용할 도구를 선택하고 명령 전체를 복사합니다.

```bash assistant=codex
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
bash workshop/scripts/start.sh --assistant codex --node-only &&
source workshop/.local/toolchain/activate-node.sh &&
node --version &&
npm --version
}
```

```bash assistant=claude
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
bash workshop/scripts/start.sh --assistant claude --node-only &&
source workshop/.local/toolchain/activate-node.sh &&
node --version &&
npm --version
}
```

```bash assistant=kiro
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
bash workshop/scripts/start.sh --assistant kiro --node-only &&
source workshop/.local/toolchain/activate-node.sh &&
node --version &&
npm --version
}
```

`--node-only`는 소유가 확인된 `workshop/.local/toolchain/`과 Node/npm만 준비합니다.\
참가자 폴더를 확인하거나 만들지 않으며, `--assistant`로 지정한 도구를 참가자 설정에 저장하지 않습니다.\
Python 3.12, uv와 AgentCore CLI를 설치하기 전에도 실행할 수 있습니다.\
시스템 Node와 기존 npm 전역 경로, 로그인 설정을 교체하지 않습니다.

출력에서 Node가 `v24.21.0` 또는 요구 조건을 충족하는 24 계열인지 확인합니다.\
새 Bash에서는 소스 루트로 이동해 `workshop/.local/toolchain/activate-node.sh`를 다시 불러와 같은 Node를 사용합니다.\
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
전용 Node를 설치했다면 새 셸에서 소스 루트의 `workshop/.local/toolchain/activate-node.sh`를 다시 불러옵니다.\
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
새 환경은 공통 실습 ID `team01`과 프로젝트 `AtlasCliTeam01`을 자동으로 사용합니다.

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

기존 세션에서 `--assistant`와 `--project-name`을 생략하면 저장된 도구와 프로젝트 이름으로 재개합니다.\
새 환경에서 생략한 도구의 기본값은 Codex입니다.

다른 도구의 탭으로 전체 `start.sh`를 실행하면 같은 소유 세션의 도구 선택을 전환합니다.\
전환은 자동 생성된 `.owner.json`과 `activate.sh`만 갱신하며 `.env`, 프로젝트, AWS 계정과 CLI 설정은 보존합니다.\
소유가 다르거나 형식이 잘못된 설정, 수동 수정된 생성 파일은 덮어쓰지 않으므로 오류에 표시된 파일을 확인합니다.

`start.sh`는 AWS 자원을 만들거나 모델을 호출하지 않습니다.\
설치 과정에는 패키지 다운로드가 있으며 첫 설치 시간은 수업 시간 밖에 둡니다.

## 4. 활성화와 AWS 자격증명 확인

`start.sh`의 자식 셸은 부모 터미널을 바꾸지 못합니다.\
출력된 절대 경로를 **현재 Bash에서** 불러옵니다.\
새 터미널에서도 같은 명령을 사용합니다.

```bash assistant=codex
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
source /home/ec2-user/my-project/jeju-atlas/workshop/.local/labs/team01/activate.sh &&
bash "$ATLAS_REPO/workshop/scripts/check_env.sh" --assistant codex
}
```

```bash assistant=claude
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
source /home/ec2-user/my-project/jeju-atlas/workshop/.local/labs/team01/activate.sh &&
bash "$ATLAS_REPO/workshop/scripts/check_env.sh" --assistant claude
}
```

```bash assistant=kiro
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
source /home/ec2-user/my-project/jeju-atlas/workshop/.local/labs/team01/activate.sh &&
bash "$ATLAS_REPO/workshop/scripts/check_env.sh" --assistant kiro
}
```
`start.sh`에서 실행한 `core.py doctor`의 `passed: true`와 위 STS 점검 성공을 확인합니다.\
이미 성공한 doctor를 별도로 반복하지 않습니다.\
본 실습 helper에는 boto3와 requests가 필요하며 준비기가 설치합니다.

Runtime도 Python 3.12를 사용합니다.\
기존 환경의 helper가 더 새 Python이어도 Runtime용 Python 3.12를 별도로 찾을 수 있어야 합니다.

## 5. CDK bootstrap 준비

새 AWS 계정에서는 **서울 리전의 CDK 배포 기반을 한 번 준비**해야 합니다.\
Node와 AWS 자격증명 점검이 통과해도 이 준비가 없으면 04장에서 배포가 중단됩니다.

다음 명령은 현재 계정의 `CDKToolkit` 스택과 `/cdk-bootstrap/hnb659fds/version`을 조회합니다.\
자원을 만들거나 바꾸지 않으며, AgentCore CLI 0.28.1이 요구하는 bootstrap 버전 **30 이상**인지 확인합니다.

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
source workshop/.local/labs/team01/activate.sh &&
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/cdk_bootstrap.py"
}
```

`ready: true`이면 다음 절로 이동합니다.\
스택과 버전 파라미터가 모두 없을 때만 아래의 처음 생성 절차를 사용합니다.\
기존 스택의 버전이 낮거나 조회 권한이 부족한 경우에는 진행자가 기존 설정과 권한부터 확인합니다.

### 진행자: 새 독립 실습 계정에서 처음 생성

이 명령은 **해당 실습 계정의 관리자 권한으로 수업 전에** 실행합니다.\
자산용 S3 버킷과 ECR 저장소, CDK 배포용 IAM 역할, 버전 SSM 파라미터를 생성합니다.\
아래의 CloudFormation 실행 역할에는 `AdministratorAccess`를 지정합니다.\
기관에서 승인한 별도 실행 정책이 있으면 해당 정책 ARN으로 바꿉니다.

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
source workshop/.local/labs/team01/activate.sh &&
atlas_bootstrap_account="${ATLAS_ACCOUNT:-$(aws sts get-caller-identity --query Account --output text)}" &&
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/cdk_bootstrap.py" \
  --expected-account "$atlas_bootstrap_account" --require-missing &&
npx --yes --package aws-cdk@2.1126.0 cdk bootstrap \
  "aws://$atlas_bootstrap_account/ap-northeast-2" \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess \
  --termination-protection &&
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/cdk_bootstrap.py" \
  --expected-account "$atlas_bootstrap_account"
}
```

계정이 맞지 않거나 기존 bootstrap 자원이 있으면 생성 전에 멈춥니다.\
기존 스택을 자동으로 갱신하거나 삭제하는 복구 명령이 아닙니다.\
고정한 CDK CLI의 표준 템플릿은 bootstrap 버전 32를 제공합니다.

bootstrap은 계정과 리전의 공용 배포 기반이므로 실습 Runtime 정리 후에도 유지합니다.\
04장 프롬프트의 Runtime 배포 승인과 별도로, 이 사전 준비를 먼저 완료합니다.

## 6. 준비 완료 후 01장으로 이동

`start.sh`의 `passed: true`, AWS 자격증명 성공과 bootstrap의 `ready: true`를 확인했다면 EC2 준비가 끝났습니다.\
[01. 환경 활성화와 Bedrock 키 입력](../chapters/01-setup.md)에서 같은 참가자 환경을 불러오고 키를 입력합니다.\
사전 구성으로 돌아가 설치와 성공한 점검을 다시 실행할 필요는 없습니다.

진행자는 [수업 전 준비 가이드](facilitator.md)에서 배포 권한, CDK bootstrap과 Bedrock 사용 조건을 확인합니다.\
선택한 도구의 로그인과 권한 모드는 [Agentic AI 코딩 어시스턴트 환경](ai-cli-environments.md)을 따릅니다.

---

## 선택: 05~14장과 교재 유지관리용 Python 패키지

핵심 과정만 진행한다면 위의 01장 링크로 이동합니다.\
전체 지도 앱이나 교재 유지관리까지 하는 환경에서만 다음 패키지를 추가합니다.

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

## 이전 소스와 도구 선택 오류

`--node-only`를 실행했는데 `Usage`만 나오고 도움말에 해당 옵션이 없으면 소스가 오래된 상태입니다.\
0절의 소스 갱신 후 선택한 Node 탭 명령을 다시 실행합니다.

Codex로 저장된 세션을 Claude Code로 사용하다 소유 불일치가 발생했다면 다음을 실행합니다.\
소스를 갱신하고 **전체 시작 명령**으로 도구를 전환한 뒤 같은 참가자 환경을 현재 Bash에 불러옵니다.

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
git pull --ff-only origin main &&
bash workshop/scripts/start.sh --assistant claude &&
source workshop/.local/labs/team01/activate.sh
}
```
Node 전용 설치만으로는 저장된 도구가 바뀌지 않습니다.\
소유 JSON을 직접 편집하거나 참가자 이름을 바꾸지 않습니다.\
갱신이나 소유 검증이 중단되면 기존 폴더와 작업을 보존하고 오류를 진행자에게 전달합니다.

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
- [AWS CDK 환경 bootstrap](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-env.html)
- [CDK bootstrap 명령과 실행 정책](https://docs.aws.amazon.com/cdk/v2/guide/ref-cli-cmd-bootstrap.html)

2026-09-24에 공식 설치 안내와 로컬 npm 0.28.1의 Python 3.12 스키마를 대조했습니다.\
2026-09-25에 CLI 0.28.1의 bootstrap 최소 버전 30과 CDK CLI 2.1126.0의 템플릿 버전 32를 대조했습니다.\
로컬 도구 점검은 새 EC2의 설치 성공, AWS 배포 또는 실제 모델 호출 성공을 대신하지 않습니다.
