# 공간 둘러보기 렌더 경로 · 2026-09-14

이 문서는 새 보기 렌더러의 구현과 독립 검증 범위다. 실제 저장된 사진 재구성·제품 메시·편집기 통합 검증은 전체 결과 보고서에서 별도로 다룬다.

## 구현

- `src/lib/room-viewer/renderer.ts`: 하나의 WebGL context, Before/After 각각 하나의 선형색·공통 깊이 렌더 타깃, 동일 카메라를 사용한다. 정면 compositor는 변경하지 않는다.
- `src/lib/room-viewer/surfaces.ts`: 방의 mm 좌표에 네 면만 생성한다. `roomFacePoint`의 u/v와 전체 벽 높이 구간을 사용한다. 원근 quad와 사진 마스크를 3D 좌표로 추정하지 않는다.
- 전체 벽과 높이 밴드는 겹치지 않는 구간으로 나누므로 같은 깊이의 중복 면이 생기지 않는다. 겹치는 불명확한 밴드·여러 전체 면은 자동으로 우선순위를 정하지 않고 제한을 알린다.
- 타일 규격, 줄눈, 반장 엇갈림, 회전, 시작점, seed, 여러 무늬를 면 UV→mm로 계산한다. 색상 텍스처는 sRGB에서 선형으로 해석하며 최종 출력에서 한 번만 sRGB로 변환한다.
- 가까운 외피는 실제 카메라 위치에 따라 숨긴다. 바닥 아래에서는 바닥을 숨긴다. 벽을 숨겨도 설치 제품은 별도 그룹으로 남는다. 앞벽과 견적 항목을 추가하지 않는다. 천장은 방 안 시점에서만 보인다(아래 2026-09-26 항목).
- 광원과 그림자는 방 좌표에 고정한다. 사진의 명암·보호 마스크·수동 복원 배경은 새 방향에 붙이지 않고 제한을 안내한다.
- 2026-09-25 사실감 조명([realistic-lighting](../src/lib/render/realistic-lighting.ts))으로 바꿨다.
  - 조명: 천장 중앙 SpotLight 하나(90° 원뿔·완전 penumbra로 평판 등처럼 cos 감쇠, 그림자 규칙은 아래 2026-09-26 2단계)와 렌더러마다 하나씩 만드는 절차적 욕실 환경맵(PMREM)을 쓴다. 환경맵에서 열린 앞면(카메라 쪽)이 밝아 뒷벽을 채운다. 반정밀도 색 타깃이 없으면 같은 밝기의 HemisphereLight로 대체한다.
  - 톤 매핑: 렌더 타깃에 그리므로 `renderer.toneMapping` 대신 조명 받는 재질 안에서 Khronos PBR Neutral 곡선을 적용한다. '원본 색' 제품과 사진 평면은 제외한다.
  - 마감별 광택: 타일 마감 문자열은 [finish](../src/lib/render/finish.ts)가 광택으로 바꾼다. 빈 값이나 알 수 없는 값은 기존 무광 0.83이다. 줄눈은 항상 거칠다.
  - 반사: 타일의 반사는 0.6배로 줄여 어두운 유광 타일이 회색으로 씻기지 않게 한다.
  - 줄눈 입체: 줄눈 안쪽은 12% 어둡게, 타일 모서리는 줄눈 폭이 있을 때만 경사 법선으로 표현한다. 픽셀보다 작아지면 사라진다.
  - 구석 그림자: 방 모서리와 바닥 설비 둘레는 mm 거리로 계산한 간접광 그림자로 처리한다. 결정적이며 Before/After에 같게 적용된다.
  - `RectAreaLight`는 모듈 전역 LTC 텍스처가 닫힌 렌더러를 붙잡을 수 있어(DFG LUT와 같은 문제) 쓰지 않는다.
- 같은 장면은 준비 결과를 재사용하고 최근 최대 6개를 보관한다. 타일·제품 디코딩은 창 수명 동안 공유한다. 비용만 바뀌면 재준비하지 않는다. 카메라 회전에는 이미지 인코딩이나 AI 호출이 없다.
- PNG/JPG 다운로드는 호출 순간의 시점을 복사해 렌더한 뒤 별도 canvas로 픽셀을 복사한다. 이후 회전은 인코딩 중인 파일에 영향을 주지 않는다. 기존 미리보기 크기·시점을 복구한다. 전체 긴 변은 원본·GPU·4096px 안에서 제한한다.
  - `quality` 없는 `export()`(시안 미리보기, FLUX 입력)는 동기 한 장이며 `render()`와 바이트 단위로 같다.
  - `quality`·`effects`가 있는 사진 다운로드는 비동기다. 그동안 들어온 `render()`는 끝난 뒤 마지막 요청 하나만 그린다.
- 2026-09-26 내보내기 사실감 1단계([결과](export-realism-stage-1-results-20260926.md))
  - **방 안 시점** `projection: 'room-eye'` + `eye { position, yaw, shift, fov }`
    - 피치 0 고정, 세로 구도는 렌즈 시프트(`setViewOffset`)다. 눈높이 1,500mm, 화각 74°(60–90°)가 기본이다.
    - 벽에서 150mm, 높이 300mm ~ 천장−150mm 안으로 제한한다. |yaw| ≤ 90° − fov/2 − 3°라 앞면이 프레임에 들어오지 않는다.
    - `eye`가 깨지면 정규화에서 버리고 궤도 보기로 연다.
  - **천장**([ceiling](../src/lib/room-viewer/ceiling.ts)): 무광 흰 면과 600×600mm 발광 평판 등이다. 방 안 시점일 때만 보이고 선택·견적·설비 상자·그림자에 들어가지 않는다. 궤도 보기와 저장 사진 시점 렌더는 이전과 같다.
  - **여러 장 겹쳐 찍기**([accumulate](../src/lib/room-viewer/accumulate.ts)): `export({ quality })`에서만 동작한다.
    - 0번 장은 원래 프레임, 이후는 고정 Halton 수열로 카메라 서브픽셀과 등 위치(600mm 판 안)를 옮겨 half-float 타깃에 평균한다.
    - 그림자는 실시간과 같은 규칙이다(아래 2단계). 등이 움직이는 장(16장 이상, 첫 장 제외)만 흐림 반경을 5텍셀로 줄인다.
    - 매 타일 1픽셀을 읽어 GPU 완료를 기다린다. 진행률·시간 예산·취소가 실제 시간을 따른다.
    - 기본 32장, 예산 10초다. 첫 장의 실제 경과 시간으로 장 수를 정하고, 16장 미만이면 등을 고정한다.
    - 가로 타일(2단계): 1/64 시험 타일 두 개로 1·4·16·64 타일 중 하나를 고정하고, 투영을 타일 행으로 잘라 타일 크기 타깃에 그린다. 타일 사이에 양보한다. GPU는 1타일이라 한 장과 같다.
    - 출력은 캔버스를 키우지 않고 8비트 타깃에 띠 단위로 합성·읽기 한다. 실시간 캔버스는 내보내기 동안 그대로다.
    - float 타깃이 없거나 도중 오류면 한 장으로 내보내고 `lastExport.fallbackReason`을 남긴다. 취소·해제·컨텍스트 손실은 다음 장 전에 멈추고 누적 타깃을 해제한다.
  - **사진 효과**([photo-effects](../src/lib/room-viewer/photo-effects.ts)): `export({ effects })`에서만 별도 post 프로그램으로 적용한다. 기본 post 프로그램 소스는 그대로다. FLUX 입력과 미리보기에는 넣지 않는다.
- 2026-09-26 사실감 2단계([결과](export-realism-stage-2-results-20260926.md)): 실시간·미리보기·내보내기 공통 그림자 규칙([shadow](../src/lib/room-viewer/shadow.ts))
  - 그림자 화각은 방에 맞춘다(등에서 바닥 모서리와 벽 1,200mm, 내보내기 등 이동 300mm, 여유 4°; 60~150°). 1024² 맵을 매 렌더 갱신한다.
  - PCF는 화면 좌표로 회전하는 5점 대신 고정 32점 Vogel 원판이다(재질 onBeforeCompile, 키 `sjn-disk-shadow-v1`). 반경은 한 장 20텍셀, 등이 움직이는 내보내기 5텍셀이다.
  - 그림자는 설비만 드리우고 면은 받기만 한다. 천장·평판 등은 둘 다 아니다.
  - 기존 결과 대비 설비 그림자만 어두워지고(밝아진 픽셀 0) 2D 합성은 픽셀 단위로 같다. 미리보기 캐시는 `room-view-v6-fixture-shadows`로 새로 그린다.
- 자산 실패는 해당 면/제품의 오류 목록에 남긴다. 창의 다시 시도는 렌더러를 새로 만들어 일시적인 읽기 실패를 다시 확인한다. 공간 치수가 없는 사진 작업과 Before/After 치수 불일치는 명확한 오류를 반환한다.

## 독립 테스트

명령:

```text
npx vitest run tests/room-viewer-surfaces.test.ts
npx eslint src/lib/room-viewer/renderer.ts src/lib/room-viewer/surfaces.ts tests/room-viewer-surfaces.test.ts tests/room-viewer-render-browser.ts
node tests/run-browser-test.mjs tests/room-viewer-render-browser.ts
```

- 순수 단위 테스트 9개 통과: 네 면·원본 불변, 밴드 분할, 전체 면 UV 유지, 내향 법선, 중복 밴드 보류, 수동 면 제한, 잘못된 밴드, cutaway, 준비 키.
- 실제 WebGL 기능 검사 19항목 통과: 파랑/주황 타일 셰이더, 네 번 회전의 픽셀 복귀, 위/아래 시점, 분할 정렬, 좌우 카드 정렬, 가격 변경 캐시, PNG/JPG와 출력 한도, 미리보기 복구, 50회 회전, 복수 무늬 seed 유지, 늦은 이전 시안 폐기, 누락 자산 오류, 출력 중 시점 변경 격리, context 해제.
- 비교 카드의 같은 장면 픽셀 차이는 RGB 채널당 최대 1이었다. 카메라는 하나이며 차이는 렌더 타깃과 출력의 선형 샘플링 반올림 범위다.
- 함수 검사 장면은 직접 만든 단색 타일과 기본 방이다. 실제 AI 인식/제품 복원 성공으로 보고하지 않는다.

최종 렌더 아티팩트: `test-results/room-viewer-20260914/renderer/post-lut/verification.json`와 같은 폴더의 `front.png`, `right.png`, `back.png`, `left.png`, `up.png`, `down.png`, `compare.png`, `after.jpg`.

## 성능 측정 조건과 한계

Chrome headless, ANGLE SwiftShader 소프트웨어 렌더링, 2400×2400×2400mm 방, 타일 네 면, 제품 없는 기능 검사 장면. 자산 준비 약 4.8ms는 64px짜리 로컬 테스트 자산이므로 실제 프로젝트 준비 시간으로 일반화하지 않는다. 900×600px 비교 화면 50회 순간 회전과 동기 픽셀 읽기를 측정했다. 기록은 약 45.5–121.9ms이며 애니메이션 fps 측정이 아니다. 원시 배열을 검증 JSON에 보관한다.

회전 전후 준비 2개·텍스처 9개로 유지했다. dispose 후 context=0, CPU 장면/타일/제품 캐시=0이며 `forceContextLoss`가 실행됐다. Three.js의 `renderer.info`는 context 해제 후 과거 할당 카운터를 일부 유지하므로 이 수치를 살아 있는 VRAM이나 누수로 해석하지 않는다(`countersMayBeStaleAfterContextLoss`). 이 검사는 RAM/VRAM의 총량이나 저사양 실제 GPU 성능을 측정하지 않았다.

## 반복 열기/닫기에서 발견하고 수정한 리소스 보유

최초 `dispose + forceContextLoss` 검사는 GPU context 종료와 우리 캐시 해제만 증명했다. 추가로 Chrome CDP에서 두 프레임 대기→강제 GC→`Runtime.queryObjects`를 실행하자 **Three.js `WebGLRenderer`가 창을 닫을 때마다 하나씩 남는 실제 CPU 객체 보유**를 확인했다. 기존 성공 로그를 이 문제까지 통과한 것으로 해석하지 않는다.

설치 버전 `three@0.185.1`의 다음 소스가 원인을 설명한다.

- `node_modules/three/src/renderers/shaders/DFGLUTData.js`: 모듈 공통 `getDFGLUT()` 텍스처 싱글턴.
- `node_modules/three/src/renderers/WebGLRenderer.js`: PBR 재질을 그릴 때 `uniforms.dfgLUT.value = getDFGLUT()`로 새로 지정한다.
- `node_modules/three/src/renderers/webgl/WebGLTextures.js`: 실제 텍스처 사용 때 context별 dispose listener를 등록한다.
- 공통 LUT는 계속 살아 있는데 context별 listener가 남으면서 닫힌 renderer를 붙잡았다. 수정 전 10회 검사에서 LUT listener **1→10**, 살아 있는 Three renderer **1→10**, BufferGeometry **8→17**로 증가했다. 우리 `RoomViewerRenderer` 자체는 이미 GC되어 0이었다.

`src/lib/room-viewer/lighting.ts`의 `ViewerLightingLut`가 재질의 기존 `onBeforeCompile`과 cache key를 보존하면서 해당 uniform의 갱신을 보기 창 소유 텍스처로 연결한다. 동일 픽셀 소스를 `Texture.clone()`한 텍스처 한 개를 창 안에서 공유하고 닫을 때 그 복사본만 `dispose()`한다. 공통 원본 텍스처나 다른 편집기 renderer의 listener를 삭제하지 않는다. 이후 매 프레임 uniform 재지정도 같은 복사본을 사용하며, 닫힌 뒤 늦은 shader 갱신에는 새 텍스처를 만들지 않는다.

사용한 확장/해제 API는 Three의 [Material.onBeforeCompile와 customProgramCacheKey](https://threejs.org/docs/pages/Material.html), [Texture.clone와 dispose](https://threejs.org/docs/pages/Texture.html)에 문서화되어 있다. `dfgLUT`라는 uniform 이름은 설치된 0.185.1 내부 계약이므로 버전 변경 시 이 회귀 검사를 다시 실행해야 한다. `node_modules`는 수정하지 않았다. `PCFSoftShadowMap`도 이 버전에서 PCF로 자동 대체되는 deprecated 상수임을 확인하고 실제 동작이 같은 `PCFShadowMap`으로 교체했다.

### 최종 검증

- `tests/room-viewer-lighting.test.ts` 6개 + 면 테스트 9개 통과. 기존 셰이더·cache key 유지, 반복 uniform 갱신의 복사본 재사용, 다른 창/전역 원본 비파괴, 늦은 종료 후 갱신, uniform이 없는 재질을 확인했다.
- `tests/room-viewer-render-browser.ts`의 19개 WebGL 기능 검사를 최종 코드에서 다시 통과했다. 최종 경로는 `renderer/post-lut/verification.json`이다.
- `tests/room-viewer-resource-browser.ts`는 최종 생산 코드로 **10회 생성→준비→6회 회전→dispose**를 완료했다. 테스트용 LUT 대체 hook을 끈 실행이다.
- 각 회차의 살아 있는 우리 renderer와 Three renderer는 모두 **0**, 창 소유 LUT **1→0**, 우리 CPU 장면·타일·제품 캐시 **0**, DOM canvas **0**, WebGL context **0**이었다. 공통 모듈 객체는 BufferGeometry **7**, Texture **14**로 모든 회차에서 일정했다. `renderer.info`의 종료 후 일부 과거 카운터와 실제 살아 있는 객체 수는 구분한다.
- 후속 main-page JS heap은 첫 회차 3,472,872B에서 열 번째 4,040,888B로 변했다. 코드 준비 등 전체 증가의 모든 원인을 식별했다는 주장은 하지 않으며, 특정 renderer 누적이 사라진 것은 객체 수로 직접 검증했다. 이는 전체 RAM·VRAM·최대 메모리 측정이 아니다.
- 조건: Chrome 152 headless + SwiftShader, 2400mm 정방형 공간, Before 표준 설비 5개 / After 표준 설비 5개+PNG 제품 1개, 타일 4면, 900×600 비교. 준비 36.6–97.4ms, 첫 프레임 353.7–576.7ms, 준비 후 순간 회전 중앙값 91.9ms / p95 106.2ms였다. GPU 완료를 기다리는 픽셀 읽기를 포함하며 fps 수치가 아니다.
- 외부 요청·Worker·AI 실행은 0이었다.

추가 아티팩트:

- 수정 전 증거: `test-results/room-viewer-20260914/resource-cycles/run-03/verification.json`
- 원인 분리 실험: `resource-cycles/lut-probe/verification.json` — 테스트에만 적용한 hook, 생산 성공 근거로 사용하지 않음
- 최종 생산 검증: `resource-cycles/post-lut/verification.json`, `resource-cycles/post-lut/summary.json`

### 나머지 독립 감사 결과

카메라 quaternion·공통 bounds·밴드 UV·색공간·분할 출력·늦은 시안 응답·내보내기 픽셀 고정·cutaway·자산 실패 경로를 다시 읽었다. 추가 확정 결함은 찾지 못했다. 사진 기반 마스크/복원 배경을 재현하지 않는 점, 단일 PNG의 얇은 옆면·동일한 뒷면, 극단적으로 방 밖에 있는 제품의 화면 맞춤 제외는 명시적인 지원 제한이다. 이 감사가 사용자 사진 전체의 재구성 인식 정확도를 검증한 것은 아니다.
