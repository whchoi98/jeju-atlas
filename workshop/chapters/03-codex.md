# 03 · Codex로 실습용 에셋 구성

소스와 테스트를 별도 실습 작업 공간으로 복사합니다.
계정·자원 이름·네트워크 참조는 참가자의 설정으로 구성합니다.
운영 출력·키·기존 카탈로그·기존 의존성 ZIP은 가져오지 않습니다.

## 작업 공간 생성

```bash
cd "$ATLAS_REPO"
python3 workshop/scripts/lab.py prepare --config "$ATLAS_CONFIG"
python3 workshop/scripts/lab.py info --config "$ATLAS_CONFIG"
git -C "$ATLAS_APP" status --short --branch
```

`deployed: false`와 예상 경로를 확인합니다.
기존 폴더에는 덮어쓰지 않습니다. 중간에 종료됐다면 생성된 폴더와 본인 작업을 먼저 확인합니다.
준비된 폴더를 이어 쓰는 경우 `prepare`를 반복하지 않습니다.

자체 Git 저장소와 `AGENTS.md`에는 계정·이름 경계, 원본 보호, 데이터 출처와 검증 규칙이 있습니다.
근거: [공식 AGENTS.md 문서](https://developers.openai.com/codex/guides/agents-md/).

## Codex 실행

```bash
codex -C "$ATLAS_APP" --sandbox workspace-write -a on-request
```

Kiro CLI 또는 Claude Code로 진행할 때는 같은 폴더에서 한 도구만 선택합니다.

```bash
cd "$ATLAS_APP"
kiro-cli chat
```

Claude Code를 선택할 경우:

```bash
cd "$ATLAS_APP"
claude
```

`CLAUDE.md`는 공통 `AGENTS.md`를 가져오며 `.kiro/steering/workshop.md`도 같은 계정·이름 경계를
명시합니다. 인증과 선택적 Claude Code Bedrock 설정은 [AI CLI 환경](../reference/ai-cli-environments.md)을 따릅니다.
개발 도구를 바꿔도 실제 Atlas의 Sol/Astra 모델 설정을 바꾸지 않습니다.

[03 공통 프롬프트 카드](../prompts/03-codex.md)를 선택한 도구에 전달합니다.
첫 요청에서는 파일 구성·계정·자원 이름·현재 단계만 확인하고 배포하지 않습니다.
원본 저장소나 `agentcore-cli`를 추가 쓰기 폴더로 지정하지 않습니다.

각 장에서 목표 → Codex 카드 → 명령/변경 계획 검토 → 단계 실행 → 결과 확인 순서로 진행합니다.
Codex 명령 실행 권한과 AWS 역할 권한은 다릅니다. 필요한 접근 요청의 동작과 이유를 확인하며
제한을 일괄 해제하는 옵션을 사용하지 않습니다.

## dry-run, plan, apply

```bash
cd "$ATLAS_REPO"
python3 workshop/scripts/lab.py run plan-bootstrap --config "$ATLAS_CONFIG"
```

이 명령은 대상과 명령만 표시합니다. `executed: false`, 내 계정·프로젝트·경로를 확인합니다.
실제로 해당 단계를 실행할 때 `--execute`를 붙입니다.
계정 불일치, 작업 공간 바인딩 변경, 운영 SSM 참조가 발견되면 중단합니다.

`plan-*`도 AWS Change Set을 만드는 실제 API 호출입니다.
`apply-*`는 성공한 계획을 적용합니다. 소스·설정이 바뀌면 계획을 새로 확인합니다.

## 비대화형 실행

로컬 검토처럼 범위가 정해진 작업에는 다음 형태를 사용할 수 있습니다.

```bash
codex exec -C "$ATLAS_APP" --sandbox workspace-write - \
  < "$ATLAS_REPO/workshop/prompts/03-codex.md"
```

비대화형 실행을 실제 AWS 변경의 무인 승인으로 확대하지 않습니다.
실패를 숨기지 말고 결과를 확인합니다.
[공식 실행 문서](https://developers.openai.com/codex/noninteractive/)를 참고합니다.

- [ ] 원본과 별도 Git 작업 공간을 확인했습니다.
- [ ] Codex가 내 계정과 자원 접두사를 알고 있습니다.
- [ ] dry-run과 실제 실행, plan과 apply의 차이를 확인했습니다.

다음: [04 · AgentCore CLI](04-agentcore-cli.md)
