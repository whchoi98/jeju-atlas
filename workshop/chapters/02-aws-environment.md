# 02. 계정과 작업 폴더

이 장은 10분입니다. EC2가 배포된 계정과 기존 네트워크를 확인하고
참가자별 작업 위치를 정합니다. 네트워크 자원을 새로 만드는 단계는 아닙니다.

## 참가자 환경과 계정

01장에서 참가자 이름과 프로젝트를 정하고 `activate.sh`를 불러왔습니다.
새 터미널이라면 먼저 그 활성화 명령을 다시 실행합니다.

```bash
python3 -B "${ATLAS_REPO:?01장의 activate.sh를 먼저 source하세요}/workshop/scripts/core.py" \
  doctor --assistant "${ATLAS_ASSISTANT:?}" &&
aws sts get-caller-identity --query '{Account:Account,Arn:Arn}'
```

현재 EC2의 실습 역할인지 확인합니다.
다른 계정의 profile로 바꾸거나 액세스 키를 새로 만들지 않습니다.
`ATLAS_CLI`는 `$ATLAS_REPO/workshop/.local/labs/$ATLAS_TEAM/$ATLAS_PROJECT`입니다.

## EC2와 기존 네트워크 확인

```bash
(
  set -e
  cd -- "${ATLAS_REPO:?}"
  if [[ ! -e "${ATLAS_CONFIG:?}" && ! -L "$ATLAS_CONFIG" ]]; then
    python3 workshop/scripts/lab.py init-ec2 --identity-only \
      --participant "${ATLAS_TEAM:?}" --config "$ATLAS_CONFIG"
  fi
  python3 workshop/scripts/lab.py info --config "$ATLAS_CONFIG"
)
```

`--identity-only`는 IMDSv2로 EC2의 계정, 리전과 VPC를 읽고 STS 계정과 대조합니다.
기존 네트워크의 식별자를 확인하며 Public/Private Subnet 수나 CloudFront 설정까지 요구하지 않습니다.
출력의 `createdAwsResources: false`, `networkChecked: false`와 본인 계정, VPC, 참가자 이름을 확인합니다.
네트워크 전체 구성을 검사했다는 의미는 아닙니다.
같은 설정이 이미 있으면 덮어쓰지 말고 `info`로 이어서 확인합니다.

`info`의 app/cli 경로는 기존 심화 준비기의 경로입니다.
본 실습의 새 프로젝트는 `$ATLAS_CLI_PARENT/$ATLAS_PROJECT`에 생성합니다.
05장에서 전체 웹 배포를 선택하면 `discover`로 그때 필요한 서브넷과 NAT 경로를 확인합니다.

## 계정 변수와 CLI 설정

```bash
source "${ATLAS_CLI_PARENT:?}/activate.sh" &&
python3 -B "$ATLAS_REPO/workshop/scripts/core.py" doctor --assistant "$ATLAS_ASSISTANT"
```

활성화가 방금 저장한 비밀값 없는 설정에서 `ATLAS_ACCOUNT`를 읽습니다.
이 값이 STS에서 확인한 계정과 같아야 합니다. 새 터미널에서도 같은 방법으로 복원합니다.
`AGENTCORE_CONFIG_DIR`는 `$ATLAS_CLI_PARENT/cli-config`이며,
01장 준비기가 다음 설정을 생성했습니다. 활성화와 사전검사 모두 이를 검사하고,
파일이 없거나 비활성화 설정이 다르면 중단합니다.

```json
{
  "disableDependencyManagement": true,
  "disableTransactionSearch": true,
  "telemetry": { "enabled": false }
}
```

본 실습은 AgentCore의 관리형 PUBLIC 네트워크 모드와 IAM 인증을 사용합니다.
이는 에이전트를 익명 공개한다는 의미가 아닙니다.
기존 VPC의 Private Subnet에 Fargate를 배포하는 작업은 08장의 심화 실습입니다.

## 배포 준비 확인

진행자는 Bedrock 모델 호출, Runtime 생성과 호출, CloudFormation,
IAM 역할 전달 권한과 기존 CDK bootstrap을 미리 점검합니다.
모델은 **Claude Sonnet 4.6**, Bedrock ID는 `global.anthropic.claude-sonnet-4-6`으로 고정합니다.
모델 ID를 알고 있다는 사실만으로 호출 권한이 확인되지는 않습니다.
로컬 사전검사의 `awsChecked: false`와 `modelInvoked: false`는 이 권한을
검사하지 않았다는 뜻입니다. 04장에서는 생성한 프로젝트의 대상과 소스도 별도로 검사합니다.

## 배포 리전과 Bedrock 호출 리전

`ATLAS_REGION`, `AWS_REGION`, `aws-targets.json`의 배포 대상은 계속 `ap-northeast-2`입니다.
Bedrock 클라이언트의 호출 리전은 주최자가 정책과 실제 호출로 확인한
`ATLAS_BEDROCK_REGION`을 별도로 사용합니다. 배포 리전을 호출 리전의 허용 증거로 삼지 않습니다.
Global 추론 프로필이 실제 추론을 처리하는 목적지 리전도 클라이언트의 호출 리전과 다릅니다.
[공식 문서 대조](../reference/official-guide-review.md)를 참고합니다.

2026-09-15 참가자 EC2의 실제 AWS CLI Converse 호출은 위 모델과 서울 호출 리전에서
`AccessDeniedException`으로 실패했습니다. `bedrock:InvokeModel`에 대한 **SCP 명시적 거부**입니다.
이 결과는 통과가 아니며 다른 리전의 성공을 의미하지도 않습니다.
동일 조건을 반복하거나 IAM/SCP를 바꾸어 우회하지 말고 주최자의 정책 확인을 기다립니다.

## 작은 실제 모델 검사

다음은 읽기 전용 doctor와 별개인 **실제 유료 모델 요청**입니다.
주최자가 확인한 호출 리전을 Bash의 `ATLAS_BEDROCK_REGION`에 지정한 뒤,
참가자 EC2에서 한 번만 실행합니다. 아직 확인된 리전이 없다면 실행하지 않습니다.

```bash
python3 -B "${ATLAS_REPO:?}/workshop/scripts/model_check.py" \
  --caller-region "${ATLAS_BEDROCK_REGION:?주최자가 확인한 호출 리전을 먼저 지정하세요}" \
  --report "$ATLAS_REPO/workshop/.local/model-checks/sonnet-$(date -u +%Y%m%dT%H%M%SZ).json" \
  --execute
```

검사기는 `Reply with exactly OK.` 한 문장과 최대 출력 16토큰으로 Converse를 한 번만 요청합니다.
모델 ID, 호출/배포 리전, 응답, 종료 사유와 실패를 기록하며 다른 리전으로 재시도하지 않습니다.
`passed: true`와 실제 `OK` 응답을 함께 확인합니다. AccessDenied, 응답 끊김,
예상과 다른 응답은 실패로 남습니다. 보고서와 참가자 식별 정보는 `.local`에 보관합니다.
`--execute`를 빼면 계획만 표시하고 AWS나 모델을 호출하지 않습니다.

확인한 호출 리전을 참가자 설정에 기록합니다. 이 명령 자체는 권한을 검증하지 않습니다.

```bash
python3 "${ATLAS_REPO:?}/workshop/scripts/lab.py" model-region \
  --caller-region "${ATLAS_BEDROCK_REGION:?}" --config "${ATLAS_CONFIG:?}"
```

EC2 역할에서 성공해도 배포 Runtime의 실행 역할에서 성공한 것은 아닙니다.
Runtime 역할과 Global 추론 프로필의 IAM/SCP 검토는 주최자가 별도로 수행합니다.

프롬프트: [계정 확인](../prompts/02-aws-environment.md)

다음: [03. AI CLI로 에이전트 구현](03-codex.md)
