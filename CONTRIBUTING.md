# 기여 안내

작은 변경 단위로 문제와 결과를 설명하고 실제 실행한 검사를 함께 남깁니다.
문서만 바꾸는 작업과 AWS 배포는 별개입니다.

## 작업 순서

1. 저장소를 fork하거나 작업 브랜치를 만듭니다.
2. 관련 코드와 문서를 읽고 수정 범위를 정합니다.
3. 변경에 맞는 검사를 실행합니다.
4. 사용자 동작이 달라지면 README와 CHANGELOG를 갱신합니다.
5. Pull Request에 변경 전후 동작, 검사 결과와 남은 제한을 적습니다.

커밋 메시지는 `feat(workshop): ...`, `fix(guide): ...`, `docs: ...`처럼 목적이 드러나게 작성합니다.
기존 이력을 정리하려고 다른 사람의 커밋을 강제로 덮어쓰지 않습니다.

## 검사

```bash
npm run check
npm run workshop:check
```

전체 앱 검사는 Node 24 계열, Python의 boto3/requests와 cfn-lint를 사용합니다.
실제 브라우저를 준비했다면 `WORKSHOP_BROWSER_TEST=1 npm run workshop:check`도 실행합니다.
필요한 경우 `PLAYWRIGHT_MODULE`과 `CHROME_EXECUTABLE`로 설치 경로를 지정합니다.

문서 변경은 상대 경로와 heading 링크, 명령의 실제 존재, 생성된 HTML을 확인합니다.
코드 변경은 해당 동작의 회귀 검사를 포함합니다. 배포나 실제 모델 호출을 실행하지 않았다면 그렇게 기록합니다.
워크숍 원본은 `workshop/chapters`, `prompts`, `reference`와 `assets`입니다.
`npm run workshop:build`로 `workshop/site`를 다시 만들고 생성물도 함께 제출합니다.

## 작업 경계

운영용 `scripts/deploy.py`는 소유 계정과 리전에 맞춰져 있습니다.
새 계정 실습은 워크숍의 참가자별 폴더와 자원을 사용합니다.
VPC, NAT, 서브넷, 인증서와 다른 프로젝트를 임의로 만들거나 바꾸지 않습니다.

137개 시드를 공식 검증값으로 승격하거나 비어 있는 방문 정보를 만들어 넣지 않습니다.
자료를 추가할 때는 출처, 확인 시각, 이용 조건과 일치 근거를 함께 남깁니다.
API 키, 토큰, `.env`, `.local`, SQLite와 데이터 아카이브는 커밋하지 않습니다.
[보안 안내](SECURITY.md)와 [데이터 품질](docs/data-quality.md)을 따릅니다.

## Pull Request에 적을 내용

변경이 필요한 상황, 변경 후 동작, 실제 검사 명령과 결과를 짧게 적습니다.
UI 변경은 데스크톱과 작은 화면을 확인합니다.
인프라 변경은 대상 계정과 자원, 검토한 변경 세트와 복구 방법을 설명합니다.
검증 실패나 실행하지 못한 부분을 성공으로 표시하지 않습니다.
