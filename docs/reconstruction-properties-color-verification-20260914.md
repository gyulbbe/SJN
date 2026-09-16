# Before 속성의 색 근거 보존 검사

2026-09-14. 별도 로컬 브라우저 하네스에서 실제 `ReconstructionProperties`, 표준 모형 렌더러, editor store와 IndexedDB 저장소를 사용했다. 입력은 직접 만든 시험 변기이며 실제 AI 인식 결과가 아니다. 사진 인식·모델 다운로드·외부 통신 없이 UI와 저장 동작을 검사한다.

새 [브라우저 검사](../tests/reconstruction-properties-color-browser.ts)는 다음12항목을 통과했다.

- 조명색 때문에 기본색을 사용한 상태에서 가로만 수정해도 원색·기본색·확인 필요·출처가 유지된다.
- 색을 직접 지정하면 `color/appearance`가 `user`이며 원 관측색은 유지된다.
- 직접 지정한 색에서 높이만 바꿔도 색 증거 전체가 동일하다.
- 실행 취소·다시 실행은 높이와 색 증거를 정확히 복원한다.
- 중립 기본색을 명시적으로 선택하면 자동 기본값이 아닌 `user` 확인으로 기록된다.
- 그 상태에서 깊이를 수정해도 사용자 색 증거가 동일하다.
- 미적용 색 선택을 취소하면 문서 revision과 실제 색이 바뀌지 않는다.
- Before review 후보의 색 증거가 실제 fixture와 일치한다.
- 실제 저장소에 쓰고 페이지를 새로고침한 후 다시 읽어도 색 증거·기하·실행 취소 기록이 유지된다.
- 최초 불변 자재 버전은 수정되지 않는다.
- After는 계속 빈 상태다.
- 390px 화면에서 가로 넘침이 없으며 실제 화면을 확인했다.

첫 실행의 프로젝트 ID는 `926547d9-419d-47f0-ac8d-e23c84bb92b2`, 저장한 Before 이력은5개였다. Chrome152 headless/SwiftShader에서 페이지 오류·외부 요청·Worker 생성은0이며 검사 전후 대상 소스 해시도 같다. 하네스가 실제 repository 저장을 명시적으로 호출한다.500ms 자동 저장 타이머를 검증한 것으로 확대해 설명하지 않는다.

[첫 실행 결과](../test-results/reconstruction-properties-color-20260914/verification.json), [새로고침 후 화면](../test-results/reconstruction-properties-color-20260914/properties-after-reload.png), [모바일 화면](../test-results/reconstruction-properties-color-20260914/properties-mobile.png).

새 [기둥 보정 helper 검사](../tests/reconstruction-lab-pedestal-corrections.test.ts)는10개를 통과했다. 기둥형 세면대에서만 원형/사각형 단면을 적용하고, 종류나 지지가 바뀐 뒤 남은 선택·잘못된 enum은 명시적으로 거부한다. 오탐으로 제외된 후보는 적용하지 않고, 삭제한 후보의 보정을 다른 후보에 붙이지 않는다. 제출 스냅샷과 나중 수정 상태도 분리된다. 원모델의 세면볼 사각형 관측을 기둥 단면으로 추론하지 않는다. 이 helper 검사는 Lab 화면의 undo 버튼을 클릭한 검사가 아니며 스냅샷 독립성을 검증한다.

관련 단위37개(기둥10·Lab교정8·제품색19)와 새 두 테스트 파일의 ESLint가 통과했다. 제품 색 품질 검증은 [별도 보고서](reconstruction-product-color-results-20260914.md)를 따른다. 흰색/파란색은 실제 사진 관측을 사용했고, 회색/검정 보존은 합성 단위 검사라는 구분을 유지한다.


## strict 배치 정책 이후 재검증

같은 브라우저 검사를 `SJN_PROPERTIES_COLOR_RUN=strict`로 새 폴더에 다시 실행해12항목 모두 통과했다. `projection.ts`와 `strict-placement.ts`를 포함한8개 소스 해시를 실행 전후 확인했고 모두 동일했다. 저장 프로젝트 `f0cc2fb7-37f3-4732-99d2-67adb183e946`를 실제 페이지 새로고침 뒤 다시 읽었으며 `placementPolicy=preserve`, 가로420·높이810·깊이690mm와 원 관측색 `#8a7767` 및 사용자 확인색 근거가 유지됐다. 이 규격은 시험 입력이며 실측값이 아니다.

페이지 오류·외부 요청·Worker 생성0, 이력5개, 빈 After 유지. 새 테스트의 scoped ESLint·타입 검사도 다시 종료0을 확인했다. 첫 실행 자료는 변경하지 않았다.

[strict 이후 검증 JSON](../test-results/reconstruction-properties-color-20260914/run-02-preserve/verification.json), [새로고침 후 화면](../test-results/reconstruction-properties-color-20260914/run-02-preserve/properties-after-reload.png).
