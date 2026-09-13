# 02. 계정과 작업 폴더

이 장은 10분입니다. EC2가 배포된 계정과 기존 네트워크를 확인하고
참가자별 작업 위치를 정합니다. 네트워크 자원을 새로 만드는 단계는 아닙니다.

## 참가자 이름

아래의 `team01`과 `AtlasCliTeam01`을 본인에게 배정된 이름으로 바꿉니다.
프로젝트 이름은 영문으로 시작하고 영문과 숫자만 사용합니다.

```bash
cd "$ATLAS_REPO"
export ATLAS_TEAM=team01
export ATLAS_PROJECT=AtlasCliTeam01
export ATLAS_REGION=ap-northeast-2
export ATLAS_CONFIG="$ATLAS_REPO/workshop/.local/$ATLAS_TEAM.json"
export ATLAS_CLI_PARENT="$ATLAS_REPO/workshop/.local/labs/$ATLAS_TEAM"
export ATLAS_CLI="$ATLAS_CLI_PARENT/$ATLAS_PROJECT"
aws sts get-caller-identity --query '{Account:Account,Arn:Arn}'
```

현재 EC2의 실습 역할인지 확인합니다.
다른 계정의 profile로 바꾸거나 액세스 키를 새로 만들지 않습니다.

## EC2와 기존 네트워크 확인

```bash
python3 workshop/scripts/lab.py init-ec2 --identity-only \
  --participant "$ATLAS_TEAM" \
  --config "$ATLAS_CONFIG"
python3 workshop/scripts/lab.py info --config "$ATLAS_CONFIG"
```

`--identity-only`는 IMDSv2로 EC2의 계정, 리전과 VPC를 읽고 STS 계정과 대조합니다.
기존 네트워크의 식별자를 확인하며 Public/Private Subnet 수나 CloudFront 설정까지 요구하지 않습니다.
출력의 `createdAwsResources: false`, `networkChecked: false`와 본인 계정, VPC, 참가자 이름을 확인합니다.
네트워크 전체 구성을 검사했다는 의미는 아닙니다.
같은 설정이 이미 있으면 덮어쓰지 말고 `info`로 이어서 확인합니다.

`info`의 app/cli 경로는 기존 심화 준비기의 경로입니다.
본 실습의 새 프로젝트는 `$ATLAS_CLI_PARENT/$ATLAS_PROJECT`에 생성합니다.
05장에서 전체 웹 배포를 선택하면 `discover`로 그때 필요한 서브넷과 NAT 경로를 확인합니다.

## CLI 설정 위치

```bash
export ATLAS_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
export AGENTCORE_CONFIG_DIR="$ATLAS_CLI_PARENT/cli-config"
export AGENTCORE_TELEMETRY_DISABLED=1
mkdir -p "$AGENTCORE_CONFIG_DIR"
```

`ATLAS_ACCOUNT`가 방금 확인한 EC2 계정과 같아야 합니다.
CLI 설정은 이 참가자의 폴더에만 저장합니다.
진행자가 다음 내용을 `cli-config/config.json`에 준비했는지 확인합니다.

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
사용할 모델 ID도 배정받습니다. 기본 예시는 `global.openai.gpt-5.6-sol`입니다.
모델 ID를 알고 있다는 사실만으로 호출 권한이 확인되지는 않습니다.

프롬프트: [계정 확인](../prompts/02-aws-environment.md)

다음: [03. AI CLI로 에이전트 구현](03-codex.md)
