# 02. 계정과 작업 폴더

계정이나 키 입력 상태에 문제가 있을 때 사용하는 선택 카드입니다.\
비밀값 없이 상태만 확인합니다.

```ai-prompt
현재 EC2의 계정과 제주 워크숍 참가자 설정을 확인해 주세요.
현재 참가자의 로컬 설정 준비와 읽기 전용 AWS 조회를 승인합니다.
activate.sh와 비밀값 없는 소유 설정에서 ATLAS_REPO, ATLAS_CLI_PARENT,
ATLAS_CLI, ATLAS_TEAM, ATLAS_PROJECT와 ATLAS_CONFIG를 찾아 재사용하세요.
각 참가자는 독립 랩을 사용합니다. 새 설정의 공통 내부 ID는 team01,
프로젝트는 AtlasCliTeam01이며 팀명 선택이나 치환을 요구하지 마세요.
이미 있는 이름과 설정은 유지하고 현재 Agentic AI 코딩 어시스턴트로 진행하세요.
모든 터미널 실행은 올바른 cd로 시작하세요. 새 셸에서는 확인한 저장소로 이동하고
기존 activate.sh를 source한 뒤 필요한 작업 폴더로 다시 이동하세요.
경로 이동이나 활성화가 실패하면 그 셸의 후속 명령을 실행하지 마세요.

aws sts get-caller-identity로 현재 계정을 확인하세요.
참가자 설정이 없을 때만 다음을 실행합니다.
python3 "$ATLAS_REPO/workshop/scripts/lab.py" init-ec2 --identity-only --participant "$ATLAS_TEAM" --config "$ATLAS_CONFIG"
python3 "$ATLAS_REPO/workshop/scripts/lab.py" info --config "$ATLAS_CONFIG"
기존 설정은 덮어쓰지 말고 EC2 계정, 리전과 VPC를 대조하세요.
init-ec2 뒤에는 활성화를 다시 적용해 ATLAS_ACCOUNT를 복원합니다.
배포 대상은 현재 EC2 계정과 ap-northeast-2이며 공유 네트워크는 유지합니다.
info의 심화 cli 경로 대신 활성화의 ATLAS_CLI를 사용하세요.

python3 "$ATLAS_REPO/workshop/scripts/workshop_env.py" status로 입력 여부를 확인하세요.
.env는 ATLAS_CLI_PARENT에 있으며 배포 코드 밖에 둡니다.
파일 내용을 읽거나 source하지 마세요. 키를 프롬프트, 로그와 명령 인자에 넣지 마세요.
Bedrock API 키와 모델 호출 리전은 사용자가 Bash의 configure에서 입력하며 키는 숨김 처리합니다.
키는 모델 호출용이며 AWS 배포에는 현재 EC2 역할과 기존 CDK bootstrap이 필요합니다.

model_check.py의 유료 사전 호출은 기본으로 생략하며 보고서는 진행 조건이 아닙니다.
실제 모델 오류를 진단 중이고 기존 evidence/model-check-*.json이 있다면
이번 참가자와 키 갱신 시점에 맞는 기록만 참고하세요.
보고서가 없으면 미실행으로 기록합니다. 입력 상태 확인은 모델 접근 성공을 뜻하지 않습니다.
과거 EC2의 SCP 거부를 현재 참가자의 실패로 가정하지 마세요.
카카오, 관광공사와 VISIT JEJU 키가 없어도 핵심 샘플 실습은 진행할 수 있습니다.
이 카드는 실제 모델 호출과 AWS 변경을 승인하지 않습니다.
IAM/SCP나 배포 계정을 바꾸어 오류를 우회하지 마세요.
전체 테스트, 로컬 agentcore dev와 HUD 설치, 실행은 추가하지 마세요.
추가 진단은 실제 오류, 위험한 기능 변경 또는 명시적 요청이 있을 때
해당 부분에 한정하며 생략한 검사를 통과로 기록하지 마세요.
키 갱신이 필요하면 사용자가 자신의 Bash에서 configure를 실행하도록 안내하세요.
실제 계정의 일치 여부, 입력 상태와 다음 조치만 비밀값 없이 보고하세요.
```
