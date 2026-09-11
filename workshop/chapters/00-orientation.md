# 00 · 완성할 서비스와 실습 흐름

실제 제주 지형·위성 지도에서 장소를 찾고, 올레길을 둘러보고, 도보·차량 경로를 비교하며
한국어와 영어로 이용 정보를 묻는 제주 아틀라스를 배포합니다.
화면과 Agent 소스는 이미 구현되어 있습니다. 목표는 이 에셋을 이해하고
**내 실습 이름의 AWS 자원으로 연결하는 것**입니다.

## 완성 모습

- MapLibre와 브라우저 GPU가 지도를 그립니다. 고도·위성 자료는 실시간 현장 영상이 아닙니다.
- SQLite 카탈로그의 기본 샘플 정보와 공식 보강 정보를 구분합니다.
- Valhalla와 OSM 그래프로 이동 경로를 계산하고 HGT로 고도 단면을 만듭니다.
- Strands Guide가 전용 Gateway·Tools·Memory와 서울 Global CRIS 모델을 사용합니다.
- CloudFront·WAF·ALB를 Private Fargate 웹·라우터에 연결하고 기존 NAT를 재사용합니다.
- S3·Scheduler 데이터 작업, DynamoDB 호출 한도, CloudWatch·SNS를 구성합니다.

전체 자원은 [자원·기술 매핑](../reference/resources.md)에서 확인합니다.

## 두 AgentCore 배포

| 구분 | CLI 입문 실습 | 실제 제주 가이드 |
|---|---|---|
| 이름 예 | `AtlasCliTeam01_Warmup` | `AtlasLabTeam01_Guide`, `AtlasLabTeam01_Tools` |
| 목적 | CLI 생성·검증·배포·호출 | 실제 여행 질문·도구·기억 처리 |
| 모델 | 호출하지 않는 결정론적 HTTP 응답 | 기존 Sol/Astra 라우팅 |
| 관리 | Amazon AgentCore CLI·CDK | Atlas CloudFormation 배포기 |
| Gateway·Memory | 없음 | 전용 Gateway와 Memory 4개 전략 |

Codex 로그인과 AWS 모델 권한은 별도입니다. Codex는 코드를 작성·검토하고 명령을 실행하는
개발 도구이며, 배포된 제주 Guide의 모델은 AWS Bedrock에서 호출합니다.

## 배포 순서

1. 도구와 AWS 계정·기존 네트워크를 확인합니다.
2. 참가자 작업 공간을 만들고 Codex 작업 범위를 정합니다.
3. CLI 입문 Runtime의 생명주기를 익힙니다.
4. ECR과 비공개 데이터 S3를 만듭니다.
5. 카탈로그와 새 의존성 ZIP을 준비하고 실제 Atlas AgentCore를 배포합니다.
6. 경로 이미지와 웹을 ALB·Fargate·CloudFront에 배포합니다.
7. 실제 Distribution ARN으로 데이터 정책을 연결하고 HTTPS·WAF·공유 자산을 완성합니다.
8. 공식 보강·관측·실사용 검증 후 실습 자원을 정리합니다.

데이터 버킷을 먼저 만들 때는 CloudFront 접근 허용이 없습니다.
존재하지 않는 Distribution ARN이나 운영 Distribution을 임시로 넣지 않습니다.

## 완료 기준

- [ ] CLI Runtime과 실제 Guide/Tools Runtime의 소유 스택을 설명합니다.
- [ ] Fargate에 Public IP가 없고 ALB 수신이 CloudFront Prefix List로 제한됩니다.
- [ ] 웹·라우터가 전용 카탈로그와 전용 AgentCore를 사용합니다.
- [ ] 사용자→CloudFront, CloudFront→ALB HTTPS와 WAF·OAC를 확인합니다.
- [ ] 공식 출처·확인 수준을 표시하고 모르는 정보를 만들지 않습니다.
- [ ] 한영 AI 응답 완료, 도구 표시, Markdown과 추천 질문을 확인합니다.
- [ ] 알람·한도·로그 보관·민감 내용 비기록을 확인합니다.
- [ ] 공유 자원과 보존 자원을 구분해 정리합니다.

HTML의 학습 완료 표시는 읽기 진도입니다. 실제 결과는 챕터의 명령으로 확인합니다.
제작 시 로컬 검사와 참가자 계정의 클라우드 배포 결과도 구분합니다.

Codex가 설치된 EC2의 계정·VPC에서 시작합니다. PC는 다운로드한 HTML을 읽는 용도로 사용합니다.
진행자와 해당 VPC의 기존 네트워크, 참가자 이름, ARM64 빌드 환경, 모델 접근,
도메인·인증서·DNS 권한 및 공공 API 이용 조건을 확인합니다.
[진행자 가이드](../reference/facilitator.md)에 준비 목록이 있습니다.

다음: [01 · 개발 도구와 CLI 설치](01-setup.md)
