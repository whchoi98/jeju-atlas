# 13 · 실습 자원 정리

공유 자원과 실습 소유 자원을 먼저 구분합니다.
워크숍 폴더를 삭제해도 AWS 자원은 사라지지 않습니다.
스택 삭제만으로 보존된 S3·ECR·Memory·로그가 전부 삭제되는 것도 아닙니다.

## CLI 입문 프로젝트

04장에서 사용한 정확한 CLI 프로젝트와 `activate.sh`로 돌아갑니다.
해당 장의 **정의 제거 → 빈 템플릿 확인 → AWS 반영** 또는
검증된 `remove all` 절차를 따릅니다.
CLI의 로컬 정의 제거 메시지를 클라우드 삭제 완료로 해석하지 않습니다.
공유 CDK bootstrap 스택·버킷·역할은 삭제하지 않습니다.

## Atlas 스택 계획

```bash
cd "$ATLAS_REPO"
python3 workshop/scripts/lab.py cleanup --config "$ATLAS_CONFIG"
```

이 호출은 내 접두사의 스택과 Project 태그를 조회하고 계획을 기록합니다.
다른 프로젝트, VPC·서브넷·NAT·공유 viewer 인증서가 목록에 포함되지 않아야 합니다.
`workshop-cleanup-plan.json`의 자원 식별자를 보관합니다.

목록과 참가자 이름을 확인한 후 실행합니다.

```bash
python3 workshop/scripts/lab.py cleanup \
  --config "$ATLAS_CONFIG" \
  --confirm-participant "$ATLAS_TEAM" \
  --execute
```

먼저 내 Schedule을 비활성화하고 내 collector task family의 작업을 종료·대기합니다.
웹 service task나 다른 task family를 이 과정에서 중지하지 않습니다.
그다음 앱/Distribution과 의존하는 운영·데이터·엣지·AgentCore·registry를 순서대로 정리합니다.
CloudFront와 Lambda@Edge 복제 정리는 시간이 걸릴 수 있습니다.
진행 중 작업이나 실패 이벤트가 있으면 원인을 확인하고 재개하며, 다른 스택을 지워 해결하지 않습니다.

재조회할 때도 이전 inventory를 보존하므로 이미 삭제된 스택의 보존 자원 ID를 잃지 않습니다.
실제 삭제는 새로 조회하고 소유 태그를 확인한 스택 목록만 사용합니다.

## 보존 및 수동 자원 확인

| 항목 | 확인 |
|---|---|
| 버전 관리 S3 | data/assets의 모든 객체 버전·delete marker와 버킷 보존 여부 |
| ECR | 실습 이미지와 repository 보존 여부 |
| AgentCore Memory | 실습 Memory의 보존 여부, 본인 데이터 삭제 필요성 |
| Runtime 로그 | CLI·Guide·Tools가 만든 로그 그룹의 보관/삭제 |
| Lambda@Edge 로그 | 여러 리전에 만든 정확한 실습 prefix 로그 그룹 |
| SSM | 실습 prefix의 Visit Jeju/TourAPI 두 SecureString |
| SNS/DNS | 실습 구독과 실습 전용 DNS 레코드 |
| 인증서 | 실습 전용으로 새로 만든 인증서인지, 공유/기존 것인지 |

보존 자료를 지우기로 결정했다면 저장한 inventory의 **정확한 실습 ID**를 사용합니다.
버킷 삭제 전에는 버전과 delete marker까지 확인합니다.
Memory는 이름만 비슷한 기존 운영 Memory를 선택하지 않습니다.
API 키 값 자체를 조회하여 삭제 대상을 확인하지 않습니다.

실습 EC2가 속한 공유 VPC, NAT·IGW·서브넷·라우트·endpoint, 기존 viewer 인증서,
CDK bootstrap, 중앙 추적 설정과 다른 프로젝트의 IAM 정책은 유지합니다.

## 마지막 점검

- [ ] CLI 입문 Runtime과 실제 Atlas 스택을 각각 확인했습니다.
- [ ] 진행 중/실패한 삭제가 없습니다.
- [ ] 보존·수동 자원의 유지 또는 삭제 결정을 기록했습니다.
- [ ] 공유 네트워크·인증서·다른 프로젝트가 유지됩니다.
- [ ] 이후 비용 화면에서 남은 과금 자원을 확인합니다.

보존 자원이 남아 있다면 비용이 완전히 없어졌다고 기록하지 않습니다.
로컬 작업을 보관할 때도 `.local/`·인증·provider 키를 GitHub에 올리지 않습니다.

Codex 카드: [13 · 정리](../prompts/13-cleanup.md)
