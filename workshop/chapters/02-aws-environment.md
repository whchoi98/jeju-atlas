# 02 · AWS 계정과 기존 네트워크

**현재 실습 EC2가 배포된 계정과 VPC**를 사용합니다.
다른 profile·기본 VPC·동일한 Name 태그의 다른 VPC를 임의로 선택하지 않습니다.
해당 VPC의 기존 Public/Private Subnet과 NAT가 필요합니다.
실습 도구는 VPC·서브넷·NAT·IGW·라우트 테이블을 만들지 않습니다.

## 계정과 참가자 이름

EC2에 연결된 실습용 IAM 역할을 기본으로 사용합니다.
액세스 키를 새로 만들거나 `aws configure`로 다른 계정에 전환하지 않습니다.
기존 환경에 AWS profile이 설정되어 있더라도 실제 caller가 EC2 계정과 다르면 중단합니다.
아래 변수와 명령은 EC2 터미널에서 설정합니다.

```bash
cd "$ATLAS_REPO"
export AWS_REGION=ap-northeast-2
export ATLAS_TEAM=team01
export ATLAS_CONFIG="$ATLAS_REPO/workshop/.local/$ATLAS_TEAM.json"
export ATLAS_APP="$ATLAS_REPO/workshop/.local/labs/$ATLAS_TEAM/app"
export ATLAS_CLI="$ATLAS_REPO/workshop/.local/labs/$ATLAS_TEAM/cli"
aws sts get-caller-identity --query '{Account:Account,Arn:Arn}'
```

계정과 역할이 맞는지 확인합니다. 같은 계정에서 `team01`을 여러 참가자가 공유하지 않습니다.

## 현재 EC2에서 설정 자동 생성

```bash
python3 workshop/scripts/lab.py init-ec2 \
  --participant "$ATLAS_TEAM" \
  --config "$ATLAS_CONFIG"

python3 workshop/scripts/lab.py doctor --config "$ATLAS_CONFIG"
```

IMDSv2의 instance identity document와 primary MAC의 VPC ID를 읽고,
STS 호출 계정과 대조한 뒤 같은 VPC의 기존 네트워크를 조회합니다.
메타데이터 token, IAM 자격 증명·user-data는 설정이나 출력에 저장하지 않습니다.
`accountId`, `instanceId`, `region`, `vpcId`와 `createdAwsResources: false`를 확인합니다.

기존 설정 파일은 덮어쓰지 않습니다. 이전 수동 설정을 바꾸어 쓰지 말고 새 EC2 설정을 생성합니다.
참가자는 영문 소문자로 시작하는 3~10자의 영문 소문자·숫자입니다.
운영 이름과 일부 예약 이름은 거부합니다. 설정 JSON에 API 키를 넣지 않습니다.

## 기존 네트워크 검색

```bash
python3 workshop/scripts/lab.py discover --config "$ATLAS_CONFIG"
python3 workshop/scripts/lab.py doctor --aws --config "$ATLAS_CONFIG"
python3 workshop/scripts/lab.py info --config "$ATLAS_CONFIG"
```

`init-ec2`는 최초 검색까지 수행합니다. 이후 `discover`로 다시 확인해도 EC2의 VPC ID에 고정됩니다.
Name 태그가 없어도 같은 VPC를 사용하며, EC2의 계정·VPC 바인딩이 바뀌면 실행을 거부합니다.

- 현재 EC2 primary interface의 VPC와 일치해야 합니다.
- 두 AZ에 Public/Private Subnet이 각각 있어야 합니다.
- Public Subnet 기본 경로는 IGW, Private Subnet 기본 경로는 기존 NAT여야 합니다.
- NAT는 해당 VPC에서 사용 가능해야 하고 Private Subnet 자동 Public IP 할당은 꺼져 있어야 합니다.
- CloudFront origin-facing Prefix List 소유자는 AWS여야 합니다.

검색 실패 시 IMDSv2 접근·IAM 조회 권한·현재 VPC의 네트워크 준비를 확인합니다.
IMDS가 안 되는 로컬 PC에서 대신 실행하거나 다른 VPC를 찾아 계속 진행하지 않습니다.
이 에셋의 검증 리전은 서울이므로 다른 리전의 EC2에서는 자동으로 서울 VPC를 선택하지 않고 중단합니다.
실습을 통과시키려고 운영 라우트나 Public IP 설정을 고치지 않습니다.

## 파생 이름

| 용도 | team01 예 |
|---|---|
| Project 태그·ECR/ECS 접두사 | `jeju-atlas-lab-team01` |
| CloudFormation 접두사 | `AtlasLabTeam01` |
| Guide / Tools | `AtlasLabTeam01_Guide` / `AtlasLabTeam01_Tools` |
| Memory | `AtlasLabTeam01_Memory` |
| CLI 프로젝트 | `AtlasCliTeam01` |
| 데이터 버킷 | `jeju-atlas-lab-team01-data-<계정>-ap-northeast-2` |

기존 `Jeju3d*`, `JejuAtlas_Guide`, `AgentCore-Ohmyjeju-default`는 배포 대상이 아닙니다.
공유 계정·NAT·서비스 한도까지 완전히 격리되는 것은 아니므로 진행자가 용량을 관리합니다.

- [ ] EC2 identity와 STS 계정, 현재 VPC ID·참가자 이름을 확인했습니다.
- [ ] 네트워크와 도구 점검을 통과했습니다.
- [ ] 내 자원의 이름을 확인했습니다.

Codex 카드: [02 · 계정·네트워크](../prompts/02-aws-environment.md)

다음: [03 · Codex 작업 공간](03-codex.md)
