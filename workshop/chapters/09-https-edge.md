# 09 · 도메인·HTTPS·엣지 구성

사용자→CloudFront와 CloudFront→ALB를 HTTPS로 구성하고 WAF·공유 자산 OAC를 연결합니다.
전체 과정에는 소유 도메인, us-east-1의 viewer 인증서, 서울의 origin 인증서와 DNS 검증이 필요합니다.
CloudFront 기본 주소로 접속된다는 사실만으로 이 장을 완료하지 않습니다.

## 도메인과 viewer 인증서

진행자가 사용을 허용한 **실습 전용 hostname**과 이를 포함하는 발급 완료 ACM 인증서를 준비합니다.
Viewer 인증서는 같은 계정의 `us-east-1`에 있어야 합니다.
`jeju-atlas.whchoi.net`과 `ohmyjeju.whchoi.net`을 실습 도메인으로 쓰지 않습니다.

```bash
cd "$ATLAS_REPO"
# 실제 실습 값으로 설정합니다.
export ATLAS_DOMAIN=atlas-team01.example.com
export ATLAS_VIEWER_CERT='arn:aws:acm:us-east-1:123456789012:certificate/00000000-0000-0000-0000-000000000000'

python3 workshop/scripts/lab.py configure-domain \
  --domain "$ATLAS_DOMAIN" \
  --viewer-certificate "$ATLAS_VIEWER_CERT" \
  --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py doctor --aws --config "$ATLAS_CONFIG"
```

예시 ARN을 실제 인증서처럼 사용하지 않습니다.
신규 인증서가 필요하면 진행자가 ACM DNS 검증을 완료합니다.
DNS에서는 실습 hostname을 내 `CloudFrontUrl`의 호스트로 연결합니다.
인증서 검증 CNAME과 서비스 CNAME은 서로 다른 레코드입니다.

도메인 설정을 앱에 반영합니다. 이 시점의 origin은 아직 초기 HTTP 경로입니다.

```bash
python3 workshop/scripts/lab.py run plan-app --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run apply-app --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run status-app --config "$ATLAS_CONFIG" --execute
```

## 서울 origin 인증서

```bash
python3 workshop/scripts/lab.py run plan-origin --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run apply-origin --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run status-origin --config "$ATLAS_CONFIG" --execute
```

ACM의 DNS 검증 레코드를 확인하고 소유 DNS에 추가합니다.
Certificate가 `ISSUED`, 스택이 완료된 뒤 진행합니다.
us-east-1 인증서를 ALB에 붙이거나 서울 인증서를 viewer 인증서로 사용하지 않습니다.

## WAF와 공유 자산

```bash
python3 workshop/scripts/lab.py run plan-edge --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run apply-edge --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run status-edge --config "$ATLAS_CONFIG" --execute

python3 workshop/scripts/lab.py run plan-static --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run apply-static --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run status-static --config "$ATLAS_CONFIG" --execute
```

엣지 스택은 us-east-1의 WAF와 CloudFront 로그 전송·관측 구성을 포함합니다.
공유 자산 S3는 내 Distribution에만 OAC 읽기를 허용합니다.
새 static 스택이 준비된 뒤 이미지를 다시 빌드하면 자산을 게시하고 manifest를 기록합니다.

```bash
python3 workshop/scripts/lab.py run build-push --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run plan-app --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run apply-app --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run status-app --config "$ATLAS_CONFIG" --execute
```

이 업데이트로 WAF·정적 자산·발급된 origin 인증서를 앱에 연결합니다.

## Lambda@Edge와 독립 HTTPS probe

Lambda@Edge는 ALB 연결 주소를 유지하며 origin 요청의 Host를 실습 hostname으로 맞춥니다.
viewer 요청·정적 자산·미디어·고도 원본에 무조건 붙이는 함수가 아닙니다.

```bash
python3 workshop/scripts/lab.py run plan-origin-routing --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run apply-origin-routing --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run status-origin-routing --config "$ATLAS_CONFIG" --execute

python3 workshop/scripts/lab.py run plan-tls-probe --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run apply-tls-probe --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run status-tls-probe --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run verify-tls --config "$ATLAS_CONFIG" --execute
```

별도 probe의 함수 버전·ALB·hostname이 실제 실습 대상과 일치하고 검증을 통과해야 합니다.
원본 검증 secret 값은 출력하지 않습니다.

```bash
python3 workshop/scripts/lab.py enable-https --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run plan-app --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run apply-app --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run status-app --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run verify-assets --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run verify-terrain --config "$ATLAS_CONFIG" --execute
```

## 확인과 문제 해결

| 확인 | 통과 기준 |
|---|---|
| 사용자 도메인 | DNS·CloudFront Alias·viewer 인증서가 같은 hostname |
| origin | HTTPS-only, ALB 인증서 발급 완료, 해당 Host와 일치 |
| SG | 80/443 수신은 AWS CloudFront Prefix List, task는 ALB SG만 |
| 자산·미디어 | OAC 접근, 직접 S3 공개 접근 차단 |
| 고도 | `/terrarium/` 캐시, ALB origin secret 미전달 |
| probe | 실제 앱과 별도 Distribution, 적용 검증 후 정리 가능 |

CNAME만 만들면 Alias·인증서 설정을 대신하지 못합니다.
403이면 origin/Host/cookie/검증 헤더, 502/504이면 TLS·ALB target·시간 제한을 구분해서 확인합니다.

Codex 카드: [09 · HTTPS·엣지](../prompts/09-https-edge.md)

다음: [10 · 공식 정보 보강](10-enrichment.md)
