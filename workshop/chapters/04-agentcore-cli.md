# 04 · AgentCore CLI로 Runtime 생명주기 익히기

이 장에서는 **모델을 호출하지 않는 HTTP Runtime 하나**로 생성 → 검증 → 로컬 실행 →
배포 → 호출 → 로그 → 정리 순서를 익힌다. 답변 생성이나 여행 추천의 품질을 확인하는 단계는
뒤의 실제 Atlas AgentCore 실습에서 다룬다.

완료 기준은 같은 입력에 같은 JSON을 받는 것, 내 프로젝트가 소유하는 AWS 자원을 설명하는 것,
로컬 정의 제거와 AWS 자원 제거를 구분하는 것이다.

> 이 교재의 제작 검증은 로컬에서 수행했다. `create`, `validate`, 로컬 HTTP 실행,
> Python 테스트와 CDK synth를 실제 확인했다. AWS 배포·원격 Runtime 호출·CloudWatch 조회·
> AWS 삭제를 실행했다는 뜻은 아니다. 클라우드 단계의 관찰 결과는 참가자가 자신의 계정에서
> 기록한다. 명령 표면은 `@aws/agentcore` **0.28.1** 기준이다.

## 1. CLI 입문 Runtime과 실제 Atlas의 경계

| 항목 | 이 장의 CLI 프로젝트 | 뒤에서 배포하는 실제 Atlas |
| --- | --- | --- |
| 목적 | Runtime 생명주기와 HTTP 입출력 확인 | 제주 가이드와 애플리케이션 기능 실행 |
| Runtime | 참가자 전용 `AtlasCliTeam01_Warmup` | 별도의 Guide·Tools Runtime |
| 실행 코드 | `BedrockAgentCoreApp`의 결정론적 Python 함수 | Atlas에 포함된 실제 에이전트·도구 코드 |
| 모델 | 호출하지 않음, 모델 권한도 부여하지 않음 | Atlas Guide의 Global CRIS Sol/Astra 설정 유지 |
| Gateway·Memory | 생성하지 않음 | 실제 Atlas 배포 절차에서 별도로 생성 |
| 인프라 | CodeZip Runtime, 실행 역할, 로그 정책 | Guide/Tools/Gateway/Memory와 애플리케이션 전체 인프라 |
| 배포 소유자 | 이 CLI 프로젝트의 CDK 스택 | 별도의 Atlas 실습 배포 스택 |
| 정리 | 이 프로젝트의 정의·스택·로그만 | Atlas 정리 장의 해당 스택·보존 자원 |

CLI가 Gateway나 Memory를 지원하지 않는다는 의미는 아니다. 입문 과제를 단일 Runtime으로
제한한 것이다. 이 프로젝트를 Atlas의 운영 설정으로 바꾸거나 실제 Guide 코드를 복사하지 않는다.
특히 Codex 인증과 AWS에서 사용하는 Bedrock 모델 설정은 서로 다른 설정이다.

`PUBLIC`은 이 Runtime의 네트워크 모드다. 인바운드 인증은 `AWS_IAM`이다.
이 모듈은 VPC, NAT, 보안 그룹, API Gateway, ECR, ECS를 만들지 않는다.

## 2. 실제 `create` 명령의 모양 확인

Node 24, Python 3.14, uv, AWS CLI, AgentCore CLI 0.28.1을 준비한다.
CLI가 아직 없다면 환경 준비 장에서 `npm install -g @aws/agentcore@0.28.1`로 설치한다.
`agentcore --version` 결과가 `0.28.1`인지 확인한다.

```bash
node --version
agentcore --version
agentcore create --help
```

0.28.1에서 인자 없이 생성하면 harness 경로가 기본이다. 입문 HTTP Runtime에 필요한
프로젝트 구조를 보기 위해서는 아래처럼 **빈 프로젝트**를 생성할 수 있다.
아래 경로와 이름은 관찰용이며, 다음 절의 실습 프로젝트와 분리되어 있다.

```bash
AGENTCORE_CONFIG_DIR=/tmp/atlas-cli-create-exercise/.cli-config \
AGENTCORE_TELEMETRY_DISABLED=1 \
agentcore create \
  --project-name AtlasCliCreate01 \
  --no-agent \
  --output-dir /tmp/atlas-cli-create-exercise \
  --skip-git \
  --skip-python-setup \
  --skip-install \
  --json
```

성공 JSON의 `projectPath`는 `/tmp/atlas-cli-create-exercise/AtlasCliCreate01`이다.
`--output-dir`은 **프로젝트의 부모 디렉터리**다. 생성한 프로젝트의 다음 두 파일을 읽어 본다.

```bash
cat /tmp/atlas-cli-create-exercise/AtlasCliCreate01/agentcore/agentcore.json
cat /tmp/atlas-cli-create-exercise/AtlasCliCreate01/agentcore/aws-targets.json
```

관찰할 내용은 `managedBy: "CDK"`, `runtimes: []`, 비어 있는 배포 대상이다.
`--no-agent`는 모델 없는 HTTP 코드를 자동으로 넣어 주는 옵션이 아니다.
다음 절의 준비기가 이 구조에 검증된 HTTP 코드, 정확한 계정·리전, 고정 의존성과
실습용 권한을 넣는다. 관찰용 scaffold를 실행하거나 배포할 필요는 없다.

## 3. 독립 프로젝트 준비

원본 `jeju-atlas` 루트에서 실행한다. 이름은 참가자별로 달라야 한다.
02장에서 확인한 계정과 참가자 이름을 그대로 사용한다.
이 시점에는 AWS 인증이나 모델 권한 없이 파일을 생성할 수 있다.

```bash
cd "$ATLAS_REPO"
python3 workshop/scripts/lab.py cli-prepare --config "$ATLAS_CONFIG" --execute
```

`lab.py cli-prepare`는 `$ATLAS_CLI`를 최종 프로젝트 경로로 삼아 `workshop/cli/prepare.py`를 호출한다. 독립적으로 준비기를 사용할 때 그 `--output`은 **최종 프로젝트 디렉터리**다. 이미 존재하는 디렉터리는
비어 있어도 거부하며 `--force` 옵션은 없다. `AtlasCli` 접두사 뒤에 영문·숫자 1~15자를
붙이고, `prod`, `shared`, `live`, `reference`, `default`가 들어간 이름은 쓰지 않는다.
참조 저장소 내부나 심볼릭 링크를 통한 출력도 거부한다.
0.28.1 ZIP packager의 경로 처리에 맞춰 출력 경로에는 영문·숫자·`/`·`-`·`_`·`.`만 사용한다.
원본 저장소 안에 보관하려면 `workshop/.local/` 또는 `.local/workshop/` 아래의 새 경로를 쓴다.

이 준비기는 지정한 번들 파일만 읽는다. `agentcore-cli` 저장소, 기존 배포 출력,
`.env`, 인증 파일, 설치된 전역 CLI를 복사하거나 읽지 않는다.
AWS 호출·패키지 설치·모델 호출·배포도 수행하지 않는다.
출력의 `deploymentPerformed: false`를 확인한다.

```text
atlas-cli-Team01/
├── .atlas-cli-workshop.json       # 계정·프로젝트·스택 소유권
├── .cli-config/config.json        # 이 실습만의 CLI 설정
├── AGENTS.md                      # Codex 작업 경계
├── activate.sh                    # 인증 값 없는 실습 환경 설정
├── toolchain.json                 # 도구 버전
├── app/warmup/
│   ├── main.py                    # BedrockAgentCoreApp HTTP entrypoint
│   ├── pyproject.toml             # 배포 패키지 의존성 전체 고정
│   ├── uv.lock
│   └── tests/test_main.py
├── agentcore/
│   ├── agentcore.json
│   ├── aws-targets.json
│   └── cdk/                       # 독립 CDK 앱과 package-lock.json
└── checks/check_synth.py          # 합성 결과의 자원·권한 검사
```

이제 생성된 디렉터리만 작업 공간으로 연다. Codex에는
[이 장의 프롬프트 카드](../prompts/04-agentcore-cli.md)를 전달한다.
원본 저장소나 참조 저장소를 Codex의 추가 작업 폴더로 지정하지 않는다.

## 4. 의존성 설치와 로컬 검증

이 장의 나머지 명령은 생성된 프로젝트 루트에서 시작한다.

```bash
cd "$ATLAS_CLI"
source ./activate.sh
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

`source ./activate.sh`는 각 터미널에서 실행한다. CLI 전역 설정 위치를 생성 프로젝트 안의
`.cli-config/`로 바꾸며 다음을 유지한다.

| 설정 | 이유 |
| --- | --- |
| `disableDependencyManagement: true` | CLI가 고정 버전을 자동으로 바꾸지 않게 함 |
| `disableTransactionSearch: true` | CLI 배포 중 계정 단위 Transaction Search 자동 설정 방지 |
| `AGENTCORE_TELEMETRY_DISABLED=1` | CLI 사용 telemetry 비활성화 |
| `instrumentation.enableOtel: false` | Runtime을 `opentelemetry-instrument`로 감싸지 않음 |
| `OTEL_SDK_DISABLED=true` | SDK telemetry 비활성화 |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=false` | 입력·답변 내용 수집 비활성화 |

`uv.lock`은 로컬 환경을 고정한다. 0.28.1의 CodeZip packager는
`uv pip install -r pyproject.toml`을 사용하므로, 이 예제는 배포 시에도 같은 버전이 쓰이도록
`pyproject.toml`에 전이 의존성까지 고정했다. `package-lock.json`은 CDK 의존성을 고정한다.
처음 설치하거나 ARM64 휠을 처음 묶을 때는 공개 패키지 저장소 접속이 필요하다.

기대 관찰은 다음과 같다.

| 실행 | 기대 관찰 |
| --- | --- |
| Python 테스트 | 결정론적 응답·네트워크 차단·입력 제한·로그 내용 검사 3개 통과 |
| `agentcore validate --json` | `{"success":true}` |
| `npm … run synth` | 로컬 CodeZip 및 `agentcore/cdk/cdk.out/`의 CloudFormation 템플릿 생성 |
| `python3 checks/check_synth.py` | `runtimeCount: 1`, `resourceCount: 3`, `modelPermissions: 0`, `deployed: false` |

템플릿의 Runtime 이름은 `AtlasCliTeam01_Warmup`, Python 버전은 `PYTHON_3_14`,
entrypoint는 `["main.py"]`이다. 실행 역할과 정책도 같은 스택에서 만든다.
로그 쓰기는 `/aws/bedrock-agentcore/runtimes/AtlasCliTeam01_Warmup-*`에 한정한다.
`logs:DescribeLogGroups`는 개별 ARN을 지원하지 않는 조회 작업이어서 `Resource: "*"`를 유지한다.
모델 호출, X-Ray, 계정 단위 로그 정책 변경 권한은 부여하지 않는다.

검증기는 계정·리전·프로젝트 경계 변경, 다른 Runtime/Memory/Gateway 추가,
운영 역할 연결과 외부 코드 경로를 거부한다. 이는 실수 방지 장치이며 IAM 권한 경계의
대체재는 아니다. **synth 성공은 배포 성공, AWS 권한 검증, 리소스 생성 완료를 뜻하지 않는다.**

## 5. 로컬 HTTP 실행과 호출

터미널 A에서 실행한다.

```bash
cd "$ATLAS_CLI"
source ./activate.sh
agentcore dev \
  --runtime Warmup \
  --port 8080 \
  --skip-deploy \
  --no-traces \
  --no-browser \
  --logs
```

`--skip-deploy`를 반드시 유지한다. CLI의 dev 흐름은 필요한 리소스 배포를 자동으로
준비할 수 있으므로, 이 단계에서는 이를 건너뛴다. `--no-traces`는 로컬 trace 수집도 끈다.

같은 프로젝트를 연 터미널 B에서 호출한다.

```bash
cd "$ATLAS_CLI"
source ./activate.sh
curl --fail --silent http://127.0.0.1:8080/ping
agentcore dev "제주에서 CLI 연결 확인" --runtime Warmup --port 8080
curl --fail --silent http://127.0.0.1:8080/invocations \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"제주에서 CLI 연결 확인"}'
```

응답 JSON에서 다음 값을 확인한다. CLI 자체의 표시 형식과 응답 envelope는 명령마다 다를 수 있다.

```json
{
  "project": "AtlasCliTeam01",
  "mode": "deterministic",
  "message": "AgentCore CLI Runtime 연결을 확인했습니다.",
  "echo": "제주에서 CLI 연결 확인",
  "modelInvoked": false
}
```

같은 입력을 두 번 보내도 결과는 같다. `/ping`은 상태 확인용이고 `/invocations`가 함수 호출
경로다. 입력은 `{"prompt":"문자열"}`이며 512자 이하로 제한한다.
잘못된 입력에는 `error: "invalid_prompt"`를 담은 JSON을 반환한다.
애플리케이션 로그에는 `warmup_complete`, 프로젝트와 글자 수만 남긴다.
터미널에 직접 표시되는 응답의 `echo`와 telemetry에 내용을 수집하는 것은 구분한다.

서버는 터미널 A의 `Ctrl+C`로 종료한다. 이 과정에는 Bedrock 모델 호출이 없다.

## 6. 교육용 AWS 계정에서 배포

여기부터는 실제 AWS 자원과 비용이 발생할 수 있다. 다음 조건이 갖추어져야 한다.

1. 명시적으로 선택한 교육용 AWS profile의 계정이 `.atlas-cli-workshop.json`과 같다.
2. 리전은 `ap-northeast-2`이고, 담당자가 준비한 기본 CDK bootstrap 버전이 30 이상이다.
3. 참가자는 이 스택의 CloudFormation 배포, 소유 실행 역할 생성·전달, bootstrap 자산 사용,
   Runtime 생성·호출·조회, 소유 로그 조회에 필요한 권한이 있다.
4. 새 스택 이름과 Runtime 접두사를 다른 참가자나 운영 배포가 사용하지 않는다.

모델 ID나 제공자 API 키는 필요 없다. 이 예제에서 모델 접근을 추가해 해결할 문제도 없다.
AWS profile 이름은 자신의 교육 환경에 맞게 설정한다.

```bash
source ./activate.sh
export AWS_PROFILE=workshop-team01
aws sts get-caller-identity --query Account --output text
cat .atlas-cli-workshop.json
```

계정이 다르면 여기서 멈춘다. 계정이 맞는 경우 다음 기존 bootstrap 버전을 조회한다.

```bash
aws ssm get-parameter \
  --name /cdk-bootstrap/hnb659fds/version \
  --region ap-northeast-2 \
  --query Parameter.Value \
  --output text
```

파라미터가 없거나 값이 30 미만이면 담당자의 환경 준비가 필요하다.
CLI가 bootstrap 생성·업그레이드를 제안해도 이 모듈에서 공유 스택 변경을 승인하지 않는다.

로컬 검증이 통과한 프로젝트에서 배포한다.

```bash
agentcore deploy --target default
```

확인 화면에서는 `AgentCore-AtlasCliTeam01-default`, 지정한 계정,
`ap-northeast-2`가 맞는지 확인한다. 최초 실습에서는 `--yes`로 확인을 생략하지 않는다.
배포 성공 후 CLI가 `agentcore/.cli/`에 기록한 상태와 실제 AWS 상태를 다음 명령으로 확인한다.
그 디렉터리는 참가자의 로컬 상태이므로 다른 팀과 공유하지 않는다.

## 7. 원격 호출·상태·로그

```bash
agentcore status --target default --runtime Warmup --json
agentcore invoke "제주에서 CLI 연결 확인" \
  --runtime Warmup \
  --target default \
  --json
agentcore logs --runtime Warmup --since 10m --limit 30 --json
```

기대 관찰은 내 Runtime ARN과 상태, 로컬과 같은 결정론적 JSON,
CloudWatch의 `warmup_complete` 로그다. 로그에는 도착 지연이 있을 수 있다.
`logs`에는 0.28.1 기준 `--target` 옵션이 없다. 이 예제는 단일 배포 대상만 허용한다.
운영 Runtime ID를 명령에 복사하지 않는다.

명령별 역할은 다음과 같다.

| 명령 | 다루는 대상 |
| --- | --- |
| `create` | 로컬 CLI 프로젝트 scaffold |
| `validate` | 로컬 `agentcore/` 설정 |
| `dev --skip-deploy …` | 로컬 HTTP 서버 또는 실행 중인 로컬 서버 호출 |
| `deploy --target default` | 해당 CLI 프로젝트의 CDK 배포 |
| `invoke --runtime Warmup …` | 배포된 Runtime endpoint |
| `status --runtime Warmup …` | 로컬 정의와 배포 상태 |
| `logs --runtime Warmup …` | 해당 Runtime의 CloudWatch 로그 |
| `remove agent --name Warmup …` | 로컬 Runtime 정의 제거 |

`agentcore dev "문장"`과 `agentcore invoke "문장"`의 호출 대상이 다르다는 점을 확인한다.

## 8. 확인 과제와 진단

- 응답의 `echo`를 한 번 바꿔 보고, 실제 모델 추론을 거친 결과가 아님을 코드로 설명한다.
- `agentcore.json`, `aws-targets.json`, `cdk.out/`가 각각 무엇을 기록하는지 설명한다.
- 로그 ARN의 프로젝트 접두사와 `DescribeLogGroups`의 예외를 찾는다.
- 로컬 테스트 결과와 실제 AWS 배포 결과를 별도 항목으로 기록한다.

| 증상 | 확인할 것 |
| --- | --- |
| `agentcore create`가 harness를 만듦 | 0.28.1 기본 동작이다. 관찰용 생성은 `--no-agent`를 사용한다. |
| 기존 디렉터리라 준비기가 거부함 | 새로운 `--output`을 지정한다. 기존 참가자 작업을 지우지 않는다. |
| `agentcore` 버전이나 옵션이 다름 | `agentcore --version`과 각 `--help`로 0.28.1인지 확인한다. |
| `uv`가 Python 3.14를 찾지 못함 | `uv sync --python 3.14 --frozen`에 필요한 Python 다운로드 경로·프록시를 확인한다. |
| synth에서 ARM64 wheel 설치 실패 | 공개 패키지 접속과 캐시를 확인한다. x86 로컬 설치 성공만으로 ARM64 패키징을 판단하지 않는다. |
| Node `DEP0190` 경고 | 고정 CDK packager의 하위 프로세스 호출 경고다. 종료 코드와 실제 템플릿 검사 결과를 별도로 확인한다. |
| dev가 연결되지 않음 | 터미널 A의 시작 로그, 동일한 `--port`, `/ping` 응답, 기존 포트 사용을 확인한다. |
| dev가 AWS 배포를 준비함 | `--skip-deploy`와 생성 프로젝트의 설정을 확인한다. |
| 배포 시 account/bootstrap 오류 | 계정 일치와 기존 bootstrap 버전을 확인한다. 운영 스택을 변경하지 않는다. |
| 원격 로그가 없음 | 로컬 dev 로그와 CloudWatch를 구분한다. 실제 배포·invoke 수행 여부와 `--since`를 확인한다. |
| `remove` 후에도 Runtime이 존재함 | 로컬 정의만 제거한 상태인지 확인하고 해당 프로젝트의 deploy 또는 소유 스택 삭제를 완료한다. |

## 9. 소유 자원 정리

로컬 dev를 종료하고, 교육용 계정·프로젝트가 맞는지 다시 확인한다.
다음 명령은 이 Runtime을 로컬 정의에서 제거한다. **제거 직후 AWS가 정리된 것은 아니다.**

```bash
agentcore remove agent --name Warmup --yes --json
agentcore validate --json
agentcore deploy --target default
agentcore status --target default --json
```

뒤의 deploy가 제거된 정의를 AWS에 적용한다. 이때 CDK 앱은 Runtime 0개를 허용해
이 스택 소유의 Runtime·역할·정책을 제거한다. 로컬에서도 확인한다.

```bash
npm --prefix agentcore/cdk run synth
python3 checks/check_synth.py --expect-empty
```

기대 결과는 `resourceCount: 0`이다. 빈 CloudFormation 스택까지 삭제할 경우에는
정확히 이 스택만 지정한다.

```bash
aws cloudformation delete-stack \
  --stack-name AgentCore-AtlasCliTeam01-default \
  --region ap-northeast-2
aws cloudformation wait stack-delete-complete \
  --stack-name AgentCore-AtlasCliTeam01-default \
  --region ap-northeast-2
```

서비스가 생성한 로그 그룹은 CloudFormation의 소유 리소스가 아니므로 남을 수 있다.
다음 조회로 **내 접두사에 해당하는 실제 로그 그룹 이름**을 확인한 뒤, 필요한 기록을
보관하고 그 그룹만 삭제한다. 다른 팀이나 운영 로그 그룹을 선택하지 않는다.

```bash
aws logs describe-log-groups \
  --log-group-name-prefix /aws/bedrock-agentcore/runtimes/AtlasCliTeam01_Warmup- \
  --region ap-northeast-2 \
  --query 'logGroups[].logGroupName' \
  --output json
```

공유 CDK bootstrap 스택·버킷과 그 안의 다른 프로젝트 아티팩트는 삭제하지 않는다.
이 모듈은 Transaction Search 설정을 만들지 않으므로 계정 단위 trace 설정을 정리할 이유도 없다.
`remove all`이나 로컬 폴더 삭제를 AWS 정리의 대체 명령으로 쓰지 않는다.
실제 Atlas 스택은 별도 정리 장을 따라 처리한다.

## 공식 근거와 검증 기록

- [AgentCore CLI 공식 소스](https://github.com/aws/agentcore-cli)
- [AgentCore JSON 스키마](https://schema.agentcore.aws.dev/v1/agentcore.json)
- [AgentCore CDK constructs](https://github.com/aws/agentcore-l3-cdk-constructs)
- [이 모듈의 로컬 검증 기록](../cli/VALIDATION.md)

스키마 URL은 업데이트될 수 있다. 이 장은 설치된 CLI 0.28.1의 스키마·도움말과
`@aws/agentcore-cdk` 0.1.0-alpha.50의 공개 scaffold 구성 요소를 함께 확인한 결과를 사용한다.
