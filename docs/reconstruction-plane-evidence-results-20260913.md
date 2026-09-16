# 광학 영역 제외·벽 조각·선택하지 않은 카메라 가설 실험

2026-09-13. 자동 재구성 전체 목표는 미완료다. 이 변경은 기존 저장 관측을 더 정확히 구분하는 오프라인 실험과 진단이다. 생산 카메라 선택, 일반 Lab 분석, 설치/접점 계산의 규칙은 변경하지 않았다. 새 AI 실행·모델 다운로드·사진 외부 전송은 없다.

## 구현과 입력 보존

`tests/reconstruction_plane_evidence.py`는 **보존된 Qwen 원문과 automaticUnderstanding이 같은 사진·종류·bbox·view를 나타내는 경우**에만 유리/거울/창/문 및 반사 영역을 기하 지지에서 제외한다. 임의의 후보 bbox나 자유 서술을 모두 제외하지 않는다. 모델/프롬프트/실행 ID, 원문·보고서·사진 해시를 남긴다. 이 영역은 거친 관측 사각형이며 통과해 보이는 실제 벽·바닥도 일부 제거할 수 있다. 실제 개구부 경계나 인스턴스 마스크라고 표시하지 않는다.

`tests/reconstruction-geometry-plane-probe.py`에 명시적인 `--saved-inputs-manifest`, `--inventory-exclusions`, `--merge-patches` 옵션을 추가했다. 과거 캡처는 원 보고서·버퍼·당시 소스 해시를 사전에 동결한 manifest로 검증하며 현재 소스의 새 캡처라고 하지 않는다. 기존 옵션 없는 실행은 여전히 현재 캡처 소스 일치를 요구한다. 새 실행은 기존 사진별 결과 폴더를 덮어쓰지 않는다.

평면 조각 병합은 모든 조각 쌍의 방향(5° 이내)·offset(기존 거리 임계값 2배 이내), 서로 중복되지 않는 픽셀 지지, 영상에서의 인접성을 확인한다. 합친 점을 다시 적합한 뒤 **모든 원래 점**이 기존 거리·법선 기준을 유지해야 한다. 다른 벽을 방향만 보고 합치거나 불편한 점을 삭제하지 않는다. 실제 네 사진에서 이 조건을 통과한 병합은 0개다.

`src/lib/reconstruction/depth-room-hypotheses.ts`는 공통 방향군과 관측 바닥+직교 벽 쌍을 열거하는 별도 진단이다. 각 쌍에 기존 `fitDepthRoomCamera`를 그대로 적용하고 제외한 나머지 벽 ID·카메라 위치/회전 차이를 기록한다. 방향군은 병합 결과가 아니고 가설 하나를 자동 선택하지 않는다. `depth-room-geometry.ts`, `source-camera.ts`, `candidate-pipeline.ts`는 이 실험에서 수정하지 않았다.

입력은 기존 네 개발 사진의 DeepLab/MoGe/Qwen 보고서다. 독립 평가가 아니다. manifest SHA256은 `5895198660c39e3b05fb0c95d81bdda7484f5f559084e3ca35865702b79cfc13`이며 원입력·과거 보고서·버퍼 불변을 마지막에 다시 확인했다. 대조군의 바닥/벽 평면·방향군·직교쌍은 이전 저장 결과와 4장 모두 정확히 같았다.

## 같은 현재 배치 코드의 실제 재생

기준선은 같은 Qwen 관측에 기존 깊이 평면을 넣은 대조군이다. 일반 DeepLab 단독 분석이나 사용자 보정 결과와 합산하지 않는다.

| 사진 | 관측 벽 수 대조/실험 | strict 카메라 대조→실험 | 배치 대조/실험 | 선택하지 않은 실험 가설 |
|---|---:|---|---:|---|
| user-01 | 2 / 3 | estimated → held | 0 / 0 | 2개, 위치 173.38mm·회전 8.67° 차이 |
| user-02 | 3 / 2 | held → held | 0 / 0 | 직교 벽 쌍 0개 |
| user-03 | 6 / 3 | held → held | 0 / 0 | 2개, 위치 20.12mm·회전 0.493° 차이 |
| user-04 | 3 / 3 | estimated → estimated | 3 / 3 | 1개; 기존 창·거울·변기 유지 |

user-02는 문/입구 면과 실제 안쪽 벽이 비슷한 방향이다. 제외 후에도 관측한 옆벽이 없어 좌우 원점을 확정할 수 없다. 가장 먼 면을 뒤벽으로 선택하거나 화면의 문틀을 방 경계로 바꾸지 않았다.

user-03은 기존 DeepLab에 유리 후보가 없어서 유리 중첩 영역의 여러 깊이 조각이 벽으로 남았었다. Qwen의 실제 유리/거울 관측 영역을 제외한 뒤 벽 6개가 3개로 줄고, 선택하지 않은 가설 간 최대 위치 차이도 약498.54mm에서20.12mm로 줄었다. 원사진과 overlay에서 제외된 유리 영역 및 그 밖의 왼쪽/오른쪽 벽 지지를 직접 확인했다. 이는 물리 카메라 정확도 향상의 증명은 아니다.

남은 오른쪽 벽 두 조각은 방향·offset·인접성 검사 뒤 공동 재적합에서 최대잔차 **0.03789 모델m > 기존 임계 0.01772 모델m**로 병합이 거절됐다. 엄격한 카메라는 계속 보류한다. user-01도 원사진/overlay를 확인했으며, 추가 제외로 드러난 오른쪽 벽의 방향 차이가 커져 카메라가 더 보수적으로 보류되는 결과를 유지했다.

## 두 가설의 후단 배치와 투영 민감도

생산 소스를 바꾸지 않은 private 하네스에서 각 유효 벽 쌍을 **선택하지 않은 별도 실험 입력**으로 `buildCandidatePipeline`에 전달했다. user-01과 user-03은 두 가설 각각 실제 후단 배치 0개다. 새 접점이나 사용자 위치를 주입하지 않았다.

같은 명목 방 표면의 격자점을 두 카메라에 투영하고 둘 다 화면 안인 점만 비교했다. 각 카메라로 pointmap을 자기 좌표계에 되돌리는 자명한 내부 오차를 사용하지 않았다. 이 수치는 **카메라 가설에 대한 모델 민감도이며 실제 사진 모서리 정답의 재투영 오차가 아니다.**

| 사진 | 비교 표본 | 최대 / p95 차이 | 기존 corner-fit 수치 기준 |
|---|---:|---:|---:|
| user-01 | 284 | 46.99 / 30.84px | 7.686px, 초과 |
| user-03 | 165 | 2.873 / 2.091px | 7.586px, 이내 |

기준은 기존 `max(3px, 사진 대각선×0.012)` 그대로다. 수치 이내라고 strict fit을 해제하거나 물리 정확도를 인정하지 않았다.

user-03의 세면대 Qwen bbox는 볼 부분이다. 하단 중앙 `(0.3515, 0.474)`을 바닥으로 투영하면 두 가설에서 약 `[-1951,0,-657]`, `[-1966,0,-653]mm`로 방 밖에 놓인다. 기존 DeepLab의 연속 기둥 근거가 있는 끝점 `(0.356823,0.749441)`은 약 `[-945.54,0,1041.36]`, `[-946.10,0,1036.58]mm`로 방 안이며 두 위치 차이는 약4.81mm다. **끝점은 진단에만 사용했다.** 이를 모델 관측 anchor로 바꾸거나 기존 위치를 재사용해 성공 수를 늘리지 않았다. 다음 접점 개선은 같은 실물·연속 기둥·가림·잘림과 출처 검증을 그대로 보존해야 한다.

## 검증과 재현

- Python 근거 계약 테스트 13개 통과, 기존 순수 기하 self-test 4개 통과.
- 새 가설 진단 4개 + 기존 depth 기하 10개, Vitest 2파일14개 통과.
- 담당 TypeScript 3파일 scoped ESLint 통과. 전체 lint/type/test/Next/vinext는 루트 통합 검사에서 별도 판정한다.
- 실제 대조/실험 각4장 평면 재계산, 현재 배치 재생, 가설별 후단 진단이 완료됐다. 출력·소스 해시를 보존했다.
- 최초 private 가설 하네스는 상대 import 경로 오류로 실패했고 경로만 고친 뒤 통과했다. 재생 뒤 요약 표시의 Windows 인코딩 오류는 UTF-8 읽기로 해결했다. 두 실패 모두 모델 실패로 집계하지 않는다.

비공개 증거 루트는 `test-results/reconstruction-plane-evidence-20260913/`다. `inputs-manifest.json`, `control/`, `experiment/`, `placement-hypotheses/`, `pair-placement/`, `validation.json`에 입력·코드·평면·전체 후단 결과가 있다. `experiment/<id>/overlay.png`는 실제 표면 지지 그림이다. 이 실험은 새 표준 공간 PNG나 전체 Lab UI 시험을 생성하지 않았다.

```powershell
& 'C:\Users\H\miniconda3\envs\whisperx\python.exe' -B -m unittest discover -s tests -p test_reconstruction_plane_evidence.py -v
& 'C:\Users\H\miniconda3\envs\whisperx\python.exe' -B tests/reconstruction-geometry-plane-probe.py --saved-inputs-manifest test-results/reconstruction-plane-evidence-20260913/inputs-manifest.json --inventory-exclusions --merge-patches --output test-results/reconstruction-plane-evidence-20260913/new-experiment --case user-01 --case user-02 --case user-03 --case user-04
```

현재 근거는 광학 영역 혼입과 서로 다른 실패 원인을 더 정확히 드러낸다. 자동 배치 품질 개선이나 기본 엔진 채택의 근거가 확보됐다고 보고하지 않는다.