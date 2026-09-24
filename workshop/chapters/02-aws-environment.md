# 02. 계정과 작업 폴더

이 장은 10분입니다.\
01장에서 입력한 키의 상태와 제공된 랩의 작업 범위를 확인합니다.\
별도의 모델 검증 요청은 기본 경로에서 생략합니다.

## 독립 랩과 공통 실습 ID

참가자마다 제공된 독립 랩에서 진행합니다.\
`team01`은 실제 팀명이 아닌 공통 실습 ID이며 그대로 사용합니다.\
AWS 계정과 EC2는 실제 환경에서 읽어 기록하고, 기존 설정과 프로젝트를 재사용합니다.

| 용도 | 사용하는 설정 |
|---|---|
| AWS 배포와 Runtime 호출 | 현재 EC2 역할의 IAM 자격 증명 |
| Bedrock 모델 호출 | 참가자 `.env`의 단기 API 키와 발급 리전 |
| Agentic AI 코딩 어시스턴트 | 이미 준비한 도구의 로그인과 모델 설정 |

Bedrock 키는 AWS 배포 자격 증명을 대신하지 않습니다.\
진행자는 EC2 역할의 배포 권한과 CDK bootstrap을 미리 준비합니다.\
Runtime 배포 리전은 `ap-northeast-2`이며 키 발급 리전과 구분합니다.

03장 프롬프트가 `aws sts get-caller-identity`와 `lab.py init-ec2 --identity-only`로 실제 계정과 EC2를 확인합니다.\
같은 확인이 이미 완료되었다면 저장한 결과를 재사용합니다.\
팀명 선택이나 새 네트워크 생성은 하지 않습니다.

## 입력 상태만 확인하고 진행

01장에서 활성화한 Bash에서 실행합니다.\
이 명령은 키 존재 여부와 기록한 만료 시각만 확인하며 모델을 호출하지 않습니다.

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
python3 "$ATLAS_REPO/workshop/scripts/workshop_env.py" status
}
```
`readyForModelCheck: true`는 입력 조건이 준비됐다는 뜻입니다.\
실제 모델 접근 성공을 의미하지는 않습니다.\
별도 검증 프롬프트를 실행하지 않고 03장 구현으로 이동합니다.

키 원문은 프롬프트, 명령 인자와 로그에 넣지 않습니다.\
카카오, 관광공사와 VISIT JEJU 키는 첫 배포 후 필요한 기능만 연결합니다.

## 선택: 키나 모델 접근 문제가 있을 때만

잘못된 키, 만료 또는 호출 리전 문제를 구분해야 할 때만 아래 진단을 선택합니다.\
정상 진행 중에는 생략합니다.\
`--execute`는 소량의 비용이 발생하는 실제 Converse 요청 한 번입니다.

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
python3 "$ATLAS_REPO/workshop/scripts/model_check.py" \
  --env-file "$ATLAS_CLI_PARENT/.env" \
  --report "$ATLAS_CLI_PARENT/evidence/model-check-$(date -u +%Y%m%dT%H%M%SZ).json" \
  --execute
}
```
실행했다면 실제 결과를, 생략했다면 미실행으로 남깁니다.\
같은 실패 조건의 요청을 반복하거나 다른 리전으로 순회하지 않습니다.

선택 프롬프트: [필요한 경우의 환경 진단](../prompts/02-aws-environment.md)

다음: [03. Agentic AI 코딩 어시스턴트로 제주 가이드 구현](03-codex.md)
