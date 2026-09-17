# D1 + R2 + Google 로그인 설정

현재 앱은 **개발·운영 모두 정식 계정 저장에 Google 로그인 + D1/R2**를 사용한다. 메인·공용 자재 구경과 `/try`의 빈 공간 생성·기본 자재 검색/배치는 로그인 없이 제공한다. 체험은 같은 탭 `sessionStorage`에만 임시 보관하고 로그인 후 본인 D1/R2 프로젝트로 저장한다. 사진·AI·정식 저장·시안 비교·견적·출력은 로그인 필수다. 관리자는 회원 관리·공용 자재 관리·다른 회원 프로젝트 조회/편집을 한다. 준비 실패나 세션 만료로 기존 계정 자료를 익명 작업으로 전환하지 않는다. [DB 설계](database-design.md)에 권한·ERD·전체 DDL·기본 데이터가 있다.

2026-09-17 사용자 승인 후 원격 D1 `sjn`에 `0005`·`0006`을 추가 적용하고 `.wrangler/development`의 빈 로컬 개발 DB에는 `0001~0006`을 순서대로 적용했다. 양쪽 스키마·초기 데이터·무결성을 확인했다. 관리자 지정·실제 Google 로그인·운영 R2 검증·R2 버킷 생성·배포·AI 호출은 수행하지 않았다.

현재 연결 조사(2026-09-17)는 다음과 같이 소스와 실제 배포를 구분한다.

| 항목 | 확인 상태 |
| --- | --- |
| 원격 D1 `sjn` | 0001~0006 적용·무결성 확인 완료 |
| 기존 R2 `sjn` | Standard/APAC, 2026-09-14 생성, 확인 당시 객체 0개; 새 버킷은 생성하지 않음 |
| 소스 R2·주소 설정 | `wrangler.jsonc`에 `ASSET_BUCKET → sjn`, `BETTER_AUTH_URL=https://sjn.gyulbbe.workers.dev` 추가 완료 |
| 빌드 산출물 | vinext 빌드 성공. `dist/server/wrangler.json`에 `ASSET_BUCKET → sjn`과 기존 `DB → sjn`·`AI` 유지 확인 |
| 확인한 실배포 버전 | 2026-09-17 14:46:54 UTC 생성 버전 `d70ff6c6-bd4e-4bba-9758-9bd5bdd81911`에 DB·ASSET_BUCKET·AI·ASSETS 바인딩과 APP_ENV·STORAGE_MODE·BETTER_AUTH_URL 확인 |
| 운영 인증 설정 | `BETTER_AUTH_URL=https://sjn.gyulbbe.workers.dev` 반영 확인. 운영 secret 목록은 비어 있고 `BETTER_AUTH_SECRET`·`GOOGLE_CLIENT_ID`·`GOOGLE_CLIENT_SECRET` 미등록. Google 콘솔의 OAuth 클라이언트 준비 여부는 미확인 |
| 실제 준비 응답 | `https://sjn.gyulbbe.workers.dev/api/storage/status`는 `mode=d1`, `ready=false`, `reason=invalid_configuration`, `authRequired=true` |
| 로컬 인증 파일 | 확인 당시 `.dev.vars`·`.env.local`·`.env`·`.dev.vars.development` 없음 |

현재 배포의 R2 바인딩과 공개 인증 URL은 반영되어 있다. 이번에는 준비 응답·배포 메타데이터·secret 이름만 읽었으며 원격 설정·DB·배포를 변경하지 않았다. 로그인 secret 3개가 없어 인증 준비 검사에서 중단되므로, 이 결과가 현재 D1/R2 실제 읽기·쓰기 성공을 보증하지는 않는다. Google/Better Auth 설정 준비와 실제 로그인·R2 업로드 검증은 남아 있다.

## 기본 로컬 개발

`npm run dev`와 `npm run dev:vinext`는 vinext의 로컬 Workers를 **http://127.0.0.1:3000**에서 실행한다. `wrangler.dev.jsonc`의 D1/R2를 `.wrangler/development`에 저장하므로 원격 sjn DB와 별개다. 개발 DB/R2는 `remote:false`이며 새 운영 DB·버킷 생성은 필요 없다. 공개 메인·빈 방 체험은 OAuth 설정 없이 열리며 공용 자재 조회에는 D1/R2가 필요하다. 계정 기능의 인증에는 실제 개발용 Google OAuth 설정이 필요하다. 기본 개발 설정에는 AI 바인딩이 없다. 서버를 켜는 것만으로 Cloudflare 원격 AI 프록시가 연결되지 않으며, 실제 AI 검증은 별도 승인된 AI 바인딩 설정에서 진행한다.

```powershell
npm ci
# .dev.vars가 없을 때만 예시를 복사한다. 기존 secret 파일을 덮어쓰지 않는다.
if (!(Test-Path -LiteralPath .dev.vars)) { Copy-Item .dev.vars.example .dev.vars }
# .dev.vars의 빈 BETTER_AUTH_SECRET / GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET를 준비한다.
npm run db:dev:migrate
npm run dev
```

Google 웹 OAuth 클라이언트의 승인 origin은 `http://127.0.0.1:3000`, redirect URI는 `http://127.0.0.1:3000/api/auth/callback/google`로 맞춘다. `BETTER_AUTH_URL`도 같은 origin이다. 테스트 상태의 Google 앱은 사용할 계정을 테스트 사용자에 등록한다. `localhost`로 바꾸거나 포트를 바꾸면 접속·secret·Google 설정을 함께 맞춰야 한다.

`db:dev:migrate`의 실제 명령은 다음과 같으며 로컬 DB에만 적용된다.

```powershell
npx wrangler d1 migrations apply DB --local --config wrangler.dev.jsonc --persist-to .wrangler/development
```

최초 관리자도 이 환경에서 먼저 Google 가입한 뒤 아래 최초 관리자 절차를 따른다. 테스트의 서명된 Google provider fixture를 일반 로그인 우회로 사용하지 않는다. 기존 `.wrangler/state`와 브라우저 IndexedDB 자료는 삭제하거나 자동 이전하지 않는다.

`npm run dev:next`는 별도 Next/Node 개발 명령이고 D1/R2/AI 바인딩을 제공하지 않는다. 기본 앱 개발을 대신하지 않는다. `build:vinext → start:vinext`는 기본 빌드 설정과 8787 포트, `.wrangler/state`를 사용하는 별도 미리보기다.

## 어디에 무엇을 저장하는가

| 위치 | 내용 |
| --- | --- |
| D1 | Google 회원·세션·역할·상태/revision·관리자 감사, 프로젝트 목록/revision, 자재 불변 버전·분류·참조·재시도·정리 |
| 비공개 R2 | 원본/가공 이미지, 제품 메시, Before·시안·이력을 포함한 프로젝트 JSON |
| 브라우저 IndexedDB | 기존 로컬 자료, 본인 계정의 미저장 복구본·캐시. 로그인만으로 자동 업로드하지 않음 |
| 같은 탭 sessionStorage | `/try` 임시 초안·배치·빈 방 재생성 정보. 이미지 바이트·개인 자료·익명 D1/R2 쓰기 없음 |

브라우저에는 D1/R2 관리 키를 전달하지 않는다. 일반 API는 본인 자료만 다루고 관리자 전용 API는 현재 관리자와 해당 프로젝트 범위를 검사한다. 소유자와 관리자 행위자를 분리해 기록한다. 공개 GET `/api/catalog/materials`, `/api/catalog/images`, `/api/catalog/placement`만 현재 활성 공용 자재의 최소 표시·배치 데이터를 로그인 없이 제공한다. 원본·메시·source/product3d·개인·과거 버전은 공개하지 않으며 버킷 공개 설정은 필요 없다. `/api/d1/**`의 일반 자료 API는 그대로 로그인 필수다.

## 저장소와 접근을 선택하는 규칙

| 실행/설정 | 결과 |
| --- | --- |
| 기본 dev / dev:vinext | 개발 전용 D1/R2; 공개 체험 가능, 계정 기능은 Google 로그인 |
| Workers + STORAGE_MODE=auto 또는 d1 + 준비 성공 | 공개 카탈로그 읽기와 인증된 D1/R2 저장 분리; APP_ENV 이름으로 계정 인증을 우회하지 않음 |
| STORAGE_MODE=local 또는 supabase | 지원하지 않는 저장소 설정; 정식 저장·카탈로그 연결 오류 |
| 바인딩·스키마 누락, 연결 실패 | 계정/자재 영역 오류·재시도 안내; 공개 메인과 빈 방 체험은 열림 |
| OAuth secret 누락·계정 준비 timeout | 계정 작업공간 잠금; 공개 메인·체험·DB/R2가 준비된 공용 자재는 이용 가능 |
| 세션 만료·정지 | 기존 계정 편집기를 숨기고 로그인 안내; 본인 계정 IndexedDB 복구본 보존 |
| 과거 IndexedDB/Supabase 자료 | 보존; 운영 어댑터·SDK 제거, 자동 읽기·쓰기·삭제·업로드 없음 |

`STORAGE_MODE`가 우선이고 없을 때만 호환 변수 `NEXT_PUBLIC_STORAGE_MODE`를 읽는다. 서버 준비 확인은 최대 4.5초, 브라우저 초기 확인은 최대 5초다. 계정이 바뀌면 이전 작업을 따로 보존하고 다른 계정에 자동 업로드하지 않는다. 관리자 권한을 잃으면 기존 편집 창이나 재시도 캐시로도 접근할 수 없다.

## 설정 파일

- [wrangler.dev.jsonc](../wrangler.dev.jsonc): 개발 전용 로컬 D1/R2, APP_ENV=development, STORAGE_MODE=d1, BETTER_AUTH_URL=http://127.0.0.1:3000.
- [scripts/dev-local.mjs](../scripts/dev-local.mjs)와 [vite.config.ts](../vite.config.ts): SJN_DEV_BINDINGS=1일 때 위 설정과 .wrangler/development를 선택.
- [wrangler.jsonc](../wrangler.jsonc): 기본 빌드/배포 원본. APP_ENV=production, STORAGE_MODE=d1, 기존 원격 sjn DB/AI/ASSETS를 유지. 기존 R2 sjn의 ASSET_BUCKET 바인딩과 BETTER_AUTH_URL=https://sjn.gyulbbe.workers.dev를 소스와 현재 실배포에서 확인. OAuth/Better Auth secret은 별도 준비가 필요.
- [wrangler.d1.example.jsonc](../wrangler.d1.example.jsonc): 운영 참고본. 이름·ID·도메인·버킷 예시를 현재 설정 전체와 교체하지 않음.
- [.dev.vars.example](../.dev.vars.example): 로컬 Workers secret 예시. 실제 .dev.vars는 커밋·배포하지 않음.
- [.env.example](../.env.example): Node 변수 예시. .env.local은 Worker secret을 대신하지 않음.
- [migrations/d1](../migrations/d1): 0001~0006. 앱은 요청 중 테이블을 생성하지 않음.

생성물 `dist/server/wrangler.json`을 직접 수정하지 않는다. 비밀값은 `NEXT_PUBLIC_*`, vars, 소스, 로그에 넣지 않는다. Workers runtime secret과 빌드 환경변수는 별개다. [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

## 운영 연결은 별도로 준비

### 1. 계정·DB·버킷 준비

2026-09-17 Wrangler 원격 목록에서 현재 `wrangler.jsonc`의 D1 `sjn` 이름·ID를 확인했고, 앱 테이블이 없는 상태에서 `0001`~`0004`를 원격 적용했다. 적용 이력 4개, 앱 테이블 23개, 속성 33개·하위 분류 21개와 무결성 검사를 확인했다. 자세한 확인값은 [DB 설계 문서](database-design.md)를 따른다. 기존 `sjn` DB를 재생성하거나 적용된 SQL을 수동 재실행할 필요는 없다. 이후 같은 날 사용자 승인으로 0005·0006을 원격에 추가했고, 로컬 개발 DB에도 0001~0006을 순서대로 적용했다. 기존 사용자 자료 집계와 초기 데이터는 유지됐으며 양쪽 무결성 검사를 통과했다. 앱의 운영 Worker 연결·실제 Google OAuth·R2는 미검증이며 관리자 지정·R2 버킷 생성·배포·AI 호출은 수행하지 않았다.

현재 계정에는 D1과 R2 모두 `sjn`이 있으므로 아래 예시 이름으로 다시 만들 필요가 없다. 아래 생성 명령은 자원이 없는 신규 구성의 예시이며 실제 원격 자원을 만든다. `sjn-data`·`sjn-assets`는 예시 이름이다. 운영할 Cloudflare 계정과 필요한 자원을 먼저 확인한다. 외주 프로젝트라면 서비스를 소유할 고객 계정에 필요한 개발 권한을 위임받는 구성이 관리·인계에 유리하다.

```powershell
npx wrangler login
npx wrangler whoami
npx wrangler d1 create sjn-data
npx wrangler r2 bucket create sjn-assets
```

출력된 D1 `database_id`를 기록한다. 버킷 이름은 계정 내에서 사용 가능한 이름으로 정한다. R2는 **Standard**로 시작하고 public access는 켜지 않는다. Worker 바인딩을 사용하므로 별도 S3 access key를 만들 필요가 없다.

아래는 신규 운영 구성의 예시다. 현재 `wrangler.jsonc`에는 기존 `sjn`의 `DB` 바인딩이 있으므로 중복 추가하거나 `sjn-data`·예시 ID로 덮어쓰지 않는다. 운영 전환에 필요한 항목만 반영하며 기존 Worker 이름·assets·compatibility 설정을 유지한다. 현재 빌드 설정은 `APP_ENV=production`, `STORAGE_MODE=d1`이며 기존 `sjn` 버킷을 연결하는 R2 바인딩은 소스에 추가했다. 이 변경과 소스의 `BETTER_AUTH_URL=https://sjn.gyulbbe.workers.dev`는 실배포에 아직 반영되지 않았고 OAuth/Better Auth secret을 준비해야 한다.

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

먼저 개발 전용 로컬 D1에서 SQL을 확인한다. 다음 명령은 `.wrangler/development`의 로컬 DB에만 적용된다.

```powershell
npm run db:dev:migrate
```

운영 DB가 맞는지 확인한 뒤 원격에 적용한다. 다음 명령은 실제 D1을 변경한다.

```powershell
npx wrangler d1 migrations apply DB --remote --config wrangler.jsonc
```

- `0001_auth.sql`: Better Auth 회원·세션·Google 계정·OAuth 검증·속도 제한·관리자 역할.
- `0002_storage.sql`: 프로젝트·자재·자산·참조·조건부 revision·재시도·정리 기록.
- `0003_catalog.sql`: 하위 분류·색상/브랜드/재질/마감, 자재 버전 연결, 브랜드 단일 선택·하위 분류 일치 제약, 프로젝트용 자원 구분.
- `0004_catalog_seed.sql`: 기본 속성 33개·하위 분류 21개, 정확히 일치하는 과거 문자열 연결.
- `0005_admin_management.sql`: 회원 상태/revision·기존 회원 backfill·세션 정지 trigger, 관리자 감사/원자 조건 검사, 프로젝트별 관리자 자산·버전 범위와 인덱스.
- `0006_reconstruction_diagnostics.sql`: 계정별 진단 메타데이터·비공개 R2 JSON, 활성 계정·실행 ID 충돌 검사, 별도 정리 대기열. 기존 브라우저 로그를 자동 이전하지 않는다.

빈 DB는 0001~0006를 순서대로 적용한다. 현재 원격 sjn과 로컬 개발 DB는 0001~0006 적용을 완료했다. 다른 DB나 이후 새 파일은 적용 이력을 확인한 뒤 미적용 번호만 진행한다. 기존 SQL을 수동 재실행하지 않는다. 기본 INSERT는 기존 관리자 변경을 덮어쓰지 않는다.

Wrangler는 적용한 migration을 추적한다. 이후 스키마 변경은 기존 SQL을 수정하지 말고 새 번호의 파일로 추가한다. 이번 Better Auth 버전은 `1.7.4`로 고정했고 실제 D1에서 로그인 테이블 동작을 테스트했다. 라이브러리 업데이트 때에는 스키마 차이를 검토한다. `npx ...@latest migrate`로 기존 운영 테이블을 무검토 변경하지 않는다. [D1 migrations 문서](https://developers.cloudflare.com/d1/reference/migrations/)

### 3. Google OAuth 만들기

Google Cloud Console에서 운영 프로젝트를 고르고 Google Auth Platform의 동의 화면과 **웹 애플리케이션 OAuth 클라이언트**를 만든다. 로고·앱 이름·지원 이메일·서비스 도메인을 설정한다. 테스트 상태면 로그인할 이메일을 테스트 사용자로 등록한다. 공개 서비스 전에는 Google의 게시/검증 조건을 확인한다.

사용자가 확인한 현재 운영 주소는 `https://sjn.gyulbbe.workers.dev/`다. Google 콘솔에는 아래 값을 정확히 등록한다. 공개 인증 URL은 현재 실배포에 반영되어 있다. Google 콘솔의 OAuth 클라이언트 설정은 미확인이고 운영 secret 3개는 미등록이며 실제 로그인 검증은 남아 있다.

| 항목 | 현재 서비스 설정값 |
| --- | --- |
| 앱 기준 주소와 `BETTER_AUTH_URL` | `https://sjn.gyulbbe.workers.dev` |
| 승인된 JavaScript 원본 | `https://sjn.gyulbbe.workers.dev` |
| 승인된 리디렉션 URI | `https://sjn.gyulbbe.workers.dev/api/auth/callback/google` |

`BETTER_AUTH_URL`에는 origin만 넣는다. `/api/auth`나 query/hash를 붙이지 않는다. 운영은 HTTPS만 허용하며, 다른 도메인·preview URL을 자동으로 신뢰하지 않는다. 접속 주소와 callback 주소가 달라지면 로그인 실패한다. 하나의 정식 도메인을 정하고 별칭은 그 주소로 연결한다.

Google은 신원 확인만 맡고 앱의 세션은 **Better Auth + D1**에 저장된다. D1 모드에는 별도 비밀번호 가입을 만들지 않았다. 이메일이 검증된 Google 계정만 허용하고 임의 OAuth 계정 자동 연결은 끈다. [Better Auth Google 안내](https://better-auth.com/docs/authentication/google)

### 4. 서버 secrets 등록

운영 Worker가 아직 없다면 승인된 배포 절차나 Cloudflare 대시보드에서 별도로 준비한다. 로컬 개발의 .dev.vars는 운영 secret 등록을 대신하지 않는다. 다음 명령은 해당 Worker의 런타임 secret을 등록한다. Google에서 발급받은 값을 명령의 대화형 입력에 넣는다.

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

Cloudflare 빌드 검증 후 설정 준비가 끝난 운영자가 `npm run deploy:vinext` 또는 기존 GitHub 연결 배포 절차를 실행한다. 이 단계는 실제 배포를 수행한다. 현재 D1 스키마 적용과 실배포의 R2 바인딩·공개 인증 URL 반영을 확인했다. 이후 소스 변경은 배포가 필요하며 Google/Better Auth secret은 배포만으로 생성되지 않는다. 누락된 인증 설정은 계정 기능 이용을 차단한다. 이후 새 마이그레이션 역시 배포와 별도로 적용한다. [`Cloudflare 첫 배포 가이드`](cloudflare-deployment.md)도 함께 확인한다.

배포 후 브라우저에서 `/api/storage/status`를 열어 다음 응답을 확인한다. 준비 확인은 R2에 시험 파일을 쓰거나 Google에 로그인하는 작업을 하지 않는다. 따라서 `ready:true`만으로 Google 콘솔 설정의 실제 정상 동작까지 확인한 것은 아니다.

```json
{ "mode": "d1", "ready": true, "reason": "ready", "authRequired": true }
```

비로그인 메인·`/materials`·현재 공용 이미지·`/try`가 열리는지, 빈 공간 배치가 같은 탭 새로고침 뒤 복원되는지 확인한다. 계정/관리자/AI API 직접 요청은 차단되고 사진·정식 저장·비교·견적·출력은 로그인 안내로 이어져야 한다. 로그인 복귀 후 같은 초안이 본인 프로젝트로 저장되는지와 실패/재시도·계정 변경, 기존 개인 프로젝트 생성·새로고침·이미지 업로드·로그아웃도 확인한다. 두 계정과 두 브라우저로 소유권을 확인하고, 타 계정의 프로젝트/파일 URL을 직접 호출해 차단되는지도 검증한다. 원격 sjn과 로컬 개발 DB의 0001~0006 적용·초기 데이터·SQL 무결성 검증은 완료했다. 운영 Worker의 바인딩·준비 응답은 읽기 확인했지만 실제 Google 로그인·R2 읽기/업로드와 Workers CPU 제한 검증은 미실행이다.

### 6. 최초 관리자와 이후 회원 관리

관리자도 먼저 정상 Google 가입을 완료해야 한다. [DB 설계 7절](database-design.md)의 SQL은 **관리자가 아직 없는 DB의 최초 한 번 지정** 예시다. 검증된 이메일·Google account·활성 상태와 정확한 사용자 ID를 확인하고 사용한다. 이번 작업에서는 해당 SQL을 실행하지 않았다.

개발 DB에서 조회할 때도 운영 설정과 혼동하지 않도록 대상 설정·상태 경로를 모두 명시한다.

```powershell
npx wrangler d1 execute DB --local --config wrangler.dev.jsonc --persist-to .wrangler/development --command "SELECT id,email,emailVerified FROM user WHERE email='admin@example.com'"
```

이후에는 `/admin/users`에서 회원 검색·승격·강등·정지·해제를 수행한다. 자기 정지·마지막 활성 관리자 해제/정지는 거부하고, revision/idempotency/감사를 변경과 한 batch로 처리한다. 정지는 기존 세션을 삭제하고 새 OAuth 세션도 차단한다.

일반 회원은 본인 프로젝트와 공용 자재를 사용한다. 관리자는 `/admin/projects`에서 타인 프로젝트를 조회·편집하지만 소유자는 유지하고 행위자를 감사에 남긴다. 해당 문서/관리자/프로젝트 범위의 자료만 사용하며 타인 프로젝트 삭제·복제·소유권 이전은 제공하지 않는다. 자재·색상·브랜드·재질·마감 등록은 관리자 전용이고 회원 모형은 제한된 프로젝트용 생성 경로만 사용한다.

## 저장·실패·비용 동작

`/try`는 공식 클라우드 저장 없이 같은 탭 초안을 보관한다. Google 로그인에 성공해 본인 프로젝트로 저장이 확정된 뒤 임시 초안을 정리하며 실패하면 유지한다. 탭을 닫으면 초안이 사라질 수 있고 기존 IndexedDB 자료를 가져오지 않는다.

계정 프로젝트의 클라우드 자동 저장은 편집 확정 후 2초 대기하고 연속 작업 중에는 최대 15초마다 확정 상태를 저장한다. 탭 이동·프로젝트 복사·로그아웃 등은 확정 작업을 먼저 처리한다. 브라우저 복구본은 별도로 준비한다. 서버의 조건부 revision이 맞아야 갱신하고, R2 저장을 마친 뒤 D1 문서를 확정한다. 요청 재시도에는 idempotency 키를 사용한다.

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
| 개발/배포 후 접근이 차단됨 | 선택한 설정 파일, STORAGE_MODE=d1, DB/ASSET_BUCKET, 인증 변수, /api/storage/status의 reason |
| `missing_bindings`                            | 바인딩 철자, 실제 배포 Worker/환경, 빌드 산출물의 설정                                                      |
| `connection_failed` / `invalid_configuration` | migration 0001~0006, DB 권한, R2 연결, origin·secret·Google 값. 브라우저 응답에는 비밀값을 노출하지 않는다. |
| `unsupported_runtime`                         | D1은 Workers용 vinext 경로에서 사용. 기본 Node `next start`에 D1 바인딩은 없다.                             |
| Google redirect 오류                          | 접속 origin = BETTER_AUTH_URL = 콘솔 승인 URI의 origin, `/api/auth/callback/google` 경로, 테스트 사용자     |
| 서버 저장 실패                                | 화면의 실제 이유 확인 후 재시도. 로컬로 자동 우회하지 않는다. 용량·권한·revision 충돌은 각각 해결해야 한다. |
| 계정 변경 감지                                | 이전 계정 복구본 보관 안내를 확인한 뒤 계정 다시 확인. 다른 계정에 이전 작업을 자동 업로드하지 않는다.      |
| 로컬 원본이 안 보임                           | localhost·127.0.0.1·배포 도메인은 각각 별도 IndexedDB. 기존 자료는 보존하며 로그인 시 자동 이전하지 않는다. |

## 과거 Supabase 자료

기존 Supabase migrations·자료는 보존하지만 실행 어댑터와 SDK는 제거했다. `STORAGE_MODE=supabase`는 설정 오류이며 기존 `/api/cloud/**`는 Next/Workers 모두 410으로 응답한다. 현재 저장은 `/api/d1/**`, 관리자는 `/api/admin/**`, 인증은 `/api/auth/**`다. Google/D1 회원이나 과거 브라우저 자료를 자동 변환·업로드하지 않는다.

## 브라우저 저장과 진단 아카이브

프로젝트·자재·기준값의 정식 저장은 D1/R2다. 기준값 선택은 D1 API만 사용하며 과거 localStorage 분류를 읽거나 저장하지 않는다. 본인 프로젝트의 IndexedDB 복구본은 500ms 지연·서버 저장 전에 작성하고 확인된 동일 내용은 정리한다. 충돌 보관본은 삭제하지 않는다.

자산 캐시는 매번 서버가 계정 권한을 승인한 뒤 동일 SHA-256 Blob만 재사용한다. 저장 후 7일 만료, 모든 계정 합산 100개/200MiB, 개별 25MiB 제한을 적용한다. 서버 권한 오류나 연결 실패에 캐시로 우회하지 않으며 관리자 타인 프로젝트 자산에는 캐시를 사용하지 않는다. 시안 미리보기와 AI 단계 캐시는 반복 렌더링·추론 방지를 위해 유지하고 모델 파일은 별도 CacheStorage를 쓴다.

진단 로그는 `0006_reconstruction_diagnostics.sql`의 D1 메타데이터·비공개 R2 JSON으로 계정별 20건/25MiB를 보관한다. 분석 시작 계정과 현재 계정이 다르면 업로드를 막는다. 관리자 타인 프로젝트 분석은 서버 아카이브에도 저장하지 않고 현재 실행 메모리에서만 내려받는다. 기존 IndexedDB 진단은 열거나 자동 전송·삭제하지 않는다. 2026-09-17 원격 sjn과 로컬 개발 DB의 0001~0006 적용을 완료했다. 새 개발 환경을 준비하거나 이후 파일을 추가하면 `npm run db:dev:migrate`로 로컬 미적용 번호만 순차 적용한다.
