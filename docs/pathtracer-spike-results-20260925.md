# 내보내기 고화질 렌더(경로 추적) 0–1단계 결과 · 2026-09-25

[작업 프롬프트](prompts/pathtracer-stage-0-1-feasibility.md)의 0단계(사전 확인)와 1단계(최소 장면 시험) 결과다. 브랜치는 `claude/pathtracer-spike`이고 사용자 화면·내보내기·편집 렌더는 바꾸지 않았다. AI 호출과 외부 요청은 없다. 2단계는 시작하지 않았다.

## 한눈에 보기

| 관문                    | 결과                                | 근거                                                                                                                                                    |
| ----------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0단계: 설치·빌드        | 통과                                | 두 패키지를 devDependencies에 정확한 버전으로 추가했다. `npm run build`와 `npm run build:vinext` 모두 된다(아래 번들 표)                                |
| 0단계: 필요할 때만 로드 | 통과(Vite 탐침)                     | 동적 import 청크에만 들어간다. 크기 203,549B, gzip 57,826B. three 본체는 진입 청크에만 있고 xatlas-web은 빠진다. 실제 앱 연결은 5단계에서 다시 확인한다 |
| 0단계: 필수 기능        | 통과                                | 재질 기본 속성, SpotLight(원뿔·반그림자·decay)를 지원한다. HemisphereLight와 PMREM 환경맵은 지원하지 않는다                                             |
| 1-1 오류 없이·같은 구도 | **SwiftShader 통과, 실제 GPU 실패** | 카메라 행렬은 두 환경 모두 차이 0이다. SwiftShader 실루엣 IoU는 0.989다. Iris Xe(D3D11)에서는 물체에 닿은 모든 픽셀이 (0,0,0,0)이다                     |
| 1-2 30초 안 수렴 ≤ 2    | **실패**                            | 실제 GPU 출력이 무효다. 첫 컴파일만 약 173초로 30초를 넘는다                                                                                            |
| 1-3 3회 반복 자원       | 조건부 통과                         | 라이브러리 `dispose()`만 쓰면 회마다 텍스처가 18개씩 는다. 추가 해제(deep)나 렌더러 폐기로는 늘지 않는다                                                |
| 1-4 번들 불변           | 통과                                | 아래 번들 표 참고                                                                                                                                       |
| 1-5 미지원 감지·대체    | **실패**                            | SwiftShader는 감지한다. D3D11 오동작은 확장 검사와 라이브러리 `CompatibilityDetector`가 모두 통과시켜 감지하지 못한다                                   |

**결론: 2단계로 가지 않는 것을 권한다.** Windows Chrome의 기본 백엔드(ANGLE D3D11)에서 이 라이브러리 출력이 무효이고, 첫 셰이더 컴파일이 수 분 걸린다. 원인을 좁히는 조사는 [후속 프롬프트](prompts/pathtracer-stage-1b-d3d11-investigation.md)에 정리했다.

> 후속([1b단계 결과](pathtracer-spike-results-20260925-d3d11.md)): 같은 GPU의 ANGLE Vulkan은 정상이다. D3D11·D3D11on12는 최소 장면·0.0.23에서도 0이라 ANGLE D3D 경로의 컴파일 문제로 좁혔다. 2단계 보류 의견은 그대로다.

## 변경한 파일

| 파일                                                                                                               | 내용                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`, `package-lock.json`                                                                                | devDependencies `three-gpu-pathtracer@0.0.24`, `three-mesh-bvh@0.9.15`. peer인 xatlas-web 0.1.0은 lockfile에만 있다                                                                           |
| [renderer.ts](../src/lib/room-viewer/renderer.ts)                                                                  | `exportFrame(view, longEdge)`: After 장면, 내보내기 카메라, 크기, viewport를 돌려주는 시험용 메서드. `exportSize()`로 `export()`의 크기 계산을 옮겼다(결과 불변). 운영 코드는 호출하지 않는다 |
| [pathtracer-spike-page.ts](../tests/pathtracer-spike-page.ts)                                                      | 브라우저 쪽 시험 코드. 라이브러리 import는 여기에만 있다. 장면·조명 A/B, 경로 추적, 수렴·색·실루엣·자원 측정, deep dispose, 백엔드 진단을 담당한다                                            |
| [pathtracer-spike-browser.ts](../tests/pathtracer-spike-browser.ts)                                                | Playwright 실행기. 옵션: `--lightings --checkpoints --max-seconds --cycles --label --angle --profile --diagnose --headed`                                                                     |
| [pathtracer-bundle-probe.mjs](../tests/pathtracer-bundle-probe.mjs)                                                | 앱 빌드 산출물 스냅샷·비교와 Vite 동적 import 탐침                                                                                                                                            |
| [helpers/delta-e.ts](../tests/helpers/delta-e.ts), [render-realism-browser.ts](../tests/render-realism-browser.ts) | ΔE2000 함수를 공유한다(동작 동일)                                                                                                                                                             |

`exportFrame`을 렌더러에 둔 이유: `prepare()`의 bounds, 접지, 조명 조립을 테스트에 복제하지 않고 `render()`와 같은 카메라 생성을 그대로 쓰기 위해서다. 5단계에서도 필요하다.

## 환경

- **PC:** Windows 11, Intel Iris Xe(내장 GPU, 드라이버 32.0.101.7076), Chrome(Playwright `channel:'chrome'`, headless). 측정 당시 `Win32_Battery.BatteryStatus=1`(배터리 사용 중)이라 성능이 낮게 나왔을 수 있다. 시스템 설정은 바꾸지 않았다.
- **SwiftShader 렌더러 이름:** `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)`
- **실제 GPU 렌더러 이름:** `ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x0000A7A1) Direct3D11 vs_5_0 ps_5_0, D3D11)`
- **기능:** 두 환경 모두 WebGL2, `EXT_color_buffer_float`, `OES_texture_float_linear`, `EXT_float_blend`를 지원한다. `MAX_TEXTURE_SIZE`는 8192(SwiftShader), 16384(Iris Xe)다. 라이브러리 `CompatibilityDetector`는 둘 다 통과했다.
- **모바일:** 미확인.

## 1단계 장면과 방법

- **장면:** `DEFAULT_ROOM`(2400mm), 자재 없는 중립 면(`VIEWER_FACE_COLORS`), reconstruction v2 양변기 1개(400×750×680mm, `#efefea`, 뚜껑 닫힘, 바닥 u 0.72·v 0.28). 보기는 `defaultRoomView()`, 크기는 1024×683이다.
- **래스터 기준:** `viewer.export(view, { format: 'png', mode: 'after', longEdge: 1024 })`.
- **경로 추적:** `exportFrame`의 world를 `clone()`한다(형상·재질 공유, 캐시 불변).
  - 별도 WebGLRenderer를 쓴다: Neutral 톤 매핑, sRGB 출력.
  - `WebGLPathTracer` 설정: bounces 5, tiles 1×1, `rasterizeScene=false`(DFG LUT가 렌더러를 붙잡는 문제 회피).
- **조명 A:** 천장 SpotLight는 그대로 둔다. HemisphereLight는 제거한다.
  - 환경은 `createInteriorEnvironment`의 상자 방을 같은 색으로 옮긴 256×128 equirect(`ProceduralEquirectTexture`)이고 세기는 0.58이다.
  - 라이브러리의 equirect 방향 규약은 `Vector3.setFromSpherical`과 x·z가 바뀌어 있어 셰이더 규약으로 계산했다.
- **조명 B:** A에 양면 천장 평면을 더했다. 단면이면 뒷면을 건너뛰어 하늘빛이 샌다.

## 측정 결과

### 구도·출력 변환 (두 환경 공통)

- **투영 상자:** 경로 추적 카메라로 투영한 변기 상자와 `fixtureBounds`의 차이는 0이다.
- **카메라 행렬:** 경로 추적 재질의 `cameraWorldMatrix`·`invProjectionMatrix`와 래스터 카메라의 차이는 0이다.
- **출력 변환:** 누적 float 값에 JS로 Neutral과 sRGB를 적용한 값과 캔버스 바이트를 32픽셀에서 비교했고 차이는 0이다. SwiftShader에서는 유효하다. GPU에서는 물체 픽셀이 0이라 의미가 없다.
- **실루엣 IoU**(`fixtureBounds` 상자 안, 발광 마스크): SwiftShader 4샘플 0.989, Iris Xe 16샘플 0.

### SwiftShader (자동 테스트용인지 확인)

| 항목                 | 값                                                         |
| -------------------- | ---------------------------------------------------------- |
| 첫 샘플(컴파일 포함) | 조명 A 194초, B 202초                                      |
| 컴파일 뒤 한 샘플    | 약 2.3초. 같은 렌더러에서 `setScene` + 2샘플에 4.7–4.9초   |
| 16·32샘플            | 180초 상한 안에 도달하지 못했다(추정: 컴파일 뒤 37초·75초) |

판단: 경로 추적 품질 측정은 자동 테스트(SwiftShader)에 넣기 어렵다. 구도·자원 확인은 4샘플 정도면 가능하지만 새 컨텍스트마다 컴파일이 2–3분 걸린다.

### Iris Xe, ANGLE D3D11

| 항목                        | 값                                                                                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 첫 실행 컴파일              | 조명 A는 60초 안에 끝나지 않았다. 진단 실행(B)에서 첫 샘플까지 173.5초(컴파일 대기 약 97초 + 첫 호출 75.9초)                                                      |
| 컴파일 뒤 속도              | 512샘플에 약 9초. 호출 한 번(1샘플) 중앙값 15.9ms, p95 26.7ms                                                                                                     |
| 같은 브라우저에서 새 렌더러 | `setScene` + 32샘플에 1.5–1.8초. 브라우저의 프로그램 캐시가 쓰인다                                                                                                |
| 출력                        | 배경 픽셀은 정상이다(선형 0.807, 0.807, 0.776, 1). 벽·바닥·변기 픽셀은 누적 float가 정확히 0, alpha 0이다(NaN 아님). 1·4·512샘플, 조명 A·B, 발광 마스크 모두 같다 |
| 재질 플래그                 | 14행이 모든 재질에서 [matte 0, castShadow 1, 0, 0]이다. matte 조기 종료는 원인이 아니다                                                                           |

그래서 GPU 시간·수렴·색 수치는 무효이며 관문 판정에 쓰지 않았다. 원인이 라이브러리인지, ANGLE D3D11인지, Intel 드라이버인지, 이 장면인지는 아직 가리지 못했다. 다른 ANGLE 백엔드와 라이브러리 예제 장면은 시험하지 않았다.

### 자원 (3회 반복, 매회 GC 뒤)

| 방식                                                                                  | `renderer.info.memory.textures` | 살아 있는 WebGLRenderer | 비고                                                                             |
| ------------------------------------------------------------------------------------- | ------------------------------- | ----------------------- | -------------------------------------------------------------------------------- |
| 같은 렌더러 + `WebGLPathTracer.dispose()`                                             | 18 → 36 → 54                    | 3(뷰어·공유 렌더러·1개) | 회마다 GPU 텍스처 18개 누수                                                      |
| 같은 렌더러 + deep dispose(재질 uniform 텍스처·저해상도 추적기·배경 텍스처 추가 해제) | 0, 0, 0 (프로그램 1)            | 3                       | 누수 없음                                                                        |
| 매회 렌더러 폐기 + `forceContextLoss`                                                 | 해당 없음                       | 2로 유지                | 늘지 않음. 폐기된 렌더러 1개가 모듈 공용 객체에 남는 것으로 보이며 원인은 미확인 |

- **JS heap:** 5.8–6.7MB로 증가 추세가 없다.
- **컴파일 중 해제:** 첫 GPU 실행에서 three `compileAsync`가 폴링하는 중에 렌더러를 해제해 `Cannot read properties of undefined (reading 'isReady')`가 3번 났다. 하네스는 이제 컴파일이 끝날 때까지 기다린 뒤 해제한다. 5단계 취소 처리에도 같은 대기가 필요하다.
- **컨텍스트 손실 이벤트:** 모두 하네스가 부른 `forceContextLoss`에서 나온 것이다.

### 번들 (앱 빌드, 기준선 대비)

| 빌드                   | 기준선 클라이언트 JS·CSS         | 변경 후                     | 차이              | 라이브러리 식별 문자열 |
| ---------------------- | -------------------------------- | --------------------------- | ----------------- | ---------------------- |
| `npm run build` (Next) | 67개 4,308,187B, gzip 1,271,442B | 4,309,064B, gzip 1,271,566B | +877B, gzip +124B | 없음                   |
| `npm run build:vinext` | 72개 3,563,927B, gzip 954,945B   | 3,564,717B, gzip 955,016B   | +790B, gzip +71B  | 없음                   |

- **Next:** 내용이 바뀐 청크는 렌더러 청크 하나다(46,733 → 47,610B). 다른 한 파일은 크기가 같고 해시만 바뀌었다.
- **vinext:** 해시 연쇄로 파일 이름이 여럿 바뀌었지만 총량 차이는 790B다.
- **판정:** 두 빌드 모두 ±1KB 안이고, 차이는 `exportFrame` 추가분이다.

### 결과물 (로컬 전용, 커밋하지 않음)

`test-results/pathtracer-spike/` 아래에 있다.

- `swiftshader/`: `capabilities.json`, `raster.png`, `mask-*.png`, `cycle-*.png`, `metrics.json`
- `gpu/`: 첫 GPU 실행. 컴파일 중 해제 오류가 났다
- `gpu-diag/`: B 조명, 1–512샘플 `B/spp-*.png`, `compare-B.png`, `metrics.json`
- `gpu-d3d11-diag/`: 누적 float 값·재질 플래그 진단 `diagnose-0.json`
- `bundle-*.json`, `bundle-probe.json`

## 발견한 제약 (2단계 이후에도 해당)

- **무시되는 셰이더 패치:** 타일 무늬·줄눈·색 보정·톤 매핑·구석/접지 차폐가 모두 빠진다. 경로 추적은 기본 재질 값만 본다.
- **`MeshBasicMaterial`:** 사진 제품 평면과 원본 색 메시는 빛을 받는 매끈한 표면이 된다.
- **텍스처:** 모든 재질 텍스처가 `textureSize` 한 크기(기본 1024²)의 8bit 배열로 줄어들고 밉맵이 없다. 굽는 타일 텍스처는 크기와 면별 분할을 함께 설계해야 한다.
- **HemisphereLight·PMREM:** 지원되지 않아 equirect 데이터 환경이 필요하다.
- **자원 해제:** `dispose()`가 불완전하다. deep dispose나 내보내기마다 전용 렌더러를 폐기하는 방식이 필요하다.
- **컴파일 시간:** 컴파일이 수 분 걸린다. 캐시가 없으면 진행률·취소 UI와 대체 경로가 필수다. 브라우저를 다시 열었을 때 디스크 캐시로 빨라지는지는 미확인이다.

## 2단계 제안 (보류)

지금 결과로는 2단계를 시작하지 않는다. D3D11 문제를 먼저 해결하거나 원인을 확인해야 한다. 해결된다면 2단계는 다음 방향이다.

- **UV 공간 굽기:** 기존 타일 셰이더(`surfaces.ts`의 `onBeforeCompile` 조각)를 UV 공간 사각형에 그린다. 정점을 `uv*2-1`로 두고 월드 좌표 varying은 유지한다. 결과를 color·normal·roughness 텍스처로 굽는다.
- **크기 상한:** 면당 mm당 1px 이상이 필요하다. 2400mm 면이면 2048–4096px다. `textureSize`가 모든 텍스처를 한 크기로 맞추므로 면을 여러 메시로 나누거나 `textureSize`를 2048로 올린다. 이때 메모리는 층마다 16MB씩 늘어난다(8bit RGBA 2048²).
- **위험:** 밉맵이 없어 멀리 있는 작은 줄눈이 깜빡일 수 있다. 줄눈 입체는 normalMap 해상도에 좌우된다. 색 보정·톤 매핑은 구울 때가 아니라 최종 출력 단계에서 맞춰야 한다.

## 0단계: 라이브러리 조사

대상: `three-gpu-pathtracer@0.0.24`(2026-02-21 갱신), `three-mesh-bvh@0.9.15`. 저장소 three는 0.185.1이다. README, `src/index.d.ts`, 소스를 직접 읽었다(패키지에 CHANGELOG 파일은 없다).

| 항목                | 확인 결과                                                                                                                                                                                                                                                                                                                                                        | 근거(설치 소스)                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 라이선스            | 셋 다 MIT: three-gpu-pathtracer, three-mesh-bvh, xatlas-web                                                                                                                                                                                                                                                                                                      | 각 `package.json`                                                                                                   |
| peer 의존성         | `three>=0.180`, `three-mesh-bvh>=0.7.4`는 필수다. `xatlas-web ^0.1.0`은 `UVUnwrapper`(라이트맵용 UV 펼치기) 전용이고 패키지 index에서 내보내지 않는다. `sideEffects:false`라 번들에서 빠진다. `peerDependenciesMeta`가 없어 npm이 자동 설치하므로 lockfile에만 있다                                                                                              | `src/utils/UVUnwrapper.js`, `src/index.js`                                                                          |
| 지원 재질           | README 기준 `MeshStandardMaterial`과 `MeshPhysicalMaterial`만 지원한다. color·map, roughness·metalness와 각 map, normalMap·normalScale, emissive·emissiveMap·emissiveIntensity, transmission, ior, clearcoat, sheen, iridescence, specular, attenuation, opacity·alphaMap·alphaTest, side, vertexColors, flatShading을 읽는다. 추가 속성은 `matte`, `castShadow` | `src/uniforms/MaterialsTexture.js`                                                                                  |
| 읽지 않는 것        | aoMap, lightMap, envMap(재질별), `onBeforeCompile`, `customProgramCacheKey`, `ShaderMaterial`. 재질 값만 표로 옮기고 래스터 셰이더는 실행하지 않는다                                                                                                                                                                                                             | 같은 파일                                                                                                           |
| `MeshBasicMaterial` | 따로 처리하지 않는다. roughness 기본값 0이 들어가 **빛을 받는 매끈한 유전체**가 된다. 사진 제품 평면과 '원본 색' 메시는 조명 없는 표시가 깨진다                                                                                                                                                                                                                  | `getField(m, 'roughness', 0.0)`                                                                                     |
| 조명                | SpotLight(angle·penumbra·decay·distance·`radius`·IES), PointLight, DirectionalLight, RectAreaLight(원형 포함)를 지원한다. 원뿔은 `smoothstep(coneCos, penumbraCos)`, 감쇠는 `1/d^decay`로 three와 같은 식이다. **HemisphereLight와 AmbientLight는 무시한다**                                                                                                     | `src/uniforms/LightsInfoUniformStruct.js`, `src/core/utils/sceneUpdateUtils.js`, `light_sampling_functions.glsl.js` |
| 환경맵              | CPU `image.data`가 있는 equirect DataTexture(float·half float·8bit)를 받는다. CubeTexture는 `CubeToEquirectGenerator`로 바꾼다. **PMREM 결과(cubeUV 렌더 타깃 텍스처)는 픽셀 데이터가 없어 쓸 수 없다**. 배경(Color·텍스처)은 environment와 따로 다루고 `backgroundIntensity`·`environmentIntensity`·회전을 읽는다                                               | `src/core/WebGLPathTracer.js` `updateEnvironment`, `src/uniforms/EquirectHdrInfoUniform.js`                         |
| 노이즈 제거         | `DenoiseMaterial`(glslSmartDeNoise 기반 화면 공간 필터, 톤 매핑·sRGB 포함)만 있다. OIDN 같은 학습형 제거기는 없다                                                                                                                                                                                                                                                | `src/materials/fullscreen/DenoiseMaterial.js`                                                                       |
| 타일·샘플           | `tiles`(기본 3×3, 호출 한 번에 타일 하나), `renderScale`, `bounces`(기본 10), `transmissiveBounces`, `filterGlossyFactor`, `minSamples`, `renderDelay`, `fadeDuration`, `stableNoise`                                                                                                                                                                            | `src/core/PathTracingRenderer.js`                                                                                   |
| 텍스처 크기         | 모든 재질 텍스처를 **한 크기(`textureSize`, 기본 1024×1024)의 8bit 배열 텍스처로 늘이거나 줄여 담는다**. 밉맵은 없다                                                                                                                                                                                                                                             | `src/uniforms/RenderTarget2DArray.js`                                                                               |
| 레이 오프셋         | `RAY_OFFSET 1e-4`에 `(max(abs(p))+1)`을 곱한다. 좌표 크기에 비례하므로 mm 단위(최대 약 2400)에서도 약 0.24mm로 동작한다                                                                                                                                                                                                                                          | `src/shader/common/util_functions.glsl.js`                                                                          |
| 출력                | `renderToCanvas` 블릿(`ClampedInterpolationMaterial`)이 `renderer.toneMapping`과 `outputColorSpace`를 적용한다. `rasterizeScene`(기본 true)은 샘플이 쌓이기 전에 원래 장면을 래스터로 그린다                                                                                                                                                                     | `src/materials/fullscreen/ClampedInterpolationMaterial.js`, `WebGLPathTracer.renderSample`                          |
| 빌드·워커           | 동기 `setScene`은 워커가 필요 없다. `setSceneAsync`는 `setBVHWorker`로 워커를 따로 넘겨야 한다. index에서 닿는 코드에는 `import.meta.url`이 없다(`UVUnwrapper`에만 있다)                                                                                                                                                                                         | `src/core/WebGLPathTracer.js`, `PathTracingSceneGenerator.js`                                                       |
| `dispose`           | `WebGLPathTracer.dispose()`는 누적 타깃·Sobol 타깃·전체 화면 사각형만 해제한다. 경로 추적 재질의 데이터 텍스처(BVH·속성·재질·환경 CDF·샘플러), 저해상도 추적기, 배경색 텍스처는 **해제하지 않는다**(1단계 측정 참고)                                                                                                                                             | `src/core/WebGLPathTracer.js`, `PathTracingRenderer.js`                                                             |
| 장치 검사           | `CompatibilityDetector`(정밀도 검사와 재질 컴파일 검사)는 index에서 내보내지 않는다. `src/detectors/`를 직접 import해야 한다                                                                                                                                                                                                                                     | `src/detectors/CompatibilityDetector.js`                                                                            |
