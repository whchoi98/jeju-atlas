# .env, Bedrock API 키와 선택 연동

본 실습의 필수 키는 **Bedrock API 키 한 개**입니다.\
**단기키와 장기키를 모두 허용**하며 같은 `.env` 입력과 Bearer 인증을 사용합니다.\
기본 JejuGuide와 06장의 심화 Guide는 **01장에서 처음 입력한 것과 같은 키**를 사용합니다.

카카오, 한국관광공사 TourAPI와 VISIT JEJU 키는 배포 후 필요한 기능만 연결합니다.\
키가 없어도 제공된 137개 시드로 제주 검색 도구와 Runtime을 구현할 수 있습니다.

## 본인 터미널에서 입력

활성화한 EC2 Bash에서 실행합니다.\
명령은 사전 구성의 `helperPython`과 같은 `ATLAS_PYTHON`을 사용합니다.\
AI 대화창에 키를 붙여 넣지 않습니다.

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/workshop_env.py" configure &&
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/workshop_env.py" status
}
```
다음 두 항목을 입력합니다.\
키 입력은 화면에 보이지 않습니다.

| 입력 | 저장 이름 | 의미 |
|---|---|---|
| 모델 호출 리전 | `ATLAS_BEDROCK_REGION` | 단기키는 발급 리전, 장기키는 키 권한으로 모델을 사용할 수 있는 리전 |
| API 키 | `AWS_BEARER_TOKEN_BEDROCK` | 단기 또는 장기 Bedrock API 키, 모델 요청의 Bearer 인증 |

저장 파일은 **`$ATLAS_CLI_PARENT/.env`**, 권한은 `0600`입니다.\
`status`는 키 존재 여부와 호출 리전을 표시하며 키 값을 출력하지 않습니다.\
기존 키를 그대로 사용할 때는 입력에서 Enter를 누릅니다.

도구는 `.env`를 데이터로 읽으며 `source .env`를 실행하지 않습니다.\
파일은 Git 제외 경로이며 Runtime의 `app/JejuGuide/` 밖에 둡니다.

| 선택한 키 | 사용할 때 확인할 내용 |
|---|---|
| 단기 API 키 | 발급한 리전에서 사용합니다. 콘솔 세션 종료 시 또는 최대 12시간 안에 만료되므로 수업 직전에 준비합니다. |
| 장기 API 키 | 키에 연결된 IAM 권한으로 모델을 호출합니다. 사용할 리전과 모델이 허용되어 있는지 진행자가 확인합니다. |

Bedrock 콘솔의 API keys에서 준비한 키를 본인 터미널에 입력합니다.\
워크샵 입력 도구는 키 유형이나 만료 시각을 묻지 않습니다.

실제 키 유효성은 Bedrock 호출 결과로 확인합니다. 기본 흐름에 별도 모델 사전 호출을 추가하지 않습니다.\
키를 바꾸면 해당 키로 사용할 호출 리전도 확인합니다.

## 세 가지 인증 구분

| 대상 | 사용하는 인증 |
|---|---|
| Codex, Claude Code, Kiro CLI | 사전에 준비한 각 도구의 로그인과 provider |
| AWS 배포, SSM/IAM 작업, AgentCore Runtime 호출 | 현재 EC2의 실습 IAM 역할 |
| Gateway와 Memory 접근 | 심화 Runtime 역할의 IAM |
| JejuGuide와 심화 Guide의 Bedrock 모델 호출 | 01장의 원본 `.env`에 입력한 같은 단기 또는 장기 API 키 |

Bedrock 키만으로 STS, CloudFormation 배포나 AgentCore의 IAM 호출 인증을 대신할 수 없습니다.\
코딩 CLI가 이미 대화 중이라면 해당 인증을 재설정하지 않습니다.

같은 키가 모든 CLI provider에 적용된다고 가정하지 않습니다.\
심화 과정의 Atlas Guide/Tools는 별도 배포입니다.\
06장의 `agent-key`로 같은 키와 SSM 정책을 심화 Guide에 연결합니다.

## 로컬 호출과 배포 연결

키나 모델 접근 오류를 구분해야 하는 경우에만 [02장](../chapters/02-aws-environment.md)의 `model_check.py --env-file ... --execute`를 한 번 선택합니다.\
이 호출은 유료 모델 요청이며 `doctor`나 교재 검사에 포함하지 않습니다.\
인증 실패, SCP 거부와 만료는 실패로 기록하고 같은 조건으로 반복하지 않습니다.

로컬 Runtime 진단도 오류가 있는 경우에만 선택합니다.\
정상 진행 중에는 아래 `agentcore dev`를 생략하고 바로 배포할 수 있습니다.\
선택한 경우 자식 프로세스에만 키를 전달합니다.

```bash
cd -- "${ATLAS_CLI:?먼저 01장의 activate.sh를 source하세요}" && {
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/workshop_env.py" run -- \
  agentcore dev --runtime JejuGuide --port 8080 --skip-deploy --no-traces --no-browser --logs
}
```
배포 전에는 AI가 [04장 프롬프트](../prompts/04-agentcore-cli.md)의 범위에서 다음을 수행합니다.

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/workshop_env.py" publish --project "$ATLAS_CLI" &&
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/workshop_env.py" publish --project "$ATLAS_CLI" --execute
}
```
첫 명령은 키를 읽거나 AWS를 호출하지 않는 계획입니다.\
실제 실행은 현재 STS 계정을 참가자 설정과 대조하고, 다음 자원을 소유 태그로 확인해 생성 또는 재사용합니다.

| 자원 | `team01` 예시 |
|---|---|
| SSM SecureString | `/jeju-atlas-lab-team01/bedrock-api-key` |
| IAM managed policy | `/jeju-atlas/AtlasCliTeam01-bedrock-key` |
| Runtime 설정 | `ATLAS_BEDROCK_AUTH=api-key`, `ATLAS_BEDROCK_API_KEY_SSM_ARN`과 호출 리전 |

정책은 해당 SSM ARN 한 개의 `ssm:GetParameter`만 허용합니다.\
기본 Runtime의 `additionalPolicies`로 연결되며, `agentcore deploy`가 실행 역할에 적용합니다.\
키 원문은 CLI JSON, CloudFormation 템플릿이나 ZIP에 넣지 않습니다.

진행자는 `ssm:PutParameter`, 파라미터/태그 조회와 위 전용 IAM 정책의 생성/조회 권한도 사전에 준비합니다.\
수업 준비가 끝난 공유 CDK bootstrap은 참가자가 다시 생성하지 않습니다.

4KiB를 넘는 키는 SSM Advanced 계층을 사용하며 계획 후 실행 결과에 계층을 표시합니다.\
이미 Advanced인 파라미터는 갱신 키가 작아져도 같은 계층을 유지합니다.

키 게시 성공은 Runtime 배포나 모델 응답 성공을 뜻하지 않습니다.\
이어 `agentcore deploy`, `status`, `invoke`의 실제 결과를 확인합니다.

## 06장 Guide에 같은 키 연결

05장의 app과 Data 스택, 카탈로그가 준비된 상태에서 이어갑니다.\
배포와 모델 호출에는 선택한 서울 `ap-northeast-2`를 사용합니다.\
키를 다시 입력하거나 별도 `.env`를 만들지 않습니다.

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
"$ATLAS_PYTHON" -B workshop/scripts/lab.py model-region \
  --config "$ATLAS_CONFIG" --caller-region ap-northeast-2 &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py agent-key --config "$ATLAS_CONFIG" --execute
}
```

`agent-key --execute`는 소유 core 세션과 app, 현재 AWS 계정을 검증합니다.\
01장의 원본 `$ATLAS_CLI_PARENT/.env`를 데이터로 읽습니다.\
파일의 `ATLAS_BEDROCK_REGION`이 설정의 `bedrockCallerRegion`과 같아야 진행합니다.

선택 옵션 `--env-file "$ATLAS_CLI_PARENT/.env"`도 반드시 그 원본 참가자 파일을 가리켜야 합니다.\
app에 복사한 파일이나 다른 참가자의 `.env`를 지정하지 않습니다.\
리전이 다르면 원본 경로와 키의 사용 가능 리전을 확인합니다.

로컬 미리보기만 필요하면 `--execute`를 뺍니다.\
다음 명령은 키를 읽거나 AWS를 호출하지 않습니다.

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
"$ATLAS_PYTHON" -B workshop/scripts/lab.py agent-key --config "$ATLAS_CONFIG"
}
```

helper는 04장과 **같은 SSM 파라미터와 단일 파라미터 managed policy**를 게시하거나 재사용합니다.\
참가자 app의 `GuideRole.ManagedPolicyArns`에 공유 정책을 연결합니다.\
GuideRole의 Bedrock 모델 IAM 권한은 넓히지 않습니다.

app의 기존 `agent/guide/model/load.py`, 새 `agent/guide/model/workshop_auth.py`와 `infra/agentcore.yaml`을 반영합니다.\
변경할 기존 파일은 비공개 `app/.local`에 백업합니다.\
직접 수정한 사용자 로더는 덮어쓰지 않고 중단하며, 오류 시 원본 소스와 app 상태를 보존합니다.

키 관련 Runtime 환경에는 `ATLAS_BEDROCK_AUTH=api-key`와 `ATLAS_BEDROCK_API_KEY_SSM_ARN`만 전달합니다.\
키 원문은 Runtime 환경이나 배포 파일에 넣지 않습니다.\
로더는 SecureString을 읽어 Bedrock에만 Bearer 인증을 사용하며 IAM 모델 인증으로 대체하지 않습니다.

Gateway, Memory, AWS 제어 작업과 Runtime 인바운드 인증은 계속 IAM입니다.\
기본 흐름에는 모델 사전 호출이나 IAM 정책 시뮬레이터를 추가하지 않습니다.

정상 순서는 `model-region → agent-key → agent-build → agent-publish → agent-plan`입니다.\
키 연결 뒤 [06장의 코드 빌드와 게시, 계획 생성](../chapters/06-atlas-agentcore.md#1-코드-빌드와-게시-배포-계획-생성)을 이어서 수행합니다.\
계획 준비 완료 뒤 `agent-apply`, 스택 완료까지 `agent-status`, 완료 후 로그 설정을 각각 실행합니다.

이미 배포한 IAM Guide는 [기존 Guide 전환](../chapters/06-atlas-agentcore.md#기존-iam-guide를-같은-api-키로-전환)을 따릅니다.\
소스 루트의 `git pull --ff-only origin main` 뒤 `agent-key`와 코드 빌드, 게시, 계획, 적용, 상태 확인이 필요합니다.\
기존 app 재준비, 의존성 ZIP 재빌드, 스택 재생성과 키 재입력은 하지 않습니다.

## 만료되거나 리전을 바꿨을 때

갱신할 키를 본인 터미널에서 원본 `.env`에 입력합니다.\
기본 Runtime과 심화 Guide에 별도로 입력하지 않습니다.

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/workshop_env.py" configure
}
```

기본 실습만 진행했다면 같은 소유 파라미터를 `publish`로 갱신합니다.

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/workshop_env.py" publish --project "$ATLAS_CLI" --execute
}
```

심화 Guide까지 연결했다면 위 게시 명령 대신 `agent-key`로 갱신할 수 있습니다.\
두 명령은 같은 파라미터를 사용하므로 둘 다 실행할 필요는 없습니다.

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
"$ATLAS_PYTHON" -B workshop/scripts/lab.py agent-key --config "$ATLAS_CONFIG" --execute
}
```

같은 SSM ARN의 키 값만 바뀌면 정책을 재사용하며 소스 재빌드나 재배포는 필요하지 않습니다.\
새로 생성되는 모델 클라이언트는 갱신된 SSM 버전을 읽습니다.\
진행 중인 요청이나 기존 모델 인스턴스가 자동으로 바뀐다고 보장하지 않습니다.

로컬 dev 서버를 사용 중이면 종료 후 다시 시작합니다.\
호출 리전, 역할, Runtime 환경이나 소스가 달라졌다면 같은 프로젝트에 해당 변경을 다시 배포합니다.\
심화 Guide는 원본 `.env` 리전과 `bedrockCallerRegion`의 일치를 먼저 확인합니다.

프로젝트나 계정을 바꾸어 처음부터 설치하지 않습니다.

## 배포 후 선택 키 입력

필요한 키만 입력하며 나머지는 Enter로 건너뜁니다.\
이 작업은 로컬 파일만 갱신합니다.

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/workshop_env.py" configure --integrations
}
```
| 제공처 | `.env` 입력 이름 | 이후 작업 |
|---|---|---|
| 카카오 Local | `KAKAO_REST_API_KEY` | 서버 조회용 REST 키, 참가자 App 설정과 ECS secrets |
| 한국관광공사 TourAPI | `TOURAPI_SERVICE_KEY` | 공식 상세 수집 worker의 전용 SSM 키 |
| VISIT JEJU | `VISIT_JEJU_API_KEY` | 공식 제주 상세 수집 worker의 전용 SSM 키 |

TourAPI와 VISIT JEJU의 환경변수 이름은 워크숍 입력 도구의 이름입니다.\
실제 수집기는 참가자별 SSM 파라미터를 읽습니다.\
05~09장의 전체 앱을 준비한 후 필요한 제공처만 게시합니다.

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/lab.py" set-secret --provider kakao \
  --config "$ATLAS_CONFIG" --env-file "$ATLAS_CLI_PARENT/.env" --execute
}
```
TourAPI는 `--provider tourapi`, VISIT JEJU는 `--provider visitjeju`입니다.\
명령은 지정한 제공처 키만 읽으며, 키가 비어 있으면 AWS 작업 전에 중단합니다.\
키를 저장한 뒤 앱 재배포 또는 worker 실행과 결과 확인이 필요합니다.

[10장](../chapters/10-enrichment.md)에서 연결 절차를 진행합니다.\
기본 Runtime만 배포한 참가자는 전체 앱을 준비할 때까지 이 단계를 건너뜁니다.

## 키 자원 정리

공유 키는 **기본 JejuGuide 역할과 심화 GuideRole 양쪽에서 정책 연결이 해제된 뒤에만** 정리합니다.\
04장의 기본 Runtime 제거만으로 심화 Guide의 키를 삭제하지 않습니다.

기본 Runtime 제거 배포와 심화 Guide의 정리 또는 정책 연결 해제가 실제로 완료됐는지 확인합니다.\
아직 사용하는 역할이 있으면 SSM 파라미터와 정책을 유지합니다.

심화 Guide를 배포하지 않았다면 기본 역할의 연결 해제를 확인합니다.

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/workshop_env.py" cleanup --project "$ATLAS_CLI" &&
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/workshop_env.py" cleanup --project "$ATLAS_CLI" --execute
}
```
현재 계정과 소유 태그를 확인합니다.\
기존 IAM 연결 검사는 정책이 역할, 사용자나 그룹에 붙어 있으면 중단해 조기 삭제를 차단합니다.\
공유 Bedrock 파라미터와 정책만 지우고 로컬 `.env`는 보존합니다.

연장 실습에 남길 경우 자원 이름과 정리 담당자를 `RESULTS.md`에 기록합니다.\
선택 제공처 키와 전체 앱 자원은 [13장](../chapters/13-cleanup.md) 범위에서 별도로 정리합니다.

## 공식 근거

- [Bedrock API 키 발급과 만료](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-generate.html)
- [Bedrock 키의 환경변수와 SDK 사용](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-use.html)
- [AgentCore CLI](https://github.com/aws/agentcore-cli)

2026-09-24에 공식 키 사용 안내를 대조했습니다.\
로컬 테스트는 키 유효성이나 새 계정의 Runtime 모델 호출 성공을 검증하지 않습니다.
