# 복구 절차

현재 배포가 안정적인 상태인지와 되돌릴 이미지의 실제 승인 상태를 먼저 확인합니다.
이 문서는 복구 절차이며 운영 롤백을 실행한 기록이 아닙니다.

## 준비

```bash
python3 scripts/rollback-release.py approved
```

출력에 있는 릴리스만 선택합니다. 날짜가 있는 문서의 오래된 digest를 현재 승인값으로 가정하지 않습니다.
웹 이미지와 라우팅 이미지의 조합, 정적 자산의 S3 매니페스트를 함께 확인합니다.
이전 HTML이 참조하는 자산을 삭제한 상태에서 이미지만 바꾸지 않습니다.

## 계획과 적용

`ATLAS_ROLLBACK_RELEASE`에는 실제 승인 목록에서 선택한 릴리스를 지정합니다.

```bash
python3 scripts/rollback-release.py plan --release "$ATLAS_ROLLBACK_RELEASE"
```

현재 릴리스와 대상 릴리스, ECS 용량과 변경 목록을 확인합니다.
자동 확장으로 늘어난 실행 수를 임의로 줄이지 않습니다.

```bash
python3 scripts/rollback-release.py apply --release "$ATLAS_ROLLBACK_RELEASE" --execute
```

완료 후 이미지 digest, 태스크 정상 상태와 공개 기능을 다시 확인합니다.
기존 네트워크와 데이터, Memory를 삭제하는 방법으로 배포 문제를 해결하지 않습니다.
자세한 검증 경계와 이전 실험 기록은 [기존 복구 문서](../rollback.md)에 있습니다.
