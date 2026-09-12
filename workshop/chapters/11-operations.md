# 11 · 관측·보안·운영 제어

웹이 열린 뒤에도 알람·수집 상태·호출 한도·로그·이미지 취약점을 확인해야 합니다.
이 장에서는 해당 설정을 내 실습 자원에 연결합니다.

## 운영 스택

```bash
cd "$ATLAS_REPO"
python3 workshop/scripts/lab.py run plan-operations --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run apply-operations --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run status-operations --config "$ATLAS_CONFIG" --execute
```

ALB/ECS/오류/AI 제한/공식 보강 지표와 대시보드·SNS topic을 확인합니다.
운영 topic이 생기면 데이터 스택에도 연결합니다.

```bash
python3 workshop/scripts/lab.py run plan-data --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run apply-data --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run status-data --config "$ATLAS_CONFIG" --execute
```

Topic 생성과 알림 수신 완료는 다릅니다.
진행자가 정한 본인 수신 채널을 SNS 콘솔에서 구독하고 확인 절차를 완료합니다.
수신 동의가 없는 사람에게 구독이나 테스트 메시지를 보내지 않습니다.

## 확인할 지표

| 영역 | 관찰 |
|---|---|
| ALB/ECS | HealthyHostCount, 응답 오류·지연, CPU·메모리, desired/running |
| AI | 일일/시간/동시 실행 한도, 종료·실패 상태, 답변 중단 |
| 수집 | 작업 종료, heartbeat, 오류·지연, 마지막 정상 snapshot |
| CloudFront/WAF | 캐시·오류·차단, 허용된 로그 필드 |
| Runtime | 실행·도구·모델 지연과 오류의 메타데이터 |
| 접속 집계 | 현재 접속 브라우저·누적 접속 세션·집계 기준 시각 |

알람이 `INSUFFICIENT_DATA`이면 데이터가 아직 없는지, 전달이 끊겼는지 확인합니다.
공식 API가 실패해도 마지막 정상 자료를 유지하는 상태와 갱신 성공을 구분합니다.

## 호출 한도와 모델 권한

실습 기본값은 `GuideLimitsEnabled: "true"`이며 일일 30회·시간당 5회·전체 동시 2회입니다.
이는 요청 입장 제한이며 금액 상한이 아닙니다.
실습 중 제한에 도달하면 먼저 DynamoDB·로그에서 제한 원인을 확인합니다.
운영자가 앱 사용량 제한을 해제하려면 준비된 실습 workspace의 `infra/production.json`에서
`GuideLimitsEnabled`를 문자열 `"false"`로 바꾸고 `plan-app`의 변경 내용을 검토해 배포합니다.
일일·시간당·전체 동시 제한과 사용자별 동시 제한이 해제되며, 같은 대화의 충돌·요청 중복 실행 방지는 유지됩니다.
앱 설정으로 AWS 서비스 자체 할당량이 변경되지는 않습니다.

## 현재 및 누적 접속 수

앱 하단의 `접속 N · 누적 M`은 브라우저 세션 기준입니다.
현재 수는 최근 90초 접속 확인, 누적 수는 집계 도입 이후 각 세션의 첫 접속을 한 번씩 더합니다.
새로고침과 같은 브라우저의 여러 탭은 중복으로 더하지 않습니다.
종료한 브라우저는 활동 기간이 지난 뒤 현재 수에서 제외됩니다.

집계는 실습 접두사의 `presence` DynamoDB 테이블을 ECS 태스크가 공유합니다.
활성 기록의 TTL 정리와 누적 등록 기록 보존을 구분합니다.
API 응답은 수와 시각만 제공하고, 확인 실패를 0명으로 표시하지 않습니다.
`GET /api/presence`로 집계 상태를 읽을 수 있으며 이 조회는 방문 수를 늘리지 않습니다.

실제 Guide는 현재 프로젝트의 Global CRIS Sol/Astra와 해당 foundation model만 호출하도록 구성합니다.
워크숍을 통과시키기 위해 다른 프로젝트의 실행 역할을 붙이거나 모델 Resource를 전부 열지 않습니다.
Codex 사용 비용과 Bedrock·AgentCore 비용도 별도로 확인합니다.

## 로그와 개인정보

- 앱·Runtime 로그 보관은 해당 실습 소유 범위에서 확인합니다.
- 입력·답변·토큰·provider API 키를 로그·trace에 남기지 않습니다.
- 도구 이름·지연·종료 상태와 숨겨진 추론 내용은 다릅니다.
- 중앙 `aws/spans`와 계정 한도는 공유될 수 있습니다.
- Runtime 실행 역할의 로그 ARN 범위가 자기 Runtime에 한정되는지 확인합니다.

기존 프로젝트의 폭넓은 로그 조회 정책을 이번 실습에서 임의로 수정하지 않습니다.
필요한 권한 검토는 해당 소유자의 별도 작업으로 남깁니다.

## 이미지와 네트워크

ECR의 실제 이미지 검사 결과와 Critical/High 항목을 확인합니다.
검사 시작과 완료를 구분하며, 계정 단위 registry/Inspector 설정을 기존 필터를 지우는 방식으로 바꾸지 않습니다.
설치된 패키지와 이미지 digest를 함께 기록합니다.

Public ALB·Private Fargate·기존 NAT, CloudFront Prefix List와 task SG를 대조합니다.
AgentCore PUBLIC 네트워크와 ECS Private Subnet을 하나의 설정으로 설명하지 않습니다.

- [ ] 운영·데이터 알람과 dashboard가 내 자원을 가리킵니다.
- [ ] SNS 구독과 실제 수신을 확인했습니다.
- [ ] 한도·로그 보관·내용 비기록·이미지 검사 결과를 기록했습니다.
- [ ] 두 브라우저·새로고침으로 현재·누적 집계와 중복 방지를 확인했습니다.

Codex 카드: [11 · 관측·운영](../prompts/11-operations.md)

다음: [12 · 검증과 문제 해결](12-validation.md)
