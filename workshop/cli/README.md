# AgentCore CLI 입문 모듈

이 폴더는 모델 없는 HTTP Runtime을 생성하는 독립 실습 준비기와 번들을 제공한다.
실제 Atlas Guide/Tools/Gateway/Memory 스택은 다른 실습에서 배포한다.

```bash
python3 workshop/cli/prepare.py \
  --project-name AtlasCliTeam01 \
  --account-id 123456789012 \
  --region ap-northeast-2 \
  --output /tmp/atlas-cli-Team01
```

계정 번호는 예시다. 준비기는 AWS 계정을 조회하지 않는다. AWS 배포 전 참가자가 실제 계정을
확인한다. 출력 디렉터리는 존재하지 않아야 하며, 생성 결과는 원본 저장소 없이 동작한다.
준비기 실행에는 Python 3.9 이상과 이 폴더의 번들만 필요하다.

생성 결과에는 `@aws/agentcore` 0.28.1의 공개 scaffold와 같은 `ConfigIO`,
`AgentCoreApplication`, `agentcore.json`, `aws-targets.json`, CDK 진입점 구조를 사용한다.
`@aws/agentcore-cdk` 0.1.0-alpha.50, CDK/TypeScript manifest와 lock 파일도 함께 제공한다.
설치된 CLI나 별도의 `agentcore-cli` 저장소에서 코드를 복사하는 생성 방식이 아니다.

생성된 프로젝트에서 시작한다.

```bash
cd /tmp/atlas-cli-Team01
source ./activate.sh
npm --prefix agentcore/cdk ci --ignore-scripts
cd app/warmup
uv sync --python 3.14 --frozen
uv run --frozen python -m unittest discover -s tests -v
cd ../..
agentcore validate --json
npm --prefix agentcore/cdk run synth
python3 checks/check_synth.py
```

준비기는 소유권 파일, 고정 계정·Seoul 대상, Python 3.14 CodeZip Runtime, telemetry를 끈
CLI/Runtime 설정을 생성한다. CDK는 자기 스택에 만든 실행 역할을 `executionRoleArn`으로
연결한다. 따라서 L3의 기본 모델/X-Ray/넓은 로그 권한을 받아서 수정하는 과정이 없다.
실행 역할의 쓰기 권한은 자기 Runtime 로그에만 한정된다.

`prepare.py`는 파일 allowlist만 읽는다. `.env`, 자격 증명, 참조 저장소, 생산 배포 출력이나
기존 참가자 프로젝트를 읽거나 복사하지 않는다. 프로젝트 이름, 리전, 계정 모양,
기존 디렉터리, 심볼릭 링크, 참조 저장소 출력, 셸에 안전하지 않은 경로를 거부한다.
Codex 카드와 생성 결과의 `AGENTS.md`도 생성된 작업 공간만 대상으로 한다.

유지보수자가 실행할 오프라인 경계 검사:

```bash
python3 -B -m unittest discover -s workshop/cli -p 'test_prepare.py' -v
```

현재 CLI/CDK ZIP packager는 `uv pip install -r pyproject.toml`로 의존성을 설치한다.
`uv.lock`만 고정하면 배포 패키지의 전이 의존성이 달라질 수 있으므로 `pyproject.toml`에도
현재 런타임 의존성 전체를 고정했다. 버전을 바꿀 때는 manifest와 lock 파일을 함께 갱신하고,
ARM64 패키징, HTTP 응답, 로그 내용과 synth 경계 검사를 다시 수행한다.

- [한국어 실습 장](../chapters/04-agentcore-cli.md)
- [Codex 프롬프트 카드](../prompts/04-agentcore-cli.md)
- [검증 명령·결과·한계·정확한 변경 파일](VALIDATION.md)
