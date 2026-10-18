# D1 읽기 줄이기: 자산 권한 확인 쿼리 개선 + 많이 불리는 쿼리 정리

## 0. 배경 (2026-10-17 사용자 보고 + D1 쿼리 통계)

운영 D1 `sjn`이 하루 무료 읽기 한도를 넘었다. 넘은 날은 2026-10-17이고, 한도는 하루 500만 행이다. 이날 대시보드에 찍힌 읽기는 **1,885만 행**이다.

DB 크기는 7.8MB뿐이다. 그런데 전날 AI로 자재를 여러 개 등록한 뒤부터 화면을 평소처럼 쓰기만 해도 한도에 걸린다.

`npx wrangler d1 insights sjn --timePeriod=7d --json`(읽기 전용)으로 본 최근 7일 상위 쿼리는 아래와 같다.

| #   | 쿼리 (코드 위치)                                                                                                              | 실행            | 1회 읽은 행         | 읽은 행 합계    |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------- | --------------- |
| A   | `visibleAssets` 재귀 CTE로 자산 1개 읽기 (`readableAsset`, `src/lib/d1/database.ts:75`)                                       | 8,546           | 약 5,500            | **4,706만**     |
| B   | 저장할 때 자산 참조 검사 `INSERT INTO d1_checks(... reference_ok)` + `visibleAssets` (`assetAssertion`, `database.ts:106`)    | 2,846           | 약 2,000            | 559만           |
| C   | `visibleAssets`의 다른 사용처 (`validateReferences` `database.ts:295`, `checkMaterialAssets` `src/lib/d1/materials.ts:67` 등) | 1,128 + 107     | 2,600~4,900         | 349만           |
| D   | `readCatalog` 옵션·하위 분류 (`src/lib/catalog/server.ts:14`)                                                                 | 873 + 1,413     | 75 / 42             | 13만            |
| E   | `d1_mutations` 정리 DELETE (`src/lib/d1/cleanup.ts:20,162`)                                                                   | 120             | 363                 | 4.4만           |
| F   | Better Auth 세션 조회 / 사용자 상태·역할 조회 (요청마다)                                                                      | 11,035 / 10,931 | 1~2                 | 4만             |
| G   | 공개 이미지 `publicImage` (`src/lib/catalog/public.ts:104`): 모든 공개 자재 payload를 `json_each`로 훑음                      | 54              | 28 (자재 수에 비례) | 0.2만           |
| H   | 공개 자재 버전 이미지 (`public.ts:149`)                                                                                       | 2               | -                   | 2회에 **4.8초** |

- **A~C, 즉 `visibleAssets` 하나가 전체 읽기의 약 95%다.** 원인은 이 CTE가 요청한 자산 하나를 확인할 때도 "볼 수 있는 자산 전체"를 처음부터 재귀로 만든다는 데 있다. 재귀 CTE라 바깥의 `WHERE a.id=?`가 안으로 내려가지 않고, 자산 행마다 `d1_material_assets → d1_material_versions → d1_materials` EXISTS를 돈다. 그래서 1회 비용이 전체 자산 수에 비례하고, 자재와 버전이 늘수록 계속 커진다.
- 같은 7일 동안 쓰기도 많았다. `d1_materials` INSERT 628회, `d1_material_versions` INSERT 1,045회, `d1_assets` INSERT 1,548회, `d1_material_assets` INSERT 937회다. 데이터가 빠르게 늘고 있다(6절에서 출처를 확인한다).
- 참고로 D1 무료 한도는 매일 UTC 0시(한국 시간 09:00)에 초기화된다.

## 1. 목표와 원칙

- **권한 판단 결과는 그대로 두고 읽는 행 수만 줄인다.** 누가 어떤 자산·버전을 볼 수 있는지는 한 건도 바뀌면 안 된다. 기존 규칙이 이상해 보여도 이 작업에서 고치지 않는다. 결과 문서에 "발견, 미변경"으로 적고 사용자에게 묻는다.
- 1회 비용이 **전체 자산·자재 수와 무관해야 한다.** 요청한 자산(또는 참조 목록)에 비례해야 한다.
- 우선순위는 A~C(필수) → G·H(공개 경로, 필수) → E(인덱스) → D·F(측정 후 판단) 순서다.

## 2. 지켜야 할 제약

- **원격 D1 `sjn`에는 쓰지 않는다.** migration 적용, 데이터 수정, 배포를 하지 않는다.
- 원격 읽기는 `wrangler d1 insights`만 자유롭게 쓴다.
- `wrangler d1 execute --remote`로 SELECT를 할 때는 미리 사용자에게 승인을 받는다. 쿼리 원문과 예상 읽기 행 수를 함께 보여 준다.
- 새 migration(예: `0008_*.sql`)은 로컬과 테스트 DB에만 적용한다. 원격 적용은 결과 문서에 명령과 SQL을 적어 두고 사용자가 결정한다.
- 커밋과 푸시는 사용자가 요청할 때만 한다. 토큰과 비밀값은 채팅, 소스, 로그에 넣지 않는다. 그냥 `git stash`는 쓰지 않는다.
- 저장소 규칙
  - Prettier로 쓸 때는 `--end-of-line crlf --write`, 검사할 때는 `--end-of-line auto`를 쓴다.
  - typecheck 후에는 `next-env.d.ts`를 되돌린다. `.next/dev/types`가 깨졌으면 지우고 다시 실행한다.
- 작업 전에 `.agents/skills/sjn-workflow/SKILL.md`와 references의 `database.md`, `development-environment.md`를 읽는다.
- 측정과 회귀 테스트는 `.agents/skills/d1-query-budget/SKILL.md`를 따른다. 그 스킬의 `references/d1-meter.md` 래퍼를 `tests/helpers/d1-meter.ts`로 추가해 쓴다(3-4, 4, 5절의 읽은 행 측정).
- 최신 `origin/main`에서 새 브랜치를 만들어 시작한다.

## 3. A~C: `visibleAssets` 다시 쓰기 (필수)

### 3-1. 현재 의미를 정확히 옮긴다

현재 정의(`database.ts:33` `visibleAssets`, `:58` `visibleAssetsQuery`)는 이렇게 동작한다.

- **기본 집합(일반 사용자)**: `deleting=0`이면서 다음 중 하나에 해당하는 자산이다.
  - `owner_id = 나`
  - 공유 자재(`m.scope='shared'`)의 **어느 버전**이든 `d1_material_assets`로 참조된 자산
- **기본 집합(관리자 프로젝트 범위, `ctx.adminProject`)**: `deleting=0`이면서 다음 중 하나에 해당하는 자산이다.
  - `d1_project_assets(project_id)`에 있는 자산
  - `d1_admin_project_assets(project_id, actor_id)`에 있는 자산
  - `d1_material_assets`의 버전이 `visible_versions` 안에 있는 자산
- **재귀**: 보이는 자산 p의 원본(`p.source_asset_id`)인 자산 a도 `deleting=0`이면 보인다.

따라서 자산 X가 보일 조건은 다음과 같다. X 자신과, X에서 **파생된 자산들**(`source_asset_id`를 거꾸로 따라 내려가는 자손, 중간 자산은 모두 `deleting=0`) 가운데 하나라도 기본 집합에 들면 X가 보인다. 길이 0의 사슬, 즉 X 자신도 포함한다.

### 3-2. 새 방식: 요청한 자산에서 출발한다

- 확인할 자산 id(1개 또는 `json_each` 목록)에서 출발한다. `source_asset_id` 인덱스(`d1_assets_source`)로 자손을 재귀로 모은다. 이때 각 행은 `(root, id)`로 둬서 어느 요청 자산의 자손인지 추적한다.
- 모은 행마다 기본 집합 조건을 **상관 EXISTS**로 확인한다. 인덱스는 PK, `d1_material_assets_asset`, `d1_project_assets_asset` 등을 쓴다.
- 관리자 범위의 `visible_versions`도 전체 버전을 미리 만들지 않는다. 확인하려는 `r.version_id` 하나에 대해 조건을 검사하는 상관 EXISTS로 바꾼다.
- `UNION`으로 중복과 순환을 막는다.
- 바꿀 사용처를 모두 찾아 같은 헬퍼를 쓰게 한다.
  - `readableAsset`: `assets.ts`의 GET 메타·raw, `source` 확인, 관리자 쓰기 전 확인
  - `assetAssertion`: 배치 안의 참조 검사
  - `validateReferences`
  - `checkMaterialAssets`
  - `grep -rn "visibleAssets\|visibleAssetsQuery\|readableAsset" src`로 빠진 곳이 없는지 확인한다.
- 배치 안의 검사(`assertion`)는 원자성을 위해 지금처럼 `INSERT INTO d1_checks ... SELECT` 형태를 유지한다.
- `visibleVersionsQuery`도 같은 방식(일반: `m.owner_id=? OR m.scope='shared'` 전체 생성)이다. 통계상 비용은 작지만(실행 89회, 1회 28행) 같은 구조이므로 함께 정리할지 판단해 보고한다.

### 3-3. 같은 결과인지 증명한다 (필수)

`tests/d1-storage.test.ts`처럼 Miniflare와 실제 migration을 쓰는 테스트를 추가한다.

- **기존 쿼리와 새 쿼리를 같은 DB에서 나란히 실행해** 결과 집합이 같은지 비교한다. 기존 쿼리 문자열은 테스트 안에 고정 사본으로 둔다.
- 무작위로 만든 그래프를 여러 seed로 돌린다. 포함할 요소는 다음과 같다.
  - 소유자 2~3명
  - 공유 자재와 개인 자재, 여러 버전(현재 버전이 아닌 옛 버전 참조 포함)
  - `source_asset_id` 사슬(깊이 0~4, 가지 갈라짐)
  - 중간 자산 `deleting=1`
  - 프로젝트 자산·관리자 프로젝트 자산
  - 없는 id, 중복 id
- 일반 사용자와 관리자 프로젝트 범위를 모두 확인한다.
- 단건 확인(`readableAsset`)과 목록 확인(`assetAssertion`, `validateReferences`, `checkMaterialAssets`)을 모두 확인한다.
- 기존 권한 테스트(`d1-storage`, `admin-projects`, `catalog-visibility`, `catalog-auth-boundary`, `d1-route` 등)가 모두 통과해야 한다.

### 3-4. 읽은 행 수를 잰다 (필수)

- 로컬 Miniflare D1 결과의 `meta.rows_read`로 잰다.
- 데이터 규모는 운영과 비슷하게, 그리고 그 5배로 만든다. 예: 자산 3,000 / 15,000, 자재 700 / 3,500, 버전 1,200 / 6,000. 실제 규모는 6절에서 확인한 값으로 맞춘다.
- 사용처별로 기존과 새 방식의 1회 읽은 행 수를 비교한다. **새 방식은 데이터를 5배로 늘려도 거의 변하지 않아야 한다.**
- 측정 테스트는 결과를 문서에 옮긴 뒤 커밋할지 판단한다. 무거우면 별도 스크립트로 둔다.

## 4. G·H: 공개 경로 (필수)

`public.ts`의 `publicImage`(`:104`)와 공개 버전 이미지(`:137~160`)는 요청 하나마다 모든 공개 자재의 `payload_json`을 `json_each`로 훑는다. 로그인하지 않은 방문자의 `/materials` 화면에서 이미지마다 불리므로, 자재가 늘면 A와 같은 문제가 생긴다.

- 먼저 `d1_material_assets`의 `asset_id` 인덱스로 이 자산을 참조하는 **현재 공개 버전**만 좁힌다. 그다음 그 버전들에만 기존 `directDisplay` 조건(직접 표시 이미지만, `source_asset_id`는 따라가지 않음)을 적용한다.
  - 단, `d1_material_assets`에 직접 표시 이미지가 모두 들어 있는지 코드로 확인한다. 아니라면 다른 방법을 찾는다.
- H의 2회 4.8초가 어느 쿼리 계획 때문인지 `EXPLAIN QUERY PLAN`으로 확인하고 개선한다.
- `publicMaterials`(`:63`)는 목록 1회에 전체를 읽는 구조라 그대로 둔다. 단, 자재 수에 비례하는 추가 반복이 있는지만 확인한다.
- 공개 범위가 그대로인지 증명한다. 기존 `catalog-visibility`, `catalog-auth-boundary` 테스트에 더해, 3-3처럼 기존 쿼리와 새 쿼리를 나란히 비교한다. 비교할 사례는 다음과 같다.
  - 비활성 자재
  - 옛 버전에만 있는 이미지
  - 원본(source) 자산
  - 타일과 일반 자재의 표시 규칙 차이
  - 대표 이미지만 있는 자재

## 5. E·D·F: 측정 후 판단

| 항목                   | 할 일                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E. `d1_mutations` 정리 | PK가 `(owner_id, request_key)`이고 `created_at` 인덱스는 단독이라 소유자의 기록을 다 훑는다. `0008`에 `(owner_id, created_at)` 인덱스를 추가하고, 로컬에서 읽은 행 수가 줄었는지 확인한다. 원격 적용은 사용자가 결정한다(SQL과 명령을 문서에 적는다). 준비 검사(`database.ts`의 테이블·컬럼 확인)에 인덱스 확인이 필요한지도 판단한다. 필요 없으면 넣지 않는다.                                                                                                     |
| D. `readCatalog`       | 요청마다 옵션 약 75행과 하위 분류 약 42행을 읽는다. 어떤 화면과 요청에서 몇 번 불리는지(예: 저장 검사 `server.ts:116`, 공개 목록) 찾는다. 같은 요청 안에서 두 번 이상 읽는다면 한 번으로 줄인다. 여러 요청에 걸친 캐시는 관리자 수정 즉시 반영 규칙과 부딪치므로 **제안만** 한다.                                                                                                                                                                                   |
| F. 세션·역할 조회      | 요청마다 1~2행이라 읽은 행 비용은 작다. 다만 실행 횟수가 가장 많다. `shared-access.ts:38`의 `/api/d1/role` 30초 폴링과 포커스 재확인, 클라이언트 자산 `get`(`src/lib/repositories/cloud.ts:161`)이 메타 요청과 raw 요청으로 **자산 하나에 권한 확인을 두 번** 하는 구조가 각각 얼마나 기여하는지 추정한다. Better Auth 세션 쿠키 캐시처럼 보안 동작(차단·만료 반영 시점)을 바꾸는 것은 **하지 않는다.** 줄일 수 있는 방안과 장단점을 결과 문서에 제안으로만 적는다. |

## 6. 데이터 증가 원인 확인

7일 동안 `d1_materials` INSERT 628회, 버전 1,045회, 자산 1,548회가 있었다.

- 코드에서 확인할 것
  - 이 쓰기가 어디서 생기는가: 자재 등록(관리자), 프로젝트 저장 때 생기는 `purpose='project'` 자재, AI 방향 사진, 배경 제거본, e2e 등.
  - 자재를 한 번 저장할 때 버전, `d1_material_assets`, `d1_material_version_options`가 몇 행씩 생기는가.
  - 옛 버전과 쓰이지 않는 자산이 정리되는가.
- 원격 행 수가 필요하면 사용자 승인을 받은 뒤 테이블별 `SELECT COUNT(*)`만 실행한다. 대상은 `d1_assets`, `d1_materials`(`purpose`·`scope`별), `d1_material_versions`, `d1_material_assets`, `d1_project_assets`, `d1_mutations`다. 쿼리 원문과 예상 읽기 행 수(테이블 행 수 합계)를 먼저 보여 준다.
- 정리 정책을 바꿔야 한다면 이 작업에서 구현하지 않는다. 원인, 규모, 선택지를 문서에 적고 사용자가 결정한다.

## 7. 검증

- 새 테스트와 기존 D1·카탈로그·관리자 테스트를 실행한다.
  - `npx vitest run tests/d1-storage.test.ts tests/admin-projects.test.ts tests/admin-project-repository.test.ts tests/catalog-visibility.test.ts tests/catalog-auth-boundary.test.ts tests/d1-catalog.test.ts tests/d1-route.test.ts`
  - 새로 추가한 테스트 파일도 함께 실행한다.
- `npm run typecheck`, `npm run lint`, Prettier 검사를 한다.
- 전체 `npx vitest run`을 돌린다. 알려진 환경 실패(reconstruction-corpus 해시, source-plane-mapping 기준 파일, D1/R2 첫 연결 5초 초과)만 남아야 한다.
- 로컬 개발 서버(`npm run dev`)에서 사람이 쓰는 흐름을 확인한다.
  - 자재 목록, 자재 편집(이미지 표시, 저장), 프로젝트 열기·저장, 공개 `/materials` 이미지
  - 깨진 이미지나 403이 없어야 한다.
  - 로컬 DB와 로그인 준비가 안 돼 있으면 `development-environment.md`의 "첫 로컬 실행"을 따른다. 비밀값은 사용자가 넣는다.

## 8. 문서

- 결과 문서 `docs/d1-query-efficiency-results-YYYYMMDD.md`를 쓴다.
  - 0절 통계표(개선 전)
  - 쿼리별 전후 1회 읽은 행 수(기본 규모, 5배 규모)
  - 같은 결과 증명 방법과 사례 수
  - 바꾼 파일
  - 미변경·제안 항목(D·F·데이터 정리)
  - 원격 `0008` 적용 명령
  - 배포 다음 날 비교용 명령: `npx wrangler d1 insights sjn --sort-by=reads --timePeriod=1d --limit=10`
- `.agents/skills/sjn-workflow/references/database.md`에 짧게 추가한다.
  - 자산 가시성 확인 방식이 바뀌었다는 것
  - "권한 CTE는 요청 대상에서 출발한다(전체 집합 생성 금지)"는 규칙
- `.agents/skills/sjn-workflow/references/development-environment.md`에 D1 쿼리 통계 보는 법을 넣는다(대시보드 D1 → `sjn` → Metrics, 위 insights 명령).
- `docs/database-design.md`에 인덱스 목록이 있으면 `0008`을 추가한다.

## 9. 보고

다음을 보고한다.

- 바꾼 쿼리별 전후 읽은 행 수
- 예상 하루 읽기: 10-16~17 사용 패턴에 새 1회 비용을 곱해 계산
- 같은 결과 증명 결과
- 원격 `0008` 적용이 필요한지와 그 SQL
- 데이터 증가 원인과 선택지
- 사용자 결정이 필요한 것(D·F 제안, 정리 정책)

커밋은 사용자 요청 시에만 한다. 커밋을 나눈다면 (1) 쿼리와 테스트, (2) migration, (3) 문서로 나누는 안을 제시한다.
