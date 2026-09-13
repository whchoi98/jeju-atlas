# 04. AgentCore CLI로 실행하고 배포하기

이 장은 50분입니다. 로컬 검사에 15분, 배포에 20분, 원격 응답 확인에 10분,
결과와 정리 계획 기록에 5분을 사용합니다. 전체 과정의 마지막 10분은 지연 대응 시간입니다.
이번에는 실제 제주 가이드의 모델 응답을 확인합니다.

## 1. 의존성과 검색 도구 검사

```bash
cd "$ATLAS_CLI"
npm --prefix agentcore/cdk install
cd app/JejuGuide
uv sync --python 3.14
uv run python -m unittest discover -s tests -v
cd ../..
agentcore validate --json
```

최초 설치에서 생성한 `package-lock.json`과 `uv.lock`을 보관합니다.
그 뒤 재설치에는 `npm ci`와 `uv sync --frozen`을 사용합니다.
검색 테스트는 모델을 호출하지 않아야 합니다.

스키마 검사가 성공하면 AI CLI에 변경 내용을 설명하게 합니다.
`default` 대상의 계정, 서울 리전, 참가자 프로젝트 이름과 모델 설정을 확인합니다.
실행 역할에는 선택한 추론 프로필과 모델 호출에 필요한 권한이 있어야 합니다.
진행자는 수업 전에 같은 배포 구성으로 이를 확인합니다.

## 2. 로컬에서 실제 모델 호출

터미널 A에서 서버를 시작합니다.

```bash
cd "$ATLAS_CLI"
agentcore dev \
  --runtime JejuGuide \
  --port 8080 \
  --skip-deploy \
  --no-traces \
  --no-browser \
  --logs
```

`--skip-deploy`는 로컬 확인 중 AWS 자원이 자동 배포되는 것을 막습니다.
VSCode Server에서 터미널 B를 열고 같은 참가자 환경 변수를 불러온 뒤 호출합니다.

```bash
cd "$ATLAS_CLI"
curl --fail --silent http://127.0.0.1:8080/ping
agentcore dev "제주 해변 두 곳을 찾아주고 자료의 출처를 알려줘" \
  --runtime JejuGuide --port 8080
```

한국어로 답하고 실제 검색 도구가 반환한 장소를 사용해야 합니다.
실습용 시드라는 출처 설명과 미확인 정보의 구분을 확인합니다.
모델 호출은 AWS 사용량에 포함됩니다.

두 번째 질문은 “협재해변의 영업시간이 확인되는지 알려줘”입니다.
자료에 없는 영업시간을 만들지 않는지 확인합니다.
서버는 터미널 A의 `Ctrl+C`로 종료합니다.

## 3. 배포 계획 확인

```bash
cd "$ATLAS_CLI"
aws sts get-caller-identity --query Account --output text
agentcore deploy --target default --dry-run
```

계정과 프로젝트 이름이 맞는지 확인하고 생성할 Runtime과 실행 역할을 검토합니다.
기존 VPC, NAT Gateway, Subnet을 생성하거나 변경하는 계획이 없어야 합니다.
계정 단위 관측 설정은 이 수업에서 새로 켜지 않습니다.
계획 단계에서 패키지를 내려받을 수 있으므로 진행자는 같은 버전으로
패키지 캐시, CDK bootstrap과 배포 권한을 미리 점검합니다.

## 4. AWS 배포

```bash
agentcore deploy --target default
agentcore status --target default --runtime JejuGuide --json
```

처음 실행한 배포가 끝나기 전에는 같은 배포를 다시 시작하지 않습니다.
상태가 READY가 되면 원격 호출로 진행합니다.
105분까지 준비되지 않으면 상태와 오류를 기록하고 진행자와 확인합니다.
권한 오류를 숨기거나 기존 운영 Runtime으로 대체하지 않습니다.

## 5. 배포한 Runtime 호출

```bash
agentcore invoke "제주 해변 두 곳을 찾아주고 자료의 출처를 알려줘" \
  --runtime JejuGuide --target default --json
agentcore logs --runtime JejuGuide --since 10m --limit 30 --json
```

응답이 끝까지 도착했는지, 검색 도구를 사용했는지, 실제 반환된 장소를 소개했는지 확인합니다.
실패했다면 로컬 결과와 원격 결과를 나눠 기록합니다.
응답이 끊겼을 때 원인을 확인하지 않고 같은 호출을 반복하지 않습니다.

본 실습은 원격 응답 확인으로 마칩니다.
대화 기억은 생성 코드의 세션 처리 범위입니다.
별도 AgentCore Memory나 Gateway까지 배포했다고 기록하지 않습니다.

## 6. 정리와 제출

VSCode에서 다음 내용을 `RESULTS.md`에 기록합니다.

| 항목 | 기록할 내용 |
|---|---|
| 사용한 AI CLI | 이름과 버전 |
| 구현 | 수정 파일, 검색 도구와 테스트 |
| 로컬 결과 | 실행한 명령과 성공 또는 오류 |
| AWS 결과 | 참가자 Runtime 이름과 상태 |
| 응답 확인 | 장소, 출처, 미확인 정보 처리 |
| 남은 자원 | 본인이 만든 자원과 정리 담당자 |

Runtime을 지우기로 했다면 같은 프로젝트에서 로컬 정의를 제거한 뒤 다시 배포합니다.

```bash
agentcore remove agent --name JejuGuide --yes --json
agentcore deploy --target default --dry-run
agentcore deploy --target default
agentcore status --target default --json
```

`remove agent`만으로 AWS 자원이 즉시 삭제되지는 않습니다.
소유 스택의 삭제 결과와 남은 로그, 배포 아티팩트를 확인합니다.
공유 CDK bootstrap, VPC, NAT Gateway, Subnet, VSCode Server는 정리 대상이 아닙니다.
정리 단계도 처음 배포 때와 같은 계정과 프로젝트에서 진행합니다.

프롬프트: [실행과 검증](../prompts/04-agentcore-cli.md)

본 실습 종료: [전체 과정](../README.md)

선택 실습: [05. ECR과 장소 데이터](05-foundation-and-data.md)
