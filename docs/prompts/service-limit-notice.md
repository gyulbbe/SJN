# Cloudflare 하루 한도 도달 시 화면 안내 (DB·AI) + main 푸시

## 0. 배경

이 서비스는 Cloudflare **Workers Free 플랜**을 쓴다. 하루 한도는 아래와 같고, 모두 **매일 00:00 UTC(한국 시간 09:00)**에 초기화된다.

| 서비스     | 하루 한도  | 넘으면                                                                                                       |
| ---------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| D1 읽은 행 | 500만      | 모든 D1 쿼리가 오류. 로그인, 프로젝트 저장·불러오기, 자재 목록, 관리자 화면이 멈춘다. 저장된 자료는 그대로다 |
| D1 쓴 행   | 10만       | 쓰기가 오류                                                                                                  |
| Workers AI | 10,000뉴런 | FLUX(실사 변환, 방향 사진, 제품 다듬기)와 Gemma(설비 분석, 결과 확인)가 오류                                 |

2026-10-16~17에 실제로 D1 읽기 한도를 넘었다. 그런데 화면에는 "서버 저장에 실패했어요", "서버 저장소에 연결하지 못했어요" 같은 일반 문구만 나와서, 사용자는 왜 안 되는지와 언제 다시 되는지를 알 수 없었다. AI 한도도 지금은 "Cloudflare AI 사용 한도를 모두 사용했어요. 한도가 갱신된 뒤 다시 시도해 주세요."까지만 나오고, **언제** 다시 되는지는 없다.

**목표:** 한도가 찼을 때 모든 화면에서 사용자가 다음 세 가지를 알 수 있게 한다.

1. **무엇이** 멈췄는가: 저장·불러오기 / AI 기능
2. **언제** 다시 되는가: 예) "10월 19일(일) 오전 9시 이후 다시 접속해 주세요"
3. **지금 할 수 있는 것**: 예) 작업 내용은 이 기기에 보관된다, AI 없이 편집은 계속할 수 있다

이 작업은 **main 푸시까지** 한다(사용자 요청). main 푸시는 Cloudflare 자동 배포로 이어진다.

## 1. 먼저 읽을 것

- `.agents/skills/sjn-workflow/SKILL.md`와 references의 `development-environment.md`, `database.md`, `project-overview.md`
- `.agents/skills/d1-query-budget/SKILL.md`가 main에 있으면 그것도 읽는다. 이번 작업은 **새 D1 쿼리, 새 폴링, 새 요청을 추가하지 않는다.** 안내는 이미 오가는 응답에서만 만든다.
- 현재 오류 경로
  - D1: `src/lib/d1/http.ts`의 `errorResponse`(알 수 없는 오류 → 503 `STORAGE_UNAVAILABLE`)와 `src/lib/storage/server.ts`
    - `serverError`
    - `storageStatus`: 준비 검사 실패 → `connection_failed`
  - D1을 거치는 다른 곳: `src/lib/storage/config.ts`의 `StorageReason`·`STORAGE_MESSAGES`, `src/components/app-provider.tsx`(준비 상태 안내 약 353행), `src/app/api/auth/[...all]/route.ts`(Better Auth), `src/lib/catalog/public-context.ts`·`public.ts`·`server.ts`, `src/lib/admin/**`, `src/lib/reconstruction/diagnostic-archive-server.ts`
  - AI: `src/lib/reconstruction/cloud-gemma-errors.ts`의 `classifyCloudGemmaFailure`(내부 코드 3036 등 → `quota_exhausted`, 429). 이 함수를 쓰는 라우트는 다음과 같다.
    - `/api/export/photoreal`, `/api/export/photoreal/product`, `/api/export/photoreal/check`
    - `/api/materials/direction-photo`
    - `/api/reconstruction/cloud`
  - 클라이언트 fetch: `src/lib/repositories/cloud.ts`, `src/lib/admin/project-repository.ts`, 각 AI 클라이언트(`src/lib/ai-export/client.ts`, `src/lib/direction-photo/client.ts`, 재구성 분석 transport 등)

## 2. Cloudflare가 돌려주는 오류 (2026-10-18 공식 문서 확인)

출처는 다음 두 곳이다. D1 오류 문구는 `D1_ERROR` 계열이다.

- https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/
- https://developers.cloudflare.com/d1/observability/debug-d1/

| 상황                 | 메시지 시작 부분(판별에 쓸 부분 문자열)                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| D1 읽기 한도         | `Your account has exceeded D1's free tier daily row read limit.` → **`free tier daily row read limit`**   |
| D1 쓰기 한도         | `Your account has exceeded D1's free tier daily row write limit.` → **`free tier daily row write limit`** |
| D1 저장 용량         | `Exceeded maximum DB size.` / `exceeded D1's maximum account storage limit`                               |
| Workers AI 하루 할당 | 내부 코드 `3036` 등. 이미 `classifyCloudGemmaFailure`가 판별한다                                          |

- 판별은 대소문자를 무시하고 부분 문자열로 한다. 메시지 끝부분은 문서마다 다르다.
- `e.message`와 `e.cause?.message`를 모두 본다.
- 앞에 `D1_ERROR: ` 같은 접두가 붙을 수 있다.
- D1 저장 용량 초과는 시간이 지나도 풀리지 않는다. "언제 다시"를 쓰지 말고 관리자 문의 안내로 따로 다룬다.

## 3. 만들 것

### 3-1. 서버: 한도 판별과 응답 계약

공용 모듈을 만든다(예: `src/lib/platform/service-limit.ts`).

- `detectServiceLimit(error)`: 결과는 `{ service: 'db-read' | 'db-write' | 'db-storage' | 'ai'; resetAt?: string }` 또는 `null`.
  - `resetAt`은 **다음 00:00 UTC**의 ISO 시각이다. 서버 시각으로 계산하며 `db-storage`에는 없다.
  - AI는 기존 `quota_exhausted` 판별을 재사용한다.
- 응답 계약은 하나로 통일한다.
  - D1 한도: 503, `{ error, code: 'SERVICE_LIMIT', limit: { service, resetAt } }`
  - AI 한도: 지금 쓰는 `code: 'quota_exhausted'`와 상태 429를 유지한다(기존 클라이언트 `ENDS_RUN` 등 호환). 여기에 `limit: { service: 'ai', resetAt }`만 더한다.
  - 응답에 계정 정보, 원문 오류, 사용량 숫자는 넣지 않는다.
- 적용할 곳
  - `d1/http.ts`의 `errorResponse`와 `storage/server.ts`의 `serverError`: 일반 503 대신 위 계약을 쓴다.
  - **`storageStatus`**: 준비 검사에서 한도 오류가 나면 새 `StorageReason`인 `'daily_limit'`(또는 `'storage_full'`)과 `resetAt`을 돌려준다. `/api/storage/status`는 이미 앱이 처음 열릴 때 부르는 요청이므로, **새 요청 없이** 한도를 미리 알 수 있다.
  - **로그인**(`/api/auth/[...all]`): Better Auth가 D1 한도 오류로 실패하면 같은 계약의 JSON을 돌려주도록 감싼다. 정상 응답은 건드리지 않는다.
  - 공개 자재(`/api/catalog/**`), 관리자 API, 진단 아카이브 등 D1을 거치는 라우트를 `grep -rn "env.DB\|ctx.env.DB" src`로 모두 찾아 같은 처리를 하고, 빠진 곳이 없는지 확인한다.
  - AI 라우트 5곳: `quota_exhausted` 응답에 `limit.resetAt`을 더한다. 자동 재시도는 지금처럼 하지 않는다.

### 3-2. 화면: 전역 안내

- **전역 상태**: 클라이언트 fetch 공통 경로(`responseJson` 등)와 AI 클라이언트가 `SERVICE_LIMIT`나 `limit`이 있는 응답을 받으면 전역 이벤트·상태로 알린다(예: `sjn-service-limit`). `/api/storage/status`의 `daily_limit`도 같은 상태로 들어간다.
- **안내 띠**: 모든 페이지(공개 페이지 포함) 위쪽에 고정하지 않는 띠를 하나 둔다. 같은 종류는 하나만 보인다.
- **시각 표시**
  - `resetAt`을 **한국 시간**(`Asia/Seoul`)으로 "10월 19일(일) 오전 9시"처럼 쓴다.
  - 오늘이면 "오늘 오전 9시", 내일이면 "내일 오전 9시"를 앞에 붙인다.
  - 기준 시각은 브라우저 시계로 한다.
- **문구 예시**(톤은 기존 화면 문구에 맞춘다)
  - DB: "오늘 서버 이용 한도를 모두 써서 로그인·저장·불러오기가 잠시 멈췄어요. **내일 오전 9시 이후** 다시 접속해 주세요. 열려 있는 작업은 이 기기에 보관돼요."
  - AI: "오늘 AI 이용 한도를 모두 써서 AI 기능(실사 변환·방향 사진·설비 분석)을 쓸 수 없어요. **오늘 오전 9시 이후** 다시 시도해 주세요. 편집과 저장은 계속할 수 있어요."
  - 저장 용량: "서버 저장 공간이 가득 찼어요. 관리자에게 알려 주세요."(시각 없음)
- **기억**
  - 안내는 `resetAt`까지 유지한다. 새로고침해도 보이도록 `localStorage`에 `{ service, resetAt }`만 둔다(읽기·쓰기 모두 try/catch, 없어도 동작).
  - `resetAt`이 지나면 자동으로 숨긴다. 이때 **새 요청을 보내 확인하지 않는다.** 다음 정상 응답이나 사용자 동작으로 자연스럽게 풀린다.
  - 정상 응답을 받으면 해당 종류의 안내를 지운다(예: 다른 사람이 유료로 바꿔 풀린 경우).
- **화면별 처리**
  - 계정 작업공간 잠금 화면(`app-provider.tsx`의 `STORAGE_MESSAGES`): `daily_limit`이면 일반 연결 실패 문구 대신 위 DB 문구와 시각을 보인다.
  - 로그인 화면: 한도 응답이면 "아이디·비밀번호 확인" 같은 엉뚱한 문구 대신 DB 문구를 보인다.
  - AI 버튼: AI 한도 상태인 동안 버튼 옆에 짧은 안내와 시각을 보인다. 버튼은 막지 않고, 누르면 같은 안내를 보인다. 서버가 다시 거절하므로 비용은 없다.
  - 자재 목록(공개): 기존 "오류·다시 시도" 영역에 DB 문구와 시각을 보인다.
- 모바일 폭(375px)에서도 띠가 잘리지 않아야 한다. Tailwind를 쓰고, 여백이 중요한 곳은 `<p>` 대신 `<div>`를 쓴다.

### 3-3. 하지 않을 것

- 사용량을 미리 조회해 "곧 한도"를 알리는 기능은 이번 범위가 아니다. 관리자 AI 사용량 화면이 있지만 토큰이 필요하고 요청이 늘어난다. 결과 문서에 제안으로만 적는다.
- **Workers 요청 수 한도**(하루 10만)를 넘으면 Cloudflare가 Worker 실행 전에 자체 오류 페이지를 보여서 앱이 안내할 수 없다. 이 한계를 결과 문서에 적는다.
- 운영 설정, 비밀값, 요금제는 바꾸지 않는다.

## 4. 테스트

- **단위**
  - `detectServiceLimit`: 2절 문구의 변형(접두 `D1_ERROR: `, `cause` 안의 메시지, 대소문자, 끝부분 차이), 관련 없는 오류는 `null`
  - `resetAt` 계산: UTC 23:59, 00:00 정각, 한국 시간 08:59와 09:00 전후
  - 한국어 시각 문구: 오늘/내일, 날짜와 요일, 월말·연말 넘김
- **서버**
  - Miniflare나 모의 DB가 위 문구로 throw하게 한다.
  - `d1Route`, `/api/storage/status`(→ `daily_limit` + `resetAt`), 로그인 라우트 감싸기, 공개 자재, 관리자 API가 같은 계약으로 응답하는지 확인한다.
  - 원문 오류가 응답에 새지 않는지 확인한다.
  - AI 라우트 5곳에서 3036 오류를 모의하면 `quota_exhausted` + 429 + `limit.resetAt`이 나오는지 확인한다.
- **화면 e2e**(Playwright, 라우트 가로채기로 한도 응답을 흉내 낸다. 실제 한도나 AI 호출 없이)
  - 첫 진입에서 `/api/storage/status`가 `daily_limit`이면 띠와 잠금 화면에 시각이 보인다.
  - 프로젝트 저장 중 `SERVICE_LIMIT`을 받으면 띠가 보이고 작업이 유지된다.
  - 로그인 실패가 한도 문구로 보인다.
  - 방향 사진·실사 변환의 `quota_exhausted` + `resetAt`이 띠와 버튼 옆 안내로 보인다.
  - 새로고침해도 `resetAt` 전에는 띠가 보이고, 시계를 `resetAt` 뒤로 돌리면 사라진다(Playwright clock).
  - 데스크톱과 375px 모바일 스크린샷을 남긴다.
- **호출 수**: 이번 변경으로 새 `/api/` 요청이나 폴링이 생기지 않았는지 e2e에서 `page.on('request')`로 확인한다(d1-query-budget 3절).
- **기존 검사**: `npm run typecheck`(끝나면 `next-env.d.ts` 되돌림), `npm run lint`, Prettier 검사(쓰기는 `--end-of-line crlf --write`, 검사는 `--end-of-line auto`), 전체 `npx vitest run`(알려진 환경 실패만 허용), 관련 e2e

## 5. 문서

- `development-environment.md`
  - 무료 한도 표와 초기화 시각
  - 한도 응답 계약(`SERVICE_LIMIT`, `limit`)
  - 화면 안내 동작
  - Workers 요청 수 한도는 앱이 안내할 수 없다는 한계
- `project-overview.md`: 사용자에게 보이는 한도 안내
- 결과 문서 `docs/service-limit-notice-results-YYYYMMDD.md`
  - 바꾼 곳 목록
  - 판별 문구와 출처
  - 화면 스크린샷 경로
  - 테스트 결과
  - 배포 확인
  - 하지 않은 것(사전 경고, Workers 요청 한도)

## 6. 커밋, main 병합, 푸시 (사용자가 이 작업에 요청함)

1. 최신 `origin/main`에서 새 브랜치를 만들어 작업한다.
2. 커밋을 나눈다: (1) 서버 판별·응답 계약·테스트, (2) 화면 안내·e2e, (3) 문서. 메시지는 기존 기록처럼 한국어로 쓴다.
3. **푸시 전 조건**: 4절 검사가 모두 통과해야 한다. 하나라도 실패하면 푸시하지 않고 보고한다. 그냥 `git stash`는 쓰지 않는다.
4. `git fetch origin` 후 main이 그 사이 바뀌었으면 브랜치에 반영하고 다시 검사한다. 충돌이 나면 해결 내용을 보고한다.
5. main에 병합한다. 기존 기록처럼 `병합: ...` 메시지의 merge 커밋을 만든다. 그다음 `git push origin main` 한다. 강제 푸시는 금지한다.
6. **배포 확인(읽기만)**
   - 약 1~2분 뒤 운영 주소(`https://sjn.gyulbbe.workers.dev`)를 연다.
   - `/api/storage/status`가 `ready: true`인지 본다.
   - 메인, 로그인 화면, 자재 목록이 정상인지 본다(띠가 보이지 않아야 한다).
   - 실제 한도 상황은 만들지 않는다.
7. 작업 브랜치의 원격 푸시는 필요하면 하고, 지우지는 않는다.

## 7. 보고

다음을 보고한다.

- 바꾼 파일과 이유
- 판별하는 문구
- 화면 문구와 스크린샷(데스크톱·모바일)
- 테스트 결과(수치)
- main 병합 커밋 해시
- 배포 확인 결과
- 남은 한계: 사전 경고 없음, Workers 요청 한도는 안내 불가
