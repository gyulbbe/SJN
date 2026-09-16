# 기본 분석의 바닥 설비 규격 수정 — 2026-09-13

기본 분석에서 가까운 벽의 homography를 바닥 체적 설비의 외곽 사각형에 적용하던 공통 오류를 수정했다. 벽에 놓인 점을 위한 투영은 벽에서 떨어진 변기·욕조·하부장의 실제 크기를 측정하지 못한다. 모델 교체나 사진별 좌표 수정은 없다.

## 실제 네 사진의 수정 전 상태

최신 보존 실제 분석은 `test-results/user-reconstruction-improvement-20260913/after-installation-shape-final/`의 baseline v5다. 현재 코드가 이미 v6 이후라는 이유로 해당 사진을 다시 분석한 v6 결과처럼 부르지 않는다. 원사진과 실제 출력 PNG를 확인했다.

| 사진 | 실제 기본 분석 배치 | 관측과 보류·형태 상태 |
|---|---:|---|
| user-01 | 변기·욕조 2개 | 세면대 후보는 검출되고 wall 방식으로 추정됐으나 실제 설치 벽과 높이 미확정으로 보류. 거울도 검출 후 보류. 유리·벽 선반·거울 수납장 별도 후보는 없음. 욕조의 오른쪽 방향은 기존 규칙 추정이며 실측이 아님. |
| user-02 | 변기 1개 | 둥근 세면볼 형태 `semantic-contour` 관측은 보존됐지만 설치 벽 미확정으로 세면대·거울 보류. 원사진의 열린 변기는 자동 열림 조합 근거가 부족해 closed/default로 출력됨. |
| user-03 | 변기·기둥 세면대 2개 | 실제 지지대와 RGB 윤곽 근거로 사각 기둥형/inferred, 변기 조합 근거로 open/inferred. 설치 좌표는 기본 공간의 규칙 추정이며 원사진 구도를 그대로 복원한 결과가 아님. 유리·상부 거울 등 전체 설비는 재현되지 않음. |
| user-04 | 창·하부장·변기 3개 | 후면 창은 관측 벽에서 배치. 하부장은 왼쪽 방향/inferred, 볼 1개/round는 default이며 실제 사진의 두 볼을 인식한 결과가 아님. 왼쪽 거울은 검출 후 실제 벽 미확정으로 보류. 변기 전체 규격만 벽 투영 때문에 과장됨. |

원본에서 확인하기 어려운 설치 치수를 측정했다고 하지 않는다. 특히 거울 수납장은 사용자01의 기존 설명을 별도 근거로 하며, 사진만 보고 두께·문 개수를 단정하지 않는다. 모델 누락과 검출 이후 설치 보류를 분리한다.

## 수정

`src/lib/reconstruction/index.ts`의 `estimateCandidateFixture`는 이제 바닥에 배치할 설비의 width/height/depth를 종류별 기본값으로 유지한다. 현재 baseline 관측 계약에는 검증된 체적 규격 관측 필드가 없다. 기본 공간 치수와 임의의 가까운 벽이 있다는 이유로 제품 규격을 실측처럼 환산하지 않는다.

- 바닥 설비의 집계 `provenance.dimensions`와 개별 `width/height/depth`는 `default`로 기록한다. 편집 가능한 기본값이며 상품 규격 검증값이 아니다.
- 직접 사용자 규격은 별도 수동 계획/기존 설비 편집 경로로 유지한다. 저장된 장면과 불변 자재 버전을 읽기만으로 재계산하거나 덮어쓰지 않는다.
- 벽면 모형은 기존의 근거 있는 평면 크기 추정을 유지한다. 마감 일부 영역만 있는 경우의 기본값과 세면대 별도 기본 규격 정책도 유지한다.
- 색상·마감·세면볼 형태·개수·변기 뚜껑·설치 방향·보류 판단은 변경하지 않았다. 깊이가 달라지면 기존 접점→중심 계산 및 공간 경계 정규화에 의해 중심 위치가 함께 조정될 수 있다.

수정 전 user04 변기는 **510×990×870mm / inferred**, 수정 후 **400×750×680mm / default**다. 이는 맞는 실제 규격을 알아낸 결과가 아니라 근거 없는 확대를 제거한 결과다. 규격 때문에 바닥 중심 v는 .18125→.1416667로 변했다. 기존 fit의 뒤쪽 경계 정규화가 적용된 결과이며 사진 속 접점 보정이나 정확한 위치 복원으로 해석하지 않는다.

## 실제 동일 관측 재생

`node --experimental-strip-types tests/reconstruction-floor-dimensions-browser.ts`가 네 사진의 저장된 실제 rawReview를 수정 직전/직후 추정기에 동일하게 제공했다. 직전 `index.ts`를 비교 폴더에 보존하고 esbuild에서 해당 파일만 과거 코드로 읽었다. 나머지 공통 renderer와 생산 생성 코드, 사진 바이트와 방 치수는 동일하다. 새 DeepLab/Qwen 실행은 하지 않았다.

- 네 건 모두 실제 production `createReconstructionProject`와 현재 공통 renderer로 1200×800 PNG 생성 성공.
- 배치 수 **2/1/2/3**, 후보별 status/requiresReview와 보류 목록이 전후 동일. 원 rawReview, 과거 저장 프로젝트와 불변 자재 버전은 변경되지 않았다. 별도 localhost IndexedDB에서 이전 생성 저장본을 후속 생성 뒤 다시 읽어 비교했다.
- user01/02/03 전후 PNG의 모든 RGBA 채널 차이 **0**. user04만 변경됐으며 3,840,000채널 중45,105채널 차이가 있었다. 창·하부장의 규격과 색, 타일 등 입력은 같고 변기 크기·그에 따른 그림자/가림 영역이 바뀐다.
- 실제 PNG를 확인했을 때 user04 변기가 하부장보다 과장돼 보이던 크기가 줄었다. 원사진과의 설치 구도, 두 볼 누락, 닫힌 변기 기본 상태 등의 남은 차이는 해결하지 않았다.
- 새 Worker는 검사에서 차단했고 HTTP/Blob 요청은 localhost 읽기뿐이다. 모델 호출·다운로드·외부 사진 전송0회. Chrome headless + SwiftShader의 생성/렌더 검사이며 성능 비교나 실제 AI 정확도 재평가가 아니다.

[네 사진 비교](../test-results/reconstruction-baseline-floor-size-20260913/comparison.html) · [검증과 코드 해시](../test-results/reconstruction-baseline-floor-size-20260913/verification.json) · [픽셀 차이](../test-results/reconstruction-baseline-floor-size-20260913/pixels.json) · [user04 수정 후 PNG](../test-results/reconstruction-baseline-floor-size-20260913/user-04/after.png).

## 검사와 남은 범위

`tests/reconstruction-floor-dimensions.test.ts` 신규9개 포함, volume/supported-placement/v2/toilet-lid/lab-bath-rim **6파일60개 통과**. 기존 volume 검사가 요구하던 '바닥 하부장 크기를 배경 벽으로 환산' 기대값은 수정된 물리적 의미에 맞춰 교체했다. 알려진 벽의 창 크기는 계속 변하고, 마감 영역만으로 창을 측정하지 않으며, 사각 볼 관측은 크기 기본값과 독립적으로 유지되는지 검증했다. 담당4파일 ESLint 통과. 루트가 baseline/cache revision을 각각 `deeplab-observed-v7-floor-size-default-2026-09-13`, `structured-scene-v9-floor-size-default-1`로 갱신했다. 기존 실제 보고서의 실행 revision은 변경하지 않았다. 전역 타입·Next/vinext는 루트 통합 검사 대상이다.

일부 바닥 관측의 접점·공간 기하는 여전히 불확실하며, 기존 정규화로 제품이 뒤 벽 가까이 몰릴 수 있다. 이 수정은 기하 보류를 숨기거나 타일 줄눈에서 제품 실측값을 새로 만들어내지 않는다. 다른 종류를 새로 인식하거나 표준 모형 자체의 세부 형상을 개선한 작업도 아니다. 일반 편집기의 사용자 규격, 기존 프로젝트의 저장된 외형과 제품 이미지/TripoSR/배경 제거는 그대로다.
