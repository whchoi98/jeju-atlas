# 로컬 PC 교재 다운로드와 EC2 실행

**PC에서는 HTML을 읽고, 실제 명령은 Codex가 설치된 EC2에서 실행합니다.**
PC에 AWS 자격 증명이나 API 키를 복사하지 않습니다.

## 다운로드할 파일

EC2에서 만든 다음 ZIP을 PC로 다운로드합니다.

```text
/home/ec2-user/my-project/jeju-atlas/workshop/.local/downloads/jeju-atlas-workshop-handbook.zip
```

압축을 해제하고 `jeju-atlas-workshop/index.html`을 브라우저에서 엽니다.
ZIP 내부에서 index.html 하나만 직접 열지 않습니다.

```text
jeju-atlas-workshop/
├── START-HERE.txt
├── index.html
├── chapters/          # 순서대로 읽는 HTML
├── reference/         # 자원·진행자·공식 문서 대조
├── assets/            # CSS·JS·SVG·나눔스퀘어·라이선스
└── prompts/           # EC2 AI CLI 공통 Markdown 카드
```

ZIP 대신 폴더를 복사한다면 **`workshop/site/` 전체**를 같은 구조로 가져갑니다.
`index.html`이나 `chapters/`만 다운로드하면 글꼴·스타일·탐색이 빠집니다.
각 챕터에는 Codex·Kiro CLI·Claude Code 공통 카드와 복사 버튼이 있고 원본 `.md`도 다운로드할 수 있습니다.
세 환경의 설치·인증·프로젝트 지침은 [AI CLI 환경](ai-cli-environments.md)에 포함됩니다.

## EC2에서 ZIP 다시 만들기

다음 명령은 EC2의 전체 저장소 루트에서 실행합니다.

```bash
cd /home/ec2-user/my-project/jeju-atlas
npm run workshop:package
```

ZIP 경로·파일 수·SHA-256이 표시됩니다. 같은 위치의 `.zip.sha256`으로 무결성을 확인할 수 있습니다.
실습 설정·DB·배포 상태·키·Runtime ZIP은 교재 묶음에서 제외합니다.

## PC로 전송

사용 중인 원격 파일 도구로 ZIP을 다운로드합니다.
SSH와 SCP를 사용할 수 있다면 **PC 터미널**에서 다음 형태로 실행합니다.

```bash
scp -i /path/to/your-key.pem \
  ec2-user@YOUR_EC2_HOST:/home/ec2-user/my-project/jeju-atlas/workshop/.local/downloads/jeju-atlas-workshop-handbook.zip \
  .
```

키 경로와 호스트는 본인의 접속 정보로 바꿉니다. 개인 키 내용은 업로드하거나 대화에 붙이지 않습니다.
SCP 접속이 없는 환경에서는 진행자가 제공한 원격 파일 다운로드 방법을 사용합니다.

## EC2에 있어야 하는 내용

EC2에는 **제주 아틀라스 전체 Git 저장소**가 필요합니다.
읽기용 `workshop/site`만으로 앱을 배포할 수는 없습니다.
Agent·서버·지도·인프라·라우팅·배포 스크립트와 잠금 파일을 포함한 전체 에셋을 유지합니다.

| 위치 | 역할 |
|---|---|
| PC의 압축 해제한 교재 | 읽기·검색·명령/카드 복사·학습 진도 |
| EC2의 전체 `jeju-atlas` 저장소 | 실습 도구와 원본 에셋 |
| EC2의 `workshop/.local/labs/<참가자>/` | Codex가 수정하고 배포할 독립 공간 |
| EC2의 현재 계정·VPC | 실습 AWS 자원의 대상 |

HTML 학습 진도는 브라우저 기록입니다. 실제 완료는 EC2의 검사와 AWS 상태로 확인합니다.

## AWS 색상

제주 앱과 교재에 AWS 네이비·오렌지 및 접근성 있는 액션 색상을 적용합니다.
나눔스퀘어와 데이터별 의미 색상을 유지하고 위성·지형 원본은 UI 색으로 바꾸지 않습니다.
[Cloudscape 색상 가이드](https://cloudscape.design/foundation/visual-foundation/colors/)를 참고했습니다.
