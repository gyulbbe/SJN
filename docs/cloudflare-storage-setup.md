# D1 + R2 + Google 로그인 설정

로컬 개발은 **설정 없이 IndexedDB로 실행**된다. 운영은 `APP_ENV=production`과 D1/R2·Google 로그인 설정으로 계정별 서버 저장을 사용하며, 준비 확인이 실패하면 편집을 잠그고 재시도를 안내한다. 공개 자재 열람과 관리자 분류·속성 설계, 전체 DDL·기본 데이터는 [DB 설계 문서](database-design.md)에 정리했다. 현재 원격 D1 `sjn`에는 `0001`~`0004`를 적용했지만 앱의 운영 Worker 연결·Google OAuth·R2 검증과 관리자 지정·배포는 이번 작업에서 수행하지 않았다. 아래 절차는 현재 적용 이력과 남은 설정을 구분해 사용한다.

## 어디에 무엇을 저장하는가

| 위치                 | 내용                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| 로컬 IndexedDB       | 기존 프로젝트·사진·자재. 로그인해도 자동 업로드하지 않는다.                                           |
| D1                   | Google 회원·세션·관리자 역할, 프로젝트 목록과 revision, 자재와 불변 버전, 자산 참조, 재시도·정리 기록 |
| 비공개 R2            | 원본/가공 이미지, 제품 메시, Before·시안·이력을 포함한 프로젝트 JSON 스냅샷                           |
| 브라우저 복구 저장소 | 서버에 미저장된 작업의 복구본과 자산 캐시. 배포 origin·저장 방식·계정 ID별로 구분한다.                |

D1/R2는 서버의 `DB`, `ASSET_BUCKET` 바인딩으로 호출한다. 브라우저에 DB 접속 정보나 R2 관리 키를 전달하지 않는다. 일반 서버 요청은 세션을 확인하고 계정 소유권을 검사한다. R2 공개 URL과 공개 버킷 설정은 필요하지 않다.

## 저장소를 선택하는 규칙

| 실행/설정                                                            | 결과                                                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `npm run dev`, `npm run dev:vinext`                                  | 스크립트가 로컬 모드를 강제한다. DB·로그인 설정이 있어도 조회하지 않는다. |
| `APP_ENV`가 `production`이 아님                                      | 로컬                                                                      |
| `APP_ENV=production`, `STORAGE_MODE=local`                           | 운영 설정 오류로 편집 차단; 로컬로 우회하지 않음                          |
| 운영 Workers + `STORAGE_MODE=auto` 또는 `d1` + 모든 준비 확인 성공   | D1/R2, Google 로그인 필요                                                 |
| 운영 설정 누락·잘못된 값·바인딩/스키마/연결 실패·초기 확인 시간 초과 | 편집을 잠그고 설정 확인·재시도 안내                                       |
| 로컬 개발 환경의 기존 IndexedDB 자료                                 | 기존 로컬 기능 유지; 서버 계정으로 자동 업로드·공개 전환하지 않음         |

서버 준비 확인은 최대 4.5초, 브라우저 초기 확인은 최대 5초다. 초기 확인 시간 초과도 운영에서는 편집 차단 상태로 처리한다. **초기 인증·DB 장애와 D1 작업 중 저장 실패·세션 만료 모두 로그인 없는 로컬 편집으로 자동 전환하지 않는다.** 현재 작업과 복구본을 유지하고 재로그인·재시도를 안내한다. 계정이 바뀌면 이전 계정 작업을 따로 보관하고 작업 화면을 잠근다.

`STORAGE_MODE`가 우선이며, 없는 경우에만 이전 `NEXT_PUBLIC_STORAGE_MODE`를 읽는다. 새로운 설정에는 `STORAGE_MODE`를 사용한다. `auto`의 서버 후보는 D1이다. Supabase로 자동 순회하지 않는다.

## 설정 파일

- [`wrangler.jsonc`](../wrangler.jsonc): 실제 빌드가 읽는 Workers 설정. `APP_ENV=local`, `STORAGE_MODE=auto`를 유지하며 D1 `sjn`의 `DB` 바인딩과 `migrations_dir: "migrations/d1"`을 선언했다. R2 `ASSET_BUCKET`은 아직 미선언이다.
- [`wrangler.d1.example.jsonc`](../wrangler.d1.example.jsonc): 운영 D1 설정 참고본. 이름·도메인·DB ID·버킷 이름을 실제 값으로 바꿔 필요한 항목을 `wrangler.jsonc`에 합친다. 예시 파일 자체는 자동 적용되지 않는다.
- [`.env.example`](../.env.example): Next/Node 환경변수 예시. `.env.local`은 로컬 Next용이며 배포 Worker secret을 대신하지 않는다.
- [`.dev.vars.example`](../.dev.vars.example): 필요할 때 `.dev.vars`로 복사하는 로컬 Wrangler 예시. 이 파일 역시 배포되지 않는다.
- [`migrations/d1`](../migrations/d1): 테이블·인덱스 생성 SQL. 앱이 요청 중에 테이블을 생성하지 않는다.

빌드 산출물 `dist/server/wrangler.json`을 직접 고치면 다음 빌드에서 사라진다. 소스 `wrangler.jsonc`를 수정하고 다시 빌드한다. 비밀값은 `NEXT_PUBLIC_*`, `vars`, 소스 코드, GitHub 커밋에 넣지 않는다. Workers 런타임 secrets와 GitHub의 빌드 환경변수는 서로 다른 설정이다. [Cloudflare secrets 문서](https://developers.cloudflare.com/workers/configuration/secrets/)

## 나중에 연결하는 순서

### 1. 계정·DB·버킷 준비

2026-09-17 Wrangler 원격 목록에서 현재 `wrangler.jsonc`의 D1 `sjn` 이름·ID를 확인했고, 앱 테이블이 없는 상태에서 `0001`~`0004`를 원격 적용했다. 적용 이력 4개, 앱 테이블 23개, 속성 33개·하위 분류 21개와 무결성 검사를 확인했다. 자세한 확인값은 [DB 설계 문서](database-design.md)를 따른다. 기존 `sjn` DB를 재생성하거나 적용된 SQL을 수동 재실행할 필요는 없다. 앱의 운영 Worker 연결·Google OAuth·R2는 미검증이며 관리자 지정·배포는 수행하지 않았다.

아래 생성 명령은 자원이 없는 신규 구성의 예시이며 실제 원격 자원을 만든다. `sjn-data`·`sjn-assets`는 예시 이름이다. 운영할 Cloudflare 계정과 필요한 자원을 먼저 확인한다. 외주 프로젝트라면 서비스를 소유할 고객 계정에 필요한 개발 권한을 위임받는 구성이 관리·인계에 유리하다.

```powershell
npx wrangler login
npx wrangler whoami
npx wrangler d1 create sjn-data
npx wrangler r2 bucket create sjn-assets
```

출력된 D1 `database_id`를 기록한다. 버킷 이름은 계정 내에서 사용 가능한 이름으로 정한다. R2는 **Standard**로 시작하고 public access는 켜지 않는다. Worker 바인딩을 사용하므로 별도 S3 access key를 만들 필요가 없다.

아래는 신규 운영 구성의 예시다. 현재 `wrangler.jsonc`에는 기존 `sjn`의 `DB` 바인딩이 있으므로 중복 추가하거나 `sjn-data`·예시 ID로 덮어쓰지 않는다. 운영 전환에 필요한 항목만 반영하며 기존 Worker 이름·assets·compatibility 설정을 유지한다. 현재 `APP_ENV=local`, `STORAGE_MODE=auto`를 유지하며 이번 작업에서 R2·secret은 설정하지 않았다.

```jsonc
"vars": {
  "APP_ENV": "production",
  "STORAGE_MODE": "auto",
  "BETTER_AUTH_URL": "https://YOUR-APP.example.com"
},
"d1_databases": [{
  "binding": "DB",
  "database_name": "sjn-data",
  "database_id": "실제 DB ID",
  "migrations_dir": "migrations/d1"
}],
"r2_buckets": [{ "binding": "ASSET_BUCKET", "bucket_name": "sjn-assets" }]
```

`ASSETS`는 앱 정적 파일, `ASSET_BUCKET`은 사용자 자료다. 이름이 비슷하지만 서로 다른 바인딩이다. 명시적인 Wrangler 환경을 쓰면 환경별 바인딩·변수·secrets를 각각 준비하고 이후 모든 명령에 같은 `--env`를 지정해야 한다. 현재 예시는 별도 `env` 없는 기본 Worker 기준이다.

### 2. 테이블과 인덱스 생성

먼저 로컬 D1에서 SQL을 확인할 수 있다. 이 명령은 `.wrangler/state`의 로컬 DB에만 적용된다.

```powershell
npx wrangler d1 migrations apply DB --local --config wrangler.jsonc --persist-to .wrangler/state
```

운영 DB가 맞는지 확인한 뒤 원격에 적용한다. 다음 명령은 실제 D1을 변경한다.

```powershell
npx wrangler d1 migrations apply DB --remote --config wrangler.jsonc
```

- `0001_auth.sql`: Better Auth 회원·세션·Google 계정·OAuth 검증·속도 제한·관리자 역할.
- `0002_storage.sql`: 프로젝트·자재·자산·참조·조건부 revision·재시도·정리 기록.
- `0003_catalog.sql`: 하위 분류·색상/브랜드/재질/마감, 자재 버전 연결, 브랜드 단일 선택·하위 분류 일치 제약, 프로젝트용 자원 구분.
- `0004_catalog_seed.sql`: 기본 속성 33개·하위 분류 21개, 정확히 일치하는 과거 문자열 연결.

빈 DB는 0001부터 순서대로 적용하고, 이미 0001/0002를 적용한 DB는 새 마이그레이션 0003/0004만 적용한다. 기본 INSERT는 기존 관리자 변경을 덮어쓰지 않는다.

Wrangler는 적용한 migration을 추적한다. 이후 스키마 변경은 기존 SQL을 수정하지 말고 새 번호의 파일로 추가한다. 이번 Better Auth 버전은 `1.7.4`로 고정했고 실제 D1에서 로그인 테이블 동작을 테스트했다. 라이브러리 업데이트 때에는 스키마 차이를 검토한다. `npx ...@latest migrate`로 기존 운영 테이블을 무검토 변경하지 않는다. [D1 migrations 문서](https://developers.cloudflare.com/d1/reference/migrations/)

### 3. Google OAuth 만들기

Google Cloud Console에서 운영 프로젝트를 고르고 Google Auth Platform의 동의 화면과 **웹 애플리케이션 OAuth 클라이언트**를 만든다. 로고·앱 이름·지원 이메일·서비스 도메인을 설정한다. 테스트 상태면 로그인할 이메일을 테스트 사용자로 등록한다. 공개 서비스 전에는 Google의 게시/검증 조건을 확인한다.

| 항목                             | 예시                                                    |
| -------------------------------- | ------------------------------------------------------- |
| 앱 기준 주소와 `BETTER_AUTH_URL` | `https://YOUR-APP.example.com`                          |
| 승인된 JavaScript 원본           | `https://YOUR-APP.example.com`                          |
| 승인된 리디렉션 URI              | `https://YOUR-APP.example.com/api/auth/callback/google` |

`BETTER_AUTH_URL`에는 origin만 넣는다. `/api/auth`나 query/hash를 붙이지 않는다. 운영은 HTTPS만 허용하며, 다른 도메인·preview URL을 자동으로 신뢰하지 않는다. 접속 주소와 callback 주소가 달라지면 로그인 실패한다. 하나의 정식 도메인을 정하고 별칭은 그 주소로 연결한다.

Google은 신원 확인만 맡고 앱의 세션은 **Better Auth + D1**에 저장된다. D1 모드에는 별도 비밀번호 가입을 만들지 않았다. 이메일이 검증된 Google 계정만 허용하고 임의 OAuth 계정 자동 연결은 끈다. [Better Auth Google 안내](https://better-auth.com/docs/authentication/google)

### 4. 서버 secrets 등록

Worker가 아직 없다면 기존 로컬 모드로 먼저 Worker를 배포하거나 Cloudflare 대시보드에서 준비한다. 다음 명령은 해당 Worker의 런타임 secret을 등록한다. Google에서 발급받은 값을 명령의 대화형 입력에 넣는다.

```powershell
npx wrangler secret put GOOGLE_CLIENT_ID --config wrangler.jsonc
npx wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.jsonc
npx wrangler secret put BETTER_AUTH_SECRET --config wrangler.jsonc
```

`BETTER_AUTH_SECRET`은 비밀번호처럼 임의로 짧게 정하지 말고 안전한 난수 32바이트 이상으로 만든다. 로컬에서 생성한 값을 비밀 관리 도구에 보관하고 secret 입력에 사용한다.

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

예시 문자열과 32자 미만 값은 거부된다. secret은 세션 서명과 OAuth 토큰 암호화에 쓰므로 매번 배포할 때 새로 만들지 않는다. 교체 시 기존 세션과 저장 토큰에 영향을 줄 수 있다. 실제 secret을 로그·스크린샷·채팅·커밋에 남기지 않는다. [Better Auth 설치·secret 안내](https://better-auth.com/docs/installation)

### 5. 빌드·배포·준비 상태 확인

```powershell
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run build:vinext
```

Cloudflare 빌드 검증 후 설정 준비가 끝난 운영자가 `npm run deploy:vinext` 또는 기존 GitHub 연결 배포 절차를 실행한다. 이 단계는 실제 배포를 수행한다. 기본 설정을 바꾸지 않고 배포하면 계속 로컬로 동작한다. [`Cloudflare 첫 배포 가이드`](cloudflare-deployment.md)도 함께 확인한다.

배포 후 브라우저에서 `/api/storage/status`를 열어 다음 응답을 확인한다. 준비 확인은 R2에 시험 파일을 쓰거나 Google에 로그인하는 작업을 하지 않는다. 따라서 `ready:true`만으로 Google 콘솔 설정의 실제 정상 동작까지 확인한 것은 아니다.

```json
{ "mode": "d1", "ready": true, "reason": "ready", "authRequired": true }
```

`/materials`의 비로그인 조회와 `/login`의 Google 버튼을 확인한 다음, 로그인 후 개인 프로젝트 생성·새로고침·이미지 업로드·로그아웃을 확인한다. 두 계정과 두 브라우저로 소유권을 확인하고, 타 계정의 프로젝트/파일 URL을 직접 호출해 차단되는지도 검증한다. 원격 D1 migration과 SQL 검증은 완료했지만 앱의 운영 Worker 연결·실제 Google 로그인·R2 접근과 Workers CPU 제한 검증은 미실행이다.

### 6. 공용 자재 관리자 지정

관리자도 먼저 정상 Google 로그인해야 한다. D1 콘솔에서 정확한 이메일을 조회하고, 본인 확인한 `id`를 사용한다.

```sql
SELECT id, email, emailVerified FROM "user" WHERE email = 'admin@example.com';
-- 위 결과의 정확한 ID를 확인한 뒤에만 실행
INSERT INTO admin_roles(user_id) VALUES ('확인한-사용자-ID');
-- 권한 회수
DELETE FROM admin_roles WHERE user_id = '확인한-사용자-ID';
```

첫 가입자에게 자동 관리자 권한을 주지 않는다. 관리자 여부는 매 요청 D1에서 확인하며 클라이언트의 역할 값은 신뢰하지 않는다. 일반 회원은 본인 프로젝트를 관리하고 공용 자재는 읽는다. 자재·하위 분류·속성 변경은 관리자 전용이다. 일반 회원의 사진 분석·추출 모형은 별도 제한된 생성 경로로 본인 프로젝트용에만 저장하며 공개 카탈로그에 등록하지 않는다. D1에 PostgreSQL RLS를 흉내 내지 않고 서버 API의 인증·소유권 검사로 제한한다. 따라서 비인가 클라이언트에 D1/R2 직접 접근 토큰을 주면 안 된다.

## 저장·실패·비용 동작

클라우드 자동 저장은 편집 확정 후 2초 대기하고 연속 작업 중에는 최대 15초마다 확정 상태를 저장한다. 탭 이동·프로젝트 복사·로그아웃 등은 확정 작업을 먼저 처리한다. 브라우저 복구본은 별도로 준비한다. 서버의 조건부 revision이 맞아야 갱신하고, R2 저장을 마친 뒤 D1 문서를 확정한다. 요청 재시도에는 idempotency 키를 사용한다.

프로젝트 JSON은 D1의 큰 단일 행 대신 R2 스냅샷으로 저장한다. 새 저장마다 이전 스냅샷이 생기므로 **원본 사진 용량만으로 R2 사용량을 계산하면 안 된다.** 이전 스냅샷·실패한 업로드는 24시간 유예 이후 정리 대상이 되고, 참조·재시도 기록을 확인한 뒤 삭제한다. 성공적인 쓰기 이후 제한된 유지관리와 명시적 자료 정리가 처리한다. 24시간 뒤 반드시 실행되는 예약 작업은 없으므로 사용이 끊기면 더 오래 남을 수 있다. 불변 자재 버전과 다른 프로젝트·이력에서 참조하는 자산은 보존한다.

이 저장소 변경 자체로 Cron·Queue나 추가 AI 호출을 만들지 않는다. 사진 분석의 Gemma 호출, 브라우저 로컬 모델, 명시적으로 실행하는 FLUX 내보내기는 각 기능의 기존 경로를 사용한다. D1/R2 저장을 고르는 것만으로 모델 추론이나 이미지 합성 업로드가 발생하지 않는다.

2026-09-14 공식 요금표 기준으로 고려할 항목은 다음과 같다. 실제 계정의 사용량과 최신 조건을 배포 전에 다시 확인한다.

| 서비스       | 무료 범위와 초과 시 주의                                                                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 Free      | 하루 읽은 행 500만·쓴 행 10만, 계정 저장 총 5GB. **Free 단일 DB는 500MB** 제한. 일일 한도 초과는 쿼리 실패로 이어지고 UTC 자정에 초기화된다. 인덱스 변경도 쓰기 사용량에 영향을 준다. |
| R2 Standard  | 월 저장 10GB, Class A 100만·Class B 1,000만 요청 무료. 인터넷 전송료는 무료지만 **저장·요청 무료 범위 초과는 과금될 수 있다.**                                                        |
| Workers Free | 하루 요청 10만, 호출당 CPU 10ms. 실제 로그인·JSON 검증·저장 요청이 CPU 한도 안에 드는지는 배포 환경에서 측정해야 한다. 네트워크 대기 시간과 CPU 시간은 다르다.                        |

출처: [D1 요금](https://developers.cloudflare.com/d1/platform/pricing/), [D1 제한](https://developers.cloudflare.com/d1/platform/limits/), [R2 요금](https://developers.cloudflare.com/r2/pricing/), [Workers 요금](https://developers.cloudflare.com/workers/platform/pricing/).

Workers/D1은 우선 Free 플랜을 유지한다. R2는 사용량·객체 개수·Class A/B 요청을 살피고 알림을 설정한다. **예산 알림은 결제 차단 장치가 아니다.** 이 앱에는 월 금액을 넘으면 강제로 중단하는 결제 한도가 없으므로 “항상 0원”을 보장하지 않는다. 프로젝트 스냅샷 증가와 미정리 객체를 운영 화면에서 주기적으로 점검한다. [Cloudflare 예산 알림](https://developers.cloudflare.com/billing/manage/budget-alerts/)

## 문제 확인

| 증상                                          | 확인할 곳                                                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 배포했는데 계속 로컬                          | `APP_ENV`, `STORAGE_MODE`, Worker의 DB/ASSET_BUCKET 바인딩, `/api/storage/status`의 reason                  |
| `missing_bindings`                            | 바인딩 철자, 실제 배포 Worker/환경, 빌드 산출물의 설정                                                      |
| `connection_failed` / `invalid_configuration` | migration 0001~0004, DB 권한, R2 연결, origin·secret·Google 값. 브라우저 응답에는 비밀값을 노출하지 않는다. |
| `unsupported_runtime`                         | D1은 Workers용 vinext 경로에서 사용. 기본 Node `next start`에 D1 바인딩은 없다.                             |
| Google redirect 오류                          | 접속 origin = BETTER_AUTH_URL = 콘솔 승인 URI의 origin, `/api/auth/callback/google` 경로, 테스트 사용자     |
| 서버 저장 실패                                | 화면의 실제 이유 확인 후 재시도. 로컬로 자동 우회하지 않는다. 용량·권한·revision 충돌은 각각 해결해야 한다. |
| 계정 변경 감지                                | 이전 계정 복구본 보관 안내를 확인한 뒤 계정 다시 확인. 다른 계정에 이전 작업을 자동 업로드하지 않는다.      |
| 로컬 원본이 안 보임                           | localhost·127.0.0.1·배포 도메인은 각각 별도 IndexedDB. 기존 자료는 보존하며 로그인 시 자동 이전하지 않는다. |

## Supabase를 나중에 선택할 때

기존 Supabase 저장 어댑터와 migrations는 보존했다. **Node/Next 서버에서** `APP_ENV=production`, `STORAGE_MODE=supabase`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, 서버 전용 `SUPABASE_SECRET_KEY`와 기존 DB/Storage 정책을 준비한다. 해당 경로의 로그인은 기존 이메일·비밀번호 방식이다. D1의 Google 회원·자료를 Supabase로 자동 변환하거나 업로드하지 않는다.

Cloudflare 빌드는 Node 의존성이 있는 `/api/cloud/**` 경로를 계속 비활성화한다. 따라서 Workers에 Supabase 변수만 추가해서 서버 저장을 켤 수는 없다. 이번에 준비한 Workers 서버 경로는 `/api/d1/**`이며 인증은 `/api/auth/**`다.
