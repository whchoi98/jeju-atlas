# 공식 AgentCore CLI 가이드 대조

2026-09-11에 다음 공식 자료를 직접 확인했습니다.

- [Amazon AgentCore CLI 공식 저장소](https://github.com/aws/agentcore-cli)
- [AWS Runtime CLI 시작 가이드](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-cli.html)
- [Codex CLI 공식 문서](https://developers.openai.com/codex/cli/)
- [EC2 IMDSv2 사용법](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-service.html)
- [EC2 메타데이터 항목](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-metadata.html)

초기 교재는 설치된 `@aws/agentcore` 0.28.1의 코드·명령 실행·공식 스키마와 공개 소스를 기준으로
검증했습니다. 사용자가 지정한 AWS Runtime 시작 가이드 본문은 이번 보강에서 직접 대조했습니다.
설치 패키지 검증과 해당 웹 문서의 직접 검토를 구분합니다.

## 공식 흐름과 이 워크숍

| 공식 가이드 | 이 실습에서의 적용 |
|---|---|
| 관리형 Harness 또는 코드 기반 Agent 선택 | 기존 Strands 앱을 배포하므로 코드 기반 흐름을 사용합니다. 기본 create 결과를 같은 에이전트로 간주하지 않습니다. |
| CLI 설치와 도구 확인 | 검증 버전 0.28.1을 확인합니다. 이미 있는 Codex는 재설치하지 않습니다. |
| `agentcore create` | 04장에서 빈 scaffold를 관찰하고 소유 계정의 결정론적 Runtime을 준비합니다. |
| 로컬 `dev` | `--skip-deploy`로 로컬 실행과 클라우드 배포를 구분합니다. |
| `agentcore deploy --dry-run` | 지정 target의 계획을 확인한 뒤 실제 deploy를 수행합니다. |
| `agentcore invoke` | 입문 Runtime을 호출합니다. 실제 Atlas Guide는 별도 Gateway·Tools·Memory와 배포합니다. |
| 변경 후 재배포·관측 | 자기 코드·상태·로그를 검증하고 다른 프로젝트 모델/아티팩트를 대체하지 않습니다. |

CLI를 EC2에 설치하는 것과 AgentCore Runtime을 AWS에 배포하는 것은 다른 단계입니다.
이 과정은 CLI 입문 실습에 더해 현재 제주 아틀라스의 전체 AgentCore 구현까지 포함합니다.

## EC2 시작 조건

실행 위치는 **Codex가 설치된 EC2**입니다. 로컬 PC는 다운로드한 교재를 읽습니다.
`init-ec2`는 IMDSv2에서 현재 instance의 계정·리전·primary interface VPC를 읽고 STS 계정과 대조합니다.
`meta-data/iam/security-credentials`나 user-data는 읽지 않습니다.

같은 Name 태그의 다른 VPC를 선택하지 않습니다. Name 태그가 없어도 instance의 VPC ID로
기존 Public/Private Subnet·NAT·CloudFront Prefix List를 검증합니다.
CloudFront/WAF/Lambda@Edge의 us-east-1 배치는 기존 에셋 구조를 유지합니다.

같은 계정·VPC에 참가자 이름의 별도 스택을 만들며 기존 제주 앱과 `agentcore-cli`는 수정하지 않습니다.
검증 리전은 서울입니다. 다른 리전의 EC2에서는 임의의 서울 VPC를 선택하지 않고 중단합니다.

## 별도로 확인할 항목

IAM·CDK bootstrap·모델 접근·DNS/인증서·공공 API 이용 조건과 실제 배포 결과는
참가자 EC2의 환경에서 확인합니다. 최신 문서와 고정 CLI의 옵션이 다르면
`agentcore <명령> --help`와 로컬 검증 결과를 함께 확인합니다.

이번 보강에서는 메타데이터·계정·VPC를 읽기 전용으로 검증했습니다.
새 AWS 스택 배포나 기존 운영 서비스 변경은 수행하지 않았습니다.
