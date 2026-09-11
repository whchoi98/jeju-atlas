# __ATLAS_PROJECT__: AgentCore CLI 입문 실습

이 디렉터리만 작업 공간이다. `toolchain.json`과 `.atlas-cli-workshop.json`을 먼저 읽는다.

- CLI는 `@aws/agentcore` 0.28.1, Runtime은 Python 3.14 CodeZip + HTTP이다.
- `app/warmup/main.py`는 `BedrockAgentCoreApp`으로 결정론적 JSON을 반환한다. 모델 호출,
  모델 SDK, Gateway/Memory 연결, 운영 Atlas 코드 복사, 외부 저장소 의존성을 추가하지 않는다.
- 계정·리전·프로젝트·Runtime 이름을 변경하지 않는다. 보호 검사를 제거하지 않는다.
  CloudFormation 스택은 `AgentCore-__ATLAS_PROJECT__-default` 하나뿐이다.
- `.env`, 인증 파일, 키체인, 운영 출력, 다른 작업 공간을 읽거나 복사하지 않는다.
  API 키나 토큰을 요청·출력·저장하지 않는다.
- 명령 전 `source ./activate.sh`를 적용한다. CLI 설정은 이 프로젝트의 `.cli-config/`만 쓴다.
  의존성 자동 변경과 계정 단위 Transaction Search 설정은 꺼 둔다.
- 패키지는 고정된 `package-lock.json`과 `uv.lock`으로 설치한다.
- 로컬 개발은 `agentcore dev --runtime Warmup --skip-deploy --no-traces --no-browser --logs`로 한다.
  `--skip-deploy`를 빼지 않는다. 입력 전문을 로그·telemetry에 기록하지 않는다.
- 로컬 변경 후 CLI validate, Python 테스트, CDK synth 및 `checks/check_synth.py`를 실행한다.
  synth는 AWS 배포나 IAM 권한 확인이 아니다.
- 사용자가 이 실습 계정으로 배포·원격 호출·삭제를 명시적으로 요청한 경우에만 해당 작업을
  수행한다. 기존 승인이 있으면 반복 확인하지 않는다. 승인된 범위 밖 AWS 리소스,
  공유 CDK bootstrap, VPC/NAT, 운영 Runtime을 만들거나 변경하지 않는다.
- 외부 메시지는 전송하지 않는다. 결과에는 실행 명령과 관찰 결과를 쓰고, 미실행 AWS 단계를
  성공했다고 보고하지 않는다.
