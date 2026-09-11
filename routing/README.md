# 제주 경로 실행 이미지

Valhalla 3.8.3 ARM64를
`sha256:58c7dd3fb256f306b00c558fb76aea9fd4fb804edd831e2b4847c26511cca507`
로 고정합니다. 그래프도 같은 엔진으로 빌드해야 합니다. 이 디렉터리의 변경만으로
컨테이너 실행이나 AWS 배포가 이루어지지는 않습니다.

## 입력과 런타임 경로

부모 데이터 빌드의 `.local/routing-data/`에서 다음 파일만 이미지에 복사합니다.

```text
valhalla_tiles.tar
admin.sqlite
source.json
elevation_data/N33/N33E126.hgt
timezones.sqlite                  # 선택 사항
```

목적지는 `/opt/routing/data/`, 설정은 `/opt/routing/valhalla.json`입니다.
PBF·임시 빌드 파일·`.env`·자격 증명은 빌드 컨텍스트에 포함하지 않습니다.
`source.json`의 엔진 버전·기반 이미지·파일 크기·SHA-256을 검사합니다.
선택 timezone 파일도 있으면 manifest에 일치하는 hash가 있어야 합니다.
없으면 runtime 설정에서 해당 DB 경로를 제거합니다. 출발시각 없는 정적 경로이며
계획 시각의 Asia/Seoul 표시와 실시간 교통·시간 의존 경로는 구분합니다.

입력 HGT가 `600`이어도 이미지 빌드 안에서 파일을 `444`, 디렉터리를 `555`로
설정하므로 UID/GID `65532:65532`가 읽을 수 있습니다. 호스트 원본 권한은 바꾸지 않습니다.
시작 때는 다운로드·그래프 빌드·설정 변경을 하지 않고 `/tmp` IPC만 사용합니다.

OS 보안 패치는 이미지 빌드 때 Ubuntu 패키지 저장소에서 적용합니다.
`build-routing-push`는 `--no-cache`로 패치를 새로 확인하며, 알려진 Critical/High
수정 버전에 못 미치면 빌드를 중단합니다. 업그레이드 전후 `valhalla_service`의
SHA-256이 같아야 하고 설치 패키지 목록은 `/opt/routing/os-packages.tsv`에 남깁니다.
그래프 검사·설정 생성 단계는 `RUN --network=none`으로 실행합니다.

## HTTP와 메모리

- `http://127.0.0.1:8002`: `/route`, `/height`, `/status`만 사용합니다.
- `/status`의 verbose 결과에 실제 tiles·3.8.3 버전·필수 action이 있어야 health가 통과합니다.
- worker 수는 1이며 reader별 LRU tile cache는 64 MiB로 제한합니다.
  `global_synchronized_cache`는 끕니다. 고정한 3.8.3 이미지에서 이 옵션을 켜면
  동시 4요청 검증 중 SIGSEGV가 두 번 재현됐고, 끈 뒤 같은 검증이 통과했습니다.
  캐시 한도는 프로세스 전체 RSS 상한이 아닙니다.
- 원격 tile/elevation URL을 제거하고 HTTP 요청 제한 시간을 15초로 둡니다.
- native stdout/stderr를 버려 요청 좌표가 로그로 나가지 않게 합니다.
  시작 상태만 고정된 짧은 JSON으로 기록합니다.

Fargate의 awsvpc 작업 안에서 웹 컨테이너만 loopback으로 접근합니다.
포트 8002의 외부 매핑·SG 규칙·ALB 대상은 추가하지 않습니다. 로컬 검증에서는
같은 네트워크 네임스페이스 또는 컨테이너 내부 요청을 사용해야 합니다.

## 배포 연결

부모가 실행을 승인한 뒤 사용할 명령입니다.

```bash
PATH=/tmp/jeju-node24/bin:$PATH python3 scripts/deploy.py build-routing-push
# 기존 production 설정에 RoutingEnabled와 측정한 크기를 합친 뒤
PATH=/tmp/jeju-node24/bin:$PATH python3 scripts/deploy.py build-push
python3 scripts/deploy.py plan-app
```

추가 설정은 `RoutingEnabled: "true"`, `TaskCpu`, `TaskMemory`, `RoutingMemory`입니다.
기존 무경로 상태는 256 CPU/512 MiB를 유지합니다. 처음 경로를 활성화하고 별도
크기를 주지 않으면 512 CPU/1024 MiB·라우터 상한 512 MiB를 사용합니다.
이는 측정을 대신하는 확정 용량이 아닙니다.

`build-routing-push`는 기존 ECR 저장소에 독립 이미지를 푸시하고
`.local/routing-image.json`에 digest·데이터 시각을 기록합니다. 웹 빌드는 그
이미지를 `image.json.routing`과 `.local/release-pairs/<웹 digest>.json`에 묶습니다.
준비된 쌍 없이 라우팅을 켜거나, 이미 사용 중인 라우터를 암묵적으로 제거하는
계획은 거절합니다.

앱 환경은 `ROUTING_URL=http://127.0.0.1:8002`,
`ROUTING_DATA_UPDATED_AT=<source.json의 data_updated_at>`입니다.
라우터는 비필수 컨테이너와 restart policy를 사용해 지도·카탈로그 장애로
번지지 않게 합니다. 라우터만 실패하면 ECS 자동 롤백을 기대하지 말고
부모의 실제 경로 검사에서 배포 승인을 막아야 합니다.

두 이미지는 한 TaskDefinition에 속하므로 ECS 배포 롤백은 이전 쌍을 복원합니다.
수동 롤백의 새 승인 항목은 다음처럼 두 이미지를 함께 기록합니다.

```python
{"digest": "sha256:<승인된 웹 digest>",
 "routing": {"imageUri": "<승인된 라우팅 ECR digest URI>",
             "dataUpdatedAt": "<해당 그래프의 OSM 시각>"}}
```

기존 무경로 승인 릴리스로 복원하면 라우팅 컨테이너를 제거합니다. 현재의
CPU/RAM·독립 Guide ARN·카탈로그·네트워크·TLS는 되돌리지 않습니다.
데이터 시각이나 라우터 digest가 바뀌면 기존 롤백 계획은 다시 작성해야 합니다.

새 앱 계획은 `.local/atlas-agent-outputs.json`의 `guideRuntimeArn`이 자체
`JejuAtlas_Guide` 런타임이고 `catalogBucket`이
`jeju-3d-data-061525506239-ap-northeast-2`인 경우에만 진행합니다.
참조 프로젝트 기본값으로 돌아가지 않습니다. 이미지 빌드와 로컬 테스트는
이 전용 AgentCore 출력이 없어도 수행할 수 있습니다.

## 최종 이미지 로컬 검증

2026-09-11 최종 Dockerfile을 실제 빌드한 뒤 0.5 CPU·512 MiB,
UID/GID 65532, read-only 루트와 별도 `/tmp` 볼륨으로 검사했습니다.
부모의 8002 프로브 대신 자체 네임스페이스와 호스트 loopback 8129 프록시를 사용했습니다.
도보/차량 세 쌍과 실제 고도, 동시 4요청 60회 및 12경유지 8회가 통과했습니다.
HGT는 이미지 안에서 `444`, `/tmp`는 `1777`이며 원본 `600` 권한은 유지됩니다.
요청 좌표·식별 표식의 로그 노출과 OOM이 없었고 SIGTERM 후 정상 종료했습니다.
이는 라우터의 로컬 검증이며 웹·GuardDuty를 포함한 실제 Fargate 통합 검증은 별도입니다.
결과와 이전 실패 기록은 `.local/routing-runtime-validation*.json`에 보관합니다.
같은 날 OS 보안 패치를 적용한 이미지에서도 동일 검증을 통과했습니다.
스캔 19개 항목의 설치 버전 비교는 `.local/routing-os-after-patch.json`,
재검증 결과는 `.local/routing-security-runtime-validation.json`에 있습니다.
이 비교는 로컬 패키지 검증이며 ECR 재스캔 결과는 게시 후 별도로 확인해야 합니다.
