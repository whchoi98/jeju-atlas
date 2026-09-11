# __ATLAS_PROJECT__ · CLI 생명주기 실습

모델을 호출하지 않는 독립 HTTP Runtime이다. 실제 Atlas Guide/Tools/Gateway/Memory
스택과 자원·배포 상태·정리 책임을 공유하지 않는다. 원본 저장소 없이 이 디렉터리만으로 실습한다.

## 도구와 설치

Node 24, `@aws/agentcore` 0.28.1, Python 3.14, uv가 필요하다. CLI가 없으면
`npm install -g @aws/agentcore@0.28.1`로 정확한 버전을 설치한다.

```bash
source ./activate.sh
node --version
agentcore --version
npm --prefix agentcore/cdk ci --ignore-scripts
cd app/warmup
uv sync --python 3.14 --frozen
uv run --frozen python -m unittest discover -s tests -v
cd ../..
agentcore validate --json
npm --prefix agentcore/cdk run synth
python3 checks/check_synth.py
```

`activate.sh`는 인증 값을 읽지 않고 이 실습의 CLI 설정·캐시·telemetry 옵션을 설정한다.
`.cli-config/config.json`은 자동 의존성 변경과 계정 단위 Transaction Search 설정을 막는다.
`npm ci`와 `uv sync --frozen`은 잠금 파일의 공개 패키지를 설치하며, 처음에는 네트워크가 필요하다.
synth는 Linux ARM64 CodeZip 의존성도 묶으므로 Docker가 필요 없다.

검증기 성공 결과는 `runtimeCount: 1`, `resourceCount: 3`, `modelPermissions: 0`이다.
CloudFormation 안의 실행 역할은 이 스택 소유이며, 자기 Runtime 로그에만 쓰기 권한을 가진다.
`logs:DescribeLogGroups`의 `Resource: "*"`는 리소스별 ARN을 지원하지 않는 조회 작업이다.
로그 그룹 자체는 Runtime 서비스가 생성하므로 스택의 세 리소스에 포함되지 않는다.

## 로컬 실행

터미널 A에서 실행한다.

```bash
source ./activate.sh
agentcore dev --runtime Warmup --port 8080 --skip-deploy --no-traces --no-browser --logs
```

같은 프로젝트를 연 터미널 B에서 호출한다.

```bash
source ./activate.sh
curl --fail --silent http://127.0.0.1:8080/ping
agentcore dev "제주에서 CLI 연결 확인" --runtime Warmup --port 8080
curl --fail --silent http://127.0.0.1:8080/invocations \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"제주에서 CLI 연결 확인"}'
```

응답은 `project: "__ATLAS_PROJECT__"`, `mode: "deterministic"`,
`modelInvoked: false`와 입력을 돌려주는 `echo`이다. 모델 품질이나 제주 정보 정확도를
확인하는 단계가 아니다. 애플리케이션 로그에는 `warmup_complete`, 글자 수, 프로젝트만 나온다.
입력은 512자 이하 문자열이다. 잘못된 입력은 `error: "invalid_prompt"` JSON을 반환한다.
터미널 A에서 `Ctrl+C`로 서버를 종료한다.

## 참가자 AWS 계정에서 실행할 단계

이 파일이 생성되었다고 AWS 배포가 된 것은 아니다. 아래 단계는 참가자가 별도로 실행한다.
`.atlas-cli-workshop.json`의 계정과 `aws sts get-caller-identity --query Account --output text`
결과가 일치해야 한다. 명시적으로 준비한 교육용 AWS profile을 사용한다.
Seoul의 기존 CDK bootstrap 버전은 30 이상이어야 하며, bootstrap 생성/변경 요청이 나오면
담당자에게 준비 상태를 확인한다. 이 모듈에서 공유 bootstrap을 변경하지 않는다.

```bash
source ./activate.sh
agentcore deploy --target default
agentcore status --target default --runtime Warmup --json
agentcore invoke "제주에서 CLI 연결 확인" --runtime Warmup --target default --json
agentcore logs --runtime Warmup --since 10m --limit 30 --json
```

CLI는 `AgentCore-__ATLAS_PROJECT__-default` 스택의 배포 상태를 `agentcore/.cli/`에 기록한다.
배포자의 IAM 권한, 실제 Runtime 가용성, CloudWatch 로그 도착은 계정에서 확인해야 한다.
API 키·모델 ID는 필요 없지만 Runtime·로그·배포 아티팩트에는 비용이 생길 수 있다.

## 정리

배포한 교육용 계정·프로젝트인지 먼저 확인한다.

```bash
agentcore remove agent --name Warmup --yes --json
agentcore deploy --target default
agentcore status --target default --json
npm --prefix agentcore/cdk run synth
python3 checks/check_synth.py --expect-empty
```

`remove agent`는 로컬 정의를 제거한다. 뒤의 deploy가 AWS 변경을 적용한다.
정리 후 synth의 기대 리소스 수는 0이다. 빈 CloudFormation 스택까지 없애려면 AWS 콘솔에서
정확히 `AgentCore-__ATLAS_PROJECT__-default`만 선택하거나, 참가자 계정에서
`aws cloudformation delete-stack --stack-name AgentCore-__ATLAS_PROJECT__-default --region ap-northeast-2`
와 `aws cloudformation wait stack-delete-complete`의 같은 스택 인자를 사용한다.

서비스 생성 로그 그룹 `/aws/bedrock-agentcore/runtimes/__ATLAS_PROJECT___Warmup-*`와
공유 bootstrap 버킷의 아티팩트는 남을 수 있다. 자기 로그 그룹만 확인해 정리하고,
공유 bootstrap 버킷/스택은 삭제하지 않는다. `remove all`이나 폴더 삭제만으로
AWS 정리가 완료되었다고 판단하지 않는다.

공식 인터페이스: [CLI 소스](https://github.com/aws/agentcore-cli),
[JSON 스키마](https://schema.agentcore.aws.dev/v1/agentcore.json),
[CDK constructs](https://github.com/aws/agentcore-l3-cdk-constructs).
