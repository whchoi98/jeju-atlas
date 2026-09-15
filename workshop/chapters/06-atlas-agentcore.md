# 06. 실제 제주 가이드 AgentCore 배포

이 장은 120분 본 실습 이후에 선택하는 심화 자료입니다.

저장소의 `agent/guide`와 `agent/tools`로 Guide, Tools, Gateway, Memory를 배포합니다.
기본 과정에서 만든 CLI 프로젝트와 별도 소유 스택으로 배포합니다.

## 구성

| 구성 | 역할 |
|---|---|
| Guide | Strands, 한영 질문, 도구 예산, 스트리밍, 구조화 응답 |
| Tools | 장소, 주변 검색, 공식 상세, 날씨, 코스 등의 MCP 도구 |
| Gateway | IAM 인증으로 자기 Tools Runtime에 연결 |
| Memory | facts, preferences, summaries, episodes, 30일 event 만료 |
| 모델 | Global Sonnet 4.6, 주최자가 확인한 Bedrock 호출 리전 |
| 관측 | 메타데이터 중심 OTel, 입력, 답변 내용 capture 비활성화 |

AgentCore는 관리형 `PUBLIC` 네트워크와 IAM 인증을 사용합니다.
ECS를 Private Subnet에 배치하는 설정과 구분합니다.
`JejuAtlasTools`는 각 Gateway 안의 대상 이름이며 같은 Gateway를 공유하는 뜻이 아닙니다.

## 새 의존성 ZIP

커밋된 `uv.lock`에서 ARM64/Python 3.14 wheel을 설치해 새 ZIP을 만듭니다.
운영 버킷의 기존 ZIP은 필요하지 않습니다.

```bash
cd "$ATLAS_REPO"
python3 workshop/scripts/lab.py deps-build --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py deps-publish --config "$ATLAS_CONFIG" --execute
```

build는 로컬 파일, 공개 패키지 다운로드를, publish는 소유 S3만 사용합니다.
소유 태그, 비공개 설정, 버전 관리를 확인하고 새 객체 버전과 SHA-256을
`agent/dependency-artifacts.json`에 기록합니다. 가짜 VersionId를 넣지 않습니다.

ZIP의 Python 실행 파일은 빌드 호스트 가상환경 경로를 사용하지 않도록 정규화합니다.
원래 빌드 환경을 제거한 뒤에도 launcher가 실행되는지 로컬 재배치 검사로 확인합니다.

## 앱 코드 패키징, 배포

```bash
python3 workshop/scripts/lab.py run agent-build --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run agent-publish --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run agent-plan --config "$ATLAS_CONFIG" --execute
```

계획에서 새 Runtime 두 개, Memory, Gateway/target와 각 역할을 확인합니다.
기존 Runtime, Memory 교체나 다른 프로젝트 변경이 있으면 적용하지 않습니다.

```bash
python3 workshop/scripts/lab.py run agent-apply --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run agent-status --config "$ATLAS_CONFIG" --execute
```

스택 완료 후 `agent-status`가 `.local/atlas-agent-outputs.json`을 작성합니다.
두 Runtime ARN, Gateway, Memory, 카탈로그가 내 이름인지 확인하고 다음 단계로 진행합니다.

```bash
python3 workshop/scripts/lab.py run agent-configure-logs --config "$ATLAS_CONFIG" --execute
```

이 명령은 스택 출력, 코드 버킷, 실행 역할을 대조하고 내 Runtime 로그 두 개에만 14일 보관을 적용합니다.
기존 Ohmyjeju나 운영 Atlas 로그를 변경하지 않습니다.

## 모델 설정

```text
ATLAS_MODEL_FAST=global.anthropic.claude-sonnet-4-6
ATLAS_MODEL_DEEP=global.anthropic.claude-sonnet-4-6
ATLAS_MODEL_ROUTING=auto
ATLAS_THINKING=disabled
ATLAS_THINKING_DEEP=disabled
```

배포된 Bedrock 호출용 ID이며 Codex의 모델 설정을 바꾸는 값이 아닙니다.
배포 대상은 서울에 유지하고 `BedrockCallerRegion` 매개변수로 별도
`ATLAS_BEDROCK_REGION`을 Runtime에 전달합니다. 02장의 `lab.py model-region`으로
주최자가 확인한 값을 기록해야 합니다.
계정의 모델 접근, 서비스 가용성, Global CRIS IAM 정책을 확인해야 합니다.
목록 조회만으로 호출 성공을 보장하지 않습니다.
`agent/guide/model/load.py`의 BedrockModel과 모델별 reasoning 설정을 확인합니다.
기존 설정을 확인하지 않고 모델 ID만 교체하지 않습니다.
준비기는 참가자 사본의 모델 기본값과 Runtime 환경만 Sonnet으로 바꿉니다.
운영 원본의 모델과 IAM/SCP는 변경하지 않습니다. 기존 GuideRole의 모델 권한도
자동 확장하지 않으므로 **Sonnet과 선택한 호출 리전에 맞는 Runtime 역할 검토를
주최자가 완료하기 전에는 agent-plan/apply를 진행하지 않습니다.**
EC2에서의 작은 Converse 성공이 Runtime 역할의 권한을 대신하지 않습니다.
현재 기록된 서울 실측은 SCP 명시적 거부이며 성공한 호출 리전은 아직 배정되지 않았습니다.

실제 여행 질문과 도구, Memory 동작은 웹을 연결한 뒤 12장에서 확인합니다.
Runtime READY만으로 여행 답변까지 검증됐다고 기록하지 않습니다.

## 재개

- 의존성 staging이 존재하면 덮어쓰지 않습니다. 로그 확인 후 해당 참가자의 로컬 staging만 정리합니다.
- 게시 후 소스가 바뀌면 build → publish → plan을 다시 수행합니다.
- 생성 실패 후 Memory가 남으면 소유 ID를 확인합니다. 운영 Memory를 지우지 않습니다.
- 모델 접근 오류는 계정, IAM, 모델 접근 문제를 먼저 확인합니다.

- [ ] 두 Runtime과 Gateway, Memory가 완료되었습니다.
- [ ] 웹에 전달할 출력이 내 자원만 가리킵니다.
- [ ] 로그 보관과 내용 capture 설정을 확인했습니다.

AI CLI 프롬프트: [06, 실제 AgentCore](../prompts/06-atlas-agentcore.md)

다음: [07, 실제 경로와 고도](07-routing.md)
