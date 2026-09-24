# 완성 공간을 실제 사진처럼 — 렌더러 조명·재질 사실감 개선 (1단계)

SJN에서 사용자가 완성한 After 공간이 CG가 아니라 실제 촬영한 욕실처럼 보이도록 렌더러를 개선해줘. 저장소는 `C:\app\SJN`이다(워크트리에서 작업하면 그 경로를 쓴다). 조사나 계획 설명에서 멈추지 말고 구현, 실제 렌더 이미지 확인, 반복 수정, 회귀 검사, 문서 갱신, 결과 보고까지 끝낸다. 시간이 오래 걸려도 괜찮다.

이 앱은 타일·설비를 고르고 견적을 내는 도구다. **사실감을 올리되, 사용자가 고른 디자인은 바뀌면 안 된다.** 타일의 색·무늬·크기·줄눈·배치, 제품 위치·크기는 지금과 같아야 하고 빛·그림자·광택·입체감만 좋아져야 한다. 이번 단계는 AI 없이 렌더러만 고친다. FLUX·Gemma 호출이나 경로 추적(path tracing)은 범위 밖이다.

## 1. 먼저 읽고 현재 구조를 확인한다

`AGENTS.md`, `.agents/skills/sjn-workflow/SKILL.md`와 references의 프로젝트 설명·개발 환경 문서, 설치된 `node_modules/next/dist/docs/`의 관련 문서, 현재 git 상태를 먼저 본다. 이미 수정된 파일을 초기화하지 않는다. 다음 문서도 읽는다.

- `docs/room-viewer-renderer-contract-20260914.md`, `docs/room-viewer-results-20260914.md`
- `docs/design-render-verification.md`, `docs/room-dimensions.md`, `docs/product3d-editor.md`

아래는 2026-09-24에 코드에서 확인한 구조다. 작업 전에 실제 코드와 다시 대조한다.

**렌더링 경로는 세 개이고 빛을 만드는 방식이 다르다.**

1. 편집 화면·PNG/JPG 내보내기·FLUX 입력 — `src/lib/render/compositor.ts`
   - 3D 조명이 아니라 2D 합성이다. `tileShader`가 타일 아틀라스를 배경 이미지에 원근 투영하고, 배경(사진 또는 기본 방 이미지)의 밝기 `shadingImage`를 `shading` 세기만큼 곱해 명암을 입힌다. 기본값은 `src/lib/types.ts`의 `shading: 0.25`이고, 사진 재구성은 0.4를 쓴다. 셰이더 주석대로 세기 0이면 정확히 중립이어야 한다.
   - 줄눈은 `seamDistance`/`seamCoverage`로 계산한 평평한 색 혼합이다. 들어간 느낌이나 모서리 음영이 없다.
   - 사진 제품은 `fixtureShader`의 타원형 가짜 그림자를 쓴다. 표준 설비 모형은 `src/lib/render/standard-model-render.ts`가 Three로 렌더한다. 조명은 AmbientLight 1.6, 바깥 햇빛 같은 DirectionalLight 1.65(`-1500, 4000, 6000`), 보조광 0.28이고 톤 매핑은 없다.
2. 공간 둘러보기(3D) — `src/lib/room-viewer/renderer.ts`
   - `NoToneMapping`, `PCFShadowMap`(1024)을 쓰고, 위와 같은 환경광 1.6·방향광 1.65·보조광 조합이다.
   - 면 재질은 `surfaces.ts`의 `surfaceMaterial`이다. 모든 타일이 `roughness 0.83, metalness 0`으로 고정된 무광이고, 환경 반사가 없다. 타일·줄눈은 `onBeforeCompile` 셰이더에서 그린다.
   - 제품은 `fixtures.ts`에서 `shading === 'lit'`이면 `MeshStandardMaterial(roughness 0.5)`, 아니면 `MeshBasicMaterial(toneMapped: false)`를 쓴다. 후자는 사용자가 고른 '원본 색' 모드다.
3. 기본 공간 배경 — `src/lib/room-background.ts`
   - 방을 만들 때 한 번 렌더해 배경 자산으로 저장한다. 조명은 `MeshBasicMaterial` 정점색에 손으로 만든 밝기 감쇠를 넣은 것이다.
   - 이미 만든 프로젝트는 저장된 PNG를 계속 쓴다. 이 파일을 바꾸면 새로 만드는 방에만 적용된다.

**재질 데이터**
- `MaterialVersion.finish`(`src/lib/types.ts`)는 자유 문자열이다.
- 카탈로그 기본 마감은 `무광`, `유광`, `반광`, `폴리싱`, `브러시드`, `엠보`, `크롬`이다(`migrations/d1/0004_catalog_seed.sql`).
- 현재 어떤 렌더러도 이 값을 쓰지 않는다.

**캐시·리비전 키.** 부작용이 있으므로 올릴지 신중히 정한다.
- `src/lib/room-viewer/render-version.ts`의 `ROOM_VIEWER_RENDERER_REVISION`: 시안 미리보기 식별자(`design-preview-context.ts`)와 프로젝트 요약 리비전(`project-summary.ts`의 `PROJECT_SUMMARY_PREVIEW_REVISION`)에 들어간다. 올리면 저장된 모든 프로젝트 요약이 오래된 것으로 처리된다. 그러면 프로젝트 목록을 열 때 프로젝트마다 R2 문서를 읽는다(`src/lib/d1/projects.ts`의 list, R2 읽기 과금). 다시 저장될 때까지 계속된다.
- `src/lib/render/design-preview-cache.ts`의 `DESIGN_RENDER_REVISION`, `src/lib/reconstruction/templates.ts`의 `TEMPLATE_RENDERER_REVISION`.
- 렌더 결과가 바뀌면 오래된 미리보기가 남지 않도록 필요한 키만 올리고, 올린 이유와 부작용을 보고한다.

three는 `0.185.1`이다. `NeutralToneMapping`, `examples/jsm/environments/RoomEnvironment.js`, `examples/jsm/postprocessing/GTAOPass.js`, `examples/jsm/lights/RectAreaLightUniformsLib.js`가 설치돼 있다. **새 npm 의존성은 추가하지 않는다.** 꼭 필요하면 멈추고 먼저 묻는다.

## 2. 개선할 항목

### 2-1. 톤 매핑·노출·환경 조명
- 공간 둘러보기와 `standard-model-render.ts`에 톤 매핑을 켠다. 색 변화가 가장 적은 `NeutralToneMapping`을 기본 후보로 한다. ACES/AgX는 색조·채도를 바꿀 수 있어 자재 색이 중요한 이 앱에서는 비교 근거 없이 쓰지 않는다.
- 환경광 1.6에 의존하던 평평한 밝기를 줄인다. `RoomEnvironment`(또는 방 치수로 만든 환경)를 PMREM으로 바꿔 반사광·환경 반사로 쓴다. 노출을 조정해 전체 밝기가 지금과 비슷하게 보이게 한다.
- '원본 색' 제품(`MeshBasicMaterial`, `toneMapped: false`)은 의도적으로 원래 색을 보여 주는 모드다. 톤 매핑·조명 변화의 영향을 받지 않게 유지한다.

### 2-2. 실내 조명
- 바깥 햇빛 같은 방향광 대신 욕실 천장등을 기준으로 한다. `RectAreaLight`는 그림자를 만들지 않으므로, 그림자는 천장 위치의 그림자용 광원으로 따로 만든다. 부드러운 그림자(PCFSoft 등)를 검토한다.
- 광원은 지금처럼 방 좌표에 고정한다(렌더러 계약). 시점을 돌려도 빛이 따라 돌지 않아야 한다.
- 방 크기에 따라 광원 위치·세기를 자동으로 맞추고, 아주 작거나 큰 방에서도 과노출·과소노출이 없게 한다.

### 2-3. 마감별 광택
- `finish` 문자열을 광택 값으로 바꾸는 순수 함수를 한 곳에 만들고 단위 테스트한다. 대소문자·공백·복합 표기(예: "유광 폴리싱")를 정규화한다. 기준 예시:
  - `유광`·`폴리싱`: 낮은 roughness와 clearcoat 검토
  - `반광`: 중간
  - `무광`·`엠보`: 높은 roughness
  - `크롬`·`브러시드`: 금속성, 브러시드는 거칠게
  - 빈 값·알 수 없는 값: **지금과 같은 무광(0.83)**으로 두어 기존 프로젝트 모습을 유지
- 공간 둘러보기: 타일 면에 roughness/clearcoat와 환경 반사를 적용한다. 유광 바닥에 벽·설비가 은은하게 비치는 정도를 목표로 한다. 거울처럼 선명한 반사는 목표가 아니다.
- 편집 화면·내보내기(2D): 3D 광원이 없으므로 `shadingImage`의 밝은 영역을 이용해 유광 타일에만 은은한 하이라이트를 더하는 식으로 보수적으로 표현한다. 무광은 지금과 같아야 하고, `shading` 0일 때 중립이라는 불변식을 깨지 않는다.

### 2-4. 줄눈과 타일 모서리 입체감
- 기존 줄눈 계산(주기·`seamDistance`·`fwidth` 안티앨리어싱)을 재사용해, 새 텍스처 없이 줄눈이 살짝 들어가 보이게 한다. 줄눈 쪽을 조금 어둡게 하고, 타일 모서리에는 약한 경사 음영을 준다. 공간 둘러보기는 법선 교란, 편집 화면은 밝기 변화로 표현한다.
- `groutWidth` 0이면 효과가 없어야 한다. 멀리 있는 작은 타일에서 모아레·반짝임이 생기지 않게 픽셀 크기를 고려해 약화한다.
- 줄눈 색·폭·배열·시작점·회전·여러 무늬 seed 결과는 지금과 같아야 한다.

### 2-5. 구석 그림자(AO)
- 공간 둘러보기: 방은 직육면체이므로 벽–벽, 벽–바닥 모서리까지의 거리(mm)로 계산하는 **결정적 모서리 AO**를 우선 검토한다. 설비 아래 접지 음영은 기존 그림자와 겹치지 않게 조정한다. `GTAOPass` 같은 화면 공간 AO는 노이즈·성능·결정성 문제가 없을 때만 쓴다.
- 편집 화면: 사진 기반 프로젝트에는 사진 자체의 명암이 있으므로 가짜 AO를 덧씌우지 않는다. 기본 공간(사진 없음)에만 알려진 방 치수와 카메라로 모서리 AO를 적용할지 검토한다. 이미 저장된 배경 PNG를 다시 만들거나 덮어쓰지 않는다.

## 3. 반드시 지킬 조건

- **디자인 불변**: 타일 색·무늬·크기·줄눈·배치·제품 위치·크기, 견적·수량 계산은 바뀌지 않는다.
- **색 정확도**: 정면으로 잘 보이는 벽·바닥 중앙 영역의 평균색을 자재 텍스처 평균색과 비교해 ΔE2000을 잰다. 개선 후 값이 기준선보다 나빠지면 안 된다. ΔE2000이 5를 넘는 자재는 원인을 보고한다.
- **Before/After 공정성**: 같은 장면이면 Before와 After가 같은 조명·카메라·파이프라인으로 렌더된다. 비교 카드의 같은 장면 픽셀 차이가 지금처럼 RGB 채널당 1 이내인지 확인한다.
- **사진 보호**: 사진 기반 프로젝트에서 바뀌지 않은 영역의 사진 픽셀은 그대로다. 새 조명을 원본 사진 위에 굽지 않는다.
- **결정성**: 같은 장면·시점은 같은 픽셀을 낸다. 네 번 90° 회전하면 원래 픽셀로 돌아오는 기존 검사가 계속 통과해야 한다. 무작위 노이즈나 시간에 따라 변하는 효과는 쓰지 않는다.
- **성능**: 공간 둘러보기 회전 렌더 시간(기존 SwiftShader 측정 약 45–122ms)을 기준선과 비교해 보고한다. 크게 느려지면 품질 단계를 나눈다. 내보내기 최대 4096px 한도와 저사양·float 렌더 타깃 미지원 환경의 대체 경로를 유지한다.
- **자원 해제**: 새 PMREM·환경 텍스처·후처리 타깃은 렌더러 dispose에서 모두 해제한다(`tests/room-viewer-resource-browser.ts`).
- **기존 프로젝트**: 마이그레이션 없이 열린다. 새 저장 필드나 설정 UI는 추가하지 않는다. 꼭 필요하면 이유를 적고 `src/lib/storage/validation.ts` 스키마까지 맞춘다.
- AI 추론·배포·운영 DB/R2 쓰기는 하지 않는다. 커밋·푸시는 요청받았을 때만 한다.

## 4. 진행 순서 — 단계마다 직접 이미지를 보고 고친다

0. **기준선 캡처.** 코드를 바꾸기 전에 고정 장면 세트를 렌더해 `test-results/render-realism/baseline/`에 저장한다. 장면은 기존 브라우저 테스트 도구로 만들고, 로컬 개발 DB에 실제 카탈로그 자재가 있으면 함께 쓴다.
   - 기본 공간(2400×2400×2400mm 등) + 흰 무광 300×600 벽타일·회색 바닥타일
   - 짙은 유광 타일 + 넓은 밝은 줄눈
   - 작은 모자이크(줄눈 모아레 확인용)
   - 표준 설비(양변기·세면대)가 있는 장면
   - 사진 기반 프로젝트 1개(있으면)
   - 각 장면마다 편집 화면 After PNG 내보내기, 공간 둘러보기 정면·좌·우·위·아래, Before/After 비교 이미지
1. 톤 매핑·환경 조명·실내 조명(2-1, 2-2)
2. 마감별 광택(2-3)
3. 줄눈·모서리 입체감(2-4)
4. 구석 그림자(2-5)

단계마다 같은 장면을 `test-results/render-realism/<단계>/`에 다시 렌더한다. **이미지를 직접 열어 기준선과 나란히 비교**하고, 색 정확도 수치와 렌더 시간을 기록한 뒤 다음 단계로 간다. 숫자만 보고 통과로 판단하지 않는다. 과한 광택, 떠 보이는 설비, 너무 어두운 구석, 줄눈 모아레가 보이면 고치고 다시 렌더한다.

## 5. 검증

- 단위:
  - `npx vitest run tests/room-viewer-surfaces.test.ts tests/room-viewer-lighting.test.ts tests/room-viewer-fixtures.test.ts tests/tile-settings.test.ts tests/render-math.test.ts`
  - 새 마감 매핑 테스트
- 브라우저 WebGL:
  - `npm run test:webgl`, `npm run test:images`, `npm run test:comparison`
  - `node tests/run-browser-test.mjs tests/room-viewer-render-browser.ts`
  - `node tests/run-browser-test.mjs tests/room-viewer-resource-browser.ts`
  - 자료가 있으면 `tests/room-viewer-real-data-browser.ts`
- E2E:
  - `npx playwright test e2e/room-viewer.spec.ts e2e/base-room.spec.ts e2e/fixture-tiling.spec.ts e2e/room-fixtures.spec.ts e2e/flux-export.spec.ts`
  - `npm run test:ui`
- 정적 검사:
  - `npm run typecheck`, `npm run lint`
  - `npx prettier --check --end-of-line auto <변경 파일>`: 작업 사본이 CRLF라서 `--end-of-line auto`로 확인한다.
- 픽셀 기대값이 들어 있는 기존 테스트는 의도한 변화 때문에 실패할 수 있다. 실패마다 **의도한 시각 변화인지 회귀인지** 구분한다. 기대값은 근거를 남기고 갱신하며, 허용 오차를 조용히 넓히지 않는다.
- 환경 주의:
  - 워크트리에 `node_modules`가 없으면 `npm ci`를 쓴다.
  - Playwright는 3000번 포트의 기존 서버를 재사용한다(`reuseExistingServer`). 다른 체크아웃의 서버가 떠 있으면 옛 코드를 검사하게 되니 먼저 확인한다.
  - `next typegen`이 바꾼 `next-env.d.ts`는 작업 결과에 섞지 않는다.

## 6. 문서

- `docs/render-realism-results-<날짜>.md`에 결과를 쓴다. 장면별 기준선/개선 이미지 경로, ΔE2000 표, 렌더 시간, 올린 캐시 키와 부작용, 한계를 담는다.
- 렌더러 계약이 바뀌면 `docs/room-viewer-renderer-contract-20260914.md`의 해당 부분을 현재 설명으로 고친다.
- 사용자에게 보이는 결과가 바뀌면 `.agents/skills/sjn-workflow/references/project-overview.md`의 렌더링·내보내기 설명을 맞춘다.
- `docs/verification.md` 맨 위에 짧은 항목을 추가한다.
- 실제 GPU·모바일 기기에서 확인하지 못한 것은 미확인으로 적는다. SwiftShader 결과를 실제 기기 성능으로 쓰지 않는다.

## 7. 결과 보고

- 장면별 **기준선 vs 개선 비교 이미지**(나란히 붙인 한 장씩)를 사용자에게 직접 보여 준다.
- 파일마다 바뀐 코드와 바뀐 이유를 코드 수준에서 설명한다.
- 보고할 내용:
  - 색 정확도 수치(기준선 대비)
  - 렌더 시간 변화
  - 통과·실패 테스트와 갱신한 기대값의 근거
  - 올린 리비전 키와 그 영향(프로젝트 목록 R2 읽기 등)
  - 남은 한계와 다음 단계 후보: AI 결과에서 조명만 가져오기, 내보내기 전용 경로 추적
