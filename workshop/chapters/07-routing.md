# 07. 실제 경로와 고도 데이터

이 장은 120분 본 실습 이후에 선택하는 심화 자료입니다.

Valhalla 3.8.3 ARM64와 해당 엔진으로 만든 OSM 그래프를 사용합니다.\
도보, 차량 거리를 직선 거리로 대신하지 않습니다.\
HGT 고도 자료의 기준일은 현재 위성 영상 촬영일이나 정밀 현장 측량일이 아닙니다.

## 입력 자료

**시간을 줄이려면 제주 PBF와 행정경계 DB가 함께 있는 v2 묶음을 사용합니다.**\
전국 PBF 다운로드, 제주 범위 추출과 행정경계 DB 생성을 건너뜁니다.
고도 준비와 타일 생성, 라우터 이미지 빌드와 게시는 계속 수행합니다.

진행자는 `jeju-routing-input-20260910-v2.zip`과 ZIP의 `.sha256` 파일을 함께 전달합니다.
압축을 풀면 `jeju-routing-input` 폴더가 생깁니다.
이 폴더 전체를 참가자 EC2의 홈 폴더에 둡니다.

| 파일 | 묶음에서의 위치 | 용도 |
|---|---|---|
| `jeju.osm.pbf` | `jeju-routing-input/` | 이미 제주 범위로 추출한 입력 |
| `admin.sqlite` | 같은 폴더 | 같은 전국 스냅샷으로 만든 행정경계 DB |
| `jeju-input.json` | 같은 폴더 | 입력 해시, 기준일, 엔진과 행정구역 개수 |
| `SHA256SUMS` | 같은 폴더 | PBF, DB, 메타데이터와 설명 파일의 체크섬 |
| `PROVENANCE.json`, `README.txt` | 같은 폴더 | 원본 헤더, 객체 시각과 재현 정보, 사용 안내 |

**자료 ZIP은 HTML 교재 ZIP과 별도로 진행자가 전달합니다.**\
`$HOME/jeju-routing-input/jeju.osm.pbf`는 저장 위치이며 다운로드 URL이 아닙니다.
이 묶음은 2026-09-10 기준 자료이며 최신 자료로 표시하지 않습니다.
다른 자료를 받았다면 그 자료와 짝이 맞는 메타데이터를 사용합니다.

ZIP을 EC2 홈에 올린 경우 다음으로 체크섬을 확인하고 압축을 풉니다.
이미 같은 폴더가 준비됐다면 이 블록을 건너뜁니다.
기존 폴더가 있으면 덮어쓰지 않습니다.

```bash
cd -- "$HOME" &&
(
  set -e
  test ! -e jeju-routing-input
  test ! -L jeju-routing-input
  printf '%s\n' '3790fcc8fafcfab9226644046df912fe73f014864efc65848078849e98987c7a  jeju-routing-input-20260910-v2.zip' |
    sha256sum -c -
  python3 -m zipfile -e jeju-routing-input-20260910-v2.zip .
)
```

위 체크섬은 명시한 v2 ZIP에만 적용합니다.
다른 버전은 진행자가 별도로 제공한 신뢰할 수 있는 체크섬과 대조합니다.
묶음 내부의 체크섬만으로 배포자의 신원까지 확인되는 것은 아닙니다.

`jeju-input.json`은 입력 정보입니다.
그래프 빌드 완료 파일인 `source.json`으로 이름을 바꾸거나 대신 복사하지 않습니다.
진행자의 준비 내용은 [공유 PBF 자료 준비](../reference/facilitator.md#07장-공유-pbf-자료-준비)에 있습니다.

## 기본: 공유 PBF로 추출 생략

05장의 참가자 app이 준비된 상태에서 실행합니다.
아래 명령 전체 또는 **하단 프롬프트** 중 하나로 진행하며 같은 작업을 중복 실행하지 않습니다.

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
source workshop/.local/labs/team01/activate.sh &&
docker info >/dev/null &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run routing-build \
  --config "$ATLAS_CONFIG" --jeju-pbf "$HOME/jeju-routing-input/jeju.osm.pbf" --execute
}
```

같은 폴더의 `jeju-input.json`, `SHA256SUMS`와 `admin.sqlite`를 자동으로 읽습니다.
v2 묶음의 파일은 이름과 위치를 함께 유지합니다.\
파일, 체크섬, 기준일, 엔진과 행정경계가 맞지 않으면 다운로드나 빌드 전에 중단합니다.
자료가 없는 상태에서 긴 직접 추출로 자동 전환하지 않습니다.

`jeju_extract_skipped`가 나오면 공유 PBF를 확인하고 추출을 생략한 것입니다.\
`admin_build_skipped`는 공유 행정경계 DB를 확인해 재사용했다는 뜻입니다.
대한민국과 제주특별자치도, 비어 있지 않은 경계와 메타데이터에 선언된 행정구역 개수를 확인합니다.
이번 묶음에는 국가 1개와 광역 16개가 들어 있습니다.
제주 PBF의 객체 시각이 선언한 기준일을 넘으면 중단합니다.\
이후 HGT를 준비하고 타일을 생성합니다.
마지막 `graph_verified`와 명령 성공을 확인한 뒤 라우터 이미지 단계로 이동합니다.

이전 PBF 전용 v1 묶음도 지원하지만 행정경계 DB용 전국 다운로드와 DB 생성은 남습니다.
v2에서 DB가 빠졌거나 불일치하면 v1 방식으로 자동 전환하지 않습니다.

이미 준비된 참가자 app에도 현재 소스의 빌더를 연결합니다.
app의 스크립트를 직접 수정하거나 `lab.py prepare`를 다시 실행할 필요는 없습니다.\
`unrecognized arguments: --jeju-pbf`가 나오면 전체 소스 루트에서 갱신한 뒤 같은 명령을 실행합니다.

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" &&
git pull --ff-only origin main
```

갱신이 실패하면 기존 변경을 보존하고 원인을 확인합니다.\
기존 `jeju.osm.pbf`가 공유 파일과 다르면 덮어쓰지 않습니다.
이미 완료한 그래프는 기존 출처와 파일을 확인해 재사용하고 새 입력으로 임의 교체하지 않습니다.

`source.json`의 라우팅 자료 기준일은 공유 PBF에서 가져옵니다.
행정구역 DB에 사용한 전국 원본의 시각과 해시는 `admin_source`에 별도로 기록합니다.\
새로 다운로드한 전국 원본의 날짜로 공유 PBF의 날짜를 바꾸지 않습니다.
v2의 전국 원본 해시는 진행자가 보관 파일과 대조한 출처 정보입니다.
참가자가 전국 파일까지 새로 다운로드해 검증한 결과로 표시하지 않습니다.
다른 날짜의 그래프와 경로 결과가 같다는 뜻도 아닙니다.

## 선택: 전국 원본부터 직접 빌드

OSM 추출 과정까지 학습하려는 경우에만 이 경로를 선택합니다.
위의 공유 PBF 경로를 완료했다면 다시 실행하지 않습니다.

07장은 Docker를 사용하는 과정입니다.\
아래 블록은 기존 참가자 환경을 활성화하고 **현재 터미널의 Docker 접근부터 확인**합니다.\
확인이 실패하면 다운로드와 빌드를 시작하지 않습니다.

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
source workshop/.local/labs/team01/activate.sh &&
docker info >/dev/null &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run routing-fetch --config "$ATLAS_CONFIG" --execute &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run routing-build --config "$ATLAS_CONFIG" --execute
}
```
허용된 공개 OSM, 고도 자료를 다운로드합니다.\
명령 사이의 `&&`는 첫 실패 뒤 후속 명령을 실행하지 않게 합니다.\
네트워크, Docker, 플랫폼 오류를 해결한 뒤 재개하고, 임의의 공용 라우팅 서버로 바꾸지 않습니다.

| 출력 | 의미와 다음 단계 |
|---|---|
| `jeju_extract_skipped` | 공유 PBF가 확인됐고 제주 범위 추출을 생략했습니다. 후속 그래프 빌드는 아직 완료되지 않았습니다. |
| `admin_build_skipped` | 공유 행정경계 DB의 해시와 내용을 확인했습니다. 전국 다운로드와 행정경계 재생성을 생략합니다. |
| `sources_verified` | OSM과 고도 입력 자료가 준비됐습니다. 그래프 빌드는 아직 별도 단계입니다. |
| `graph_verified` | 그래프 빌드와 빌더 내부의 필수 검증이 완료됐습니다. 라우터 이미지 게시로 진행합니다. |
| Docker 소켓 `permission denied` | 현재 터미널의 Docker 권한을 적용한 뒤 아래 복구 절차로 재개합니다. |
| `source.json` 없음 | 그래프 빌드 완료 기록이 없습니다. 앞선 `routing-build` 결과부터 확인합니다. |

빌더는 완성된 그래프의 파일과 해시를 확인한 뒤 참가자 app의 `.local/routing-data/source.json`을 작성합니다.\
`source.json`에서 출처 시각, 엔진, 기반 이미지, 파일 크기, SHA-256을 확인합니다.\
자료를 갱신하면 이전 실습과 거리, 예상 시간이 달라질 수 있습니다.

Docker의 `FINISHED`는 빌더 이미지 준비가 끝났다는 뜻이며, 이후 선택한 경로의 도로 타일 처리가 이어집니다.\
중간 로그의 경고나 `Finished` 한 줄만으로 전체 완료를 판단하지 않습니다.\
**명령이 성공적으로 끝나고 마지막에 `graph_verified`가 나왔는지** 확인합니다.\
이 결과는 그래프 파일과 해시 확인이며, 실제 웹의 경로 응답까지 확인한 결과는 아닙니다.

## 복구: 다운로드 후 Docker 권한으로 빌드가 중단됐다면

사전 구성에서 Docker를 확인했더라도 새 터미널이나 기존 VSCode Server에서 실행한 프로세스는 다른 그룹 권한을 가질 수 있습니다.\
**실제로 라우팅 빌드를 실행할 터미널**에서 아래 블록만 실행합니다.

```bash
cd -- "$HOME" &&
sudo usermod -aG docker "$(id -un)" &&
newgrp docker
```

새 프롬프트가 나타난 뒤 다음 블록을 별도로 실행합니다.\
공유 PBF 경로를 사용했다면 **같은 `--jeju-pbf`를 포함해 재개**합니다.

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
source workshop/.local/labs/team01/activate.sh &&
docker info >/dev/null &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run routing-build \
  --config "$ATLAS_CONFIG" --jeju-pbf "$HOME/jeju-routing-input/jeju.osm.pbf" --execute
}
```

공유 PBF, 행정경계 DB, 메타데이터와 체크섬 파일을 모두 유지합니다.
옵션을 빼면 직접 추출 경로가 되므로 실패 후 재개할 때도 같은 옵션을 사용합니다.\
직접 빌드 경로에서 `sources_verified`까지 성공했다면 기존 `downloads.json`, OSM과 HGT 파일을 보존하고 **다음 명령으로 빌드부터 재개**합니다.

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
source workshop/.local/labs/team01/activate.sh &&
docker info >/dev/null &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run routing-build \
  --config "$ATLAS_CONFIG" --execute
}
```

다운로드를 반복하거나 `.local/routing-data`를 삭제할 필요는 없습니다.\
`source.json`은 빌드 성공 시 생성되므로 직접 만들거나 다른 실습에서 복사하지 않습니다.\
Docker 접근이 계속 실패하면 [사전 구성의 Docker 소켓 권한 확인](../reference/preconfiguration.md#docker-소켓-권한-오류가-계속되는-경우)을 따릅니다.

Docker 확인에 성공한 같은 터미널에서 후속 작업과 Agentic AI 코딩 어시스턴트를 실행합니다.\
이미 실행 중인 코딩 어시스턴트가 권한 오류를 내면 작업을 보존하고 이 셸에서 다시 실행합니다.

## 선택: 기존 그래프 파일을 다시 확인할 때

`routing-build`가 `graph_verified`로 끝났으면 별도 `routing-verify`는 기본으로 생략합니다.\
파일을 옮겼거나 기존 그래프의 무결성을 다시 확인해야 할 때만 실행합니다.

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
source workshop/.local/labs/team01/activate.sh &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run routing-verify \
  --config "$ATLAS_CONFIG" --execute
}
```

빌드가 실패했거나 `source.json`이 없으면 이 검증을 반복하지 않고 실패한 빌드 단계부터 해결합니다.

## 라우터 이미지

`graph_verified`가 확인된 뒤 같은 터미널에서 실행합니다.

```bash
cd -- "/home/ec2-user/my-project/jeju-atlas" && {
source workshop/.local/labs/team01/activate.sh &&
docker info >/dev/null &&
"$ATLAS_PYTHON" -B workshop/scripts/lab.py run build-routing-push --config "$ATLAS_CONFIG" --execute
}
```
입력 검증, OS 패치를 거쳐 불변 ECR 이미지로 게시하고 `.local/routing-image.json`에 digest, 자료 기준 시각을 기록합니다.\
이후 웹 이미지는 해당 라우터와 한 쌍으로 기록됩니다.\
검증된 타일, admin DB, HGT와 필요 시 timezone DB만 이미지에 넣습니다.

## 웹 연결

| 항목 | 설정 |
|---|---|
| 주소 | 같은 Fargate task의 `http://127.0.0.1:8002` |
| API | `/route`, `/height`, `/status` |
| 외부 노출 | ALB target, SG, 외부 port mapping에 8002를 추가하지 않음 |
| 실행 | 비루트 사용자, 읽기 전용 root, 별도 `/tmp` |
| 기준 용량 | task 0.5 vCPU, 1 GiB, 라우터 상한 512 MiB |

용량은 기존 실측 구성입니다.\
모든 부하에 충분하다는 보장은 아니므로 동시 요청의 상태, 지연, OOM을 따로 봅니다.\
예상 이동 시간은 실시간 교통 시간이 아닙니다.

- [ ] 자료 출처와 hash 검증을 통과했습니다.
- [ ] 동일 엔진 버전으로 그래프, 이미지를 빌드했습니다.
- [ ] 라우터가 내 ECR의 digest로 기록되었습니다.
- [ ] 임의 원격 라우터나 공개 8002 포트에 의존하지 않습니다.

웹 배포 후 도보, 차량 결과와 고도 단면을 비교합니다.\
정확한 값이 과거 기록과 다르면 자료 시각과 실제 경로를 함께 확인합니다.

하단 프롬프트로 진행하면 본문 명령을 중복 실행하지 않아도 됩니다.\
[프롬프트 진행 안내](00-orientation.md#하단-프롬프트로-진행하는-방법)를 참고하고 이미 완료한 작업은 유지합니다.

Agentic AI 코딩 어시스턴트 프롬프트: [07, 라우팅](../prompts/07-routing.md)

다음: [08, 웹과 Fargate](08-web.md)
