# AWS 색상·워크숍 PWA 공개 배포

2026-09-11 운영 배포 및 실제 브라우저 검증 기록입니다.

| 항목 | 확인 결과 |
|---|---|
| 릴리스 | `release-20260911T194530Z` |
| 구현 커밋 | `36b9394` |
| 앱 스택 | `Jeju3dApp` · `UPDATE_COMPLETE` |
| ECS | `jeju-3d:13` · PRIMARY `COMPLETED` · desired/running 2/2 |
| CloudFormation 완료 확인 | 2026-09-11 19:53:34 UTC |
| 대표 주소 | `https://jeju-atlas.whchoi.net` |
| CloudFront 주소 | `https://d2mznud99i2mdr.cloudfront.net` |
| 워크숍 | 두 호스트의 `/workshop/` |
| 공개 교재 ZIP | `/workshop/downloads/jeju-atlas-workshop-handbook.zip` |

## 반영 내용

- AWS 네이비·오렌지·액션 블루의 앱과 워크숍, 나눔스퀘어.
- 앱 이용 안내의 워크숍 링크와 한국어/English 전환.
- 14개 챕터·6개 참고 문서·개요, 총 21개 HTML 페이지와 공통 프롬프트 카드.
- Codex·Kiro CLI·Claude Code 환경 및 Amazon AgentCore CLI·실제 Atlas Agent 배포 교재.
- 앱 이미지 안에 허용한 공개 교재만 빌드하고 PC용 ZIP·SHA-256도 게시.
- `/workshop`의 정규 경로 이동, 페이지·서비스워커·ZIP·Markdown 응답 타입과 캐시 정책.

교재 게시가 참가자의 AWS 실습 완료를 뜻하지는 않습니다.
입문 AgentCore CLI Runtime과 참가자별 Atlas Runtime 배포는 각 실습 계정에서 실행하는 절차입니다.

## 두 PWA의 동작

지도 앱은 `/`, 워크숍은 `/workshop/`에서 별도로 설치합니다.
브라우저가 계산한 설치 ID와 서비스워커 scope를 두 공개 호스트에서 확인했습니다.
워크숍 manifest의 `id`를 생략하여 해당 경로의 `start_url`이 설치 ID가 됩니다.
명시적인 상대 `id: "./"`는 origin 기준으로 해석되어 지도 앱과 충돌할 수 있어 사용하지 않습니다.

지도 앱 서비스워커는 워크숍 페이지·자산을 가로채지 않고, 앱 업데이트 상태 조회에서도
워크숍 탭을 제외합니다. 각 서비스워커는 자기 cache prefix만 정리합니다.
지도 앱의 작성 중인 질문·편집 상태 확인 절차는 유지합니다.

워크숍은 전체 공개 교재의 오프라인 저장 완료를 표시합니다.
새 버전은 읽는 사람이 적용하며 다른 탭이 업데이트되어도 현재 문서를 자동으로 다시 열지 않습니다.
설치된 앱의 진도·코스 저장소를 배포 때문에 지우지 않습니다.
다운로드한 `file://` 교재는 서비스워커·manifest 접근 없이 읽습니다.

지도 앱의 저장 코스와 앱 화면은 오프라인으로 볼 수 있습니다.
새 지도 타일·사진·최신 검색·날씨·AI, 외부 참고 링크와 AWS 실습 명령은 연결이 필요합니다.
기존에 설치한 지도 앱에서는 **새 버전 적용** 안내를 사용합니다.

## 검증

| 검사 | 결과 |
|---|---|
| 앱 Node 테스트 | 308 통과, 선택 검사 1개 생략 |
| 앱 Python 테스트 | 190 통과, 선택 검사 2개 생략 |
| CloudFormation / npm audit / 프로덕션 빌드 | 통과 |
| 워크숍 Python / CLI 준비기 / 사이트 검사 | 48 + 9 + 37 = 94 통과 |
| 로컬 실제 브라우저 PWA 검사 | 5개 통과 |
| 대표 도메인 실제 브라우저 PWA 검사 | 5개 통과, 페이지 오류 0 |
| CloudFront 도메인 실제 브라우저 PWA 검사 | 5개 통과, 페이지 오류 0 |
| 기존 운영 인프라 검증 | 91개 통과 |
| 별도 참가자 복사본 | `npm ci` 및 앱·공개 교재 빌드 통과 |
| 게시 이미지의 실제 컨테이너 | 네트워크 차단·읽기 전용·UID 1000 상태에서 HTTP 검증 통과 |
| ECR 보안 검사 | 19:46:35 UTC 검사 완료, 발견된 취약점 0건 |
| 게시 소스 비밀값 검사 | Gitleaks 발견 0건 |

브라우저 검사는 개별 manifest/아이콘, 실제 활성 서비스워커, 캐시 경계,
ZIP 다운로드·해시, 네트워크 차단 상태의 챕터/참고 문서 이동·학습 진도,
지도 앱 오프라인 재열기, 모바일 폭을 확인합니다.
OS의 설치 대화상자 수동 승인이나 모든 모바일 기종을 시험한 것은 아닙니다.
실제 모델을 호출하지 않고 기존 연결·권한과 요청 검증을 확인했습니다.

공개 ZIP은 748,577바이트이며 SHA-256은 다음과 같습니다.

```text
16cd8d8164bb666f32beae87071bb9c002a395271eea6ee9137534f374374684
```

## 변경 범위와 독립성

실제 CloudFormation 파라미터 변경은 `ImageUri`, `Release` 두 개입니다.
태스크 정의·ECS 서비스와 그 참조를 가진 자동 확장 자원이 변경 세트에 포함됐습니다.
기존 VPC·서브넷·NAT·DNS·AgentCore·라우터 이미지는 변경하지 않았습니다.
빌드용 Python을 컨테이너 빌드 단계에만 추가했고 런타임에는 Python/npm이 없습니다.

웹 이미지:

```text
061525506239.dkr.ecr.ap-northeast-2.amazonaws.com/jeju-3d@sha256:d9462ae5cde1c258ad918b8dd668cdd7c7a3be7b484cef006fd78b059cfe0c64
```

이전과 같은 라우터 이미지:

```text
061525506239.dkr.ecr.ap-northeast-2.amazonaws.com/jeju-3d@sha256:bae4b2b84b99d8c55b2c973b1f3a89da505f6d15e1d9b27bf46665b4a7d8b5da
```

참고 저장소 `agentcore-cli`, `jeju-3d`, `jeju-3d-mobility`의 HEAD와 작업 상태가 유지됐습니다.
과거 작업의 영향과 잔존 권한은 별도 [독립성 점검](separation-audit-2026-09-11.md)을 참조합니다.

원본 보고서·계획·스캔·스크린샷은 Git 제외 폴더
`.local/deployment-aws-theme-workshop-20260911/`에 보관합니다.
CloudFront 무효화 `I4VCNTCON5HPZK5GF3CS4B50OL`의 `Completed`도 확인했습니다.

참고: [MDN manifest id](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/id),
[MDN ServiceWorker 등록](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerContainer/register).
