# 08. 3D 지도 웹과 Fargate 배포

이 장은 120분 본 실습 이후에 선택하는 심화 자료입니다.

기존 지도, 한영 UI, 카탈로그, AI 스트리밍, PWA를 사용합니다.\
Private Fargate의 웹, 라우터를 Public ALB와 새 CloudFront에 연결합니다.

CloudFront 기본 도메인의 HTTPS로 접속하며, WAF/OAC 구성은 다음 장에서 완성합니다.\
도메인 등록과 인증서 발급은 실습에 포함하지 않습니다.

## 빌드

```bash
cd "$ATLAS_REPO" && {
python3 workshop/scripts/lab.py run install --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run build-push --config "$ATLAS_CONFIG" --execute
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
python3 workshop/scripts/lab.py run plan-app --config "$ATLAS_CONFIG" --execute
}
```
새 ALB, SG, ECS, TaskDefinition, CloudFront, DynamoDB와 session/origin secret을 확인합니다.\
VPC, NAT, DNS 수정이나 운영 서비스 교체는 없어야 합니다.\
Guide, 카탈로그는 06장의 전용 출력에서 읽습니다.

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
python3 workshop/scripts/lab.py run apply-app --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run status-app --config "$ATLAS_CONFIG" --execute
}
```
서비스 안정화와 CloudFront 전파를 기다립니다.\
완료 후 `$ATLAS_APP/.local/app-outputs.json`에서 `ApplicationUrl`, `CloudFrontUrl`, `DistributionId`, `ClusterName`, `ServiceName`을 확인합니다.

## 첫 접속

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
ATLAS_URL="$(python3 "${ATLAS_REPO:?}/workshop/scripts/lab.py" url \
  --config "${ATLAS_CONFIG:?}" --plain)" &&
export ATLAS_URL &&
curl --fail --silent "$ATLAS_URL/healthz"
}
```
이 명령은 참가자 App 스택의 실제 출력을 조회합니다.\
브라우저에서 같은 CloudFront 기본 HTTPS URL을 엽니다.\
출력이 없으면 중단하며 예시 주소나 운영 도메인을 사용하지 않습니다.

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

실제 AI 검증은 엣지, 운영 구성을 마친 뒤 12장에서 진행합니다.

## 실제 Distribution으로 데이터 정책 연결

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
python3 workshop/scripts/lab.py run plan-data --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run apply-data --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run status-data --config "$ATLAS_CONFIG" --execute
}
```
이번 계획에는 실제 CloudFront ARN과 공개 URL이 들어갑니다.\
미디어는 OAC를 통해 전달하며 S3 버킷을 공개하지 않습니다.\
운영 Distribution ARN이나 과거 수집 URL을 사용하지 않는지 확인합니다.

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

Agentic AI 코딩 어시스턴트 프롬프트: [08, 웹 배포](../prompts/08-web.md)

다음: [09, CloudFront 기본 HTTPS와 엣지](09-https-edge.md)
