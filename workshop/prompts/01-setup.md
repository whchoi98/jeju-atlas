# 01. 준비된 도구 확인

설치 작업 대신 현재 환경을 확인합니다.

```text
EC2의 현재 실습 환경을 읽기 전용으로 점검해 주세요.
사용자가 지정한 ATLAS_REPO와 ATLAS_ASSISTANT를 사용합니다.
저장소가 없거나 경로가 전달되지 않았다면 기존 프로젝트를 사용하지 말고
01장의 전체 소스 준비와 별도 Bash 활성화가 필요하다고 알려 주세요.

ATLAS_REPO/workshop/scripts/core.py doctor --assistant에 선택한 도구를 지정합니다.
선택한 AI CLI 하나, Node 24.18.1 이상인 24 계열, npm, uv, Python 3.14,
AWS CLI, npm @aws/agentcore 0.28.1, helper Python의 boto3/requests,
전체 소스와 137개 샘플, 참가자 환경과 CLI 설정 결과를 함께 보고하세요.
기존 lab.py doctor는 심화용이므로 기본 과정에서 Docker를 요구하지 마세요.

설치와 인증 변경은 하지 마세요. 누락 도구는 진행자의 install_core.sh 절차로 넘깁니다.
시스템 Node/Python, 셸 시작 파일, 전역 npm과 Claude 로그인 파일을 바꾸지 마세요.
AI의 자식 셸에서 export했다고 사용자의 다른 Bash 환경이 복원됐다고 말하지 마세요.
사용자는 별도 Bash에서 절대 경로 activate.sh를 source해야 합니다.
로그인 파일이나 비밀값은 읽지 마세요.
AWS 자원 생성과 모델 호출은 이 단계에 포함하지 않습니다.
```
