# 04. AgentCore CLI로 배포하고 결과 보기

이 장은 45분입니다.\
키 연결과 의존성 준비, 배포, 예시 응답과 자원 인계에 사용합니다.\
시간이 오래 걸리는 종합 검증은 기본 경로에서 생략합니다.

같은 대화에 [배포 프롬프트](../prompts/04-agentcore-cli.md)를 한 번 전달합니다.\
현재 랩 계정의 실습 자원 생성과 결과를 보기 위한 소량의 모델 호출을 포함합니다.\
공통 실습 ID `team01`과 기존 프로젝트를 그대로 사용합니다.

## 기본 실행 순서

| 순서 | 실행과 필요한 확인 |
|---|---|
| 1 | 작업 경로, 실제 계정, 키 입력과 CDK bootstrap 준비, `agentcore validate` 설정 확인 |
| 2 | `workshop_env.py publish` 계획을 확인하고 `--execute`로 키 연결 |
| 3 | `uv export --locked`로 제약 파일 생성 |
| 4 | 같은 `UV_CONSTRAINT`를 적용해 `agentcore deploy --target default --dry-run` 계획 확인 |
| 5 | `agentcore deploy --target default` 실행과 Runtime 상태 확인 |
| 6 | `agentcore invoke`로 예시 응답 한 번 보고 결과 인계 |

세부 명령은 프롬프트에 있으므로 한 줄씩 옮겨 실행하지 않아도 됩니다.\
계정과 경로 확인, 배포 계획 검토는 실제 자원을 올바른 대상으로 만들기 위해 수행합니다.\
별도 전체 테스트나 브라우저 검증으로 확대하지 않습니다.

`.env`가 없으면 [01장의 입력](01-setup.md)부터 완료합니다.\
현재 입력은 **모델 호출 리전과 Bedrock API 키 두 항목**이며 단기 또는 장기키를 사용합니다.\
과거 만료 시각 오류가 기록되어 있어도 만료 시각을 다시 입력하지 않습니다.

`AWS environment needs bootstrapping`이면 [사전 구성의 CDK bootstrap 준비](../reference/preconfiguration.md#5-cdk-bootstrap-준비)로 이동합니다.\
현재 계정의 준비 여부를 먼저 확인하므로 키 게시나 긴 패키징 전에 누락을 찾을 수 있습니다.\
준비한 코드와 제약 파일은 그대로 유지하고 완료 후 같은 프로젝트에서 재개합니다.

CLI 0.28.1의 CodeZip 빌더는 `uv.lock`을 직접 읽지 않습니다.\
AI는 내보낸 제약 파일을 `UV_CONSTRAINT`로 계획과 배포 명령에 동일하게 전달합니다.

키는 소유 SSM SecureString에 보관하고 Runtime에는 ARN과 읽기 정책을 연결합니다.\
키 원문과 `.env`는 코드, 배포 ZIP과 결과 보고서에 넣지 않습니다.\
Runtime으로 들어오는 요청은 IAM으로 인증합니다.

## 결과 응답 한 번 보기

Runtime이 READY가 되면 다음 질문을 한 번 사용합니다.

> 제주 해변 두 곳과 자료의 출처를 알려줘. 영업시간이 확인되는지도 알려줘.

응답이 끝까지 도착하는지 확인하고 실제 결과를 기록합니다.\
이 한 번의 예시 응답으로 전체 기능을 검증했다고 표시하지 않습니다.\
READY 상태만 확인했다면 모델 응답은 미실행으로 남깁니다.

## 필요한 경우에만 추가 진단

정상 진행 중에는 아래 항목을 모두 건너뛰어도 됩니다.

| 문제가 생긴 경우 | 선택할 진단 |
|---|---|
| `.env` 미저장 또는 과거 만료 시각 안내 | 소스를 갱신한 뒤 01장의 두 항목 입력 |
| CDK bootstrap 누락 또는 버전 부족 | 사전 구성의 읽기 전용 bootstrap 확인과 진행자 준비 |
| 키 만료, 인증 또는 호출 리전 오류 | 02장의 작은 모델 진단 한 번 |
| Runtime 소스나 진입점 오류 | `agentcore dev` 로컬 실행 또는 해당 파일의 import 확인 |
| 검색 결과 오류, 검색 로직 변경 | 해당 입력만 다루는 검색 테스트 |
| 원격 응답 오류 | 해당 Runtime의 최근 로그 |
| 전체 앱의 특정 기능 문제 | [12장 선택 문제 해결](12-validation.md) 중 해당 기능 |

`npm run check`, 전체 unittest, 한영 응답 비교와 브라우저 자동 검증은 기본 배포 프롬프트에서 실행하지 않습니다.\
키를 갱신하면 같은 소유 파라미터를 게시하고 새 세션에서 확인합니다.\
진행 중인 배포와 같은 실패 요청은 반복하지 않습니다.

## 결과와 자원 인계

100분까지 기본 작업을 마무리하고 최대 20분을 배포 대기와 필요한 오류 처리에 사용합니다.\
120분에는 실제 완료 범위와 재개 위치를 인계합니다.

`$ATLAS_CLI_PARENT/RESULTS.md`에는 변경 파일, 배포 결과, 실제로 본 응답과 남은 자원을 짧게 기록합니다.\
추가 진단은 실행한 것만 적고 나머지는 생략 또는 미실행으로 표시합니다.\
별도 Gateway, Memory와 전체 웹은 기본 완료 항목에 포함하지 않습니다.

삭제를 요청한 경우에는 같은 프로젝트에서 `agentcore remove agent --name JejuGuide --yes --json`으로 정의를 제거합니다.\
삭제 계획을 확인한 뒤 `agentcore deploy --target default --yes`로 반영합니다.\
Runtime과 실행 역할 정리가 끝난 뒤 `workshop_env.py cleanup` 계획과 `--execute`로 소유 키와 정책을 정리합니다.

## 배포 후 선택 사항

HUD는 설치하지 않아도 본 실습을 완료할 수 있습니다.\
카카오, 관광공사와 VISIT JEJU 키도 필요한 기능을 선택할 때만 추가합니다.

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
python3 "$ATLAS_REPO/workshop/scripts/workshop_env.py" configure --integrations
}
```
[키와 선택 연동](../reference/keys-and-integrations.md)의 해당 기능만 진행합니다.

필수 프롬프트 2: [배포와 결과 보기](../prompts/04-agentcore-cli.md)

본 실습 종료: [전체 과정](../README.md)

선택 실습: [05. 컨테이너 저장소와 장소 데이터](05-foundation-and-data.md)
