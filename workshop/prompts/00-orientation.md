# 00. 실습 목표 확인

VSCode Server에서 선택한 AI CLI에 전달합니다. 아직 코드를 바꾸거나 AWS에 배포하지 않습니다.

```text
AgentCore CLI로 제주 여행 에이전트를 만드는 120분 실습을 시작합니다.
VPC, NAT Gateway, Subnet과 VSCode Server는 제공된 환경을 사용합니다.
나는 Codex, Kiro CLI, Claude Code 중 준비된 도구 하나만 사용합니다.
AI CLI가 응답해도 전체 저장소, Node 24, Python 3.14와 AgentCore CLI가
준비됐다고 가정하지 마세요. 01장의 core.py doctor를 통과해야 합니다.
교재 ZIP은 읽기용이며 EC2에서 실행할 전체 소스가 포함되어 있지 않습니다.

실습 110분과 여유 10분 안에 다음 결과를 만듭니다.
- AgentCore CLI가 생성한 Strands 프로젝트
- 제주 장소 JSON을 읽는 검색 도구와 모델 없는 테스트
- 참가자 전용 Runtime 배포와 실제 Bedrock 모델 응답

모델은 Sonnet 4.6입니다. Bedrock은 global.anthropic.claude-sonnet-4-6,
Claude Code 실행은 claude --model claude-sonnet-4-6으로 구분합니다.
Codex 편집 세션의 자체 모델은 바꾸지 마세요.

기존 전체 3D 웹 인프라 배포는 심화 자료입니다.
본 과정의 Runtime에 Gateway나 별도 Memory가 이미 있다고 가정하지 마세요.
우선 역할 분담과 확인할 결과를 짧게 설명해 주세요.
파일 수정, 도구 설치, AWS 변경은 아직 하지 마세요.
기존 Claude 프로젝트를 실습 폴더로 바꾸거나 모델을 호출하지 마세요.
```
