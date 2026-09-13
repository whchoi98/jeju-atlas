# 04. 로컬 실행과 AWS 배포

기본 과정의 마지막 실습입니다. 실제로 진행할 단계를 지정해 전달합니다.

```text
현재 참가자 프로젝트의 JejuGuide를 AgentCore CLI로 검증하고 배포합니다.
먼저 내가 지정한 단계와 현재 결과를 확인하세요.

로컬 단계:
- 생성된 pyproject.toml과 CDK package.json에서 의존성을 설치하고 lock 파일을 보관합니다.
- 모델 없는 검색 테스트와 agentcore validate --json을 실행합니다.
- agentcore dev --runtime JejuGuide --port 8080 --skip-deploy --no-traces --no-browser --logs로
  로컬 서버를 실행합니다. 이 단계에서 자동 배포를 하지 마세요.
- 별도 터미널에서 “제주 해변 두 곳을 찾아주고 자료의 출처를 알려줘”를 호출합니다.
- 실제 도구 사용, 장소 이름과 시드 자료 안내, 완성된 응답을 확인합니다.

배포 단계:
- STS 계정, default 대상, 참가자 프로젝트 이름을 대조합니다.
- agentcore deploy --target default --dry-run으로 변경할 자원을 확인합니다.
- 이 실습에서 요청한 배포를 진행하고 status에서 Runtime 상태를 확인합니다.
- invoke로 같은 질문의 원격 응답을 확인하고 logs에서 오류 원인을 찾습니다.
- 진행 중인 배포를 중복 실행하거나 끊긴 모델 호출을 원인 확인 없이 반복하지 마세요.

계정 단위 설정, 기존 VPC, NAT Gateway, Subnet, 다른 Runtime과 Memory는 변경하지 않습니다.
105분까지 배포가 준비되지 않으면 현재 상태와 원인을 남기고 진행자와 확인합니다.

RESULTS.md에 사용한 AI CLI, 수정 파일, 로컬 검사, 실제 원격 호출 결과와 남은 자원을 기록하세요.
Runtime을 정리하라고 요청받았다면 remove agent로 로컬 정의를 지운 뒤
같은 프로젝트의 deploy 계획과 삭제 결과를 확인합니다. remove만으로 AWS 삭제 완료라 쓰지 마세요.
이번에 확인한 결과만 보고하고 Gateway, Memory와 전체 웹 배포까지 했다고 쓰지 마세요.
```
