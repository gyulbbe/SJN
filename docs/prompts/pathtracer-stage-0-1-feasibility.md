# 내보내기 고화질 렌더(경로 추적) 0~1단계: 사전 확인과 최소 장면 시험

> 보류됨. 코드는 `claude/pathtracer-spike` 브랜치(`8005b51`)에 있다. 결정: [경로 추적 보류 결정](../pathtracer-decision.md)

SJN의 3D 공간 렌더를 실제 사진에 가깝게 만들기 위해, 내보내기 전용 경로 추적(path tracing) 렌더가 **이 프로젝트에서 가능한지** 확인해줘. 이번 범위는 0단계(사전 확인)와 1단계(최소 장면 시험)까지다. 조사나 계획 설명에서 멈추지 말고 설치, 시험 코드, 측정, 결과 문서, 보고까지 끝낸다. **2단계(타일 굽기)는 시작하지 않는다.** 결과를 보고한 뒤 사용자가 계속할지 정한다.

## 0. 배경

- 편집기의 3D 렌더는 이미 사실감을 높였다(`2c7c7f9`, [결과 문서](../render-realism-results-20260925.md)): 방 좌표에 고정한 천장 조명, 절차적 환경맵, Neutral 톤 매핑, 마감별 광택, 줄눈 입체, 구석·접지 그림자.
- 그래도 래스터 렌더라 CG처럼 보일 수 있다. FLUX AI 변환은 사진 같지만 자재·구도를 바꿀 수 있다.
- 경로 추적은 빛이 여러 번 튀는 과정을 계산한다. 자재·치수를 바꾸지 않으면서 사진에 가깝고, 사용자 기기에서 돌아가 AI 호출 비용이 없다.
- 편집 화면은 지금처럼 빠른 래스터 렌더로 두고, **내보내기에서만** 쓰는 것이 목표다.

### 전체 계획 (이번에는 0~1단계만)

| 단계                  | 내용                                                       | 계속할지 판단 기준                         |
| --------------------- | ---------------------------------------------------------- | ------------------------------------------ |
| **0. 사전 확인**      | 라이브러리 설치·번들·브라우저 기능 확인, 범위와 목표 결정  | 설치·빌드되고 필요할 때만 불러올 수 있는가 |
| **1. 최소 장면 시험** | 빈 방 + 표준 변기 1개를 경로 추적, 시간·노이즈·메모리 측정 | 목표 시간 안에 보기 괜찮은 결과가 나오는가 |
| 2. 타일 굽기          | 셰이더로 계산하는 타일을 텍스처로 굽기                     | 무늬·색이 기존과 같은가                    |
| 3. 설비·제품 변환     | 표준 모형, 사진 제품, 입체 제품, 유리, 거울, 벽 구조       | 종류별 모양·색이 같은가                    |
| 4. 조명 설계          | 방 닫기, 천장 면 조명, 노출·톤 맞추기                      | 사실감이 확실히 좋아졌는가                 |
| 5. 내보내기 연결      | "고화질" 옵션, 진행률·취소·대체 경로                       | 멈춤·누수가 없는가                         |
| 6. 검증·문서          | 색 정확도, 기기별 시간, E2E                                | 배포 여부 결정                             |

### 이미 확인한 사실 (2026-09-25, 코드와 npm 조회)

- `three-gpu-pathtracer` 최신 0.0.24(2026-02-21 갱신)는 peer 의존성이 `three >=0.180.0`, `three-mesh-bvh >=0.7.4`, `xatlas-web ^0.1.0`이다. 이 저장소의 three는 0.185.1이다.
- **타일은 셰이더 안에서 계산된다.** `src/lib/room-viewer/surfaces.ts`의 `onBeforeCompile` 패치가 그리는 순간 다음을 모두 만든다.
  - 타일 아틀라스 선택, 무작위 타일, 엇갈림·회전·오프셋
  - 줄눈 색·폭, 줄눈 입체 노멀, 줄눈 거칠기·금속
  - 색 보정(`sjnAdjust`), 톤 매핑, 구석·접지 차폐
  - 경로 추적 라이브러리는 `onBeforeCompile`과 `ShaderMaterial`을 무시할 가능성이 크다. 0단계에서 확인한다.
- 설비(`src/lib/room-viewer/fixtures.ts`)도 색 보정·톤 매핑을 셰이더 패치로 넣는다. 사진 제품과 원본 색 메시는 일부러 빛을 받지 않는 `MeshBasicMaterial`이다.
- 조명(`src/lib/render/realistic-lighting.ts`)
  - `createRoomLightRig`: 천장 `SpotLight`(90° 원뿔, 반그림자 1, 방 좌표 고정)
  - 환경맵이 없을 때: `HemisphereLight`
  - `createInteriorEnvironment`: 작은 절차적 욕실 장면을 PMREM으로 거른 환경맵
- 카메라는 `src/lib/room-viewer/view-state.ts`의 `createRoomViewCamera`와 `roomViewViewport`, 기본 보기는 `defaultRoomView()`다. `RoomViewerRenderer.export(view, { format, mode, longEdge })`와 `fixtureBounds(width, height, view)`가 같은 카메라를 쓴다.
- 대상 프로젝트는 기본 공간·벽 구조처럼 3D 방이 있는 프로젝트다. 사진 기반 프로젝트는 배경이 실제 사진이라 대상이 아니다.
- 지금 브라우저 테스트는 SwiftShader(CPU 흉내 그래픽)로 돈다. 경로 추적 속도는 실제 GPU에서 따로 재야 한다.

## 1. 먼저 읽는다

`AGENTS.md`와 `.agents/skills/sjn-workflow/SKILL.md`, 관련 references(프로젝트 설명, 개발 환경)를 먼저 읽는다. 동적 import와 클라이언트 전용 코드는 `node_modules/next/dist/docs/`의 해당 문서로 확인한다(이 저장소는 vinext + Cloudflare Workers). 다음 파일도 읽는다.

- `src/lib/room-viewer/renderer.ts`
  - `setSnapshot`, `export`, `fixtureBounds`
  - Before/After 타깃과 후처리(`postMaterial`)
  - `environment`, 자원 해제(`dispose`)
- `src/lib/room-viewer/surfaces.ts`, `fixtures.ts`, `lighting.ts`(`ViewerLightingLut`: three 0.185.1 전역 DFG 텍스처가 닫힌 렌더러를 붙잡는 문제와 그 해결)
- `src/lib/render/realistic-lighting.ts`, `src/lib/room-viewer/view-state.ts`
- 문서: `docs/room-viewer-renderer-contract-20260914.md`, `docs/render-realism-results-20260925.md`
- 테스트 도구
  - `tests/run-browser-test.mjs`
  - `tests/render-realism-browser.ts`: `deltaE2000`, 영역 샘플링
  - `tests/flux-grounding-browser.ts`: esbuild 번들, Chrome 실행 옵션, `viewer.export`/`fixtureBounds` 사용 예

## 2. 작업 환경

- `C:\app\SJN`의 main에서 새 브랜치 `claude/pathtracer-spike`를 만든다(워크트리 사용 가능). 다른 작업 트리의 변경은 건드리지 않는다.
- bare `git stash`는 쓰지 않는다.

## 3. 0단계: 사전 확인

1. **라이브러리 조사**: 설치한 뒤 README, CHANGELOG, 타입 정의를 읽고 아래를 표로 정리한다.
   - 라이선스
   - peer 의존성 중 실제로 필요한 것. `xatlas-web`은 무엇에 쓰이고 없어도 되는지
   - 지원 재질 속성
     - `MeshStandardMaterial`/`MeshPhysicalMaterial`의 color·map·roughness·metalness·normalMap
     - alphaMap·alphaTest, transmission, emissive
     - `MeshBasicMaterial` 처리
   - 지원 조명
     - SpotLight(원뿔·반그림자), RectAreaLight, PointLight, DirectionalLight
     - HemisphereLight 지원 여부
     - 환경맵 형식: equirect만인지, PMREM cubeUV도 되는지
   - 무시되는 것: `onBeforeCompile`, `ShaderMaterial`, `customProgramCacheKey`
   - 노이즈 제거(denoise) 기능, 타일 단위 렌더, 샘플 수 조절, `dispose` API
2. **설치와 번들**
   - 필요한 패키지만 정확한 버전으로 설치한다.
   - `npm run build`가 되는지 확인한다.
   - 라이브러리가 **동적 `import()`로만 닿는 별도 청크**에 들어가는지 확인한다.
   - 청크 크기(원본·gzip)를 잰다. 기존 편집기 진입 번들 크기가 바뀌지 않는지(±1KB) 확인한다.
   - 분리가 안 되면 원인을 보고한다.
3. **브라우저 기능**
   - SwiftShader와 실제 GPU 각각에서 기록한다: WebGL2, `EXT_color_buffer_float`, `OES_texture_float_linear`, `MAX_TEXTURE_SIZE`, `WEBGL_debug_renderer_info`의 렌더러 이름.
   - 지원 안 되는 환경을 어떻게 감지해 기존 래스터 내보내기로 대체할지 적는다.
4. **범위·목표 제안**(보고서에 적고, 사용자가 나중에 확정한다)
   - 대상: 3D 방 프로젝트. 사진 기반은 제외한다.
   - 출력: 우선 긴 변 1024px. 2048px은 나중에 측정한다.
   - 시간 목표: 데스크톱 실제 GPU 30초 안
   - 편집 화면은 그대로 두고 내보내기 옵션으로만 넣는다.

**0단계 관문**

- 설치·빌드가 된다.
- 필요할 때만 불러온다.
- 필수 기능(재질 기본 속성, SpotLight 또는 대체 조명)을 지원한다.
- 막히면 1단계로 가지 않고 대안(다른 라이브러리, 직접 구현 규모)을 조사해 보고한다.

## 4. 1단계: 최소 장면 시험

### 장면

- `DEFAULT_ROOM`, 벽 구조 없음
- 타일 자재 없는 중립 면: 기존 `VIEWER_FACE_COLORS` 기본색
- 바닥에 표준 양변기 1개: `reconstruction` v2 toilet, 400×750×680mm, `#efefea`, 뚜껑 닫힘, 방 바닥 오른쪽
- 보기는 `defaultRoomView()`다. 래스터 비교본은 같은 스냅샷으로 `viewer.export(view, { format: 'png', mode: 'after', longEdge: 1024 })`를 쓴다.

### 같은 장면·카메라를 얻는 방법

경로 추적에는 내보내기와 **같은 Three 장면과 카메라**를 넘긴다.

- 권장: `RoomViewerRenderer`에 시험용 메서드를 하나 둔다. 예: 보기와 크기를 받아 After 장면 그래프와 카메라를 돌려주는 메서드.
  - 카메라 생성은 `render()`·`fixtureBounds()`와 같은 방식이어야 한다.
  - 기존 렌더 출력은 바뀌면 안 된다.
- 대안: 시험 하네스에서만 기존 빌더를 조립한다.
- 어느 쪽이든 이유를 적는다. 경로 추적 카메라의 투영·월드 행렬이 래스터 내보내기와 같은지 숫자로 확인한다.

### 재질·조명

- **재질**: 1단계에서는 셰이더 패치 없이 기본 재질 속성만 쓰인다고 보고, 래스터와 달라지는 점(색 보정·톤 매핑·차폐 없음)을 기록한다.
- **조명 A**: 기존 천장 `SpotLight`를 그대로 쓴다(지원되면). PMREM 환경맵과 `HemisphereLight` 대신 라이브러리가 지원하는 단순 환경(균일 또는 그라데이션 equirect)을 쓴다.
- **조명 B**: A에 천장 평면을 더해 방을 위쪽까지 닫는다. 카메라 쪽 앞면은 연다. 실제 욕실은 닫힌 공간이라 간접광 수렴이 느리다. 그래서 A·B 모두 측정한다.
- **출력**: Neutral 톤 매핑과 sRGB 출력이 경로 추적 결과에도 적용되는지 확인한다.

### 측정

- **환경**
  - 실제 GPU: 사용자 PC의 Chrome을 GPU 사용 옵션으로 띄운다(headed 또는 `--use-angle=d3d11` 등). 렌더러 이름을 기록해 실제 GPU였음을 남긴다. 시스템 설정은 바꾸지 않는다.
  - SwiftShader: 기존 옵션으로 16·32샘플만 돌려, 자동 테스트에서 쓸 수 있는지 본다.
  - 모바일은 여기서 잴 수 없으므로 미확인으로 적는다.
- **해상도·샘플**: 1024×683(3:2)에서 16·32·64·128·256·512샘플, 또는 60초까지 렌더한다. 샘플 수마다 PNG를 저장한다.
- **지표**
  - 시간: 각 샘플 수까지 걸린 초, 초당 샘플
  - 수렴(노이즈): k샘플과 2k샘플 이미지의 평균 절대차(0~255). 전체와 뒷벽 평탄 영역을 따로 잰다.
  - 구도: 변기 영역(`fixtureBounds` 상자) 안 실루엣이 래스터와 겹치는지. 행렬 일치와 함께 본다.
  - 색: 벽·바닥 평탄 영역의 래스터 대비 ΔE2000. 조명 차이로 달라지는 것이 정상이므로 기록만 하고 관문에 넣지 않는다(4단계 과제).
  - 자원: 한 페이지에서 3회 반복 렌더 후 `renderer.info.memory`와 라이브러리 자원이 늘지 않는지, 콘솔 오류, WebGL 컨텍스트 손실 여부
- **산출물**
  - 시험 스크립트 `tests/pathtracer-spike-browser.ts`를 `node tests/run-browser-test.mjs`로 실행한다.
  - 결과는 `test-results/pathtracer-spike/`에 둔다: 래스터 vs 64·256·512샘플 비교 시트, 샘플별 PNG, `metrics.json`.

### 1단계 관문(제안값, 측정 뒤 조정 가능)

1. 오류 없이 렌더되고, 방·변기가 래스터와 같은 구도다.
2. 실제 GPU, 1024px에서 **30초 안에** 수렴 지표 ≤ 2(0~255)이고, 눈으로 봐도 거친 노이즈가 없다(조명 B 기준).
3. 3회 반복 후 메모리 증가와 콘솔 오류가 없다.
4. 라이브러리는 필요할 때만 불러오고 기존 번들 크기는 그대로다.
5. 지원 안 되는 환경을 감지해 기존 내보내기로 대체할 수 있다.

타일 정확도(2단계)와 조명·색 품질(4단계)은 이번 관문에 넣지 않는다.

## 5. 반드시 지킬 조건

- **AI 호출은 하지 않는다.** 비용이 드는 외부 호출도 없다.
- **사용자에게 보이는 동작을 바꾸지 않는다.** UI 추가, 내보내기 변경, 편집 렌더 변경 모두 하지 않는다. 시험 코드는 격리한다. 운영 경로에서 라이브러리를 import하지 않는다.
- 새 패키지는 필요한 것만, 정확한 버전으로 추가하고 라이선스를 기록한다.
- 기존 테스트가 깨지지 않아야 한다. 렌더러를 건드렸다면 기존 출력이 같은지 확인한다(아래 검증).
- 시스템 설정(GPU 드라이버, 전원, 레지스트리)은 바꾸지 않는다. 테스트 브라우저 실행 옵션만 쓴다.
- 줄바꿈은 작업 사본 CRLF, 저장소 LF다. Prettier는 쓰기에 `--end-of-line crlf --write`, 검사에 `--end-of-line auto`를 쓴다. typecheck 뒤 `next-env.d.ts`를 되돌린다.
- 커밋·푸시는 사용자가 요청할 때만 한다.

## 6. 검증

- `npm run typecheck`
  - `.next/dev/types/validator.ts`가 반쯤 쓰여 문법 오류가 나면 `.next/dev/types`를 지우고 다시 돌린다.
  - 끝나면 `next-env.d.ts`를 되돌린다.
- `npm run lint`, 변경 파일 Prettier, `npm run build`(청크 분리 확인 포함)
- 렌더러 회귀: `node tests/run-browser-test.mjs tests/render-realism-browser.ts`, `node tests/run-browser-test.mjs tests/flux-grounding-browser.ts`
- 전체 `npx vitest run`
  - 이미 알려진 환경 실패가 있다: `reconstruction-corpus` 해시, `reconstruction-source-plane-mapping` 기준 파일 없음, 로컬 D1/R2 첫 연결 5초 초과(`storage-server`, 가끔 `d1-storage`).
  - 그 밖의 실패가 없는지 본다.

## 7. 문서와 보고

- `docs/pathtracer-spike-results-20260925.md`(실행일로 바꾼다)
  - 라이브러리 조사표, 환경(GPU 이름), 측정표, 비교 이미지 경로
  - 관문별 통과·실패와 근거
  - 발견한 제약(무시되는 셰이더 패치, 지원 안 되는 조명·환경맵)
  - 2단계 제안: 기존 타일 셰이더를 UV 공간에서 재사용해 색·노멀·거칠기 텍스처로 굽는 방법, 텍스처 크기 상한, 예상 위험
- `docs/verification.md`에 항목을 추가한다. 사용자 동작이 바뀌지 않으므로 `project-overview.md`는 고치지 않는다(시험 브랜치 사실만 기록).
- 사용자에게 보고할 것
  - 0·1단계 관문 결과를 한눈에
  - 시간·노이즈 수치와 비교 이미지(래스터 vs 경로 추적)
  - 번들 크기, 지원 안 되는 것
  - 추가·수정한 파일과 이유
  - 2단계로 갈지에 대한 의견
  - 2단계는 사용자가 정한 뒤에 시작한다.
