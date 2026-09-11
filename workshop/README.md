# 제주 아틀라스 · AgentCore CLI × AI CLI 워크숍

Codex가 설치된 실습 EC2에서 시작하여 **그 EC2의 계정과 VPC**에 참가자 이름으로 배포합니다.
Codex를 기본으로 사용하거나 같은 EC2의 Kiro CLI·Claude Code 환경을 선택할 수 있습니다.
현재 저장소의 3D 지도·제주 장소 데이터·한영 AI 가이드·이동 경로를 사용합니다.
Markdown을 순서대로 읽거나, 생성된 `site/index.html`을 브라우저에서 엽니다.

PC에서는 `workshop/site/` 전체 또는
`workshop/.local/downloads/jeju-atlas-workshop-handbook.zip`을 내려받습니다.
압축 해제 후 `index.html`을 열고 실제 명령은 EC2에서 실행합니다.
[다운로드·실행 위치 안내](reference/offline-start.md) ·
[공식 GitHub/AWS 가이드 대조](reference/official-guide-review.md) ·
[Codex·Kiro CLI·Claude Code 환경](reference/ai-cli-environments.md)

## 시작

```bash
cd /home/ec2-user/my-project/jeju-atlas
npm ci
npm run workshop:build
python3 -m http.server 8008 --directory workshop/site --bind 127.0.0.1
```

브라우저에서 `http://127.0.0.1:8008`을 엽니다. 정적 HTML은 파일로 열어도 동작합니다.
사이트에는 CLI를 실행하거나 AWS 키를 받는 기능이 없습니다. 진도 표시는 브라우저에 저장하는 학습 기록입니다.

설치된 AI CLI는 유지합니다. [01 · 개발 도구](chapters/01-setup.md)에서 버전·인증과 부족한 도구만
확인합니다. `npm run workshop:package`로 PC용 ZIP을 다시 만들 수 있습니다.
전체 과정을 한 번에 짧게 끝내는 실습으로 보지 않습니다. 이미지·경로 그래프 빌드,
인증서 검증과 CloudFront 전파 시간을 포함해 진행자는 이틀의 실습 시간을 준비합니다.

## 챕터

| 순서 | 실습 |
|---|---|
| 00 | [완성할 서비스와 실습 흐름](chapters/00-orientation.md) |
| 01 | [개발 도구와 CLI 설치](chapters/01-setup.md) |
| 02 | [AWS 계정과 기존 네트워크](chapters/02-aws-environment.md) |
| 03 | [Codex로 실습용 에셋 구성](chapters/03-codex.md) |
| 04 | [AgentCore CLI 첫 배포](chapters/04-agentcore-cli.md) |
| 05 | [ECR·S3·장소 카탈로그](chapters/05-foundation-and-data.md) |
| 06 | [실제 Atlas AgentCore 배포](chapters/06-atlas-agentcore.md) |
| 07 | [Valhalla·OSM·고도](chapters/07-routing.md) |
| 08 | [ALB·Private Fargate·3D 웹](chapters/08-web.md) |
| 09 | [도메인·HTTPS·CloudFront·WAF](chapters/09-https-edge.md) |
| 10 | [공식 정보·사진·올레길 보강](chapters/10-enrichment.md) |
| 11 | [관측·보안·운영 제어](chapters/11-operations.md) |
| 12 | [검증·문제 해결·복구](chapters/12-validation.md) |
| 13 | [실습 자원 정리](chapters/13-cleanup.md) |

[자원·기술 매핑](reference/resources.md) · [진행자 가이드](reference/facilitator.md) ·
[카탈로그와 출처](reference/catalog-bootstrap.md)

## 공통 작업 규칙

원본 저장소와 `agentcore-cli`는 수정하지 않습니다. 참가자 작업은
`workshop/.local/labs/<참가자>/app`과 `cli`에 저장합니다.
현재 EC2의 VPC를 IMDSv2로 식별하고 그 VPC의 기존 서브넷·NAT를 재사용합니다.
VPC 이름이나 기본 VPC로 대체하지 않으며 공유 네트워크를 만들거나 삭제하지 않습니다.

`lab.py run`은 기본적으로 실행할 명령과 대상을 표시합니다. 해당 단계의 목적·대상·변경 계획을
확인한 뒤 `--execute`를 붙여 실행합니다. 실행 시 실제 AWS 계정과 준비된 작업 공간의 소유권을
다시 검사합니다. 이 장치는 실수 방지용이며 IAM 최소 권한이나 별도 AWS 계정을 대신하지 않습니다.

CLI 입문 Runtime과 실제 Atlas Guide/Tools는 별도 배포입니다. 입문 Runtime은 모델을 호출하지 않으며,
실제 가이드는 기존 Strands·Global CRIS Sol/Astra·Gateway·Memory 코드를 사용합니다.
Codex의 로그인·과금과 배포된 AWS 모델의 권한·과금은 구분합니다.

풀 구성 완료에는 사용할 수 있는 도메인·인증서, 모델 접근, 공공 API 키와 알림 수신 확인이 필요합니다.
초기 CloudFront 주소로 웹을 확인한 뒤 09~11장의 HTTPS·WAF·공식 보강·운영 구성을 마칩니다.
해당 준비가 없으면 “전체 배포 완료”로 기록하지 않습니다.

## 문서와 검증

`chapters/`가 학습 원본, `prompts/`가 세 AI CLI의 공통 카드, `scripts/`가 실습 도구, `cli/`가 검증된 AgentCore CLI 예제입니다.
`course.json`을 기준으로 `site/`를 생성합니다. `.local/`에는 참가자 설정·데이터·ZIP·클라우드 출력이
들어가며 Git 및 정적 사이트에서 제외합니다. API 키는 프롬프트·문서·설정 JSON에 넣지 않습니다.

```bash
npm run workshop:check
```

제작 시 실행한 로컬 검사와 실제 클라우드 리허설 여부는 `VALIDATION.md`에 기록합니다.
챕터의 기대 결과는 참가자가 자신의 계정에서 실행해 확인하는 기준입니다.
