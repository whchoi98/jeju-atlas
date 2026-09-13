# PC에서 교재 열기

PC에서는 교재를 읽고 명령은 EC2의 VSCode Server 터미널에서 실행합니다.
PC에 AWS 키나 CLI 로그인 파일을 복사할 필요가 없습니다.

## 내려받을 파일

`workshop/site/` 전체 또는 다음 ZIP을 내려받습니다.

```text
workshop/.local/downloads/jeju-atlas-workshop-handbook.zip
```

ZIP을 압축 해제한 뒤 `jeju-atlas-workshop/index.html`을 엽니다.
`chapters`, `reference`, `assets`, `prompts` 폴더를 함께 유지합니다.
HTML 하나만 복사하면 글꼴, 스타일과 탐색 기능이 빠집니다.

VSCode Server 파일 탐색기에서 ZIP을 내려받거나 진행자가 안내한 파일 전송 방법을 사용합니다.
운영 사이트의 다운로드 파일은 별도 배포가 끝난 버전일 수 있으므로
이번에 생성한 로컬 교재의 제목과 120분 진행표를 확인합니다.

## 시간표와 프롬프트

본 실습은 00~04장의 110분과 여유 시간 10분입니다.
05장 이후는 선택하는 심화 자료입니다.
각 장의 프롬프트 복사 버튼으로 내용을 복사해 선택한 AI CLI에 전달합니다.
Codex, Kiro CLI, Claude Code는 EC2에 설치되어 있습니다.

## 교재 다시 만들기

EC2의 원본 저장소 루트에서 실행합니다.

```bash
cd /home/ec2-user/my-project/jeju-atlas
npm run workshop:build
npm run workshop:package
```

ZIP과 `.zip.sha256` 파일이 같은 폴더에 생성됩니다.
묶음에는 교재와 정적 자산, 프롬프트 카드만 포함됩니다.
참가자 설정, 데이터베이스, 로그인 파일과 배포 상태는 포함하지 않습니다.

## 오프라인 사용

파일로 연 교재는 인터넷 없이 읽을 수 있습니다.
HTTPS 사이트에서는 저장 완료 후 PWA로 설치해 읽을 수도 있습니다.
AWS 명령과 실제 모델 호출은 연결된 EC2 터미널에서 수행해야 합니다.
교재가 오프라인으로 열린다고 모델이나 AWS 실습도 오프라인으로 실행되는 것은 아닙니다.

| 위치 | 역할 |
|---|---|
| PC의 교재 | 읽기, 검색, 명령과 프롬프트 복사 |
| EC2의 원본 저장소 | 실습 스크립트와 데이터 원본 |
| EC2의 참가자 폴더 | AI CLI가 수정하고 AgentCore CLI가 배포할 프로젝트 |

읽음 표시는 브라우저 기록입니다. 실습 완료는 터미널 결과와 AWS 상태로 확인합니다.
