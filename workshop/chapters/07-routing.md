# 07. 실제 경로와 고도 데이터

이 장은 120분 본 실습 이후에 선택하는 심화 자료입니다.

Valhalla 3.8.3 ARM64와 해당 엔진으로 만든 OSM 그래프를 사용합니다.\
도보, 차량 거리를 직선 거리로 대신하지 않습니다.\
HGT 고도 자료의 기준일은 현재 위성 영상 촬영일이나 정밀 현장 측량일이 아닙니다.

## 입력 자료

```bash
cd "$ATLAS_REPO" && {
python3 workshop/scripts/lab.py run routing-fetch --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run routing-build --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run routing-verify --config "$ATLAS_CONFIG" --execute
}
```
허용된 공개 OSM, 고도 자료를 다운로드합니다.\
네트워크, Docker, 플랫폼 오류를 해결한 뒤 재개하고, 임의의 공용 라우팅 서버로 바꾸지 않습니다.

`source.json`에서 출처 시각, 엔진, 기반 이미지, 파일 크기, SHA-256을 확인합니다.\
자료를 갱신하면 이전 실습과 거리, 예상 시간이 달라질 수 있습니다.

## 라우터 이미지

```bash
cd -- "${ATLAS_REPO:?먼저 01장의 activate.sh를 source하세요}" && {
python3 workshop/scripts/lab.py run build-routing-push --config "$ATLAS_CONFIG" --execute
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

Agentic AI 코딩 어시스턴트 프롬프트: [07, 라우팅](../prompts/07-routing.md)

다음: [08, 웹과 Fargate](08-web.md)
