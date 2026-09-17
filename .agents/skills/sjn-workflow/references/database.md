# DB·저장 구조

확인 기준: **2026-09-17 현재 소스와 별도로 확인한 원격 이력**. 2026-09-17 사용자 승인 후 원격 D1 `sjn`에 기존 `0001~0004`를 보존하며 `0005_admin_management.sql`과 `0006_reconstruction_diagnostics.sql`을 추가 적용했다. `.wrangler/development`의 빈 로컬 개발 DB에도 `0001~0006`을 순서대로 적용했다. 양쪽 초기 데이터·무결성을 확인했으며 관리자 지정·배포·R2 버킷 생성·실제 Google 로그인·AI 호출은 수행하지 않았다. 운영 R2 연결도 미검증이다. 정확한 DDL은 [migrations/d1](../../../../migrations/d1), ERD·인덱스·전체 SQL·과거 확인값은 [DB 설계](../../../../docs/database-design.md)를 따른다.

## 저장 경계

| 저장소 | 역할 |
| --- | --- |
| D1 `DB` | 회원·세션·역할·상태/revision, 관리자 감사, 프로젝트 목록/revision, 자재 버전·분류·참조·재시도·정리 |
| 비공개 R2 `ASSET_BUCKET` | 프로젝트 JSON 스냅샷, 이미지·원본·가공 자료·제품 메시 |
| IndexedDB | 본인 미저장 복구본, 자산·시안·AI 재사용 캐시. 예전 브라우저 원본은 읽기·쓰기·삭제·자동 이전하지 않음 |
| sessionStorage | `/try`의 같은 탭 임시 초안·공개 자재 배치 정보·빈 방 재생성 정보. 이미지 바이트·계정 자료·D1/R2 쓰기 없음 |
| 진단 D1/R2 | 진단 메타데이터·계정별 JSON 아카이브(20건/25MiB) |
| Workers `ASSETS` | 앱 정적 파일; 사용자 자료 R2와 별개 |

기본 개발은 [wrangler.dev.jsonc](../../../../wrangler.dev.jsonc)의 로컬 D1/R2를 `.wrangler/development`에 저장하며 계정 프로젝트·관리·사진/AI 기능에는 Google 로그인이 필요하다. 운영 빌드 원본 [wrangler.jsonc](../../../../wrangler.jsonc)은 기존 `sjn` 바인딩을 보존한다. 소스에는 기존 R2 `sjn`을 연결하는 `ASSET_BUCKET`을 추가했다. 2026-09-17 확인한 실배포 버전에는 이 바인딩과 인증 설정이 아직 없어 소스 변경 후 재배포·인증 준비가 필요하다. 버킷 존재 확인이나 DB 적용 완료를 앱의 R2 업로드·Google 로그인 성공으로 해석하지 않는다. 기존 IndexedDB 자료는 보존한다. 익명 체험은 이 원본이나 계정 복구본을 열지 않는 별도 `/try` 경로다.

## 핵심 스키마

| 원본 | 계약 |
| --- | --- |
| [0001](../../../../migrations/d1/0001_auth.sql) | Better Auth `user/session/account/verification/rateLimit`, 기존 `admin_roles`, auth meta |
| [0002](../../../../migrations/d1/0002_storage.sql) | 프로젝트 R2 문서·revision, 자재 불변 버전, 자산·참조, 재시도·조건 검사·정리 |
| [0003](../../../../migrations/d1/0003_catalog.sql) | 하위 분류·색상/브랜드/재질/마감·버전별 선택 ID, catalog/project 용도 분리 |
| [0004](../../../../migrations/d1/0004_catalog_seed.sql) | 속성 33개·하위 분류 21개. 고정 ID/`ON CONFLICT DO NOTHING`, 정확히 일치하는 과거 문자열만 연결 |
| [0005](../../../../migrations/d1/0005_admin_management.sql) | `d1_user_management`, `d1_admin_audit`, `d1_admin_checks`, 관리자 프로젝트 자산/버전 범위, admin meta·목록/감사 인덱스 |
| [0006](../../../../migrations/d1/0006_reconstruction_diagnostics.sql) | `d1_reconstruction_diagnostics`, `d1_diagnostic_cleanup`, `d1_diagnostic_checks`; 계정별 목록/정리 인덱스 |

`0001~0004`는 수정하지 않는다. `0005`는 기존 회원을 active/revision 0으로 backfill하고 기존 역할·세션·자료를 보존한다. 신규 회원 상태 생성, 정지 시 세션 삭제, 정지 회원 session INSERT/UPDATE 거부는 SQL trigger로도 보장한다. `owner_id`·`current_version_id`는 기존 논리 관계이며 새 FK를 만들려고 기존 테이블을 재생성하지 않는다. 카탈로그·새 프로젝트 편집 범위의 참조는 FK를 사용한다.

## 로그인·회원 관리

[인증](../../../../src/lib/auth/d1.ts)은 Google + D1 세션이다. 검증된 세션 ID와 최신 회원 상태·`admin_roles`를 확인한다. 비밀번호 가입·계정 자동 연결·첫 가입자 자동 승격은 없다. 개발·운영 모두 메인·공용 자재 구경·`/try`의 빈 공간 생성과 기본 자재 검색/배치를 공개한다. 사진·AI·정식 저장·시안 비교·견적·출력과 기존 계정 프로젝트는 로그인 필수다. 세션 만료·정지·강등 후 계정/관리자 자료 접근을 차단하며 해당 작업을 게스트 초안으로 자동 전환하지 않는다. 운영 저장 계약은 D1 전용이다. 로컬 저장 어댑터·Supabase 실행 코드와 SDK는 제거했으며 `/api/cloud/**`는 410으로 종료를 안내한다. 과거 데이터 형식 검증용 IndexedDB 구현은 테스트 전용이며 앱 번들에서 참조하지 않는다.

[회원 API](../../../../src/lib/admin/users.ts)는 이름/email/id 부분 검색·role/status 필터와 25개 cursor 페이지, `setRole/setStatus`를 제공한다. 변경에는 `expectedRevision`과 `X-Idempotency-Key`가 필수다. [access](../../../../src/lib/admin/access.ts)는 현재 활성 관리자·대상 revision·자기 정지·마지막 활성 관리자 보호를 변경·감사·재시도 결과와 같은 batch에서 확인한다. 정상 값 변경만 revision을 증가시키며 중복 요청은 감사/변경을 반복하지 않는다.

최초 관리자만 확인한 Google 회원에 대해 [설계 문서의 bootstrap SQL](../../../../docs/database-design.md)을 사용한다. 이후 일상적인 승격·강등·정지·해제는 `/admin/users`에서 수행한다. 직접 SQL은 앱의 마지막 관리자·revision·감사 정책을 우회할 수 있다.

## 프로젝트·자재 접근과 감사

- 일반 [프로젝트 API](../../../../src/lib/d1/projects.ts)는 관리자도 본인 자료만 다룬다. 일반 회원에게 다른 회원의 자료 접근을 열지 않는다.
- [관리자 프로젝트 전용 API](../../../../src/lib/admin/projects.ts)는 타인 프로젝트 검색·조회·편집을 허용한다. 소유자 ID와 실제 관리자 행위자를 분리하고 기존 `storage_revision` 충돌 검사를 유지한다. 다른 회원 프로젝트 삭제·복제·소유권 이전은 제공하지 않는다.
- 관리자 자산/버전은 해당 문서의 참조, 그 관리자·프로젝트에서 새로 만든 자료, 허용된 공용 카탈로그로 제한한다. 관계없는 회원 개인 자료는 제외한다. 별도 추적 테이블은 접근 범위이며 미사용 자료를 영구 보존하는 참조가 아니다.
- 관리자 목록·읽기·변경·저장·관련 자료 접근은 `d1_admin_audit`에 기록한다. 역할/상태/revision 등의 작은 요약만 남기고 토큰·프로젝트 원문·사진·R2 키는 넣지 않는다. 감사 실패 시 보호 작업도 실패한다. 계정/프로젝트 삭제로 감사가 cascade되지 않지만 운영 DB 권한까지 막는 변조 방지 기능은 아니다.
- [공용 카탈로그](../../../../src/lib/catalog/public.ts)의 GET 목록·표시 이미지·배치 API는 로그인 없이 shared/active/catalog 현재 버전만 제공한다. [배치 DTO](../../../../src/lib/catalog/placement-contract.ts)는 버전 ID·규격·설치 방식·줄눈·표시 이미지와 배치 기준점만 포함하며 회원 정보·R2 키·전체 payload·원본·메시·source/product3d 참조를 공개하지 않는다. 배치 이미지가 일부라도 공개 불가하면 해당 자재의 배치 DTO는 제외하여 기존 뷰 인덱스를 보존한다. `/api/d1/**`와 관리자 API의 인증·소유권 검사는 유지한다.
- 일반 회원 모형은 `personal/project`로 제한된 생성 API를 쓴다. 자재 수정은 새 버전이고 기존 프로젝트의 과거 버전·연결 이미지·이름 스냅샷을 보존한다.

## 저장·정리

[D1 database helper](../../../../src/lib/d1/database.ts)는 소유권·revision·자산/버전 참조를 커밋 batch에서 재확인한다. 관리자 편집 batch에는 현재 활성 관리자 조건도 추가한다. 재시도 기록은 행위자·요청 키·리소스·해시가 맞아야 재사용하며 권한 상실 후에는 반환하지 않는다.

R2와 D1은 하나의 트랜잭션이 아니다. `stageObject`가 업로드 전에 정리 작업을 기록하고 D1 커밋이 확정되면 제거한다. [cleanup](../../../../src/lib/d1/cleanup.ts)은 프로젝트·불변 버전·파생 자산의 원본 참조를 보존한다. 미사용 객체는 24시간 유예, lease·재시도를 사용한다. 저장 후 유지관리 실패로 확정된 저장을 실패로 바꾸지 않는다.

## 적용·검증

`npm run db:dev:migrate`는 `wrangler.dev.jsonc --local --persist-to .wrangler/development`의 로컬 DB에만 적용한다. 원격 `sjn`과 로컬 개발 DB는 2026-09-17 승인 후 0001~0006 적용을 완료했다. 이후 원격 변경은 승인된 대상과 미적용 목록을 다시 확인한다. migration 작성이나 문서 변경을 운영 적용 허가로 해석하지 않는다.

빈 DB 0001~0006, 기존 DB upgrade, seed 중복 방지, FK·불변 참조·관리자 감사·정지·동시 변경·재시도를 격리 Miniflare로 검사한다. 주된 테스트는 `tests/d1-auth.test.ts`, `d1-admin-users.test.ts`, `admin-projects.test.ts`, `d1-storage.test.ts`, `d1-catalog.test.ts`다. 브라우저 fixture와 로컬 Google provider를 실제 Google·운영 R2 검증으로 보고하지 않는다. 준비 확인은 읽기 전용이며 앱이 테이블을 자동 생성하지 않는다.

관련 스키마·권한·참조·실행 경계가 바뀌면 이 요약과 [상세 설계](../../../../docs/database-design.md), [설정 가이드](../../../../docs/cloudflare-storage-setup.md)를 함께 갱신한다.

## 브라우저 저장과 진단 아카이브

프로젝트·자재·기준값의 정식 저장은 D1/R2다. [게스트 세션](../../../../src/lib/guest/session.ts)은 `sessionStorage`의 `sjn:guest-draft:v1`에 같은 탭 초안을 보관하여 새로고침·Google 로그인 이동 뒤 복원한다. 탭을 닫으면 사라질 수 있으며 계정 IndexedDB나 기존 자료를 열지 않는다. 체험에서 로그인을 선택해 돌아오면 현재 계정과 자재 참조를 재검증하여 본인 D1/R2 프로젝트로 저장한다. 저장 확정 전에는 임시 초안을 지우지 않고 실패·계정 변경을 처리하며, 익명 상태에서는 D1/R2 쓰기·AI·진단 아카이브를 실행하지 않는다. 기준값 선택은 D1 API만 사용하며 과거 localStorage 분류를 읽거나 저장하지 않는다. 본인 프로젝트의 IndexedDB 복구본은 500ms 지연·서버 저장 전에 작성하고 확인된 동일 내용은 정리한다. 충돌 보관본은 삭제하지 않는다.

자산 캐시는 매번 서버가 계정 권한을 승인한 뒤 동일 SHA-256 Blob만 재사용한다. 저장 후 7일 만료, 모든 계정 합산 100개/200MiB, 개별 25MiB 제한을 적용한다. 서버 권한 오류나 연결 실패에 캐시로 우회하지 않으며 관리자 타인 프로젝트 자산에는 캐시를 사용하지 않는다. 시안 미리보기와 AI 단계 캐시는 반복 렌더링·추론 방지를 위해 유지하고 모델 파일은 별도 CacheStorage를 쓴다.

진단 로그는 `0006_reconstruction_diagnostics.sql`의 D1 메타데이터·비공개 R2 JSON으로 계정별 20건/25MiB를 보관한다. 분석 시작 계정과 현재 계정이 다르면 업로드를 막는다. 관리자 타인 프로젝트 분석은 서버 아카이브에도 저장하지 않고 현재 실행 메모리에서만 내려받는다. 기존 IndexedDB 진단은 열거나 자동 전송·삭제하지 않는다. 원격 sjn과 로컬 개발 DB의 0001~0006은 2026-09-17에 적용 완료했다. 새로운 개발 환경이나 이후 마이그레이션은 `npm run db:dev:migrate`로 로컬 미적용 번호만 순차 적용한다.
