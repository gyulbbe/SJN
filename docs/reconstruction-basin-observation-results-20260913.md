# 세면대 원시 관측과 사각 기둥형 보완 검증

2026-09-13. DeepLab 가중치와 제품 배경 제거·TripoSR는 변경하지 않았다. 다음 결과는 **원본 JPG 직접 분석 → 같은 원시 성분 재생** 실험이다. 앱이 방향 정규화 후 다시 저장한 JPEG를 분석하는 최종 공간 평가는 별도 기록한다.

## 확인된 원인

`test 화장실3.jpg`의 세면대 주성분에서 기둥 분리는 이미 동작했다. 전체 폭 173px, 기둥 폭 51px, 볼/기둥 경계 y=208이었으나 남은 하단 윤곽은 82열, coverage 0.56427이었다. 기존 0.65 범위 검사를 통과하지 못해 `basinShape`가 미입력 상태로 남았다. 원 모델 마스크를 사진에 겹쳐 확인한 결과 회색 볼의 오른쪽 아래 면이 세면대 영역에서 빠졌다.

범위 기준만 낮춰도 직선 잔차가 약 9.41px이므로 사각으로 판정할 근거가 되지 않는다. 원 모델이 기둥형을 놓쳤거나 기둥과 볼을 분리하지 않았다고 보고하지 않는다. 모델의 공간 분류와 코드의 형태 추정을 구분한다.

## 공통 변경

기존 의미 윤곽에서 사각·곡면 근거가 있으면 그대로 사용한다. 그 경로가 실패하고 실제 기둥 지지 근거가 있는 세면대에만 RGB 보완을 검사한다.

- 관측된 볼/기둥 전이 범위에서 **실제 세면대 마스크에 닿는 밝기 경계**를 구한다. 사각형 crop 안의 타일 줄눈만 검사하지 않는다.
- 충분히 긴 좌우 두 직선의 잔차·범위·방향과 볼 안의 교점을 검사한다.
- 같은 점들을 부드러운 2차 곡선에도 맞춰 비교한다. 짧은 두 현으로 둥근 볼을 사각으로 오인하지 않도록 곡선으로 동등하게 설명되는 경우는 보류한다.
- 사진별 좌표, 파일명, 제품별 정답이나 사각 기본값을 사용하지 않는다. 원근·가림·반사·작은 사진에 따라 보류할 수 있다.

새 출처는 `evidence.basinShape.source = semantic-rgb-contour`다. `edgeSlopes`, `rimIntersection`, `observedEdgeCoverage`, `coverage`, `fitError`를 보관하며, 측정하지 않은 `curvature`를 0으로 채우지 않는다. 이 값은 관측 규칙의 `inferred` 결과이며 DeepLab이 사각이라는 세부 분류를 직접 출력했다는 뜻이 아니다. 교점은 원본 방향 정규화 좌표로 crop/flip 변환한다. 기존 `semantic-contour` 저장 문서는 그대로 읽고, Supabase 검증에 구분된 스키마를 추가했다. 실제 서버 연결 검증은 하지 않았다.

## 실제 네 사진

Windows 10, Headless Chrome 152, TensorFlow.js WASM 단일 스레드, 사진마다 독립 Worker. 외부 요청 0. 아래 시간은 원본 읽기·모델/WASM 준비·주 분석·반전·확대 확인을 포함하며 **순수 추론 시간이나 새 RGB 함수 처리 시간은 아니다**. 메모리 peak는 이 실험에서 측정하지 않았다.

| 입력 | 실제 분석 시간 | 분석 패스/세면대 원시 성분 | 동일 관측 재생 결과 |
|---|---:|---:|---|
| TEST 화장실.jpg | 21.611초 | 6 / 18 | 조각난 벽걸이 볼 형태 미확정 유지 |
| TEST 화장실2.jpg | 10.535초 | 3 / 3 | 기존 곡면 관측 유지 |
| test 화장실3.jpg | 20.650초 | 6 / 37 | 주 성분 1개만 미확정→사각; 기둥 근거 유지 |
| images.jpg | 30.028초 | 8 / 19 | 기존 결과 유지; 두 볼 추가 관측 주장 없음 |

전체 77개 원시 성분 중 달라진 것은 세 번째 사진 주 분석의 세면대 한 개다. 그 성분의 좌우 직선 coverage는 0.71864 / 0.87486, 기울기는 0.16607 / -0.19949, 최대 RMS는 폭 대비 0.00365다. 두 직선의 결합 RMS 약 0.00315에 비해 매끈한 곡선 RMS는 약 0.00608로, 두 직선의 모서리 관측을 지지했다. 이는 세 번째 사진의 형태 보완 결과이며 다른 설비의 인식·설치 벽·위치가 개선됐다는 뜻은 아니다.

## 재현 및 진단 자료

- 원본 입력 manifest 및 SHA: `test-results/reconstruction-basin-shape-investigation-20260913/capture-inputs.json`, `raw-v1/user-*/report.json`
- 구 알고리즘 시점 원시 자료/소스 스냅샷: `raw-v1/`의 pass JSON, RGBA binary, PNG, source. 원본 보존.
- 최종 새 알고리즘 동일 입력 재생: `replay-v3-final/`의 pass JSON, `summary.json`, `source-hashes.json`
- 실제 사진/마스크/관측 테두리 비교: `test-results/reconstruction-basin-shape-investigation-20260913/comparison.html`
- 세 번째 사진 최종 관측 이미지: `replay-v3-final/user-03/pass-00-object-48-55125.png`

이 개인 사진과 결과는 Git 추적 대상에 넣지 않는다. `raw-v1`, 초기 `replay-v2`, 곡선 구분까지 포함한 `replay-v3-final`을 별도로 보존한다.

원시 캡처는 `segmentRoom(..., {captureBasins:true})`를 지정한 개발 하네스에서만 활성화된다. `basinDiagnostics`에는 각 pass의 원 RGB, 좌우 반전 여부와 원본 영역, 성분 pixel run, 기둥 여부, 단계별 실패 이유와 적합 수치를 담는다. 일반 앱에서는 해당 옵션이 없고 원시 RGB 복사·원시 profile 생성·프로젝트 저장을 추가하지 않는다.

```powershell
$env:BASIN_OBSERVATION_MANIFEST='test-results/reconstruction-basin-shape-investigation-20260913/capture-inputs.json'
$env:BASIN_CAPTURE_OUTPUT='test-results/reconstruction-basin-shape-investigation-20260913/new-raw-run'
node tests/run-browser-test.mjs tests/reconstruction-basin-observation-browser.ts

$env:BASIN_REPLAY_OUTPUT='test-results/reconstruction-basin-shape-investigation-20260913/new-replay'
node tests/run-browser-test.mjs tests/reconstruction-basin-observation-replay.ts
```

첫 명령은 실제 모델을 실행한다. 두 번째는 보존한 원시 성분을 순수 함수로 재생하며 모델을 실행하지 않는다. 기존 결과 경로를 덮어쓰지 않는다.

## 검사 결과와 한계

관련 4개 단위 파일 47개 검사 통과. 새 RGB 검사 13개는 0.75/1/1.5 배율, 곡선·일직선·무늬 없음·한쪽 선, 기둥 없음·마스크 밖 경계·잘린 입력, 기존 곡면 보존, 구/신 출처 저장, crop/flip 변환, 원시 캡처 유무의 후보 동일성을 검증한다. 이 합성 단위 결과를 AI 사진 인식 성공으로 계산하지 않는다. 담당 ESLint와 전체 `tsc --noEmit` 통과.

첫 사진의 분리된 볼, 네 번째 사진의 두 볼은 해결됐다고 보고하지 않는다. 현재 보완은 이미 기둥 지지 근거가 있는 충분한 크기의 세면대에 제한된다. 정면에서 모서리가 보이지 않는 사각 볼이나 반사·무늬가 강한 제품은 여전히 미확정 또는 오인식할 수 있다. 앱 JPEG 입력, 다른 욕실 사진, 최종 배치/PNG와 전체 빌드는 루트 통합 평가에서 별도 확인한다.
