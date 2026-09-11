# 제주 아틀라스 전용 Guide

이 디렉터리는 독립 AgentCore CodeZip 소스입니다. `main.py`가 `atlas_agent`,
`atlas_contracts`, `model`, `memory`, `mcp_client`를 같은 패키지에서 불러옵니다.
참조 저장소나 그 가상환경은 빌드·실행에 필요하지 않습니다. 최초 가져온 소스의
출처와 해시는 상위 provenance 기록을 유지하며, 이후 변경은 이 프로젝트가 소유합니다.

Gateway는 HTTP Runtime target 구성을 유지합니다. 환경변수
`AGENTCORE_GATEWAY_JEJUATLASTOOLS_URL`을 바탕으로
`/JejuAtlasTools/invocations`에 SigV4로 연결하고, 도구 이름에 `jejuatlastools_`를
붙입니다. 집계 `/mcp` 엔드포인트를 도구 목록으로 사용하지 않습니다.

필수 운영 구성은 전용 Gateway URL, `ATLAS_MEMORY_ID`, `AWS_REGION=ap-northeast-2`입니다.
Memory ID가 없으면 Memory manager를 생성하지 않습니다. 모델은
`ATLAS_MODEL_FAST=global.openai.gpt-5.6-sol`,
`ATLAS_MODEL_DEEP=global.openai.gpt-6-astra`이며 기존 intent routing을 유지합니다.
`ATLAS_MODEL_ROUTING`, `ATLAS_THINKING`, `ATLAS_THINKING_DEEP`,
`ATLAS_STRUCTURED_MODE`, `ATLAS_PREFETCH`, `ATLAS_TURN_TIMEOUT_S`,
`ATLAS_TOOL_BUDGET_PER_TOOL`, `ATLAS_TOOL_BUDGET_TOTAL`은 기존 동작을 조절합니다.

`atlas_agent/privacy.py`는 AWS/Strands 내용 수집을 끄고 span/log exporter 직전에도
운영 필드만 남깁니다. 질문·답변·도구 인자·쿠키·토큰·예외 본문은 telemetry에
보내지 않습니다. 도구 이름·상태·시간·토큰 수와 사용자용 SSE 이벤트는 유지합니다.
명시적인 대화 Memory는 telemetry와 별도이며 기존 actor/session 구분과
Kakao 데이터 저장 제한을 보존합니다.

의존성은 이 디렉터리의 `uv.lock`으로 고정합니다. 프로젝트 루트에서
`UV_PROJECT_ENVIRONMENT="$PWD/.local/atlas-guide-venv" uv sync --project agent/guide --frozen --no-dev`
로 별도 환경을 만들 수 있습니다. 이 명령은 패키지만 설치합니다.
`main.py` 실행은 Gateway warming을 시작할 수 있으므로 오프라인 검증에서는
`tests/agent`의 네트워크 차단 fixture를 사용합니다.

전용 리소스·역할·배포 구성은 `infra/agentcore.yaml`,
`scripts/deploy-atlas-agent.py`가 소유합니다. 이 패키지는 기존 프로젝트 ARN이나
자격증명 파일을 기본값으로 사용하지 않습니다.
