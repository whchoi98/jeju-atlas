# 배포 절차

운영 재배포와 새 계정의 실습 배포를 구분합니다.
운영 스크립트는 소유 계정 `061525506239`, 서울 리전과 기존 제주 자원에 맞춰져 있습니다.
다른 계정이나 새 참가자는 [워크숍](../../workshop/README.md)의 이름 공간과 절차를 사용합니다.

## 로컬 실행

[README](../../README.md)의 명령으로 시드 카탈로그를 생성하고 화면을 확인합니다.
AI와 카카오, 실제 경로는 추가 리소스가 필요하며 로컬 시드 실행만으로 제공되지 않습니다.
`.env.example`을 사용할 때 실제 브라우저 origin과 `PUBLIC_ORIGIN`을 맞춥니다.

## 기존 운영 서비스 재배포

AWS 역할, Docker ARM64 빌드, Node 24, boto3/requests와 cfn-lint가 필요합니다.
운영 작업 폴더에는 소유 AgentCore 출력과 승인된 라우팅 이미지 기록이 있어야 합니다.
`.local/`이 없는 새 clone에서 값을 임의로 만들어 채우지 않습니다.
[Agent 배포](../../agent/README.md)와 [라우팅 이미지](../../routing/README.md)의 실제 출력으로 준비합니다.

```bash
python3 scripts/deploy.py network
python3 scripts/deploy.py build-push
python3 scripts/deploy.py plan-app
```

`build-push`는 코드/템플릿/의존성 검사와 빌드 뒤 이미지를 게시합니다.
같은 릴리스의 웹 이미지와 라우팅 이미지 digest를 함께 기록합니다.
정적 자산은 이미지에서 추출해 불변 S3 객체로 게시합니다.

`.local/app-change-set.json`과 실제 변경 세트에서 계정, 리전, 이미지와 변경 자원을 확인합니다.
워크숍만 바꾼 배포라면 네트워크나 AgentCore, 데이터 테이블을 변경할 이유가 없습니다.

```bash
python3 scripts/deploy.py apply-app
python3 scripts/deploy.py status-app
```

스택 완료와 ECS의 실제 정상 태스크 수, ALB target health를 확인합니다.
이전 태스크와 draining 대상이 정리되기 전에는 최종 검증을 완료로 기록하지 않습니다.

```bash
python3 scripts/deploy.py invalidate
python3 scripts/verify.py
```

API와 정적 파일, 설치형 PWA와 공개 교재 ZIP을 확인합니다.
실제 모델 호출이 필요한 변경은 별도 질문으로 종료와 내용까지 확인합니다.
로컬 테스트, AWS 배포와 실제 모델 검증을 구분해 기록합니다.

## 워크숍만 수정한 경우

```bash
npm run workshop:build
npm run workshop:check
npm run workshop:package
```

위 명령은 로컬 교재를 생성합니다. 운영 사이트 반영은 별도 이미지 배포가 필요합니다.
Git에 커밋하거나 푸시하는 행위도 AWS 배포와 별개입니다.
공개 워크숍의 `/workshop/` 범위와 지도 앱 `/`의 캐시를 서로 덮어쓰지 않습니다.

## 배포 중 문제가 생기면

진행 중인 배포를 중복 시작하지 않습니다.
스택 이벤트와 컨테이너/ALB 상태로 원인을 확인하고 [복구 절차](rollback.md)를 따릅니다.
기존 원본 검증 헤더나 세션 키를 로그에 출력하지 않습니다.
