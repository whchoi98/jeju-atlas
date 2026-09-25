# 제주 아틀라스 설치 프롬프트

EC2에서 사용하는 Agentic AI 코딩 어시스턴트에 아래 프롬프트 중 하나를 붙여 넣습니다.\
이미 설치하고 로그인한 Codex, Claude Code, Kiro CLI를 그대로 사용합니다.\
AI가 기존 환경을 확인하고 요청 범위의 작업을 실행합니다.
키 입력만 참가자 자신의 Bash에서 숨김 입력으로 받으며 AI 대화에 붙여넣지 않습니다.

| 하고 싶은 일 | 사용할 프롬프트 |
|---|---|
| 처음 시작하며 소스와 개발 도구를 준비하기 | 1. 설치 준비 |
| 기본 제주 가이드를 구현하고 AgentCore에 배포하기 | 2. 기본 CLI 실습 |
| 지도·AI·길찾기가 있는 전체 웹 서비스를 AWS에 설치하기 | 3. 전체 설치 |
| 중단했던 설치나 배포를 이어가기 | 4. 기존 작업 재개 |

참가자마다 AWS 자원 범위가 분리된 독립 랩을 사용합니다.\
새 설치의 공통 내부 ID는 `team01`, 프로젝트는 `AtlasCliTeam01`이며 자동으로 적용합니다.\
실제 팀 배정이나 이름 선택은 없습니다. 재개할 때는 기존 ID·프로젝트·경로를 유지합니다.

도구 설치는 수업 전에 끝냅니다. 기본 00–04장은 **100분 + 여유 20분**입니다.\
전체 웹 설치는 05–14장의 별도 심화 과정으로 120분 안의 완료를 약속하지 않습니다.

**기본 진행은 준비·구현·필요한 빌드·배포와 최종 응답 1회 확인입니다.**\
HUD 설치와 전체 테스트·브라우저·한영 응답 등 추가 검증은 생략합니다.\
오류가 있거나 별도 확인을 요청한 경우에만 해당 진단을 추가하고, 생략한 검사는 통과로 기록하지 않습니다.

스킬 언급이나 이 문서 열람 자체는 외부 작업 승인이 아닙니다.
각 프롬프트를 실제로 전달한 사용자의 승인 범위만 적용합니다.

## 1. 설치 준비

AWS 자원 생성과 유료 모델 호출 없이 소스, 전용 개발 도구와 참가자 환경을 준비합니다.

```text
제주 아틀라스 설치 환경을 준비해 주세요. 계획 설명에 그치지 말고 실제 파일과 도구를 준비해 주세요.

[입력]
- 저장소: 현재 작업 폴더와 바로 아래 폴더에서 찾아 재사용.
  없으면 ~/my-project/jeju-atlas에 공식 저장소를 새로 clone.
- 공식 저장소: https://github.com/whchoi98/jeju-atlas.git
- 독립 랩: 기존 설정을 재사용. 새 설치는 내부 ID team01, 프로젝트 AtlasCliTeam01을 자동 사용.
  팀명이나 새 ID를 묻거나 재개 중인 프로젝트 이름을 바꾸지 마세요.
- Agentic AI 코딩 어시스턴트·모델·provider: 현재 대화에 사용하는 사전 검증된 설정.
- 실행 범위: 로컬 설치와 읽기 전용 환경 확인.

[진행]
1. 저장소의 AGENTS.md와 workshop/AGENTS.md를 읽고 기존 변경, 참가자 설정과 설치 기록을 확인하세요.
   skills/jeju-atlas-install/SKILL.md가 함께 전달되었으면 그 절차도 적용하세요.
   기존 프로젝트가 여러 개여서 대상을 정할 수 없을 때만 어느 프로젝트인지 한 번 물어보세요.
   매 Bash 실행의 첫 줄에서 확인한 실제 작업 폴더로 cd하세요.
2. 선택한 Agentic AI 코딩 어시스턴트와 uv 등 누락된 사전 요구를 해결하세요.
   Node 24 계열 24.18.1 이상, Runtime Python 3.12, npm @aws/agentcore 0.28.1을 사용합니다.
   기존 보조 Python은 3.12 이상이면 유지하고 Python starter CLI와 구분하세요.
   별도 환경 진단이 필요하면 check_env.sh를 사용하세요.
3. 새 독립 랩에서 Codex를 사용하면 실제 저장소 루트로 이동한 뒤 다음을 실행하세요.
   bash workshop/scripts/start.sh --assistant codex --participant team01
   기존 참가자·프로젝트·도구이면 해당 값을 사용하세요.
   이 명령이 참가자 준비, 전용 도구 설치와 doctor를 수행하게 하세요.
   기본 doctor가 성공했으면 반복하지 말고 다음 단계로 진행하세요.
4. 출력된 절대 activationPath를 사용할 Bash에서 source하세요.
   새 Bash마다 다시 활성화하고 명령에 맞는 작업 폴더로 cd하세요.
   프로젝트 생성 전 Agentic AI 코딩 어시스턴트의 작업 위치는 ATLAS_CLI_PARENT입니다.
   아직 없는 ATLAS_CLI를 미리 만들거나 이동하지 마세요.
5. 현재 EC2의 신원·STS 계정·리전·VPC를 읽기 전용으로 확인하고 기존 설정을 보존하세요.
   키가 필요하면 사용자가 자신의 Bash에서 다음을 실행하도록 안내하세요.
   cd -- "$ATLAS_CLI_PARENT" || exit 1
   python3 "$ATLAS_REPO/workshop/scripts/workshop_env.py" configure
   Bedrock API 키와 모델 호출 리전 두 항목만 해당 helper로 입력받으세요.
   에이전트는 같은 helper의 status로 상태만 확인하고 .env를 직접 읽거나 source하지 마세요.

기존 시스템 Python/Node, Agentic AI 코딩 어시스턴트 로그인, 셸 시작 파일을 유지하세요.
HUD 설치·진단, 전체 테스트와 core.py doctor --project는 생략하세요.
실패한 명령이 있으면 해당 원인만 확인하고 필요한 진단을 수행하세요.
이 요청에서는 AWS 변경, SSM 키 게시, 실제 모델 호출을 실행하지 마세요.
카카오·관광공사·VISIT JEJU 키는 첫 배포 뒤 선택 입력으로 남깁니다.
실제 소스 경로, 활성화 명령, 도구 버전, 검사 결과와 다음 단계를
ATLAS_CLI_PARENT/RESULTS.md에 비밀값 없이 기록하고 마지막에 짧게 알려 주세요.
```

선택한 Agentic AI 코딩 어시스턴트 실행 권장은 [준비 참조](jeju-atlas-install/references/prepare.md#선택한-agentic-ai-코딩-어시스턴트-실행)에 있습니다.
Codex는 `on-request`와 `auto_review`, Claude Code는 지원되는 사전 검증 환경에서
`claude --permission-mode auto`, Kiro는 `kiro-cli chat`를 사용합니다.
코딩 모델을 Runtime의 Sonnet 4.6으로 강제하지 않으며,
키 helper로 Agentic AI 코딩 어시스턴트를 실행하지 않습니다.

## 2. 기본 CLI 실습

이 프롬프트는 **참가자 전용 Runtime 구현·배포, 전용 SSM 키 전달과 최종 응답 확인용 모델 호출**을 승인합니다.\
첫 실행은 활성화 후 `$ATLAS_CLI_PARENT`에서, 기존 프로젝트는 해당 작업 폴더에서 시작합니다.\
세부 단계는 [구현 카드](../workshop/prompts/03-codex.md)와
[배포 카드](../workshop/prompts/04-agentcore-cli.md)를 에이전트가 읽도록 합니다.

```text
현재 참가자의 제주 가이드 기본 CLI 실습을 구현부터 배포·원격 응답까지 완료해 주세요.
사전 설치를 마친 00–04장 기본 실습이며 전체 앱은 별도입니다.
범위는 100분 실습과 여유 20분 안의 JejuGuide Runtime입니다.

[입력과 승인]
- 기존 저장소·참가자·프로젝트·Agentic AI 코딩 어시스턴트와 검증된 코딩 모델·provider·로그인을 유지하세요.
- 새 독립 랩은 공통 내부 ID team01, 프로젝트 AtlasCliTeam01을 자동 사용하세요.
  팀명이나 새 ID를 묻지 말고 재개 시 기존 값을 유지하세요.
- AWS 대상은 현재 EC2의 실습 계정, 배포 리전은 ap-northeast-2입니다.
- JejuGuide 모델은 global.anthropic.claude-sonnet-4-6, Runtime은 Python 3.12입니다.
- 모델 인증은 사용자가 helper로 입력한 Bedrock API 키입니다.
  단기 또는 장기 API 키와 모델 호출 리전은 ATLAS_CLI_PARENT/.env에서 helper로만 사용하세요.
- 로컬 구현·의존성 설치·검사, 읽기 전용 AWS 조회,
  이 참가자의 Runtime 생성·변경·배포와 필요한 역할·최소 정책 설정을 승인합니다.
- 이 참가자의 키를 전용 SSM SecureString으로 게시·갱신하고,
  해당 parameter 하나의 GetParameter managed policy를 연결하는 작업을 승인합니다.
- 배포 후 최종 원격 답변 한 번의 모델 호출을 승인합니다.
  오류가 발생하면 같은 범위에서 원인 확인에 필요한 최소 추가 호출만 수행하세요.
- 공유 네트워크·CDK bootstrap·계정 전체 설정 변경, 자원 삭제와 Git push는 제외합니다.

[실행]
1. skills/jeju-atlas-install/SKILL.md와 적용되는 AGENTS.md, 기존 RESULTS.md를 읽으세요.
   기존 작업이 있으면 현재 파일과 AWS 상태부터 대조하고 create를 반복하지 마세요.
   매 Bash 실행의 첫 줄에 실제 작업 폴더로 cd를 넣으세요.
   새 Bash에서는 출력된 절대 activate.sh를 source하고 명령에 맞는 폴더로 다시 cd하세요.
2. start.sh의 기본 doctor 결과를 재사용하고 EC2 신원·STS 계정·참가자 설정·default 배포 대상을 대조하세요.
   환경 변경이나 실패가 있을 때만 필요한 진단을 다시 실행하세요.
   키 입력 상태는 workshop_env.py status로 확인하세요. 누락되거나 실제 호출에서 만료가 확인된 키는 사용자 Bash의
   configure 숨김 입력으로 갱신하고 키를 대화나 명령 인자로 받지 마세요.
3. workshop/prompts/03-codex.md를 읽고 없는 프로젝트만 AgentCore CLI로 생성하세요.
   137개 샘플과 검색 도구, 세션·스트리밍을 연결하세요.
   model_config.py --project "$ATLAS_CLI" --env-file "$ATLAS_CLI_PARENT/.env"로
   Python 3.12, 로더·인증·호출 리전을 맞추고 사용자 로더를 덮어쓰지 마세요.
4. agentcore validate --json으로 설정 스키마를 확인한 뒤 배포로 진행하세요.
   테스트 파일 생성·검색 테스트·core.py doctor --project·model_check.py·로컬 응답은 기본으로 생략하세요.
   오류가 있거나 별도 검증을 요청받으면 해당 진단만 추가하세요.
   로컬 재현이 필요하면 run --으로 Runtime 자식에만 키를 전달하세요.
   Agentic AI 코딩 어시스턴트에는 이 키를 전달하지 마세요.
5. workshop/prompts/04-agentcore-cli.md를 읽고 SSM 연결을 진행하세요.
   workshop_env.py publish --project "$ATLAS_CLI"로 계획을 확인한 뒤 --execute로 적용하세요.
   Runtime 설정의 키 전달은 SSM ARN과 additionalPolicies만 사용하고 원문·.env를 ZIP에 넣지 마세요.
6. agentcore deploy --target default --dry-run에서 현재 참가자 범위를 확인한 뒤 배포하세요.
   04장대로 uv export --locked로 잠금 제약을 만들고 계획과 실제 배포에 같은 UV_CONSTRAINT를 전달하세요.
   진행 중인 배포는 조회하고 중복 실행하지 마세요.
   준비 상태를 확인한 뒤 최종 원격 질문 한 번으로 도구 사용·샘플 출처·응답 완료를 확인하세요.

같은 승인 범위를 단계마다 다시 묻지 마세요. 키 원문은 로그·코드·보고서에 넣지 마세요.
HUD와 전체 테스트·브라우저·한영 응답 검증을 완료 조건에 추가하지 마세요.
모델 오류를 확인되지 않은 리전이나 IAM으로 자동 대체하지 말고 같은 실패 호출을 반복하지 마세요.
카카오·관광공사·VISIT JEJU는 키 없이 첫 배포를 마친 뒤 선택 기능으로 남겨 주세요.
RESULTS.md에 필수 확인·배포·원격 답변의 실제 결과, 생략한 선택 검사와 미완료 항목을 구분해 기록하세요.
생략한 검사를 통과로 표시하지 마세요.
```

## 3. 전체 설치

이 프롬프트에는 **참가자 AWS 자원 배포와 검증에 필요한 유료 모델 호출 승인**이 포함됩니다.
기존 VPC·Subnet·NAT와 EC2를 사용하는 설치입니다. 준비만 하려면 1번을 사용합니다.
전체 웹 설치는 별도 심화 과정이며 기본 실습의 100~120분에 포함하지 않습니다.

```text
현재 EC2에 제주 아틀라스 전체 웹 서비스를 설치하고 실제 접속과 AI 응답까지 확인해 주세요.
필요한 로컬 준비부터 진행하여 사용할 수 있는 CloudFront HTTPS 주소를 알려 주세요.

[입력]
- 저장소: 현재 작업 폴더와 바로 아래 폴더에서 찾아 재사용.
  없으면 ~/my-project/jeju-atlas에 https://github.com/whchoi98/jeju-atlas.git을 clone.
- 독립 랩: 기존 설정을 재사용. 새 설치는 내부 ID team01, 프로젝트 AtlasCliTeam01을 자동 사용.
  팀명이나 새 ID를 묻거나 기존 프로젝트 이름을 바꾸지 마세요.
- Agentic AI 코딩 어시스턴트·모델·provider: 현재 대화에 사용하는 사전 검증된 설정.
- AWS 대상: 현재 EC2의 실습 계정, 서울 ap-northeast-2.
- 네트워크: 현재 EC2의 기존 VPC와 준비된 Public/Private Subnet, NAT.
- 모델: global.anthropic.claude-sonnet-4-6.
- 모델 인증: 기존에 명시적으로 선택한 설정을 재사용. 새 설치의 기본은 IAM.
- Bedrock 호출 리전: 기존에 실제 확인한 값을 재사용.
  확인한 값이 없으면 모델 작업 전에 필요한 입력을 한 번에 물어보세요.
- API 키 방식을 지정한 경우: 기존 전용 SSM SecureString의 ARN을 사용.
  기존 전달 경로가 없으면 helper의 숨김 입력으로 받은 키를 참가자 Guide까지 연결하는
  구현 범위와 실제 지원을 확인하세요. 기본 CLI용 publish가 심화 Guide를 지원한다고 가정하지 마세요.
  키 원문을 프롬프트, 코드, 명령 인자, Runtime 설정, ZIP이나 로그에 넣지 마세요.

[승인 범위]
이 참가자의 서비스 설치에 필요한 AWS 자원 생성·변경, 이미지와 데이터 게시,
최종 웹 응답 한 번과 오류 발생 시 원인 확인에 필요한 최소 모델 호출을 승인합니다.
API 키 인증을 명시적으로 선택한 경우 이 참가자의 전용 SSM 키 전달,
최소 읽기 권한과 Guide 로더·갱신·배포 연결 작업도 포함합니다.
같은 범위의 작업은 단계마다 재확인하지 말고 변경 계획을 검토하여 진행하세요.
공유 네트워크, 공유 CDK bootstrap, 계정 전체 설정 변경과 자원 삭제,
Git push는 이 승인에 포함하지 않습니다.

[진행]
1. 적용되는 AGENTS.md와 기존 RESULTS.md, completion-context.json을 먼저 읽으세요.
   skills/jeju-atlas-install/SKILL.md가 있으면 인증·배포 참조까지 해당 단계에서 읽으세요.
   기존 소스, 참가자 폴더, 활성화 파일과 배포 자원을 재사용하세요.
   매 Bash 실행의 첫 줄에서 확인한 실제 작업 폴더로 cd하세요.
2. 선택한 도구·참가자의 start.sh로 필요한 사전 준비를 하고,
   출력된 절대 activate.sh를 사용할 Bash에서 source한 뒤 해당 작업 폴더로 다시 cd하세요.
   start.sh에서 기본 doctor가 성공했으면 반복하지 마세요.
   Node 24 계열 24.18.1 이상, Runtime Python 3.12와 npm @aws/agentcore 0.28.1을 사용하세요.
   전체 앱에 필요한 Python 검사 의존성, PyYAML, cfn-lint와 Docker도 확인하세요.
3. 전체 소스의 workshop/scripts/lab.py로 참가자 앱 사본을 준비하세요.
   기존 app 폴더가 있으면 재생성하지 말고 소유 설정과 현재 코드를 확인하세요.
4. 기존 네트워크 확인 → ECR·Data → 카탈로그·의존성 →
   Guide·Tools·Gateway·Memory → Valhalla → 웹 앱 →
   실제 Distribution을 사용하는 WAF·정적 S3 연결 → 모니터링 순서로 진행하세요.
   각 변경 계획의 계정과 참가자 범위를 확인한 뒤 적용하고 완료 상태를 확인하세요.
5. 실제 Guide의 모델 인증을 먼저 확인하세요. 기본 CLI Runtime과 심화 Guide는 별도입니다.
   .env 복사만으로 심화 Guide의 API 키 연결이 완료됐다고 하지 마세요.
   API 키를 선택했다면 키 전달·권한·로더·갱신을 구현·대조한 뒤 배포하세요.
   IAM 성공과 API 키 성공을 구분하고 최종 웹 응답에서 실제 연결을 확인하세요.
   별도 모델 검사와 Runtime 직접 호출은 오류 진단 또는 추가 확인 요청 시에만 수행하세요.
6. 필요한 빌드와 확인은 참가자 사본에서 수행하고 소스·이미지·결과가 같은 변경을 가리키게 하세요.
   CloudFront URL은 내 App 스택 출력으로 조회하세요.
7. 배포 상태와 실제 HTTPS 접속, 최종 웹 응답 한 번의 완료를 확인하세요.
   전체 테스트·브라우저 자동화·한영 응답·PWA·교재·전체 통합 검증은 기본으로 생략하세요.
   오류가 있으면 실패한 명령과 관련 기능만 진단하고 추가 요청이 있을 때 해당 검사를 수행하세요.
   HUD와 core.py doctor --project를 설치·배포의 필수 조건으로 두지 마세요.

카카오 검색과 공식 사진·영업시간 보강은 첫 배포 뒤 제공처 키가 있을 때 설정하세요.
입력은 workshop_env.py configure --integrations의 사용자 Bash 숨김 입력으로 받습니다.
lab.py set-secret --provider와 --env-file "$ATLAS_CLI_PARENT/.env"의 계획을 확인하고,
선택한 참가자 연동 범위에서 --execute로 게시한 뒤 앱·수집기 전달과 실제 기능을 검사하세요.
키가 없거나 자료가 제한되면 해당 기능의 상태와 데이터 범위를 정확히 기록하세요.
검사 생략·실패·시간초과를 통과로 바꾸지 마세요.
진행 중인 배포는 상태를 조회하고, 같은 원인의 배포·모델 호출을 반복하지 마세요.
RESULTS.md에 실제 URL, 소스·이미지 버전, 완료 항목, 실패 항목과 재개 명령을 기록하세요.
```

API 키를 처음 선택할 때는 입력의 `모델 인증`을 `API 키, SSM ARN: 실제 ARN`으로 바꿉니다.
전달 경로가 아직 없으면 `API 키, 사용자 Bash에서 숨김 입력 후 Guide 연결 구현 포함`으로 명시합니다.
일반 Guide의 IAM 인증과 기존 참가자 사본의 API 키 지원은 다를 수 있습니다.
코드의 지원 여부를 확인하며, 환경변수나 기본 CLI helper만으로 연결 완료로 처리하지 않습니다.

## 4. 기존 작업 재개

이미 생성한 앱과 Runtime의 구현·배포를 이어갈 때 사용합니다.\
같은 참가자 범위의 배포와 최종 응답 확인용 모델 호출을 승인합니다.

```text
제주 아틀라스 설치를 마지막으로 멈춘 지점부터 이어서 완료해 주세요.
현재 작업 폴더의 저장소와 workshop/.local 아래에서 기존 참가자와 작업 기록을 찾으세요.
재개 시 기존 참가자 ID와 프로젝트 이름을 유지하고 새 팀명이나 ID를 묻지 마세요.
여러 기존 프로젝트에서 재개 대상을 식별할 수 없을 때만 대상 프로젝트를 한 번 물어보세요.

같은 참가자 서비스의 남은 AWS 배포·설정 변경과 최종 응답 한 번의 모델 호출을 승인합니다.
오류가 발생하면 같은 범위에서 원인 확인에 필요한 최소 추가 호출만 수행하세요.
기존 소스 변경, 데이터, 도구, 계정과 이미 선택한 모델 인증을 유지하세요.
기존에 선택한 API 키 방식은 이 참가자 전용 SSM 키와 최소 읽기 정책의 게시·갱신을 포함합니다.
공유 자원 변경, 삭제와 Git push는 제외합니다.

1. 적용되는 AGENTS.md, completion-context.json, 참가자 RESULTS.md,
   evidence와 참가자 앱의 .local 검사·배포 기록을 읽으세요.
   skills/jeju-atlas-install/SKILL.md가 있으면 재개 절차를 적용하세요.
2. 매 Bash 실행의 첫 줄에 확인한 실제 작업 폴더로 cd를 넣으세요.
   출력되거나 기록된 절대 activate.sh를 같은 Bash에서 불러오고 실제 app/CLI 폴더로 다시 cd하세요.
   기록의 상태는 현재 파일과 AWS의 읽기 전용 조회로 다시 확인하세요.
3. 완료된 설치·데이터 생성·이미지 빌드는 재사용하세요.
   기존 app을 lab.py prepare로 덮어쓰거나 CLI를 다시 create하지 마세요.
4. API 키 모드이면 workshop_env.py status로 키와 모델 호출 리전의 입력 여부를 확인하세요.
   키는 .env를 직접 읽거나 source하지 말고, 사용자 Bash의 configure 숨김 입력으로 갱신하세요.
   기본 CLI는 키 갱신이 필요한 경우 publish 계획과 --execute로 전용 SSM 키를 갱신하세요.
   기본 helper와 심화 Guide의 인증 지원을 구분하고, 실제 SSM 전달·역할·로더·배포 환경을 대조하세요.
   리전·코드 변경이 있으면 배포하세요.
   기본 CLI는 새 Runtime 세션, 심화 앱은 웹에서 최종 응답 한 번을 끝까지 확인하세요.
5. CLI에 scripts/agentcore-package.py가 있으면 기존 패키징 wrapper를 사용하세요.
   전체 웹 설치와 기본 CLI 실습 Runtime의 상태를 각각 확인하세요.
6. 남은 필수 배포·응답 실패가 있으면 실패한 명령과 원인을 확인하고 관련 진단만 수행하세요.
   HUD, 전체 테스트·브라우저·한영 응답·core.py doctor --project는 기본으로 생략하세요.
   과거의 선택 검사 미실행 기록을 필수 작업으로 바꾸지 마세요.
   캐시 Miss, 자료 부족, 브라우저 시간초과를 숨기거나 검사 조건을 느슨하게 하지 마세요.

현재 상태에서 필요한 작업을 계속 진행하고 완료·미완료·생략·외부 입력이 필요한 항목을 구분하세요.
생략한 검사를 통과로 기록하지 마세요.
RESULTS.md와 기존 재개 기록을 갱신한 뒤 실제 URL과 남은 항목을 알려 주세요.
```

## 설치 스킬 사용

스킬 원본은 [jeju-atlas-install/SKILL.md](jeju-atlas-install/SKILL.md)입니다.
준비, 기본 CLI 실습, 전체 웹 설치, 중단 작업 재개를 같은 스킬이 처리합니다.
세부 참조는 [준비](jeju-atlas-install/references/prepare.md),
[모델 인증](jeju-atlas-install/references/model-auth.md),
[배포](jeju-atlas-install/references/deploy.md)입니다.

등록된 Codex에서는 원하는 범위로 요청합니다.

```text
$jeju-atlas-install 현재 EC2에서 제주 아틀라스 설치 준비를 해 주세요.
AWS 배포와 모델 호출은 제외합니다.
```

실행할 프롬프트 맨 앞에 `$jeju-atlas-install`을 추가할 수 있습니다.
외부 작업 승인은 해당 프롬프트에 적은 범위로 한정합니다.
스킬 이름을 인식하지 못하는 환경에서는 다음처럼 파일을 직접 읽도록 요청할 수 있습니다.

```text
저장소의 skills/jeju-atlas-install/SKILL.md를 읽고 그 절차를 적용해 주세요.
실행 범위와 승인은 뒤에 붙이는 설치 프롬프트를 따르세요.
```

### 다른 EC2에 스킬 복사

**이 문서와 skills 폴더가 들어 있는 소스**를 먼저 옮깁니다.
아직 Git에 게시되지 않은 파일은 공개 저장소를 clone하는 것만으로 전달되지 않습니다.
다음은 Codex의 사용자 스킬 경로인 `~/.agents/skills/`에 복사하는 명령입니다.
옮긴 **전체 저장소 루트의 Bash 터미널**에서 실행합니다.
이미 같은 이름의 스킬이 있으면 덮어쓰지 않고 중단합니다.

```bash
cd -- "${ATLAS_REPO:-/home/ec2-user/my-project/jeju-atlas}" || exit 1
(
  set -eu
  atlas_repo="$PWD"
  atlas_skill_src="$atlas_repo/skills/jeju-atlas-install"
  atlas_skill_dst="$HOME/.agents/skills/jeju-atlas-install"
  test -f "$atlas_skill_src/SKILL.md"
  for atlas_reference in prepare model-auth deploy; do
    test -f "$atlas_skill_src/references/$atlas_reference.md"
  done
  test ! -e "$atlas_skill_dst"
  test ! -L "$atlas_skill_dst"
  mkdir -p -- "$(dirname -- "$atlas_skill_dst")"
  cp -R -- "$atlas_skill_src" "$atlas_skill_dst"
)
```

ZIP으로 전달받았다면 압축 안의 `jeju-atlas-install` 폴더를 같은 사용자 스킬 경로에 둡니다.
복사 후 스킬을 확인하고 보이지 않으면 Codex를 다시 시작합니다.
파일 읽기 방식은 별도 스킬 등록 없이도 사용할 수 있습니다.
최종 설치 결과는 도구 설치, AWS 배포, 최종 응답과 생략한 선택 검사로 나눠 받아 보세요.
과거의 테스트 개수나 다른 계정의 배포 기록은 새 설치의 성공 근거가 아닙니다.

관련 문서: [로컬 개발](../docs/onboarding.md) · [워크숍](../workshop/README.md) ·
[진행자 준비](../workshop/reference/facilitator.md)

스킬 등록 경로 확인: OpenAI 공식 문서 `https://developers.openai.com/codex/skills/`
(2026-09-24 확인).
