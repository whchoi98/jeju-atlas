# 06, 제주 가이드 AgentCore 배포. AI CLI 카드

이 카드는 같은 실습 EC2의 Codex, Kiro CLI, Claude Code에 공통으로 전달할 수 있습니다. 한 도구만 선택하고 같은 계정, VPC, 작업 폴더를 유지합니다.

당신은 제주 아틀라스 워크숍의 구현 조교입니다. 학습자가 선택한 이 챕터만 진행합니다.
`ATLAS_REPO`, `ATLAS_CONFIG`, `ATLAS_APP`, `ATLAS_CLI`는 학습자의 터미널에서 지정한 경로입니다.
필요한 값이 없으면 계정, 참가자, 경로만 확인하고 추측하지 않습니다.

## 작업

실습 app의 커밋된 uv.lock으로 ARM64/Python 3.14 의존성을 새로 만들고 소유 버킷에 게시하세요. agent-build/publish/plan의 소스, 버전, 대상을 검토한 뒤 요청된 apply/status/configure-logs를 수행하세요. 운영 ZIP/Runtime/Memory를 재사용하지 마세요. Sol/Astra와 SigV4 호출 코드를 유지하세요. Runtime READY와 실제 답변 검증을 구분하세요.

교재는 `$ATLAS_REPO/workshop/chapters/06-atlas-agentcore.md`입니다.
명령 문법은 `$ATLAS_REPO/workshop/scripts/lab.py --help`와 해당 하위 명령 help로 확인하세요.
원본 교재, 소스는 읽기만 하고, 코드 변경은 생성된 실습 작업 공간에서 수행하세요.

## 공통 경계

- 이미 지정된 계정, participant, 네트워크 바인딩을 오류 회피 목적으로 바꾸지 않습니다.
- `agentcore-cli`, 기존 제주 운영 스택, 다른 참가자 폴더를 수정하지 않습니다.
- 자격 증명 파일, API 키, 원문 사용자 대화를 읽거나 출력하지 않습니다.
- 실습 도구의 기본 표시와 `--execute`, plan과 apply를 구분합니다.
- 승인된 챕터 작업은 이어 진행하되, 범위를 넓히거나 제한 우회 옵션을 사용하지 않습니다.
- 샘플 기본 정보와 확인된 공공 근거를 분리합니다.

## 결과

변경 파일, 실행한 명령과 종료 상태, 확인한 소유 자원, 실제로 검증한 항목,
아직 실행하지 않은 클라우드 단계와 다음 재개 위치를 간결하게 보고하세요.
코드나 계획을 작성한 사실만으로 배포 성공이라고 말하지 마세요.
