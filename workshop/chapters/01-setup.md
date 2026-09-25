# 01. 환경 확인과 Bedrock 키 입력

이 장은 10분입니다.\
사전 구성이 끝난 EC2에서 참가자 폴더와 도구를 확인합니다.

VSCode Server의 **Bash 터미널**을 사용합니다.\
**설치와 로그인은 [사전 구성](../reference/preconfiguration.md)에서 수업 전에 완료합니다.**\
00장은 안내만 제공하므로 읽는 것만으로 참가자 폴더나 활성화 파일이 생기지 않습니다.

## 시작 전에 전체 소스 받기

저장소가 없는 EC2에서만 아래 명령을 **수업 전에 한 번** 실행합니다.\
VSCode Server의 Bash 터미널에서 실행하며, 현재 폴더가 `claude-lab`이어도 지정한 경로에 저장됩니다.

```bash
cd -- "$HOME" && {
mkdir -p /home/ec2-user/my-project &&
git clone https://github.com/whchoi98/jeju-atlas.git \
  /home/ec2-user/my-project/jeju-atlas
}
```
이미 해당 경로에 전체 저장소가 있으면 새 시작 명령을 실행하기 전에 갱신합니다.

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
git pull --ff-only origin main
}
```
갱신이 중단되면 기존 작업을 보존하고 오류를 진행자에게 전달합니다.\
새로 받은 환경은 [사전 구성](../reference/preconfiguration.md)을 마친 뒤 돌아옵니다.\
`/home/ec2-user/my-project/jeju-atlas/workshop/scripts/core.py`가 준비된 뒤 아래 시작 블록을 실행합니다.

## 시작 블록 한 번 실행

사용할 Agentic AI 코딩 어시스턴트의 탭 하나를 선택하고 명령 전체를 복사합니다.\
선택한 탭은 다른 페이지에서도 유지됩니다.

각 참가자는 별도로 제공된 랩을 사용하므로 팀명을 입력하거나 바꾸지 않습니다.\
새 환경은 공통 실습 ID `team01`과 프로젝트 이름 `AtlasCliTeam01`을 자동으로 사용합니다.\
아래 `team01` 경로는 그대로 복사하고, 이미 준비한 설정이 있으면 같은 설정을 이어 씁니다.

```bash assistant=codex
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
bash workshop/scripts/start.sh --assistant codex &&
source /home/ec2-user/my-project/jeju-atlas/workshop/.local/labs/team01/activate.sh &&
python3 "$ATLAS_REPO/workshop/scripts/workshop_env.py" configure
}
```

```bash assistant=claude
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
bash workshop/scripts/start.sh --assistant claude &&
source /home/ec2-user/my-project/jeju-atlas/workshop/.local/labs/team01/activate.sh &&
python3 "$ATLAS_REPO/workshop/scripts/workshop_env.py" configure
}
```

```bash assistant=kiro
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
bash workshop/scripts/start.sh --assistant kiro &&
source /home/ec2-user/my-project/jeju-atlas/workshop/.local/labs/team01/activate.sh &&
python3 "$ATLAS_REPO/workshop/scripts/workshop_env.py" configure
}
```
`start.sh`는 참가자 환경을 준비하고 누락된 핵심 도구를 설치한 뒤 `core.py doctor`를 실행합니다.\
준비가 끝난 환경에서는 기존 도구와 폴더를 재사용합니다.

전체 시작 명령에 `--assistant`를 지정하면 같은 소유 세션에서 해당 도구로 전환합니다.\
기존 `.env`, 프로젝트, AWS 계정과 CLI 설정은 유지됩니다.\
`--assistant`와 `--project-name`을 생략하면 저장된 값을 재사용하며, 새 환경에서 생략한 도구는 Codex입니다.

누락 도구의 다운로드와 설치가 필요하면 사전 구성을 마친 뒤 수업을 시작합니다.\
이 명령은 Runtime을 만들거나 모델을 호출하지 않습니다.

마지막 입력에서 Bedrock 단기키의 발급 리전, 키와 실제 만료 시각을 지정합니다.\
키는 화면에 표시되지 않으며 `$ATLAS_CLI_PARENT/.env`에 권한 `0600`으로 저장됩니다.\
카카오와 관광공사 키는 지금 입력하지 않습니다.

**`source`는 반드시 사용자의 Bash에서 실행합니다.**\
`start.sh`가 출력하는 `activationPath`를 사용하면 됩니다.

스크립트나 AI의 자식 셸은 부모 터미널의 환경을 활성화할 수 없습니다.\
저장소 경로가 다른 환경에서는 진행자가 알려 준 실제 경로로 바꿉니다.

## 통과 조건

doctor의 `passed: true`와 다음 항목을 확인합니다.

| 항목 | 수업 기준 |
|---|---|
| 실행 소스 | 전체 저장소와 137개 샘플 장소 |
| Node와 npm | Node 24 계열 24.18.1 이상과 npm |
| Python과 uv | Runtime Python 3.12, helper Python 3.12 이상, uv |
| Python 보조 패키지 | helper Python에서 boto3와 requests 사용 가능 |
| AgentCore CLI | npm `@aws/agentcore` 0.28.1 |
| AWS와 AI 도구 | AWS CLI와 선택한 Agentic AI 코딩 어시스턴트 하나 |

Node 20 이상, Python 3.10 이상이라는 일반 점검만으로 이 수업의 준비가 끝나지는 않습니다.\
Docker는 사전 설치 항목이며 핵심 CodeZip 경로의 통과 조건에는 포함하지 않습니다.

`lab.py doctor`는 전체 앱을 위한 심화 점검입니다.\
도구 검사 통과는 AWS 배포 권한이나 실제 모델 응답 성공을 뜻하지 않습니다.

활성화하면 `ATLAS_REPO`는 원본 소스, `ATLAS_CLI_PARENT`는 참가자 폴더, `ATLAS_CLI`는 그 아래 만들 AgentCore 프로젝트를 가리킵니다.\
참가자 `.env`와 `RESULTS.md`는 `ATLAS_CLI_PARENT`에 두어 배포 코드와 분리합니다.\
프로젝트는 03장의 AI가 생성합니다.

## 새 Bash의 환경 복원

새 터미널은 앞 터미널의 변수를 이어받지 않습니다.\
아래 명령을 먼저 실행한 뒤 다음 장의 터미널 블록을 복사합니다.\
각 블록의 첫 `cd`는 해당 작업의 시작 위치를 맞춥니다.

```bash
cd /home/ec2-user/my-project/jeju-atlas && {
source workshop/.local/labs/team01/activate.sh
}
```
## 막혔거나 새 터미널을 열었다면

`Usage`에 `--node-only`가 없으면 소스를 갱신한 뒤 선택한 Node 탭 명령을 다시 실행합니다.\
Codex로 저장된 세션을 Claude Code로 전환할 때는 [소스 갱신 → 전체 시작 → 참가자 활성화](../reference/preconfiguration.md#이전-소스와-도구-선택-오류)를 따릅니다.\
소유 JSON이나 참가자 이름은 직접 바꾸지 않습니다.

새 Bash에서는 출력된 절대 경로의 `activate.sh`를 다시 `source`합니다.\
스크립트가 없으면 [실행 소스 위치 확인](../reference/offline-start.md#python-스크립트가-없을-때)을 따릅니다.

> **“전체 실습 소스가 없습니다”가 표시된다면**\
> 명령의 `repo=`가 가리키는 폴더에 `workshop/scripts/core.py`가 있는지 확인합니다.\
> 전체 Git 저장소를 아직 받지 않았다면 먼저 소스를 받고, 다른 위치에 받았다면 실제 경로를 지정합니다.

`workshop/site/`, `dist/workshop/`와 교재 ZIP에는 실행 소스가 없습니다.\
검사에 실패하면 누락 항목과 재개 위치를 진행자에게 전달합니다.

선택한 Agentic AI 코딩 어시스턴트의 기존 로그인과 모델 설정을 사용합니다.\
자동 검토 모드는 진행자가 사용할 모델과 provider 조합으로 수업 전에 확인합니다.

Codex auto-review와 Claude Code auto mode 실행은 [03장](03-codex.md), 지원 조건과 문제 해결은 [도구별 안내](../reference/ai-cli-environments.md)를 참고합니다.\
[HUD](../reference/hud-setup.md)는 수업 시간 밖의 선택 항목입니다.

선택 프롬프트: [환경 진단](../prompts/01-setup.md)

다음: [02. 계정과 작업 폴더](02-aws-environment.md)
