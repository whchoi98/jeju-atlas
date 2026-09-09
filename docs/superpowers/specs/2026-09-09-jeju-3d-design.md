# 제주 아틀라스 설계

사용자 요청: 현재 AWS 계정에 CloudFront → Prefix List Security Group → Public ALB → Private ECS Fargate를 구성하고, `cc-on-bedrock-vpc`와 기존 NAT Gateway를 재사용해 실제 3D 제주 지도를 배포한다.

## 지도 경험

MapLibre GL JS와 공개 Terrain Tiles의 실제 고도 데이터를 사용한다. Esri World Imagery를 실제 지형에 입혀 제주 전역을 탐색한다. 위성 영상 촬영 시점은 지역별로 다르며 실시간 영상이라고 표시하지 않는다. 건물 사진측량이나 실시간 교통 데이터는 제공하지 않는다.

한국어 지도 화면에 검색, 명소 분류, 지점 이동, 2D/3D, 고도 배율, 위성/지형 보기, 지도 초기화와 공유를 제공한다. 고도 배율은 화면에 명시하고 1배도 선택할 수 있다. 주요 명소를 순서대로 이동하는 비행 모드를 제공한다. 모바일에서도 지도와 선택한 장소를 함께 볼 수 있다. 외부 데이터 요청 실패 및 WebGL 미지원에 대한 안내를 표시한다. 지도 출처는 화면에 유지한다.

실제 지도가 화면의 중심이다. 차가운 흰색 사이드바, 바다색 `#187c87`, 잉크색 `#17313a`, 해무색 `#d8ebe8`, 현무암색 `#53636a`, 제한적인 화산색 `#c16d43`를 쓴다. 명소 제목과 고도·좌표는 구별해 읽을 수 있게 한다.

## AWS

- 리전: `ap-northeast-2`, 계정: `061525506239`.
- 기존 VPC: `vpc-0dfa5610180dfa628` (`cc-on-bedrock-vpc`).
- ALB Public 서브넷: `subnet-08486a1e618b1991e`, `subnet-0c161777c4031c320`.
- ECS Private 서브넷: `subnet-07b1e65682847dce9`, `subnet-095297380cd45e1eb`.
- 재사용 NAT: `nat-00b8a70dc184a4d0c`, `nat-08379e076e2e6e234`.
- CloudFront 원본 전용 AWS 관리 Prefix List: `pl-22a6434b`.
- 전용 CloudFormation 스택과 ECR 저장소, ECS 클러스터, 서비스, 로그 그룹, ALB, 보안 그룹, CloudFront를 생성한다.
- 기존 네트워크 리소스나 다른 앱은 수정하지 않는다. 신규 VPC, 서브넷, NAT Gateway, EIP는 생성하지 않는다.
- 기본 용량: Linux ARM64, 0.25 vCPU, 512 MiB, Fargate On-Demand 태스크 1개. 두 AZ의 Private 서브넷에 배치 가능하지만 태스크 1개이므로 앱 자체의 이중화를 주장하지 않는다.
- 태스크 Public IP 비활성화. ALB는 CloudFront Prefix List의 TCP 80만 수신하고, 태스크 TCP 8080은 ALB SG만 수신한다.
- ALB는 무작위 원본 검증 헤더가 일치할 때만 전달한다. 기본 리스너 응답은 403이다. 값은 Secrets Manager에 생성하고 소스·이미지·출력·로그에 남기지 않는다.
- 사용자 → CloudFront는 HTTPS, HTTP 요청은 HTTPS로 리다이렉트한다.
- 현재 계정의 Route 53 Hosted Zone은 공개 NS 위임과 일치하지 않는다. 도메인/위임을 수정하지 않고 기본 `cloudfront.net` 주소를 사용한다. CloudFront → ALB는 HTTP이다. 종단 간 TLS로 변경하려면 공개 검증 가능한 도메인과 서울 리전의 신뢰된 ACM 인증서가 필요하다.
- 실행 역할은 전용 ECR 이미지 읽기와 로그 기록 권한만 가진다. 앱 태스크 역할은 AWS 권한이 없다. 컨테이너는 비루트 사용자, 읽기 전용 파일시스템으로 동작한다.
- 이미지 태그는 불변이며 배포는 digest로 고정한다. CloudWatch 로그 보관은 14일이다. 롤링 배포 실패 시 ECS circuit breaker가 롤백한다.

## 비용

2026-09-09 AWS Price List API의 서울 리전 Linux ARM 요금:

- vCPU: $0.03725/vCPU-hour, 메모리: $0.00409/GB-hour.
- 0.25 vCPU + 0.5 GB × 730시간 = $8.29/월.
- ALB $0.0225/hour × 730시간 = $16.43/월.
- ALB 공인 IPv4 최소 2개 × $0.005/hour × 730시간 = $7.30/월.
- 고정성 비용 합계 약 $32.02/월. ALB LCU, CloudFront 요청/전송, ECR, CloudWatch, Secrets Manager, 기존 NAT의 추가 처리량은 별도.
- 소규모 사용 예상 $35–45/월. 사용량에 따라 달라지며 세금·할인·크레딧은 미반영.

## 검증

Node 정적 서버를 실제 HTTP 요청으로 검증한다: 상태 확인, 올바른 MIME, HEAD, 없는 파일, 경로 이탈 차단, 캐시, 메서드 제한.
CloudFormation은 cfn-lint와 정적 보안 검사로 검증하고 배포 전 변경 집합을 확인한다.
브라우저에서 실제 지도 타일·고도 로딩, 명소 이동, 검색, 2D/3D, 모바일 레이아웃 및 콘솔 오류를 확인한다.
배포 후 HTTPS 응답, HTTP 리다이렉트, CloudFront 캐시, ALB Target Health, ECS Private ENI와 NAT 경로, ALB 직접 접근 제한을 확인한다.

## 근거

- AWS: `https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/restrict-access-to-load-balancer.html`
- 고도: `https://registry.opendata.aws/terrain-tiles/`
- MapLibre: `https://maplibre.org/maplibre-gl-js/docs/examples/3d-terrain/`
- 요금: `https://aws.amazon.com/fargate/pricing/`, `https://aws.amazon.com/elasticloadbalancing/pricing/`, `https://aws.amazon.com/vpc/pricing/`
