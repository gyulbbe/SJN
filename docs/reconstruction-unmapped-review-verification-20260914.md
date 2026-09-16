# 위치 제안이 없는 실제 후보의 Review UI 검증

2026-09-14 실제 user-01 저장 관측의 세면대 `object-48-109079`로 신규 기본 위치 분기를 검사했다. 이 후보는 wall/wall 방식으로 관측됐지만 설치 벽과 `placementReview`가 없다. 모의 후보를 만들거나 새 AI를 실행하지 않았다.

생산 Review 화면에서 다음 동작이 통과했다.

1. 사진에서 알아낸 위치가 아니라 기본값으로 시작한다는 안내가 보인다. 기본 규격 600×320×450mm와 설치 높이 650mm를 표시한다.
2. 설치 면을 왼쪽 벽으로 선택해도 높이 650mm와 `v = 1 - 650/2400`의 관계가 유지된다.
3. 그림 한 번 클릭으로 u=0.5, v=0.7, 높이 약 720mm를 설정한다. 선택·그림 조작 중에는 프로젝트 문서를 변경하지 않는다.
4. 추가하면 Before에 벽걸이 세면대 한 개가 생긴다. 선택한 벽·위치는 `user`, 폭·높이·깊이는 `default`로 보존된다. `placementPolicy: preserve`를 유지한다.
5. 이 원관측에는 세면볼 형태 증거가 없으므로 사각형 기본값과 `shape: default`가 저장된다. 이를 AI의 사각형 인식 성공으로 보지 않는다. 원래 evidence 전체와 색상 증거(관측색 #a89c8a, 중립색 #efefea, 확인 필요)는 그대로 유지된다.
6. 명시적 저장 후 실제 페이지 새로고침·재로딩에서 모형 및 후보 데이터가 동일하다. After의 설비·적용 자재는 비어 있고 원사진·raw 보고서·소스 해시 10개도 불변이다.

Chrome 152 headless / SwiftShader, 별도 loopback 43202 포트에서 브라우저 테스트 exit 0, scoped lint·타입 검사 exit 0이다. 페이지 예외·외부 요청·Worker 생성은 모두 0이다. 그림 위치와 2400mm 방 치수는 기능 검사용 사용자 선택·가정값으로 사진 실측이 아니다. 명시적 저장소 검증이며 500ms 자동 저장 시간은 검사하지 않았다.

- 테스트: `tests/reconstruction-unmapped-review-browser.ts`
- 증거: `test-results/reconstruction-placement-quality-20260914/unmapped-review-ui/run-01/verification.json`
- 증거 SHA-256: `1d21ba6535d5b1bb15fb4e8f75e48bf5c7cf9e5ab6f12a7f640ee4134442e5aa`
- 화면: 같은 폴더의 `initial-unmapped-basin.png`, `picture-selected.png`, `saved-basin.png`

이 검증은 사용자 확인 경로가 작동한다는 결과다. 자동 공간 재현의 품질 개선 결과와 합산하지 않는다.
