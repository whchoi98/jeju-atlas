# 01. 환경 진단

환경 활성화나 키 입력에서 문제가 생겼을 때 사용하는 선택 카드입니다.\
키나 로그인 파일을 첨부하지 않습니다.

```ai-prompt
제주 가이드 워크숍의 환경 활성화와 키 입력 문제를 진단해 주세요. 읽기 전용 점검을 승인합니다.
적용되는 AGENTS.md와 workshop/AGENTS.md, skills/jeju-atlas-install/SKILL.md를 읽으세요.
ATLAS_REPO 또는 /home/ec2-user/my-project/jeju-atlas에서 전체 소스를 찾으세요.
전체 준비를 마친 세션은 activate.sh와 비밀값 없는 소유 설정에서 작업 경로를 확인하세요.
00장은 안내만 제공하므로 읽었다는 이유로 참가자 파일이 생성됐다고 가정하지 마세요.
기존 참가자와 프로젝트를 재사용하고 같은 경로를 반복해서 묻지 마세요.
모든 터미널 실행은 올바른 cd로 시작하세요. 새 셸에서는 확인한 저장소 절대 경로로
이동하고 준비 단계에 맞는 활성화 파일을 source한 뒤 필요한 작업 폴더로 다시 이동하세요.
경로 이동이나 활성화가 실패하면 그 셸의 후속 명령을 실행하지 마세요.

설치는 사전 구성에서 완료하며 01장은 기존 환경 활성화와 비공개 키 입력만 수행합니다.
01장의 공통 명령은 세 도구 모두 저장된 선택을 이어 쓰므로 도구를 다시 선택하도록 요구하지 마세요.
사전 구성의 전체 start.sh는 참가자 준비, 누락 도구 설치와 doctor를 수행합니다.
새 설정의 기본값은 team01, AtlasCliTeam01, codex이며 팀명 선택을 요청하지 마세요.
기존 세션에서는 --assistant와 --project-name을 생략하면 저장된 값을 재사용합니다.
참가자가 다른 도구를 선택했다면 전체 start.sh --assistant claude처럼 명시합니다.
같은 소유 세션을 검증한 뒤 생성된 .owner.json과 activate.sh만 도구 선택에 맞춰 갱신하며,
.env, 프로젝트, AWS 계정과 CLI 설정은 유지합니다.
start.sh --node-only는 소유 도구 경로와 Node/npm만 준비하며 참가자 폴더를 확인하거나 만들지 않습니다.
Node 전용 활성화는 workshop/.local/toolchain/activate-node.sh이며 도구 선택을 저장하지 않습니다.

Usage에 --node-only가 없으면 원본 저장소에서 git pull --ff-only origin main 후 재시도를 안내하세요.
저장된 codex를 claude로 전환하다 소유 불일치가 났다면 소스 갱신 후
전체 bash workshop/scripts/start.sh --assistant claude와 참가자 activate.sh의 source를 안내하세요.
이 읽기 전용 진단에서는 갱신이나 전환을 실행하지 말고 참가자 Bash용 명령을 알려 주세요.
소유가 다르거나 형식이 잘못되거나 수동 수정된 설정은 덮어쓰지 마세요.
소유 JSON 직접 편집, 다른 참가자 이름, 폴더 삭제나 저장소를 다시 받는 방법으로 해결하지 마세요.
실행 소스가 없는 읽기용 교재 ZIP이나 workshop/site를 작업 저장소로 사용하지 마세요.
AI가 활성화한 자식 셸은 사용자의 Bash를 바꾸지 못합니다.
사용자에게 실제 activationPath를 source하는 한 줄을 알려 주세요.

사전 구성의 core.py doctor는 한 번이면 됩니다. 이미 성공했다면 반복하지 마세요.
실패하거나 결과가 없을 때 활성화한 셸에서 다음을 사용합니다.
python3 "$ATLAS_REPO/workshop/scripts/core.py" doctor --assistant "$ATLAS_ASSISTANT"
전체 소스와 샘플 137개, Node 24 계열 24.18.1 이상, npm, uv, Python 3.12,
helper의 boto3/requests, AWS CLI, npm @aws/agentcore 0.28.1과 선택한 Agentic AI 코딩 어시스턴트를 확인하세요.
Docker는 사전 설치하되 CodeZip 핵심 과정에서는 요구하지 않습니다.
lab.py doctor는 심화 점검이며 core.py doctor와 바꾸어 사용하지 마세요.
기본 진단에 core.py doctor --project나 테스트 파일 작성을 추가하지 마세요.

설치가 필요하면 workshop/reference/preconfiguration.md에서 이어갈 항목을 알려 주세요.
설치와 로그인 시간은 100분 핵심 과정 밖입니다. 현재 로그인과 AI 모델 설정을 유지하세요.
HUD는 선택 사항입니다. 참가자가 선택하기 전에는 설치하거나 실행하지 마세요.
긴 Codex 설정을 필수 준비로 추가하지 마세요.
auto-review와 auto mode는 진행자가 수업 전에 모델과 provider 조합으로 검증합니다.
지원되지 않으면 해당 도구의 일반 승인 모드를 안내하고 실제 모드를 기록하세요.
자동 검토를 위해 수업 중 모델이나 provider를 바꾸지 마세요.
.env와 로그인 파일을 읽거나 출력하지 말고, 키 입력을 대화창으로 받지 마세요.
키 입력은 발급 리전과 Bedrock 단기키 두 항목만 받으며 만료 시각을 묻지 않습니다.
이 진단에서는 도구 설치, AWS 변경과 모델 호출을 실행하지 마세요.
별도 모델 사전 호출, agentcore dev와 전체 테스트는 기본으로 생략합니다.
추가 검사는 실제 오류, 위험한 기능 변경 또는 명시적 요청이 있을 때 해당 부분만 수행합니다.
생략한 검사는 통과로 기록하지 마세요.
실제 경로, 통과 항목, 실패 항목과 재개할 한 단계만 짧게 보고하세요.
```
