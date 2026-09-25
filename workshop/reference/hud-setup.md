# Codex와 Claude Code HUD 설치 (선택)

HUD는 코딩 세션의 상태를 표시하는 **선택 도구**입니다.\
설치하지 않아도 Agentic AI 코딩 어시스턴트를 사용하고 기본 실습을 완료할 수 있습니다.\
기본 진행에는 [도구별 안내](ai-cli-environments.md)의 Agentic AI 코딩 어시스턴트 실행 명령을 사용합니다.

| 선택한 도구 | HUD 설치 안내 |
|---|---|
| Codex | 이 페이지의 `my-codex-hud` 설치 |
| Claude Code | [사전 구성의 Claude HUD 설치](preconfiguration.md#claude-hud-설치-선택) |
| Kiro CLI | HUD 설치 없이 기존 실행 방법 사용 |

Claude Code의 `jarrodwatts/claude-hud`는 마켓 등록, 플러그인 설치,
세션 리로드, 표시 항목 설정과 상태줄 활성화 순서입니다.\
같은 사전 구성 페이지에서 [AWS 및 기타 플러그인](preconfiguration.md#aws-플러그인-설치)도 준비할 수 있습니다.

## Codex의 my-codex-hud

HUD를 사용하고 싶을 때만 이 페이지를 진행합니다.\
이 안내의 my-hud는 Codex용 [my-codex-hud](https://github.com/whchoi98/my-codex-hud)를 뜻합니다.\
다운로드와 네이티브 모듈 설치는 수업 전이나 실습 후에 진행합니다.
설치 오류가 나거나 시간이 부족하면 HUD를 건너뛰고 본 실습을 계속합니다.

| 구분 | 사용할 이름 |
|---|---|
| 소스 저장소 | `whchoi98/my-codex-hud` |
| Codex 설치 플러그인 | `codex-hud@codex-hud` |
| 설치 스킬 | `codex-hud-install` |
| HUD 실행 명령 | `codex-hud` |
| 교재 검토 기준 | 2026-09-16 공개 main, HUD 0.7.0 |

검토한 소스 커밋은 `bf1e6489345a3ff7ee8a20ad23d56c0657f53516`입니다.\
HUD를 설치한 경우 등록한 소스와 실제 설치 버전을 기록하고 수업 중 임의로 갱신하지 않습니다.

이 도구는 Codex의 터미널 상태를 표시하며 AgentCore Runtime에 설치하지 않습니다.\
Claude Code HUD는 위의 전용 안내를 사용하고, Kiro CLI는 [도구별 안내](ai-cli-environments.md)의 기존 실행 방법을 사용합니다.

## HUD를 사용하려는 경우의 준비

HUD 사용을 선택했다면 먼저 [사전 구성](preconfiguration.md)의 전체 소스, Node, Python과 CLI 설치를 마칩니다.\
참가자 활성화 파일을 같은 Bash에서 불러오고, 실제 `ATLAS_REPO`를 확인합니다.\
워크숍의 Node 24와 Python 환경을 사용합니다.

Codex의 모델, provider와 리전은 [Bedrock 연결 설정](codex-bedrock.md)을 먼저 확인합니다.\
HUD 설치가 이 설정을 대신하거나 Runtime 모델을 변경하는 것은 아닙니다.

- PATH에서 실행할 수 있는 Codex CLI, npm, Python 3.9 이상과 Git이 필요합니다.
- npm 의존성을 내려받을 네트워크 또는 준비한 캐시가 필요합니다.
- `node-pty`의 해당 OS/CPU용 사전 빌드가 없으면 C/C++ 컴파일러, make와 Node 헤더도 준비합니다.
- 이미 정상인 HUD가 있으면 버전과 실제 경로를 확인해 재사용합니다. 플러그인을 중복 등록하지 않습니다.
- 설치 파일은 프로젝트 전용 경로에 두고 사용자 셸 시작 파일, Codex 인증과 전역 npm 설정을 유지합니다.

```bash
cd -- "${ATLAS_REPO:?참가자 활성화 파일을 먼저 불러오세요}" &&
(
  set -e
  command codex --version
  command codex plugin marketplace add --help
  command codex plugin add --help
)
```
`plugin marketplace` 명령을 지원하지 않으면 HUD 설치를 건너뛰고 기존 Codex로 실습합니다.\
HUD가 필요할 때 진행자가 수업 밖에서 지원 버전을 준비합니다.\
로그인 상태는 기존 계정을 사용해 확인하고 인증 파일을 참가자 사이에 복사하지 않습니다.

## 1. 설치 플러그인 등록 (선택)

HUD를 선택했고 아직 등록되지 않은 환경에서만 VSCode Server의 Bash 터미널에 입력합니다.\
이미 같은 플러그인이 있다면 `command codex plugin list --json`으로 등록을 확인합니다.

```bash
cd -- "${ATLAS_REPO:?참가자 활성화 파일을 먼저 불러오세요}" &&
(
  set -e
  command codex plugin marketplace add whchoi98/my-codex-hud --ref main
  command codex plugin add codex-hud@codex-hud
  command codex plugin list --json
)
```
앞의 `command`는 기존 셸 함수가 있더라도 원래 Codex CLI로 등록 명령을 전달합니다.\
등록 결과에서 `codex-hud`를 확인한 뒤 새 Codex 대화를 엽니다.\
플러그인 등록과 HUD 실행 파일 설치는 각각 확인합니다.

## 2. 프로젝트 전용 HUD 설치 (선택)

HUD 설치를 선택한 경우에만 새 Codex 대화에서 실제 `ATLAS_REPO` 경로와 아래 요청을 전달합니다.\
01장 환경 점검과 기본 실습의 완료 조건에는 HUD가 포함되지 않습니다.

```ai-prompt
$codex-hud-install
선택 기능인 Jeju Atlas 워크숍의 Codex HUD를 설치해 주세요.
이 대화에서 지정한 실제 ATLAS_REPO를 프로젝트 루트로 사용합니다.
셸 명령은 첫 줄에서 실제 ATLAS_REPO로 cd한 뒤 실행하세요.

먼저 기존 HUD의 설치 경로와 버전을 확인하고 정상 설치가 있으면 재사용하세요.
새 설치가 필요하면 아래 범위를 사용하세요.
- scope: project
- project-dir: 실제 ATLAS_REPO
- prefix: ATLAS_REPO/workshop/.local/toolchain/codex-hud
- shell: none
- language: ko
- 자동 실행은 설정하지 않습니다.

스킬의 실제 경로에서 설치 계획과 동봉 패키지 체크섬을 확인한 뒤 설치하세요.
사용자 셸 시작 파일, Codex 인증/모델 설정과 전역 npm prefix를 바꾸지 마세요.
다른 참가자의 CLI 프로젝트를 생성하거나 기존 작업을 덮어쓰지 마세요.
기존 내부 ID와 프로젝트 이름을 유지하고 새 팀명이나 ID를 묻지 마세요.

설치 결과의 절대 command와 prefix, 버전, startupFiles를 알려 주세요.
그 command로 --version, doctor --json, demo --language ko --no-color를 확인하세요.
doctor의 종료 코드와 함께 inline.available 및 실제 PTY probe 결과를 확인하세요.
진단을 위해 모델 요청을 보내지 말고, 실제 TTY 화면은 진행자가 별도로 확인할
항목으로 남겨 주세요. 누락 의존성과 실패 결과를 설치 성공으로 표시하지 마세요.
HUD 설치가 실패하면 원인을 기록하고 기존 codex 명령으로 본 실습을 계속하도록 안내하세요.
HUD를 기본 실습의 선행 조건으로 추가하거나 전체 실습 검사를 실행하지 마세요.
```

새 설치의 prefix는 위 프로젝트 경로이며 `startupFiles`는 빈 목록이어야 합니다.\
기본 CLI 프로젝트는 03장에서 만들므로 사전 설치 단계에서 `ATLAS_CLI`를 생성하지 않습니다.

기존 설치를 재사용했다면 다음 예시의 실행 경로를 실제 설치 결과의 `command`로 바꿉니다.\
`install_core.sh`는 이 HUD 설치를 대신하지 않습니다.

## 3. HUD를 설치한 경우의 확인

HUD를 설치한 경우에만 새 실행 파일을 직접 지정합니다.\
세션 기록이 없어도 버전과 demo를 확인할 수 있습니다.

```bash
cd -- "${ATLAS_REPO:?참가자 활성화 파일을 먼저 불러오세요}" &&
(
  set -e
  hud_bin="${ATLAS_REPO:?}/workshop/.local/toolchain/codex-hud/bin/codex-hud"
  test -x "$hud_bin"
  "$hud_bin" --version
  "$hud_bin" doctor --json
  "$hud_bin" demo --language ko --no-color
)
```
0.7.0 기준으로 `inline.available: true`와 `inline.probe.status: ok`를 확인합니다.\
doctor가 정상 종료해도 필드에 의존성 실패가 있으면 설치 확인을 통과한 것으로 기록하지 않습니다.

`hud.autostart.configured: false`는 이 안내의 자동 실행 없는 설정과 일치합니다.\
사용량이 비어 있거나 아직 세션을 기다리는 상태는 설치 실패를 뜻하지 않습니다.

`core.py doctor`는 본 실습 도구 검사이며 HUD의 설치와 실제 화면을 검사하지 않습니다.\
HUD를 확인한 경우 그 결과를 별도로 기록합니다.\
실제 화면 확인이 필요하면 같은 EC2의 TTY에서 확인합니다.
HUD를 설치하지 않았거나 확인을 생략했다면 선택 항목을 생략한 것으로 기록합니다.

## 4. 참가자 프로젝트에서 HUD 실행 (선택)

HUD가 설치되어 있고 사용을 원하는 경우, 03장에서 CLI 프로젝트를 만든 뒤 실행합니다.\
참가자 환경을 활성화한 같은 Bash 터미널을 사용합니다.\
기존 설치를 재사용하는 경우 마지막 명령의 HUD 경로를 설치 결과에 맞춥니다.

```bash
cd -- "${ATLAS_CLI:?03장에서 만든 프로젝트 경로를 확인하세요}" && {
test -f agentcore/agentcore.json &&
"${ATLAS_REPO:?}/workshop/.local/toolchain/codex-hud/bin/codex-hud" start \
  --language ko -- --sandbox workspace-write -a on-request -c 'approvals_reviewer="auto_review"'
}
```
HUD 옵션은 `--` 앞에, Codex 옵션은 뒤에 둡니다.\
프로젝트 경로, Codex 입력과 HUD 표시를 확인하고 새 Bash에서는 참가자 활성화부터 반복합니다.

이 방식은 셸 자동 실행 함수를 등록하지 않으며 기존 `codex` 명령도 유지합니다.\
HUD의 모델/사용량 표시는 로컬 세션 기록이며 배포된 AgentCore 모델 호출 결과가 아닙니다.

## 문제 해결과 인계

HUD 문제 해결은 필요할 때 진행합니다.\
본 실습은 [도구별 안내](ai-cli-environments.md)의 Codex 실행 명령으로 계속할 수 있습니다.

| 현상 | 확인 또는 조치 |
|---|---|
| 플러그인만 있고 명령이 없음 | 2단계의 HUD 실행 파일 설치와 반환된 절대 경로 확인 |
| npm 또는 네이티브 빌드 실패 | Node 버전, 패키지 접근, 컴파일러, make와 Node 헤더 확인 |
| PTY를 열지 못함 | 실제 TTY와 OS/CPU 의존성, doctor의 probe 결과 확인 |
| 다른 설치 버전이 표시됨 | PATH 이름 대신 설치 결과의 절대 command로 실행 |
| HUD가 세션을 기다림 | 프로젝트 경로와 로컬 세션 선택을 확인하고 설치 실패와 구분 |
| 새 Bash에서 명령이 없음 | 참가자 환경 활성화 후 설치 결과의 절대 경로로 실행 |

HUD를 설치하거나 진단한 경우에만 소스/버전, 설치 경로, 진단 결과와 실제 TTY 확인 여부를 남깁니다.\
HUD만 확인하려고 모델 질문을 보내거나 AWS 자원을 생성하지 않습니다.\
설치 제거와 자동 실행 추가는 별도 작업이며 공유 toolchain 폴더를 통째로 삭제하지 않습니다.

관련 자료: [원본 설치 안내](https://github.com/whchoi98/my-codex-hud/blob/main/plugins/codex-hud/README.md), [Codex 플러그인 공식 안내](https://developers.openai.com/codex/plugins/), [01장 환경 확인](../chapters/01-setup.md).
