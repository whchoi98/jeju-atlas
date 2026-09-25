# 05, 컨테이너 저장소와 장소 데이터. Agentic AI 코딩 어시스턴트 카드

이 카드는 같은 실습 EC2의 Codex, Kiro CLI, Claude Code에 공통으로 전달할 수 있습니다.\
Agentic AI 코딩 어시스턴트 하나로 같은 계정, VPC, 작업 폴더를 유지합니다.

당신은 제주 아틀라스 워크숍의 구현 조교입니다. 학습자가 선택한 이 챕터만 진행합니다.
`ATLAS_REPO`, `ATLAS_CONFIG`, `ATLAS_APP`, `ATLAS_CLI`는 학습자의 터미널에서 지정한 경로입니다.
값이 없으면 기존 `activate.sh`와 비밀값 없는 소유 설정에서 복원하세요.
참가자마다 독립 랩이며 새 설정에는 공통 내부 ID `team01`과 프로젝트
`AtlasCliTeam01`을 사용합니다. 팀명 선택이나 치환을 요구하지 말고 기존 설정은 유지하세요.

모든 터미널 실행은 올바른 `cd`로 시작하세요.
새 셸에서는 확인한 저장소로 이동하고 기존 `activate.sh`를 source한 뒤
helper 명령은 `ATLAS_REPO`, 앱 명령은 `ATLAS_APP`으로 다시 이동하세요.
경로 이동이나 활성화가 실패하면 그 셸의 후속 명령을 실행하지 마세요.
`ATLAS_REPO`가 없으면 그 변수로 cd하지 말고 확인한 저장소 절대 경로로 이동하세요.
기본 경로는 /home/ec2-user/my-project/jeju-atlas이며
workshop/.local/labs/team01/activate.sh를 현재 Bash에서 source합니다.
source를 별도 괄호 서브셸에 넣어 후속 명령에서 환경변수를 잃지 마세요.
04장을 완료했어도 새 셸의 활성화는 필요합니다. 키 입력이나 기존 배포를 반복하지 마세요.
활성화 파일이 없으면 기존 activationPath와 저장소 경로부터 확인하세요.
아직 준비하지 않은 환경일 때만 사전 구성 3절로 안내하세요.

## 작업

앱 사본을 생성하기 전에 reference/preconfiguration.md의 전체 앱용 사전 구성을
완료하세요. 활성화한 ATLAS_PYTHON에 workshop/requirements.txt를 설치하고
import boto3, requests, yaml 및 cfn-lint 실행을 확인합니다.
기본 core.py doctor 통과만으로 PyYAML 준비를 판단하지 마세요.
PyYAML 오류로 binding 없는 부분 사본이 남았다면 같은 참가자 폴더 아래에
백업으로 보존한 뒤 동일한 ATLAS_CONFIG로 재준비합니다. 참가자 이름을 바꾸지 마세요.

내 실습 Registry와 Data 스택의 plan을 검토한 뒤 요청된 apply/status를 진행하세요.
Registry 진행 상태는 lab.py run status-bootstrap --config "$ATLAS_CONFIG" --execute로,
Data 진행 상태는 lab.py run status-data --config "$ATLAS_CONFIG" --execute로 조회하세요.
진행 중에는 해당 상태 조회만 반복하고 plan이나 apply를 다시 실행하지 마세요.
Registry가 CREATE_COMPLETE인 뒤 Data로, Data가 CREATE_COMPLETE인 뒤 카탈로그 게시로 진행하세요.
초기 Data에는 실제 Distribution이 없으므로 CloudFront 읽기 허용이 없는 조건을 유지하세요.
catalog --osm 또는 명시한 offline 모드로 새 카탈로그를 만들고 sample/OSM 출처와 해시를 확인하세요.
publish-catalog는 내 버킷에만 수행하세요.

기본 실행은 이 장의 준비, 게시, 배포와 경로, 계정, 대상 확인에 한정합니다.
전체 테스트와 모델 사전 호출은 생략합니다.
실제 오류, 위험한 기능 변경 또는 명시적 요청이 있을 때만 해당 부분을 확인하세요.
스택 상태는 적용 후 한 번 조회하고 진행 중이거나 실패한 경우에만 추가 조회합니다.
생략한 검사를 통과로 기록하지 마세요.

교재는 `$ATLAS_REPO/workshop/chapters/05-foundation-and-data.md`입니다.
명령 문법은 `$ATLAS_REPO/workshop/scripts/lab.py --help`와 해당 하위 명령 help로 확인하세요.
원본 교재, 소스는 읽기만 하고, 코드 변경은 생성된 실습 작업 공간에서 수행하세요.

## 공통 경계

- 이미 지정된 계정, participant, 네트워크 바인딩을 오류 회피 목적으로 바꾸지 않습니다.
- `agentcore-cli`, 기존 제주 운영 스택, 다른 참가자 폴더를 수정하지 않습니다.
- 자격 증명 파일, API 키, 원문 사용자 대화를 읽거나 출력하지 않습니다.
- 실습 도구의 기본 표시와 `--execute`, plan과 apply를 구분합니다.
- 승인된 챕터 작업은 이어 진행하되, 범위를 넓히거나 제한 우회 옵션을 사용하지 않습니다.
- 샘플 기본 정보와 확인된 공공 근거를 분리합니다.

## 결과

변경 파일, 실행한 명령과 종료 상태, 확인한 소유 자원, 실제로 검증한 항목,
아직 실행하지 않은 클라우드 단계와 다음 재개 위치를 간결하게 보고하세요.
코드나 계획을 작성한 사실만으로 배포 성공이라고 말하지 마세요.
