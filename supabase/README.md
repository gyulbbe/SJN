# Supabase 연결 준비

기본 실행은 IndexedDB 로컬 모드다. 이 코드에 실제 Supabase 프로젝트를 연결하거나 배포하지 않았으며 아래 클라우드 검증은 **미실행**이다.

1. 별도 Supabase 프로젝트에 `migrations/`의 SQL을 파일명 순서대로 적용한다(`202609050001_initial.sql`부터 `202609070003_material_usage.sql`까지). 새 프로젝트 기준이며 기존 정책과 충돌하는 환경은 정책을 검토한다.
2. `.env.example`을 `.env.local`로 복사하고 `NEXT_PUBLIC_STORAGE_MODE=supabase`, URL, publishable key, 서버 전용 `SUPABASE_SECRET_KEY`를 설정한다. secret key는 브라우저에 전달하지 않는다.
3. Authentication에서 이메일/비밀번호 로그인을 사용한다. 이메일 확인을 켜면 확인 후 로그인한다. 관리자 권한은 운영자가 SQL로 `admin_roles(user_id)`에 넣는다. 사용자 입력 메타데이터를 관리자 판정에 쓰지 않는다.
4. 개발 서버를 다시 시작하고 로그인한다. 로컬 프로젝트/자재는 자동으로 서버에 업로드되지 않는다.

## 구현 인터페이스

- `src/lib/repositories/index.ts`의 `getRepositories()`는 동기적으로 `Repositories`를 반환하고, CRUD는 Promise다. 모드는 빌드 환경변수로 명시하며 잘못된 설정 시 실패한다.
- `src/lib/supabase/client.ts`의 `createBrowserSupabase()`는 `@supabase/ssr` 브라우저 클라이언트를 반환한다. `auth.signInWithPassword`, `auth.signUp`, `auth.signOut`, `auth.getUser`를 UI에서 사용한다. 쿠키는 각 API 요청의 서버 auth.getUser로 검증·갱신한다.
- `/api/cloud/projects`와 `/api/cloud/materials`는 JSON POST `operation`을 받는다. 저장소 계약의 CRUD 메서드와 매칭하며 `create/save`는 문서, `update`는 input과 expectedVersionId, 프로젝트 `save`는 expectedStorageRevision을 받는다.
- `/api/cloud/assets` POST는 multipart `file` + JSON `metadata`를 받는다. 서버가 25MB/40MP, 실제 JPG·PNG·WebP 형식과 전체 픽셀 디코딩을 검증하고 소유자·형식·크기를 다시 정한다. 원본 바이트는 유지한다. GET `?id=UUID`는 접근 허용된 자산 메타데이터와 120초 서명 URL을 반환한다.
- `/api/cloud/cleanup` POST `{ "operation": "run" }`은 현재 사용자의 도달 불가능 자산과 실패한 업로드를 정리한다. 최소 24시간 유예, DB 참조 검사, 삭제 상태, 작업 claim, 지수 백오프를 사용한다. 별도 예약 작업은 이번에 만들지 않았다. 재실행은 실패한 삭제를 다시 시도하고, 비활성화 자재를 포함한 모든 불변 버전은 보존한다.
- `/api/cloud/role` GET은 인증 사용자의 서버 검증 관리자 상태 `{ "isAdmin": boolean }`을 반환한다. UI 표시용이며 실제 공용 자재 변경은 DB 함수에서 권한을 다시 검증한다.

## 저장 경계와 복구

클라이언트에는 테이블 SELECT만 허용한다. 프로젝트/자재 쓰기 RPC는 service_role만 호출할 수 있고 route가 현재 인증 사용자 ID를 직접 전달한다. 개인 데이터는 소유자에게만, 공용 자재와 연결된 이미지는 로그인 사용자에게 읽기를 허용한다. Storage 업로드·수정·삭제는 사용자 토큰으로 허용하지 않으므로 이미지 검증을 우회할 수 없다.

업로드 전에 정리 작업을 기록하고 업로드 성공 뒤 자산을 등록한다. 등록 트랜잭션은 소유권·원본 참조·실제 Storage 객체를 확인하고 정리 작업을 제거한다. 문서 저장은 DB 함수 안에서 예상 revision 확인, 참조 검사, 문서·자산·자재 버전 참조 변경을 한 번에 수행한다. 현재 장면뿐 아니라 실행 취소/다시 실행 장면도 참조 대상이다. 삭제는 먼저 참조를 제거하며, 재시도 가능한 작업이 실제 파일 삭제를 마무리한다.

## 연결 후 수행할 검증 — 아직 미실행

- `tests/security.sql` 권한/RLS 점검을 테스트 DB에서 실행한다.
- 서로 다른 사용자 A/B로 개인 프로젝트 목록·ID 직접 조회·이미지 서명 URL·개인 자재 접근이 격리되는지 확인한다 (요구사항 L).
- 일반 사용자 공용 자재 수정/관리자 역할 변경, 사용자 토큰 직접 Storage 업로드, service 전용 RPC 호출을 모두 거부하는지 확인한다.
- 관리자가 공용 자재를 생성하고 A/B가 읽거나 개인 자재로 복제할 수 있는지 확인한다.
- 두 탭의 동일 revision 저장은 한 개만 성공(409), 이전 자재 버전은 재진입 때 유지되는지 확인한다.
- 25MB 초과, 40MP 초과, 위장 파일, 손상/다중 프레임 이미지, 타 사용자 sourceAssetId 업로드를 거부하는지 확인한다.
- 업로드 뒤 DB 실패, 삭제 네트워크 실패, 작업 중단 후 정리 재시도, clone·history·sourceAssetId가 공유하는 파일 보존을 확인한다.
- secret key가 클라이언트 JS에 포함되지 않고, 쿠키 세션 만료 후 401이 UI에 표시되는지 확인한다.

공식 참고: [SSR 클라이언트](https://supabase.com/docs/guides/auth/server-side/creating-a-client), [Storage 접근 정책](https://supabase.com/docs/guides/storage/security/access-control).

## 자재 수량·금액 v3 확장

`materialUsage`와 `renderRevision`은 선택적 v3 필드다. API와 로컬 저장은 같은 숫자/판매 단위 스키마를 검증하고, 현재 시안·이력·공통 복원 백업의 가격 출처 버전(`sourceVersionId`)도 보존한다. `202609070003_material_usage.sql`은 버전 참조 탐색과 참조 테이블을 확장하며 기존 사용자 문서를 덮어쓰지 않는다. 실제 마이그레이션 적용·RLS·사용자 격리·Storage 연결 검증은 아직 실행하지 않았다. 기존 견적 UI는 제거했으며 원본 JSON 데이터는 보관한다.
