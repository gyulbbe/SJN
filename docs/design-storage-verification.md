# 다중 시안 저장·장애 복구 검증

현재 시안 생성·복제 한도는 **5개**이며 비교도 **5개**다. 이전 10개 한도에서의 측정·시험 기록은 아래에 보존했다. [5개 한도 변경과 기존 자료 호환](five-design-limit.md) 참고.

검증일: 2026-09-07. 로컬 저장소와 격리된 테스트 브라우저를 사용했다. 실제 사용자의 IndexedDB, 사진, 시안은 열거나 수정하지 않았다.

## 저장 구조와 경계

- 저장 문서는 v3 하나이며 `shared`, `designs`, `activeDesignId`, `comparisonDesignIds`, `roomHistory`로 구성된다. v1/v2는 읽기 시 메모리에서만 변환되고 성공한 조건부 저장 때 v3로 기록된다.
- 시안 최대 10개, 비교 선택 최대 5개, 시안 및 Before 이력 각 방향 최대 50개를 공통 상수로 검증한다. 시안 ID 중복·유효하지 않은 활성/비교 ID, 중첩 복원 백업, 과거·미래 백업 동시 보관을 거절한다.
- 프로젝트 복제는 전체 시안과 이력·복원 백업을 보존하며 시안/면/제품/견적 ID 및 연결 참조를 변환한다. 이미지 본문과 자재 버전은 공유한다.
- GC는 모든 시안·Before·기준 공간·이력·복원 백업·견적 및 이미지 원본 선조의 참조를 확인한다. 일반 자재 버전은 불변으로 보관하고 저장 전 새 자산은 24시간 유예로 보호한다.
- IndexedDB 쓰기는 트랜잭션 완료 뒤 성공을 반환하며 `storageRevision` 조건이 맞지 않으면 저장하지 않는다. 실패한 저장은 이전 문서와 호출자의 현재 메모리 문서를 변경하지 않는다.
- 썸네일 캐시는 별도 로컬 DB를 사용한다. 클라우드 저장 어댑터는 시안 문서 요청만 전송하며 합성 이미지·AI 요청을 추가하지 않는다.

## 실행한 단위 테스트

```powershell
npx vitest run tests/design-storage.test.ts tests/storage.test.ts tests/comparison-storage.test.ts tests/room-storage.test.ts tests/quote-storage.test.ts tests/storage-validation.test.ts
```

6개 파일, 43개 테스트 통과. 담당 파일 ESLint도 통과했다. 핵심 검증은 다음과 같다.

- v1/v2의 읽기 시 비파괴 변환과 CAS 저장, 10개 시안·5개 비교의 재진입
- 11번째 시안·6번째 비교·중복/유실 ID 및 재귀 백업 거절
- 모든 시안·견적·이력·백업의 독립 ID 재발급, 삭제한 원본의 공유 이미지 보존
- 숨은 시안/Undo/백업에서만 쓰는 이미지와 원본 선조의 GC 보호
- 마지막 시안 삭제로 만들어진 0개 상태 저장, 기준 공간 미리보기 반환
- 용량 초과·누락 참조·동시 조건부 저장 실패 시 이전 문서 보존
- 클라우드 저장 요청 한 건만 발생하고 이미지 업로드/AI 요청이 없는지 확인

## 문서 크기 및 참고 처리 시간

Node + `fake-indexeddb`에서 시안 10개, 각 과거 이력 50개(총 500개), 각 장면 기본 4면, 제품 0개, 첫 시안 견적 1개 조건으로 측정했다.

| 항목 | 결과 |
| --- | ---: |
| JSON 문서 크기 | 1,792,681 bytes (약 1.71 MiB) |
| 검증 포함 create 저장 | 99 ms |
| load | 23 ms |
| 재진입 이력 | 500개 모두 보존 |

이 수치는 실제 브라우저 IndexedDB·GPU 성능 지표가 아니다. 복잡한 마스크, 다수 제품, 견적 및 공통 복원 백업은 문서 크기를 늘린다. 서버 요청 본문은 기존 20 MiB 제한을 유지한다. 실제 브라우저 비교 렌더링 측정은 별도 검증 결과를 참고한다.

## 실제 Chrome 장애 복구

Windows / Chrome 152.0.7977.76 headless / Next.js 개발 서버 / 1440×1000 화면에서 Playwright의 격리된 브라우저 컨텍스트로 실행했다. GPU 인자는 프로젝트 설정의 SwiftShader (`--use-angle=swiftshader`, `--enable-unsafe-swiftshader`)를 사용했다.

```powershell
npx playwright test e2e/design-failures.spec.ts --output=test-results/design-failures --reporter=line
```

4개 시나리오 모두 통과(32.5초). 이후 WebGL 시나리오에 비교 카드의 직접 재시도를 추가하고 해당 시나리오를 `--grep WebGL --output=test-results/design-webgl-retry`로 실행해 통과했다.

- 프로젝트 저장에만 지속적인 `QuotaExceededError` 및 `AbortError`를 주입하고 최신 복사 시안·견적을 보존한 뒤 수동 저장으로 재시도
- 같은 격리 컨텍스트의 두 탭에서 읽기 전용 및 첫 탭 종료 후 쓰기 잠금 인계
- 재진입 때 WebGL context 생성을 실패시키고 시안 문서 보존·하드웨어 가속 안내·무한 로딩 방지·정상 재진입 확인. 비교 카드 두 개에서 오류와 다시 시도 버튼을 확인하고, 실패 주입을 해제한 뒤 각각 재시도하여 이미지 복구 및 편집기 복귀도 통과했다.

시안 복사 후 저장이 계속 실패하는 동안 기존 DB 문서는 완전히 동일했고, 화면의 복사본과 수정 중 견적은 유지됐다. 실패 해제 후 “지금 저장”으로 한 번의 조건부 저장이 완료됐으며 새로고침 뒤 복사본 견적까지 복구됐다. 이 과정에서 자산 개수 증가, 클라우드 요청, AI 모델 요청, 처리되지 않은 페이지 오류는 없었다.

두 번째 탭은 시안 생성·복제·이름 변경·삭제·저장이 비활성화되었고, 시안 조회 및 Before/After 전환이 원본 저장 문서를 바꾸지 않았다. 첫 탭 종료 후 두 번째 탭이 편집권을 얻어 세 번째 시안을 저장했다.

주입은 테스트 페이지의 브라우저 API에만 적용했다. 실제 디스크를 채우거나 GPU 설정을 변경하지 않았다. 대표 스크린샷은 `test-results/design-failures` 및 `test-results/design-webgl-retry`에 있고, 각 디렉터리의 `.last-run.json`은 `passed`다.

## 기존 편집 기능 29개 회귀

다중 시안 신규 테스트를 제외한 기존 9개 파일을 실제 Chrome에서 모두 실행했다.

```powershell
npx playwright test e2e/auto-apply.spec.ts e2e/base-room.spec.ts e2e/editor.spec.ts e2e/fixture-tiling.spec.ts e2e/quote.spec.ts e2e/reconstruction.spec.ts e2e/room-dimensions.spec.ts e2e/room-fixtures.spec.ts e2e/simple-editor.spec.ts --output=test-results/design-existing-regression --reporter=line
```

최초 실행은 27개 통과, 2개 실패(6.0분). 실패 2개는 `editor.spec.ts`의 테스트 전용 바닥 ID가 `legacy-floor`여서 새 UUID 저장 검증에 걸린 것이었다. 실제 앱과 동일한 UUID로 수정한 뒤 해당 파일 3개를 `test-results/design-existing-editor-retry`에서 다시 실행하여 모두 통과했다(25.8초). 두 실행을 합쳐 기존 29개 시나리오의 통과를 확인했다. 최초 실패 기록을 지우거나 통과로 바꾸지 않았다.

추가한 회귀 기대값 변경은 다음 정책에 한정했다.

- 저장된 장면·견적·이력을 활성 시안에서 조회하고 v3를 확인한다.
- 실행 취소 프레임의 `scene`을 비교하며, 견적 변경은 해당 시안의 독립 이력에 추가되는 것을 확인한다.
- 공간 치수는 일반 실행 취소 대신 공간 설정의 전체 복원·전체 다시 실행으로 검증한다.
- 프로젝트 복제는 새 엔티티 ID를 제외한 모든 합성 구성이 동일하고, 견적 면 참조가 새 ID로 연결되는지 확인한다.

자동감지·모델 실패 재시도·분석 취소, 기본 공간·모바일, 타일과 제품 이동 잔상, 잠금·방향·삭제, 견적·PDF·용량 실패·읽기 전용, 실제 사진 재구성 Before와 재분석, 공통 치수·수동 영역 보존, 기본 네 면 삭제 방지, 4096px 내보내기 및 재진입을 확인했다. 앱 코드를 고쳐야 하는 기능 회귀는 발견하지 않았다. 기존 E2E 9개 파일 ESLint 경고 0개, 타입 검사 오류 0개다.

전체 로그: `test-results/design-existing-regression.log`, 수정 파일 재실행 로그: `test-results/design-existing-editor-retry.log`.

## 서버 미실행 항목

`supabase/migrations/202609070001_design_workspaces.sql`은 v3 한도 검사와 모든 시안·이력·백업의 재귀 자산/자재 참조 인덱스를 준비한다. 기존 소유권·RLS·비공개 Storage 정책과 조건부 저장 RPC를 유지한다.

실제 Supabase 계정 연결, SQL 적용, 사용자 간 격리(L), Storage 업로드·삭제 재시도는 이번 로컬 검증에서 실행하지 않았다. 스키마·어댑터 테스트를 서버 사용자 격리 검증 통과로 간주하지 않는다.
