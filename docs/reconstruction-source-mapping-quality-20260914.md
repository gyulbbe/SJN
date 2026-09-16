# 사진 재구성 위치 매핑 조사와 수정 — 2026-09-14

이번 기록은 `docs/prompts/before-reconstruction-placement-quality.md`의 상류 좌표 계산 담당 결과다. 모형 수 증가나 자동 재현 성공 보고가 아니다. 실제 생성 이미지·사용자 확인 흐름·전체 빌드는 통합 검증 보고서에서 별도로 다룬다.

## 확인한 원인

1. `analysis.reviewFromSegmentation`의 바닥은 `visible-floor-region`, `depthStart=0`, `depthEnd=0.65`라는 임시 범위다. `alignedReconstructionFloor`가 윤곽과 가로 대응을 개선해도 실제 보이는 깊이 구간을 알아낸 것은 아니다. 기존 baseline `installation.mapReconstructionCandidate`는 이를 물리 방 직사각형처럼 사용했다. 후보 개선 엔진의 기존 `observed-placement`는 이미 같은 바닥을 거부하므로 두 경로의 계약도 달랐다.
2. `auto-surfaces.estimatePlaneQuad`는 텍스처 원근용 네 점이다. 최소 x+y 모서리가 물리적으로 방 뒤쪽이라는 보장은 없다. user-03 실제 raw의 첫 점 `(0.1118568, 0.9440716)`은 사진 전경인데 기존 매핑의 v=0으로 쓰였다. 임의 네 점 재정렬이나 접점 이동으로 해결하지 않았다.
3. 기존 floor 방향 추정은 bbox 중심과 겹치는 wall plane을 골랐고 appearance 영역도 포함했다. 사진에서 오른쪽에 있다는 이유로 right 방향을 사용하면 깊이 보정이 x축으로 바뀐다. 명시적 설치 벽 근거가 있을 때만 그 방향을 쓰고, 없으면 back/default로 남긴다. 사용자 확인 방향은 사진에 그 벽 평면이 없어도 유지한다.
4. `frontContactToCentre`의 부호 자체는 맞다. world +z가 앞쪽이며 local +z 앞면에서 중심으로 돌아가려면 깊이 절반을 빼야 한다. 문제는 하단 윤곽이 실제 앞쪽 접점인지, 평면 대응과 방향이 맞는지다. 부호를 반대로 바꾸거나 깊이를 없애서 범위에 맞추지 않았다.
5. 선언된 부분 back 벽에 horizontalStart/End가 있을 때 제품 폭 추정이 전체 방 폭을 곱하는 누락을 확인했다. 이제 부분 폭을 사용한다. `0.3 × (0.8−0.2) × 2400 = 432mm`는 기존 모형 10mm 단계로 430mm가 된다. 이는 입력 구간을 사용한 계산 테스트이며 사진의 실측 정답이 아니다.

## 변경한 계약

- 새 `src/lib/reconstruction/source-plane-mapping.ts`는 네 점 → 평면 좌표 → 선언한 물리 구간을 순수 함수로 변환한다. 좌우벽 깊이 방향, 뒷벽 부분 폭, 벽 부분 높이를 적용하고 clamp하지 않는다. 90/180/270도 돌아간 사진에서도 선언한 모서리 순서를 유지한다.
- `installation.ts`의 `inspectReconstructionCandidateMapping`은 `placement`와 `provisionalPlacement`를 분리한다. room-boundaries 또는 사용자 confirmed 바닥만 물리 위치 추정에 사용할 수 있다. visible-floor, 출처 없는 바닥, 잘린 하단, 평면 밖 접점은 보류한다.
- 물리 매핑을 보류해도 유한한 임시 계산은 사라지지 않는다. `index.ts`가 기존 `placementReview.requested`에 제안 규격·위치와 기본값 출처를 저장하고 `reasons` 및 `trace`에 상류 원인을 기록한다. 범위 검증이 통과해도 평면 미확정 사유는 보류 상태를 유지한다. 원사진·raw review는 바꾸지 않는다.
- 위치 수정 화면은 이 제안을 읽어 사용자 확인을 받는다. 이 경로의 결과는 사용자 확인 결과다. 실제 촬영 카메라 승인이나 자동 AI 인식으로 표시하지 않는다.
- 소스 평면 밖 수치를 경계로 옮기지 않는다. 수치적으로 무한하거나 저장 범위를 넘는 투영은 저장 불가능한 숫자를 문서에 쓰지 않고 이유와 원관측을 유지한다.

## 실제 관측 재생

입력은 `test-results/reconstruction-product-color-20260914/actual-baseline`에 보존된 다섯 장의 실제 DeepLab raw review다. 이 자료는 과거 color v6 관측이며 현재 v7 색상 관측 캐시로 자동 재사용했다는 뜻이 아니다. 이번에는 기하 변경을 검증하기 위해 명시적으로 재생했고 새 AI 추론은 하지 않았다.

순수 매핑 결과는 `test-results/reconstruction-placement-quality-20260914/source-mapping/summary.json` 및 사진별 JSON에 기록했다. 사진별 원보고서 SHA256, 원사진 지문, 후보 원래 foot/bounds/설치, 상태, 사유, 수정 없는 계산 제안을 포함한다.

| 사진 | 물리 평면 매핑 허용 후보 | 임시 제안 보존·보류 후보 |
|---|---:|---:|
| user-01 | 0 | 2 |
| user-02 | 0 | 1 |
| user-03 | 0 | 2 |
| user-04 | 1 | 2 |
| prospective-03 | 0 | 3 |

이 표는 **매핑 단계 수**다. 모형 생성·시각 정답 판정·재현 성공률과 다르다. user-04의 예전 vanity는 방 범위 안이라는 이유만으로 생성됐지만 바닥 대응 깊이는 미확정이므로 이번에는 보류한다. 이 변화는 자동 재현 개선으로 주장하지 않는다. 실제 사진의 측정된 위치 정답이 없으므로 mm 정확도, 원사진 재투영 오차도 보고하지 않는다.

## 테스트와 남은 한계

- 변경 후 관련 9개 파일 **175개 단위 테스트 통과**. 새 source-plane 26개에는 4방향 사진 회전, 부분 구간, 좌우벽 깊이, 범위 밖 좌표 보존, visible-floor 미승격, 잘린 하단, 독립 방향 근거, 사용자 방향 유지, 부분 back 폭 및 실제 5장 raw 불변을 포함한다.
- 기존 observed-placement 82개와 strict-placement 11개가 통과했다. 기존 지원 형태 테스트의 바닥은 유효 물리 평면을 뜻하도록 room-boundaries를 명시했고, 미확정 평면 보류 테스트를 별도로 추가했다. 과거 ceiling alignment 테스트도 윤곽 개선만으로 물리 깊이가 확정되지 않는다고 검사한다.
- 생성 통합 테스트의 모의 매핑은 새 inspection API 경계로 이동했다. 이 모의 테스트를 AI 검증으로 집계하지 않는다.
- 수정 파일 ESLint 오류·경고 0. 최종 전역 타입·Next/vinext·실제 생성/Review 브라우저 검사는 부모 통합 작업에서 수행한다. 초기 개발 중 테스트 실패와 이후 성공을 구별한다.
- 실제 source camera는 여전히 미확정이다. room-boundaries 자체도 관측 선과 기본 방 치수로 정한 근사이며 실측이 아니다. confirmed floor도 사용자가 지정한 대응이라는 뜻이지 자동 사진 기하 복원이 아니다.
- 바닥 접점이 사진에 잘리지 않아도 bbox 하단이 앞쪽 접점이라는 가정은 남는다. 유리·가림 뒤의 정확한 접지 윤곽과 실제 제품 치수는 현재 관측만으로 확정할 수 없다. 그림에서 필요한 위치만 확인하는 흐름과 향후 촬영 기하 검증을 구별해 평가해야 한다.
