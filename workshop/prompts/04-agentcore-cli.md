# 04. 로컬 실행과 AWS 배포

기본 과정의 마지막 실습입니다. 실제로 진행할 단계를 지정해 전달합니다.

```text
현재 참가자 프로젝트의 JejuGuide를 AgentCore CLI로 검증하고 배포합니다.
먼저 내가 지정한 단계와 현재 결과를 확인하세요.
모델은 global.anthropic.claude-sonnet-4-6으로 고정합니다.
작은 실제 model_check.py 검사에 SCP 거부가 남아 있으면 배포로 진행하지 마세요.
배포 리전은 ap-northeast-2이며 Bedrock 호출 리전은 별도 ATLAS_BEDROCK_REGION입니다.
주최자가 확인하지 않은 리전을 대입하거나 순회 호출하지 마세요.
ATLAS_REPO, ATLAS_CLI와 ATLAS_ASSISTANT가 비었으면 진행하지 마세요.
별도 Bash마다 참가자 activate.sh를 source해야 하며, AI의 자식 셸 export로
사용자의 다른 터미널이 바뀌었다고 가정하지 마세요.

로컬 단계:
- core.py doctor --assistant에 선택한 도구와 --project를 지정해 소스, 도구,
  참가자 설정, 저장한 계정과 default 대상, JejuGuide 파일과 데이터를 확인합니다.
- 생성된 pyproject.toml과 CDK package.json에서 의존성을 설치합니다.
  기존 lock이 있으면 npm ci와 uv sync --frozen을 사용하고 기존 파일을 보존합니다.
- 모델 없는 검색 테스트와 agentcore validate --json을 실행합니다.
- Ran 0 tests는 성공 기준이 아닙니다. 실제 검색 테스트 수와 결과를 확인합니다.
- agentcore dev --runtime JejuGuide --port 8080 --skip-deploy --no-traces --no-browser --logs로
  로컬 서버를 실행합니다. 이 단계에서 자동 배포를 하지 마세요.
- 별도 터미널에서 “제주 해변 두 곳을 찾아주고 자료의 출처를 알려줘”를 호출합니다.
- 8080이 다른 프로젝트에서 사용 중이면 종료하지 말고 서버와 호출에 같은 빈 포트를 지정합니다.
- 실제 도구 사용, 장소 이름과 시드 자료 안내, 완성된 응답을 확인합니다.

배포 단계:
- STS 계정, default 대상, 참가자 프로젝트 이름을 대조합니다.
- CLI 설정 파일이 없거나 disableDependencyManagement/disableTransactionSearch가
  true가 아니면 중단합니다. 원본이나 다른 프로젝트의 설정으로 대체하지 마세요.
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
