# 내보내기 사실감 1단계: 방 안 시점, 여러 장 겹쳐 찍기, 사진 효과

> 여러 장 사진 계획은 폐기됨(2026-09-26 사용자 결정). 실사 변환은 프로젝트 하나 기준이다.

SJN의 **After 이미지를 원하는 각도에서, 실제 방 사진처럼** 내보낼 수 있게 해줘. 경로 추적은 보류했다([결정 기록](../pathtracer-decision.md)). 이번에는 지금의 래스터 렌더러 위에서 동작하고 Windows Chrome 기본 환경(ANGLE D3D11)에서도 문제없는 방법으로 사실감을 올린다. 조사나 계획 설명에서 멈추지 말고 구현, 측정, 테스트, 문서, 보고까지 끝낸다.

## 0. 목표와 범위

- **사용자 요구 (2026-09-26)**
  - After만 여러 각도에서 보면 된다. Before는 여러 각도를 지원하지 않아도 된다.
  - 사진이 한 장이든 여러 장이든 같은 방식으로 동작해야 한다. 여러 장 사진 기능은 이후 단계다.
- **세 가지 작업**을 순서대로 한다. 각각 따로 쓸 수 있는 단위다. 작업마다 판단 기준을 확인하고 따로 커밋한다.
  1. **1-1 방 안 시점**: 방 안 눈높이에서 찍은 건축 사진 같은 구도로 After를 본다. 천장을 닫는다.
  2. **1-2 여러 장 겹쳐 찍기**: 내보낼 때만 조명과 카메라를 조금씩 흔들어 여러 장을 평균 낸다. 부드러운 그림자와 매끈한 윤곽을 얻는다.
  3. **1-3 사진 효과**: 약한 빛 번짐, 가장자리 어두움, 입자감을 넣고 끄고 켤 수 있게 한다.
- **바꾸지 않는 것**
  - 편집 화면의 실시간 렌더, 시안 카드 미리보기
  - 2D 합성 경로(벽 구조 없는 프로젝트의 편집 내보내기, 사진 합성)
  - 견적·수량 계산, 타일 배치 규칙, 저장 형식의 기존 값
- 호출 비용은 없다. AI 호출도 하지 않는다.

## 1. 현재 구조 (2026-09-26 main `dc06da4` 확인)

- **3D 렌더러**: `src/lib/room-viewer/renderer.ts`의 `RoomViewerRenderer`. `render()`는 실시간이고 `export(view, { format, mode: 'after' | 'compare', longEdge })`는 내보내기용이다. `fixtureBounds`는 FLUX 입력용이다.
- **여러 각도 After는 이미 받을 수 있다.** 편집기의 공간 둘러보기(`src/components/rooms/room-viewer.tsx`)가 현재 시점으로 `renderer.export(capturedView, { mode, longEdge: 4096 })`를 내려받는다. 사진 프로젝트에는 "저장한 사진 시점"(`projection: 'source-photo'`, `sourceCamera`)이 있다.
- **편집기 내보내기**(`editor.tsx`의 `captureExport`)는 벽 구조가 있을 때만 3D 렌더러를 쓴다(`projectDesignPreviewRoomContext`, `src/lib/render/design-preview-context.ts`). 나머지는 2D 합성이다.
- **시점**: `src/lib/room-viewer/view-state.ts`
  - `RoomViewState { version:1, sourceCamera?, projection?: 'source-photo'|'room-fit', quaternion, zoom(0.25~8), pan }`
  - `createRoomViewCamera`는 방 바깥에서 상자를 들여다보는 궤도 카메라다.
  - 저장 검증은 `src/lib/storage/validation.ts`(`quaternionSchema` 등)에 있다.
- **면**: 바닥·왼벽·뒷벽·오른벽만 있고 **천장과 앞벽이 없다.** 그래서 방 바깥의 빈 공간이 보인다. FLUX 비교에서도 이 영역을 AI가 흰 벽으로 멋대로 채웠다.
- **조명**: `src/lib/render/realistic-lighting.ts`
  - `createRoomLightRig`: 천장 높이 0.985 지점의 SpotLight, 그림자 1024², radius 5
  - `createInteriorEnvironment`: PMREM 환경맵
  - Neutral 톤 매핑
- **진행률 표시**: 방금 반영된 `src/components/model-loading-progress.tsx`(`useModelLoadingProgress`)와 그 추적기다. 표시 부분은 1-2의 내보내기 진행률에 재사용하거나 일반화한다.
- **참고 문서**: `docs/room-viewer-renderer-contract-20260914.md`, `docs/render-realism-results-20260925.md`, `docs/flux-export.md`

## 2. 먼저 읽는다

- `AGENTS.md`, `.agents/skills/sjn-workflow/SKILL.md`와 references(프로젝트 설명, 개발 환경), `node_modules/next/dist/docs/`의 관련 문서
- 1절의 파일 전부와 `src/lib/room-viewer/surfaces.ts`, `fixtures.ts`, `lighting.ts`(`ViewerLightingLut`: 닫힌 렌더러를 붙잡는 전역 텍스처 문제)
- 테스트
  - `tests/room-view-state.test.ts`, `room-viewer-*.test.ts`
  - `tests/room-viewer-render-browser.ts`, `room-viewer-resource-browser.ts`, `render-realism-browser.ts`, `flux-grounding-browser.ts`
  - `e2e/room-viewer.spec.ts`

## 3. 작업 환경

- `C:\app\SJN`의 main에서 새 브랜치 `claude/export-realism-stage-1`을 만든다(워크트리 사용 가능).
- bare `git stash`는 쓰지 않는다. 커밋은 작업마다 하나씩 한다. 푸시·main 병합은 사용자가 요청할 때만 한다.

## 4. 1-1 방 안 시점

- **새 시점 방식**: 방 안 카메라를 추가한다. 예: `projection: 'room-eye'`와 위치·방향·화각.
  - 기본값은 눈높이 1,500mm, 수평 시선(피치 0)이라 세로선이 곧게 선다. 화각은 풀프레임 24mm 상당(수평 약 74°)이다.
  - 위치는 방 안으로 제한한다(벽에서 최소 150mm). 방향은 **앞벽을 보지 않는 범위**로 제한한다. 앞벽에는 자재 정보가 없다.
  - 제한 범위는 측정해 정하고 근거를 적는다.
- **프리셋**: 공간 둘러보기에 "방 안 시점" 버튼 몇 개를 둔다. 예: 입구 가운데에서 뒷벽, 입구 왼쪽 모서리, 입구 오른쪽 모서리. 사용자가 조금 돌리거나 옮길 수 있게 한다. 기존 궤도 보기와 사진 시점은 그대로 둔다.
- **저장 호환**
  - `RoomViewState`를 넓힐 때 기존 저장 시점과 프로젝트를 그대로 읽어야 한다.
  - `normalizeRoomView`, 저장 검증 스키마, 캐시 키(`canonicalQuaternion` 등)를 함께 고친다. 이전 형식 호환 테스트를 넣는다.
- **천장**
  - 3D 보기에 중립 무광 흰색 천장 면을 추가한다. 견적·자재 적용·선택 대상이 아니다.
  - 기존 SpotLight 위치에 얇은 발광 등기구(원형 또는 사각 매입등)를 보이게 둔다.
  - 궤도 보기(방 바깥)에서는 지금처럼 천장이 없어야 한다. 위에서 내려다볼 때 가리면 안 된다. 방 안 시점에서만 켜는지, 카메라 위치에 따라 켜는지 정하고 이유를 적는다.
- **영향 확인**
  - `fixtureBounds`와 FLUX 입력(`e2e/flux-export.spec.ts`, `tests/flux-grounding-browser.ts`)이 새 시점에서도 맞는지 확인한다.
  - 공간 둘러보기의 After·비교 내려받기가 새 시점에서 되는지 확인한다.
  - 390px 화면에서 프리셋 버튼이 넘치지 않는지 확인한다.
- **판단 기준**
  - 방 안 시점 After에 방 바깥 빈 공간이 보이지 않는다.
  - 세로선이 곧다.
  - 기존 궤도 보기 렌더가 기준선과 픽셀 단위로 같다.
  - 이전 저장 시점이 그대로 열린다.

## 5. 1-2 여러 장 겹쳐 찍기 (내보내기 전용)

- `export()`에서만 N장을 그려 float 타깃에 평균 낸다. 실시간 `render()`와 시안 미리보기는 바꾸지 않는다.
  - **카메라**: 서브픽셀 흔들기로 윤곽 계단 현상을 없앤다.
  - **조명**: 천장 조명 위치를 등기구 크기(예: 600×600mm) 안에서 흔들고, 매번 그림자 맵을 다시 그린다. 넓은 광원의 부드러운 그림자가 된다.
  - 흔들기 순서는 Halton 같은 **고정 수열**을 쓴다. 같은 장면은 항상 같은 결과가 나와야 한다.
  - 비교(`compare`) 내보내기는 Before·After 양쪽에 같은 방식을 쓴다.
- **N과 해상도**
  - 실제 GPU(Iris Xe, **D3D11 기본값**, 전원 연결 상태 기록)와 SwiftShader에서 1024·2048·4096 각각 N=8·16·32·64의 시간과 메모리를 잰다.
  - 4096 half-float 누적 타깃은 약 128MB다. 내장 GPU에서 부담되면 타일로 나눠 누적하거나 N을 줄인다.
  - 목표: Iris Xe D3D11, 4096에서 약 10초 안. 넘으면 기본 N·해상도 조합을 조정하고 근거를 적는다.
- **진행률**: 몇 %인지 보이게 한다(1절의 진행률 표시 재사용). 취소하면 즉시 멈추고 자원을 해제한다. 창을 닫아도 같다.
- **대체**: float 렌더 타깃이 없거나 실패하면 지금처럼 한 장으로 내보내고 이유를 기록한다.
- **판단 기준**
  - 타일 평탄 영역의 색이 한 장 렌더 대비 ΔE2000 ≤ 1이다. `render-realism-browser.ts`의 측정을 재사용한다.
  - 그림자 경계가 눈에 띄게 부드럽다. 설비 아래 그림자 폭이나 경계 기울기로 수치화한다.
  - 윤곽 계단이 줄었다.
  - 3회 반복 내보내기 후 자원이 늘지 않는다.

## 6. 1-3 사진 효과

- 조명·반사 하이라이트에만 약한 빛 번짐(bloom), 가장자리 어두움(vignette), 약한 입자감(grain), 부드러운 톤 곡선을 넣는다.
- 공간 둘러보기와 편집기 내보내기에 **"사진 효과" 켜기/끄기**를 둔다.
  - 기본값은 켬이다. 견적용으로 쓸 효과 없는 원본은 같은 창에서 끄고 받을 수 있다.
  - 선택 상태를 기억할지(브라우저 저장)는 판단해 적는다.
- **색 보존**
  - 화면 가운데 60% 영역의 타일 색은 효과 없는 결과 대비 ΔE2000 ≤ 2여야 한다.
  - 입자감은 고정 씨앗을 써서 같은 장면이 같은 결과를 내게 한다.
- **AI 현장 사진 변환(FLUX) 입력**에는 사진 효과를 넣지 않는다. 겹쳐 찍기는 적용해도 되는지 측정하고 판단한다(입력 크기가 496px라 영향이 작을 수 있다).
- **판단 기준**: 효과 켬/끔 비교 이미지에서 사진 같은 느낌이 늘고, 위 색 보존 조건을 지킨다.

## 7. 반드시 지킬 조건

- 실시간 편집 렌더, 시안 미리보기, 2D 합성 출력은 기준선과 픽셀 단위로 같아야 한다. 바뀌면 원인을 찾아 없앤다.
- 저장된 프로젝트와 시점을 그대로 읽어야 한다. 이전 형식을 거부하거나 조용히 초기화하지 않는다.
- 렌더러 자원 해제 규칙을 지킨다(`ViewerLightingLut`, 컨텍스트 손실, 취소 중 해제). 새 타깃·텍스처는 모두 해제한다.
- 시스템 설정과 Chrome 전역 플래그는 바꾸지 않는다. 실제 GPU 측정은 테스트 브라우저 실행 옵션으로만 한다. 기본 백엔드 D3D11에서 먼저 잰다.
- Tailwind를 우선 쓴다. `globals.css`의 `p{margin:0}` 때문에 여백이 필요한 표시 요소는 `<div>`로 만든다.
- 줄바꿈은 작업 사본 CRLF, 저장소 LF다. Prettier는 쓰기에 `--end-of-line crlf --write`, 검사에 `--end-of-line auto`를 쓴다. typecheck 뒤 `next-env.d.ts`를 되돌린다.

## 8. 검증

- **단위**
  - 시점 스키마(새 방식, 이전 형식 호환, 범위 제한)
  - 방 안 카메라 행렬(세로선 수직, 앞벽 미포함)
  - 흔들기 수열 결정성, 효과 파라미터 범위
- **브라우저**
  - `room-viewer-render-browser.ts`, `room-viewer-resource-browser.ts`, `render-realism-browser.ts`(실시간 렌더 픽셀 불변), `flux-grounding-browser.ts`
  - 새 비교 스크립트: 같은 장면을 기존 궤도 한 장, 방 안 시점 한 장, 겹쳐 찍기, 사진 효과로 뽑아 `test-results/export-realism-stage-1/`에 나란히 저장한다. ΔE·그림자·시간 수치도 남긴다.
  - 이미지는 직접 열어 확인한다.
- **E2E**: `e2e/room-viewer.spec.ts` 확장
  - 프리셋 버튼, 방 안 시점 내려받기
  - 진행률 % 증가, 취소, 사진 효과 켜기/끄기
  - 390px 넘침 없음, 저장 시점 새로고침 유지
  - 기존 `flux-export`, `room-*` spec도 통과해야 한다.
- `npm run typecheck`, `npm run lint`, 변경 파일 Prettier
- 전체 `npx vitest run`
  - 이미 알려진 환경 실패가 있다: `reconstruction-corpus` 해시, `reconstruction-source-plane-mapping` 기준 파일 없음, 로컬 D1/R2 첫 연결 5초 초과.
  - 391px "직접 구성" 흐름의 내보내기 버튼 E2E 실패는 원래 있던 것이다.
  - 그 밖의 실패가 없어야 한다.
- 3000번 포트와 `TIME_WAIT` 수를 먼저 확인한다. 포트 고갈로 인한 실패는 환경 문제로 구분한다.

## 9. 문서와 보고

- `docs/export-realism-stage-1-results-<실행일>.md`
  - 작업별 전후 비교 이미지 경로와 수치(ΔE, 그림자 폭, 시간, 메모리)
  - 정한 기본값(N, 해상도, 효과 세기, 시야 제한)과 근거
- `docs/room-viewer-renderer-contract-20260914.md`(또는 새 계약 문서)에 방 안 시점, 천장, 내보내기 누적 규칙을 적는다.
- 사용자에게 보이는 동작이 바뀌므로 `.agents/skills/sjn-workflow/references/project-overview.md`의 렌더링·내보내기 설명을 맞춘다.
- `docs/verification.md` 맨 위에 항목을 추가한다.
- **보고**
  - 작업 1-1·1-2·1-3별 판단 기준 결과와 비교 이미지
  - 파일별 변경과 이유, 테스트 결과(숫자, 실패 원인)
  - 남은 한계. 예: 앞벽 방향 시점, 사진 합성 프로젝트는 대상 밖
  - 다음 단계 제안: 2-0 여러 장 사진 효과 실험
