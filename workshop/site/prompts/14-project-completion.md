# 14, Codex로 프로젝트 완성하기. 통합 프롬프트

이 파일은 새 AWS 계정의 워크숍 환경 준비부터 애플리케이션과 AWS 구현까지 이어 가는 선택 프롬프트입니다.\
핵심 100분과 여유 20분은 00~04장에 해당하며 전체 앱 작업에는 별도 시간이 필요합니다.\
소스나 참가자 설정이 아직 없어도 아래 입력 블록부터 전달합니다.

기본 작업 유형은 독립 랩의 워크숍 참가자 작업입니다.\
새 설정은 공통 내부 ID `team01`과 프로젝트 `AtlasCliTeam01`을 사용하고 기존 설정은 유지합니다.\
유지관리 작업일 때만 대상 checkout과 유지관리 목적을 따로 명시합니다.

Kiro CLI와 Claude Code에서도 같은 작업 범위를 사용할 수 있습니다.\
HTML 교재의 복사 버튼은 설명과 코드 펜스를 제외한 프롬프트 본문만 복사합니다.

```ai-prompt
Jeju Atlas의 요청한 미완료 항목을 구현하고 애플리케이션과 AWS 구성을 연결해 주세요.
설계 제안에 그치지 말고 필요한 코드 수정, 빌드와 승인된 배포를 진행하세요.
이미 구현된 기능과 정상 자원은 재사용합니다.
기본 과정 00~04장은 100분과 여유 20분이며 이 전체 앱 작업은 별도 심화 과정입니다.

0. 기본 작업 유형과 시작 원칙

- 기본은 현재 접속한 AWS 계정의 워크숍 참가자 작업입니다.
  사용자가 유지관리라고 명시한 경우에만 지정된 checkout을 유지관리합니다.
  시작할 때 유지관리인지 참가자인지를 다시 묻지 않습니다.
- 사용할 원본 저장소 URL은 다음과 같이 이미 정해져 있습니다.
  https://github.com/whchoi98/jeju-atlas.git
  이 URL이나 아직 만들지 않은 설정 파일의 경로를 사용자에게 다시 요구하지 않습니다.
- ATLAS_REPO, ATLAS_CONFIG, ATLAS_APP, ATLAS_CLI가 없어도 시작합니다.
  이 값들은 아래 준비 과정의 결과입니다. team01.json도 미리 있어야 하는 파일이 아닙니다.
- 각 참가자는 별도의 랩을 사용합니다. 새 설정에는 공통 내부 ID team01과
  프로젝트 AtlasCliTeam01을 사용하고 팀명 선택이나 치환을 요구하지 않습니다.
  기존 이름, 소유 설정과 이미 생성한 자원은 그대로 재사용합니다.
- 현재 작업 폴더는 시작 위치입니다. /home/ec2-user/claude-lab에 소스가
  없으면 그 폴더가 Jeju Atlas라고 가정하지 말고 별도 소스 폴더를 준비합니다.
  이 프롬프트를 작성한 다른 호스트의 절대 경로를 현재 환경에 그대로 요구하지 않습니다.
- 현재 작업 공간의 읽기 전용 조사, 알려진 저장소 clone, 프로젝트 안의
  준비 파일 생성과 사전 구성의 로컬 도구 설치는 이 요청에 포함됩니다.
  Node 24, Python 3.12, 보조 패키지와 npm AgentCore CLI는 사전 구성에서
  먼저 준비하고, 설치 확인 후 구현 단계로 넘어갑니다.
  실제 AWS 자원 변경과 유료 요청은 뒤의 배포 범위와 승인 원칙을 따릅니다.
- 현재 사용하는 Agentic AI 코딩 어시스턴트인 Codex, Kiro CLI 또는 Claude Code를 유지합니다.
  다른 도구를 설치하거나 모델과 인증을 바꾸는 것으로 초기화 오류를 해결하지 않습니다.
  HUD는 참가자가 선택했을 때만 설치하거나 실행합니다.
- 모든 터미널 실행은 올바른 cd로 시작합니다.
  소스 확보 전에는 실제 존재하는 작업 폴더로 이동합니다.
  소스 확보 후 새 셸에서는 확인한 저장소 절대 경로로 이동하고,
  기존 activate.sh를 source한 뒤 필요한 ATLAS_APP 또는 ATLAS_CLI로 다시 이동합니다.
  helper 명령은 ATLAS_REPO, 프로젝트 생성 전에는 ATLAS_CLI_PARENT를 사용합니다.
  경로 이동이나 활성화가 실패하면 그 셸의 후속 명령을 실행하지 않습니다.
- 기본 실행은 경로, 계정, 소유 대상, 스키마 확인과 구현, 빌드, 배포에 필요한 명령입니다.
  배포 계획을 확인해 적용하고, 변경한 대상의 상태를 한 번 조회한 뒤
  승인된 최종 예제 응답 한 번으로 결과물을 확인합니다.
  별도 model_check.py 유료 사전 호출, 로컬 agentcore dev, 새 테스트 묶음,
  npm run check, npm run workshop:check와 전체 브라우저, 한영, 경로, Gateway, Memory
  검증은 기본으로 생략합니다. 실제 오류, 위험한 기능 변경 또는 명시적 요청이
  있을 때만 해당 부분을 좁혀 확인합니다. 생략한 검사를 통과로 기록하지 않습니다.
  필수 패키지 설치, 잠금 버전 적용, 빌드와 CFN 계획, 배포 대상, key_binding 검사는 유지합니다.
  검사 생략을 권한 확인 생략이나 IAM/SCP 변경 허용으로 해석하지 않습니다.

1. 빈 환경에서 소스와 참가자 설정 준비

아래 순서로 직접 조사하고 실행하세요. 가능한 로컬 작업을 마친 뒤
실제 도구 권한이나 AWS 인증 때문에 막힌 항목만 구체적으로 보고합니다.
유지관리라고 명시된 경우에는 A의 소스 확인 후 참가자 초기화 B~D를
건너뛰고 지정 checkout에서 2단계로 진행합니다. E의 참가자 경계도 참가자 작업에 적용합니다.

A. 소스 확보
- 실제 cwd, 읽고 쓸 수 있는 작업 공간, Git과 Python 실행 경로를 확인합니다.
  명시된 ATLAS_REPO나 현재 작업 공간의 기존 소스 후보에서
  workshop/scripts/core.py, package.json과 AGENTS.md가 있는지 확인합니다.
- 정상 원본이 있으면 재사용하고 기존 변경을 보존합니다.
  없으면 현재 쓰기 가능한 작업 공간 아래의 빈 jeju-atlas-workshop 폴더에
  위 저장소를 clone합니다. 같은 이름이 이미 있으면 기존 폴더를 유지하고
  구분되는 새 이름을 정합니다. 사용자에게 없는 소스 경로를 찾아 달라고 하지 않습니다.
- clone한 실제 절대 경로를 ATLAS_REPO로 정하고 다음을 실행합니다.
  python3 -B "$ATLAS_REPO/workshop/scripts/core.py" source --repo "$ATLAS_REPO"
- 기존 후보가 이 검사를 통과하지 못하면 불완전한 폴더를 보존하고
  알려진 저장소의 새 clone으로 준비합니다. 없는 경로를 다시 요청하지 않습니다.
- 읽기용 교재 ZIP, workshop/site, dist/workshop은 원본 소스가 아닙니다.
  core.py가 없으면 가짜 준비기를 만들지 말고 전체 Git 소스를 확보합니다.
  Git 접근이나 모든 쓰기 경로가 실제로 차단된 경우에만 그 오류와 필요한 조치 하나를 묻습니다.

B. 독립 랩의 공통 내부 ID와 로컬 준비
- 같은 작업의 기존 소유 설정이 있으면 확인 후 재사용합니다.
  새 설정은 ATLAS_TEAM=team01, ATLAS_PROJECT=AtlasCliTeam01로 기록합니다.
  임의의 이름을 생성하거나 참가자에게 팀명을 고르도록 요청하지 않습니다.
  공통 ID만으로 소유권을 판단하지 않고 현재 EC2 계정과 소유 바인딩을 함께 확인합니다.
- 현재 대화 도구에 맞게 ATLAS_ASSISTANT를
  codex, kiro, claude 중 하나로 정하고 다른 도구까지 요구하지 않습니다.
- 기존 활성화가 없는 새 환경에서는 다음 준비기를 실행합니다.
  python3 -B "$ATLAS_REPO/workshop/scripts/core.py" prepare \
    --participant team01 --project-name AtlasCliTeam01 \
    --assistant "$ATLAS_ASSISTANT"
- 반환된 activationPath를 실제 경로로 저장하고 그 파일을 source합니다.
  ATLAS_CONFIG와 ATLAS_CLI는 활성화 결과를 사용합니다.
  CLI 프로젝트가 아직 없는 것은 정상입니다. projectPath는 03장에서 만들 대상입니다.
- 기존 소유 활성화 파일이 있으면 검증해 재사용합니다. 소유권이 다른
  폴더를 덮어쓰거나 새 도구를 쓰기 위해 기존 준비 파일을 임의 수정하지 않습니다.
- setup에서 성공한 core.py doctor는 재사용합니다. 결과가 없을 때만 다음으로 한 번 확인합니다.
  python3 "$ATLAS_REPO/workshop/scripts/core.py" doctor --assistant "$ATLAS_ASSISTANT"
  core.py doctor --project와 이를 위한 테스트 파일 작성은 요구하지 않습니다.
  이미 맞는 도구가 있으면 재설치하지 않습니다.
  누락이 있으면 reference/preconfiguration.md와
  설치기의 선행 조건을 확인하고, 원본 저장소에서 bash workshop/scripts/install_core.sh를
  실행하는 사전 구성을 먼저 완료합니다. 시스템 도구와 셸 시작 파일은 유지합니다.
  누락 도구를 설치했다면 같은 activationPath를 다시 source하고 실패했던 준비 항목을 확인합니다.
- 받은 Git 원본에 새 사전 구성 참고 문서가 없어도 아래 명령과
  기존 workshop/requirements.txt로 준비를 계속합니다. 문서 경로를 새 필수 입력으로 요구하지 않습니다.
- 이 전체 완성 작업은 앱 사본을 다루므로 기본 boto3/requests 외에
  PyYAML과 cfn-lint도 사전 구성에 포함합니다. 같은 ATLAS_PYTHON에 다음을 실행합니다.
  uv --no-config pip install --python "$ATLAS_PYTHON" \
    -r "$ATLAS_REPO/workshop/requirements.txt"
  "$ATLAS_PYTHON" -B -c 'import boto3, requests, yaml; print("App helper imports OK")'
  cfn-lint --version
  PyYAML의 import 이름은 yaml입니다. 다른 Python의 pip에 설치하지 않습니다.
  core.py doctor가 통과해도 이 별도 검사를 생략하지 않습니다.

C. 현재 EC2와 AWS 계정으로 설정 생성
- ATLAS_CONFIG가 없다면 사용자에게 파일을 달라고 하지 말고 다음을 실행합니다.
  python3 "$ATLAS_REPO/workshop/scripts/lab.py" init-ec2 --identity-only \
    --participant "$ATLAS_TEAM" --config "$ATLAS_CONFIG"
- 이 명령은 IMDSv2의 현재 EC2 계정, 리전, VPC와 STS를 대조하고
  로컬 참가자 JSON을 만듭니다. 읽기 전용 AWS 조회이며 자원을 만들지 않습니다.
  team01.json에는 조회한 실제 값을 저장합니다.
  예제 계정 ID, 운영 계정과 예제 VPC를 실제 값으로 사용하지 않습니다.
- 같은 설정이 이미 있으면 덮어쓰지 않고 lab.py info --config로 확인합니다.
  기존 설정도 현재 EC2와 STS 바인딩을 대조한 뒤 재사용하며 info 출력만으로
  AWS 확인을 마쳤다고 표시하지 않습니다.
  준비 후 활성화를 다시 불러와 ATLAS_ACCOUNT와 경로를 복원합니다.
- 이 워크숍의 배포 리전은 ap-northeast-2입니다. Codex provider의
  us-west-2 설정을 배포 리전으로 복사하지 않습니다.
  EC2 리전 불일치, IMDS 또는 STS 접근 실패는 실제 제약으로 기록합니다.
  계정이나 profile을 바꿔 우회하지 않고, 독립적인 소스 조사와 로컬 작업은 계속합니다.
- 조회가 불가능할 때만 실패한 명령과 함께 필요한 인증 또는 실행 환경
  조치 하나를 요청합니다. 네 개의 경로와 계정 정보를 한꺼번에 다시 묻지 않습니다.

D. 참가자 앱과 실행 경로 확정
- 이 단계의 lab.py는 모두 패키지를 설치한 "$ATLAS_PYTHON"으로 실행합니다.
  다른 시스템 Python으로 prepare를 호출해 같은 import 오류를 반복하지 않습니다.
- 먼저 같은 ATLAS_PYTHON에서 import yaml이 성공하는지 확인합니다.
  실패하면 B의 전체 앱용 사전 구성을 완료한 뒤 다시 확인하며,
  PyYAML 누락을 앱 생성 차단으로만 남긴 채 이 준비를 건너뛰지 않습니다.
- lab.py info --config의 workspace를 예정 ATLAS_APP으로 먼저 기록합니다.
  경로는 여기서 얻으므로 prepare가 실패해도 사용자에게 다시 묻지 않습니다.
- 설정이 준비되면 원본의 lab.py discover --config로 현재 EC2 VPC의
  기존 네트워크를 읽고, lab.py prepare --config로 참가자 앱 사본을 만듭니다.
  두 명령의 전제와 결과를 확인하며 VPC, NAT나 서브넷을 자동 생성하지 않습니다.
- 기존 앱 사본이 있으면 다시 prepare하지 말고 소유 설정과 바인딩을 검증합니다.
  lab.py info의 workspace를 ATLAS_APP으로 기록합니다.
  ATLAS_CLI는 core.py prepare의 projectPath와 활성화 값을 사용합니다.
  lab.py info의 예전 cliWorkspace 경로로 ATLAS_CLI를 바꾸지 않습니다.
- 이전 prepare가 PyYAML 누락으로 중단됐다면 부분 사본이 남았을 수 있습니다.
  import yaml을 먼저 복구하고, 실제 ATLAS_APP의 파일과
  .local/workshop-binding.json을 확인합니다. binding이 있는 기존 사본은
  소유 검증 후 재사용하고 삭제하거나 덮어쓰지 않습니다.
  이번 실패로 생성됐고 binding이 없는 부분 사본은 같은 참가자 폴더 아래
  겹치지 않는 백업 이름으로 옮겨 모든 파일을 보존합니다.
  그 뒤 같은 ATLAS_CONFIG로 prepare를 다시 실행하고 백업의 사용자 변경을 검토합니다.
  이를 해결하려고 참가자 이름이나 계정을 바꾸거나 binding을 수동 작성하지 않습니다.
- ATLAS_CLI가 아직 없으면 03장의 agentcore create 절차로 생성합니다.
  소스와 계정이 준비되기 전에는 그 경로의 agentcore.json을 필수 입력으로 요구하지 않습니다.
- 네트워크 준비나 조회 권한 때문에 앱 사본 생성이 막히면 그 단계만
  차단으로 남깁니다. 가능한 기본 CLI 구현, 소스 분석과 로컬 검사를 계속합니다.
- 원본, 참가자 이름, config, app, CLI, activation의 실제 경로와 준비 단계를
  원본 아래 workshop/.local/completion-context.json에 기록합니다.
  인증 값은 넣지 않고 재개할 때 기존 소유 바인딩과 대조합니다.
- 도구 호출마다 셸이 새로 열릴 수 있습니다. 후속 Bash 호출은 확인한 저장소로
  cd한 뒤 저장한 절대 activationPath를 source하고 실제 ATLAS_APP으로 다시 이동합니다.
  자식 셸에서 한 번 export한 값을 다음 호출이나 사용자 터미널이
  자동으로 상속한다고 가정하지 않습니다. 생성된 activate.sh 원문은 유지합니다.

E. 준비 후 작업 경계
- 앱 수정은 ATLAS_APP, 기본 CLI Runtime 수정은 ATLAS_CLI에서 진행합니다.
  ATLAS_REPO의 원본 교재와 운영 배포기는 참가자 작업에서 읽기만 합니다.
- 적용되는 루트와 하위 AGENTS.md를 따릅니다. Git 없는 참가자 사본에서는
  상위 운영 저장소의 git status를 자기 변경으로 취급하지 않습니다.
- README, 온보딩, 구현 참조, 아키텍처, AgentCore 설명과 관련 장을 읽고
  아래 구현 계획으로 이어 갑니다. 과거 기록을 현재 성공 결과로 사용하지 않습니다.

2. 구현안과 실행 계획

다음 요청 경로를 실제 코드와 대조하고 부족한 부분을 보완합니다.

웹/PWA → CloudFront + WAF
  ├─ OAC → 비공개 S3: 정적 자산과 사진
  └─ Public ALB: CloudFront 원본 Prefix List와 원본 검증 헤더
       → Private ECS Fargate: Node.js API와 Valhalla
          ├─ S3: 카탈로그와 공식 상세 스냅샷
          ├─ DynamoDB: 요청 조정과 접속 집계
          ├─ Kakao Local API
          └─ IAM → AgentCore Guide Runtime(Strands)
                     ├─ Amazon Bedrock
                     ├─ IAM → HTTP Gateway → Tools Runtime(MCP) → S3
                     └─ AgentCore Memory

- Prefix List는 ALB Security Group의 허용 원본 조건으로 표현합니다.
- 수정이 필요한 구성 요소만 현재 상태, 부족한 점, 수정 파일과 의존성을 짧게 정리합니다.
  아래 구성 요소 목록은 소스와 계약을 읽는 기준이며 전체 검증 실행 목록이 아닙니다.
- 구현안에 요청/스트리밍 흐름, 네트워크와 IAM 경계, 데이터 저장 위치,
  환경 변수와 스택 Outputs, 배포 순서와 복구 방법을 포함합니다.
- 실행 불가, 데이터 손실, 보안 결함과 핵심 사용자 흐름 실패를 우선합니다.
  기존 명세 밖의 신규 기능은 별도 제안으로 남깁니다.
- 작은 단위로 원인 확인, 수정과 필요한 빌드를 진행합니다.
  추가 회귀 검사는 구체적인 실패, 위험한 변경 또는 요청이 있을 때만 해당 부분에 적용합니다.
  필요한 작업 기록 하나에 상태, 근거, 다음 단계를 유지합니다.
  짧은 계획을 공유한 다음 바로 실행 가능한 작업부터 시작합니다.

3. AWS AgentCore CLI

- 저장소가 사용하는 npm @aws/agentcore의 실행 경로, 버전과 도움말을
  확인합니다. 같은 agentcore 이름의 Python Starter Toolkit과 구분합니다.
- Node 24 계열 24.18.1 이상, 기본 Runtime Python 3.12,
  npm @aws/agentcore 0.28.1과 프로젝트별 설치 경로를 사용합니다.
  시스템 도구, 로그인 설정과 다른 프로젝트의 CLI 환경을 보존합니다.
- agentcore.json, aws-targets.json, 실제 소스 경로와 진입점을 확인합니다.
- 프로젝트가 없을 때만 create하고 필요한 구현 뒤 validate, 배포 미리보기,
  deploy, status와 최종 invoke로 진행합니다. dev와 logs는 오류 진단에 필요할 때만 사용합니다.
  옵션은 설치 버전의 도움말로 확인합니다.
- 기본 JejuGuide의 모델은 global.anthropic.claude-sonnet-4-6이며
  Runtime은 CodeZip, PYTHON_3_12, PUBLIC, IAM 호출 인증을 유지합니다.
- Bedrock API 키는 사용자가 자신의 터미널에서 workshop_env.py configure로
  비공개 입력합니다. .env는 ATLAS_CLI_PARENT에 두고 직접 읽거나 source하지 않습니다.
  키 원문을 코드, 프롬프트, 명령 인자, 로그나 배포 ZIP에 넣지 않습니다.
  호출 리전은 입력한 모델 호출 리전을 사용하며 배포 리전으로 대체하지 않습니다.
  입력을 마친 뒤 다음 helper로 생성 로더와 Python 3.12 설정을 적용합니다.
  기존 로더 변경은 보존합니다.
  python3 "$ATLAS_REPO/workshop/scripts/model_config.py" --project "$ATLAS_CLI" --env-file "$ATLAS_CLI_PARENT/.env"
- 기본 Runtime 배포 시에는 04장의 workshop_env.py publish --project "$ATLAS_CLI"
  계획을 확인하고 승인 범위에서 --execute를 적용합니다.
  key_binding의 STS 계정, default 대상, 소유 태그 검사와 단일 SSM 읽기 권한을 유지합니다.
  Runtime 설정에는 SSM ARN만 연결하고 AWS 배포와 Runtime inbound 인증은 IAM을 사용합니다.
  확인된 키 만료나 접근 실패를 해결하며 사전 model-check 보고서는 요구하지 않습니다.
  심화 Guide/Tools에는 이 인증 방식을 자동 적용하지 않습니다.
- app/JejuGuide에서는 uv sync --python 3.12를 사용하고,
  기존 uv.lock이 있으면 --frozen을 사용합니다. CDK의 package-lock.json이 있으면 npm ci를 사용합니다.
  기본 CodeZip 배포는 먼저 mkdir -p "$ATLAS_CLI_PARENT/evidence"를 실행하고
  app/JejuGuide에서 다음으로 잠금 버전을 내보냅니다.
  uv export --python 3.12 --locked --no-dev --no-emit-project --no-hashes --output-file "$ATLAS_CLI_PARENT/evidence/runtime-constraints.txt"
  키 연결 후 ATLAS_CLI에서 agentcore validate --json을 수행하고
  UV_CONSTRAINT="$ATLAS_CLI_PARENT/evidence/runtime-constraints.txt" agentcore deploy --target default --dry-run
  계획의 계정과 소유 대상을 확인한 뒤 같은 제약으로 적용합니다.
  UV_CONSTRAINT="$ATLAS_CLI_PARENT/evidence/runtime-constraints.txt" agentcore deploy --target default
  UV_CONSTRAINT는 빌드 명령에만 전달합니다. Runtime envVars에 넣지 않습니다.
  잠금 불일치가 실제로 발생했을 때만 pyproject 차이를 검토해 lock과 내보내기를 갱신합니다.
- 생성된 CDK, bootstrap, CodeZip과 의존성 포함 범위를 확인합니다.
  CLI와 기존 운영 CloudFormation이 같은 자원을 중복 관리하지 않습니다.
- 00~04장의 참가자 Runtime과 심화 Atlas 스택을 구분합니다.
  실습 모델은 해당 장의 Sonnet 설정을, 운영 모델은 기존 설정을 따릅니다.
  배포 리전과 Bedrock 호출 리전, EC2와 Runtime 역할의 권한을 구분합니다.
  로컬 실행에서도 실제 모델 요청이 발생하는 단계를 식별합니다.

4. AgentCore Guide, Tools, Gateway와 Memory

- agent/guide/의 Strands 구현을 기준으로 한영 응답, 도구 선택,
  스트리밍, 취소, 입력 검증, 타임아웃과 실패 처리를 보완합니다.
- 웹 세션, 대화 ID, Runtime 세션과 Memory actor의 연결을 확인합니다.
- agent/tools/의 find_places, place_detail, route, weather, sun_times,
  layer, festivals, plan_day 계약과 실제 연결된 도구 목록을 대조합니다.
  실제 오류나 계약 변경이 있을 때만 해당 입력을 확인합니다.
- HTTP Gateway의 실제 출력과 target 이름으로 호출 경로를 결정합니다.
  대상별 /<target-name>/invocations와 집계형 /mcp 구성을 구분하고,
  Guide→Gateway와 Gateway→Tools의 IAM 인증을 확인합니다.
- 사실, 선호, 요약과 경험 Memory 전략을 확인합니다.
  actor/session 격리, 단기 이벤트 만료, 장기 기억과 로그 보존을
  코드와 설정에서 확인합니다. 브라우저 삭제와 서버 Memory 삭제 범위를 유지합니다.
  Gateway/Memory 전용 호출과 전체 검증 묶음은 기본으로 실행하지 않습니다.
- Guide와 Tools의 uv.lock, 소유 dependency-artifacts.json, 배포 ZIP의
  버전과 해시를 확인합니다. 의존성 변경은 배포 아티팩트 갱신까지 다룹니다.
  참가자 manifest가 아직 없다면 06장의 소유 의존성 준비 절차를 따릅니다.
- AgentCore의 네트워크 모드와 IAM 인증을 Fargate 네트워크와 각각
  문서화합니다. 다른 프로젝트의 Runtime, Gateway, Memory를 재사용하지 않습니다.

5. CloudFront, Prefix List와 ALB

- 동적 API, 정적 자산, 사진, 고도 타일과 워크숍 경로를 현재 origin과
  연결합니다. 개인별 API와 AI 스트리밍 응답을 공유 캐시에 넣지 않습니다.
- 쿠키, Origin, CSRF, 요청 식별 헤더, CORS와 오류 응답 계약을 보존합니다.
- 기존 Public Subnet의 ALB에 해당 리전의 CloudFront origin-facing
  managed prefix list를 적용합니다. listener 포트와 SG quota를 확인합니다.
- 올바른 원본 검증 헤더가 있을 때만 Target Group으로 전달하고,
  기본 listener 동작은 거부 응답으로 유지합니다.
  ALB 검증 비밀값은 다른 origin, 코드, 로그와 브라우저에 노출하지 않습니다.
- 운영 유지관리에서는 기존 원본 HTTPS와 도메인 설정을 유지합니다.
  참가자는 App 스택의 실제 기본 CloudFront HTTPS URL과 원본 HTTP를
  사용합니다. 실습에 ACM 발급, DNS 등록과 원본 Host/TLS probe를 추가하지 않습니다.
- 실제 접근 오류나 접근 제어 변경이 있을 때만 CloudFront, ALB 또는 헤더의
  해당 조건을 확인합니다. 정상 배포 뒤 별도의 전체 경계 검사를 자동 실행하지 않습니다.

6. ECS Fargate, ECR과 Valhalla

- 기존 Private Subnet, Public IP 없음, awsvpc, IP Target Group과
  ALB에서 앱 포트로만 접근하는 Task Security Group을 확인합니다.
- 기존 NAT 또는 승인된 endpoint를 통한 외부 의존 서비스 접근을 확인합니다.
  Task Execution Role과 애플리케이션 Task Role의 권한을 분리합니다.
- ARM64 Docker 빌드, ECR 불변 이미지와 digest를 확인하고,
  릴리스별 웹 이미지와 라우팅 이미지 조합을 기록합니다.
- 같은 Task의 Node API와 Valhalla 연결, health/readiness, 시작 순서,
  종료와 draining, 배포 실패 rollback 설정을 보존합니다.
- CPU, 메모리, Task 수와 Auto Scaling은 기존 설정과 실측을 기준으로 합니다.
- CloudFront, ALB, Node와 AgentCore 사이의 스트리밍 타임아웃,
  heartbeat와 클라이언트 취소 전파 계약을 보존합니다.
  오류나 관련 변경이 있을 때만 실패한 경로를 재현합니다.

7. S3와 데이터

- 카탈로그/공식 상세, 정적 자산/사진, Agent 코드/의존성과 필요한
  로그의 버킷 또는 prefix, 읽기와 게시 역할을 구분합니다.
- Public Access Block, 암호화, OAC와 Distribution ARN 조건,
  필요한 버전 관리, 수명 주기와 복구 가능한 보존 정책을 코드와 계획에서 확인합니다.
- 읽기 전용 SQLite의 스냅샷 해시, 출처와 시각을 보존하고
  누락 또는 손상 시 readiness와 오류 처리를 확인합니다.
- 샘플, 운영 카탈로그와 필드별 공식 근거를 구분합니다.
  없는 주소, 편의 정보, 사진, 이용시간을 만들어 채우지 않습니다.
- 직접 S3 공개 접근 차단과 CloudFront 경유 접근 정책을 유지합니다.
  실제 403, 자산 누락 또는 정책 변경이 있을 때만 해당 요청을 확인합니다.
- /workshop/의 실제 제공 경로를 확인합니다. S3 업로드만으로
  ECS 이미지의 교재가 갱신됐다고 판단하지 않습니다.

8. DynamoDB

- GuideQuota의 기존 id 키, expiresAt TTL, 요청 ID 중복 방지와
  대화별 실행 조정을 확인합니다. 조건부 쓰기, 트랜잭션, 경합 재시도,
  취소와 재시작 후 정리 계약을 보존합니다. AI 한도가 꺼져도 조정은 유지합니다.
- VisitorPresence의 scope/visitor 키와 expires_at TTL을 확인합니다.
  heartbeat와 최근 활동 시각으로 현재 접속을 계산하고, 최초 접속
  세션의 누적 집계가 여러 탭과 ECS Task에서 중복되지 않게 합니다.
- TTL 삭제가 지연된 레코드의 논리적 만료를 처리합니다.
  페이지네이션, 재시도, 실패 시 동작과 접근 패턴을 확인합니다.
- 온디맨드 용량, 암호화, 삭제 보호, Retain과 필요한 PITR를 확인합니다.
  브라우저 즐겨찾기, 여행 코스와 히스토리의 저장/삭제 범위를 유지합니다.
  동시성, 다중 Task, 삭제 검증은 해당 오류, 위험한 변경 또는 명시적 요청이 있을 때만 수행합니다.

9. IaC, 관측과 배포

- 기존 infra/bootstrap.yaml, data.yaml, static.yaml, agentcore.yaml,
  application.yaml, edge.yaml, operations.yaml과 관련 스크립트를 활용합니다.
- 스택 Outputs와 실제 식별자를 연결하고, 버킷 정책과 Distribution의
  의존성을 포함해 단계별 배포 순서를 정합니다.
- 유지관리에서는 배포 runbook과 deploy-atlas-agent.py, deploy.py를,
  참가자 작업에서는 해당 장의 lab.py wrapper와 자기 사본을 사용합니다.
  원본 운영 배포기를 참가자 계정에서 직접 실행하지 않습니다.
- ALB 상태/오류/지연, ECS 재시작/자원, AgentCore 호출/도구 실패,
  DDB throttling/경합에 필요한 CloudWatch 로그와 알람을 확인합니다.
- 질문/답변 원문과 비밀값의 로그 노출을 방지하면서 추적에 필요한
  모델, 도구, 요청과 오류 메타데이터를 유지합니다.
- 필요한 패키지 설치와 빌드, 아티팩트 생성, 게시, CFN 계획과 변경 세트 검토,
  적용, 상태 확인과 결과 기록을 진행합니다.
  계획에서 현재 계정, VPC, 소유 태그와 실제 스택 대상을 확인하는 절차는 생략하지 않습니다.
  상태는 변경한 대상별로 한 번 조회하고 진행 중이거나 실패한 경우에만 추가 조회합니다.
  진행 중인 배포를 중복 시작하거나 검증을 위해 자원을 다시 만들지 않습니다.
- AWS 변경, 실제 유료 호출, 공개 게시와 Git push는 대화에서 승인된
  범위만 수행합니다. 추가 승인이 필요하면 대상, diff, 검사 결과와
  복구 방법을 먼저 준비한 뒤 요청하며 이미 받은 승인은 다시 묻지 않습니다.
  승인 대기와 무관한 로컬 작업은 계속합니다.
- 13장에서 이미 정리한 자원은 로컬 검증을 위해 자동 재생성하지 않습니다.
  유지하거나 새로 만든 소유 자원은 정리 또는 인계 결정을 기록합니다.

10. 필요한 빌드와 최종 응답, 선택 진단

- 요청한 구현과 배포에 필요한 패키지 설치, 타입, 스키마 확인과 빌드는 실행합니다.
  참가자 앱은 lab.py의 install/build/build-push 등 해당 장의 경로를 사용합니다.
  build-push 내부의 기존 검사는 유지하고 별도 전체 검사 명령으로 중복 실행하지 않습니다.
  빌드 내부 필수 검사와 CFN 계획을 약화하거나 강제로 통과시키지 않습니다.
- shared/ 계약, 장소/GeoJSON 좌표, MapLibre worker, /api/config 세션,
  CSRF, 요청 조정과 카카오 선택 토큰의 일시성을 보존합니다.
- 한영 UI와 탭 간 동기화, 앱, 워크숍의 PWA 캐시 및 업데이트 범위를 보존합니다.
- Node는 .nvmrc에 맞춘 24 계열을 사용합니다. Python 검사 의존성과
  Agent별 환경을 구분하고 실제 PATH 및 ATLAS_PYTHON을 확인합니다.
  기존 .env와 데이터는 보존하고 빌드 후 실제 PUBLIC_ORIGIN으로 실행합니다.
- 기본 CLI 결과를 확인할 때는 ATLAS_CLI에서
  agentcore status --target default --runtime JejuGuide --json으로 상태를 한 번 확인합니다.
  이미 조회했다면 결과를 재사용하고 진행 중이거나 실패한 경우에만 추가 조회합니다.
  READY 확인 뒤 다음 원격 예제를 한 번 호출합니다.
  agentcore invoke "제주 해변 두 곳과 자료의 출처를 알려줘. 영업시간이 확인되는지도 알려줘." --runtime JejuGuide --target default --json
  기본 CLI 결과 확인은 ATLAS_CLI에서 실행합니다. 전체 앱 결과 확인이 이번 목표라면
  실제 참가자 App 스택의 기본 CloudFront HTTPS URL에서 같은 질문 한 번으로 대신합니다.
  두 경로를 모두 자동 실행하지 말고 현재 결과물의 경로 하나만 사용합니다.
  실제 유료 호출은 대화에서 승인된 범위에 한정합니다.
  실제 도구 결과와 응답 완료를 확인하고 성공하면 추가 질문 없이 인계합니다.
- npm run check, npm run workshop:check, lab.py run check/verify,
  별도 모델 사전 호출, 로컬 agentcore dev와 전체 브라우저, 한영, 경로, Gateway, Memory
  검증은 기본으로 생략합니다. 교재에 예시가 있어도 전체 목록을 순서대로 실행하지 않습니다.
- 실제 오류, 인증, 세션, 삭제, 데이터 계약 같은 위험한 변경 또는 명시적 요청이 있을 때만
  12장의 선택 진단으로 해당 구성 요소를 확인합니다.
  실패한 입력이나 관련 테스트 하나를 선택하고, 원인 수정 뒤 그 확인만 다시 수행합니다.
  tests/agent/, UI 브라우저와 도로 경로 확인도 해당 문제가 있을 때만 선택합니다.
  더 넓은 검증은 사용자가 명시한 범위가 있을 때 수행합니다.
- 실제 배포나 예제 응답이 실패하면 해당 로그와 상태부터 확인합니다.
  키 만료는 사용자 터미널의 비공개 갱신과 소유 SSM 게시 절차로 처리하고,
  원인이 바뀌기 전 실패한 모델 호출을 반복하지 않습니다.
  새 키 확인은 새 Runtime 세션을 사용하고 프로젝트를 다시 만들지 않습니다.
- 카카오, 관광공사와 VISIT JEJU 키는 첫 배포 후 선택 입력합니다.
  키 없는 연동은 미연결로 기록하며 기본 완료를 막는 필수 검증으로 추가하지 않습니다.
- 실행한 명령, 종료 상태와 생략, 실패 이유를 짧게 기록합니다.
  보호 장치나 테스트 단언을 약화하지 않습니다.
  빌드, Runtime READY, AWS 배포와 실제 응답 완료는 각각 관찰한 결과만 기록합니다.

11. 문서, 완료 기준과 인계

- 요청한 구현과 필요한 빌드, 승인된 배포 및 최종 예제 응답,
  실행/복구 안내와 자원 인계를 완료 조건으로 삼습니다.
  선택 검사를 생략한 사실은 기록하되 기본 완료 조건에 다시 추가하지 않습니다.
- 유지관리에서는 한국어/영어 README, 관련 문서와 색인,
  CHANGELOG.md의 Unreleased를 갱신합니다. 참가자는 자기 작업 기록에
  변경과 검증을 남기고 필요한 원본 문서 수정은 인계합니다.
  날짜가 있는 과거 배포/검증 기록은 보존합니다.
- 최종 보고는 해결한 문제, AWS 구성과 변경 파일, 실제 검사 결과,
  재현 절차, 배포/실제 호출 여부, 남은 차단과 복구 방법을 담습니다.
- 소스, 빌드, AWS 배포, 실제 예제 응답과 생략한 추가 검증을 구분합니다.
  요청한 기능의 실패, 배포 차단이나 미완료 응답이 있으면 해당 부분을 완료로 선언하지 않습니다.
  필요한 조치와 다음 재개 위치를 남기며 예제 한 번으로 전체 운영 검증을 통과했다고 쓰지 않습니다.

지금 작업 대상과 저장소 상태 조사부터 시작해 주세요.
```
