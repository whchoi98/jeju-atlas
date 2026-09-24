# 제주 아틀라스 설치 스킬 — 이전 경로

정식 패키지는 [jeju-atlas-install/SKILL.md](jeju-atlas-install/SKILL.md)입니다.
이 파일을 전달받은 에이전트는 정식 진입점을 읽고 요청 범위의 참조만 이어서 읽습니다.
기존 설치·인증·배포·재개·결과 기록 지침은 정식 패키지에 옮겼습니다.

독립 랩의 새 설치는 공통 내부 ID `team01`과 프로젝트 `AtlasCliTeam01`을 자동 사용합니다.\
실제 팀 배정이나 이름 선택은 없으며, 재개할 때는 기존 값을 유지합니다.

Agentic AI 코딩 어시스턴트로 준비·구현·필요한 빌드·배포를 진행합니다.\
기본 확인은 필요한 경로·계정·설정, 배포 상태와 최종 응답 1회입니다.\
HUD와 전체 테스트·브라우저·한영 응답 등 추가 검증은 필요할 때만 선택합니다.
생략한 검사는 통과로 기록하지 않습니다.

- [EC2 준비](jeju-atlas-install/references/prepare.md)
- [모델 인증과 키 전달](jeju-atlas-install/references/model-auth.md)
- [기본 실습과 전체 앱 배포](jeju-atlas-install/references/deploy.md)
- [사용자용 설치 프롬프트와 복사 안내](installation-prompts.md)

다른 EC2에는 이 파일 하나가 아니라 `jeju-atlas-install/` 폴더 전체를 복사합니다.
스킬을 읽는 행위 자체는 AWS 변경·유료 호출·삭제를 승인하지 않습니다.
