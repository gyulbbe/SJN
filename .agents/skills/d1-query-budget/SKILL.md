---
name: d1-query-budget
description: SJN에서 D1(DB)을 거치는 코드를 추가하거나 바꿀 때 사용한다. 대상은 SQL, `/api/d1/**`·`/api/catalog/**`·`/api/admin/**` 라우트, 권한·가시성 확인, 저장·읽기 흐름, 그리고 화면에서 이런 API를 부르는 fetch·폴링·이미지 표시다. 요청 1회당 쿼리 수와 D1이 과금하는 읽은 행(rows_read)·쓴 행을 실제 로컬 D1에서 재는 테스트를 추가한다. 이 테스트로 데이터가 늘어도 비용이 커지지 않는지, 화면이 같은 API를 비정상적으로 많이 부르지 않는지 확인한다.
---

# D1 호출·읽기 예산 확인

## 왜 필요한가

2026-10-17 운영 D1 `sjn`이 하루 1,885만 행을 읽어 무료 한도(하루 읽기 500만 행, 쓰기 10만 행)를 넘었다. DB 크기는 7.8MB뿐이었다.

원인은 쿼리 하나였다. 자산 1개의 권한을 확인할 때마다 "볼 수 있는 자산 전체"를 재귀 CTE로 새로 만들었고, 1회에 약 5,500행을 읽었다. 이 쿼리가 2일 동안 8,500회 불려 전체 읽기의 95%를 차지했다.

D1은 **돌려준 행이 아니라 훑은 행**을 과금한다. 그래서 기능 테스트가 모두 통과해도 데이터가 늘면 비용이 계속 커질 수 있다. 이 스킬은 그런 코드가 들어오기 전에 막는 절차다.

## 언제 적용하나

다음 중 하나라도 바뀌면 적용한다.

- D1 SQL(`prepare`·`batch`), migration의 테이블·인덱스
- D1을 읽는 서버 코드: `src/lib/d1/**`, `src/lib/catalog/**`, `src/lib/admin/**`, `src/lib/auth/**`, `src/lib/storage/server.ts`, 진단 아카이브 등
- 위 API를 부르는 클라이언트 코드: repository, `fetch`, `setInterval`·focus·visibility 재확인, 이미지 목록 표시, 자동 저장

D1과 무관한 화면 스타일 작업이나 문서만 고친 작업에는 적용하지 않는다.

## 절차

### 1. 쿼리 계획 점검 (정적)

바꾼 SQL마다 로컬 D1에서 `EXPLAIN QUERY PLAN`을 확인한다.

- **커지는 테이블**에 `SCAN`이 나오면 안 된다. 커지는 테이블은 `d1_assets`, `d1_materials`, `d1_material_versions`, `d1_material_assets`, `d1_material_version_options`, `d1_projects`, `d1_project_assets`, `d1_project_versions`, `d1_admin_*`, `d1_mutations`, `d1_cleanup_jobs`, `d1_reconstruction_diagnostics`, `user`, `session`이다.
  - 대신 `SEARCH ... USING (COVERING) INDEX`·`PRIMARY KEY`가 나와야 한다.
  - 행 수가 고정에 가까운 표(`d1_catalog_options`, `d1_material_subcategories`, `*_meta`)의 SCAN은 허용한다.
- 다음 패턴은 금지한다.
  - **권한·가시성 CTE가 전체 집합을 만드는 것.** 특히 `WITH RECURSIVE`는 바깥의 `WHERE id=?`가 안으로 내려가지 않는다. 요청한 id(또는 `json_each` 목록)에서 출발해 인덱스로 따라가고, 조건은 상관 `EXISTS`로 확인한다.
  - **모든 행의 `payload_json`·`metadata_json`에 `json_extract`·`json_each`를 거는 것.** 인덱스 열로 후보를 먼저 좁힌 뒤 그 행들에만 JSON 조건을 적용한다.
  - **반복문 안의 쿼리(N+1).** 목록은 `json_each(?)` 한 번이나 `batch` 한 번으로 처리한다.
  - **한 요청 안에서 같은 쿼리를 다시 실행하는 것.** 읽은 값은 변수로 넘긴다.
  - **새 `WHERE`·`ORDER BY` 조합에 인덱스가 없는 것.** 필요하면 새 migration에 인덱스를 추가한다.

### 2. 요청 1회 비용 측정 (필수)

[d1-meter](references/d1-meter.md)의 래퍼를 `tests/helpers/d1-meter.ts`로 둔다(이미 있으면 그것을 쓴다). 이 래퍼로 Miniflare D1을 감싸 요청 1회의 쿼리 수, `rows_read`, `rows_written`을 기록한다. 기존 `tests/d1-storage.test.ts`처럼 `Miniflare` + `applyD1Migrations` + `handleD1Request`(또는 해당 라우트 함수)를 쓴다.

참고할 기존 예: `tests/d1-read-cost.test.ts`(2026-10-17 운영 모양의 데이터를 1배·5배로 만들어 읽은 행을 잼, `SJN_D1_COST=1`일 때만 실행), `tests/d1-visibility-equivalence.test.ts`(옛 SQL과 새 SQL을 같은 DB에서 나란히 비교). 결과는 `docs/d1-query-efficiency-results-20261017.md`에 있다.

- **두 규모로 시드한다.** 기본 규모 N과 5N을 만든다. 기본 N은 운영과 비슷하게 잡는다. 2026-10-17 운영은 자산 2,037, 자재 958, 버전 973, 자재-자산 참조 1,001행이었다(`tests/d1-read-cost.test.ts`의 `shape`). 운영 행 수를 새로 확인했다면 그 값을 쓴다. 측정 대상과 무관한 다른 사용자와 공유 자재 데이터도 함께 넣는다. 그래야 "남의 데이터까지 훑는" 문제가 드러난다.
- **기준**(넘으면 고치거나 사유를 결과에 적고 사용자에게 알린다)
  - **단건 요청**(id 하나 읽기·권한 확인·이미지 1장): 5N의 `rows_read`가 N의 1.5배 + 20 이하이고, 절대값은 100행 이하
  - **목록 요청**: `rows_read`가 (돌려준 항목 수 × 고정 상수) + 상수 이하. 5N에서 돌려준 항목 수가 같다면 단건과 같은 기준을 적용한다.
  - **쿼리 수**: 데이터 규모와 무관해야 한다(N과 5N에서 같아야 한다). 저장 요청에서 참조 수에 비례해 쿼리 수가 늘면 안 된다.
  - **쓰기**: 저장 1회의 `rows_written`이 바뀐 항목 수에 비례해야 한다. 바뀌지 않은 버전·참조 행을 다시 쓰지 않는다.
- 측정은 실제 화면이 쓰는 경로로 한다. 일반 사용자, 관리자, 관리자 프로젝트 범위, 로그인하지 않은 공개 경로 중 해당하는 것을 모두 잰다.
- 기준 확인은 **회귀 테스트로 커밋한다.** 위 기준을 `expect`로 고정하고, 실패하면 어떤 SQL이 몇 행을 읽었는지(`records`) 출력한다. 시드가 무거우면 일반 테스트는 규모를 줄이고(N과 5N의 비율 비교는 유지), 운영 규모 측정은 `tests/d1-read-cost.test.ts`처럼 환경 변수로 켤 때만 돌린다.

### 3. 화면의 호출 횟수 측정 (클라이언트를 바꿨다면 필수)

Playwright e2e에서 `page.on('request')`로 `/api/` 요청을 경로별로 센다(`e2e/cloud-recovery.spec.ts:279` 방식).

- **해당 흐름을 한 번 수행**(화면 열기 → 대표 동작 → 저장 등)하고 경로별 횟수를 기록한다.
  - 같은 자산 id의 메타·raw 요청은 페이지 로드당 각 1회 이하여야 한다.
  - 다시 그리기, 탭 전환, 미리보기 갱신마다 같은 요청이 반복되면 안 된다.
- **60초 동안 가만히 둔다.** 이때 `/api/` 요청은 폴링 주기에 맞는 횟수 이하여야 한다. 현재 역할 확인은 30초 주기다. 페이지가 숨겨졌을 때(visibility hidden)는 폴링이 멈춰야 한다.
- 새 폴링, 재시도, 자동 저장은 주기·중단 조건·최대 횟수를 코드에 명시한다. 실패 시 즉시 무한 재시도하지 않는다.

### 4. 하루 사용량 추정

결과에 다음 표를 적는다.

| 경로 | 쿼리 수/회 | rows_read/회 (N / 5N) | rows_written/회 | 예상 호출/일 | 예상 읽기/일 |
| ---- | ---------- | --------------------- | --------------- | ------------ | ------------ |

- 예상 호출/일은 화면 구조로 추정한다. 예: 이미지 수 × 화면 열기 횟수, 폴링 주기 × 사용 시간.
- **기능 하나의 예상 읽기는 하루 25만 행(무료 한도의 5%) 이하, 쓰기는 하루 5,000행 이하를 목표로 한다.** 넘으면 사용자에게 알린다.

### 5. 배포 후 확인 (사용자가 배포한 뒤)

다음 날 운영 통계를 읽어 상위 쿼리에 새 코드가 올라오지 않았는지 확인한다. 읽기 전용이다.

```bash
npx wrangler d1 insights sjn --sort-by=reads --timePeriod=1d --limit=10
```

`--sort-by=count`로 호출 횟수 상위도 본다. 대시보드에서는 Workers & Pages → D1 → `sjn` → Metrics에서 볼 수 있다.

## 지켜야 할 것

- 원격 D1 `sjn`에는 쓰지 않는다. 원격에서 허용되는 것은 `wrangler d1 insights` 읽기뿐이다.
- `wrangler d1 execute --remote` SELECT는 사용자 승인 후에만 쓴다. 쿼리 원문과 예상 읽기 행 수를 먼저 보여 준다.
- 새 migration은 로컬과 테스트 DB에만 적용한다. 원격 적용은 사용자가 결정한다.
- 비용을 줄이려고 권한·공개 범위 판단을 바꾸지 않는다. 바꿔야 한다면 기존 쿼리와 새 쿼리를 같은 DB에서 나란히 실행해 결과가 같음을 테스트로 보인다.
- 여러 요청에 걸친 캐시, Better Auth 세션 쿠키 캐시처럼 권한 반영 시점이 달라지는 변경은 제안만 하고 사용자가 결정한다.
- DB·권한 구조가 바뀌면 [sjn-workflow](../sjn-workflow/SKILL.md)에 따라 `references/database.md`도 갱신한다.

## 완료 보고

최종 답변에 다음을 짧게 적는다.

- 측정한 경로와 4절 표
- 기준을 넘은 항목과 처리 결과
- 추가한 회귀 테스트 파일
- 새 인덱스·migration과 원격 적용 필요 여부

측정하지 못한 경로가 있으면 "미측정"으로 적고 이유를 쓴다.
