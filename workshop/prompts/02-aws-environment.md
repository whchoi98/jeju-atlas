# 02. 계정과 작업 위치 확인

02장에서 정한 참가자 변수와 설정 파일을 함께 전달합니다.

```text
현재 EC2의 계정과 참가자별 작업 위치를 확인해 주세요.
허용한 설정은 ATLAS_CONFIG, ATLAS_TEAM, ATLAS_PROJECT, ATLAS_REGION,
ATLAS_ACCOUNT, ATLAS_CLI_PARENT, ATLAS_CLI입니다.

workshop/scripts/lab.py init-ec2 --identity-only와 info의 결과에서 EC2 계정, 서울 리전,
VPC, 참가자 이름을 대조합니다. 이미 있는 설정 파일은 덮어쓰지 마세요.
본 실습에서는 네트워크 전체 검사를 요구하지 않습니다.
기존 VPC나 네트워크 설정은 만들거나 바꾸지 마세요.
AWS 자격 증명, 메타데이터 토큰과 로그인 파일은 출력하지 마세요.

배포 계정이 일치하는지와 다음 장에서 사용할 프로젝트 경로를 알려 주세요.
AgentCore CLI 설정은 이 참가자의 cli-config 폴더를 사용합니다.
아직 AgentCore 배포나 모델 호출은 하지 마세요.
```
