# DB·저장 구조

확인 기준: **2026-09-17 저장소 소스와 실제 원격 D1 확인**. Wrangler 원격 목록에서 D1 `sjn`의 이름·ID를 대조했고 `0001`~`0004` 적용 이력·스키마·기본 데이터·무결성을 확인했다. 앱의 운영 Worker 연결·Google OAuth·R2는 미검증이며 관리자 지정·배포는 수행하지 않았다. 이 문서는 DB 작업 시 지켜야 할 계약과 원본 위치를 요약한다. 정확한 DDL은 [migrations/d1](../../../../migrations/d1), 현재 원격 확인값과 상세 설계는 [DB 설계 문서](../../../../docs/database-design.md)를 확인한다.

## 저장 경계와 현재 상태

| 저장소 | 역할 |
| --- | --- |
| Cloudflare D1 `DB` | 회원·세션·관리자 역할, 프로젝트 요약·revision, 자재 버전 JSON, 분류·속성, 참조·재시도·정리 기록 |
| 비공개 R2 `ASSET_BUCKET` | 프로젝트 JSON 스냅샷, 이미지·원본·가공 자료·제품 메시 |
| 브라우저 IndexedDB | 로컬 프로젝트·자재·사진. 로그인만으로 기존 자료를 서버에 자동 업로드하지 않음 |
| Workers `ASSETS` | 앱 정적 파일. 사용자 자료용 R2와 구분 |

현재 [wrangler.jsonc](../../../../wrangler.jsonc)는 `APP_ENV=local`, `STORAGE_MODE=auto`를 유지하며 D1 `sjn`의 `DB` 바인딩과 `migrations_dir: "migrations/d1"`을 포함한다. 원격 migration `0001`~`0004`는 적용됐지만 R2 `ASSET_BUCKET`은 미선언이며 앱 배포·관리자 지정은 수행하지 않았다. 운영 설정 참고본 [wrangler.d1.example.jsonc](../../../../wrangler.d1.example.jsonc)의 `sjn-data`는 예시 이름이다. DB 스키마 준비를 앱의 운영 연결 완료로 표현하지 않는다. [DB 설계 문서의 2026-09-16 검증 기록](../../../../docs/database-design.md)은 당시 격리 Miniflare·Google 테스트 provider 결과이며 현재 원격 DB 적용 상태와 구분한다.

관련 변경 시 저장소별 역할과 기본 모드를 갱신한다. 운영 상태는 실제 확인 근거와 확인일이 있을 때만 바꾼다.

## 핵심 테이블과 관계

| 영역 | 원본·핵심 관계 |
| --- | --- |
| 인증 | [0001_auth.sql](../../../../migrations/d1/0001_auth.sql): `user`와 `session`, `account`, `admin_roles` 연결. `verification`, `rateLimit`, `d1_auth_meta` 포함 |
| 프로젝트 | [0002_storage.sql](../../../../migrations/d1/0002_storage.sql): `d1_projects`에 소유자·요약·`storage_revision`·R2 `object_key` 저장 |
| 자재 | `d1_materials`의 `current_version_id`가 현재 `d1_material_versions`를 가리킴. 버전별 payload·연결 자산을 보존 |
| 자산·참조 | `d1_assets`는 R2 객체 메타데이터와 원본 `source_asset_id`를 보유. `d1_project_assets`, `d1_project_versions`, `d1_material_assets`로 사용 관계 저장 |
| 카탈로그 | [0003_catalog.sql](../../../../migrations/d1/0003_catalog.sql): `d1_catalog_options`, `d1_material_subcategories`, `d1_material_version_options`; 자재에 `purpose` 추가 |
| 저장 안정성 | `d1_mutations`는 재시도 결과, `d1_checks`는 batch 조건 검사, `d1_cleanup_jobs`와 `d1_maintenance`는 객체 정리·실행 간격 관리 |

`owner_id`와 `current_version_id`는 기존 스키마의 **논리 관계**이며 FK가 아니다. 서버의 소유권·참조 검사를 유지한다. 카탈로그 연결은 FK·유일 제약·하위 분류와 렌더링 카테고리 일치 트리거로도 제한한다. ERD와 컬럼별 설명·전체 DDL은 [DB 설계 문서](../../../../docs/database-design.md)에 있으므로 여기에는 복사하지 않는다.

[0004_catalog_seed.sql](../../../../migrations/d1/0004_catalog_seed.sql)은 고정 ID와 `ON CONFLICT DO NOTHING`으로 기본 데이터를 추가한다. 과거 문자열은 정확히 일치하는 값만 연결하며 기존 payload나 관리자가 바꾼 기준 데이터를 덮어쓰지 않는다.

관련 변경 시 테이블 역할·관계·스키마 원본 링크를 갱신한다. 컬럼·제약·ERD의 상세 변경은 DB 설계 문서에 반영한다.

## 권한·공개 범위·참조 보존

- [인증 코드](../../../../src/lib/auth/d1.ts)는 Google 로그인과 서버 세션을 사용한다. 사용자 ID는 검증된 세션에서 얻고 관리자 여부는 `admin_roles`에서 조회한다. 비밀번호 가입·임의 계정 연결·자동 관리자 승격 경로는 없다. 관리자 지정 SQL은 DB 설계 문서를 따른다.
- [프로젝트 처리](../../../../src/lib/d1/projects.ts)는 관리자도 `id + owner_id`로 본인 자료만 조회·변경한다. 관리자의 추가 권한은 공용 자재·기준 데이터 관리다. [자재 처리](../../../../src/lib/d1/materials.ts)의 일반 회원 프로젝트용 생성 경로는 `scope=personal`, `purpose=project`로 제한한다.
- [공개 카탈로그](../../../../src/lib/catalog/public.ts)는 현재 버전 중 `scope=shared`, `active=1`, `purpose=catalog`이며 reconstruction payload가 없는 항목만 노출한다. 공개 이미지는 현재 공개 버전에서 직접 표시하는 이미지에 한정하고 `source_asset_id`를 따라 원본을 공개하지 않는다. R2 내부 키·개인 프로젝트·전체 원본 payload를 공개 DTO에 추가하지 않는다.
- [로그인 사용자 자산 접근](../../../../src/lib/d1/database.ts)의 `visibleAssets`는 본인 자산과 공유 자재의 자산에서 원본 참조를 재귀 조회한다. 이 규칙을 비로그인 공개 이미지 접근과 혼동하지 않는다.
- 자재 수정은 새 버전을 만들고 현재 버전 포인터를 바꾼다. 프로젝트가 참조하는 과거 버전과 자산을 보존한다. 비활성화가 기존 프로젝트 참조 삭제나 자재 버전 일괄 삭제로 이어지지 않게 한다.

관련 변경 시 세션·역할 검증, 관리자 범위, 공개 조건, 프로젝트 전용 생성 제한, 과거 참조 보존 규칙을 코드와 함께 갱신한다.

## 저장·정리 계약

[프로젝트 저장](../../../../src/lib/d1/projects.ts)은 `storage_revision`으로 동시 수정 충돌을 검사한다. R2 업로드 전 참조를 확인하고, 커밋하는 D1 batch 안에서 소유권·revision·자산/버전 참조를 다시 검사한다. [database.ts](../../../../src/lib/d1/database.ts)의 `d1_checks` CHECK 실패는 batch를 중단하며, `d1_mutations`는 사용자·재시도 키·리소스·요청 해시가 맞을 때만 기존 결과를 재사용한다.

R2와 D1은 하나의 트랜잭션이 아니다. `stageObject`는 업로드 전에 정리 작업을 기록하고, D1 커밋 성공 시 해당 기록을 제거한다. [cleanup.ts](../../../../src/lib/d1/cleanup.ts)는 소유자별로 제한된 작업을 수행하며 프로젝트·자재 버전·파생 자산이 참조하는 자산을 보존한다. 현재 유예 기간은 [http.ts](../../../../src/lib/d1/http.ts)의 24시간이며 정리 작업은 lease·재시도를 사용한다. 저장 후 유지관리 실패로 이미 성공한 저장을 실패 처리하지 않는다.

관련 변경 시 충돌·재시도 조건, 객체 업로드와 커밋 순서, 참조 보호·정리 유예·실패 처리를 갱신한다.

## 마이그레이션과 검증

1. 실행용 SQL은 `migrations/d1`에 새 번호로 추가한다. 이미 적용된 migration을 고치거나 운영 테이블을 삭제·재생성해서 맞추지 않는다. `0003` 전체는 이력 관리 없이 재실행할 SQL이 아니다.
2. D1 바인딩과 `migrations_dir`가 있는 대상 설정을 확인한다. 현재 원격 `sjn`에는 `0001`~`0004`가 적용됐다. 이후에는 대상 DB와 미적용 목록을 확인하며, 로컬 DB의 적용 상태를 원격 결과로 대신하지 않는다. 로컬 검증은 `--local`과 별도 `--persist-to` 경로로 기존 개발 DB를 유지하며 수행한다.
3. 빈 DB 전체 적용과 기존 스키마 업그레이드를 구분해 확인한다. `PRAGMA foreign_key_check`, 기존 개인 자료·불변 버전·이름 스냅샷 보존, 공개 범위와 타 사용자 접근 차단을 확인한다.
4. 관련 코드 변경은 `npx vitest run tests/d1-catalog.test.ts tests/d1-storage.test.ts tests/d1-auth.test.ts`와 변경 범위에 맞는 타입·브라우저 검증으로 확인한다. [준비 상태 검사](../../../../src/lib/d1/database.ts)와 [인증 스키마 검사](../../../../src/lib/auth/d1.ts)는 읽기 전용이며 요청 중 테이블을 자동 생성하지 않는다.

설정·로컬 및 원격 적용 명령·Google 연결·관리자 지정의 상세 절차는 [DB 설계 문서](../../../../docs/database-design.md)와 [Cloudflare 저장소 설정](../../../../docs/cloudflare-storage-setup.md)을 따른다. 코드·문서 수정, 로컬 검증, 운영 migration·권한 부여·배포는 별도 행위이며 문서 갱신 자체를 운영 작업 권한으로 해석하지 않는다. 비밀값은 이 문서에 기록하지 않는다.

관련 변경 시 migration 순서·검증 명령·준비 상태 조건과 상세 절차 링크를 갱신한다. 검증 결과는 실행 범위와 한계를 함께 기록하며 운영 성공을 추정하지 않는다.
