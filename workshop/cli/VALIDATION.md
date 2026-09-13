# CLI 모듈 검증 및 인계

검증 날짜: 2026-09-11. 실제 AWS 배포, 원격 Runtime 호출, CloudWatch 조회, AWS 삭제,
모델 호출, 외부 메시지 전송은 수행하지 않았다. 원본 애플리케이션과 참조 저장소는 수정하지 않았다.
아래 AWS 계정 번호는 합성 검사용 예시다.

## 사용한 도구와 공식 입력

| 항목 | 검증 버전 |
| --- | --- |
| Node | 24.21.0 (`PATH=/tmp/jeju-node24/bin:$PATH`) |
| AgentCore CLI | `@aws/agentcore` 0.28.1 |
| AgentCore CDK construct | 0.1.0-alpha.50 |
| CDK CLI / library | 2.1126.0 / 2.261.0 |
| constructs / TypeScript | 10.7.0 / 5.9.3 |
| 준비기 Python | 3.9.25 |
| Runtime Python | 3.14.3 |
| uv | 0.10.9 |
| Python SDK | bedrock-agentcore 1.9.1 |

설치된 npm 패키지의 `dist/assets/cdk/`와 public schema/construct 코드를 읽어
인터페이스를 확인했다. 참조 솔루션 저장소에는 의존하지 않는다.

- 공식 소스: `https://github.com/aws/agentcore-cli`
- 공식 스키마: `https://schema.agentcore.aws.dev/v1/agentcore.json`
- 확인한 스키마 SHA-256:
  `0d392ce87e09ccadd5e499eeb355fe702681b79494b542d45cd5130060f897c3`

공식 스키마의 JavaScript Unicode 정규식 때문에 Python `jsonschema`의 기본 정규식 엔진으로는
검사가 끝나지 않았다. 임시 AJV 8.17.1과 설치된 CLI의 validator로 생성 설정을 검증했다.
AJV 기본 설치에서는 URI format을 인식하지 않는다는 경고가 났다. 이 예제는 해당 규칙을
사용하는 JWT/Gateway 필드를 포함하지 않는다.

## 실제 실행한 검증

원본 저장소 루트에서:

```bash
python3 -B -m unittest discover -s workshop/cli -p 'test_prepare.py' -v
python3 workshop/cli/prepare.py \
  --project-name AtlasCliTeam01 \
  --account-id 123456789012 \
  --region ap-northeast-2 \
  --output /tmp/atlas-cli-final-Team01
```

준비기 테스트 **8개 통과**. 생성 파일의 재현성, 기존 빈 폴더, 참가자 작업 보존,
이름, 계정, 리전, 심볼릭 링크, 참조 저장소 출력과 셸 경로 경계를 확인했다.

생성된 작업 공간에서 `source ./activate.sh` 후 다음 검증을 실행했다.
검증 과정의 AWS 설정 파일은 `/dev/null`로 지정하고 AWS 키, profile, 웹 identity, container
credential 환경 변수는 해제했으며 EC2 metadata 조회도 비활성화했다.
패키지 다운로드가 끝난 뒤 재검증은 임시 캐시와 `UV_OFFLINE=1`을 사용했다.

```bash
agentcore --version
agentcore validate --json
agentcore package --runtime Warmup
npm --prefix agentcore/cdk ci --ignore-scripts --offline --no-audit --no-fund \
  --cache /tmp/atlas-cli-npm-cache \
  --userconfig /dev/null --globalconfig /tmp/atlas-cli-no-global.npmrc
cd app/warmup
uv sync --python 3.14 --frozen --offline --no-config
uv run --frozen --offline --no-config python -m unittest discover -s tests -v
cd ../..
npm --prefix agentcore/cdk run synth
python3 checks/check_synth.py
```

| 검사 | 실제 결과 |
| --- | --- |
| CLI validate | `{"success":true}` |
| CLI package | `agentcore/Warmup.zip` 생성, 표시 크기 19.01 MB |
| Python 테스트 | 3개 통과; 결정론적 응답, 네트워크 차단, 입력 제한, 기본 logger의 메타데이터 출력 |
| CDK synth | 종료 코드 0; Linux ARM64 CodeZip 합성 |
| synth 검사 | Runtime 1개, 역할 1개, 정책 1개; 모델 권한 0개 |
| 공식 JSON schema | 생성한 설정의 적용 대상 필드 검증 통과 |
| 변조한 synth: 모델 호출 grant 추가 | 거부 |
| 변조한 synth: 다른 프로젝트 로그 ARN | 거부 |
| 변조한 synth: VPC 리소스 추가 | 거부 |

CLI의 create 동작도 새 임시 경로에서 확인했다.

```bash
agentcore create --project-name AtlasCliProbe01 --no-agent \
  --output-dir /tmp/atlas-cli-scaffold-probe \
  --skip-git --skip-python-setup --skip-install --json
```

실제 결과는 `projectPath: /tmp/atlas-cli-scaffold-probe/AtlasCliProbe01`,
`runtimes: []`, 빈 AWS target 배열이었다.
`create`, `validate`, `dev`, `deploy`, `invoke`, `status`, `logs`, `remove`,
`remove agent`, `remove all`, `package`, `add agent`의 `--help`를 설치된 CLI에서 확인했다.
도움말이 stderr로 나오는 경우를 포함해 확인했으며, 클라우드 명령의 실행 검증과는 구분한다.

## 실제 로컬 HTTP 실행

`/tmp/atlas-cli-validation-Team01`에서 다음 서버를 시작했다.

```bash
agentcore dev --runtime Warmup --port 8080 \
  --skip-deploy --no-traces --no-browser --logs
```

별도 프로세스에서:

```bash
agentcore dev "제주에서 CLI 연결 확인" --runtime Warmup --port 8080
curl -q --fail --silent http://127.0.0.1:8080/ping
curl -q --fail --silent http://127.0.0.1:8080/invocations \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"제주에서 CLI 연결 확인"}'
```

`/ping`과 `/invocations` 모두 HTTP 200. CLI와 HTTP 응답에서
`project: AtlasCliTeam01`, `mode: deterministic`, `modelInvoked: false`,
입력과 같은 `echo`를 확인했다. CLI dev의 import 실행에서도
`warmup_complete project=AtlasCliTeam01 prompt_chars=14 model_invoked=false`가 출력되며
입력 전문은 이벤트 로그에 없음을 확인했다. 시작한 서버는 `Ctrl+C`로 종료했다.

## 로컬 제거 검사

검증용 프로젝트에 실제 배포 상태가 없는 조건에서 실행했다.

```bash
agentcore remove agent --name Warmup --yes --json
agentcore validate --json
npm --prefix agentcore/cdk run synth
python3 checks/check_synth.py --expect-empty
```

CLI는 정의 제거 성공과 “app source code has not been modified”,
AWS에 적용하려면 deploy가 필요하다는 안내를 반환했다.
제거 후 합성 결과는 Runtime 0개, 전체 리소스 0개였다.
클라우드 삭제는 수행하지 않았다.

## 남은 한계

- 실제 계정 IAM, 서비스 가용성, Runtime 생성, CloudWatch 로그 도착은 미검증이다.
  장의 클라우드 관찰 결과는 참가자가 기록해야 한다.
- CDK bootstrap은 기존 교육 계정의 버전 30 이상을 전제로 한다. 이 모듈에서 생성, 업그레이드하지 않았다.
- 최초 Python/Node 패키지 설치와 ARM64 wheel 확보에는 공개 저장소 네트워크가 필요하다.
- 고정 upstream packager가 Node `DEP0190` 경고를 내고 CDK는 미설정 feature flag 안내를 낸다.
  검증 종료 코드는 0이었다. 패키지, 참조 저장소를 패치하지 않았고, 준비기와 CDK guard는
  공백, 메타 문자가 없는 출력 경로를 요구한다.
- Runtime 서비스가 만드는 로그 그룹과 공유 bootstrap 버킷의 배포 아티팩트는 스택 제거 후
  남을 수 있다. 장에서 소유 로그의 수동 확인과 공유 자원 보존을 설명한다.
- 계정, 이름 guard는 실수 방지 검사다. 소유권 파일과 코드까지 의도적으로 바꾸는 사용자를
  제한하는 IAM 권한 경계는 아니다.

## 정확한 변경 파일

이 담당 작업은 다음 **21개 파일**만 추가했다. 구현 계획, 원본 앱, 다른 작업자의 파일은 변경하지 않았다.

```text
workshop/chapters/04-agentcore-cli.md
workshop/prompts/04-agentcore-cli.md
workshop/cli/README.md
workshop/cli/VALIDATION.md
workshop/cli/prepare.py
workshop/cli/test_prepare.py
workshop/cli/template/.gitignore
workshop/cli/template/AGENTS.md
workshop/cli/template/README.md
workshop/cli/template/activate.sh
workshop/cli/template/app/warmup/main.py
workshop/cli/template/app/warmup/pyproject.toml
workshop/cli/template/app/warmup/uv.lock
workshop/cli/template/app/warmup/tests/test_main.py
workshop/cli/template/agentcore/cdk/package.json
workshop/cli/template/agentcore/cdk/package-lock.json
workshop/cli/template/agentcore/cdk/cdk.json
workshop/cli/template/agentcore/cdk/tsconfig.json
workshop/cli/template/agentcore/cdk/bin/cdk.ts
workshop/cli/template/agentcore/cdk/lib/stack.ts
workshop/cli/template/checks/check_synth.py
```
