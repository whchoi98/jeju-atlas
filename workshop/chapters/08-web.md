# 08. 3D 지도 웹과 Fargate 배포

이 장은 120분 본 실습 이후에 선택하는 심화 자료입니다.

기존 지도, 한영 UI, 카탈로그, AI 스트리밍, PWA를 사용합니다.\
Private Fargate의 웹, 라우터를 Public ALB와 새 CloudFront에 연결합니다.

CloudFront 기본 도메인의 HTTPS로 접속하며, WAF/OAC 구성은 다음 장에서 완성합니다.\
도메인 등록과 인증서 발급은 실습에 포함하지 않습니다.

## 빌드

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run install --config "$ATLAS_CONFIG" --execute &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run build-push --config "$ATLAS_CONFIG" --execute
}
```
Node, Python 테스트, CloudFormation 검사, npm audit와 빌드를 수행합니다.\
검사 후 웹 이미지를 게시하고 라우터와의 digest 쌍을 기록합니다.\
오류가 나면 검사를 건너뛰어 push하지 않습니다.

전체 소스 검사 프롬프트는 기본 경로에서 생략합니다.\
빌드 오류나 변경한 기능의 문제가 있을 때만 [12장](12-validation.md)에서 해당 검사를 선택합니다.

## 앱 계획

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run plan-app --config "$ATLAS_CONFIG" --execute
}
```
새 ALB, SG, ECS, TaskDefinition, CloudFront, DynamoDB와 session/origin secret을 확인합니다.\
VPC, NAT, DNS 수정이나 운영 서비스 교체는 없어야 합니다.\
Guide, 카탈로그는 06장의 전용 출력에서 읽습니다.

### 앱 배포 시작

계획의 계정과 생성 또는 변경 자원을 확인한 뒤 한 번 실행합니다.

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
source workshop/.local/labs/team01/activate.sh &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run apply-app --config "$ATLAS_CONFIG" --execute
}
```
적용 요청이 접수돼도 배포가 완료된 것은 아닙니다.\
이후에는 아래 상태 조회로 진행 상황을 확인합니다.

### 완료 상태 조회

아래 블록은 App 스택의 상태와 최근 이벤트를 조회합니다.\
새 터미널에서도 기존 참가자 환경을 먼저 불러옵니다.

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
source workshop/.local/labs/team01/activate.sh &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run status-app \
  --config "$ATLAS_CONFIG" --execute
}
```

출력 중 **`stack`과 `status`가 있는 JSON**을 확인합니다.\
공통 실습 ID의 스택 이름은 `AtlasLabTeam01App`입니다.

| `status` | 다음 행동 |
|---|---|
| `CREATE_IN_PROGRESS`, `UPDATE_IN_PROGRESS`, `UPDATE_COMPLETE_CLEANUP_IN_PROGRESS` | 잠시 기다린 뒤 위 `status-app` 조회 블록만 다시 실행합니다. |
| `CREATE_COMPLETE`, `UPDATE_COMPLETE` | 스택 배포 완료입니다. 함께 출력되는 `outputs`를 확인한 뒤 첫 접속으로 진행합니다. |
| `REVIEW_IN_PROGRESS` | 스택 자원 생성 전입니다. 계획 결과와 `apply-app` 실행 결과부터 확인합니다. |
| 실패 또는 `ROLLBACK`이 포함된 상태 | 출력된 이벤트의 실패 자원과 이유를 확인합니다. |

진행 중에는 `plan-app`과 `apply-app`을 반복하지 않습니다.\
조회 명령의 종료 코드가 0이어도 스택이 완료된 것은 아닙니다.

스택 완료 시 참가자 app의 `.local/app-outputs.json`이 저장됩니다.\
`ApplicationUrl`, `CloudFrontUrl`, `DistributionId`, `ClusterName`, `ServiceName`을 확인합니다.\
스택 상태와 실제 웹 접속 상태를 구분하며, 다음 단계에서 HTTPS health 응답을 확인합니다.

## 첫 접속

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
이 명령은 참가자 App 스택의 실제 출력을 조회하고 **접속 URL을 첫 줄에 표시**합니다.\
다음 줄에 `/healthz` 응답이 나오며, 브라우저에서는 표시된 CloudFront 기본 HTTPS URL을 엽니다.\
출력이 없으면 중단하며 예시 주소나 운영 도메인을 사용하지 않습니다.

### 선택: 화면과 PWA 확인

08장의 기본 접속 확인은 실제 URL과 `/healthz` 응답입니다.\
다음 화면 확인은 오류가 있거나 해당 기능을 추가로 확인하고 싶을 때 진행합니다.
생략한 항목은 미실행으로 기록합니다.

- 대표 명소가 먼저 보이고 모든 장소 식별자가 한꺼번에 나타나지 않습니다.
- 카테고리, 검색, 주변 찾기가 동작합니다.
- 휴대폰에서 해변을 선택한 뒤 목록을 위로 스크롤하고 다음 페이지까지 이동합니다. 추가 조건은 **필터, 지도 설정**에서 펼칩니다.
- 데스크톱에서는 사이드바 경계의 작은 화살표로 접고 펼칩니다. 검색과 AI 대화, 작성 중인 질문이 유지되는지 확인합니다.
- 2D/3D, 고도 배율, 제주 한 바퀴와 올레길 둘러보기를 확인합니다.
- 한국어/English 토글과 나눔스퀘어를 확인합니다.
- 저장 코스, PWA 오프라인 앱 셸과 온라인 API의 차이를 확인합니다.
- 같은 호스트의 `/workshop/`에서 교재와 ZIP 다운로드가 열리는지 확인합니다.
- HTTPS 교재의 오프라인 저장이 완료되면 연결을 끊고 다른 챕터를 엽니다.
- 지도 앱과 워크숍을 각각 설치하고, 업데이트 후 저장 코스와 학습 진도가 유지되는지 확인합니다.

실제 AI 응답 확인은 엣지, 운영 구성을 마친 뒤 12장이나 전체 앱 완료 단계에서 진행합니다.\
08장의 health 응답만으로 AI와 길찾기 전체가 검증됐다고 판단하지 않습니다.

## 실제 Distribution으로 데이터 정책 연결

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run plan-data --config "$ATLAS_CONFIG" --execute
}
```
이번 계획에는 실제 CloudFront ARN과 공개 URL이 들어갑니다.\
미디어는 OAC를 통해 전달하며 S3 버킷을 공개하지 않습니다.\
운영 Distribution ARN이나 과거 수집 URL을 사용하지 않는지 확인합니다.

계획의 대상을 확인한 뒤 갱신을 시작합니다.

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run apply-data --config "$ATLAS_CONFIG" --execute
}
```

완료 상태는 다음으로 조회합니다.
진행 중이면 아래 조회만 다시 실행하며 `plan-data`와 `apply-data`를 반복하지 않습니다.

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
source workshop/.local/labs/team01/activate.sh &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run status-data \
  --config "$ATLAS_CONFIG" --execute
}
```

Data 스택이 `CREATE_COMPLETE` 또는 `UPDATE_COMPLETE`이면 다음 장으로 진행합니다.\
실패 또는 `ROLLBACK` 상태이면 출력된 이벤트의 원인을 먼저 확인합니다.

## 문제 해결

| 현상 | 먼저 볼 것 |
|---|---|
| ALB target unhealthy | `/healthz`, 컨테이너 로그, 포트, task 상태 |
| 지도만 나오고 장소 없음 | 내 S3 카탈로그 객체, IAM, SQLite 검사 |
| AI 준비 오류 | 전용 Runtime 출력과 task 환경 변수 |
| 코드 변경 후 계획 거부 | 이미지, 라우터 쌍과 새 검사 결과 |
| CloudFront 반영 지연 | Distribution의 배포 상태, 캐시 |

- [ ] Private Fargate 2개와 ALB target 상태가 정상입니다.
- [ ] 웹, 카탈로그, 라우터가 내 배포 자원에 연결됩니다.
- [ ] 실제 Distribution ARN으로 미디어 정책을 갱신했습니다.

하단 프롬프트로 진행하면 본문 명령을 중복 실행하지 않아도 됩니다.\
[프롬프트 진행 안내](00-orientation.md#하단-프롬프트로-진행하는-방법)를 참고하고 이미 완료한 작업은 유지합니다.

Agentic AI 코딩 어시스턴트 프롬프트: [08, 웹 배포](../prompts/08-web.md)

다음: [09, CloudFront 기본 HTTPS와 엣지](09-https-edge.md)
