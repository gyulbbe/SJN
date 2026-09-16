# 실제 보류 후보의 사용자 확인·추가 검증

2026-09-14, Chrome 152.0.7977.83 headless / SwiftShader에서 확인했다. 생산 `ReconstructionReviewPanel`, `createReconstructionProject({ reuseAnalysis })`, IndexedDB 저장소를 사용한 독립 브라우저 하네스다. Next 개발 서버나 사용자 브라우저 저장소에는 접근하지 않았다.

## 입력과 범위

- 원사진: 사용자가 제공한 `test 화장실3.jpg` (SHA-256 `0f2a7196a8e307926654990c9cbafa843b518e8043e99ce35ad441a960c6e77b`).
- 관측: 기존 실제 DeepLab 실행의 `test-results/reconstruction-product-color-20260914/actual-baseline/user-03/baseline.json` 안 `rawReview`. 파일 SHA-256 `3d93734a2bc163052577697aeb7d5d511190b30a9d92d3e979e63b0cb7ae4234`.
- 추가 추론 없이 저장된 관측을 재생했다. 위치·종류·치수 수정은 브라우저에서 명시적으로 입력한 사용자 행동이다. 이 결과를 자동 인식 또는 자동 배치 성공으로 보지 않는다.
- 색상은 이 관측 기록의 증거가 추가·저장 과정에서 유지되는지만 검사했다. 최신 픽셀 추정 품질 검증은 별도 `reconstruction-product-color-results-20260914.md`를 따른다.

## 통과한 동작

1. 실제 관측을 다시 구성한 최초 Before의 배치 모형은 0개이고, 변기와 세면대가 위치 보류 후보로 남는다. 원래 제안의 위치·치수가 입력창에 그대로 표시된다.
2. 변기 가로 위치에 `1e9%` 또는 빈 값을 입력해 추가하면 명확한 오류가 발생한다. 편집 revision과 전체 후보 문서는 변하지 않는다.
3. 변기 위치만 가로·깊이 50%로 고쳐 추가하면 400×750×680mm와 각 치수의 `default` 출처가 유지된다. 위치만 `user`가 되고 `placementPolicy: preserve`가 저장된다.
4. 세면대 폭에 먼저 입력한 값은 종류를 하부장으로 바꾸면 기본 제안으로 초기화된다. 다시 세면대·벽걸이형으로 선택하면 그 설치 방식의 기본 제안이 표시된다.
5. 그 뒤 가로 37%, 폭 620mm, 설치 높이 680mm를 입력하면 해당 값으로 추가된다. 폭은 `user`, 수정하지 않은 높이 320mm·깊이 450mm는 `default`로 유지된다.
6. 두 모형을 추가한 뒤 원본 raw 관측은 변하지 않는다. 의도한 두 잘못된 입력 외에는 응용 오류가 발생하지 않는다.
7. 명시적 저장소 저장 후 실제 페이지를 새로고침하여 다시 읽으면 모든 모형 데이터와 검토 데이터, 색상 증거가 같고 모든 After 시안은 빈 상태를 유지한다.
8. 외부 요청 0개, Worker 생성 0개, 브라우저 페이지 오류 0개다. 실행 전후 원사진·raw 파일·관련 생산 소스 8개의 해시가 같다.

저장은 저장소 API를 직접 호출하여 검증했으므로 500ms 자동 저장 타이밍 검증으로 보지 않는다. 이 하네스의 화면은 검토 패널이며 공간 합성 이미지 품질을 측정하는 화면은 아니다.

## 실행과 결과

```powershell
node tests/run-browser-test.mjs tests/reconstruction-strict-review-browser.ts
npx eslint tests/reconstruction-strict-review-browser.ts
npx tsc --noEmit --project test-results/reconstruction-strict-placement-20260914/review-ui/scoped-tsconfig.json
```

브라우저의 모든 검증이 통과했고 scoped lint와 타입 검사는 각각 exit 0이다. 테스트는 별도 loopback 43189 포트를 사용하고 종료 시 브라우저와 서버를 닫는다. 첫 시도는 임의 배정된 5061 포트를 Chrome이 차단하여 앱 로드 전에 실패했다. 안전한 고정 포트로 변경한 뒤 재검증했으며 첫 실패 기록도 보관했다.

- 테스트: `tests/reconstruction-strict-review-browser.ts`
- 결과: `test-results/reconstruction-strict-placement-20260914/review-ui/verification.json`
- 결과 SHA-256: `1be95ceca13547b026700e3c2f03a6f09d7e0269f7af160a73a5c5a349901005`
- 화면: 동일 폴더의 `held-original.png`, `review-after-reload.png`
- 문서: 동일 폴더의 `initial-project.json`, `saved-project.json`

사진과 검증 산출물은 ignored 로컬 경로에 보관한다. 사용자 사진의 배포나 외부 전송은 하지 않았다.
