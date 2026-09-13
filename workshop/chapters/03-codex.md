# 03. AI CLI로 제주 가이드 구현

이 장은 35분입니다. AgentCore CLI로 Strands 프로젝트를 생성한 뒤
선택한 AI CLI에 제주 장소 검색 도구와 응답 규칙을 구현하도록 요청합니다.
변경 파일과 테스트는 참가자가 직접 확인합니다.

## 1. AgentCore 프로젝트 생성

```bash
cd "$ATLAS_REPO"
agentcore create \
  --project-name "$ATLAS_PROJECT" \
  --name JejuGuide \
  --framework Strands \
  --model-provider Bedrock \
  --language Python \
  --build CodeZip \
  --memory none \
  --network-mode PUBLIC \
  --output-dir "$ATLAS_CLI_PARENT" \
  --skip-git \
  --skip-python-setup \
  --skip-install \
  --json
```

생성 위치는 `$ATLAS_CLI_PARENT/$ATLAS_PROJECT`입니다.
`--output-dir`은 프로젝트의 부모 폴더를 가리킵니다.
같은 폴더가 있으면 덮어쓰지 말고 이전 작업을 확인합니다.
이 명령은 실제 모델을 사용하는 Strands 코드를 생성합니다.
모델 없는 Warmup 준비기나 `--no-agent` 예제를 기본 과정에 사용하지 않습니다.

## 2. 생성된 파일 확인

```bash
cd "$ATLAS_CLI"
cat agentcore/agentcore.json
cat agentcore/aws-targets.json
```

`JejuGuide` Runtime, `CodeZip`, `app/JejuGuide/`, `PYTHON_3_14`를 확인합니다.
`app/JejuGuide/main.py`에는 AgentCore HTTP 진입점과 Strands Agent가 있습니다.
모델 설정은 `app/JejuGuide/model/load.py`에서 읽습니다.

`aws-targets.json`이 비어 있으면 선택한 AI CLI에 다음 형식으로 작성하도록 요청합니다.
계정 번호에는 02장에서 확인한 실제 값을 사용합니다.

```json
[
  {
    "name": "default",
    "account": "실습 계정 ID",
    "region": "ap-northeast-2"
  }
]
```

예시의 설명 문자열을 계정 번호 대신 저장하지 않습니다.
수정 후 `agentcore validate --json`으로 스키마를 검사합니다.

## 3. 사용할 데이터 복사

```bash
mkdir -p app/JejuGuide/data
cp "$ATLAS_REPO/agent/tools/data/jeju_pois.json" \
  app/JejuGuide/data/jeju_pois.json
```

137개 장소는 실습용 시드입니다. 좌표와 주소를 공식 검증값으로 설명하지 않습니다.
사진, 전화, 영업시간처럼 비어 있는 값을 AI가 채우게 하지 않습니다.
카카오와 공공 API 키는 이번 기본 실습에 필요하지 않습니다.

## 4. AI CLI 실행

현재 `$ATLAS_CLI` 폴더에서 하나만 실행합니다.

```bash
# Codex를 선택한 경우
codex -C "$ATLAS_CLI" --sandbox workspace-write -a on-request
```

```bash
# Kiro CLI를 선택한 경우
cd "$ATLAS_CLI"
kiro-cli chat
```

```bash
# Claude Code를 선택한 경우
cd "$ATLAS_CLI"
claude
```

[구현 프롬프트](../prompts/03-codex.md)를 전달합니다.
코딩 도구가 실제 파일 구조와 데이터를 먼저 읽는지 확인합니다.
첫 응답에서 수정할 파일과 검사 방법을 확인한 뒤 작업을 진행합니다.

이번에 요청할 구현은 다음과 같습니다.

1. 장소 이름과 카테고리로 JSON을 검색하는 `search_jeju_places` 도구
2. 정확히 일치하는 이름을 먼저 반환하고 결과를 최대 5개로 제한하는 처리
3. 도구 결과만 근거로 답하고 시드 자료의 한계를 밝히는 한국어 응답 규칙
4. 진행자가 배정한 Bedrock 모델과 서울 리전 설정
5. 모델을 호출하지 않고 검색과 입력 검증을 확인하는 테스트

테스트에는 정상 검색, 카테고리만 지정한 검색, 결과 없음, 두 조건이 모두 빈 입력과 결과 수 제한을 포함합니다.
실제 모델 호출은 다음 장에서 수행합니다.

## 5. 코드 검토

AI CLI에 변경 파일 목록을 요청하고 VSCode에서 해당 파일을 열어 확인합니다.
반환 필드, 검색 정렬, 입력 길이 제한과 모델 ID를 읽습니다.
AWS 계정과 자원 이름, 프로젝트 밖의 파일이 바뀌지 않았는지도 확인합니다.

예상 수정 위치는 `app/JejuGuide/main.py`, 모델 설정, 검색 도구와 테스트입니다.
생성된 Runtime의 세션별 Agent 구분과 스트리밍 진입점은 유지합니다.
Codex의 모델 설정과 배포된 Bedrock 모델 설정을 서로 바꾸지 않습니다.

프롬프트: [구현과 코드 검토](../prompts/03-codex.md)

다음: [04. 실행과 배포](04-agentcore-cli.md)
