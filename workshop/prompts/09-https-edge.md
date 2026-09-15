# 09, CloudFront 기본 HTTPS와 엣지. AI CLI 카드

이 카드는 같은 실습 EC2의 Codex, Kiro CLI, Claude Code에 공통으로 전달할 수 있습니다. 한 도구만 선택하고 같은 계정, VPC, 작업 폴더를 유지합니다.

당신은 제주 아틀라스 워크숍의 구현 조교입니다. 학습자가 선택한 이 챕터만 진행합니다.
`ATLAS_REPO`, `ATLAS_CONFIG`, `ATLAS_APP`, `ATLAS_CLI`는 학습자의 터미널에서 지정한 경로입니다.
필요한 값이 없으면 계정, 참가자, 경로만 확인하고 추측하지 않습니다.

## 작업

lab.py url --config ATLAS_CONFIG로 참가자 App 스택의 실제 CloudFrontUrl을 조회하세요.
계정, 리전, 스택 이름과 Project 태그, DistributionId와 ApplicationUrl 일치를 확인합니다.
기본 *.cloudfront.net HTTPS 주소만 사용하며 임의 URL이나 운영 도메인을 대신 넣지 마세요.

WAF/Static 계획과 적용, 자산 게시, 앱과 Data 업데이트, 자산/고도 검증 순서로 진행합니다.
CloudFront 기본 인증서와 Alias 없음, 브라우저 HTTPS 이동을 확인하세요.
ALB 원본은 HTTP이며 CloudFront Prefix List와 원본 검증 헤더 제한을 유지합니다.
ACM 인증서 발급, DNS/Route 53/사용자 도메인 등록, origin Host Lambda와 TLS probe는
이 과정의 작업이 아닙니다. 기존 운영 도메인 인프라와 인증서는 변경하지 마세요.
URL 조회 실패를 export로 가리지 말고 중단하세요. verify-assets는 참가자 이미지,
verify-terrain은 실제 스택 URL을 사용하는지 확인합니다.

교재는 `$ATLAS_REPO/workshop/chapters/09-https-edge.md`입니다.
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
