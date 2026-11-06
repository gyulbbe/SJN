# D1 쓰기 줄이기: 자재 저장 1번이 쓰는 행 (2026-11-04)

운영 D1 `sjn`은 2026-11-03에 하루 쓰기 한도(10만 행)를 넘었다(쓴 행 130,499, 읽은 행 466,738, DB 48.8MB). 하루 쓰기의 98%가 기존 공용 자재 저장 1,157번이었고, 1번에 약 110행을 썼다. 이 작업은 저장 1번이 쓰는 행을 줄였다. 화면, 저장 형식, 권한, 목록 결과(순서·필터·개수)는 그대로다.

## 1. 사용자 결정

| 질문 | 결정 |
| --- | --- |
| 어디까지 고칠까 | 저장 비용만 줄이기(색인·트리거·검사·분류 읽기). 목록 요약에 현재 버전만 두는 큰 변경은 하지 않음 |
| 관리자 화면에 DB 사용량 | 보이기(관리자 AI 사용량 화면에 오늘 DB 쓰기·읽기와 남은 양) |
| 1,157건은 어떤 작업이었나 | 사용자가 직접 한 것이 아니라 AI에게 시킨 일괄 작업 |

## 2. 코드에서 다르게 확인한 것

- **검사 줄:** 명세는 `d1_checks`·`d1_admin_checks`를 `WITHOUT ROWID`로 바꾸고 검사를 합치자고 했다. 대신 **실패할 때만 줄을 쓰는** 방법을 골랐다.
  - 검사 문장이 `INSERT … SELECT ?,0 WHERE NOT coalesce((조건),0)`가 된다.
  - 통과하는 검사는 0행을 쓴다. 실패하면 지금처럼 그 줄이 제약을 어겨 batch를 멈춘다.
  - 표 구조도, batch 안의 순서도 바뀌지 않는다. 그래서 오류 종류(409·400·관리자 오류)와 우선순위가 그대로고, 옛 코드와 섞여도 문제가 없다.
  - 저장 1번에서 약 15행이 줄었다.
- **옛 버전 줄의 updated_at을 읽는 곳은 두 곳이다.** 명세는 `adminProjectEntries`만 짚었지만, 목록의 `rowsFor`도 관리자 프로젝트 서랍의 옛 버전 카드에 그 값을 썼다.
  - 두 곳 모두 옛 버전일 때만 `d1_materials.updated_at`을 읽게 바꿨다.
  - 현재 버전은 지금처럼 요약 줄의 값을 읽는다. 목록 쪽마다 읽는 행이 늘지 않게 하려는 것이다.
- **`d1_materials_owner/shared/public`:** 쓰는 곳은 옛 전체 목록 요청(`list`) 하나뿐이었다. 지웠다. `list`는 이 색인 없이도 같은 결과를 낸다.
- **옛 전체 목록 요청(`list`):** 작업일이 2026-11-04라 코드 주석의 예정(11-05 이후 지우기)대로 남겼다.
- **분류 읽기:** 로컬에서 저장 1번이 121행(옵션 66, 하위 분류 42, 종류 13)을 읽었다. 명세의 약 137행과 비슷하다.
- **로컬 측정의 성격:** 부분 색인에서 빠지는 것(현재 버전이 아니게 된 줄)은 쓴 행으로 세지 않았다. 들어가는 것은 셌다.

## 3. 바꾼 것

### migration 0014 (`migrations/d1/0014_write_cost.sql`)

기존 줄을 다시 쓰지 않는다. 그래서 적용해도 쓰기가 거의 없다.

- **지운 색인 10개**
  - `d1_list_lane`, `d1_list_category`, `d1_list_recent`, `d1_list_personal`, `d1_list_facet_order`: 0009의 updated_at 순서. 0010부터 목록은 이름으로 지정한 색인만 쓰고, 목록 이미지 일괄은 `d1_list_all_new`로 옮겼다.
  - `d1_mutations_age`: 정리는 0008의 `d1_mutations_owner_age`를 쓴다.
  - `d1_versions_material`: `UNIQUE(material_id,version)`과 앞부분이 같다.
  - `d1_materials_owner`, `d1_materials_shared`, `d1_materials_public`: 옛 `list`만 썼다.
- **`d1_material_list_version_insert`(같은 이름으로 다시 만듦)**
  - 브랜드 순서(prio)를 저장 내용의 `catalog.brandId`로 처음부터 계산한다.
  - 이 자재의 새 현재 버전이면, 바로 앞 현재 버전과의 **차이만** 개수 표에 쓴다. 분류 값이 같은 보통 저장은 개수 표를 0행 쓴다.
  - 그다음 앞 현재 버전을 현재가 아니게 한다.
- **`d1_material_list_brand_link`(같은 이름):** 값이 다를 때만 쓴다. 위 트리거가 이미 같은 값을 넣었으므로 보통은 0행이다.
- **`d1_material_list_material_update`(같은 이름)**
  - 소유자·공개 범위·용도·사용 여부가 바뀌면 지금처럼 모든 버전에 복사한다.
  - 현재 버전만 바뀐 보통 저장은 여기서 아무것도 하지 않는다. 새 버전이 들어올 때 위 트리거가 처리한다.
  - 이미 있는 버전으로 현재를 옮기면 두 줄만 고치고, 개수는 차이만 쓴다.
- **준비 검사(`checkD1Storage`)는 바꾸지 않았다.** 요구하는 색인 15개, 트리거 5개, `d1_versions_added_kind`는 모두 남아 있다.

### 코드

- `src/lib/d1/database.ts` `assertion`, `src/lib/admin/access.ts` `adminAssertion`: 실패할 때만 줄을 쓴다.
- `src/lib/catalog/server.ts` `resolveCatalogInput`: 고른 옵션(`json_each` 한 번), 고른 하위 분류, 그 종류만 읽는다. 이름과 오류 문구는 그대로다.
- `src/lib/d1/list-images.ts` `listImagePage`
  - 등록순 `d1_list_all_new`로 바꿨다.
  - 커서가 `c`(등록 시각)를 쓴다. 옛 커서(`u`)는 그 부분을 처음부터 다시 연다. 일괄 생성은 목록만 보여 주므로 문제없다.
- `src/lib/d1/materials.ts` `adminProjectEntries`, `src/lib/d1/material-list.ts` `rowsFor`: 옛 버전의 updated_at을 자재 표에서 읽는다.
- `src/lib/admin/ai-usage.ts`, `src/components/admin/admin-ai-usage.tsx`: 오늘 DB 사용량을 보인다(5절).

## 4. 전후 (로컬 D1, `tests/d1-write-cost.test.ts`)

브랜드·색 2개·마감·하위 분류·크기가 있는 공용 타일을 관리자가 수정 저장한 경우다. 시드는 공용 타일 200개(N)와 1,000개(5N)다.

| 저장 | 쿼리 수 | 쓴 행 (전 → 후) | 읽은 행 (전 → 후) |
| --- | --- | --- | --- |
| 수정 저장, 저장 전 버전 1개 | 21 → 21 | 107 → **58** | 212 → 131 |
| 수정 저장, 버전 5개 | 21 → 21 | 127 → **58** | 275 → 148 |
| 수정 저장, 버전 20개 | 21 → 21 | 202 → **58** | 517 → 210 |
| 새 공용 타일 | 18 → 18 | 95 → 59 | 183 → 86 |
| 사용 끄기, 버전 21개(모든 버전 복사) | 9 → 9 | 154 → 141 | 355 → 358 |
| 관리자 프로젝트 새 모형 | 16 → 16 | 37 → 22 | 40 → 49 |

- 5N에서도 쿼리 수와 쓴 행은 같다. 읽은 행은 수정 저장 131·148·210, 새 타일 86, 관리자 프로젝트 49로 N과 같은 수준이다. 카탈로그 크기가 아니라 그 자재의 버전 수만 조금 따라간다.
- **수정 저장 1번 문장별(버전 1개)**

| 문장 | 전 | 후 | 줄어든 이유 |
| --- | --- | --- | --- |
| 검사(관리자·자료·충돌·분류·하위 분류)와 지우기 | 15 | 0 | 통과하면 쓰지 않음 |
| `UPDATE d1_materials` (+ 자재 트리거) | 14 | 1 | 보통 저장은 트리거가 쓰지 않음, updated_at 색인 3개 지움 |
| `INSERT d1_material_versions` (+ 버전 트리거) | 45 | 37 | 0009 색인 4개·`d1_versions_material` 지움, 개수 표는 차이만 |
| `INSERT d1_material_version_options` (+ 브랜드 트리거) | 25 | 13 | 브랜드 순서를 미리 계산해 다시 쓰지 않음 |
| `d1_material_assets` | 3 | 3 | |
| `d1_mutations` | 5 | 4 | `d1_mutations_age` 지움 |
| **합계** | **107** | **58** | 목표 60행 이하(가능하면 50) |

- 50행까지는 줄이지 못했다. 남은 58행은 대부분 목록이 실제로 읽는 데이터다.
  - 요약 줄과 정렬 색인 9개
  - 분류 값 4줄 × 정렬 색인 3개
  - 옵션 4줄과 그 색인
- 더 줄이려면 목록 정렬 방식을 줄이거나, 요약에 현재 버전만 두는 큰 변경(1절에서 하지 않기로 함)이 필요하다.

### 하루 사용량 추정 (d1-query-budget 4절)

| 경로 | 쿼리 수/회 | rows_read/회 (N / 5N) | rows_written/회 | 예상 호출/일 | 예상 쓰기/일 |
| --- | --- | --- | --- | --- | --- |
| 공용 자재 수정 저장 | 21 | 131 / 131 (버전 1개) | 58 | 1,157 (2026-11-03) | 약 67,000 (전 약 124,000~) |
| 새 공용 자재 | 18 | 86 / 86 | 59 | 20 | 약 1,200 |
| 관리자 프로젝트 새 모형 | 16 | 40 / 49 | 22 | 적음 | – |

- 11-03과 같은 일괄 작업은 이제 하루 쓰기의 약 67%다. 혼자서는 한도를 넘지 않는다. 다만 같은 날 다른 저장이 3만 행을 넘게 쓰면 여전히 넘을 수 있다.
- 쓰기 목표(기능 하나 하루 5,000행 이하)는 이런 일괄 저장으로는 맞출 수 없다. 1,157건이면 6.7만 행이다.
- 1,157건은 AI에게 시킨 일괄 작업이었다(1절). 일괄 수정 도구나 AI 작업은 다음처럼 하는 것이 좋다.
  - 바뀐 것이 없는 자재는 다시 저장하지 않는다.
  - 많은 수정은 관리자 화면의 "오늘 DB 사용량"을 보며 나눠서 한다.

## 5. 관리자 화면의 오늘 DB 사용량

- **위치:** `/admin/ai-usage`의 "오늘 DB 사용량" 칸
  - 계정 전체의 오늘(UTC) 쓴 행·읽은 행, 무료 한도(10만·500만), 남은 양을 보인다.
  - 막대는 70%에 주황, 90%에 빨강이 된다.
- **읽는 곳:** Cloudflare 통계 `d1AnalyticsAdaptiveGroups`(`date_geq`/`date_leq` = 오늘)를 같은 토큰(`CLOUDFLARE_ANALYTICS_TOKEN`, Account Analytics 읽기)으로 읽는다. DB는 읽지 않는다.
- **실패할 때:** 통계 쪽만 실패하면 AI 값은 그대로 두고, "DB 사용량을 읽지 못했어요: …"로 이유를 보인다.
- **설정:** 운영에 통계 값이 있어야 보인다. 로컬 `.dev.vars`의 값은 비어 있다. 운영에서 실제 통계로 확인하지는 않았다(모의 응답으로만 시험).

## 6. 시험

- **새로 더한 것**
  - `tests/d1-write-cost.test.ts`
    - 위 표의 경로를 실제 요청 경로로 잰다.
    - 기준을 고정했다: 수정 저장 60행 이하이고 버전 수와 무관, 쿼리 수 같음, 새 자재 60, 관리자 프로젝트 25.
    - 바꾼 SQL의 쿼리 계획에 SCAN이 없는지 본다.
    - 문장별 기록은 `test-results/d1-write-cost.json`에 남는다.
  - `tests/d1-write-cost-equivalence.test.ts`: 0013 DB와 0014 DB에서 같은 저장을 돌렸다.
    - 만들기, 수정 여러 번, 분류 값 바꾸기, 브랜드 바꾸기, 옵션 빼기, 새 종류, 사용 끄기·켜기, 공용·개인 전환, 브랜드 순서.
    - 결과가 바이트 단위로 같은 것: 공개 목록(정렬 4가지·필터·검색·종류), 관리자 서재·선택 목록(정렬 4가지), 관리자 프로젝트 서랍(정렬 4가지), 버전 묶음 조회, 개수 표, 현재 버전 요약 줄.
    - 옛 버전 요약 줄은 updated_at만 다르다.
    - 검사: 옛 검사 문장과 새 검사 문장이 같은 제약에서 멈춘다(앞 검사 먼저, NULL은 실패). 통과하면 0행을 쓴다.
    - 옛 코드 + 0014: 목록 이미지 일괄이 지운 색인 때문에 실패하고, 옛 버전 카드의 시각이 다르다(7절 순서의 근거).
  - `tests/admin-ai-usage.test.ts`(DB 사용량 2건), `e2e/admin-ai-usage.spec.ts`(DB 칸, 390px)
- **고친 것**
  - `tests/d1-material-list-sync.test.ts`: updated_at은 현재 버전만 자재와 같게 확인한다.
  - `tests/d1-material-paging-equivalence.test.ts`: 준비 시간 제한을 30초로 했다. main에서도 약 9초로 기본 10초에 가까웠고, 0014가 더해져 넘었다.
- **통과:** D1 시험 전부를 한 파일씩 차례로 돌렸다(`--fileParallelism=false`, 약 24분). 19개 파일, 183개 시험이 통과했다.
  - 위 두 시험, d1-storage, d1-catalog, d1-material-kinds, d1-material-order, d1-list-images, d1-route, d1-images, d1-auth, d1-admin-users
  - d1-material-list-sync, d1-material-paging-equivalence, d1-material-paging-cost, d1-visibility-equivalence, d1-fixture-layouts, d1-reconstruction-diagnostics
  - admin-projects, admin-ai-usage
  - typecheck, lint
- **건너뜀:** `tests/d1-read-cost.test.ts`는 `SJN_D1_COST=1`일 때만 돈다.
- **전체를 한꺼번에 돌리면:** 이 PC에서는 무거운 D1 시험이 동시에 돌면서 "fetch failed"·503으로 몇 개가 떨어진다.
  - main도 같다. 무거운 시험이 제시간에 준비되도록 `--hookTimeout=60000`을 주면, main에서도 4개 파일 7개 시험이 같은 식으로 떨어진다.
  - 그래서 D1 시험은 차례로 돌린 결과를 기준으로 삼았다.
  - 워크트리에는 재구성 기준 그림이 없어 6개가 ENOENT로 떨어진다. 이 작업과 무관하다.

## 7. 원격 적용 (사용자가 정함)

- **순서**
  1. 이 브랜치를 main에 합치고 push한다. 자동 배포로 새 코드가 먼저 나간다.
  2. 그다음 원격에 0014를 적용한다.
- **순서가 중요한 이유:** 옛 코드는 목록 이미지 일괄에서 `d1_list_recent`를 이름으로 부른다. 0014가 먼저면 그 관리자 도구가 배포 전까지 실패한다.
- **새 코드 + 옛 스키마:** 문제없다. 쓰기만 예전만큼 많다.
- **명령:** main에 합친 뒤 본 폴더에서 실행한다.

```bash
npx wrangler d1 migrations apply DB --remote --config wrangler.jsonc
```

- **원격에서 쓸 행:** 0014는 색인 지우기와 트리거 다시 만들기뿐이고, 줄을 넣거나 고치지 않는다.
  - 로컬 측정: 공용 자재 200개 DB에 적용하면 문장 16개가 쓴 행 3, 읽은 행 1,937이었다(`tests/d1-write-cost.test.ts`).
  - 원격(자재 약 2천 개)도 쓰기는 몇 행이다. 읽기는 지우는 색인 크기를 따라 2만 행 안팎으로 추정한다(하루 한도 500만의 0.4%).
- **적용 시각:** 하루 쓰기에 여유가 있을 때가 좋다. 한국 오전 9시 초기화 뒤를 권한다.

## 8. 한계

- 측정은 로컬 Miniflare D1이다. 원격의 행 수 세는 방식과 조금 다를 수 있다. 저장 전 107행은 운영 추정 약 110행과 거의 같았다.
- 옛 버전 요약 줄의 updated_at은 이제 그 버전이 마지막으로 현재였던 때의 값이다.
  - 읽는 곳(`rowsFor`·`adminProjectEntries`)은 자재 표에서 읽게 바꿨다.
  - 앞으로 그 열을 새로 읽는 코드는 자재 표를 봐야 한다.
- 보통 저장에서 새 버전이 아직 들어오지 않은 사이에는 옛 현재 버전이 현재로 남는다.
  - 같은 batch 안이라 밖에서는 보이지 않는다.
  - SQL로 자재의 `current_version_id`만 없는 버전으로 바꾸고 그 버전을 넣지 않으면 옛 줄이 현재로 남는다. 앱은 그렇게 쓰지 않는다.
- 수정 저장이 읽는 행은 그 자재의 버전 수에 따라 조금 늘어난다(버전 20개에 210행). 트리거가 그 자재의 현재 버전을 찾기 때문이다.
- 상태 변경(사용 끄기·켜기, 공용·개인 전환)은 지금처럼 모든 버전에 복사한다(버전 21개에 141행).
- 옛 전체 목록 요청 `list`는 2026-11-06에 지웠다. 원격 0014도 같은 날 적용된 것을 확인했다(`migrations list --remote`: 남은 것 없음).

## 9. 재실행

```bash
npx vitest run tests/d1-write-cost.test.ts tests/d1-write-cost-equivalence.test.ts
```

```bash
SJN_D1_WRITE_TILES=1000 npx vitest run tests/d1-write-cost.test.ts
```

```bash
npx playwright test e2e/admin-ai-usage.spec.ts
```

D1 시험 전부를 차례로(약 24분):

```bash
npx vitest run tests/d1-*.test.ts tests/admin-projects.test.ts tests/admin-ai-usage.test.ts --fileParallelism=false
```
