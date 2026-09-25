# 01. 환경 활성화와 Bedrock 키 입력

이 장은 10분입니다.\
[사전 구성](../reference/preconfiguration.md)을 마친 EC2에서 기존 실습 환경을 불러오고 Bedrock API 키를 입력합니다.

**단기 또는 장기 Bedrock API 키 중 준비된 키 하나를 사용합니다.**\
두 유형 모두 아래의 같은 입력 명령을 사용합니다.

사전 구성의 `start.sh`와 AWS 자격증명 점검까지 완료했다면 아래 명령으로 이어갑니다.\
소스나 설치 준비가 남아 있으면 사전 구성의 해당 단계부터 마칩니다.

## 환경을 불러오고 키 입력

EC2의 VSCode Server에서 **Bash 터미널**을 사용합니다.\
Codex, Claude Code, Kiro CLI 모두 같은 명령을 사용하며, 사전 구성에서 저장한 도구 선택을 이어 씁니다.

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
source workshop/.local/labs/team01/activate.sh &&
"$ATLAS_PYTHON" -B "$ATLAS_REPO/workshop/scripts/workshop_env.py" configure
}
```

`team01`은 독립 랩에서 자동으로 사용하는 공통 실습 ID입니다.\
기존에 다른 ID로 준비한 환경은 준비기가 출력한 `activationPath`를 사용합니다.

`source`는 현재 Bash의 경로와 도구 설정을 복원합니다.\
도구 설치와 이미 성공한 점검은 반복하지 않습니다.

## 입력할 두 가지 값

| 터미널 입력란 | 입력할 내용 |
|---|---|
| `Bedrock model region` | Bedrock 모델을 호출할 AWS 리전 |
| `Bedrock API key` | 단기 또는 장기 API 키. 입력 중 화면에 표시되지 않음 |

단기키는 키를 발급한 리전을 사용합니다.\
장기키는 해당 키의 권한으로 모델을 사용할 수 있는 호출 리전을 지정합니다.\
키 유형이나 만료 시각을 추가로 입력하지 않습니다.

### 저장되는 위치

값은 `$ATLAS_CLI_PARENT/.env`에 권한 `0600`으로 저장됩니다.\
`ATLAS_CLI_PARENT`는 참가자 폴더이며, 이후 생성할 AgentCore 프로젝트의 배포 코드와 분리된 위치입니다.

카카오, 관광공사 TourAPI와 VISIT JEJU 키는 첫 배포 후 필요한 경우에만 추가합니다.\
키 갱신과 선택 연동 방법은 [.env와 외부 연동](../reference/keys-and-integrations.md)을 참고합니다.

## 새 터미널을 열었거나 문제가 생겼다면

새 Bash에서는 기존 환경만 다시 불러옵니다.\
키를 이미 저장했다면 입력 명령을 반복할 필요가 없습니다.

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
source workshop/.local/labs/team01/activate.sh
}
```

| 상황 | 이어갈 곳 |
|---|---|
| 소스나 `activate.sh`가 없습니다. | [사전 구성의 소스와 참가자 환경 준비](../reference/preconfiguration.md) |
| 도구를 바꾸거나 이전 소스에서 오류가 났습니다. | [기존 실습 재개와 도구 선택](../reference/preconfiguration.md#이전-소스와-도구-선택-오류) |
| 키나 모델 호출 리전을 다시 입력해야 합니다. | 이 장의 키 입력 명령 |

필요할 때만 사용하는 선택 프롬프트: [환경 진단](../prompts/01-setup.md)

다음: **[02. 계정과 작업 폴더](02-aws-environment.md)**
