# 기존 도메인 인증서를 사용하는 원본 HTTPS

목표는 CloudFront→ALB 암호화입니다. 별도 원본 DNS는 아직 없지만,
현재 서울 ACM 인증서는 `jeju-atlas.whchoi.net`을 포함합니다.
AWS 문서는 Host를 전달하는 동작에서 원본 인증서가 그 Host와 일치할 수
있음을 명시합니다.

## 구성

- 연결할 서버는 기존 ALB의 AWS DNS 이름입니다. HTTPS 443만 사용합니다.
- ALB에 도달하는 세 동작(기본, 카탈로그 API, 비공개 API)만 Host를 전달합니다.
- 미국 동부의 숫자 버전 Lambda@Edge를 origin-request에 연결하여 Host를
  `jeju-atlas.whchoi.net`으로 고정합니다. 두 viewer 주소 모두 같은 인증서
  이름을 사용합니다.
- 함수는 예상 ALB의 HTTPS 요청인지 검사하며 URI·쿼리·쿠키·Origin·CSRF
  헤더를 그대로 반환합니다. 요청 본문을 함수에 전달하거나 기록하지 않습니다.
- 원본 검증 비밀 헤더와 CloudFront Prefix List 443 제한을 유지합니다.
- 고도·사진 S3 동작에는 함수나 Host 정책을 연결하지 않습니다.
- 기존 공개 원본 DNS 방식도 `OriginTlsMode=dns`로 유지합니다.
  새 방식은 `canonical-host`입니다.

## 배포와 증거

먼저 독립된 임시 CloudFront 배포로 HTTPS 건강 상태·정적 자산·한국어 쿼리·
세션 증명·잘못된 Origin 차단을 확인합니다. 원본 비밀은 CloudFormation의
Secrets Manager 참조로만 전달합니다.

검증을 통과한 숫자 함수 버전만 운영 배포에 연결합니다. 운영의 두 viewer 주소,
HTTPS 원본 설정·인증서·ALB 리스너·SG·본문 전달·SSE를 확인합니다.
실패하면 운영 설정을 바꾸지 않거나 저장한 이전 원본 설정으로 되돌립니다.
검증용 배포는 비활성화 후 삭제합니다. 엣지 함수 버전은 롤백용으로 보존합니다.

함수는 로그에 요청 정보를 쓰지 않습니다. JSON 오류 로그만 사용하며
사용되는 리전의 전용 로그 그룹은 14일 보관합니다.

근거 원문은 `.local/tls-source-docs/`에 보관합니다. 함수 실행 시점의 Host
처리를 문서만으로 추정해 완료하지 않고, 실제 검증 배포의 응답으로 입증합니다.
