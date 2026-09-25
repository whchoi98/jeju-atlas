# .env, Bedrock 단기키와 선택 연동

본 실습의 필수 키는 **Bedrock 단기 API 키 한 개**입니다.\
카카오, 한국관광공사 TourAPI와 VISIT JEJU 키는 배포 후 필요한 기능만 연결합니다.\
키가 없어도 제공된 137개 시드로 제주 검색 도구와 Runtime을 구현할 수 있습니다.

## 본인 터미널에서 입력

활성화한 EC2 Bash에서 실행합니다.\
AI 대화창에 키를 붙여 넣지 않습니다.

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
python3 "$ATLAS_REPO/workshop/scripts/workshop_env.py" configure
python3 "$ATLAS_REPO/workshop/scripts/workshop_env.py" status
}
```
다음 두 항목을 입력합니다.\
키 입력은 화면에 보이지 않습니다.

| 입력 | 저장 이름 | 의미 |
|---|---|---|
| 발급 리전 | `ATLAS_BEDROCK_REGION` | Bedrock 콘솔에서 단기키를 만든 리전 |
| 단기키 | `AWS_BEARER_TOKEN_BEDROCK` | 모델 요청의 Bearer 인증 |

저장 파일은 **`$ATLAS_CLI_PARENT/.env`**, 권한은 `0600`입니다.\
`status`는 키 존재 여부와 발급 리전을 표시하며 키 값을 출력하지 않습니다.\
기존 키를 그대로 사용할 때는 입력에서 Enter를 누릅니다.

도구는 `.env`를 데이터로 읽으며 `source .env`를 실행하지 않습니다.\
파일은 Git 제외 경로이며 Runtime의 `app/JejuGuide/` 밖에 둡니다.

단기키는 발급한 리전에서 사용하며 콘솔 세션 종료 시 또는 최대 12시간 안에 만료됩니다.\
수업 직전에 발급해 사용합니다.

실제 키 유효성은 Bedrock 호출 결과로 확인합니다. 기본 흐름에 별도 모델 사전 호출을 추가하지 않습니다.\
키를 바꾸면서 발급 리전을 그대로 추측하지 않습니다.

## 세 가지 인증 구분

| 대상 | 사용하는 인증 |
|---|---|
| Codex, Claude Code, Kiro CLI | 사전에 준비한 각 도구의 로그인과 provider |
| AWS 배포, SSM/IAM 작업, AgentCore Runtime 호출 | 현재 EC2의 실습 IAM 역할 |
| JejuGuide의 Bedrock 모델 호출 | `.env`에서 입력한 단기 API 키 |

Bedrock 키만으로 STS, CloudFormation 배포나 AgentCore의 IAM 호출 인증을 대신할 수 없습니다.\
코딩 CLI가 이미 대화 중이라면 해당 인증을 재설정하지 않습니다.

같은 키가 모든 CLI provider에 적용된다고 가정하지 않습니다.\
심화 과정의 Atlas Guide/Tools는 별도 배포이며, 기본 CLI의 키 연결이 자동 적용되지 않습니다.

## 로컬 호출과 배포 연결

키나 모델 접근 오류를 구분해야 하는 경우에만 [02장](../chapters/02-aws-environment.md)의 `model_check.py --env-file ... --execute`를 한 번 선택합니다.\
이 호출은 유료 모델 요청이며 `doctor`나 교재 검사에 포함하지 않습니다.\
인증 실패, SCP 거부와 만료는 실패로 기록하고 같은 조건으로 반복하지 않습니다.

로컬 Runtime 진단도 오류가 있는 경우에만 선택합니다.\
정상 진행 중에는 아래 `agentcore dev`를 생략하고 바로 배포할 수 있습니다.\
선택한 경우 자식 프로세스에만 키를 전달합니다.

```bash
cd "$ATLAS_CLI" && {
python3 "$ATLAS_REPO/workshop/scripts/workshop_env.py" run -- \
  agentcore dev --runtime JejuGuide --port 8080 --skip-deploy --no-traces --no-browser --logs
}
```
배포 전에는 AI가 [04장 프롬프트](../prompts/04-agentcore-cli.md)의 범위에서 다음을 수행합니다.

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
python3 "$ATLAS_REPO/workshop/scripts/workshop_env.py" publish --project "$ATLAS_CLI"
python3 "$ATLAS_REPO/workshop/scripts/workshop_env.py" publish --project "$ATLAS_CLI" --execute
}
```
첫 명령은 키를 읽거나 AWS를 호출하지 않는 계획입니다.\
실제 실행은 현재 STS 계정을 참가자 설정과 대조하고, 다음 자원을 소유 태그로 확인해 생성 또는 재사용합니다.

| 자원 | `team01` 예시 |
|---|---|
| SSM SecureString | `/jeju-atlas-lab-team01/bedrock-api-key` |
| IAM managed policy | `/jeju-atlas/AtlasCliTeam01-bedrock-key` |
| Runtime 설정 | `ATLAS_BEDROCK_API_KEY_SSM_ARN`, 호출 리전과 인증 방식 |

정책은 해당 SSM ARN 한 개의 `ssm:GetParameter`만 허용합니다.\
Runtime의 `additionalPolicies`로 연결되며, `agentcore deploy`가 실행 역할에 적용합니다.\
키 원문은 CLI JSON, CloudFormation 템플릿이나 ZIP에 넣지 않습니다.

진행자는 `ssm:PutParameter`, 파라미터/태그 조회와 위 전용 IAM 정책의 생성/조회 권한도 사전에 준비합니다.\
수업 준비가 끝난 공유 CDK bootstrap은 참가자가 다시 생성하지 않습니다.

4KiB를 넘는 키는 SSM Advanced 계층을 사용하며 계획 후 실행 결과에 계층을 표시합니다.\
이미 Advanced인 파라미터는 갱신 키가 작아져도 같은 계층을 유지합니다.

키 게시 성공은 Runtime 배포나 모델 응답 성공을 뜻하지 않습니다.\
이어 `agentcore deploy`, `status`, `invoke`의 실제 결과를 확인합니다.

## 만료되거나 리전을 바꿨을 때

새 키를 터미널에서 입력한 뒤 같은 소유 파라미터를 갱신합니다.

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
python3 "$ATLAS_REPO/workshop/scripts/workshop_env.py" configure
python3 "$ATLAS_REPO/workshop/scripts/workshop_env.py" publish --project "$ATLAS_CLI" --execute
}
```
로컬 dev 서버는 종료 후 다시 시작합니다.\
원격 Runtime은 새 대화 세션에서 확인합니다.\
모델 로더는 새 Agent를 만들 때 SSM 키를 다시 읽습니다.

호출 리전 등 Runtime 설정이 달라졌다면 같은 프로젝트를 다시 배포합니다.\
기존 대화의 이미 생성된 모델 클라이언트가 자동으로 갱신됐다고 가정하지 않습니다.\
프로젝트나 계정을 바꾸어 처음부터 설치하지 않습니다.

## 배포 후 선택 키 입력

필요한 키만 입력하며 나머지는 Enter로 건너뜁니다.\
이 작업은 로컬 파일만 갱신합니다.

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
python3 "$ATLAS_REPO/workshop/scripts/workshop_env.py" configure --integrations
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
python3 "$ATLAS_REPO/workshop/scripts/lab.py" set-secret --provider kakao \
  --config "$ATLAS_CONFIG" --env-file "$ATLAS_CLI_PARENT/.env" --execute
}
```
TourAPI는 `--provider tourapi`, VISIT JEJU는 `--provider visitjeju`입니다.\
명령은 지정한 제공처 키만 읽으며, 키가 비어 있으면 AWS 작업 전에 중단합니다.\
키를 저장한 뒤 앱 재배포 또는 worker 실행과 결과 확인이 필요합니다.

[10장](../chapters/10-enrichment.md)에서 연결 절차를 진행합니다.\
기본 Runtime만 배포한 참가자는 전체 앱을 준비할 때까지 이 단계를 건너뜁니다.

## 키 자원 정리

04장에서 `JejuGuide` 제거를 배포하고 소유 실행 역할의 정리를 확인한 후 실행합니다.

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
python3 "$ATLAS_REPO/workshop/scripts/workshop_env.py" cleanup --project "$ATLAS_CLI"
python3 "$ATLAS_REPO/workshop/scripts/workshop_env.py" cleanup --project "$ATLAS_CLI" --execute
}
```
현재 계정과 소유 태그를 확인하며 정책이 역할에 붙어 있으면 중단합니다.\
기본 실습의 Bedrock 파라미터와 정책만 지우고 로컬 `.env`는 보존합니다.

연장 실습에 남길 경우 자원 이름과 정리 담당자를 `RESULTS.md`에 기록합니다.\
선택 제공처 키와 전체 앱 자원은 [13장](../chapters/13-cleanup.md) 범위에서 별도로 정리합니다.

## 공식 근거

- [Bedrock 단기키 발급과 만료](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-generate.html)
- [Bedrock 키의 환경변수와 SDK 사용](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys-use.html)
- [AgentCore CLI](https://github.com/aws/agentcore-cli)

2026-09-24에 공식 키 사용 안내를 대조했습니다.\
로컬 테스트는 키 유효성이나 새 계정의 Runtime 모델 호출 성공을 검증하지 않습니다.
