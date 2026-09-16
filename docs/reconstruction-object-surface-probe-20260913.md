# 4장 실제 semantic labels + MoGe 제품 표면 진단 (2026-09-13)

## 검증 범위

현재 앱의 물체 배치나 크기를 변경하지 않은 개발 진단이다. 기존 4장 사용자 사진에서 새로 실행한 DeepLab 첫 전체사진 추론의 라벨을, 이미 저장된 MoGe pointmap 및 이전 Qwen 관측과 결합했다. 새로운 Qwen/MoGe 호출, 모델 다운로드, 외부 전송은 없었다. 4장은 개발에 사용한 사진이며 미사용 홀드아웃이 아니다. 자동 배치 정확도·실측 크기·완성된 Before를 입증한 결과가 아니다.

- 새 캡처: `test-results/reconstruction-object-surfaces-20260913/labels/user-01..04/`
- 표면 결과: `test-results/reconstruction-object-surfaces-20260913/surfaces/user-01..04/report.json`
- 집계: `test-results/reconstruction-object-surfaces-20260913/surfaces/summary.json`
- 시각화: 각 `overlay.png`, `overlay.jpg`; `surfaces/contact-sheet.jpg`
- 재사용 가능 점: 각 `surface-points.npz`의 candidate별 semantic grid index, label, camera points/normals와 eligible한 경우 world points/normals

실제 브라우저 4장 캡처와 오프라인 4장 분석 모두 exit 0. 각 보고서 input SHA-256은 원본 파일·manifest·MoGe·배치 실험 입력과 일치한다. 라벨 SHA, NPZ SHA, 캡처한 6개 소스 SHA도 확인했다. `labels == 4`가 이번 floor mask와 일치하며, 이전 캡처와 이번 캡처의 floor/wall 배열은 4장 모두 바이트 단위로 동일했다. 따라서 이번 opt-in 라벨 출력이 기존 floor/wall 결과를 바꾸지는 않았다. 이 확인은 다른 모든 앱 동작의 회귀 검증을 대체하지 않는다.

user-02는 semantic 512×313에서 원본/MoGe 600×367로 픽셀 중심을 매핑했다. 나머지는 같은 크기다. 내부 재투영 오차 최대 0.000087 px 미만은 그리드 계약 확인일 뿐이며, MoGe `force_projection`이 만드는 내부 일관성으로서 깊이 정확도의 증거가 아니다.

## 구현된 작은 캡처 계약

`src/lib/segmentation/index.ts`와 `worker.ts`에 `captureSemanticLabels?: boolean`을 추가했다. 명시적으로 켠 호출에만 `semanticLabels?: Uint8Array`를 반환한다. 이미 존재하는 첫 전체사진 추론 배열을 worker transfer에 포함하며 일반 호출에는 결과로 보존하지 않는다. reconstruction 모드의 flip/crop 패스는 해당 옵션을 받지 않는다. 기존 captureBasins 및 취소 경로는 유지했다.

관련 검증은 `tests/segmentation-cancellation.test.ts` 8 passed, 수정 TS 파일과 새 브라우저 harness의 scoped ESLint exit 0이다. 이번 하위 작업에서 전역 tsc/build는 실행하지 않았다.

## 표면 선택 규칙

[공식 DeepLab ADE20K 라벨](https://github.com/tensorflow/tfjs-models/blob/master/deeplab/src/config.ts)에 따라 cabinet=11, sink=48, toilet=66, bathtub=38, shelf=25, door=15를 사용했다. vanity는 11과 48을 별도 부품으로 보고한다. cabinet 아래의 bathtub 오분류를 임의로 vanity에 합치지 않았다.

Qwen bbox는 후보와 픽셀을 연결하는 제한 영역일 뿐이다. 그 안의 같은 종류 라벨만 사용하고, 거울·창·유리 후보 박스와 겹치는 픽셀은 보수적으로 제외했다. 부품별 1 px erosion, 16 px 미만 연결성분 제거, 유한 좌표·법선·깊이 확인, 국소 깊이 불연속 제거를 동일하게 적용했다. 원시 min/max와 p2–p98 범위 및 법선 방향 분포를 함께 저장했다. 6축 법선 구간은 관찰용 집계로, 물체 자세를 축에 맞추거나 평면 존재를 보증하지 않는다.

원본에 표시되지 않은 반사/유리는 여전히 오염 가능성이 있다. 유리 앞의 실제 물체라도 유리 박스와 겹치면 제외될 수 있다. 라벨은 인스턴스 정답이 아니므로 같은 종류의 여러 물체가 한 박스에 들어오면 이 규칙만으로 분리하지 못한다. 가려진 뒷면·전체 제품 치수·중심점은 보충하지 않았다.

## 4장 결과

| 사진 | 좌표 사용 | 같은 종류 표면으로 남은 점 | 하단 중앙의 실제 라벨 및 제한 |
|---|---|---|---|
| user-01 | estimated camera의 model-world | 변기 13,257 / 세면대 622 / 욕조 6,673 | 변기=바닥, 세면대=벽, 욕조=욕조. 선반은 일치 라벨 0. 세면대는 유리 중첩 제외 후 일부만 남음. |
| user-02 | camera-space만 | 변기 8,315 / 세면대 3,073 | 변기=변기, 세면대=벽. 문은 일치 라벨 0. 방 카메라 보류 상태를 해제하지 않음. |
| user-03 | camera-space만 | 변기 3,765 / 세면대 6,294 | 변기=바닥, 세면대=세면대. 변기는 뚜껑 일부만 분류되고 하부/그릇 대부분 누락된 것이 overlay에서 보임. |
| user-04 | estimated camera의 model-world | 변기 5,743 / 하부장 세면대 23,824 | 변기와 하부장 하단 중앙 모두 바닥. 하부장 몸체 20,909 + sink 2,915. |

4장 원본/표면/법선 overlay를 직접 확인했다. user-03 변기처럼 점이 존재해도 제품 전체가 잡힌 것은 아니다. user-01 욕조의 모델 world robust z 최소는 약 -117 mm로 방 경계와 충돌한다. 카메라가 estimated라는 상태만으로 안정적인 방 정렬을 입증하지 못한다.

## user-04에서 확인한 핵심 원인

Qwen vanity bbox 하단 중앙 `(0.2, 0.952)`은 semantic `(89,425)` 픽셀에서 label 4, 즉 바닥이다. 같은 종류 표면 픽셀에 속하지 않는다. 이 위치에서 기존 카메라 ray와 floor를 교차한 anchor는 모델 좌표 약 `[-759, 0, 2146] mm`이다. 이 점을 제품 중심으로 해석하는 것은 별도 가정이다.

선택된 하부장+sink 표면의 model-world p2–p98 범위는 x `[-1161,-547]`, y `[136,891]`, z `[350,2186] mm`이다. 보이는 표면은 Z 방향으로 길게 이어진다. 법선은 +Z 방향 63.5%, +X 26.3%, +Y 5.4%이며, overlay에서 각각 큰 앞 끝판·길게 이어진 옆면·상부 표면과 대응한다. bbox 하단 anchor의 z=2146은 앞 끝판 근처에 있다.

따라서 하단점 하나를 중심으로 놓고 기본 yaw를 적용하는 방식이 잘못된 배치를 만드는 원인이라는 독립 픽셀 근거가 있다. 그러나 이 범위를 실제 제품의 길이·깊이·높이로 바로 채택하면 안 된다. 가림·분류오류·모델 깊이·방 정렬 오차가 남는다. 제품 표면과 지지면, 끝판/전면 방향, 기본 규격 또는 사용자 확인값을 함께 검증하는 다음 단계가 필요하다. 사진별 상수나 방 경계 clamp로 이 사례를 통과시키는 것은 검증 결과에 해당하지 않는다.

## 재현 명령

기존 설치된 Python 환경만 사용한다. 첫 명령은 앱에 포함된 DeepLab의 로컬 브라우저 추론이며, 두 번째는 저장된 파일만 읽는 오프라인 계산이다. 결과 경로는 git ignored private test-results다.

```powershell
$env:SEMANTIC_LABELS_MANIFEST='test-results/reconstruction-object-surfaces-20260913/manifest.json'
node tests/run-browser-test.mjs tests/reconstruction-semantic-labels-browser.ts
$env:PYTHONUTF8='1'
& 'C:\Users\H\miniconda3\envs\whisperx\python.exe' tests/reconstruction-object-surface-probe.py
```

소스 해시가 달라진 상태로 이전 라벨을 현재 코드 결과처럼 사용하지 않도록 오프라인 스크립트는 캡처 6개 소스와 현재 파일이 다르면 중단한다. 카메라는 저장된 `placement/user-01..04/report.json`의 SHA로 식별하며, user-01/04만 해당 실험의 estimated camera로 좌표 변환한다. user-02/03에는 world 좌표를 생성하지 않는다.