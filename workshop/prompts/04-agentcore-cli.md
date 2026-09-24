# 04. 배포와 예제 응답

필수 프롬프트 2입니다.\
03장을 마친 같은 Agentic AI 코딩 어시스턴트 대화에 전달합니다.\
참가자 AWS 자원 생성과 최종 예제 응답을 위한 소량의 유료 모델 호출 승인이 포함됩니다.

```ai-prompt
현재 참가자의 JejuGuide를 AgentCore CLI로 배포하고 최종 예제 응답을 한 번 확인해 주세요.
이 장은 45분이며 핵심 과정 전체는 100분, 여유를 포함해 최대 120분입니다.

현재 EC2 계정의 ap-northeast-2에 이 참가자 Runtime과 배포 스택,
키용 SSM SecureString, 해당 키만 읽는 IAM managed policy를 생성하거나 갱신하는 작업을 승인합니다.
로컬 작업과 읽기 전용 AWS 조회, 검증에 필요한 소량의 유료 모델 호출도 승인합니다.
같은 범위의 승인을 반복해서 묻지 말고 계획의 계정과 소유 자원을 검토한 뒤 실행하세요.
공유 VPC, Subnet, NAT Gateway, EC2, CDK bootstrap, 다른 Runtime과 계정 전체 설정은 유지합니다.
삭제는 별도 요청이 있을 때만 진행하고 기본 종료는 자원 담당자와 정리 시점 인계입니다.
기본 흐름은 필요한 경로, 계정, 스키마 확인, 키 게시 계획과 적용,
배포 계획과 적용, 상태 조회 1회, 최종 원격 예제 응답 1회입니다.
model_check.py의 유료 사전 호출, 로컬 agentcore dev, 테스트 생성, 실행,
npm run check와 npm run workshop:check는 기본으로 생략합니다.
실제 오류, 위험한 기능 변경 또는 명시적 요청이 있을 때만
해당 부분의 진단을 추가합니다. 생략한 검사를 통과로 기록하지 마세요.

1. 기존 결과와 환경을 확인하세요.
   "$ATLAS_REPO/skills/jeju-atlas-install/SKILL.md", 적용되는 AGENTS.md와
   ATLAS_CLI_PARENT/RESULTS.md를 읽고 같은 참가자와 ATLAS_CLI를 사용하세요.
   환경이 비었으면 현재 참가자 activate.sh와 소유 설정에서 복원합니다.
   참가자마다 독립 랩이며 새 설정의 공통 내부 ID는 team01,
   프로젝트는 AtlasCliTeam01입니다. 팀명을 묻거나 기존 이름과 자원을 바꾸지 마세요.
   모든 터미널 실행은 올바른 cd로 시작하세요. 새 셸에서는 확인한 저장소로 이동하고
   기존 activate.sh를 source한 뒤 ATLAS_CLI로 다시 이동하세요.
   Python 의존성 명령은 ATLAS_CLI/app/JejuGuide로 이동한 뒤 실행합니다.
   경로 이동이나 활성화가 실패하면 그 셸의 후속 명령을 실행하지 마세요.
   python3 "$ATLAS_REPO/workshop/scripts/workshop_env.py" status로 입력 여부만 확인합니다.
   .env는 ATLAS_CLI_PARENT에 두며 직접 읽거나 source하지 않습니다.
   키를 프롬프트, 명령 인자, 로그, 코드, 배포 ZIP과 RESULTS.md에 넣지 마세요.
   model-check 보고서가 없어도 진행합니다. 사전 유료 호출을 새로 만들지 마세요.
   현재 키의 만료나 해결되지 않은 접근 실패가 확인되면 해당 원인과 재개 단계를 기록하세요.
   과거 EC2의 SCP 거부를 현재 참가자의 실패로 가정하거나 IAM/SCP를 바꾸지 마세요.

2. 배포 설정을 확인하세요.
   setup에서 성공한 core.py doctor를 반복하거나 core.py doctor --project를 요구하지 마세요.
   활성화와 소유 설정으로 현재 작업 경계를 확인합니다.
   Python은 3.12이며 기존 uv.lock과 package-lock.json을 보존하세요.
   Node 24 계열 24.18.1 이상과 npm @aws/agentcore 0.28.1을 사용합니다.
   Runtime은 JejuGuide, CodeZip, PYTHON_3_12, PUBLIC, IAM 호출 인증을 유지합니다.
   모델은 global.anthropic.claude-sonnet-4-6, 호출 리전은 .env의 확인된 값입니다.
   확인된 키 만료나 현재의 모델 접근 실패는 해결 후 배포와 호출을 재개합니다.

3. 배포 전에 키를 게시하세요.
   aws sts get-caller-identity의 계정, ATLAS_ACCOUNT와 default 배포 대상을 대조합니다.
   CLI 설정의 disableDependencyManagement와 disableTransactionSearch가 true이고
   telemetry가 비활성화되어 있는지 확인하세요.
   다음 계획에서 현재 계정, 참가자 소유 태그, SSM과 최소 읽기 권한 policy를 확인합니다.
   python3 "$ATLAS_REPO/workshop/scripts/workshop_env.py" publish --project "$ATLAS_CLI"
   승인된 범위와 일치하면 이어서 적용하세요.
   python3 "$ATLAS_REPO/workshop/scripts/workshop_env.py" publish --project "$ATLAS_CLI" --execute
   publish 내부의 key_binding 계정, 대상, 소유 태그 검사를 유지하세요.
   불일치나 권한 오류가 나면 그 원인에서 멈추고 검사나 IAM/SCP를 우회하지 마세요.
   키 관련 Runtime 설정에는 키 원문 대신 SSM ARN만 연결하세요.
   .env와 비밀 파일은 배포 코드 밖에 두고 ZIP에 포함하지 마세요.
   이 키는 모델 호출용이며 Runtime으로 들어오는 요청은 계속 IAM 인증을 사용합니다.
   키 연결 후 ATLAS_CLI에서 agentcore validate --json으로 배포 스키마를 확인하세요.

4. 같은 프로젝트에서 배포하고 원격 응답을 확인하세요.
   CLI 0.28.1의 CodeZip 빌더는 uv.lock을 직접 읽지 않으므로 배포 의존성에도 잠금 버전을 적용하세요.
   mkdir -p "$ATLAS_CLI_PARENT/evidence"를 실행하고 app/JejuGuide에서 다음으로 내보냅니다.
   uv export --python 3.12 --locked --no-dev --no-emit-project --no-hashes --output-file "$ATLAS_CLI_PARENT/evidence/runtime-constraints.txt"
   lock이 현재 pyproject와 맞지 않으면 실제 차이를 확인해 uv lock --python 3.12로 갱신하고
   같은 uv export를 다시 실행하세요. 이 문제를 이유로 전체 테스트를 추가하지 마세요.
   내보내기에 성공한 뒤 ATLAS_CLI에서 다음 계획을 실행합니다.
   UV_CONSTRAINT="$ATLAS_CLI_PARENT/evidence/runtime-constraints.txt" agentcore deploy --target default --dry-run
   현재 참가자의 변경 계획인지 확인한 뒤 같은 제약을 유지해 적용하세요.
   UV_CONSTRAINT="$ATLAS_CLI_PARENT/evidence/runtime-constraints.txt" agentcore deploy --target default
   UV_CONSTRAINT는 빌드 명령에만 전달하고 Runtime envVars에 넣지 마세요.
   agentcore status --target default --runtime JejuGuide --json으로 실제 상태를 한 번 확인합니다.
   아직 진행 중이면 배포를 중복 실행하지 말고 그 상태를 기록합니다.
   진행 상태 때문에 필요할 때만 기다린 뒤 같은 대상의 상태를 추가 조회합니다.
   READY가 된 뒤 다음 질문을 한 번 호출하세요.
   agentcore invoke "제주 해변 두 곳과 자료의 출처를 알려줘. 영업시간이 확인되는지도 알려줘." --runtime JejuGuide --target default --json
   완성된 원격 응답, 실제 검색 도구 사용, 시드 출처와 미확인 영업시간을 확인하세요.
   READY만으로 모델 응답 성공이라 쓰지 마세요. 성공하면 추가 질문 없이 인계합니다.
   응답 실패 시에만 agentcore logs --runtime JejuGuide --since 10m --limit 30 --json으로 조회합니다.
   진행 중인 배포를 다시 시작하거나 원인 확인 없이 모델 요청을 반복하지 마세요.
   로그로 해결되지 않는 오류에 한해 model_check.py 또는 짧은 로컬 실행 중
   필요한 진단 하나만 선택합니다. 실제 유료 호출은 승인된 범위 안에서만 수행합니다.
   패키징 실패가 실제로 발생하면 설치 스킬의 해당 절차와 오류 증거를 먼저 확인합니다.
   기존 패키징 helper가 있으면 검토해 재사용하고 추정으로 launcher나 패키지 버전을 바꾸지 마세요.
   키가 만료되면 사용자가 Bash에서 configure로 비공개 갱신하도록 안내하세요.
   갱신 후 publish 계획과 --execute를 적용하고 새 Runtime 세션으로 검증합니다.
   invoke의 --session-id에 새 UUID를 사용하고 이전 세션을 재사용하지 마세요.
   키 갱신을 이유로 프로젝트나 Runtime을 다시 만들지 마세요.

5. 결과와 자원을 인계하세요.
   ATLAS_CLI_PARENT/RESULTS.md에 사용한 Agentic AI 코딩 어시스턴트, 변경 파일,
   실제 실행한 명령과 결과, 최종 원격 응답, Runtime과 스택, SSM 및 policy 식별자를 기록하세요.
   비밀값은 남기지 말고 실패, 미실행과 성공을 구분합니다.
   생략한 테스트와 로컬 실행은 미실행으로 남기며 핵심 실습의 완료 조건에 추가하지 마세요.
   남긴 자원의 정리 담당자, 시점과 이어갈 단계를 기록하세요.
   Gateway, 별도 Memory, 전체 웹과 외부 연동은 핵심 과정의 완료 항목에 넣지 마세요.
   115분부터 새 배포나 유료 호출을 시작하지 말고 120분 안에 현재 상태를 인계합니다.

별도 삭제 요청이 있으면 같은 ATLAS_CLI에서 다음 순서를 따릅니다.
agentcore remove agent --name JejuGuide --yes --json으로 로컬 정의를 제거한 뒤
agentcore deploy --target default --dry-run의 소유 자원 삭제 계획을 확인하고
agentcore deploy --target default --yes로 적용합니다. AWS에서 Runtime 삭제를 확인하세요.
마지막 Runtime을 제거하는 배포는 CLI가 --yes를 요구하므로 삭제 요청과 계획을 확인한 뒤 사용합니다.
그 뒤에만 python3 "$ATLAS_REPO/workshop/scripts/workshop_env.py" cleanup --project "$ATLAS_CLI"로
키와 policy 정리 계획을 보고 같은 명령에 --execute를 붙여 적용합니다.
공유 bootstrap과 네트워크를 유지하고 남은 로그, 아티팩트와 삭제 진행 상태를 기록하세요.

추가 키 입력과 외부 연동은 첫 배포 뒤 reference/keys-and-integrations.md를 따라 진행합니다.
이 작업과 05~14장은 100~120분 밖의 선택 과정입니다.
HUD는 참가자가 선택한 경우에만 설치하거나 실행합니다.
마지막에는 실제 완료 항목, 실패 또는 미실행 항목, 자원 인계만 짧게 보고하세요.
```
