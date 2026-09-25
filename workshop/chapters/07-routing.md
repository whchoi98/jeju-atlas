# 07. 실제 경로와 고도 데이터

이 장은 120분 본 실습 이후에 선택하는 심화 자료입니다.

Valhalla 3.8.3 ARM64와 해당 엔진으로 만든 OSM 그래프를 사용합니다.\
도보, 차량 거리를 직선 거리로 대신하지 않습니다.\
HGT 고도 자료의 기준일은 현재 위성 영상 촬영일이나 정밀 현장 측량일이 아닙니다.

## 입력 자료

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
| `sources_verified` | OSM과 고도 입력 자료가 준비됐습니다. 그래프 빌드는 아직 별도 단계입니다. |
| `graph_verified` | 그래프 빌드와 빌더 내부의 필수 검증이 완료됐습니다. 라우터 이미지 게시로 진행합니다. |
| Docker 소켓 `permission denied` | 현재 터미널의 Docker 권한을 적용한 뒤 아래 복구 절차로 재개합니다. |
| `source.json` 없음 | 그래프 빌드 완료 기록이 없습니다. 앞선 `routing-build` 결과부터 확인합니다. |

빌더는 완성된 그래프의 파일과 해시를 확인한 뒤 참가자 app의 `.local/routing-data/source.json`을 작성합니다.\
`source.json`에서 출처 시각, 엔진, 기반 이미지, 파일 크기, SHA-256을 확인합니다.\
자료를 갱신하면 이전 실습과 거리, 예상 시간이 달라질 수 있습니다.

Docker의 `FINISHED`는 빌더 이미지 준비가 끝났다는 뜻이며, 이후 행정구역 DB와 도로 타일 처리가 이어집니다.\
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
`sources_verified`까지 성공했다면 기존 `downloads.json`, OSM과 HGT 파일을 보존하고 **빌드부터 재개**합니다.

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
