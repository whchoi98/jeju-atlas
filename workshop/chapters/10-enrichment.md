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

- [ ] 숨김 입력으로 내 SSM 경로에 키를 저장했습니다.
- [ ] 전용 worker와 주간 Schedule을 구성했습니다.
- [ ] 최소 한 번의 실제 수집 결과·로그·갱신 시점을 확인했습니다.
- [ ] 사진·시간·편의·올레길 출처와 미확인 상태가 구분됩니다.

Codex 카드: [10 · 공식 보강](../prompts/10-enrichment.md)

다음: [11 · 관측과 운영](11-operations.md)
