# 시안 생성 한도 5개로 변경

2026-09-07 사용자 요청에 따라 신규 시안 생성·복제는 프로젝트당 **최대 5개**로 변경했다. 동시 비교도 기존과 같이 최대 5개다.

- `src/lib/comparison.ts`의 `MAX_DESIGNS`를 5로 변경했다. 생성·복제 명령, 관리 카드의 버튼 비활성화, 개수 표시와 서버 입력 검증이 같은 상수를 사용한다. 기본 이름은 A–E다.
- 5개 상태에서 연속 생성·복제를 눌러도 추가되지 않는다. 하나를 삭제해 4개가 되면 다시 추가할 수 있다. 안내 문구도 최대 5개로 표시한다.
- 이전 버전에서 이미 저장한 6–10개 시안과 전체 복원 백업은 자동 삭제하거나 잘라내지 않는다. 그대로 열고 편집·삭제할 수 있으며 새 시안은 5개 미만일 때만 추가한다. 실제 과거 백업의 전체 복원도 보존한다.
- 호환 저장은 신뢰할 수 있는 이전 저장본의 현재/백업 시안 ID를 확인한다. 5개를 초과하는 그룹에는 기존 그룹에 없던 새 ID를 추가할 수 없고, 새 프로젝트를 6개로 만들거나 초과 백업을 삽입하는 요청도 거절한다. 기존 파일을 읽기만으로 덮어쓰지 않는다.
- 저장 경계는 `projectWriteError`, `storedProjectV3Schema`를 구분하며 신규 문서의 `projectV3Schema`는 5개 제한을 유지한다. Supabase API도 소유권이 확인된 기존 문서와 비교한다.
- SQL은 새 마이그레이션 `202609070002_five_design_limit.sql`에 쓰기 트리거로 준비했다. 기존 10개 구조 검증은 예전 자료 보존용 상한이며, 신규/변경된 초과 그룹은 트리거가 막는다. 실제 서버에 적용하거나 연결 테스트하지 않았다.

## 검증

- 전체 Vitest **35개 파일·289개 통과**. `test-results/five-design-limit-all-unit.log`
- 변경 상태/저장 단위 테스트 **34개 통과**. `test-results/five-design-limit-unit.log`
- 기존 6–10개 저장본 호환, 편집·축소, 신규 ID 차단, 과거 백업 복원/다시 실행 등 추가 회귀 **4개 통과**. `tests/five-design-compatibility.test.ts`
- 실제 Chrome 한도 시나리오 **1개 통과 (10.0초)**. 5개까지 연속 복제, 추가 버튼 차단, 5개 비교 선택, 삭제 후 추가, 전체 삭제 후 빈 상태와 새 시안 생성 확인. `test-results/five-design-limit-browser.log`
- ESLint 경고·오류 0, TypeScript 통과. `test-results/five-design-limit-lint.log`, `test-results/five-design-limit-typecheck.log`
- Next.js 프로덕션 빌드 통과. `test-results/five-design-limit-build.log`
- 5개 시안×50개 이력 샘플은 JSON **925,566 bytes**, Node + fake-indexeddb에서 save45ms/load11ms였다. 실제 브라우저 성능 측정으로 해석하지 않는다.

기존 다중 시안 보고서의 10개 시험과 성능 수치는 당시 측정 기록으로 남겨 두었다. 현재 한도는 이 문서와 공통 상수를 따른다.
