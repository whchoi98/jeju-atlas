# 05. 컨테이너 저장소와 장소 데이터

이 장은 120분 본 실습 이후에 선택하는 심화 자료입니다.

ECR과 비공개 데이터 S3를 먼저 만듭니다.
웹 Distribution과 실제 Atlas Runtime이 아직 없는 단계입니다.
운영 Distribution을 데이터 버킷에 임시 연결하지 않습니다.

## 심화 작업 폴더 준비

여기부터는 120분 본 실습 이후의 선택 과정입니다. 전체 Atlas를 배포할 별도 작업 사본을 만듭니다.
기본 과정의 CLI Runtime과 새 CloudFormation 스택을 같은 자원으로 취급하지 않습니다.

```bash
cd "$ATLAS_REPO"
export ATLAS_APP="$ATLAS_REPO/workshop/.local/labs/$ATLAS_TEAM/app"
python3 workshop/scripts/lab.py discover --config "$ATLAS_CONFIG"
python3 workshop/scripts/lab.py prepare --config "$ATLAS_CONFIG"
python3 workshop/scripts/lab.py info --config "$ATLAS_CONFIG"
```

이미 본인의 app 폴더가 있다면 prepare를 다시 실행하지 말고 현재 파일과 바인딩을 확인합니다.
이후 선택한 AI CLI는 이 app 폴더에서 실행합니다.

## ECR 생성

각 plan 출력에서 참가자 이름과 생성 자원을 확인한 뒤 apply를 실행합니다.

```bash
cd "$ATLAS_REPO"
python3 workshop/scripts/lab.py run network --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run plan-bootstrap --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run apply-bootstrap --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run status-bootstrap --config "$ATLAS_CONFIG" --execute
```

`CREATE_COMPLETE`가 된 뒤 진행합니다. 진행 중이면 status를 다시 확인하며 apply를 반복하지 않습니다.
ECR은 웹, 수집 작업, 라우터 이미지를 불변 태그와 digest로 관리합니다.

## CloudFront 없이 비공개 데이터 버킷 생성

```bash
python3 workshop/scripts/lab.py run plan-data --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run apply-data --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run status-data --config "$ATLAS_CONFIG" --execute
```

실습용 데이터 템플릿은 초기의 빈 Distribution 입력을 처리합니다.
Public Access Block, 버전 관리, 암호화, 미디어 OAC를 만들지만
CloudFront 미디어 읽기 허용은 실제 Distribution을 연결할 때까지 없습니다.
수집 이미지와 Schedule은 아직 활성화하지 않습니다.

데이터 → AgentCore → 웹 → 실제 Distribution 연결 순서로 최초 배포 의존성을 해결합니다.

## 카탈로그 생성, 게시

전체 실습에서는 공개 OSM 장소를 포함해 새 카탈로그를 만듭니다.

```bash
python3 workshop/scripts/lab.py catalog --osm --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py publish-catalog --config "$ATLAS_CONFIG" --execute
```

네트워크 없는 준비 실습은 `--osm`을 생략하면 샘플 137건만 사용합니다.
이 경우 전체 데이터 준비가 끝났다고 기록하지 않습니다.
이미 생성된 파일은 덮어쓰지 않으므로 처음에 사용할 모드를 선택합니다.
재생성할 때는 본인 파일을 백업하고 새 출력을 검증합니다.

샘플/OSM 개수, SQLite 경로, SHA-256과 게시 객체 버전을 확인합니다.
OSM 개수는 조회 시점과 조건에 따라 달라지며 과거 운영의 6,587건과 같다고 보장하지 않습니다.
검증된 Overpass JSON이 있으면 `--osm-file`을 사용할 수 있습니다.

최초 게시에서는 `place-details/latest.json`에 빈 공식 snapshot도 조건부로 초기화합니다.
공식 확인 결과를 만들어 넣는 것이 아니라, 읽기 전용 worker가 첫 실행부터 정상 파일을 읽게 하는
준비입니다. 이미 보강된 snapshot은 덮어쓰지 않습니다.

## 데이터 의미

| 자료 | 해석 |
|---|---|
| 샘플 137건 | 실제 장소 이름을 바탕으로 만든 시드. 기본 좌표, 주소, 소개는 공식 검증값이 아님 |
| OSM 행 | 실제 OpenStreetMap 자료. ODbL 출처와 조회 정보를 유지 |
| 사진, 시간, 편의 | 후속 보강에서 확인된 항목만 표시 |
| 빈 필드 | 모르는 값. Codex나 모델이 만들어 채우지 않음 |

준비기는 Node 카탈로그와 Python Tools가 함께 읽는 테이블, 검색 인덱스, 메타데이터를 만듭니다.
자세한 내용은 [카탈로그 준비 기준](../reference/catalog-bootstrap.md)에 있습니다.

- [ ] Registry와 Data 스택이 완료되었습니다.
- [ ] S3가 비공개이고 아직 운영 CloudFront와 연결되지 않았습니다.
- [ ] 출처를 구분한 카탈로그를 내 버킷에 게시했습니다.

AI CLI 프롬프트: [05, ECR, 카탈로그](../prompts/05-foundation-and-data.md)

다음: [06, 실제 Atlas AgentCore](06-atlas-agentcore.md)
