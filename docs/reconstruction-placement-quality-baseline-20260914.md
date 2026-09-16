# 사진 → Before 배치 개선 전 동결

2026-09-14 새 개선에 들어가기 전, 기존 strict 생성기를 실제 저장 관측 5개에 다시 실행했다. 생산 소스 45개와 실행 번들을 고정하고 원사진·원보고서·관측 해시·후보별 입력과 출력·무보정 Before 및 빈 After PNG를 별도 경로에 보존했다.

실행은 새 AI 추론이 아닌 **분석 캐시 `observations-semantic-interior-color-v6` / 엔진 `deeplab-observed-v8-product-color-2026-09-14` 관측 재생**이다. 최종 색상 픽셀 정책 v7을 새로 실행한 결과가 아니다. 초기 진단 메시지에서 캐시와 엔진 revision을 혼동했던 내용은 `scope-correction.json`에서 정정했다. 사진과 raw를 수정하지 않았다.

## 실제 확인한 단계

| 사진 | 관측/현재 후보 | 자동 생성 | 주요 중단 지점 |
|---|---:|---:|---|
| user-01 | 15/15 | 0 | 변기 왼쪽 162.95mm·욕조 뒤쪽 750mm 침범. 세면대 `object-48-109079`는 검출되고 벽걸이 방식까지 제안했지만 설치 벽/높이가 미확정 |
| user-02 | 4/4 | 0 | 변기 뒤쪽 65.87mm 침범. 세면대 `object-48-50879`는 검출 후 설치 벽/높이 미확정 |
| user-03 | 13/13 | 0 | 기둥형 세면대 `object-48-54678`는 깊이 v=-0.09145와 뒤쪽 459.48mm 침범. 통합 변기는 v=-0.14167, 뒤쪽 680mm·왼쪽 73.26mm 침범 |
| user-04 | 17/17 | 2 | 창·하부장 생성. 변기는 뒤쪽 87.34mm 침범. 거울은 벽 설치 제안 이후 실제 배치 미확정 |
| prospective-03 | 13/13 | 0 | 변기 2개·욕조·거울의 물리 범위 보류. 세면대는 검출됐지만 설치 벽/지지 방식 미확정 |

침범 mm는 가정한 2400×2400×2400mm 표준 공간의 계산값이며 원사진의 실측 오차가 아니다. 기하 미확정이므로 원사진 카메라 재투영 정확도는 평가 불가다. 변기/욕조 같은 관측 라벨의 수를 실제 정답 설비 수로 세지 않는다. 약하거나 충돌하는 나머지 후보는 원래 이유와 함께 보존했다. 이번 재생에서는 관측 이후 후보가 조용히 삭제되거나, 생성된 모형이 저장 과정에서 사라진 증거가 없다. 이것이 모든 후보 판단이 정확함을 증명하지는 않는다.

## 조건과 측정

Chrome 152.0.7977.83 headless / ANGLE SwiftShader, localhost 전용 포트 43191에서 실행했다. 모델 Worker 생성·외부 요청·페이지 예외 모두 0이다. 명시적 저장·재로딩과 프로젝트 복사 시 모형 보존, 빈 After를 검사했다. 500ms 자동 저장이나 사람의 최소 보정 시간은 이 하네스에서 측정하지 않았다.

| 사진 | 생성(ms) | 합성·PNG 준비(ms) | 완료 직후 페이지 JS used heap(MiB) |
|---|---:|---:|---:|
| user-01 | 840.5 | 843.9 | 10.53 |
| user-02 | 403.6 | 678.3 | 9.81 |
| user-03 | 340.3 | 568.8 | 12.08 |
| user-04 | 568.3 | 1103.4 | 14.74 |
| prospective-03 | 296.4 | 558.6 | 10.41 |

메모리는 CDP `Runtime.getHeapUsage`의 메인 페이지 순간값이다. 다섯 사진은 같은 페이지에서 순차 실행하여 GC 시점의 영향을 받는다. 전체 프로세스·peak·GPU·모델·WASM 메모리가 아니며 사용자 최소 RAM으로 환산하지 않는다. ArrayBuffer backing storage는 별도 원기록에 남겼고 JS used heap과 혼합하지 않았다.

## 보존 위치와 재검증

- 하네스: `tests/reconstruction-placement-quality-browser.ts`
- 고정 결과: `test-results/reconstruction-placement-quality-20260914/before-run-01/`
- 원본/Before/After 비교: 위 폴더 `comparison.html`
- 소스 및 번들: `source-manifest.json`, `frozen-bundle.js`
- 후보 단계: `candidate-stage-facts.json`; 각 사진 `result.json`에는 원 planes의 `geometrySource`·quad·interval, 후보 bounds·foot·installation·trace, 원래 요청/출처·world bounds·overflow를 포함한다.
- 번들 SHA-256: `b2f759cc0d02d8b36cea775481074438b157eaafed20e8fb5ec2cfa3ef020f90`

브라우저 명령 exit 0, 신규 하네스 scoped lint·타입 검사 exit 0을 확인했다. 생산 변경이 끝나면 별도 `SJN_PLACEMENT_PHASE` 이름으로 같은 raw를 재생한다. 완료된 phase에는 덮어쓰기를 거절한다. 결과 수치가 늘어도 정확한 위치·형태·관계가 개선되었는지는 별도로 판단한다.
