# 개발환경 참조

확인 기준: **2026-09-17 저장소 소스와 실제 원격 D1 확인**. Wrangler 원격 목록에서 D1 `sjn`의 이름·ID가 `wrangler.jsonc`와 일치함을 확인했고 `0001`~`0004` migration을 원격에 적용했다. 앱의 운영 Worker 연결·Google OAuth·R2는 미검증이며 관리자 지정·배포는 수행하지 않았다. 선언된 설정, 예시 값, 과거 검증 기록을 실제 운영 상태와 구분하며, 실제 `.env*`·`.dev.vars`·secret 값은 기록하지 않는다.

## 실행과 검사

Node 기준은 [`.node-version`](../../../../.node-version)의 **22.23.2**다. 의존성·명령은 [`package.json`](../../../../package.json)과 `package-lock.json`을 따른다. 새 환경에서는 `npm ci`로 설치한다.

| 목적 | 명령 | 기본 주소·동작 |
| --- | --- | --- |
| Next 개발 | `npm run dev` | `http://127.0.0.1:3000`, 로컬 저장 강제 |
| Workers 개발 | `npm run dev:vinext` | 포트 `3001`, 로컬 저장 강제 |
| Next 빌드·실행 | `npm run build` → `npm run start` | `127.0.0.1:3000`, Node 런타임 |
| Workers 빌드·미리보기 | `npm run build:vinext` → `npm run start:vinext` | 포트 `8787`, 로컬 workerd |
| 기본 검사 | `npm run typecheck`, `npm run lint`, `npm test` | 변경 범위에 맞게 실행 |
| Workers 브라우저 검사 | `npm run test:cloudflare` | 빌드 후 실행; Chrome, 포트 `8787` |

[`scripts/dev-local.mjs`](../../../../scripts/dev-local.mjs)는 두 개발 명령에 `APP_ENV=local`, `SJN_DEV_LOCAL=1`을 강제한다. [`build/cloudflare-local.ts`](../../../../build/cloudflare-local.ts)는 vinext 런타임에도 이 로컬 선택을 반영한다.

`start:vinext`는 `wrangler dev --config dist/server/wrangler.json --port 8787 --persist-to .wrangler/state`다. `.wrangler/state`는 로컬 Workers 상태이며 브라우저 IndexedDB와 별개다. Windows에서는 미리보기 서버를 종료한 뒤 재빌드한다. Next·vinext 빌드는 공유 `.next/types`를 갱신하므로 순차 실행한다.

브라우저 자료는 origin별로 분리된다. `localhost`와 `127.0.0.1`, 포트, 브라우저 프로필, 운영 도메인이 다르면 같은 자료가 보이지 않을 수 있다. 로그인해도 로컬 자료가 계정 저장소로 자동 업로드되지 않는다.

## 현재 설정과 파일 역할

| 파일·설정 | 소스에서 확인한 의미 |
| --- | --- |
| [`wrangler.jsonc`](../../../../wrangler.jsonc) | 기본 빌드 설정. Worker `sjn`, `APP_ENV=local`, `STORAGE_MODE=auto`. `AI`·`ASSETS`와 D1 `sjn`의 `DB` 바인딩, `migrations_dir=migrations/d1` 선언. `ASSET_BUCKET` 미선언 |
| [`wrangler.d1.example.jsonc`](../../../../wrangler.d1.example.jsonc) | 운영 D1 참고본. `sjn-data`·`sjn-assets`는 예시 이름, DB ID·도메인은 placeholder. 자동 적용되지 않음 |
| [`.env.example`](../../../../.env.example) | Next/Node 변수 예시. 실제 `.env.local`은 운영 Worker secret을 대신하지 않음 |
| [`.dev.vars.example`](../../../../.dev.vars.example) | Wrangler 로컬 변수 예시. 실제 `.dev.vars`는 배포 설정이 아님 |
| `dist/server/wrangler.json` | Workers 빌드 산출물. 미리보기·배포 명령이 읽음. 원본 설정을 수정하고 다시 빌드 |

Wrangler 소스는 `compatibility_date=2026-09-07`, `nodejs_compat`, 진입점 `vinext/server/fetch-handler`를 사용한다. Dashboard에만 있는 운영 값이나 바인딩이 현재 소스와 일치하는지는 미확인이다.

| 변수·바인딩 | 용도 |
| --- | --- |
| `APP_ENV`, `STORAGE_MODE` | 저장소 선택. `NEXT_PUBLIC_STORAGE_MODE`는 `STORAGE_MODE`가 없을 때만 읽는 호환 변수 |
| `BETTER_AUTH_URL` | 앱의 기준 origin. 운영은 HTTPS |
| `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | 서버 인증 설정. 운영 값은 Wrangler secret/Worker 설정으로 준비 |
| `DB` | D1 바인딩. URL·비밀번호 환경변수가 아님 |
| `ASSET_BUCKET` | 비공개 R2 사용자 자료 바인딩 |
| `ASSETS` | `dist/client`의 앱 정적 파일 바인딩. R2 사용자 자료와 별개 |
| `AI` | Gemma·FLUX가 공유하는 Workers AI 바인딩 |
| `NEXT_PUBLIC_MOGE_MODEL_URL` | 선택적 브라우저 MoGe 모델 미러. 같은 고정 SHA의 모델만 허용 |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` | 기존 Node/Next Supabase 어댑터의 선택적 설정 |

`NEXT_PUBLIC_`에는 서버 secret이나 AI 토큰을 넣지 않는다. 설정 작업에서는 예시 파일과 코드로 이름·형식을 확인하고, 실제 secret은 문서·로그·Git에 옮기지 않는다.

## 로컬·운영 저장소 선택

현재 기준은 [`storage/config.ts`](../../../../src/lib/storage/config.ts), [`storage/server.ts`](../../../../src/lib/storage/server.ts), [`storage/bootstrap.ts`](../../../../src/lib/storage/bootstrap.ts)다.

- `APP_ENV`가 `production`이 아니면 로컬 IndexedDB를 선택한다.
- 운영 `STORAGE_MODE=auto` 또는 `d1`은 Cloudflare 런타임, `DB`·`ASSET_BUCKET`, 인증 설정과 스키마·연결 확인이 필요하다.
- 운영 `STORAGE_MODE=local`, 잘못된 설정, 누락된 바인딩, 연결 실패·초기 timeout은 **편집 차단 상태**다. 로그인 없는 로컬 편집으로 자동 전환하지 않는다.
- `STORAGE_MODE=supabase`는 Node/Next에서만 지원한다. Workers의 기존 `/api/cloud/**` 경로는 503으로 대체되며 D1 경로는 `/api/d1/**`다.

`GET /api/storage/status`는 서버 최대 4.5초, 브라우저 초기 확인은 최대 5초다. D1 스키마와 R2의 `HEAD __sjn_readiness__`를 읽기 전용으로 확인하며, sentinel 객체가 없어도 HEAD 성공이면 된다. `ready:true`는 실제 Google 로그인이나 R2 업로드 성공까지 증명하지 않는다. 근거: [`status route`](../../../../src/app/api/storage/status/route.ts), [`d1/database.ts`](../../../../src/lib/d1/database.ts).

README와 일부 과거 검증 기록의 “초기 실패 후 로컬 시작” 설명은 현재 정책과 다르다. 이 문서에서는 위 소스를 기준으로 하며, 운영 구성 상세는 [D1·R2 설정 가이드](../../../../docs/cloudflare-storage-setup.md)를 확인한다.

## R2 객체 키와 이미지 API

R2에는 이미지·제품 메시와 프로젝트 JSON 스냅샷을 저장한다. D1에는 자산 메타데이터·권한·참조와 실제 객체 키를 저장한다. 버킷 이름은 배포 환경의 `ASSET_BUCKET` 바인딩으로 결정하며 `sjn-assets`를 실제 운영 버킷명으로 단정하지 않는다.

| 자료 | 코드가 만드는 R2 객체 키 | D1 연결 |
| --- | --- | --- |
| 이미지·제품 메시 | `assets/{encodeURIComponent(userId)}/{assetId}/{randomUUID}` | `d1_assets.object_key` |
| 프로젝트 스냅샷 | `projects/{encodeURIComponent(userId)}/{projectId}/{randomUUID}.json` | `d1_projects.object_key` |

자산 키에는 원래 파일명이나 확장자가 붙지 않는다. 객체 키와 브라우저에서 여는 API URL은 다르다. 근거: [`d1/assets.ts`](../../../../src/lib/d1/assets.ts), [`d1/projects.ts`](../../../../src/lib/d1/projects.ts), [`0002_storage.sql`](../../../../migrations/d1/0002_storage.sql).

| 흐름 | 경로·동작 |
| --- | --- |
| 인증 업로드 | `POST /api/d1/assets`, multipart `file` + JSON 문자열 `metadata` |
| 인증 메타데이터 조회 | `GET /api/d1/assets?id={assetId}` → 자산 메타데이터와 아래 raw URL |
| 인증 파일 조회 | `GET /api/d1/assets?id={assetId}&raw=1` → D1의 `object_key`로 R2를 읽어 응답 |
| 공개 카탈로그 이미지 | `GET /api/catalog/images?id={assetId}` → 허용된 공개 이미지의 바이트 응답 |

인증 경로는 세션과 자산 접근권한을 확인한다. 업로드는 파일 최대 25MB이며 서버가 형식·MIME·메타데이터를 검증한다. 정리 기록을 남기고 R2에 올린 뒤 D1 등록을 확정한다. raw 응답은 `private, no-store`이며 R2 공개 URL이나 서명 URL을 반환하지 않는다.

공개 이미지 API는 현재 활성 공용 카탈로그 버전에 직접 표시되는 `texture`·`product`·`preview`만 허용한다. 파생 이미지의 원본 참조를 따라 공개하지 않는다. 사용자 자료 버킷 전체를 공개할 필요가 없다.

흐름 근거: [`cloud repository`](../../../../src/lib/repositories/cloud.ts), [`D1 route`](../../../../src/app/api/d1/assets/route.ts), [`storage/server.ts`](../../../../src/lib/storage/server.ts), [`catalog/public.ts`](../../../../src/lib/catalog/public.ts), [`catalog image route`](../../../../src/app/api/catalog/images/route.ts).

기존 Supabase의 [`/api/cloud/assets`](../../../../src/app/api/cloud/assets/route.ts)는 `scene-assets` 버킷의 `{userId}/{assetId}`와 120초 서명 URL을 사용한다. 이 경로를 R2 규칙과 혼동하지 않는다.

## Google 로그인

Better Auth 기준 경로는 `/api/auth`다. `BETTER_AUTH_URL`에는 경로·query·hash 없는 origin을 넣는다. 예시 origin이 `https://YOUR-APP.example.com`이면 Google 승인 리디렉션 URI는 `https://YOUR-APP.example.com/api/auth/callback/google`이다.

운영은 HTTPS만 허용하고 신뢰 origin은 설정된 기준 주소로 제한한다. 앱 접속 origin·`BETTER_AUTH_URL`·Google Console 콜백의 origin을 일치시킨다. 실제 OAuth 클라이언트·운영 콜백·세션 갱신은 이번 문서 작성에서 확인하지 않았다. 근거: [`auth/d1.ts`](../../../../src/lib/auth/d1.ts), [설정 절차](../../../../docs/cloudflare-storage-setup.md).

## AI 연결과 모델 다운로드

| 기능 | 서버 API | 모델·공통 연결 |
| --- | --- | --- |
| 사진 설비 분석 | `/api/reconstruction/cloud` | `@cf/google/gemma-4-26b-a4b-it`, `AI`, `sjn-gateway` |
| 현장 사진 변환 내보내기 | `POST /api/export/photoreal` | `@cf/black-forest-labs/flux-2-klein-4b` 또는 `flux-2-klein-9b`, 같은 `AI`·`sjn-gateway` |

Gemma·FLUX는 별도 Gateway나 브라우저 토큰 없이 서버 바인딩을 공유한다. 근거: [`Gemma contract`](../../../../src/lib/reconstruction/cloud-gemma-contract.ts), [`Gemma server`](../../../../src/lib/reconstruction/cloud-gemma-server.ts), [`FLUX contract`](../../../../src/lib/ai-export/contract.ts), [`FLUX server`](../../../../src/lib/ai-export/server.ts).

Next 개발 서버에는 Cloudflare AI 바인딩이 없다. `build:vinext` → `start:vinext`로 로컬 workerd를 실행해도 AI 요청은 실제 원격 호출이며 사진 전송·사용량이 발생한다. 로컬 저장 강제는 AI 네트워크 차단을 뜻하지 않는다. 실제 AI 검사에는 원격 바인딩을 끄는 `--local`을 추가하지 않으며 Worker 전체를 원격 실행하는 `--remote`도 필요 없다.

Gemma GET 준비 응답은 바인딩·접근 정책만 확인한다(`upstreamVerified:false`). 모델 추론·잔여량·Gateway 로그·과금의 실제 상태를 보증하지 않는다.

MoGe·DeepLab 계산은 브라우저에서 수행한다. MoGe와 배경 제거 등은 최초 실행에 모델/CDN 다운로드가 필요할 수 있다. MoGe R2 미러를 마련할 경우 모델 전용 공개 경로를 사용하고 사용자 사진 버킷을 공개하지 않는다. 연결 작업에만 [현재 AI 실행 가이드](../../../../docs/reconstruction-cloud-browser-setup.md), 내보내기 작업에만 [FLUX 가이드](../../../../docs/flux-export.md)를 추가로 읽는다.

## 빌드와 실제 배포의 경계

`npm run build`·`npm run build:vinext`는 빌드, `npm run start:vinext`는 로컬 미리보기다. `npm run deploy:vinext`는 생성된 `dist/server/wrangler.json`으로 실제 Worker 배포를 수행한다. 기본 소스 설정을 그대로 배포하면 로컬 저장 모드다.

원격 자원 생성·secret 등록·원격 migration은 일반 로컬 개발의 필수 단계가 아니다. 현재 `DB`가 가리키는 원격 D1 `sjn`에는 `migrations/d1/0001_auth.sql`부터 `0004_catalog_seed.sql`까지 적용됐으며, DB 재생성이나 기존 SQL 재실행은 필요 없다. 이후에는 대상 DB와 미적용 migration을 확인한다. `wrangler d1 migrations apply DB --local`은 로컬 DB, `--remote`는 실제 원격 DB를 변경한다. 원격 DB 적용과 별개로 앱은 `APP_ENV=local`, `STORAGE_MODE=auto`를 유지하며 R2 설정·관리자 지정·배포는 수행하지 않았다.

배포·D1/R2 설정이 필요한 작업에서만 [Cloudflare 배포 가이드](../../../../docs/cloudflare-deployment.md)와 [저장소 설정 가이드](../../../../docs/cloudflare-storage-setup.md)를 읽는다. 날짜가 붙은 검증 문서의 과거 결과는 현재 운영 계정·배포·Google 로그인·R2 쓰기의 재확인으로 취급하지 않는다.

이 문서의 명령·포트·환경변수·바인딩·저장소 선택·R2 키/API·OAuth·AI 연결을 바꾸는 코드나 설정을 수정했다면, 해당 항목과 근거 링크를 같은 작업에서 갱신한다.
