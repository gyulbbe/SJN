# 저장된 모델 기하와 semantic mask의 평면 관측 실험

`tests/reconstruction-geometry-plane-probe.py`는 기존 MoGe-2 NPZ와 실제 DeepLab floor/wall 캡처만 읽는 오프라인 개발 평가다. 새로운 모델 추론, 사진 전송, 패키지 설치, 앱 연동을 하지 않는다. 목적은 보이는 면의 카메라 상대 방향·위치에 일관된 근거가 있는지 확인하는 것이다. 방의 전체 물리 모서리, 실측 크기, 제품 배치 정확도를 검증하는 도구가 아니다.

## 재현

```powershell
$probePython = 'C:\Users\H\miniconda3\envs\whisperx\python.exe'
& $probePython tests/reconstruction-geometry-plane-probe.py --self-test
& $probePython tests/reconstruction-geometry-plane-probe.py
```

기본 입력은 `test-results/reconstruction-moge2-20260913/manifest.json`, 각 사진의 `geometry.npz`와 `report.json`, `test-results/reconstruction-floor-geometry-20260913/semantic/{id}/report.json`, `floor.u8`, `wall.u8`, `photo.rgba`다. NumPy·SciPy·Pillow가 이미 설치된 환경을 쓰며 torch나 MoGe를 import하지 않는다. Python network audit guard를 적용하고 CPU 연산 스레드는 1개로 제한한다. `--geometry`, `--semantic`, `--output`, `--case`로 입력·범위를 명시할 수 있다.

결과는 `test-results/reconstruction-floor-geometry-20260913/planes/`에 저장한다. 재평가 결과를 보존하려면 별도 `--output`을 지정한다. 기본 경로를 재실행하면 그 경로의 보고서가 갱신된다. 초기 구현 검토에서 발견한 마지막 PCA 갱신 이후 inlier 불일치와 첫 가설 실패의 조기 종료는 보완했으며, 이전 산출물은 `planes-initial-before-membership-fix/`, `planes-before-ranked-hypotheses/`에 분리해 보존했다. 이들 초기 결과는 최종 평면 집계에 섞지 않는다.

## 입력 검증과 대응 관계

- 입력 사진의 SHA-256은 manifest, MoGe 실행, semantic 캡처, 현재 로컬 파일에서 같아야 한다.
- NPZ 해시는 실제 모델 실행 report와 같아야 한다. MoGe 실행 당시 스크립트 해시와 현재 파일도 같아야 한다.
- semantic 캡처가 기록한 5개 소스 해시는 평가 시작·종료에 현재 코드와 대조한다. 이를 전체 저장소 해시라고 표현하지 않는다.
- `floor.u8`/`wall.u8`는 report의 width×height, `photo.rgba`는 width×height×4 바이트를 정확히 가져야 한다. 실제 캡처는 full-frame 이미지를 mask 크기의 canvas로 축소했고 crop하지 않았다.
- semantic grid 픽셀 중심에 대응하는 원본 pointmap index는 `floor((gridIndex + 0.5) × originalSize / gridSize)`다. 모델 깊이의 객체 경계를 가로질러 보간하지 않고 가장 가까운 원본 샘플을 사용한다. 이미지 종횡비는 정수 반올림 범위 내에서 일치해야 한다.
- `intrinsics`는 정규화된 원본 내부 파라미터를 보존한다. full-frame 축소에 가로·세로 crop이나 원점 이동을 임의로 추가하지 않는다.

## 평면 추정과 출력 계약

먼저 raw semantic mask를 grid 기준 2px erode한다. 캡처에는 물체별 픽셀 마스크가 없어 **모든 관측 objects의 bounds + 2px**를 보수적으로 제외한다. bounds 안의 실제 벽·바닥도 제거될 수 있으며 제외된 양을 기록한다. 모델 유효성·finite·양의 깊이·법선 길이 및 floor/wall mask 충돌을 검사한다.

모든 사진에 동일한 개발 기준을 적용한다. 거리 threshold는 valid scene median model depth의 0.8%, 모델 법선과 plane normal의 각도 차이는 15° 이하다. 이는 실측 오차나 확률로 교정된 신뢰도가 아니다. RANSAC은 384개 3점 가설과 96개 normal-seeded 가설 등을 최대 6000개 점으로 평가한다. 상위 가설 중 방향·offset이 겹치지 않는 최대 12개를 PCA로 제한 횟수 정제한다. 첫 가설의 PCA가 실패해도 다른 가설을 확인한다. 마지막 출력 식과 inlier 집합의 일치 조건을 유지한다.

지지 픽셀 수·이미지 면적·남은 후보 대비 비율·PCA의 두 면내 분산·공간 grid 분포로 좁은 선이나 작은 조각을 구분한다. 지배적인 semantic floor plane의 카메라 쪽 normal을 `floorGravityCandidate.upCamera`로 제시하고, 이를 기준으로 벽이 수직에서 15° 이내인지 검사한다. 이것은 센서 중력이나 측정된 room up이 아니다. 바닥이 없으면 벽의 수직 관계도 미확인이다.

JSON의 각 plane에는 다음 값이 있다.

- `equation.normal`, `equation.d`: 카메라 좌표에서 `n·p+d=0`, unit normal은 카메라 원점을 향한다. 축은 오른쪽 +x, 아래 +y, 전방 +z다.
- `support.medianPointCamera`, `medianPointProjectedOntoPlaneCamera`: 대표 inlier 중앙값과 plane 위 대표점.
- `support.bboxGridPixels`, `bboxNormalized`, `robustPointBoundsCameraP2P98`: 보이는 inlier의 범위. 물리 방 전체 범위가 아니다.
- `support.pixels`, `imageAreaRatio`, `originalCandidateRatio`, 공간 grid 분포: 면을 지지하는 영상 근거의 양.
- `residual`: threshold·median·p95·max, outlier 수, 모델 법선과의 각도, PCA 분산.
- `fitDiagnostics`, `rejectedPlaneCandidates`, `unassigned.*.attempts`: 수렴 여부와 가설 실패·보류 이유.

`wallOrientationClusters`는 방향이 비슷한 관측 patch 묶음이다. `wall-1` 같은 ID는 지지 크기와 반복 추정 순서이며 back/left/right 설치 벽 이름이 아니다. 여러 patch가 한 개의 휘어진 모델 면에서 생길 수 있어 patch 개수를 실제 벽·바닥 개수로 보고하지 않는다.

`support-labels.npz`는 inlier label·정제한 후보 mask·제외 영역·원본 샘플 index·잔차를 보존한다. `overlay.png`는 원본, 후보/설비 제외, inlier, 잔차를 나란히 보여준다. 원본 사진이 포함되므로 공개 문서에 그림을 복사하지 않는다.

## 2026-09-13 최종 저장 결과

최종 실행은 8장 모두 `evaluated`, errors=[]이며 offline 수치 계산·저장 총 5.811s였다. 모델 실행 시간은 포함되지 않는다. 입력 해시·캡처 소스 해시가 맞고, 저장된 NPZ 8개를 별도로 다시 읽어 inlier 수·잔차·15° 법선 조건·제외 영역과 겹치지 않음·대표점의 평면 식 일치를 확인했다. 합성 검사 4개는 이상치가 섞인 바닥, 직교 벽, 바닥을 벽으로 잘못 채택하지 않음, 해상도 대응을 확인한다.

| 사례 | floor patch | wall patch | wall 방향 묶음 | 수치상 floor + 직교 wall pair |
| --- | ---: | ---: | ---: | --- |
| user-01 | 2 | 2 | 2 | 있음, 주쌍 84.44° |
| user-02 | 2 | 3 | 2 | 없음 |
| user-03 | 1 | 6 | 3 | 있음, 주쌍 78.45° |
| user-04 | 1 | 3 | 2 | 있음, 주쌍 89.891° |
| bath-20 | 1 | 4 | 2 | 있음, 작은 문/인접 공간 patch 포함 |
| bath-22 | 1 | 5 | 3 | 있음, 거울 오염 가능 |
| bath-27 | 3 | 1 | 1 | 없음, 유일 wall patch가 욕조 몸체 |
| bath-31 | 3 | 4 | 4 | 없음 |

사용자 4장은 이미 개발에 사용한 사진이고, bath 4장은 재사용한 기존 회귀 사진이다. 새 미공개 홀드아웃이 아니다. 수치 조건을 통과한 5/8을 공간 재구성 또는 카메라 보정 성공 5/8로 보고하면 안 된다.

## 직접 확인한 한계와 후속 실험

8장 최종 overlay를 직접 확인했고, 비공개 `planes/visual-review.json`에 관측과 의심 patch ID를 기록했다. 이 기록은 모델 출력이나 사용자 보정이 아닌, 평가자의 육안 검토다.

- user-04의 넓은 `floor-1`, `wall-1`, `wall-2`는 이번 자료 중 source-camera 실험의 가장 분명한 출발점이다. 공통 룸으로의 회전·원점·scale·제품 크기·bbox 일치는 여전히 별도 검증이다.
- user-01은 mirror detection의 전체 범위가 부족해 일부 왼쪽 wall inlier가 반사 영역을 포함한다. 수치상 두 벽 방향이 있어도 그대로 room boundary로 사용할 수 없다.
- user-02는 입구·바깥쪽 면과 뒤벽이 비슷한 방향으로 나타난다. 사진 좌우를 설치 벽으로 강제하지 않는다.
- user-03은 유리 파티션 부근에서 깊이/normal이 여러 patch로 나뉜다. 주벽 각도도 90°와 약 11.55° 다르다. 이 오차를 없애기 위해 사진별 좌표를 보정하거나 무조건 직각으로 clamp하지 않는다.
- bath-20의 두 번째 방향에는 작은 문틀·인접 공간 조각이 포함되고 바닥도 출입구를 가로지른다. 같은 방의 모서리라는 근거가 부족하다.
- bath-22는 거울 위쪽·반사 영역이 semantic wall로 남아 plane 가설에 섞였다. 직교 조건만으로 이 후보를 채택하면 반사를 방의 벽으로 만들 수 있다.
- bath-27은 검출하지 못한 욕조 몸체가 semantic wall로 남고 유일한 wall patch를 만들었다. 작은 잔차·일관된 normal은 물체의 의미를 검증하지 못한다.
- bath-31은 기둥과 여러 샤워 면이 보이지만 공간의 독립적인 두 벽 방향을 확정하지 못했다.

후속 source-camera 후보는 실제 wall/floor 역할, 거울·유리 제외, 충분한 영상 지지, 모델 기하 왜곡을 함께 검토해야 한다. pointmap과 normal은 같은 모델에서 나온 추정이며 독립적인 실측 증거가 아니다. 관측 patch에서 찾은 교선·교점을 안 보이는 물리 방 전체 모서리로 승격하지 않는다. 최소 사용자 확인이 필요하면 해당 plane 역할·공간 기준을 명시해 확인하고 AI 관측과 따로 남긴다.