# Cloudflare 하루 한도 화면 안내 결과 (2026-10-18)

## 1. 왜

이 서비스는 Cloudflare Workers Free 플랜을 쓴다. 하루 한도는 다음과 같고, 모두 매일 00:00 UTC(한국 09:00)에 초기화된다.

- D1 읽기 500만 행
- D1 쓰기 10만 행
- Workers AI 10,000뉴런

2026-10-16~17에 실제로 D1 읽기 한도를 넘었다([D1 읽기 줄이기 결과](d1-query-efficiency-results-20261017.md)). 그런데 화면에는 일반 문구만 나왔다.
- "서버 저장에 실패했어요"
- "서버 저장소에 연결하지 못했어요"

그래서 사용자는 왜 안 되는지도, 언제 다시 되는지도 알 수 없었다. AI 한도 문구에도 "언제"가 없었다.

이번 작업으로 한도가 차면 모든 화면이 세 가지를 말한다.
- 무엇이 멈췄는가
- 언제(한국 시간) 다시 되는가
- 지금 할 수 있는 것

안내는 이미 오가는 응답에서만 만든다. 새 요청, 폴링, 재확인은 없다.

## 2. 판별하는 문구와 출처

**출처** (2026-10-18 확인)
- https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/
- https://developers.cloudflare.com/d1/observability/debug-d1/

| 상황 | 찾는 부분 문자열(대소문자 무시) | 결과 |
| --- | --- | --- |
| D1 읽기 한도 | `free tier daily row read limit` | `db-read` + 다음 00:00 UTC |
| D1 쓰기 한도 | `free tier daily row write limit` | `db-write` + 다음 00:00 UTC |
| D1 저장 용량 | `exceeded maximum db size` / `maximum account storage limit` | `db-storage`(시각 없음, 관리자 문의) |
| Workers AI 하루 할당 | 기존 `classifyCloudGemmaFailure`의 `quota_exhausted`(내부 코드 3036 등) | `ai` + 다음 00:00 UTC |

- 앞에 `D1_ERROR: `가 붙거나 끝부분이 달라도 된다.
- 오류의 `message`와 `cause`(3단계)를 본다.
- 관계없는 오류(`UNIQUE constraint`, `no such table`, 연결 끊김)는 판별하지 않는다.

## 3. 응답 계약

| 경우 | 응답 |
| --- | --- |
| D1 한도 | 503 `{ error, code: 'SERVICE_LIMIT', limit: { service, resetAt } }` |
| AI 하루 할당 | 지금처럼 429 `quota_exhausted`에 `limit: { service: 'ai', resetAt }`만 더함(클라이언트 `ENDS_RUN` 호환, 자동 재시도 없음) |
| `/api/storage/status` | 준비 검사가 한도면 `reason: 'daily_limit'`(용량은 `storage_full`) + `limit` |

응답에는 원문 오류, 계정 정보, 사용량 숫자를 넣지 않는다. 시험에서 본문에 "exceeded"·"D1_ERROR"·"Workers Paid"가 없음을 확인한다.

### 라우트별 출구

D1을 거치는 모든 라우트(`src/app/api/**/route.ts`)는 다섯 출구 중 하나로 끝난다. 다섯 곳 모두 맨 앞에서 한도를 판별한다.

| 라우트 | 출구 |
| --- | --- |
| `/api/d1/{assets,catalog,cleanup,materials,project-materials,projects,role}` | `d1Route`: 로그인 확인은 `serverError`, 처리기·변경 재시도는 `errorResponse` |
| `/api/admin/{users,projects,project-assets,project-materials,ai-usage}` | `adminRoute`: 로그인 확인은 `serverError`, 처리기는 `adminErrorResponse` → `errorResponse` |
| `/api/catalog/{materials,images,placement}` | `serverError` |
| `/api/storage/session` | `serverError`(get-session 감시 포함) |
| `/api/storage/status` | `storageStatus` → `daily_limit`·`storage_full` |
| `/api/auth/[...all]` | `handleD1Auth`(DB 감시) → 바깥은 `serverError` |
| `/api/reconstruction/diagnostics` | 로그인 확인은 `serverError`, 처리기는 `errorResponse` |
| `/api/export/photoreal{,/product,/check}`, `/api/materials/direction-photo`, `/api/reconstruction/cloud` | `cloudGemmaErrorResponse`: AI 할당은 429 + `limit`, 로그인 확인 중 D1 한도는 503 `SERVICE_LIMIT` |
| `/api/cloud/*`, `/api/reconstruction/local*`, `/api/reconstruction-lab/engine` | D1 없음(고정 410) |

응답을 만들지 않고 오류를 삼키는 뒷정리(`d1/cleanup.ts`, 진단 정리)는 그대로 두었다.

### Better Auth가 삼키는 한도

시험해 보니 Better Auth는 DB 오류를 두 가지로 삼켰다.
- **HTTP get-session**: "세션 없음"(200 `null`)으로 답한다.
- **서버 API `getSession`**: 원문 없는 자기 `INTERNAL_SERVER_ERROR`를 던진다.

그대로 두면 D1 한도가 "로그아웃됨"(401)으로 보여, 계정 작업 화면이 로그인 안내로 바뀐다.

그래서 로그인 경로(`handleD1Auth`, `getD1Session`)는 `watchServiceLimit`로 DB를 감싸 한도 오류만 기록한다.
- 쿼리, 순서, 결과는 그대로다.
- 감싸기 전후의 실행 쿼리 목록이 같음을 시험으로 확인했다(d1-query-budget: 새 SQL·추가 쿼리 없음).

## 4. 화면

| 곳 | 보이는 것 |
| --- | --- |
| 모든 페이지(공개 포함) 위쪽 띠 | DB: "오늘 서버 이용 한도를 모두 써서 로그인·저장·불러오기가 잠시 멈췄어요. **내일 10월 19일(월) 오전 9시** 이후 다시 접속해 주세요. 열려 있는 작업은 이 기기에 보관돼요." / AI: "오늘 AI 이용 한도를 모두 써서 AI 기능(실사 변환·방향 사진·설비 분석)을 쓸 수 없어요. … 이후 다시 시도해 주세요. 편집과 저장은 계속할 수 있어요." / 용량: "서버 저장 공간이 가득 찼어요. 관리자에게 알려 주세요." |
| 계정 작업공간 잠금 화면, `/login` 준비 안내 | "로그인과 D1·R2 연결 설정을 먼저 확인해 주세요." 대신 DB 문구와 시각 |
| 로그인 실패 | "아이디 또는 비밀번호가 맞지 않아요." 대신 DB 문구 |
| AI 버튼 옆(실사 변환, 방향 사진, 자동 초안) | "AI 한도 · 내일 10월 19일(월) 오전 9시 이후". 버튼은 막지 않는다(누르면 서버가 다시 거절, 비용 없음) |
| 공개 자재 목록 오류 영역 | DB 문구와 시각 |

**시각과 기억**
- 시각은 `Asia/Seoul`로 쓰고, 브라우저 시계로 "오늘"·"내일"을 붙인다.
- 안내는 `localStorage['sjn-service-limit']`에 `{service, resetAt}`만 남겨 새로고침 뒤에도 보인다. 저장소가 없거나 거부하면 그 페이지에서만 보인다.
- `resetAt`이 지나면 타이머로 숨긴다. 이때 요청은 없다.
- 그 종류의 정상 응답을 받으면 지운다.

**스크린샷**(git 제외, `test-results/e2e/service-limit-*/`)
- `limit-login-desktop.png`, `limit-home-mobile.png`(375px)
- `limit-save-desktop.png`
- `limit-ai-desktop.png`, `limit-ai-mobile.png`

## 5. 테스트

**단위·서버(vitest)**
- `tests/service-limit.test.ts` 7개
  - 판별: 공식 문구, `D1_ERROR: ` 접두, `cause` 안, 대소문자, 끝부분 차이, `quota_exhausted`, 관계없는 오류
  - `resetAt`: UTC 23:59, 00:00 정각, 한국 08:59·09:00 전후, 연말
  - 응답 모양
  - DB 감시: 결과·오류를 그대로 넘기고, 배치에는 원래 문장을 넘기고, 쿼리를 늘리지 않음
- `tests/service-limit-server.test.ts` 7개: 실제 Miniflare D1/R2와 실제 Better Auth
  - `/api/storage/status`: `daily_limit`·`storage_full`. 다른 오류는 `connection_failed`, 정상이면 `ready`
  - 로그인·get-session·`/api/storage/session`: get-session이 200 null 대신 한도로 답함
  - `/api/d1/projects`: 로그인 확인 단계와 처리기 단계, 쓰기 한도
  - 공개 자재, 관리자 API(로그인 확인 단계와 처리기 단계)
  - AI 라우트의 로그인 확인 중 D1 한도: 모델 호출 0회
  - 감싸기 전후의 실행 쿼리 목록이 같음
  - 다른 오류는 원래 응답 그대로
  - 모든 응답 본문에 원문이 없음
- `tests/service-limit-notice.test.ts` 7개
  - 시각 문구: 오늘·내일·그 밖, 요일, 월말, 연말
  - 화면 문구 4종
  - `limit` 검증
  - 저장소 기억: 종류마다 하나, 지난 시각 숨김, 정상 응답이면 지움, 저장소 거부, 깨진 값
- **AI 5곳**: 기존 `flux-export`·`flux-product-server`·`direction-photo-server`·`flux-check`·`reconstruction-cloud-gemma` 시험의 한도 사례에, 라우트 응답의 `limit: { service: 'ai', resetAt }` 확인을 더했다. 속도 제한(`rate_limited`)에는 `limit`이 없음도 확인한다.
- **전체 `npx vitest run`**: 249개 파일 중 245개 통과, 3개 실패, 1개 건너뜀
  - 알려진 환경 실패: reconstruction-corpus 1, source-plane-mapping 5
  - 동시 실행 부하로 인한 시간 초과: flux-composite 1(단독 재실행 12/12 통과)

**e2e(Playwright, 라우트 가로채기, `page.clock`으로 2026-10-18 12:00 한국 시간)**
- `e2e/service-limit.spec.ts` 4개 통과
  1. 준비 검사가 `daily_limit`이면 다음이 확인된다.
     - 메인·`/login`·잠금 화면에 띠와 "내일 10월 19일(월) 오전 9시" 문구가 보인다.
     - 같은 화면을 정상일 때와 한도일 때 열어 `/api/` 경로별 요청 수를 비교했다. 한도일 때 새 경로가 없고 횟수가 같거나 적다.
     - 60초 동안 두어도 요청이 0회다.
     - 09:00이 지나면 요청 없이 띠가 사라진다.
     - 375px에서 가로 스크롤이 없다.
  2. 프로젝트 저장이 `SERVICE_LIMIT`을 받으면 띠가 보이고, 고친 이름이 화면에 남는다.
  3. 로그인 실패가 한도 응답이면 한도 문구가 보이고 "아이디 또는 비밀번호"는 없다.
  4. 실사 변환이 `quota_exhausted`와 `resetAt`을 받으면 다음이 확인된다.
     - 대화상자 오류, 띠, 버튼 옆 "AI 한도 · …"가 보인다.
     - 버튼은 쓸 수 있다.
     - 새로고침해도 안내가 남고, AI 요청은 다시 가지 않는다.
     - 09:00이 지나면 사라진다.
- `e2e/direction-photo-ai.spec.ts` 3개 통과: 한도 응답에 `limit`을 더해 다음을 확인했다.
  - 후보 실패 문구가 한도 문구다.
  - 띠가 보인다.
  - "방향 사진 만들기" 옆에 "AI 한도 · … 오전 9시 이후"가 보인다.
  - 버튼은 쓸 수 있다.
- `e2e/cloud-recovery.spec.ts`, `e2e/login-flow.spec.ts` 모두 통과(관련 4개 파일에서 26개 중 23개 통과).
  - `flux-export.spec.ts`는 8개 중 3개가 실패했다.
  - 그중 2개(453행 "the AI input is the outside view…", 772행 "composite export…")는 이번 변경이 없는 기준 코드에서도 똑같이 실패했다.
  - 나머지 1개(19행 또는 121행, 실행마다 다름)는 단독 재실행에서 통과했다.

**그 밖**
- `npm run typecheck`, `npm run lint`(전체, 문제 0) 통과
- 바꾼 코드 파일 Prettier 검사 통과. 원래 Prettier를 적용하지 않은 파일(`auth/d1.ts`, `public-catalog.tsx`, `reconstruction-cloud-gemma.test.ts`)은 바꾼 줄만 고쳤다.

## 6. 병합과 배포

- **브랜치**: `claude/service-limit-notice`(최신 `origin/main` `df73162`에서 출발, 원격에도 푸시). 커밋은 세 개다.
  1. `2347da2` 서버 판별·응답 계약·테스트
  2. `68fefaa` 화면 안내·e2e
  3. `4abf007` 문서
- **병합**: `git fetch` 뒤 main이 그대로라(`df73162`) 다시 맞출 것이 없었다. main 병합 커밋 `b59ac39`를 2026-10-18 17:29:50 KST에 `git push origin main` 했다(강제 푸시 없음).
- **배포 확인**(읽기만, 실제 한도 상황은 만들지 않음)
  - Cloudflare 자동 배포: 푸시 약 74초 뒤 `2026-10-18T08:31:04Z`, 버전 `2583817e-b795-4597-bed0-474bdfccfb2a`(`wrangler deployments list`)
  - `https://sjn.gyulbbe.workers.dev/api/storage/status`: `{"mode":"d1","ready":true,"reason":"ready","authRequired":true,"googleSignIn":true}`
  - 내장 브라우저로 연 `/`, `/login`, `/materials`
    - 모두 정상이고 안내 띠는 없었다(`service-limit-banner` 0개, 저장된 안내 없음).
    - `/materials`는 "928개의 자재"를 보였다.
    - `/login`에는 경고가 없었다.
  - 배포된 스크립트(`repositories-*.js`)에 새 코드(`sjn-service-limit`)가 들어 있음을 확인했다.

## 7. 하지 않은 것과 한계

- **사전 경고("곧 한도") 없음**: 관리자 AI 사용량 화면이 있지만 토큰이 필요하고 요청이 늘어난다.
  - 제안: 관리자 화면에서 그날 사용량을 보여 주는 것은 별도 작업으로 할 수 있다.
- **Workers 요청 수 한도(하루 10만)는 안내할 수 없다**: 넘으면 Cloudflare가 Worker 실행 전에 자체 오류 페이지를 보여서, 앱 코드가 실행되지 않는다.
- **D1 쓰기 한도의 문구**: "저장이 잠시 멈췄어요"로 따로 쓴다. 읽기는 될 수 있어서다.
- **띠가 뜨는 때**: 한도를 넘기 직전에 열려 있던 화면은 다음 요청(저장, 목록, 5분마다 하는 로그인 확인 등)에서 한도 응답을 받아야 띠를 보인다.
