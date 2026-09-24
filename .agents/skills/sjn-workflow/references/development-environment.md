# 개발환경 참조

체험의 우측 견적·수량·단가·속성·공간 구조 조절과 시안 추가/비교는 비로그인으로 허용한다. 상단 공간 둘러보기·AI 보정·저장·공간 크기·내보내기는 로그인 안내로 연결한다. 공개 자재의 등록된 가격·포장 정보만 사용하며, 수정한 견적과 시안은 같은 탭의 초안에만 보관한다.

확인 기준: **2026-09-17 현재 소스**. 2026-09-17 사용자 승인 후 D1 `sjn`의 기존 0001~0004에 0005·0006을 추가 적용했고, `.wrangler/development`의 빈 로컬 개발 DB에는 0001~0006을 순서대로 적용했다. 양쪽 초기 데이터·무결성을 확인했다. 관리자 지정·배포·R2 버킷 생성·실제 Google 인증·AI 호출은 수행하지 않았다. 실제 secret은 문서·로그·Git에 기록하지 않는다. 기존 R2 `sjn`(Standard/APAC, 2026-09-14 생성, 확인 당시 객체 0개)을 읽기 확인했고 소스에 `ASSET_BUCKET → sjn`을 추가했다. 2026-09-17 14:46:54 UTC에 생성된 현재 실배포 버전(`d70ff6c6-bd4e-4bba-9758-9bd5bdd81911`)을 읽기 확인한 결과 `DB`·`ASSET_BUCKET`·`AI`·`ASSETS` 바인딩과 `APP_ENV=production`·`STORAGE_MODE=d1`·`BETTER_AUTH_URL=https://sjn.gyulbbe.workers.dev`가 있다. 운영 secret 목록은 비어 있고 전체 바인딩에도 `BETTER_AUTH_SECRET`·`GOOGLE_CLIENT_ID`·`GOOGLE_CLIENT_SECRET`이 없어 로그인 준비 검사가 실패한다. 2026-09-23 소스부터 로그인 준비에 필수인 secret은 `BETTER_AUTH_SECRET`뿐이고 Google 두 값은 선택이다(둘 다 없으면 아이디 로그인만, 한쪽만 있으면 설정 오류). 이 소스는 `0007_username_auth.sql`의 `username`·`displayUsername` 컬럼을 준비 조건으로 본다. 2026-09-23 사용자가 원격 `sjn`에 0007의 `username`·`displayUsername` 컬럼을 직접 추가했고(auth meta version 1 유지), 같은 날 사용자 승인으로 Time Travel 북마크 기록 후 남은 고유 인덱스 `user_username_idx`와 `d1_migrations`의 0007 기록을 추가했다. 원격 목록은 `No migrations to apply`이며 회원 수는 변하지 않았다. 실제 `/api/storage/status`는 `ready=false`, `reason=invalid_configuration`이다. 이 확인은 운영 설정 변경·배포를 하지 않은 읽기 검사이며, 인증 준비 검사에서 중단되므로 현재 D1/R2 실제 읽기·쓰기나 Google 로그인이 성공했다는 뜻은 아니다. 실제 Google OAuth·R2 업로드 검증은 남아 있다. 로컬 `.dev.vars`·`.env.local`·`.env`·`.dev.vars.development`도 확인 당시 없었다. Google callback은 `https://sjn.gyulbbe.workers.dev/api/auth/callback/google`이다.

## 실행과 검사

Node 기준은 [`.node-version`](../../../../.node-version)의 22.23.2다. [package.json](../../../../package.json)과 lockfile을 사용하며 새 환경은 `npm ci`로 설치한다.

| 목적 | 명령 | 동작 |
| --- | --- | --- |
| 기본 Workers 개발 | `npm run dev` 또는 `npm run dev:vinext` | vinext, `http://127.0.0.1:3000`, 로컬 D1/R2; 계정 기능은 아이디 가입·로그인(Google은 설정 시) |
| 개발 migration | `npm run db:dev:migrate` | 0001~0007 중 미적용 번호, 로컬 DB만, `.wrangler/development` |
| 별도 Next 개발 | `npm run dev:next` | Node/Next, Cloudflare D1/R2/AI 바인딩 없음; 기본 앱 작업 공간 대체 아님 |
| Next 빌드 | `npm run build` → `npm run start` | Node 빌드/실행 검사; Workers 바인딩은 생기지 않음 |
| Workers 빌드·미리보기 | `npm run build:vinext` → `npm run start:vinext` | 빌드 설정과 `dist/server/wrangler.json`, 포트 8787, `.wrangler/state` |
| 기본 검사 | `npm run typecheck`, `npm run lint`, `npm test` | 변경 범위에 맞는 검증; Next/vinext 빌드는 순차 실행 |

vinext 개발 서버는 클라이언트 모듈을 동적 import로 받아 Next 개발 서버보다 하이드레이션이 늦다(홈 기준 0.3~2초). 서버에서 먼저 그려지는 공개 화면의 버튼은 하이드레이션 전까지 비활성으로 두고(`GuestHome`), e2e는 활성화를 기다린 뒤 누른다.

[dev-local](../../../../scripts/dev-local.mjs)는 `APP_ENV=development`, `SJN_DEV_BINDINGS=1`을 설정한다. [Vite 설정](../../../../vite.config.ts)이 이를 보고 `wrangler.dev.jsonc`와 `persistState.path=.wrangler/development`를 선택한다. 개발용 DB/R2에는 `remote:false`가 명시돼 있다. 기본 빌드 설정과 개발 설정을 섞지 않는다. 기존 `.wrangler/state`나 origin별 IndexedDB 자료는 삭제·자동 이전하지 않는다.

## 설정 파일과 변수

| 파일 | 역할 |
| --- | --- |
| [wrangler.dev.jsonc](../../../../wrangler.dev.jsonc) | 개발 전용 sjn-development. 로컬 DB/R2, `APP_ENV=development`, `STORAGE_MODE=d1`, `BETTER_AUTH_URL=http://127.0.0.1:3000`, AI 바인딩 없음 |
| [wrangler.jsonc](../../../../wrangler.jsonc) | 기본 빌드/배포 원본. 원격 sjn DB/AI/ASSETS, APP_ENV=production·STORAGE_MODE=d1, ASSET_BUCKET → 기존 R2 sjn, BETTER_AUTH_URL=https://sjn.gyulbbe.workers.dev. 현재 실배포에 해당 바인딩·공개 변수 반영을 읽기 확인했으며 로그인 secret 3개는 미등록 |
| [wrangler.d1.example.jsonc](../../../../wrangler.d1.example.jsonc) | 운영 설정 참고본; 이름·ID·도메인·버킷은 예시이며 자동 적용되지 않음 |
| [.dev.vars.example](../../../../.dev.vars.example) | 실제 `.dev.vars`의 로컬 Workers secret 예시. 빈 Google/Better Auth 값을 직접 준비 |
| [.env.example](../../../../.env.example) | Node/Next 변수 참고. `.env.local`은 Workers secret을 대신하지 않음 |
| `dist/server/wrangler.json` | 생성물; 직접 편집하지 않고 원본 설정을 고쳐 재빌드 |

D1 `DB`와 R2 `ASSET_BUCKET`은 바인딩이며 URL/비밀번호 변수가 아니다. `ASSETS`는 정적 파일이고 R2 사용자 자료와 다르다. `AI`는 Gemma/FLUX 공통 Workers AI 바인딩이다. `BETTER_AUTH_SECRET`(필수), `GOOGLE_CLIENT_ID`·`GOOGLE_CLIENT_SECRET`(선택, 둘 다 넣거나 둘 다 비움)은 서버 전용이다. 준비 응답 `/api/storage/status`는 ready일 때 값 없이 `googleSignIn` 여부만 알려 주고 화면은 이에 따라 Google 버튼을 숨긴다. `NEXT_PUBLIC_*`·Wrangler vars·커밋에 비밀값을 넣지 않는다.

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

Gemma는 `/api/reconstruction/cloud`의 `@cf/google/gemma-4-26b-a4b-it`, FLUX는 `/api/export/photoreal`의 4B/9B다. 같은 `AI` 바인딩과 `sjn-gateway`를 사용하며 활성 로그인이 필요하다. 기본 개발 설정과 Next Node에는 AI 바인딩이 없다. 기본 개발 서버 시작만으로 원격 프록시를 연결하지 않도록 `wrangler.dev.jsonc`에서 AI를 제외했다. 실제 Workers AI 검증은 별도 승인된 원격 AI 바인딩 설정에서 실행한다. **로컬 D1/R2라는 사실은 AI가 로컬이라는 뜻이 아니다.** 명시적 AI 실행은 Cloudflare 사진 전송·사용량을 발생시킨다. 로그인·DB 준비·문서 갱신만으로 AI를 실행하지 않는다.

체험 중에는 사진 업로드·AI 실행·진단 아카이브를 시작하지 않는다. MoGe·DeepLab·배경 제거·제품 입체화는 로그인한 기능의 브라우저 실행이며 모델/CDN 다운로드가 필요할 수 있다. [현재 AI 가이드](../../../../docs/reconstruction-cloud-browser-setup.md), [FLUX](../../../../docs/flux-export.md)를 해당 기능 작업 시 확인한다. 준비 응답은 바인딩/접근 검사이며 추론·과금·잔여량 검증이 아니다.

`deploy:vinext`는 실제 배포다. 현재 확인한 실배포에는 소스의 R2 바인딩과 공개 인증 URL이 반영되어 있다. 이후 소스 변경을 Worker에 반영하려면 검증된 산출물로 배포해야 하며, 누락된 Better Auth secret(과 선택한 경우 Google 두 값)은 배포만으로 생성되지 않는다. main 푸시는 Cloudflare 자동 배포로 이어진다(2026-09-23 푸시 약 80초 뒤 새 배포 확인). 아이디 로그인 코드는 0007 컬럼이 있는 DB에서만 준비 검사를 통과한다. 이 문서 갱신에서는 원격 설정·DB·배포를 변경하지 않았다. 원격 sjn과 로컬 개발 DB는 2026-09-17 사용자 승인 후 0001~0006 적용을 완료했다. 이후 운영 DB 변경은 대상과 미적용 목록을 확인해 별도로 승인된 범위에서 진행한다. 로컬 개발 DB 적용과 원격 DB 적용은 다른 작업이다. 자세한 Google/secret/배포 준비는 [설정 가이드](../../../../docs/cloudflare-storage-setup.md)를 따른다.
