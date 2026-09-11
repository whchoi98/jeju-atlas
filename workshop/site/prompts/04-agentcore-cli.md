# 04 · AI CLI 프롬프트 카드: 독립 CLI Runtime

이 카드는 같은 실습 EC2의 Codex·Kiro CLI·Claude Code에 공통으로 전달할 수 있습니다. 한 도구만 선택하고 같은 계정·VPC·작업 폴더를 유지합니다.

`prepare.py`로 생성한 CLI 프로젝트를 작업 폴더로 연 뒤 아래 내용을 전달한다.
프로젝트 전체는 이 카드만으로 이해할 수 있으며, 원본·참조 저장소를 추가로 열 필요가 없다.

```text
현재 작업 폴더는 Jeju Atlas 워크숍의 독립 AgentCore CLI 입문 프로젝트다.
이 폴더 안에서만 작업하라. 먼저 AGENTS.md, README.md, toolchain.json,
.atlas-cli-workshop.json, agentcore/agentcore.json, agentcore/aws-targets.json,
app/warmup/main.py, agentcore/cdk/lib/stack.ts를 읽어 작업 경계를 확인하라.

목표:
- @aws/agentcore 0.28.1의 Runtime 생명주기를 로컬에서 확인한다.
- Python 3.14 CodeZip + HTTP, BedrockAgentCoreApp entrypoint를 유지한다.
- {"prompt":"제주에서 CLI 연결 확인"}를 받으면 같은 결정론적 JSON을 반환한다.
- mode는 deterministic, modelInvoked는 false이며 echo에는 입력 문자열이 들어간다.
- 입력은 512자 이하 문자열이다. 잘못된 입력은 invalid_prompt JSON을 반환한다.

분리 원칙:
- 이것은 모델 없는 생명주기 실습이다. 실제 Atlas Guide/Tools/Gateway/Memory 스택과
  다르며, Global CRIS Sol/Astra 모델 설정은 이 프로젝트에 추가하지 않는다.
- 이 작업 공간 밖을 읽거나 수정하지 않는다. agentcore-cli, 그 worktree,
  원본 Atlas 코드, 기존 배포 출력, 운영 리소스에 접근하지 않는다.
- .env, 인증 파일, 키체인, API 키와 토큰을 읽거나 출력·복사·저장하지 않는다.
  모델 SDK, 모델 호출, 외부 도구 호출, 외부 메시지 전송을 추가하지 않는다.
- 소유권 파일의 계정·ap-northeast-2 리전·AtlasCli 접두사·Warmup 이름을 유지한다.
  더 많은 Runtime, Memory, Gateway, VPC/NAT, 운영 역할이나 외부 코드 경로를 추가하지 않는다.
- 모든 Python 의존성은 pyproject.toml과 uv.lock, CDK 의존성은 package-lock.json으로
  고정되어 있다. CLI의 ZIP packager가 uv.lock을 직접 쓰지 않으므로 pyproject의
  전이 의존성 고정을 제거하지 않는다.
- prompt-content telemetry를 끈다. 로그에는 이벤트·프로젝트·글자 수만 남긴다.
- CLI 설정은 이 폴더의 .cli-config만 쓴다. disableDependencyManagement와
  disableTransactionSearch를 true로 유지한다. 소유 스택의 로그 권한 경계를 완화하지 않는다.

지금 할 일:
1. source ./activate.sh를 적용하고 CLI 버전이 0.28.1인지 확인한다.
2. npm --prefix agentcore/cdk ci --ignore-scripts로 고정 의존성을 설치한다.
3. app/warmup 안에서 uv sync --python 3.14 --frozen 후
   uv run --frozen python -m unittest discover -s tests -v를 실행한다.
4. 프로젝트 루트에서 agentcore validate --json,
   npm --prefix agentcore/cdk run synth, python3 checks/check_synth.py를 실행한다.
5. agentcore dev --runtime Warmup --port 8080 --skip-deploy --no-traces --no-browser --logs
   로 로컬 서버를 시작한다. --skip-deploy를 생략하지 않는다.
6. 별도 터미널/프로세스에서 같은 activate.sh를 적용하고
   agentcore dev "제주에서 CLI 연결 확인" --runtime Warmup --port 8080을 실행한다.
   /ping과 /invocations HTTP 응답도 확인한 뒤 자신이 시작한 서버를 종료한다.
7. 발견한 문제는 이 작업 공간 안에서만 수정하고 관련 검증을 다시 실행한다.

AWS 작업:
- 지금 요청은 로컬 검증까지다. agentcore deploy, 원격 invoke/status/logs,
  AWS 삭제나 bootstrap 생성·수정을 실행하지 않는다.
- 나중에 내가 특정 클라우드 동작을 명시적으로 요청하면 기존 승인을 존중하되,
  교육용 계정이 소유권 파일과 같은지 확인하고 이 프로젝트만 대상으로 한다.
  공유 CDK bootstrap이 없거나 버전 30 미만이면 생성·업그레이드하지 말고 전제 조건 실패로 보고한다.
- 사용 가능한 실제 명령은 agentcore deploy --target default,
  agentcore invoke "문장" --runtime Warmup --target default --json,
  agentcore status --target default --runtime Warmup --json,
  agentcore logs --runtime Warmup --since 10m --limit 30 --json이다.
- agentcore remove agent --name Warmup --yes --json은 로컬 정의 제거다.
  뒤의 deploy 또는 정확한 소유 스택 삭제가 있어야 AWS 제거가 적용된다.

최종 보고:
- 변경 파일과 실제 실행한 명령, 성공/실패 및 남은 문제를 제시한다.
- synth의 Runtime 1개, 전체 자원 3개, 모델 권한 0개를 확인한다.
- 로컬 HTTP 결과와 AWS 배포 여부를 따로 쓴다.
- 실행하지 않은 클라우드 단계를 성공이라고 쓰지 않는다.
```
