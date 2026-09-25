# EC2 설치 준비

[스킬 본문](../SKILL.md)에서 설치 준비 또는 복구를 선택했을 때 읽는다.\
설치·다운로드는 본 실습 100분과 여유 20분 전에 끝낸다.\
참조하는 `workshop/` 경로는 발견한 전체 저장소 기준이다.

00장은 안내만 제공하며 참가자 파일을 만들지 않는다.\
00장에서 목표를 확인하고 준비가 필요한 경우 `workshop/reference/preconfiguration.md`를 진행한다.\
준비를 마치면 01장의 환경 활성화와 키 입력으로 바로 이어간다.

## 전체 소스 확보

먼저 현재 폴더와 기존 작업 기록에서 전체 저장소를 찾는다.
`workshop/scripts/core.py`, `lab.py`와 `skills/jeju-atlas-install/SKILL.md`가 있어야 한다.\
전체 소스가 없고 대상 경로도 비어 있을 때만 실행한다.

```bash
cd -- "$HOME" &&
mkdir -p /home/ec2-user/my-project &&
git clone https://github.com/whchoi98/jeju-atlas.git \
  /home/ec2-user/my-project/jeju-atlas
```

이후 명령은 실제 소스 루트에서 실행한다.
교재 ZIP이나 스킬 폴더만 전달받은 상태에서는 실습 스크립트를 실행할 수 없다.\
기존 저장소는 아래 갱신 절차를 사용하고 다시 clone하지 않는다.

## 기존 상태와 선행 도구

전체 준비나 세션 재개는 저장소·참가자·프로젝트·현재 Agentic AI 코딩 어시스턴트를 기존 설정에서 찾는다.\
`workshop/.local/labs/`의 소유 파일과 활성화 파일을 확인하고 기존 작업을 보존한다.\
Node/npm만 준비하는 요청에서는 참가자 탐색을 생략한다.\
여러 기존 프로젝트 중 재개 대상을 식별할 수 없을 때만 확인한다.\
원본 저장소와 참가자 프로젝트를 구분한다.

참가자별 AWS 자원 범위가 분리된 독립 랩에서 새 설치의 기본값은 `team01`, `AtlasCliTeam01`, `codex`다.\
팀 배정이나 이름 선택 절차를 추가하지 않는다.\
재개 시에는 기존 참가자 값·프로젝트 이름·경로를 그대로 사용한다.

기존 clone은 새 준비 명령을 실행하기 전에 전체 소스 루트에서 갱신한다.

```bash
cd -- "${ATLAS_REPO:-/home/ec2-user/my-project/jeju-atlas}" && {
git pull --ff-only origin main
}
```
갱신이 중단되면 기존 작업을 보존하고 오류를 보고한다.\
저장소를 다시 받거나 폴더 삭제·reset으로 해결하지 않는다.

| 항목 | 본 실습 기준 |
|---|---|
| Node/npm | Node 24 계열 24.18.1 이상과 동작하는 npm. 다운로드 버전은 `.nvmrc` |
| Python | 기본 CLI Runtime은 3.12, 심화 Guide/Tools 번들은 3.14. 기존 보조 환경은 3.12 이상 허용 |
| uv | 필수. Runtime과 참가자 Python 의존성 관리에 사용 |
| AgentCore | npm `@aws/agentcore` 0.28.1. 같은 이름의 Python starter CLI는 다른 도구 |
| AWS CLI/IAM | 동작하는 CLI와 EC2 실습 계정의 STS 인증. 배포·CDK·invoke 권한은 별도 확인 |
| Agentic AI 코딩 어시스턴트 | Codex, Claude Code, Kiro CLI 중 선택한 하나와 검증된 모델·provider·인증 |
| Docker | 기본 CodeZip은 선택 사항. 05–14장 컨테이너 과정에서는 필수 |
| HUD | Codex와 Claude Code 각각의 선택 도구. 설치·진단 없이 본 실습 진행 가능 |

기본 준비는 아래 `start.sh` 한 번으로 진행한다.
누락 도구나 환경 오류를 따로 확인해야 할 때만 전체 소스 루트에서 사전 점검을 실행한다.
다음 예시의 기본 경로와 실제 저장소가 다르면 `cd` 대상을 실제 경로로 바꾼다.

```bash
cd -- "${ATLAS_REPO:-/home/ec2-user/my-project/jeju-atlas}" &&
bash workshop/scripts/check_env.sh --assistant codex
```

선택한 도구에 맞춰 `claude` 또는 `kiro`를 지정할 수 있다.
필수 실패는 모두 확인하고 해결한다. `--offline`은 STS 확인을 **생략**하며,
`--containers`는 Docker 설치·현재 셸의 `docker info` 접근 실패를 필수 실패로 처리한다.
docker 그룹 이름이나 systemd 상태만으로 사용 가능하다고 판정하지 않는다.

### Docker 설치 후 소켓 권한 오류

설치가 끝난 뒤 `permission denied ... /var/run/docker.sock`이 나오면 현재 셸의 그룹 적용을 확인한다.\
패키지를 다시 설치하기 전에 아래 블록으로 현재 사용자를 그룹에 등록하고 새 셸을 연다.

```bash
cd -- "$HOME" &&
sudo usermod -aG docker "$(id -un)" &&
newgrp docker
```

`newgrp`는 새 셸을 여는 마지막 명령이다.\
그 뒤의 확인 명령을 같은 `{ ... }` 블록에 이어 붙이지 않는다.\
새 프롬프트가 나타난 뒤 다음 블록을 따로 실행한다.

```bash
cd -- "$HOME" &&
docker info >/dev/null &&
printf '%s\n' 'Docker 사용 가능'
```

성공한 같은 터미널에서 후속 설치와 Agentic AI 코딩 어시스턴트를 실행한다.\
VSCode Server에서 새 터미널만 여는 경우에도 이전 그룹을 이어받을 수 있다.\
그때는 해당 터미널에서 위 두 블록을 수행하고, 이미 실행 중인 코딩 어시스턴트는 그 셸에서 다시 실행한다.\
전용 Node가 필요하면 소스 루트의 `workshop/.local/toolchain/activate-node.sh`를 다시 불러온다.

계속 실패하면 현재 그룹, 등록된 Docker 그룹, 소켓 소유권과 데몬 상태를 읽기 전용으로 확인한다.\
Docker가 준비되지 않아도 기본 CodeZip 과정은 진행할 수 있으며 컨테이너 과정 전에 해결한다.

## 한 번의 준비 명령

새 독립 랩은 위 기본값을 사용한다.\
기존 세션에서 `--assistant`와 `--project-name`을 생략하면 저장된 도구와 프로젝트 이름으로 재개한다.

```bash
cd -- "${ATLAS_REPO:-/home/ec2-user/my-project/jeju-atlas}" &&
bash workshop/scripts/start.sh
```

기존 선택이 없는 새 환경에서는 사용하는 도구를 명시한다.
Codex는 `--assistant codex`, Claude Code는 `--assistant claude`,
Kiro CLI는 `--assistant kiro`를 위 `start.sh`에 붙인다.
Claude Code나 Kiro에서 준비하면서 기본값 Codex를 그대로 저장하지 않는다.

이 명령은 `core.py prepare`, `install_core.sh`, 활성화와 `core.py doctor`를 수행한다.
호환되는 도구는 재사용하고, 필요한 Node·Python·보조 패키지·npm AgentCore CLI는
소유가 확인된 `workshop/.local/toolchain/`에 준비한다.
선행 uv, AWS CLI, 선택한 Agentic AI 코딩 어시스턴트가 없으면 먼저 해당 사전 요구를 해결한다.
`start.sh`가 모든 시스템 도구나 Agentic AI 코딩 어시스턴트 로그인까지 설치한다고 가정하지 않는다.
준비용 `python3`는 먼저 실행 가능해야 하며, 설치 후 Runtime은 Python 3.12를 사용한다.
이 명령에서 기본 doctor가 성공했으면 같은 진단을 다시 실행하지 않는다.
환경 변경이나 명령 실패가 있을 때만 해당 도구를 다시 확인한다.

**명령이 출력한 절대 `activationPath`를 참가자가 사용할 Bash에서 source한다.**
스크립트 내부의 활성화는 부모 터미널에 남지 않는다.
새 `team01`을 저장소 루트에서 준비한 경우의 기본 경로는 다음과 같으며,
실제 출력과 대조한 뒤 사용한다.

```bash
cd -- "${ATLAS_REPO:-/home/ec2-user/my-project/jeju-atlas}" &&
source "$PWD/workshop/.local/labs/team01/activate.sh"
```

참가자가 도구를 바꾸면 전체 `start.sh --assistant claude`처럼 선택한 도구를 명시한다.\
같은 소유 세션을 검증한 뒤 자동 생성된 `.owner.json`과 `activate.sh`만 도구 선택에 맞춰 갱신한다.\
`.env`, 프로젝트, AWS 계정과 CLI 설정은 보존한다.

소유가 다르거나 형식이 잘못되거나 수동 수정된 설정은 덮어쓰지 않는다.\
불일치로 중단되면 해당 차이를 확인하며 소유 JSON을 직접 고치거나 참가자 이름을 바꾸지 않는다.\
설치기의 소유 검사, Node 체크섬, uv `--no-bin` 처리를 유지한다.

## Node만 준비하거나 이전 명령에서 막힌 경우

Node/npm만 필요하면 `start.sh --node-only`로 소유 도구 경로와 Node/npm만 준비한다.\
이 단계는 참가자 폴더를 확인하거나 만들지 않으며 `--assistant` 선택도 저장하지 않는다.\
현재 Bash에서 소스 루트로 이동해 `workshop/.local/toolchain/activate-node.sh`를 source한다.\
전체 준비 후에는 참가자 `activate.sh`를 사용한다.

```bash
cd -- "${ATLAS_REPO:-/home/ec2-user/my-project/jeju-atlas}" && {
bash workshop/scripts/start.sh --node-only &&
source workshop/.local/toolchain/activate-node.sh &&
node --version &&
npm --version
}
```

`Usage`에 `--node-only`가 없으면 소스를 갱신한 뒤 Node 명령을 다시 실행한다.\
Codex로 저장된 세션을 Claude Code로 시작하다 소유 불일치가 발생한 경우에는 다음을 사용한다.

```bash
cd -- "${ATLAS_REPO:-/home/ec2-user/my-project/jeju-atlas}" && {
git pull --ff-only origin main &&
bash workshop/scripts/start.sh --assistant claude &&
source "$PWD/workshop/.local/labs/team01/activate.sh"
}
```
출력된 참가자 활성화 경로가 다르면 확인한 실제 경로를 사용한다.\
`--node-only`만 다시 실행해서는 저장된 도구가 바뀌지 않는다.

## CDK bootstrap 준비

키 입력과 본 실습 전에 소스의 `workshop/scripts/cdk_bootstrap.py`를 helper Python으로 실행한다.\
현재 계정의 CDKToolkit과 `/cdk-bootstrap/hnb659fds/version`이 일치하고 버전 30 이상이어야 한다.\
다음은 기본 참가자 경로의 조회 예시다. 기존 경로가 다르면 기록된 활성화 파일을 사용한다.

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
source workshop/.local/labs/team01/activate.sh &&
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/cdk_bootstrap.py"
}
```

`missing`, `ready: false`이면 조회만 완료됐으며 배포 기반 생성은 남아 있다.
공유 자원 생성 승인이 없다면 로컬 준비를 마친 뒤 진행자에게 해당 계정·리전의 생성을 요청한다.
이미 승인받은 범위는 다시 묻지 않는다.\
프로젝트 생성 전에는 전체 소스의 `workshop/reference/preconfiguration.md` 5-2절에 있는
고정 CDK 버전의 최초 생성 명령을 사용한다.
계정과 생성할 S3·ECR·IAM 자원을 확인하고 기관의 실행 정책을 적용한다.

04장에서 프로젝트의 CDK가 이미 설치됐다면 다음 경로를 사용할 수 있다.
**해당 계정의 공유 bootstrap 생성이 승인됐고 두 자원이 없는 경우에만** 실행한다.
기본 CloudFormation 실행 역할은 `AdministratorAccess`를 사용한다.

```bash
cd -- "${ATLAS_REPO:?기존 참가자 환경을 먼저 활성화하세요}" && {
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/cdk_bootstrap.py" \
  --expected-account "${ATLAS_ACCOUNT:?02장에서 확인한 계정이 필요합니다}" --require-missing &&
cd -- "$ATLAS_CLI/agentcore/cdk" &&
./node_modules/.bin/cdk bootstrap "aws://$ATLAS_ACCOUNT/ap-northeast-2" \
  --termination-protection &&
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/cdk_bootstrap.py" \
  --expected-account "$ATLAS_ACCOUNT"
}
```

마지막 조회의 `status: ready`, `ready: true`를 확인한다.
bootstrap은 EC2마다 생성하지 않고 같은 계정·리전에서 재사용하며 실습 정리 후에도 유지한다.\
조회 거부나 진행 중인 스택을 없는 것으로 간주하거나 자동으로 업그레이드하지 않는다.
AgentCore 0.28.1의 `deploy --dry-run --yes`는 bootstrap을 실제로 변경할 수 있으므로 사용하지 않는다.

## 참가자 키 입력과 작업 위치

활성화 후 사용자가 자신의 대화형 Bash에서 실행한다.

```bash
cd -- "${ATLAS_CLI_PARENT:?참가자 활성화 파일을 먼저 불러오세요}" &&
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/workshop_env.py" configure
```

단기 또는 장기 Bedrock API 키와 모델 호출 리전 두 항목만 입력한다.\
단기키는 발급 리전, 장기키는 해당 키 권한으로 모델을 호출할 수 있는 리전을 사용한다.
키를 AI 대화로 받거나 명령 인자·파이프로 전달하지 않는다.
에이전트는 입력 완료 여부를 다음으로 확인한다.

```bash
cd -- "${ATLAS_CLI_PARENT:?참가자 활성화 파일을 먼저 불러오세요}" &&
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/workshop_env.py" status
```

키 값은 출력하지 않는다. 입력 메타데이터 확인과 모델 접근 성공은 구분한다.
기본 진행은 별도 모델 검사 없이 설정과 배포로 이어간다.
모델 호출이 실패하거나 사용자가 진단을 요청한 경우에만
[모델 인증](model-auth.md)의 선택 검사를 승인 범위에서 수행한다.
카카오·관광공사·VISIT JEJU 키 입력은 첫 배포 뒤로 미룬다.

아직 프로젝트가 없다면 부모 폴더에서 Agentic AI 코딩 어시스턴트를 시작한다.

```bash
cd -- "${ATLAS_CLI_PARENT:?참가자 활성화 파일을 먼저 불러오세요}"
```

에이전트가 AgentCore CLI로 `$ATLAS_CLI`를 생성한다.
기존 프로젝트를 이어갈 때는 활성화 후 실제 `$ATLAS_CLI`로 이동한다.
후속 셸마다 같은 절대 활성화 파일을 source하고 작업 폴더로 다시 이동한다.
각 셸 실행의 첫 줄에 실제 폴더로 이동하는 `cd`를 넣는다.
활성화가 저장소 루트로 이동하므로 프로젝트 명령 전에 작업 위치를 다시 맞춘다.

## 선택한 Agentic AI 코딩 어시스턴트 실행

아래에서 준비된 도구 **하나만** 실행한다.
키 helper로 Agentic AI 코딩 어시스턴트를 감싸서 실행하지 않는다.

| 도구 | 권장 실행 |
|---|---|
| Codex | `codex -a on-request --sandbox workspace-write -c 'approvals_reviewer="auto_review"'` |
| Claude Code | `claude --permission-mode auto` |
| Kiro CLI | `kiro-cli chat` |

수업 전에 각 도구의 `--version`, `--help`와 조직 설정에서 옵션 지원을 확인한다.
Codex는 `on-request`와 `auto_review`를 함께 사용하며 승인 정책과 sandbox를 유지한다.
Kiro에는 모든 도구를 신뢰하는 옵션을 추가하지 않는다.
Claude Code는 **사전 검증된 모델·provider를 유지**한다. auto 모드 지원은 모델,
provider와 조직 설정에 따라 다르므로 지원 여부를 먼저 확인한다.
지원되지 않으면 자동화 모드를 지원하는 사전 구성으로 진행자가 준비하거나 기존 권한 모드로 진행한다.
스킬이 코딩용 모델을 Sonnet 4.6으로 강제하거나 로그인·provider를 바꾸지 않는다.
JejuGuide Runtime의 Sonnet 4.6 설정과 Agentic AI 코딩 어시스턴트의 모델은 별개다.
HUD 설치나 진단을 이 실행의 선행 조건으로 두지 않는다.
HUD를 원하는 경우에만 전체 저장소의 `workshop/reference/hud-setup.md`를 안내한다.

도구 옵션의 근거는 [Codex CLI](https://developers.openai.com/codex/cli/reference),
[Codex 설정](https://developers.openai.com/codex/config-reference),
[Claude 권한 모드](https://code.claude.com/docs/en/permission-modes)다.
2026-09-24 확인 기준이며, 실제 EC2의 설치 버전과 사용 가능 모델을 수업 전에 대조한다.

## Claude Code의 선택 사전 설치

이 절은 **Claude Code 사용자용**이다.
전체 저장소의 `workshop/reference/preconfiguration.md`에서
`선택: Claude Code HUD와 플러그인` 절의 실행 명령을 사용한다.\
설치 전에 현재 목록을 확인하고 이미 정상인 플러그인은 재사용한다.

| 구분 | 설치 대상 |
|---|---|
| 선택 HUD | `jarrodwatts/claude-hud` 마켓의 `claude-hud@claude-hud` |
| AWS 권장 | `aws-core`, `aws-agents` |
| 기타 선택 | `superpowers`, `explanatory-output-style`, `remember`, `data-engineering`, `security-guidance`, `hookify`, `vercel`, `deploy-on-aws`, `ralph-loop` |

AWS 및 기타 플러그인은 `@claude-plugins-official`에서 설치한다.
공식 마켓이 없는 새 환경에서만 먼저 등록한다.\
설치 명령은 `$HOME`에서 시작하는 Bash 블록으로 실행한다.
실패한 항목에서 후속 설치를 멈추고, 이미 설치된 항목을 보존한다.

HUD 설치 뒤 `/reload-plugins`, `/claude-hud:configure`, `/claude-hud:setup`은
**Claude Code 대화창에 한 줄씩** 입력한다.
필요하면 새 Claude Code 세션에서 반영하고 설치 목록과 실제 상태줄을 확인한다.\
Codex의 `my-codex-hud`와 혼동하거나 이 명령을 Kiro에 적용하지 않는다.

설치와 플러그인별 외부 기능 사용은 구분한다.
플러그인을 설치했다는 이유로 새 AWS 자원, Vercel 배포, 긴 반복 작업이나 전체 검사를 추가하지 않는다.
선택 설치 실패는 해당 항목에 기록하며 준비된 Agentic AI 코딩 어시스턴트로 본 실습을 이어 간다.

## 준비 완료 기준

`start.sh`에서 수행한 기본 `core.py doctor` 결과와 출력된 활성화 경로,
작업 폴더·키 입력 상태를 참가자 `RESULTS.md`에 기록한다.
실제 모델 요청, 원격 배포와 응답은 아직 완료로 표시하지 않는다.
`core.py doctor --project`는 테스트 파일을 요구하는 선택 전체 검사다.
준비 단계에서는 실행하지 않으며, 기본 실습을 위해 테스트 파일을 만들도록 요구하지 않는다.

심화 앱은 같은 보조 Python에 `workshop/requirements.txt`를 설치하고
`import yaml`, `cfn-lint`, Docker 접근을 추가 확인한다.
04장을 완료했더라도 새 터미널에서 `ATLAS_REPO`가 비어 있으면 기존 환경부터 불러온다.\
설치나 배포를 처음부터 반복하지 않고 다음처럼 확인한 저장소 경로에서 활성화한다.

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" &&
source workshop/.local/labs/team01/activate.sh
```

이후 같은 Bash에서 05장의 보조 패키지 설치와 app 준비로 이어간다.\
`source`를 별도 괄호 서브셸 안에 넣어 다음 명령에서 환경변수를 잃지 않는다.\
활성화 파일이 없으면 기존 `activationPath`와 저장소 경로를 먼저 확인하고, 미준비 환경에서만 사전 구성을 수행한다.

앱 준비는 `lab.py`를 사용하며 전체 진단은 문제 발생 또는 요청 시에만 수행한다.
02장의 계정과 작업 폴더까지 확인했다면 03–08장 하단 프롬프트를 한 장씩 사용한다.
이미 본문 명령으로 마친 작업은 건너뛰며, 매 장의 완료 상태를 확인한 뒤 다음 카드로 이동한다.
이어서 [배포](deploy.md)를 읽는다.
