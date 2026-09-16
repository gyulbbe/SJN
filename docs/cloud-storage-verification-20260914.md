# D1·R2·Google 로그인 구현 검증 — 2026-09-14

## 구현 범위

기존 변경사항과 로컬 데이터베이스를 유지한 채 D1/R2 저장 어댑터와 Google 로그인 경로를 추가했다. 기존 사진 재구성·제품 AI 모델·렌더러를 교체하지 않았다. 계정 생성, 실제 Google OAuth 설정, 원격 SQL·R2 업로드·배포·유료 플랜 전환은 수행하지 않았다.

- 기본 개발 명령은 APP_ENV=local을 강제한다. 배포 Workers에서 명시된 운영 환경·바인딩·auth 설정·읽기 준비 검사가 모두 통과한 경우 D1을 선택한다.
- 초기 준비 실패에는 이유를 표시하고 로컬로 시작한다. 늦은 응답으로 사용 중인 저장소를 바꾸지 않는다. 정상 클라우드 작업 중의 오류는 복구·재시도로 처리한다.
- Better Auth 1.7.4의 Google OAuth, PKCE/state, 세션 쿠키, 서버 관리자 역할을 사용한다. 정상 자료 요청의 인증·관리자 검사에는 실제 D1 SELECT 2회가 사용된다.
- D1에는 요약·버전·참조, R2에는 프로젝트 스냅샷과 이미지/메시를 보관한다. 프로젝트 JSON은 최대 20MB, 자재 버전 JSON은 최대 512KB로 제한한다.
- 로컬 자동 저장 500ms는 유지한다. 클라우드 복구본은 별도 IndexedDB에 500ms, 서버 저장은 2초 지연/연속 작업 최대 15초 간격으로 처리한다.
- 클라우드 자료와 캐시는 origin/backend/userId로 구분한다. 계정 변경을 감지하면 이전 계정 복구본을 확정한 뒤 캔버스와 편집 상태를 비운다. 복구 저장이 실패하면 화면을 잠그고 기존 메모리를 보존한다.
- 요청에는 서버에서 인증한 계정과 대조할 기대 사용자 ID를 넣는다. 이 헤더로 인증하지 않는다. 계정 변경 뒤 도착한 이전 화면의 요청도 차단하며, 저장소 초기화 전 늦은 작업이 로컬로 우회하지 못한다.
- 서버 revision 조건과 재시도 ID를 검사한다. 응답 유실 뒤 재시도는 같은 작업을 재사용하며 성공한 별도 작업은 구분한다. 자재 활성화 true → false → true와 중간 응답 유실도 검증했다.
- 로컬/클라우드 전환·로그아웃은 현재 편집을 확정한 뒤 진행한다. 서버 저장 실패 시 재시도, 서버본으로 복귀, 충돌 작업을 별도 프로젝트로 복원하는 경로를 제공한다.

## 주요 변경 위치

| 역할                          | 파일                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 초기 저장소 선택·이유·timeout | src/lib/storage/config.ts, bootstrap.ts, server.ts; src/app/api/storage/                                          |
| Workers 환경 바인딩           | src/lib/platform/runtime.ts, build/cloudflare-local.ts                                                            |
| 로그인·권한                   | src/lib/auth/d1.ts; src/app/api/auth/                                                                             |
| D1/R2 API·검증·참조·정리      | src/lib/d1/; src/app/api/d1/                                                                                      |
| 저장소와 계정 경계            | src/lib/repositories/index.ts, cloud.ts, contracts.ts                                                             |
| 화면·로그인·로컬 전환         | src/components/app-provider.tsx, project-home.tsx, materials/shared-access.ts                                     |
| 지연 저장·복구·충돌           | src/components/editor/editor.tsx; src/lib/storage/recovery.ts, save-scheduler.ts, cloud-asset-cache.ts            |
| 스키마                        | migrations/d1/0001_auth.sql, 0002_storage.sql                                                                     |
| 설정·실행                     | .env.example, .dev.vars.example, wrangler.jsonc, wrangler.d1.example.jsonc, scripts/dev-local.mjs, vite.config.ts |
| 기존 Supabase 호환            | src/lib/supabase/client.ts, server.ts; Node 전용 runtime session 경로                                             |
| 설정 안내                     | [cloudflare-storage-setup.md](cloudflare-storage-setup.md), [cloudflare-deployment.md](cloudflare-deployment.md)  |

## 실제 검증

Windows, Node 22.13.1, AMD Ryzen 7 7800X3D에서 실행했다. 브라우저는 Playwright 1.63.0 Chromium이며 WebGL 회귀는 SwiftShader를 사용했다. Miniflare 5.20260911.0-alpha, Wrangler 4.131.1을 잠금 파일에 고정했다.

| 검사                                         | 결과                                                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 전체 Vitest                                  | 125개 파일 · 1,536/1,536 통과, 29.68초                                                                    |
| Better Auth + 실제 Miniflare D1/R2 readiness | 25/25 통과. Google 응답은 로컬에서 서명한 제공자 fixture이며 실제 Google 로그인이 아님                    |
| D1/R2 저장·파일 형식·route 경계              | 26/26 통과. 저장/자재/참조/충돌/실패는 실제 로컬 Worker 데이터베이스·버킷; route actor 경계는 명시적 mock |
| 초기화·로그인 화면 Chrome                    | 7/7 통과, 15.7초. 설정·세션·목록 API fixture로 제어 흐름 검증                                             |
| 클라우드 복구 Chrome                         | 7/7 통과, 35.6초. 500ms 복구/2초 저장, 503/401, 새로고침·충돌·계정 변경·빠른 뒤로가기 검증                |
| 기존 편집 Chrome                             | 15개 통과, 실제 사용자 저장 fixture를 요구하는 1개 건너뜀                                                 |
| Cloudflare 배포 번들 Chrome                  | 4/4 통과, 20.7초. 실제 사진 분석 포함                                                                     |
| lint                                         | 오류 0 · 경고 0                                                                                           |
| Next.js build / typecheck                    | 둘 다 통과                                                                                                |
| vinext build                                 | 통과                                                                                                      |
| Wrangler deploy --dry-run                    | 통과. 실제 배포 없음. 전체 4404.39KiB, gzip 1141.23KiB                                                    |

Chrome 회귀의 첫 동시 실행에서 두 테스트가 결과 디렉터리를 서로 정리하면서 trace 파일 ENOENT를 냈다. 두 테스트의 기능 검사는 통과한 상태였으며, 출력 디렉터리를 분리한 재실행에서 2/2 통과(21.0초)를 확인했다. 이 문제를 앱 저장 실패로 분류하지 않았다.

전체 Vitest 로그의 거부된 OAuth state, 잘못된 callback, 변조 쿠키 오류는 실패 시나리오의 예상 로그다. 공개 서비스 인증 성공으로 보고하지 않는다.

클라우드 화면 fixture에서 로컬 자산 marker가 보존되고 자동 업로드가 없음을 검증했다. Cloudflare 로컬 모드 브라우저 테스트에는 배포 번들의 실제 사진 분석과 벽 타일 저장도 포함한다. Google 제공자·네트워크 오류를 사용하는 UI fixture 테스트와 구분한다.

### 재실행 명령

```powershell
npm test
npm run lint
npm run build
npm run typecheck
npm run build:vinext
npx wrangler deploy --dry-run --config dist/server/wrangler.json --outdir test-results/storage-worker-dryrun
npx playwright test e2e/storage-bootstrap.spec.ts --output=test-results/storage-bootstrap-e2e
npx playwright test e2e/cloud-recovery.spec.ts --output=test-results/cloud-recovery-final
npx playwright test e2e/base-room.spec.ts e2e/material-usage.spec.ts e2e/room-viewer.spec.ts --output=test-results/storage-editor-regression
npm run test:cloudflare
```

로그와 스크린샷은 Git에서 제외된 test-results/에 보관한다. 주요 로그는 storage-unit-tests-final.log, storage-next-build-final.log, storage-typecheck-final.log, storage-lint-final.log, storage-vinext-build-final.log, storage-worker-dryrun.log, storage-cloudflare-e2e-final.log다. UI 비교 이미지는 storage-bootstrap-e2e/, cloud-recovery-final/에 있다.

## 비용과 정리 한계

D1 Free는 호출당 쿼리 50개 제한이 있다. 정상 인증 2 SELECT를 포함할 여유를 두고 저장+유지관리의 실제 D1 쿼리 수를 검사했다. 유지관리는 사용자별 15초 lease와 객체 최대 3개, 명시적 미참조 자산 정리는 후보 최대 4개로 제한했다. 유지관리 예약·정리 실패로 이미 성공한 저장을 실패로 바꾸지 않는다.

R2의 이전 프로젝트 스냅샷은 24시간 재시도 유예와 참조 검사 후 정리한다. 사진뿐 아니라 이 스냅샷도 용량에 포함된다. 계속되는 입력은 최대 15초마다 저장하지만, 간헐적 편집과 2초 대기 반복은 더 많은 스냅샷을 만들 수 있다. 종료한 사용자의 정리를 실행할 별도 Cron은 추가하지 않았으며, 다음 쓰기/정리 요청 전까지 남을 수 있다. 보관할 자료나 불변 자재 버전을 임의로 삭제해서 용량을 맞추지 않는다.

무료 CPU 한도와 원격 실행 메모리는 로컬 wall-clock 처리 시간으로 판단할 수 없다. 특히 큰 JSON·메시 검증과 Google 로그인은 실제 Workers CPU 측정이 필요하다. R2 무료 범위 초과를 차단하는 결제 상한은 구현하지 않았다. [설정 가이드의 비용 안내](cloudflare-storage-setup.md#저장실패비용-동작)와 공식 요금표를 확인해야 한다.

## 아직 확인하지 않은 항목

- 실제 Google Console 클라이언트, 동의 화면, 운영 도메인 callback과 세션 갱신.
- 실제 배포 D1/R2 자격 증명·원격 migration·두 실제 사용자 계정의 격리.
- Workers Free 10ms CPU, 동시 접속 부하, R2 월별 저장/요청 사용량.
- 기존 Supabase 실서버 로그인·저장 회귀. 어댑터는 Node/Next용으로 보존했으며 Cloudflare에서는 선택하지 않는다.
- Workers의 이미지 검사는 바이트 컨테이너 구조·형식·용량·치수 검사다. 전체 이미지 픽셀 디코딩을 수행하지 않으며 브라우저 업로드 단계의 디코딩 검사를 함께 사용한다.
- 실제 사용자 저장 fixture가 없는 room-viewer의 해당 케이스는 건너뛰었다. 기본 공간·다중 시안·Before/After·이미지 출력·모바일·WebGL 실패 케이스는 실행했다.
