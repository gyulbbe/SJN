# 개발환경 참조

체험의 우측 견적·수량·단가·속성·공간 구조 조절과 시안 추가/비교는 비로그인으로 허용한다. 상단 공간 둘러보기·AI 보정·저장·공간 크기·내보내기는 로그인 안내로 연결한다. 공개 자재의 등록된 가격·포장 정보만 사용하며, 수정한 견적과 시안은 같은 탭의 초안에만 보관한다.

확인 기준: **2026-09-17 현재 소스**. 2026-09-17 사용자 승인 후 D1 `sjn`의 기존 0001~0004에 0005·0006을 추가 적용했고, `.wrangler/development`의 빈 로컬 개발 DB에는 0001~0006을 순서대로 적용했다. 양쪽 초기 데이터·무결성을 확인했다. 관리자 지정·배포·R2 버킷 생성·실제 Google 인증·AI 호출은 수행하지 않았다. 실제 secret은 문서·로그·Git에 기록하지 않는다. 기존 R2 `sjn`(Standard/APAC, 2026-09-14 생성, 확인 당시 객체 0개)을 읽기 확인했고 소스에 `ASSET_BUCKET → sjn`을 추가했다. 2026-09-17 14:46:54 UTC에 생성된 현재 실배포 버전(`d70ff6c6-bd4e-4bba-9758-9bd5bdd81911`)을 읽기 확인한 결과 `DB`·`ASSET_BUCKET`·`AI`·`ASSETS` 바인딩과 `APP_ENV=production`·`STORAGE_MODE=d1`·`BETTER_AUTH_URL=https://sjn.gyulbbe.workers.dev`가 있다. 운영 secret 목록은 비어 있고 전체 바인딩에도 `BETTER_AUTH_SECRET`·`GOOGLE_CLIENT_ID`·`GOOGLE_CLIENT_SECRET`이 없어 로그인 준비 검사가 실패한다. 2026-09-23 소스부터 로그인 준비에 필수인 secret은 `BETTER_AUTH_SECRET`뿐이고 Google 두 값은 선택이다(둘 다 없으면 아이디 로그인만, 한쪽만 있으면 설정 오류). 이 소스는 `0007_username_auth.sql`의 `username`·`displayUsername` 컬럼을 준비 조건으로 본다. 2026-09-23 사용자가 원격 `sjn`에 0007의 `username`·`displayUsername` 컬럼을 직접 추가했고(auth meta version 1 유지), 같은 날 사용자 승인으로 Time Travel 북마크 기록 후 남은 고유 인덱스 `user_username_idx`와 `d1_migrations`의 0007 기록을 추가했다. 원격 목록은 `No migrations to apply`이며 회원 수는 변하지 않았다. 실제 `/api/storage/status`는 `ready=false`, `reason=invalid_configuration`이다. 이 확인은 운영 설정 변경·배포를 하지 않은 읽기 검사이며, 인증 준비 검사에서 중단되므로 현재 D1/R2 실제 읽기·쓰기나 Google 로그인이 성공했다는 뜻은 아니다. 실제 Google OAuth·R2 업로드 검증은 남아 있다. 로컬 `.dev.vars`·`.env.local`·`.env`·`.dev.vars.development`도 확인 당시 없었다. Google callback은 `https://sjn.gyulbbe.workers.dev/api/auth/callback/google`이다.

## 실행과 검사

Node 기준은 [`.node-version`](../../../../.node-version)의 22.23.2다. [package.json](../../../../package.json)과 lockfile을 사용하며 새 환경은 `npm ci`로 설치한다.

| 목적 | 명령 | 동작 |
| --- | --- | --- |
| 기본 Workers 개발 | `npm run dev` 또는 `npm run dev:vinext` | vinext, `http://127.0.0.1:3000`, 로컬 D1/R2; 계정 기능은 아이디 가입·로그인(Google은 설정 시) |
| 개발 migration | `npm run db:dev:migrate` | 0001~0011 중 미적용 번호, 로컬 DB만, `.wrangler/development` |
| 별도 Next 개발 | `npm run dev:next` | Node/Next, Cloudflare D1/R2/AI 바인딩 없음; 기본 앱 작업 공간 대체 아님 |
| Next 빌드 | `npm run build` → `npm run start` | Node 빌드/실행 검사; Workers 바인딩은 생기지 않음 |
| Workers 빌드·미리보기 | `npm run build:vinext` → `npm run start:vinext` | 빌드 설정과 `dist/server/wrangler.json`, 포트 8787, `.wrangler/state` |
| 기본 검사 | `npm run typecheck`, `npm run lint`, `npm test` | 변경 범위에 맞는 검증; Next/vinext 빌드는 순차 실행 |

vinext 개발 서버는 클라이언트 모듈을 동적 import로 받아 Next 개발 서버보다 하이드레이션이 늦다(홈 기준 0.3~2초). 서버에서 먼저 그려지는 공개 화면의 버튼은 하이드레이션 전까지 비활성으로 두고(`GuestHome`), e2e는 활성화를 기다린 뒤 누른다.

개발 서버(vinext)는 1MB를 넘는 업로드를 기본 한도(`serverActions.bodySizeLimit`)로 413으로 막는다. 큰 사진(1MB 초과)을 실제로 저장해 보는 확인에서만 `next.config.ts`에 `experimental: { serverActions: { bodySizeLimit: '40mb' } }`를 임시로 넣고 서버를 다시 띄운 뒤, 끝나면 반드시 되돌린다(커밋 금지). 운영 Workers에서도 그런지는 확인하지 못했다.

[dev-local](../../../../scripts/dev-local.mjs)는 `APP_ENV=development`, `SJN_DEV_BINDINGS=1`을 설정한다. [Vite 설정](../../../../vite.config.ts)이 이를 보고 `wrangler.dev.jsonc`와 `persistState.path=.wrangler/development`를 선택한다. 개발용 DB/R2에는 `remote:false`가 명시돼 있다. 기본 빌드 설정과 개발 설정을 섞지 않는다. 기존 `.wrangler/state`나 origin별 IndexedDB 자료는 삭제·자동 이전하지 않는다.

## D1 쿼리 통계

운영 D1의 읽기·쓰기 양은 Cloudflare 대시보드의 D1 → `sjn` → **Metrics**와 쿼리별 통계 명령으로 본다. 통계 명령은 분석 API만 읽어 D1 읽기 한도를 쓰지 않는다. 무료 한도는 하루 읽기 500만 행이고 매일 UTC 0시(한국 09:00)에 초기화된다.

```bash
npx wrangler d1 insights sjn --sort-by=reads --timePeriod=1d --limit=10
```

`--timePeriod=7d --json`이면 쿼리 원문·실행 횟수·읽은 행 합계를 기록용으로 받는다. 원격 `wrangler d1 execute --remote`의 SELECT는 읽기 한도를 쓰므로 쿼리 원문과 예상 읽기 행 수를 보이고 승인을 받은 뒤에만 실행한다. `--file`로 원격 실행하면 결과 없이 요약(읽은 행 수)만 돌아오므로 결과가 필요하면 `--command`를 쓴다. 로컬(Miniflare)의 D1 결과 `meta.rows_read`로 쿼리별 읽은 행 수를 미리 잰다([측정](../../../../tests/d1-read-cost.test.ts), [2026-10-17 결과](../../../../docs/d1-query-efficiency-results-20261017.md)).

## Cloudflare 하루 한도와 화면 안내

Workers Free 플랜의 하루 한도는 모두 **매일 00:00 UTC(한국 09:00)**에 초기화된다.

| 서비스 | 하루 한도 | 넘으면 |
| --- | --- | --- |
| D1 읽은 행 | 500만 | 모든 D1 쿼리 오류: 로그인, 프로젝트 저장·불러오기, 자재 목록, 관리자 화면이 멈춤(저장된 자료는 그대로) |
| D1 쓴 행 | 10만 | 쓰기 오류 |
| D1 저장 용량 | 계정 한도 | 시간이 지나도 풀리지 않음(관리자 문의) |
| Workers AI | 10,000뉴런 | FLUX(실사 변환·방향 사진·제품 다듬기)와 Gemma(설비 분석·결과 확인) 오류 |
| Workers 요청 | 10만 | Worker 실행 전에 Cloudflare 자체 오류 페이지. **앱이 안내할 수 없다** |

**판별** ([service-limit](../../../../src/lib/platform/service-limit.ts) `detectServiceLimit`): 오류의 `message`와 `cause`(3단계)를 대소문자 무시 부분 문자열로 본다. 앞에 `D1_ERROR: `가 붙어도 되고 끝부분이 달라도 된다.
- `free tier daily row read limit` → `db-read`
- `free tier daily row write limit` → `db-write`
- `exceeded maximum db size` 또는 `maximum account storage limit` → `db-storage`
- AI는 기존 `classifyCloudGemmaFailure`의 `quota_exhausted`(내부 코드 3036 등)를 그대로 쓴다.
- 출처: Cloudflare 문서 `d1/observability/debug-d1`, 2026-09-01 변경 기록 "D1 free tier limit enforcement".

**응답 계약**
- D1 한도: 503 `{ error, code: 'SERVICE_LIMIT', limit: { service, resetAt } }`. `resetAt`은 서버 시각 기준 다음 00:00 UTC이고, `db-storage`에는 없다. 원문 오류·계정 정보·사용량 숫자는 넣지 않는다.
- AI 하루 할당: 지금처럼 429 `quota_exhausted`(`ENDS_RUN` 등 호환)에 `limit: { service: 'ai', resetAt }`만 더한다. 자동 재시도는 없다.
- `/api/storage/status`: 준비 검사가 한도면 `reason: 'daily_limit'`(용량은 `storage_full`)과 `limit`을 준다. 앱이 처음 여는 요청이라 새 요청 없이 미리 안다.
- **출구**: D1을 거치는 모든 라우트는 다섯 출구 중 하나로 끝나고, 다섯 곳 모두 먼저 한도를 판별한다.
  - `errorResponse`: `d1Route`의 처리기, 관리자 처리기, 진단 아카이브
  - `serverError`: 로그인 확인 단계, 공개 자재, `/api/storage/session`, 관리자 로그인 확인
  - `handleD1Auth`
  - `storageStatus`
  - `cloudGemmaErrorResponse`: AI 라우트 5곳. 로그인 확인 중 D1 한도는 `SERVICE_LIMIT`로 답한다.
- **Better Auth가 삼키는 오류**: get-session은 DB 오류를 "세션 없음"(200 null)으로 답하고, 서버 API는 자기 `INTERNAL_SERVER_ERROR`를 던진다. 그래서 로그인 경로는 `watchServiceLimit`로 DB를 감싸 한도 오류만 기록한다(쿼리·순서·결과는 같고 추가 쿼리 없음). 그러지 않으면 한도가 "로그아웃됨"(401)으로 보인다.

**화면** ([service-limit-notice](../../../../src/lib/service-limit-notice.ts), [띠](../../../../src/components/service-limit-banner.tsx))
- 이미 오가는 응답에서만 안내를 만든다. 새 요청·폴링·재확인은 없다.
- 안내를 만드는 곳
  - `/api/storage/status`
  - `/api/d1/**`·관리자 fetch(`responseJson`·`adminRequest`)
  - get-session, 로그인
  - FLUX(`readFluxAnswer`·결과 확인)
  - Gemma 분석 transport와 접근 확인
  - 공개 자재 목록
- 모든 페이지(공개 포함) 위쪽에 고정하지 않는 띠를 둔다. 종류(DB·AI)마다 한 줄이다.
- 시각은 `Asia/Seoul`로 "10월 19일(월) 오전 9시"처럼 쓴다. 브라우저 시계로 오늘이면 앞에 "오늘", 내일이면 "내일"을 붙인다.
- `localStorage['sjn-service-limit']`에 `{service, resetAt}`만 둔다. 저장소가 없거나 거부해도 그 페이지 메모리로 동작한다. `resetAt`이 지나면 타이머로 숨긴다(요청 없음). 그 종류의 정상 응답을 받으면 지운다.
- 화면별 처리
  - 잠금 화면(`BackendGuard`)과 `/login`의 준비 안내: 일반 문구 대신 한도 문구를 보인다.
  - 로그인 실패: "아이디·비밀번호" 문구 대신 한도 문구를 보인다.
  - AI 버튼 옆(실사 변환·방향 사진·자동 초안): "AI 한도 · {시각} 이후"를 보인다. 버튼은 막지 않는다.
  - 공개 자재의 오류 영역: 한도 문구를 보인다.
- 사전 경고("곧 한도")는 없다. 관리자 AI 사용량 화면은 토큰이 필요하고 요청이 늘어서 쓰지 않았다.

## 설정 파일과 변수

| 파일 | 역할 |
| --- | --- |
| [wrangler.dev.jsonc](../../../../wrangler.dev.jsonc) | 개발 전용 sjn-development. 로컬 DB/R2, `APP_ENV=development`, `STORAGE_MODE=d1`, `BETTER_AUTH_URL=http://127.0.0.1:3000`, AI 바인딩 없음 |
| [wrangler.jsonc](../../../../wrangler.jsonc) | 기본 빌드/배포 원본. 원격 sjn DB/AI/ASSETS, APP_ENV=production·STORAGE_MODE=d1, ASSET_BUCKET → 기존 R2 sjn, BETTER_AUTH_URL=https://sjn.gyulbbe.workers.dev. 현재 실배포에 해당 바인딩·공개 변수 반영을 읽기 확인했으며 로그인 secret 3개는 미등록 |
| [wrangler.d1.example.jsonc](../../../../wrangler.d1.example.jsonc) | 운영 설정 참고본; 이름·ID·도메인·버킷은 예시이며 자동 적용되지 않음 |
| [.dev.vars.example](../../../../.dev.vars.example) | 실제 `.dev.vars`의 로컬 Workers secret 예시. 빈 Google/Better Auth 값을 직접 준비 |
| [.env.example](../../../../.env.example) | Node/Next 변수 참고. `.env.local`은 Workers secret을 대신하지 않음 |
| `dist/server/wrangler.json` | 생성물; 직접 편집하지 않고 원본 설정을 고쳐 재빌드 |

D1 `DB`와 R2 `ASSET_BUCKET`은 바인딩이며 URL/비밀번호 변수가 아니다. `ASSETS`는 정적 파일이고 R2 사용자 자료와 다르다. `AI`는 Gemma/FLUX 공통 Workers AI 바인딩이다. `BETTER_AUTH_SECRET`(필수), `GOOGLE_CLIENT_ID`·`GOOGLE_CLIENT_SECRET`(선택, 둘 다 넣거나 둘 다 비움)은 서버 전용이다. 준비 응답 `/api/storage/status`는 ready일 때 값 없이 `googleSignIn` 여부만 알려 주고 화면은 이에 따라 Google 버튼을 숨긴다. `NEXT_PUBLIC_*`·Wrangler vars·커밋에 비밀값을 넣지 않는다. 관리자 AI 사용량 화면(`/api/admin/ai-usage`)은 선택 설정 `CLOUDFLARE_ACCOUNT_ID`(32자리 계정 ID)와 `CLOUDFLARE_ANALYTICS_TOKEN`(해당 계정 "Account Analytics: 읽기" 권한만 준 API 토큰)을 서버에서만 읽는다. 운영은 `wrangler secret put`, 로컬은 `.dev.vars`로 등록하며 없으면 그 화면만 설정 안내를 보인다. 2026-09-25 기준 운영 등록 여부는 미확인이다. Workers AI 추가 계정 `AI_EXTRA_1_ACCOUNT_ID`·`AI_EXTRA_1_TOKEN`(선택 `AI_EXTRA_1_GATEWAY`)도 서버 전용 선택 secret이다. 있으면 FLUX·Gemma가 그 계정(REST)을 먼저 쓰고 하루 할당을 다 쓰면 `AI` 바인딩을 쓴다. 운영에는 2026-10-25 사용자가 Runtime secrets로 넣었다. 로컬 `.dev.vars`에 넣으면 AI 바인딩 없는 개발 서버에서도 그 계정으로 실제 호출된다([결과](../../../../docs/ai-account-pool-results-20261025.md)).

## 첫 로컬 실행

1. `.dev.vars.example`을 `.dev.vars`로 복사한다(이미 있으면 덮어쓰지 않는다).
2. 길이 32자 이상 안전한 `BETTER_AUTH_SECRET`을 준비한다. 경로 없는 `BETTER_AUTH_URL`과 실제 접속 origin을 맞춘다. 이것만으로 아이디 가입·로그인을 쓸 수 있다.
3. Google도 쓰려면 웹 OAuth 클라이언트의 origin을 `http://127.0.0.1:3000`, redirect URI를 `http://127.0.0.1:3000/api/auth/callback/google`로 맞추고 개발용 credentials 두 값을 모두 로컬 secret에 입력한다. 테스트 상태라면 계정이 Google 테스트 사용자에 포함되어야 한다.
4. `npm run db:dev:migrate` 후 `npm run dev`를 실행하고 준비 상태·아이디 가입/로그인(설정 시 Google)을 확인한다.
5. 최초 관리자 지정은 로그인한 회원만 대상으로 [bootstrap SQL](../../../../docs/database-design.md)을 로컬 개발 DB에 적용한다. 아이디 회원은 `user.username`으로 확인한다. 이후 역할/상태 변경은 관리자 UI를 사용한다.

개발의 계정 프로젝트·관리·사진/AI 기능에는 로그인이 필요하며 Google 없이 아이디 가입으로 시작할 수 있다. 메인·공용 자재·`/try` 체험은 로그인 없이 열리며 공용 자재 읽기에는 로컬 D1/R2가 필요하다. 격리 테스트의 서명된 Google fixture는 일반 실행용 우회 기능이 아니다. 로컬 D1/R2 구성 자체는 Cloudflare 운영 DB·버킷 생성이나 배포를 필요로 하지 않는다. 이 문서는 실제 Google 인증 완료를 의미하지 않는다.

## 현재 저장소·접근 정책

[storage/config](../../../../src/lib/storage/config.ts)와 [server](../../../../src/lib/storage/server.ts)의 정식 계정 저장은 개발·운영 모두 D1 + 로그인(아이디 또는 Google)을 요구한다. 공개 경로 `/`, `/materials`, `/try`, `/login`과 계정 작업공간의 준비 상태를 분리한다. `/try`는 같은 탭 `sessionStorage` 초안만 사용하며 빈 공간 생성·공개 자재 배치를 제공하고, 사진·AI·정식 저장·출력은 로그인 안내로 연결한다. `auto/d1`만 현재 선택 경로이며 `local/supabase`는 설정 오류다. 과거 Supabase SQL과 브라우저 원본은 보존하지만 실행 어댑터·SDK는 제거했다. `/api/cloud/**`는 410이며 계정 자료는 `/api/d1/**`, 익명 공개 읽기는 `/api/catalog/{materials,images,placement}`를 사용한다. IndexedDB에는 복구본·재사용 캐시만 새로 저장하고 진단 아카이브는 `/api/reconstruction/diagnostics`를 통해 D1/R2에 저장한다.

누락된 바인딩·migration·secret·연결 실패·초기 timeout은 계정 작업공간 접근을 잠근다. 메인과 빈 공간 체험은 열리고, 공용 자재는 [독립 DB/R2 환경 검사](../../../../src/lib/catalog/public-context.ts)로 읽어 OAuth 준비 실패에 종속되지 않는다. DB/R2가 없으면 자재 영역에 오류·재시도를 표시한다. 세션 만료 시 기존 계정 편집 화면을 숨기고 로그인 안내를 표시하되 본인 계정의 IndexedDB 복구본은 보존한다. 관리자 타인 프로젝트 편집은 명시적으로 범위가 지정된 저장소를 사용하고 캐시로 권한을 우회하지 않는다.

계정 저장용 `GET /api/storage/status`는 서버 최대 4.5초, 브라우저 초기 확인 최대 5초다. D1 스키마와 R2 `HEAD __sjn_readiness__`를 읽기만 하며 sentinel 객체가 없어도 HEAD 성공이면 된다. `ready:true`는 실제 Google callback/R2 업로드 성공까지 보증하지 않는다. 원본: [status route](../../../../src/app/api/storage/status/route.ts), [database](../../../../src/lib/d1/database.ts), [auth](../../../../src/lib/auth/d1.ts).

## R2 키와 접근 API

| 자료 | 객체 키 |
| --- | --- |
| 이미지·메시 | `assets/{encodeURIComponent(userId)}/{assetId}/{randomUUID}` |
| 프로젝트 문서 | `projects/{encodeURIComponent(userId)}/{projectId}/{randomUUID}.json` |

객체 키와 브라우저 URL은 다르다. 일반 업로드·조회는 `/api/d1/assets`, raw 바이트는 `?id={assetId}&raw=1`다. 관리자 전용 경로는 `/api/admin/project-assets?projectId=...`이며 해당 프로젝트/행위자 범위만 허용한다. `/api/catalog/images?id=...`는 로그인 없이 현재 활성 공용 자재에서 직접 사용하는 표시 이미지(texture/product/preview)만 전달한다. `GET /api/catalog/placement`는 최소 배치 DTO 목록, `?materialId=...`는 현재 버전 한 건을 반환하며 과거 버전/개인 자재 조회 경로로 쓰지 않는다. source 원본·메시를 공용 이미지로 노출하지 않는다.

이미지 업로드는 최대 25MB, 서버에서 형식·MIME·metadata를 검사한다. raw는 private/no-store이며 버킷 공개나 S3 관리 키 배포는 필요 없다. [assets](../../../../src/lib/d1/assets.ts), [projects](../../../../src/lib/d1/projects.ts), [admin projects](../../../../src/lib/admin/projects.ts), [catalog images](../../../../src/app/api/catalog/images/route.ts)를 확인한다. 과거 Supabase migration의 scene-assets 규칙은 현재 R2 경로와 별개다. 실행 어댑터와 SDK는 제거했다.

## AI와 빌드·운영 경계

Gemma는 `/api/reconstruction/cloud`의 `@cf/google/gemma-4-26b-a4b-it`, FLUX는 `/api/export/photoreal`(제품 하나씩 다듬는 실험 C는 별도 라우트 `/api/export/photoreal/product`, 자재 폼의 방향 사진 만들기는 `/api/materials/direction-photo`)의 `@cf/black-forest-labs/flux-2-klein-4b`다. 같은 `AI` 바인딩을 사용하고 `sjn-gateway`는 Gemma만 거치며(FLUX는 multipart 스트림이라 게이트웨이 미사용), 활성 로그인이 필요하다. 기본 개발 설정과 Next Node에는 AI 바인딩이 없다. 기본 개발 서버 시작만으로 원격 프록시를 연결하지 않도록 `wrangler.dev.jsonc`에서 AI를 제외했다. 실제 Workers AI 검증은 별도 승인된 원격 AI 바인딩 설정에서 실행한다. **로컬 D1/R2라는 사실은 AI가 로컬이라는 뜻이 아니다.** 명시적 AI 실행은 Cloudflare 사진 전송·사용량을 발생시킨다. 로그인·DB 준비·문서 갱신만으로 AI를 실행하지 않는다.

### 로컬 FLUX 시험 환경 (2026-10-21)

방향 사진 시험을 Cloudflare 하루 한도 없이 하려고 FLUX.2 klein 4B를 PC에서 돌린다. **시험 하네스만** 쓰고 앱 라우트는 쓰지 않는다. 로컬은 Cloudflare와 다르게 그린다. 앱 프롬프트의 "plain grey"를 훨씬 세게 따라 회색으로 그리고, 사진의 특징(곰 얼굴·레버)도 덜 쓴다. 공식 구현과는 같다(guidance·버전·크기는 원인이 아님, [넓게 찾기 결과](../../../../docs/direction-photo-explore-results-20261021.md) 1절). image 0·사진 변형은 로컬로 거르고, 문장 변형과 결정은 Cloudflare로 확인한다.

- **모델:** `black-forest-labs/FLUX.2-klein-4B`(Apache 2.0, 동의 절차 없음, 2026-10-21 revision `e7b7dc2`). diffusers 폴더만 받는다(약 16GB). 저장소의 단일 파일(7.75GB)은 필요 없다. 9B는 비상업 라이선스라 쓰지 않는다.
- **환경(저장소 밖):** Python 3.12 venv. 예: `C:\dev\sjn-local-flux\.venv`
  1. `py -3.12 -m venv C:\dev\sjn-local-flux\.venv`
  2. `pip install torch==2.11.0 --index-url https://download.pytorch.org/whl/cu128`(드라이버에 맞는 CUDA 빌드)
  3. `pip install -r tests/direction-photo-real/local-flux/requirements.txt`
- **실행:** `HF_HOME`을 모델 캐시 폴더로 두고(예: `C:\dev\sjn-local-flux\hf`) `python tests/direction-photo-real/local-flux/server.py`를 실행한다. 첫 실행에서 가중치를 받는다. Hugging Face 로그인·토큰은 필요 없다.
  - 주소: `127.0.0.1:8798`에서만 받는다. Cloudflare 시험용 Worker는 8799다.
  - 요청: 시험용 Worker와 같다. 한 번에 한 요청, 재시도 없음.
  - 확인: `GET /health`가 설정(`meta`)을 돌려준다.
- **설정(env):** `LOCAL_FLUX_OFFLOAD`(`model` 기본 / `sequential` / `none`), `LOCAL_FLUX_STEPS`(4), `LOCAL_FLUX_GUIDANCE`(1.0, 가중치가 distilled라 쓰이지 않음), `LOCAL_FLUX_PORT`(8798). 사진 0장 요청도 받는다(시험용).
- **진단:** `tests/direction-photo-real/local-flux/diag.py`는 서버와 같은 로딩(`flux_local.py`)으로 파이프라인을 직접 불러, 지난 요청의 가이드·사진·프롬프트를 하나씩 바꿔 본다. 다른 diffusers·transformers 버전은 venv를 새로 만들지 않고 `pip install --no-deps --target <폴더>`로 받아 `PYTHONPATH`에 먼저 둔다(torch는 기존 venv 것).
- **GPU를 같이 쓰는 앱:** 게임 등이 GPU 메모리를 많이 쓰면(예: 6.5GB) 12GB 카드에 함께 올라가지 못해 한 장이 수 분 걸리거나 하네스가 300초에 끊긴다. Ollama 비전 모델(약 4GB)도 서버와 동시에 올리지 않는다.
- **12GB VRAM:** bf16 + 모델 CPU 오프로드면 GPU 최대 약 8.4GB, 896×992 한 장 약 7~10초다(RTX 4070 Ti, 첫 장 16초). 같은 요청·seed는 같은 이미지다.
- **하네스:** `variants.ts`·`run.mjs`에 `FLUX_ENGINE=local`을 준다.
  - 장부에는 engine·설정·시간을 적고 뉴런은 0이다. 예산은 Cloudflare 호출만 센다.
  - 응답의 `meta.engine`이 `local`이 아니면 멈춘다.
  - `run.mjs`의 로컬 모드는 화면이 보낸 라우트 요청을 가로채 로컬 서버의 답으로 돌려준다. 개발 서버의 AI 바인딩이 필요 없다.

체험 중에는 사진 업로드·AI 실행·진단 아카이브를 시작하지 않는다. MoGe·DeepLab·배경 제거는 로그인한 기능의 브라우저 실행이며 모델/CDN 다운로드가 필요할 수 있다. [현재 AI 가이드](../../../../docs/reconstruction-cloud-browser-setup.md), [FLUX](../../../../docs/flux-export.md)를 해당 기능 작업 시 확인한다. 준비 응답은 바인딩/접근 검사이며 추론·과금·잔여량 검증이 아니다.

`deploy:vinext`는 실제 배포다. 현재 확인한 실배포에는 소스의 R2 바인딩과 공개 인증 URL이 반영되어 있다. 이후 소스 변경을 Worker에 반영하려면 검증된 산출물로 배포해야 하며, 누락된 Better Auth secret(과 선택한 경우 Google 두 값)은 배포만으로 생성되지 않는다. main 푸시는 Cloudflare 자동 배포로 이어진다(2026-09-23 푸시 약 80초 뒤 새 배포 확인). 아이디 로그인 코드는 0007 컬럼이 있는 DB에서만 준비 검사를 통과한다. 이 문서 갱신에서는 원격 설정·DB·배포를 변경하지 않았다. 원격 sjn과 로컬 개발 DB는 2026-09-17 사용자 승인 후 0001~0006 적용을 완료했다. 이후 운영 DB 변경은 대상과 미적용 목록을 확인해 별도로 승인된 범위에서 진행한다. 로컬 개발 DB 적용과 원격 DB 적용은 다른 작업이다. 자세한 Google/secret/배포 준비는 [설정 가이드](../../../../docs/cloudflare-storage-setup.md)를 따른다.
