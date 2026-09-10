# 승인된 웹 이미지만 되돌리기

계획·권한 보호 회귀, 실제 이미지의 로컬 복구, 운영 AWS의 검토 가능한
변경 세트까지 확인했습니다. **운영 서비스를 이전 버전으로 되돌리는
실험은 실행하지 않았습니다.**

기존 이미지 `9c3959…`에는 현재 HTML이 참조하는
`/assets/index-DMIDY6QD.js`가 없습니다. 근거는
`.local/mixed-release-assets-audit.json`입니다. **두 이미지의 자산을 공유
S3 경로에 게시하고 검증한 뒤 운영 롤백을 적용해야 합니다.**

## 허용 이미지

저장소는 `061525506239.dkr.ecr.ap-northeast-2.amazonaws.com/jeju-3d`로 고정합니다.
태그가 아니라 아래 digest URI를 배포하며, 계획과 적용 직전에 ECR의 태그·digest
일치 여부를 다시 확인합니다. 허용 목록 추가는 코드 검토가 필요합니다.

| 릴리스 | 승인 digest |
|---|---|
| `release-20260910T202150Z` | `sha256:18fb0b1fa57b1ee5552eec9e9db34717c23319c28fc6e6e78bbfc45a939a54b9` |
| `release-20260910T180902Z` | `sha256:0ef30ebd2d916a26fcc53eeee47a92c5483c55aef408c836e5a49c25880f671b` |
| `release-20260910T173044Z` | `sha256:9c3959d38054d2d6c3715439b897ae1204f4059a8f4724409399d32ab46b35b7` |

목록 조회는 AWS에 접속하지 않습니다.

```bash
python3 scripts/rollback-release.py approved
```

## 공유 자산 부트스트랩

`infra/static.yaml`은 서울의 `Jeju3dStatic`용입니다. 비공개 버킷
`jeju-3d-assets-061525506239-ap-northeast-2`와 OAC를 만들며 버전 관리,
삭제·교체 시 보존을 사용합니다. 자동 만료는 없습니다. 운영 CloudFront의
`DistributionArn`으로 묶인 `assets/*` 읽기만 허용하고 HTTP는 거절합니다.
`releases/*` 매니페스트는 CloudFront에 공개하지 않습니다.

출력은 `AssetsBucketName`, `AssetsBucketDomainName`, `AssetsOriginAccessControlId`입니다.
릴리스 담당자가 스택을 배포한 뒤 다음 두 이미지를 함께 준비·게시합니다.

```bash
assets_bucket=jeju-3d-assets-061525506239-ap-northeast-2
current_image=061525506239.dkr.ecr.ap-northeast-2.amazonaws.com/jeju-3d@sha256:0ef30ebd2d916a26fcc53eeee47a92c5483c55aef408c836e5a49c25880f671b
previous_image=061525506239.dkr.ecr.ap-northeast-2.amazonaws.com/jeju-3d@sha256:9c3959d38054d2d6c3715439b897ae1204f4059a8f4724409399d32ab46b35b7
python3 scripts/publish-assets.py --bucket "$assets_bucket" \
  --image-uri "$current_image" --image-uri "$previous_image"
# 로컬 준비 결과 검토 후 S3 게시
python3 scripts/publish-assets.py --bucket "$assets_bucket" \
  --image-uri "$current_image" --image-uri "$previous_image" --execute
```

게시기는 로컬 Docker의 정확한 RepoDigest를 확인하고 컨테이너를 시작하지 않은
상태에서 `/app/dist/assets`를 임시 디렉터리로 추출합니다. 호스트 `dist`는
읽지 않습니다. 네트워크는 `none`이고 자격 증명·볼륨을 컨테이너에 주입하지 않습니다.
`--pull=never`이므로 두 이미지가 먼저 로컬에 있어야 합니다.
한 실행은 최대 이미지 8개·파일 1,024개·파일당 32 MiB·전체 128 MiB로 제한합니다.
추출은 이미지당 60초 제한이며 링크·위험 경로·알 수 없는 파일 형식은 거절합니다.

전체 자산을 확인한 뒤 `IfNoneMatch: *`로만 업로드합니다. 같은 이름의 기존
객체는 SHA-256 메타데이터·S3 체크섬·크기·MIME·캐시 헤더가 모두 같아야 재사용합니다.
다르면 덮어쓰지 않고 중단합니다. JS·CSS·글꼴 등 MIME을 지정하고 자산은
`public, max-age=31536000, immutable`로 제공합니다.

자산 전체가 게시된 뒤에만 `releases/<sha256 접두사 없는 digest>.json`을 기록합니다.
매니페스트는 `{version: 1, imageUri, assetsSHA: {"assets/파일명": "파일 SHA-256"}}`
형식이며 재실행해도 같은 내용입니다. 두 매니페스트의 `imageUri` 일치와 각
자산의 존재를 확인한 뒤 앱의 `/assets/*` S3 경로를 활성화합니다.
이 경로에는 ALB Host 함수·세션·쿼리를 전달하지 않습니다.

이후 새 이미지 빌드에서는 `--image-uri` 하나로 해당 이미지 자산을 추가할 수
있습니다. 이전 객체와 매니페스트는 삭제하지 않습니다. 공유 경로 배포 후에는
스택 시점과 템플릿이 바뀌므로 **롤백 계획을 새로 생성**합니다.

2026-09-10 두 기존 이미지의 **19개·2,343,150바이트** 자산을 게시했고
새 서버 이미지의 manifest도 추가했습니다. 세 버전의 합집합 19개가 실제
CloudFront에서 모두 200·정확한 SHA-256으로 응답했습니다.
근거는 `.local/shared-assets-verification.json`입니다.
롤백 계획과 적용은 대상 이미지의 공유 자산 manifest도 확인합니다.

## 계획과 적용

```bash
rollback_release=release-20260910T173044Z
python3 scripts/rollback-release.py plan --release "$rollback_release"
cat .local/rollback-change-set.json
# REVIEWABLE 계획의 대상 이미지·기준 상태·변경 목록을 검토한 뒤에만 실행
python3 scripts/rollback-release.py apply --release "$rollback_release" --execute
```

`plan`은 `Jeju3dApp`에 UPDATE 변경 세트를 만들지만 실행하지 않습니다.
현재 배포된 템플릿을 `UsePreviousTemplate`으로 사용하고, 모든 매개변수에
`UsePreviousValue`를 지정합니다. 예외는 승인된 `ImageUri`·`Release`와
**실제 ECS desired count를 그대로 넣는 `DesiredCount`**뿐입니다.
예를 들어 자동 확장으로 3개나 4개가 실행 중이면 2개로 되돌리지 않습니다.
실제 값이 현재 최소·최대 범위를 벗어나면 계획을 거절합니다.

지역 파일의 예전 템플릿·배포 설정을 읽어 되돌리지 않습니다. 도메인·TLS·WAF·
역할·할당량·네트워크·데이터 설정과 기존 템플릿은 유지합니다.
`app-change-set.json`, `image.json`, 소스 파일도 수정하지 않습니다.

계획의 `base`에는 스택 ID·`stackLastUpdatedTime`, `currentImage`·릴리스,
태스크 정의·배포 ID, 실제 용량, 템플릿·매개변수 지문을 저장합니다.
적용 직전에 이 상태를 다시 비교하므로 배포·자동 확장·설정 변경이 있으면
**새 계획부터 작성**해야 합니다. 보호 매개변수의 값은 보고서에 복사하지 않습니다.

허용되는 변경은 다음뿐입니다.

- `TaskDefinition`: 컨테이너 정의 변경에 따른 태스크 리비전 교체.
- `Service`: 태스크 정의와 보존할 desired count 변경. 서비스 교체는 금지.
- `ScalableTarget`, `CpuScalingPolicy`, `MemoryScalingPolicy`: 템플릿과 보호
  매개변수가 같은 상태에서 생기는 동적 리소스 참조 변경만 허용.
  최소·최대 용량이나 정책 목표 변경은 금지.

추가·삭제·가져오기, 다른 리소스, 설명되지 않은 변경은 거절합니다.
변경 세트의 모든 페이지와 실제 템플릿·매개변수를 적용 전에 다시 검사합니다.
다른 대상 릴리스나 이미 적용한 계획으로 `apply`를 반복할 수 없습니다.

## 적용 후 확인과 복구

`EXECUTING`은 실행 요청이 접수됐다는 뜻이며 배포 완료가 아닙니다.

```bash
python3 scripts/deploy.py status-app
aws ecs wait services-stable --region ap-northeast-2 --cluster jeju-3d --services jeju-3d
aws ecs describe-services --region ap-northeast-2 --cluster jeju-3d --services jeju-3d \
  --query 'services[0].{desired:desiredCount,running:runningCount,pending:pendingCount,taskDefinition:taskDefinition}'
curl --fail --silent --show-error https://jeju-atlas.whchoi.net/healthz
curl --fail --silent --show-error https://jeju-atlas.whchoi.net/readyz
```

스택 완료, 실제 태스크 이미지와 계획의 digest 일치, `/healthz`의 대상 릴리스,
`/readyz`의 200 응답, 두 AZ 정상 타깃을 확인합니다. 두 viewer 주소의 정적 화면·
카탈로그와 기존 TLS·WAF·한도 설정도 확인한 뒤 별도 운영 증거를 남깁니다.
`verify.py`는 `.local/image.json`을 기대 이미지로 사용하므로, 전체 검증은
릴리스 담당자가 원본 기록을 보존하고 대상과 일치하는 검증 입력을 준비해 수행합니다.

`EXECUTION_UNKNOWN`이면 응답 손실 후 실행됐을 가능성이 있습니다.
변경 세트와 스택 상태를 먼저 확인하고 같은 적용 요청을 반복하지 않습니다.
이전 이미지로 다시 복구할 때도 스택 안정화 후 위 허용 목록의 다른 릴리스로
새 계획을 만듭니다. 이 도구는 보안 설정이나 데이터 복원을 수행하지 않습니다.

## 실제 이미지의 로컬 복구

먼저 가짜 AWS 상태에 대한 계획·적용 거절과 두 승인 이미지 경로를 검사합니다.

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p rollback_release_test.py -v
```

현재→이전→현재의 세 단계를 같은 HTTP/카탈로그 계약으로 검사합니다.
실제 카탈로그·공식 상세를 읽기 전용으로 마운트하고 파일 hash·수정 시각이
유지되는지 확인합니다. 컨테이너 네트워크는 차단하고 모델은 비활성화합니다.

```bash
python3 scripts/verify-release-rollback.py \
  --current 061525506239.dkr.ecr.ap-northeast-2.amazonaws.com/jeju-3d@sha256:18fb0b1fa57b1ee5552eec9e9db34717c23319c28fc6e6e78bbfc45a939a54b9 \
  --previous 061525506239.dkr.ecr.ap-northeast-2.amazonaws.com/jeju-3d@sha256:0ef30ebd2d916a26fcc53eeee47a92c5483c55aef408c836e5a49c25880f671b \
  --output .local/release-rollback-final-rehearsal.json
```

세 단계 모두 준비 상태·정적 파일·동일 장소 ID/좌표·공식 상세를 확인했습니다.
이 기록은 로컬 이미지 호환성 검사이며 운영 장애 중 롤백 수행 기록과 구분합니다.
