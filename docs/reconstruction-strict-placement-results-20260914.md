# 사진 재구성의 숨은 위치 변경 제거

2026-09-14. 목표의 ‘벽 침범을 감추기 위한 강제 이동·축소 금지’에 대한 제한된 변경이다. 새 AI 모델이나 촬영 카메라 추정은 추가하지 않았다.

## 확인한 원인과 수정

- `src/lib/reconstruction/index.ts`의 `estimateCandidateFixture`가 관측 접점을 제품 중심으로 변환한 뒤 바닥 위치를 다시 fit하고 벽 설치 높이를 방 안으로 clamp했다. 지금은 원래 추정 중심·기본 규격·관측 높이를 그대로 유지한다.
- `createReconstructionFixture`는 별도로 폭/높이/깊이를 축소하고 u/v/설치 높이를 움직였다. 사진 생성과 Before 속성 확정은 `placementPolicy: preserve`로 원래 값과 실제 모형 bounds를 검사한다. 실패한 사진 후보만 held로 보존하고 다른 후보 생성을 계속한다. 저장·렌더 실패는 기하 보류로 삼키지 않는다.
- `src/lib/reconstruction/projection.ts`도 바닥 모형을 다시 fit했다. 저장된 preserve 플래그가 있는 제품의 재투영은 u/v/scale을 바꾸지 않는다. 일반 직접 모형 추가의 기존 기본 fit은 유지하며 과거 저장 자료를 읽기만으로 변환하지 않는다.
- `strict-placement.ts`는 요청 위치·규격·출처, world bounds, 방향별 넘침과 보류 이유를 저장한다. 이 검사는 명목 표준 모형이 입력한 방 안에 있는지 검사한다. 실제 촬영 카메라가 없으므로 projectedBounds나 bboxErrorPx를 만들지 않는다. 기존 1mm 이하 수학적 경계 오차 허용은 좌표를 옮기지 않는다.
- `ReconstructionReview` 후보는 위치/규격/설치 높이/바닥 방향을 직접 바꿀 수 있다. 벽 높이와 v는 한쪽을 편집할 때 서로 맞춘다. 종류·세면대 설치 방식 변경은 새 기본 제안으로 명시 초기화하며 이후 입력을 실제 생성에 전달한다. 위치만 바꿔도 폭·높이·깊이 전체를 user로 올리지 않고 축별 출처를 유지한다.
- NaN/Infinity/저장 schema 범위 초과는 문서에 기록하지 않는다. 로컬 입력과 오류를 남기고 마지막 유효 보류 제안 및 저장본을 유지한다. 유효하지만 방 밖인 유한 제안은 보류로 저장한다.

## 실제 저장 관측 5장 재생

입력은 `reconstruction-product-color-20260914/manifest.json`의 원사진 5장과 `actual-baseline/{case}/baseline.json`의 실제 rawReview다. 각 원사진 SHA와 원관측 전체 내용·보고서 SHA를 확인했다. 첫 실행과 최종 provenance 추가 실행을 별도 폴더로 보존했다.

최종 근거: `test-results/reconstruction-strict-placement-20260914/run-02-provenance/summary.json`. 이는 원래 모델이 생성한 관측의 **재생**이며 새 AI 실행, 사용자 위치 수정, 카메라 복원 또는 최신 색상 정책 재추론 결과가 아니다. source raw는 당시 색 관측 v6이고 최종 색 정책 v7 자동 캐시로 승격하지 않는다.

| 사례 | 과거 배치 | 현재 무보정 배치 | 새 보류 | 원요청에서 확인한 대표 문제 | 생성/PNG 준비 시간 |
|---|---:|---:|---:|---|---|
| user-01 | 2 | 0 | 2 | 변기 왼쪽162.95mm, 욕조 뒤750mm 침범 | 741.1/644.6ms |
| user-02 | 1 | 0 | 1 | 변기 뒤65.87mm 침범 | 297.3/547.4ms |
| user-03 | 2 | 0 | 2 | 변기 뒤680mm·왼쪽73.26mm, 세면대 뒤459.48mm 침범 | 282.7/533.8ms |
| user-04 | 3 | 2 | 1 | 변기 뒤87.34mm 침범 | 568.6/1094.6ms |
| prospective-03 | 4 | 0 | 4 | 변기 오른쪽680mm, 욕조 뒤489.56mm, 추가 변기 뒤466.51mm, 거울 앞121mm 침범 | 303.6/514.2ms |

수치는 입력 방과 명목 모형의 물리 경계 차이이며 실제 원사진 제품 위치의 오차가 아니다. **자동 배치가 개선됐다고 보고할 수 없다.** 기존 보정이 큰 추정 오류를 가렸고 이제 10개 후보에 확인이 필요하다는 의미다. 아무 수정 없이 새로 실행했을 때 빈 모형 공간이 더 많아지는 한계도 남는다. 개선 후보의 사용자 보정 결과는 별도 경로로 평가한다.

Chrome 152, Windows, headless ANGLE SwiftShader, 1200×800 PNG, 같은 2400mm 기본 공간. 시간은 캐시된 실제 관측의 생성·렌더 시간이며 AI 처리 시간/사람 보정 시간/GPU 실기기 성능이 아니다. 이 검사에서 메모리 peak는 측정하지 않았다.

5개 모두 IndexedDB 저장→재로드 시 후보 검토·fixture geometry 동일, 프로젝트 복제 시 설비 보존, 공통 Before/After 렌더, After의 설비·적용 자재 없음, 원사진·raw 관측 불변을 확인했다. page errors/Worker/외부 요청은 모두0이다. PNG에는 편집 컨트롤이 없다. 개별 before.png/after.png가 같은 결과 폴더에 있다.

## 검사와 남은 확인

- `tests/reconstruction-strict-placement.test.ts`: 11개. 원좌표/규격 보존·실제 범위 보류·wall v/높이 불일치·source reprojection 수치 없음·저장된 재투영 불변·축별 출처·NaN/Infinity/1e9 저장 금지.
- `tests/reconstruction-generation-v2.test.ts`: 14개. 기존 거울/위생도기/사각 기둥 검사에 strict 생성·사용자 높이/치수·수동 직접 추가 호환 4개 추가.
- `tests/reconstruction-pipeline-integration.test.ts`: 8개. 모델/렌더 경계 mock 단위 검사라는 점을 유지한다. 유효·범위 초과 candidate plan 동시 입력 시 원제안 held와 독립 후보 정확 생성 검사 추가.
- `tests/reconstruction-observation-cache.test.ts`: 11개. 최신 색 관측 v7만 자동 재사용하고 실제 구형 v6 형식 key, 다른 모델/모델 revision/prompt/출력 계약/설정/사진/방 조건 및 historical-correction은 차단한다.
- 관측 cache와 출력 revision은 분리했다. 출력 baseline v9/candidate v12가 현재이며 관측 v7 정책을 고정한다. 제한된 동등 revision만 허용한다. 미래 모든 출력 변경에서 자동 호환됨을 보장하지 않는다. 과거 보고서의 revision은 수정하지 않았다.
- 관련 52개 단위와 scoped ESLint를 통과했고 `tsc --noEmit --incremental false` exit0을 확인했다. 프로젝트 전체 lint/단위·Next/vinext 검사와 실제 raw 후보를 사용한 Review UI 입력→추가→저장 검사 결과는 최종 루트 보고에서 합친다.
- Supabase 타입·검증 schema는 확장했으며 실제 서버 연결·배포는 실행하지 않았다.

## 남는 제품 한계

보류 사유와 간단한 수정을 제공해도 원사진 위치를 자동 복원한 것은 아니다. 일부 source floor/벽 범위와 접점-제품 중심 해석은 여전히 불확실하다. 원래 카메라와 비교용 공통 카메라가 다르고 단일 사진의 실제 크기·숨은 형상·제품 단면은 확정할 수 없다. 다음 실험은 해당 관측의 의미와 신뢰 가능한 설치 기준을 더 확보해야 하며, 빈 결과를 숨기기 위한 좌표 재클램프나 사진별 고정값으로 되돌리지 않는다.
