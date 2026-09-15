# 03. 제주 가이드 구현

현재 AgentCore 프로젝트를 열고 아래 내용을 전달합니다.
계정 번호와 모델은 02장에서 확인한 값입니다.

```text
AgentCore CLI 0.28.1로 생성한 이 프로젝트에 제주 여행 가이드를 구현해 주세요.
코드는 현재 폴더 안에서만 수정합니다. Runtime 이름은 JejuGuide입니다.
01장의 기본 사전검사를 통과하고 이 참가자 폴더에서 AI CLI를 새로 열었습니다.
현재 경로가 ATLAS_CLI와 다르거나 agentcore/agentcore.json이 없으면 중단하세요.
VPC, NAT Gateway, Subnet, VSCode Server와 선택한 AI CLI는 기존 환경을 사용합니다.

먼저 AGENTS.md, agentcore/agentcore.json, app/JejuGuide/main.py,
app/JejuGuide/model/load.py와 app/JejuGuide/data/jeju_pois.json을 읽어 실제 구조를 확인하세요.
이미 생성한 프로젝트에서 agentcore create를 다시 실행하지 마세요.
변경할 파일과 검사 방법을 짧게 설명한 뒤 다음 구현을 진행하세요.

1. 생성된 Strands Agent와 BedrockAgentCoreApp 진입점을 유지합니다.
   세션별 Agent 구분과 스트리밍 처리를 하나의 전역 대화로 바꾸지 마세요.
2. search_jeju_places(query="", category="", limit=5) 도구를 만듭니다.
   파일 구조를 먼저 읽고 이름과 카테고리로 검색하세요. 정확한 이름 일치를 먼저 반환합니다.
   검색어는 최대 160자, limit는 1~5로 검증합니다. query가 비어도 category가 있으면 검색합니다.
   두 조건이 모두 비면 입력 오류를 반환하고, 없는 장소는 빈 결과로 처리합니다.
   데이터 경로는 실행 디렉터리가 아니라 도구 파일 위치를 기준으로 계산합니다.
3. 반환 항목은 기존 id, 이름, 카테고리, 좌표, 주소와 출처로 제한합니다.
   137건은 실습용 시드입니다. source=sample과 미검증 안내를 포함하세요.
   전화, 사진, 영업시간과 편의 정보를 추측해서 추가하지 마세요.
4. 기본 add_numbers 예제는 제주 도구로 바꾸고 Agent의 tools에 연결합니다.
   응답은 한국어로 작성하고 도구 결과에 있는 장소만 소개합니다.
   확인하지 않은 정보는 미확인으로 밝힙니다.
5. 모델은 global.anthropic.claude-sonnet-4-6으로 고정합니다.
   model_config.py가 준비한 app/JejuGuide/model/load.py를 유지합니다.
   Bedrock 호출은 주최자가 확인한 ATLAS_BEDROCK_REGION을 명시적으로 사용합니다.
   배포 리전 ap-northeast-2나 다른 리전으로 자동 대체하지 마세요.
   기존 사용자 로더를 덮어쓰지 말고 필요한 차이를 먼저 확인하세요.
   Codex, Kiro CLI 또는 Claude Code 자체의 모델 설정은 바꾸지 마세요.
6. agentcore/aws-targets.json의 default 대상에는 확인한 실습 계정과 리전을 넣습니다.
   자격 증명이나 API 키를 파일과 프롬프트에 넣지 마세요.
7. 순수 검색 로직과 테스트를 분리합니다. 정상 검색, 일치 우선순위, 결과 없음,
   카테고리만 지정한 검색, 두 조건이 모두 빈 입력, 잘못된 limit를 검사합니다. 이 테스트에서는 모델이나 AWS를 호출하지 마세요.
8. CLI가 허용하는 설정으로 질문과 답변 원문 telemetry 수집을 끕니다.
   계정 단위 관측 설정과 기존 자원의 권한은 변경하지 마세요.
9. 프로젝트 AGENTS.md에 작업 폴더와 계정 경계를 적습니다.
   Claude Code의 CLAUDE.md에는 @AGENTS.md 참조를 넣고, Kiro CLI는 .kiro/steering/workshop.md에
   같은 경계를 적어 도구를 바꿔도 적용되도록 합니다.
   기존 프로젝트 지침이 있으면 먼저 읽고 필요한 내용만 보완합니다.

이번 요청은 코드 구현과 로컬 테스트까지입니다. AWS 배포는 다음 장에서 진행합니다.
시스템 도구, 원본 저장소와 다른 Claude 프로젝트의 소스나 인증은 수정하지 마세요.
변경 파일, 실제 실행한 검사, 남은 문제와 다음 실행 명령을 알려 주세요.
실행하지 않은 모델 호출이나 배포를 성공으로 보고하지 마세요.
확인된 서울 Converse의 SCP 거부는 실제 실패입니다. 코드 수정이나 doctor 통과가
이를 해결했다고 말하지 마세요. IAM/SCP와 기존 Runtime 역할 정책은 자동 수정하지 마세요.
```
