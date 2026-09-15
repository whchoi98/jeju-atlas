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

### 기존 서비스의 워크숍 정적 파일만 게시

현재 `/workshop/`는 기존 CloudFront의 ALB origin을 통해 ECS 이미지에서 제공됩니다.
기존 S3 자산 버킷에 파일만 올려도 이 경로가 바뀌지는 않습니다.
정적 교재 게시가 승인된 경우에는 현재 실행 중인 **불변 이미지** 위에
`/app/dist/workshop/`만 교체한 이미지를 만들고 기존 App 스택을 갱신합니다.
새 애플리케이션 인프라, 도메인, 인증서와 보안 정책은 만들거나 바꾸지 않습니다.

1. 워크숍 검사와 공개 교재 빌드를 마치고 소스 커밋을 기록합니다.
2. `publish-workshop.py inspect-live`로 안정된 기존 서비스의 이미지 digest를
   `.local` 기록에 저장합니다.
3. 해당 digest를 `FROM`으로 사용한 임시 Dockerfile에서 기존
   `/app/dist/workshop/`를 지우고 검증한 공개 교재 디렉터리만 복사합니다.
   패키지 설치, 앱 재빌드와 다른 파일 변경은 하지 않습니다.
4. `verify-images`로 루트 파일시스템의 비워크숍 파일과 이미지 실행 설정이
   동일한지 확인합니다. Docker가 컨테이너마다 만드는 hosts/hostname/resolv.conf와
   파일 시각은 비교에서 제외하지만 내용, 모드, 소유자와 링크는 검사합니다.
5. 기존 ECR 저장소에만 새 불변 이미지를 게시하고 digest를 기록합니다.
   Docker 인증은 전용 `.local` 설정 경로와 stdin을 사용합니다.
6. 아래 계획의 변경이 기존 TaskDefinition/Service의 Modify와
   `ImageUri` 매개변수 하나뿐인지 확인한 뒤 적용합니다.

```bash
python3 scripts/publish-workshop.py inspect-live --output "$PUBLICATION/live.json"
python3 scripts/publish-workshop.py verify-images \
  --base-image "$CURRENT_IMAGE" --candidate-image "$CANDIDATE_IMAGE" \
  --output "$PUBLICATION/image-proof.json"
python3 scripts/publish-workshop.py plan \
  --image-uri "$PUBLISHED_IMAGE" --proof "$PUBLICATION/image-proof.json" \
  --output "$PUBLICATION/plan.json"
```

`PUBLICATION`은 새로 만든 `.local` 작업 폴더입니다. 이미지 값은 실제 조회,
빌드와 ECR 게시 결과를 사용합니다. 예시 digest나 다른 계정 값을 넣지 않습니다.
계획은 기존 CloudFormation 템플릿을 재사용하며 다른 매개변수는 이전 값을 보존합니다.
기존 서비스 용량이 스택 설정과 다르면 자동으로 맞추지 않고 중단합니다.

```bash
python3 scripts/publish-workshop.py apply --plan "$PUBLICATION/plan.json"
# 기존 스택과 서비스가 안정된 후
python3 scripts/publish-workshop.py status --plan "$PUBLICATION/plan.json"
python3 scripts/publish-workshop.py invalidate --plan "$PUBLICATION/plan.json"
```

이 경로는 기존 서비스의 태스크 정의 revision과 web 이미지 교체만 수행합니다.
앱의 Release 값, 라우터 이미지와 설정은 유지하고 워크숍 소스 커밋/콘텐츠 해시를 별도 기록합니다.
무효화 범위는 `/workshop`, `/workshop/*`뿐입니다. 공개 HTML, 프롬프트, service worker,
ZIP 및 체크섬을 확인하고 실제 모델 호출은 게시 검증에 포함하지 않습니다.
배포 증거의 계정/ARN, 인증과 참가자 상태는 `.local`에 보관하고 공개 교재에 넣지 않습니다.

## 배포 중 문제가 생기면

진행 중인 배포를 중복 시작하지 않습니다.
스택 이벤트와 컨테이너/ALB 상태로 원인을 확인하고 [복구 절차](rollback.md)를 따릅니다.
기존 원본 검증 헤더나 세션 키를 로그에 출력하지 않습니다.
