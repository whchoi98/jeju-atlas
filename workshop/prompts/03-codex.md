# 03. 제주 가이드 구현

필수 프롬프트 1입니다.\
참가자 부모 폴더에서 연 Agentic AI 코딩 어시스턴트에 한 번 전달합니다.\
키는 사용자의 Bash에서 이미 입력했으므로 대화창에 붙여넣지 않습니다.

```ai-prompt
제주 가이드 워크숍 03장을 실제로 수행해 주세요. 이 장의 시간은 30분입니다.
계획 설명에 그치지 말고 AgentCore 프로젝트 생성과 검색 도구 구현을 완료하세요.
현재 참가자 폴더와 참가자 설정의 로컬 수정, 의존성 설치, 읽기 전용 AWS 조회를 승인합니다.
이미 정해진 경로나 같은 범위의 실행 승인을 반복해서 묻지 마세요.
AWS 자원 생성과 유료 모델 호출은 04장에서 진행합니다.
기본 실행은 필요한 구현, 의존성 준비와 경로, 계정, 스키마 확인에 한정합니다.
테스트 파일 작성과 전체 테스트, model_check.py의 유료 사전 호출,
로컬 agentcore dev는 생략하고 구현 후 04장으로 진행하세요.
실제 오류, 위험한 기능 변경 또는 명시적 요청이 있을 때만 해당 부분을
짧게 확인합니다. 생략한 검사를 통과로 기록하지 마세요.

1. 소스와 작업 범위를 확인하세요.
   ATLAS_REPO와 현재 폴더의 activate.sh 및 .owner.json을 우선 사용합니다.
   소스의 기본 위치는 /home/ec2-user/my-project/jeju-atlas입니다.
   "$ATLAS_REPO/skills/jeju-atlas-install/SKILL.md", 저장소 AGENTS.md,
   workshop/AGENTS.md와 기존 참가자 프로젝트의 지침을 읽으세요.
   ATLAS_CLI_PARENT는 현재 참가자 부모 폴더, ATLAS_CLI는 그 아래 프로젝트입니다.
   아직 프로젝트가 없어도 정상입니다. 각 참가자는 독립 랩을 사용합니다.
   새 설정은 공통 내부 ID team01과 프로젝트 AtlasCliTeam01을 사용하며
   팀명 선택이나 치환을 요구하지 마세요. 기존 이름과 소유 설정은 유지합니다.
   모든 터미널 실행은 올바른 cd로 시작하세요. 새 셸에서는 확인한 저장소 절대 경로로
   이동하고 기존 activate.sh를 source한 뒤 해당 작업 폴더로 다시 이동하세요.
   생성 전에는 ATLAS_CLI_PARENT, 생성 후 CLI 명령은 ATLAS_CLI,
   Python 의존성 작업은 ATLAS_CLI/app/JejuGuide에서 수행합니다.
   경로 이동이나 활성화가 실패하면 그 셸의 후속 명령을 실행하지 마세요.
   .env와 로그인 파일을 직접 읽거나 출력하지 마세요. 필요한 처리는 지정된 helper만 사용합니다.
   원본 소스와 다른 참가자의 파일, 시스템 도구와 AI 로그인 설정은 보존하세요.
   코딩용 모델과 provider는 사전 검증된 설정을 유지하고 수업 중 자동 변경하지 마세요.

2. 기존 사전 점검 결과와 계정을 확인하세요.
   setup에서 성공한 core.py doctor는 반복하지 말고 core.py doctor --project를 요구하지 마세요.
   Node 24 계열 24.18.1 이상, Python 3.12와 npm @aws/agentcore 0.28.1을 유지합니다.
   aws sts get-caller-identity
   ATLAS_CONFIG가 없을 때만 다음 명령으로 로컬 참가자 설정을 만드세요.
   python3 "$ATLAS_REPO/workshop/scripts/lab.py" init-ec2 --identity-only --participant "$ATLAS_TEAM" --config "$ATLAS_CONFIG"
   python3 "$ATLAS_REPO/workshop/scripts/lab.py" info --config "$ATLAS_CONFIG"
   다시 활성화해 ATLAS_ACCOUNT를 복원하고 EC2 신원과 STS 계정을 대조하세요.
   배포 대상은 이 계정의 ap-northeast-2입니다. 기존 VPC와 CDK bootstrap을 사용합니다.
   lab.py info의 심화용 cli 경로 대신 ATLAS_CLI를 사용하세요.

3. 프로젝트가 없을 때만 다음 명령으로 생성하세요.
   agentcore create --project-name "$ATLAS_PROJECT" --name JejuGuide --framework Strands --model-provider Bedrock --language Python --build CodeZip --memory none --network-mode PUBLIC --output-dir "$ATLAS_CLI_PARENT" --skip-git --skip-python-setup --skip-install --json
   기존 ATLAS_CLI가 있으면 파일과 진행 상태를 확인하고 create를 반복하지 마세요.
   생성된 agentcore/agentcore.json, agentcore/aws-targets.json,
   app/JejuGuide/main.py와 model/load.py를 읽으세요.
   aws-targets.json의 default 대상이 비었을 때 실제 STS 계정과 ap-northeast-2를 기록합니다.
   기존 대상이 다른 계정이나 프로젝트를 가리키면 자동 교체하지 말고 불일치를 보고하세요.
   Runtime은 JejuGuide, CodeZip, PUBLIC, IAM 호출 인증을 유지합니다.
   참가자 CLI 설정의 disableDependencyManagement, disableTransactionSearch와 telemetry 비활성화를 유지하세요.

4. 원본 샘플과 모델 설정을 준비하세요.
   "$ATLAS_REPO/agent/tools/data/jeju_pois.json"을 app/JejuGuide/data/jeju_pois.json에 복사합니다.
   대상이 이미 있으면 원본과 비교하고 차이를 보고하세요. 자동으로 덮어쓰지 마세요.
   원본 137개와 source=sample을 유지합니다.
   python3 "$ATLAS_REPO/workshop/scripts/model_config.py" --project "$ATLAS_CLI" --env-file "$ATLAS_CLI_PARENT/.env"
   helper가 생성 로더와 Python 3.12 설정을 적용하게 하세요.
   runtimeVersion은 PYTHON_3_12, 로컬 Python과 pyproject도 3.12에 맞는지 확인합니다.
   모델은 global.anthropic.claude-sonnet-4-6이며 호출 리전은 .env의 확인된 값만 사용합니다.
   배포 리전으로 자동 대체하지 말고 키를 코드, Runtime 설정, 명령 인자나 보고서에 복사하지 마세요.
   helper가 기존 사용자 로더의 차이를 보고하면 해당 차이부터 검토하고 덮어쓰지 마세요.

5. search_jeju_places(query="", category="", limit=5)를 구현하세요.
   실제 JSON 구조를 읽고 이름과 카테고리로 검색하며 정확한 이름 일치를 먼저 반환합니다.
   query는 최대 160자, limit는 정수 1~5로 검증하세요.
   category만 있으면 검색하고 두 조건이 모두 비면 입력 오류, 결과가 없으면 빈 목록을 반환합니다.
   데이터 경로는 도구 파일 위치를 기준으로 계산합니다.
   반환 장소에는 원본 id, name, category, lat, lng, address, source를 사용합니다.
   실습용 시드와 미검증 안내를 포함하고 없는 사실이나 관측 시각은 만들지 마세요.
   기본 add_numbers를 제주 도구로 바꾸고 Strands Agent의 tools에 연결하세요.
   도구 결과만 근거로 한국어로 답하고 영업시간, 사진과 전화번호가 없으면 미확인이라고 밝힙니다.
   생성된 BedrockAgentCoreApp 진입점, 세션별 Agent와 스트리밍 처리를 유지하세요.

6. 실행에 필요한 의존성과 스키마를 준비하세요.
   agentcore/cdk에 package-lock.json이 있으면 npm ci, 처음이면 npm install을 사용합니다.
   app/JejuGuide에서 처음에는 uv sync --python 3.12,
   uv.lock이 있으면 uv sync --python 3.12 --frozen을 사용하고 잠금 파일을 보존하세요.
   검색 로직은 모델과 분리하되 기본 과정에서 테스트 묶음을 새로 만들거나 실행하지 마세요.
   ATLAS_CLI에서 agentcore validate --json으로 생성한 설정을 확인하세요.
   실제 검색 오류를 수정할 때만 해당 입력을 모델 없이 확인합니다.
   검증 실패는 해당 파일과 원인만 수정하고 관련 확인만 다시 수행하세요.
   패키징 오류가 아직 없다면 추정으로 패키징 설정을 바꾸지 마세요.

참가자 AGENTS.md에 작업 범위와 비밀값 처리 규칙을 간결하게 기록하세요.
기존 지침과 작업 기록은 보존하고 선택한 Agentic AI 코딩 어시스턴트 하나로 계속 진행합니다.
HUD는 참가자가 선택했을 때만 설치하거나 실행합니다.
카카오, 관광공사와 VISIT JEJU 연동은 첫 배포 뒤 선택 작업으로 남깁니다.
ATLAS_CLI_PARENT/RESULTS.md에 변경 파일, 실제 실행한 명령과 결과,
생략한 검사와 남은 문제를 짧게 기록하세요.
키와 인증 파일은 기록하지 마세요. 배포와 실제 모델 응답은 아직 완료로 표시하지 마세요.
마지막에 구현 결과와 04장에서 이어갈 위치를 짧게 보고하세요.
```
