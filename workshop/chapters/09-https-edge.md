# 09. CloudFront 기본 HTTPS와 엣지

이 장은 120분 본 실습 이후에 선택하는 심화 자료입니다.
08장에서 만든 참가자 Distribution의 **기본 HTTPS 주소**로 앱과 교재를 엽니다.
별도 도메인 등록, Route 53/DNS 레코드 설정과 ACM 인증서 발급은 필요하지 않습니다.

브라우저에서 CloudFront까지는 기본 인증서의 HTTPS를 사용합니다.
CloudFront에서 ALB까지는 템플릿의 HTTP 경로를 사용하며, 기존 CloudFront Prefix List와
원본 검증 헤더 제한을 유지합니다. 이 구성을 운영의 origin TLS 구성과 같은 것으로 설명하지 않습니다.
기존 운영 도메인, 인증서, Lambda@Edge와 DNS 설정은 변경하지 않습니다.

## 참가자 환경과 실제 URL

새 Bash라면 01장의 본인 `activate.sh`를 먼저 source합니다.
심화 앱은 `$ATLAS_REPO/workshop/.local/labs/$ATLAS_TEAM/app`이며 05장에서 준비한 사본입니다.

```bash
python3 "${ATLAS_REPO:?}/workshop/scripts/lab.py" doctor \
  --assistant "${ATLAS_ASSISTANT:?}" --aws --config "${ATLAS_CONFIG:?}"
```

앱 스택의 완료 상태를 확인한 뒤 URL을 읽습니다.

```bash
python3 "${ATLAS_REPO:?}/workshop/scripts/lab.py" run status-app \
  --config "${ATLAS_CONFIG:?}" --execute
```

```bash
ATLAS_URL="$(python3 "${ATLAS_REPO:?}/workshop/scripts/lab.py" url \
  --config "${ATLAS_CONFIG:?}" --plain)" &&
export ATLAS_URL &&
printf '앱: %s\n교재: %s/workshop/\n' "$ATLAS_URL" "$ATLAS_URL"
```

`url`은 현재 참가자의 App 스택을 CloudFormation에서 읽는 조회 명령입니다.
계정, 리전, 스택 이름과 Project 태그를 확인하고 실제 `CloudFrontUrl`,
`ApplicationUrl`, `DistributionId`를 대조합니다. 두 URL은 같은
`https://d....cloudfront.net` 루트 주소여야 합니다.
스택이나 출력이 없으면 중단하며, 예시 주소나 운영 Distribution으로 대신하지 않습니다.
`export ATLAS_URL="$(...)"` 한 줄로 합치면 조회 실패의 종료 상태가 가려질 수 있으므로
위처럼 조회와 export를 구분합니다.

```bash
curl --fail --silent "${ATLAS_URL:?}/healthz"
```

같은 주소의 `/workshop/`에서 교재와 다운로드 ZIP도 확인합니다.
URL 조회 성공만으로 서비스 안정화나 CloudFront 전파 완료가 확인된 것은 아닙니다.

## WAF와 공유 자산 OAC

실제 Distribution이 만들어진 뒤 이 순서로 진행합니다.
각 plan 결과의 계정, Project 이름과 변경 자원을 읽은 후 같은 단계의 apply를 실행합니다.

```bash
(
  set -e
  cd -- "${ATLAS_REPO:?}"
  python3 workshop/scripts/lab.py run plan-edge --config "${ATLAS_CONFIG:?}" --execute
)
```

Edge 계획을 확인한 뒤 적용하고 Static 계획을 만듭니다.

```bash
(
  set -e
  cd -- "${ATLAS_REPO:?}"
  python3 workshop/scripts/lab.py run apply-edge --config "${ATLAS_CONFIG:?}" --execute
  python3 workshop/scripts/lab.py run status-edge --config "$ATLAS_CONFIG" --execute
  python3 workshop/scripts/lab.py run plan-static --config "$ATLAS_CONFIG" --execute
)
```

Static 계획의 비공개 버킷과 소유 Distribution을 확인한 뒤 적용합니다.

```bash
(
  set -e
  cd -- "${ATLAS_REPO:?}"
  python3 workshop/scripts/lab.py run apply-static --config "${ATLAS_CONFIG:?}" --execute
  python3 workshop/scripts/lab.py run status-static --config "$ATLAS_CONFIG" --execute
)
```

Edge 스택은 us-east-1의 WAF와 CloudFront 로그 전송을 포함합니다.
Static 스택의 비공개 S3는 내 Distribution에만 OAC 읽기를 허용합니다.
인증서 스택, origin Host 함수와 독립 TLS probe는 이 과정에서 만들지 않습니다.

## 앱에 WAF와 정적 자산 연결

Static 준비 후 새 이미지를 빌드하면 자산을 게시하고 manifest를 기록합니다.

```bash
(
  set -e
  cd -- "${ATLAS_REPO:?}"
  python3 workshop/scripts/lab.py run build-push --config "${ATLAS_CONFIG:?}" --execute
  python3 workshop/scripts/lab.py run plan-app --config "$ATLAS_CONFIG" --execute
)
```

앱 계획의 `ViewerDomainName`, `ViewerCertificateArn`, `OriginDomainName`은 비어 있고
`OriginTlsEnabled`는 false여야 합니다. 기존 도메인/인증서 매개변수가 남아 있으면
자동으로 제거하지 말고 해당 스택이 이번 참가자의 새 실습인지 확인합니다.
계획이 맞으면 앱을 적용하고 Data 갱신 계획을 확인합니다.

```bash
(
  set -e
  cd -- "${ATLAS_REPO:?}"
  python3 workshop/scripts/lab.py run apply-app --config "${ATLAS_CONFIG:?}" --execute
  python3 workshop/scripts/lab.py run status-app --config "$ATLAS_CONFIG" --execute
  python3 workshop/scripts/lab.py run plan-data --config "$ATLAS_CONFIG" --execute
)
```

Data의 `PublicMediaOrigin`이 실제 App 스택의 기본 CloudFront URL인지 확인한 뒤 적용합니다.

```bash
(
  set -e
  cd -- "${ATLAS_REPO:?}"
  python3 workshop/scripts/lab.py run apply-data --config "${ATLAS_CONFIG:?}" --execute
  python3 workshop/scripts/lab.py run status-data --config "$ATLAS_CONFIG" --execute
)
```

## 확인과 문제 해결

```bash
(
  set -e
  cd -- "${ATLAS_REPO:?}"
  python3 workshop/scripts/lab.py run verify-assets --config "${ATLAS_CONFIG:?}" --execute
  python3 workshop/scripts/lab.py run verify-terrain --config "$ATLAS_CONFIG" --execute
)
```

검사기는 참가자의 이미지 receipt와 실제 스택 URL을 사용합니다.
고정된 운영 CloudFront 주소를 기본값으로 사용하지 않습니다.
전체 서비스와 실제 모델 응답 검증은 12장에서 수행합니다.

| 확인 | 통과 기준 |
|---|---|
| 접속 주소 | 실제 스택의 CloudFrontUrl과 ApplicationUrl이 일치 |
| viewer | 기본 CloudFront 인증서, 사용자 Alias 없음, HTTP에서 HTTPS로 이동 |
| ALB 원본 | HTTP, 원본 검증 헤더와 CloudFront Prefix List 제한 유지 |
| WAF | 이 참가자의 WebACL이 Distribution에 연결됨 |
| 자산과 미디어 | OAC로 접근하며 직접 S3 공개 접근은 차단 |
| 고도 | `/terrarium/` 캐시와 CORS, ALB 원본 secret 미전달 |
| 교재 | 같은 CloudFront 주소의 `/workshop/`, ZIP과 독립 PWA 캐시 |

403은 WAF, Origin/CSRF와 검증 헤더를 구분해 확인합니다.
502/504는 ALB target, 원본 HTTP 연결과 응답 제한을 확인합니다.
인증서 발급이나 DNS 등록으로 우회하지 않습니다.

AI CLI 프롬프트: [09, CloudFront 기본 HTTPS](../prompts/09-https-edge.md)

다음: [10, 공식 정보 보강](10-enrichment.md)
