# 오류별 재개와 완료 상태 조회

실패한 명령과 마지막 성공 결과를 확인하고 **남은 단계부터** 이어 간다.\
전체 준비·키 입력·빌드·배포를 일괄 반복하지 않는다.

아래 명령의 경로는 새 독립 랩의 기본값이다.\
재개하는 랩의 저장소나 참가자가 다르면 기록된 실제 경로를 사용한다.
현재 EC2 계정과 참가자 설정을 대조하며 다른 계정의 예시 ARN을 복사하지 않는다.

## 준비 출력과 오류 해석

| 출력 또는 현상 | 해석과 다음 작업 |
|---|---|
| `전체 실습 소스가 없습니다` | 지정한 `repo`에 `workshop/scripts/core.py`가 없다. 전체 소스 위치부터 확인한다. 교재 ZIP이나 `claude-lab` 폴더를 전체 소스로 간주하지 않는다. 없을 때만 [준비](prepare.md#전체-소스-확보)의 clone 명령을 사용한다. |
| `fatal: invalid refspec 'https://…'` | `git pull origin` 뒤에는 저장소 URL 대신 브랜치가 필요하다. 소스 루트에서 `git pull --ff-only origin main`을 실행한다. 실패하면 기존 변경을 보존한다. |
| `core.py prepare`의 `activationPath`, `projectPath`, `createdAwsResources: false`, `installedTools: false` | 참가자 폴더 준비의 정상 결과다. 프로젝트 경로는 예약된 위치이며 CLI 프로젝트 생성·도구 설치·AWS 배포 성공을 뜻하지 않는다. 사전 구성의 `start.sh`와 현재 셸 활성화로 이어 간다. |
| Node 20 또는 `need >=24.18.1 within major 24` | [Node 전용 준비](prepare.md#node만-준비하거나-이전-명령에서-막힌-경우)를 실행하고 `activate-node.sh`를 source한다. `--node-only`가 Usage에 없으면 먼저 소스를 갱신한다. |
| `Existing directory belongs to another setup` | `.owner.json`의 repo·참가자·프로젝트·도구와 요청을 대조한다. 같은 소유 세션의 도구 변경은 갱신한 전체 `start.sh --assistant claude` 등으로 처리한다. 소유 파일 직접 수정이나 다른 ID로 우회하지 않는다. |
| doctor의 `passed: true`, `awsChecked: false`, `modelInvoked: false` | 로컬 도구 준비 성공이다. AWS 배포 권한, CDK bootstrap과 실제 모델 응답까지 확인한 결과는 아니다. |
| 키 status의 `readyForModelCheck: true`, `modelAccessVerified: false` | 필요한 입력이 저장됐으며 모델은 호출하지 않았다. 기본 흐름에서 유료 사전 검사를 추가하지 않는다. |
| CDK의 `status: missing`, `ready: false` | 조회는 끝났지만 해당 계정·서울 리전의 bootstrap이 없다. [준비의 CDK 절차](prepare.md#cdk-bootstrap-준비)에서 별도 승인된 생성 후 `ready: true`를 확인한다. |

## 새 Bash에서 환경 복원

`ATLAS_REPO: 먼저 01장의 activate.sh를 source하세요`는 현재 셸의 변수 누락이다.\
04장까지 완료했어도 새 SSH·VSCode 터미널이나 `newgrp` 뒤에는 다시 활성화한다.

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" &&
source workshop/.local/labs/team01/activate.sh
```

같은 Bash에서 후속 명령을 실행한다.\
`source`를 `( ... )`, `bash -c` 등 별도 프로세스에 넣으면 부모 터미널에 변수가 남지 않는다.
활성화 파일이 없으면 이전 `activationPath`와 실제 소스 위치를 확인한다.
준비된 랩에 `start.sh`나 키 입력을 반복하지 않는다.

`ATLAS_ACCOUNT`는 참가자 JSON을 읽어 채운다.
최초 `lab.py init-ec2 --identity-only`로 설정을 만든 뒤에는 다시 source한다.\
이 초기화는 EC2 신원과 STS를 대조하며, 네트워크 검색은 수행하지 않아 `network: {}`일 수 있다.
심화 과정에서는 05장의 `discover`로 기존 VPC/Subnet 정보를 읽는다.
계정이나 VPC를 수동으로 다른 값에 맞추지 않는다.

## 05장 참가자 app이 없을 때

`Prepare the participant workspace first`는 기본 CLI 프로젝트와 별도인 app 준비가 필요하다는 뜻이다.\
먼저 05장의 보조 패키지 설치로 같은 helper Python의 PyYAML을 준비한다.
그다음 app이 **아직 없을 때만** 실행한다.

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
source workshop/.local/labs/team01/activate.sh &&
export ATLAS_APP="$ATLAS_REPO/workshop/.local/labs/$ATLAS_TEAM/app" &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py discover --config "$ATLAS_CONFIG" &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py prepare --config "$ATLAS_CONFIG" &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py info --config "$ATLAS_CONFIG"
}
```

이미 존재하는 app은 소유 바인딩과 현재 파일을 확인한다.
PyYAML 오류로 미완성 사본이 남았다면 교재 사전 구성의 백업·복구 절차를 적용한다.
기존 app을 삭제하거나 정상 사본 위에 `prepare`를 반복하지 않는다.\
`info`의 legacy `cliWorkspace` 대신 기본 CLI는 활성화된 `$ATLAS_CLI`를 사용한다.

## 계획과 스택 상태를 구분한다

| 관측한 상태 | 다음 행동 |
|---|---|
| `agent-plan`의 `CREATE_COMPLETE` | 변경 세트 준비 완료다. 대상과 변경을 검토한 뒤 `agent-apply`를 한 번 실행한다. |
| `agent-plan`의 `PENDING` | 출력된 기존 `changeSetId`를 조회한다. `CREATE_COMPLETE` 및 `ExecutionStatus: AVAILABLE`일 때 적용한다. |
| `agent-status`의 `NOT_CREATED` | 스택이 없다. 마지막 계획 오류와 대상 설정을 확인하고 실패한 단계부터 재개한다. |
| 스택 `REVIEW_IN_PROGRESS` | 실제 자원 배포 전이다. 기존 계획 준비 완료와 apply 실행 여부를 확인한다. 기다리는 것만으로 배포가 시작되지 않는다. |
| `execution: started` 또는 apply의 `started` | 배포 요청이 접수됐다. 이후에는 status만 조회한다. |
| 스택 `CREATE_IN_PROGRESS`, `UPDATE_IN_PROGRESS`, `UPDATE_COMPLETE_CLEANUP_IN_PROGRESS` | 잠시 기다린 뒤 같은 status 명령만 다시 실행한다. |
| 스택 `CREATE_COMPLETE`, `UPDATE_COMPLETE` | 스택과 출력 자원을 확인하고 다음 단계로 진행한다. |
| 실패 또는 `ROLLBACK`이 포함된 상태 | 최근 이벤트의 실패 자원과 이유를 확인한다. 원인을 해결하기 전 apply나 모델 호출을 반복하지 않는다. |

**계획의 `CREATE_COMPLETE`, 조회 명령 종료 코드 0, 실제 스택 완료는 서로 다른 결과다.**

변경 세트가 `PENDING`이거나 기존 계획의 적용 가능 여부가 불확실할 때만 다음을 조회한다.
참가자 app의 기존 계획 기록에서 ID를 읽으며 새 변경 세트를 만들지 않는다.

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
source workshop/.local/labs/team01/activate.sh &&
atlas_change_set="$("$ATLAS_PYTHON" -B -c \
  'import json, sys; print(json.load(open(sys.argv[1]))["changeSetId"])' \
  "$ATLAS_CLI_PARENT/app/.local/atlas-agent-change-set.json")" &&
aws cloudformation describe-change-set \
  --region ap-northeast-2 --change-set-name "$atlas_change_set" \
  --query '{StackName:StackName,Status:Status,ExecutionStatus:ExecutionStatus,StatusReason:StatusReason}' \
  --output json --no-cli-pager
}
```

기록이 없으면 마지막 `agent-plan` 출력과 실제 app 경로를 먼저 확인한다.
`Status: CREATE_COMPLETE`, `ExecutionStatus: AVAILABLE`이고 검토한 본인 계획일 때 적용한다.

### 단계별 조회 명령

| 장과 대상 | `lab.py run`의 조회 단계 | 다음 단계 |
|---|---|---|
| 05장 ECR Registry | `status-bootstrap` | 완료 후 Data 준비 |
| 05장 또는 08장 Data | `status-data` | 최초 완료 후 카탈로그, 08장 갱신 완료 후 엣지 단계 |
| 06장 AgentCore | `agent-status` | 완료 후 `agent-configure-logs` |
| 08장 App | `status-app` | 완료 후 URL과 HTTPS 확인, 실제 Distribution 데이터 정책 연결 |

`plan-bootstrap`/`status-bootstrap`은 **참가자 ECR Registry** 작업이다.
사전 구성의 공유 `CDKToolkit` bootstrap과 다르다.

새 Bash에서도 아래에서 필요한 조회 **하나만** 실행할 수 있다.

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
source workshop/.local/labs/team01/activate.sh &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run status-bootstrap \
  --config "$ATLAS_CONFIG" --execute
}
```

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
source workshop/.local/labs/team01/activate.sh &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run status-data \
  --config "$ATLAS_CONFIG" --execute
}
```

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
source workshop/.local/labs/team01/activate.sh &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run agent-status \
  --config "$ATLAS_CONFIG" --execute
}
```

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
source workshop/.local/labs/team01/activate.sh &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run status-app \
  --config "$ATLAS_CONFIG" --execute
}
```

이 조회들의 `--execute`는 읽기 전용 AWS 조회를 실제로 수행한다는 뜻이다.
배포를 재시작하지 않으며 로컬 출력 파일은 갱신할 수 있다.\
Registry/Data/App 조회는 `stack`과 `status` JSON 뒤에 `outputs` JSON도 출력할 수 있다.
마지막 JSON만 읽어 스택 상태를 놓치지 않는다.

### 06장 로그 설정 오류

`Complete the independent stack before configuring runtime logs`이면 먼저 `agent-status`를 실행한다.\
계획만 준비됐다면 [배포 참조](deploy.md#06장-guide-연결과-배포)의 `agent-apply`부터,
진행 중이면 조회부터, 완료됐다면 로그 설정부터 이어 간다.
코드 빌드·게시 전체를 반복할 필요가 없다.

`Provide an explicit organizer-verified Bedrock caller region`이면 서울 호출 리전을 저장한다.
기존 API 키 연결과 게시된 코드가 그대로인 경우 `agent-plan`부터 재개한다.\
옛 IAM Guide라면 먼저 [같은 키 연결과 코드 재배포](deploy.md#기존-iam-guide-재개)를 적용한다.
리전 설정만 바꾸거나 `.env`를 복사해서 API 키 연결이 됐다고 판단하지 않는다.

## 07장 Docker와 라우팅 재개

`permission denied ... /var/run/docker.sock`이면 [Docker 그룹 적용](prepare.md#docker-설치-후-소켓-권한-오류)을 수행한다.
새 프롬프트에서 활성화하고 `docker info`가 성공한 같은 셸에서 작업한다.\
`sources_verified`까지 성공한 다운로드는 보존하고 [빌드 재개 명령](deploy.md#07장-라우팅과-docker-권한-복구)을 사용한다.

빌드 실패 뒤 `routing-verify`의 `source.json` 누락은 후속 오류일 수 있다.
`source.json`은 빌더가 생성하므로 임의 작성하거나 다른 랩에서 복사하지 않는다.
명령을 `&&`로 연결해 첫 실패에서 멈춘다.

Docker의 `FINISHED`는 빌더 이미지 생성 완료일 수 있다.
라우팅 작업의 최종 `graph_verified`와 명령 종료 상태를 확인한다.\
중간 admin/geometry/timezone 경고의 존재만으로 빌드 실패를 단정하거나 모든 경고가 무해하다고 단정하지 않는다.
`graph_verified`는 생성 파일과 해시 확인이며 모든 경로 품질의 증거는 아니다.
별도 `routing-verify`는 파일 이동 후 무결성 확인 등 필요한 경우에만 실행한다.

## 08장 URL과 실제 접속

App 스택 완료 후 실제 URL을 조회해 표시한다.

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
source workshop/.local/labs/team01/activate.sh &&
ATLAS_URL="$("$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/lab.py" url \
  --config "$ATLAS_CONFIG" --plain)" &&
export ATLAS_URL &&
echo "$ATLAS_URL" &&
curl --fail --silent "$ATLAS_URL/healthz" &&
printf '\n'
}
```

URL은 첫 줄, health 응답은 다음 줄에 나온다.
기존 `ATLAS_URL`에 값만 저장했을 때는 터미널에 주소가 자동 출력되지 않는다.\
예시 URL이나 운영 도메인을 대신 사용하지 않는다.

`CREATE_COMPLETE`는 스택 완료, health 성공은 웹 서버 응답 확인이다.
지도·길찾기·모델 응답 전체의 성공으로 확대하지 않는다.\
첫 접속 후에는 08장 하단의 **실제 Distribution으로 데이터 정책 연결**을 완료한다.
이때 갱신 진행 중이면 위 `status-data`만 조회한다.

03–08장 본문 명령을 이미 수행했다면 프롬프트에 완료한 작업을 전달하고 남은 단계만 실행한다.
장별 실행 결과, 생략한 검사와 다음 재개 지점을 기존 기록에 남긴다.
