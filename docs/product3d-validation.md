# 360° 제품 편집 검증 기록

검증일: 2026-09-12. 테스트는 사용자 브라우저 프로필과 자료를 읽지 않는 별도 Chrome 자동화 컨텍스트에서 실행했다.

## 자재 이미지 등록 간소화

대표/상품 소개 이미지 설정을 제거하고 제품 사진·타일 텍스처만으로 등록하도록 브라우저 회귀를 갱신했다. 아래 대표 지정 관련 내용은 제거 전 단계의 검증 이력이며 현재 UI에는 대표 설정이 없다.

- `npx playwright test --config playwright.product3d.config.ts`: **14개 통과 / 실제 AI opt-in 1개 건너뜀**, 44.3초. 이번 변경에서는 AI 추론 코드를 바꾸지 않았고 새 실추론을 반복하지 않았다.
- `e2e/material-images.spec.ts` 3개: 실제 PNG를 올려 **정면 우선 / 정면 없을 때 첫 사진 / 첫 타일 텍스처**를 목록·상세·편집 목록·사용 내역 네 화면에서 픽셀로 확인했다. 제품 사진 또는 텍스처만으로 등록되며 기존 대표·상품 소개 설정이 없는 것을 검사했다.
- 두 번째 사진이 정면이면 새 제품 배치의 `viewIndex`가 1로 시작했다. 이후 사용자가 첫 사진(index 0)으로 바꾼 배치는 새로고침해도 0을 유지했다. 사용 내역의 상품 썸네일은 정면 우선 표시를 유지한다.
- 상시 표시되는 빠른 이름 선택, 임의 각도 이름 입력, 360° 새 각도 이름/이름 변경의 동일 입력 규칙을 검사했다. 이름 선택은 제품 자세를 바꾸지 않는다.
- 같은 실제 메시를 사용하는 여러 각도 추가·개별 수정·삭제·저장 재진입, PNG, 오류·취소·모바일·기존 공간의 개수/단가/위치 보존 회귀가 통과했다. Worker 응답을 제어한 메시 재생 테스트이며 새 AI 결과로 계산하지 않는다.
- `background-removal-apply.spec.ts` 3개, `editor.spec.ts` 4개, `material-usage-inputs.spec.ts` 1개, `material-usage.spec.ts` 5개를 실행해 **13개 모두 최종 통과**했다. 12개가 최초 실행(1.7분)에 통과했고, 출력 테스트의 Windows `saveAs` 파일 복사 권한 오류를 실제 다운로드 스트림 읽기로 바꾼 뒤 해당 1개도 통과했다(12.7초). PNG를 실제 내려받아 패널/도구 없는 렌더와 평균 색상 차이 2 미만 조건을 확인했다. 앱 렌더나 저장 로직은 변경하지 않았다.
- 전체 단위 테스트 **505개 / 53개 파일** 통과(주 작업에서 실행). 최종 `npm run lint`와 `npm run typecheck` 통과. `npm run build`(Next.js 16.3.4)와 `npm run build:vinext` 모두 통과했고 vinext 빌드 후 Next 라우트 타입을 다시 생성해 검사했다. vinext에서 기존 punycode·experimental glob·향후 Vite config loader·plugin timing 안내가 있었고 빌드 오류는 없었다. 개발 서버 `/materials` HTTP 200을 확인했다.
- 스크린샷: `test-results/material-images-validation/`의 `product-images-form.png`, `tile-texture-form.png`, `material-card.png`, `material-detail.png`, `material-usage.png`. 제품 등록 화면의 두 사진·입력/빠른 선택, 대표 설정이 없는 레이아웃을 직접 확인했다.

변경된 브라우저 테스트는 기존 대표 업로드 단계를 제거하고 제품/텍스처 업로드만 수행한다. `tests/reconstruction-browser.ts`의 검증용 렌더 코드도 공통 표시 이미지 선택기를 사용한다. 외부 서버 업로드·Supabase 실연결·Cloudflare 배포와 무거운 AI 전체 추론 회귀는 이번 변경에서 실행하지 않았다.

## 여러 각도 저장 검증

`npx playwright test --config playwright.product3d.config.ts` 전체 **11개 통과 / 실제 AI opt-in 1개 건너뜀**, 38.0초. 기존 배경 제거 적용 회귀도 **3개 통과**, 16.7초. 아래 기본 360° 편집 검증을 새 **이 각도 추가 / 선택한 각도 수정** 흐름에 맞춰 함께 회귀했다. 프로덕션 AI 추론은 변경하지 않아 이번 여러 각도 추가 작업에서는 새 실추론을 반복하지 않았다.

- 같은 실제 메시를 한 번 받아 **3개 각도**를 추가했고 창이 계속 열려 있는지 확인했다. 3개 모두 **같은 메시 ID·입력 이미지 ID**, 서로 다른 PNG 자산 ID·바이트 해시·자세를 저장했다.
- 선택한 한 각도만 수정하고 나머지 두 자세가 유지됨을 확인했다. 이름 변경, 원본 사진 항목 삭제, 다른 각도를 대표 이미지로 지정하는 동작을 확인했다.
- 추가·수정하지 않은 마지막 드래그를 닫기로 버린 뒤 자재 저장·새로고침·재진입에서 저장한 자세만 복원했다. Worker·모델 재요청 없이 썸네일 선택으로 자세를 전환했다.
- 원래 자재 버전은 불변으로 보존되며 각도 편집 창을 닫는 것과 자재 폼의 최종 저장/취소를 구분했다.
- 공간의 각도 썸네일 변경에서 동일 제품 ID·자재 버전·위치·배치 개수 1개와 **350,000원** 단가/합계가 유지됐다. 기존 촬영 방향 드롭다운이 제거된 것도 확인했다.
- 각도 목록은 입체 뷰어 아래에 표시한다. 레이아웃 재배치 후 다중 각도·모바일·공간 선택 대상 **3개 추가 재검사 통과**, 21.0초.

### 여러 각도 저장 최종 통합 검사

- 단위 테스트 492개 / 52개 파일 통과. 여러 각도의 메시·입력 공유, PNG/자세 독립성, 삭제 후 불변 버전·공유 자산 보존, 100장 제한과 이름 검증 포함.
- Inspector의 사진 기반 오류/지연/잠금/읽기 전용 회귀와 기본 공간의 위치·배율·규격·undo/redo 보존 2개 통과(23.2초 / 18.0초).
- `npm run build`, `npm run build:vinext` 모두 통과. vinext 이후 `npm run typecheck`, `npm run lint` 재검사도 통과. 기존 의존성 빌드 안내 외 오류 없음.
- 최종 갤러리 화면 캡처를 포함한 다중 각도 테스트 1개 재확인 통과(7.7초), `multiple-angles-gallery.png` 확인.
- 개발 서버 `/materials` HTTP 200. 새 모델·외부 업로드·배포 변경 없음.

## 360° 편집 기본 검증 결과

| 검증                                                          | 결과                                                                                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `npx playwright test --config playwright.product3d.config.ts` | **8개 통과, 1개 opt-in 건너뜀**, 28.4초                                                                                      |
| 저장 자세 초기 WebGL 실패 → 뷰어 재시도 추가 테스트           | **1개 통과**, 8.0초. 저장한 카메라·제품 회전·확대 유지, 새 Worker 0회                                                        |
| `SJN_PRODUCT3D_REAL=1`로 실제 AI opt-in만 실행                | **1개 통과**, 22.8초                                                                                                         |
| 회전·기울기·상하 뒤집기                                       | 카메라와 제품 quaternion 분리, 위/아래 손잡이 같은 회전 방향, pole-crossing, 키보드 1° 조작 통과                             |
| 작업 단위 실행 취소                                           | 20번의 pointer move를 포함한 한 번의 드래그가 undo 한 번으로 복원됨                                                          |
| 사진 적용·저장                                                | 선택한 한 장만 교체, 방향·순서 유지, 대표 이미지 조건부 변경, 이전 불변 버전 보존 통과                                       |
| 저장 후 재진입                                                | 동일 자세 복원, 새 AI Worker와 ONNX 요청 0회, 저장 메시 반복 개폐 4회 후 생성된 WebGL 컨텍스트 전부 반환                     |
| PNG                                                           | 실제 다운로드 파일 1024×1024, 투명 픽셀·불투명 제품 확인, 바깥 3px 제품 침범 0                                               |
| PNG의 UI·확대 제외                                            | 선택 손잡이 표시/3.8배 확대/체크무늬 조건과 선택 해제/화면 맞춤/검정 배경 조건의 PNG가 **바이트까지 동일**                   |
| 오류 처리                                                     | 저장 용량 오류 시 원본·결과 보존과 재시도, 추론 오류·취소 후 늦은 응답 폐기, 메시 유실 시 자동 AI 금지, WebGL 실패 안내 통과 |
| 모바일                                                        | 390×844, 가로 넘침 없음, CDP 터치 드래그·두 손가락 핀치 및 키보드 손잡이 통과                                                |

저장소 전체 단위 테스트 **492개 / 52개 파일**과 `npx tsc --noEmit`, ESLint 오류·경고 0개를 확인했다. Next/vinext 빌드 결과는 전체 구현 인계에서 별도로 기록한다.

## 실제 AI와 재생 테스트 구분

실제 메시를 사용하는 UI 테스트는 이전 실제 TripoSR 변기 메시(`test-results/front-alignment-toilet/photograph`)의 **55,956개 정점·111,912개 삼각형**을 사용한다. Worker 응답은 제어하며 Three.js 렌더링·PNG·IndexedDB는 실제로 실행한다. 메시 재생 테스트를 새 AI 추론의 성공 증거로 계산하지 않는다.

별도 opt-in은 **프로덕션 Product3dClient → 실제 Product3d Worker → encoder/backbone/decoder → 실제 뷰어**를 실행했다. Worker 응답이나 모델 결과는 모의 응답으로 대체하지 않았다. 모델은 고정 revision의 로컬 파일 3개를 HTTP로 스트리밍했으며 파일 합계는 839,952,130 bytes다. 다운로드 숫자는 인터넷 속도 측정값이 아니다.

- 모델: `dcharlot65-aurasense/triposr-onnx-web`, `e23007c3ce90bb968eae014c0168981871fe2d0d`.
- 백엔드: WebGPU. 실제 생성 Worker 1회, 55,956개 정점·111,912개 삼각형.
- 로컬 파일 전송: 2.147초. 모델 초기화: 4.004초. 실제 추론·메시 구성: **8.630초**.
- 이 격리 테스트 컨텍스트에서는 Cache Storage에 모델을 보관하지 못했다는 안내가 표시됐고 생성은 계속 성공했다. 이번 실행만으로 인터넷 다운로드나 영구 모델 캐시의 성공을 주장하지 않는다. 저장된 제품 메시를 재개할 때 모델을 사용하지 않는 동작은 별도 UI 테스트에서 확인했다.
- 생성 후 회전·기울기·PNG를 다시 실행해도 추가 Worker와 모델 파일 요청이 없었다.
- 실제 AI PNG: 불투명 픽셀 314,936개, 완전 투명 픽셀 731,443개, 바깥 3px 제품 침범 0.

사진은 [White toilet.JPG](https://commons.wikimedia.org/wiki/File:White_toilet.JPG), Doug Coldwell, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)에서 받은 기존 QA 사진과 그 배경 제거 결과다. 앱 기본 자재로 추가하지 않았다. 자세한 원본 출처는 [배경 제거 검증 문서](./ai-background-removal.md)에 있다.

## 조작 성능

최종 브라우저 실행에서 8회 연속 드래그하며 **해당 뷰어 캔버스의 실제 WebGL `drawElements` 호출**을 세었다. 다른 캔버스는 제외했다. 독립 `requestAnimationFrame` 간격도 별도로 기록해 렌더 횟수와 구분했다.

- Windows, Headless Chrome 152, NVIDIA RTX 4070 Ti / ANGLE Direct3D11, 논리 CPU 16개.
- 화면 1440×1100, DPR 1, 실제 메시 55,956개 정점·111,912개 삼각형, 모델 추론 종료 후 측정.
- 실제 렌더 170회, **111.1fps**. 같은 구간의 UI RAF 116.1fps, 평균 간격 8.61ms, 33.34ms 초과 0회.
- 이 하드웨어에서 30fps 목표를 통과했다. 짧은 자동화 드래그 구간이며 저사양 PC·실제 모바일·장시간 메모리 사용에 대한 결과로 일반화하지 않는다.

## 발견해 수정한 사항

React StrictMode의 effect 재실행 때 같은 canvas의 WebGL 컨텍스트를 파기한 직후 재사용하면 미리보기가 실패했다. effect마다 새 canvas를 만들고 해제하도록 수정했으며, 저장 메시 반복 재진입과 컨텍스트 반환 검사로 회귀를 확인했다.

Windows Chrome이 저장소 아래 Playwright 임시 다운로드 경로에 쓸 때 빈 파일/EPERM이 발생했다. OS 임시 다운로드 폴더로 분리한 후 실제 PNG 다운로드 바이트를 읽는 검증을 통과했다. 앱의 PNG 생성 결과로 오인하지 않았다.

## 산출물과 확인하지 않은 범위

`test-results/product3d-validation/`에 `interaction.json`, `performance.json`, `real-inference.json`, 원본 각도/변경 각도의 PNG와 화면, 모바일 화면을 남겼다. 테스트 결과물과 내려받은 모델은 Git에 포함하지 않는다.

- Supabase 실제 업로드·사용자 격리·Storage 정책 적용, Cloudflare 배포는 실행하지 않았다.
- 새 버전의 CPU 실추론과 저사양 PC·실제 모바일 GPU의 추론/조작 성능은 실행하지 않았다.
- 사용자 첨부 세면대의 원본 투명 PNG가 없어 해당 제품의 정확한 결과를 직접 검증하지 않았다.
- 입력에 남은 쓰레기통·휴지걸이 등 주변 물체도 함께 입체화되는 것을 확인했다. 이를 자동으로 제품과 분리하지 않는다.
- 한 장에서 보이지 않는 뒷면·구멍의 내부·얇은 부품과 실제 치수의 일치는 보장되지 않는다. 회전 기능 개선을 형상 복원 품질 개선으로 보고하지 않는다.

## 360° 초기 구현 당시 저장소 검사

- `npm test`: 52개 파일, **488개 단위 테스트 통과**. 메시 코덱·참조/정리·자세·캐시·소스 추적·적용 실패 재시도와 기존 편집/자재 계산 회귀 포함.
- 기존 브라우저 회귀: `simple-editor.spec.ts`, `room-fixtures.spec.ts`, `background-removal-apply.spec.ts`, `background-removal.spec.ts`의 일반 UI **6개 통과**. BiRefNet 실제 추론 opt-in 1개는 이 작업에서 재실행하지 않았다.
- 공간 출력 회귀는 Windows의 다운로드 파일 권한 복사 문제를 발견해, OS 임시 폴더와 실제 다운로드 스트림 검증으로 수정 후 통과했다. 출력은 4096×2731px 확인.
- `npm run lint`와 `npx tsc --noEmit` 통과. 최종 빌드 결과는 아래 기록.

- `npm run build`: Next.js 16.3.4 Turbopack 프로덕션 빌드 통과.
- `npm run build:vinext`: Vite/vinext의 client·worker·RSC·SSR 빌드 및 3개 경로 사전 렌더 통과. 기존 의존성의 punycode deprecation, 향후 Vite native config loader의 확장자 안내와 plugin timing 안내가 출력됐으며 빌드 오류는 없었다.
- vinext 빌드 후 `npm run typecheck`로 Next 라우트 타입을 다시 생성하고 타입 검사 통과.
- 로컬 개발 서버 `/materials` HTTP 200 확인. 외부 배포는 하지 않았다.

## 주요 변경 파일

- `src/components/materials/material-form.tsx`, `background-removal-test.tsx`: 진입·배경 제거 연결·선택 사진 교체.
- `src/components/materials/product3d-editor.tsx`, `product3d-viewport.tsx`와 CSS: 단일 뷰어·진행/오류·마우스/터치/키보드·자세 이력.
- `src/lib/product3d/`: 실제 TripoSR Worker·캐시·원본 추적·자세·공통 렌더/PNG·메시 코덱·원자적 폼 적용 준비.
- `src/lib/types.ts`, `src/lib/repositories/{local,cloud,references}.ts`: 이미지/메시 구분 및 불변 버전 자산 참조.
- `src/lib/supabase/validation.ts`, `src/app/api/cloud/{assets,materials}/route.ts`, `supabase/migrations/202609120001_product3d_assets.sql`: 서버 검증과 Storage MIME/참조 준비.
- `tests/product3d-*.test.ts`, `e2e/product3d.spec.ts`, `playwright.product3d.config.ts`: 단위/브라우저 검증. Windows 회귀 다운로드의 경로/파일 권한 처리는 `playwright.config.ts`, `e2e/room-fixtures.spec.ts`에 반영.

기존 세 방향 UI·자동 정면 추정과 관련 소스/검증 파일은 실행 경로에서 제거했다. 기존 미커밋 자료를 안전하게 보존하기 위해 `docs/archive/retired-three-view`에 원문과 SHA-256 목록을 남겼다. 이 보관 파일은 컴파일·테스트 탐색·실행에 사용되지 않는다. 과거 PNG와 모델 캐시 이름은 호환성을 위해 유지한다.
