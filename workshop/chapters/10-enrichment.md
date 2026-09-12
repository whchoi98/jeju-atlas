# 10 · 공식 정보와 주간 보강

Visit Jeju·TourAPI 자료로 장소 상세·사진·시간·코스 정보를 보강합니다.
샘플 기본 필드를 공식 검증 데이터로 바꾸어 표시하지 않습니다.
라이선스·원문 출처·확인 시점과 match 결과를 유지합니다.

## 키 입력

참가자의 단말 터미널에서 실행합니다. API 키를 Codex 대화나 명령 인자에 넣지 않습니다.

```bash
cd "$ATLAS_REPO"
python3 workshop/scripts/lab.py set-secret --provider visitjeju --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py set-secret --provider tourapi --config "$ATLAS_CONFIG" --execute
```

키는 숨김 입력을 받아 내 이름의 SSM SecureString으로 저장합니다.

```text
/jeju-atlas-lab-team01/visitjeju-api-key
/jeju-atlas-lab-team01/tourapi-service-key
```

수집 코드와 IAM도 이 두 경로를 사용합니다.
운영 `/jeju-atlas/`나 참조 프로젝트의 secret 경로를 입력하지 않습니다.
확인은 parameter 이름·버전으로 하고 복호화한 값을 화면에 출력하지 않습니다.

## 수집 이미지와 Schedule

```bash
python3 workshop/scripts/lab.py run build-data-push --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run plan-data --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run apply-data --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run status-data --config "$ATLAS_CONFIG" --execute
```

task definition·worker 역할·로그·지표 필터를 확인합니다.
카탈로그·공식 snapshot·미디어 대상은 내 버킷이고 공개 미디어 URL은 내 ApplicationUrl이어야 합니다.

주간 실행을 활성화합니다.

```bash
python3 workshop/scripts/lab.py enable-schedule --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run plan-data --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run apply-data --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run status-data --config "$ATLAS_CONFIG" --execute
```

즉시 결과를 보고 싶으면 진행자가 ECS 콘솔에서 이 데이터 task definition을 한 번 실행합니다.
클러스터, Private Subnet, worker SG, Public IP 비활성화, 전용 task/execution role을
스택 출력·생성 task definition과 대조합니다. 웹 task를 수집 작업 대신 실행하지 않습니다.
Schedule 활성화만으로 첫 수집이 이미 완료됐다고 기록하지 않습니다.

## 결과 해석

- 공식적으로 연결된 사진·시간·편의 정보만 표시합니다.
- 장소 이름·좌표·주소·소개가 여전히 샘플인 경우 그 근거를 분리합니다.
- `tourapi_usetime` 파싱값을 독립 검증된 요일별 운영시간으로 설명하지 않습니다.
- 인허가상 `open`과 현재 시각의 영업 여부는 다릅니다.
- 출처 없는 사진·비상업 전용·불명확한 라이선스 자료를 공개 갤러리에 올리지 않습니다.
- API 실패나 match 실패는 “정보 없음/갱신 지연”으로 남기고 값을 만들어 채우지 않습니다.

신규 카탈로그의 LOCALDATA 등 추가 근거는 별도 자료가 없으면 비어 있습니다.
기존 운영 snapshot에 그런 필드가 있었다는 이유만으로 새 실습에서도 확인됐다고 하지 않습니다.
이번 작업의 직접 수집 대상과 외부에서 들어온 근거를 구분합니다.

## 올레길과 웹 확인

보강 결과의 올레길 자료·출처·geometry를 확인하고 둘러보기에서 코스를 선택합니다.
제주 한 바퀴와 올레길의 실제 코스·경유지·이동 경로가 서로 다른 기능임을 확인합니다.
공식 자료와 OSM geometry의 출처를 구분합니다.

사진은 내 CloudFront `/media/`에서 전달되어야 합니다.
Data 스택의 미디어 정책과 실제 Distribution이 맞지 않으면 S3를 공개하는 대신
08장의 데이터 정책 연결을 다시 확인합니다.

## 선택 실습 · 카카오 장소 정보

카카오 Developers에서 실습 앱의 **카카오맵 사용 설정을 ON**으로 바꾸고 REST API 키를 준비합니다.
키 종류를 혼동하지 않습니다. 이 기능은 ECS의 REST 조회이므로 JavaScript·네이티브 앱 키는 사용하지 않습니다.

```bash
python3 workshop/scripts/lab.py set-secret --provider kakao --config "$ATLAS_CONFIG" --execute
```

참가자 앱의 `infra/production.json`에 `KakaoRestApiKeyParameter`를
`/jeju-atlas-lab-<참가자>/kakao-rest-api-key`로, `KakaoDailyLimit`를 `1000` 이하로 설정합니다.
JSON에는 키 값이 아닌 내 SSM 경로만 넣습니다. 진행자가 준비한 서로 다른 프로젝트의 키를 공유하지 않습니다.

```bash
python3 workshop/scripts/lab.py run build-push --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run plan-app --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run apply-app --config "$ATLAS_CONFIG" --execute
python3 workshop/scripts/lab.py run status-app --config "$ATLAS_CONFIG" --execute
```

계획에서 실행 역할의 `ssm:GetParameters`가 내 파라미터 ARN 한 개로 제한되고,
웹 컨테이너에는 ECS secrets로 전달되는지 확인합니다. 브라우저 설정·JS·로그에 키가 없어야 합니다.
장소 상세의 카카오 카드에서 이름·주소·전화·상세 링크·조회 시각을 확인합니다.
기존 장소 ID·지도 좌표·샘플 근거와 공식 관광정보를 덮어쓰지 않습니다.

동일한 이름의 다른 지점이나 불완전한 검색 결과는 확정 연결하지 않습니다.
가까운 200m의 후보를 먼저 확인하고, 미검증 시드는 필요한 경우 2km까지 다시 조회합니다.
카카오 분류 코드가 비어 있으면 세부 분류를 확인하며, 본점 표기 차이는 100m 이내에서만 허용합니다.
연결하지 못한 경우 이름·분류·위치·검색 결과 부족 등의 사유를 구분하여 확인합니다.
카카오 Local은 사진·후기·영업시간을 제공하지 않으므로 추가 방문 정보는 카카오 상세 페이지로 연결합니다.
조회는 별도의 일일 한도와 동시 실행 제한을 사용하며, 카카오 결과는 DB·PWA 캐시에 저장하지 않습니다.
API 인증이나 제공처가 실패해도 기존 장소 상세는 읽을 수 있어야 합니다.

- [ ] 숨김 입력으로 내 SSM 경로에 키를 저장했습니다.
- [ ] 전용 worker와 주간 Schedule을 구성했습니다.
- [ ] 최소 한 번의 실제 수집 결과·로그·갱신 시점을 확인했습니다.
- [ ] 사진·시간·편의·올레길 출처와 미확인 상태가 구분됩니다.

Codex 카드: [10 · 공식 보강](../prompts/10-enrichment.md)

다음: [11 · 관측과 운영](11-operations.md)
