# 02 · AWS 계정과 기존 네트워크

현재 계정의 별도 실습 스택이나 참가자별 계정을 사용할 수 있습니다.
어느 경우에도 기존 VPC의 Public/Private Subnet과 NAT가 필요합니다.
실습 도구는 VPC·서브넷·NAT·IGW·라우트 테이블을 만들지 않습니다.

## 계정과 참가자 이름

진행자가 제공한 AWS profile 또는 EC2의 실습용 역할을 사용합니다.
SSO profile을 사용하는 호스트의 예입니다.

```bash
# SSO profile을 사용하는 경우에만 실행합니다.
export AWS_PROFILE=workshop
aws sso login --profile "$AWS_PROFILE"
```

EC2 역할을 사용하는 경우 위 profile 예제를 그대로 실행하지 않습니다.
이후 공통 변수를 설정합니다.

```bash
cd "$ATLAS_REPO"
export AWS_REGION=ap-northeast-2
export ATLAS_TEAM=team01
export ATLAS_CONFIG="$ATLAS_REPO/workshop/.local/$ATLAS_TEAM.json"
export ATLAS_APP="$ATLAS_REPO/workshop/.local/labs/$ATLAS_TEAM/app"
export ATLAS_CLI="$ATLAS_REPO/workshop/.local/labs/$ATLAS_TEAM/cli"
export ATLAS_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
aws sts get-caller-identity --query '{Account:Account,Arn:Arn}'
```

계정과 역할이 맞는지 확인합니다. 같은 계정에서 `team01`을 여러 참가자가 공유하지 않습니다.

## 설정 생성

```bash
python3 workshop/scripts/lab.py init \
  --participant "$ATLAS_TEAM" \
  --account-id "$ATLAS_ACCOUNT" \
  --profile "${AWS_PROFILE:-}" \
  --vpc-name cc-on-bedrock-vpc \
  --config "$ATLAS_CONFIG"

python3 workshop/scripts/lab.py doctor --config "$ATLAS_CONFIG"
```

기존 설정 파일은 덮어쓰지 않습니다.
계정은 12자리 숫자, 참가자는 영문 소문자로 시작하는 3~10자의 영문 소문자·숫자입니다.
운영 이름과 일부 예약 이름은 거부합니다. 설정 JSON에 API 키를 넣지 않습니다.

## 기존 네트워크 검색

```bash
python3 workshop/scripts/lab.py discover --config "$ATLAS_CONFIG"
python3 workshop/scripts/lab.py doctor --aws --config "$ATLAS_CONFIG"
python3 workshop/scripts/lab.py info --config "$ATLAS_CONFIG"
```

`discover`는 조회 API를 사용하고 결과를 로컬 설정에 기록합니다.

- Name 태그가 일치하는 VPC가 정확히 하나여야 합니다.
- 두 AZ에 Public/Private Subnet이 각각 있어야 합니다.
- Public Subnet 기본 경로는 IGW, Private Subnet 기본 경로는 기존 NAT여야 합니다.
- NAT는 해당 VPC에서 사용 가능해야 하고 Private Subnet 자동 Public IP 할당은 꺼져 있어야 합니다.
- CloudFront origin-facing Prefix List 소유자는 AWS여야 합니다.

검색 실패 시 VPC 이름·라우트·권한을 확인하고 진행자에게 준비된 환경을 요청합니다.
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

- [ ] 실습 계정·참가자 이름을 확인했습니다.
- [ ] 네트워크와 도구 점검을 통과했습니다.
- [ ] 내 자원의 이름을 확인했습니다.

Codex 카드: [02 · 계정·네트워크](../prompts/02-aws-environment.md)

다음: [03 · Codex 작업 공간](03-codex.md)
