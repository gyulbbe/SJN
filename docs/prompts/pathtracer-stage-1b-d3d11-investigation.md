# 경로 추적 1b단계: D3D11 검은 출력 원인과 로딩 진행률 가능성 확인

> 이 문서는 `.claude/worktrees/pathtracer-spike/docs/prompts/pathtracer-stage-1b-d3d11-investigation.md`의 이전 판을 대체한다. 작업을 시작하면 이 내용으로 그 파일을 덮어쓴다.

[0~1단계 결과](../pathtracer-spike-results-20260925.md)에서 `three-gpu-pathtracer@0.0.24`는 설치·번들·구도·자원 면에서는 쓸 만했다. 그러나 두 가지가 막혔다.

- **Windows Chrome 기본 백엔드(ANGLE D3D11, Intel Iris Xe)에서 물체 픽셀이 전부 (0,0,0,0)** 으로 나왔다.
- 첫 셰이더 준비가 약 3분 걸렸다.

이번 작업은 **2단계(타일 굽기)로 갈지 결정할 근거**를 만든다. 아래 질문을 순서대로 풀고, 중단 조건에 걸리면 그 자리에서 멈추고 보고한다. 2단계는 시작하지 않는다.

## 0. 이번에 바뀐 기준 (사용자 결정, 2026-09-25)

- **첫 로딩은 오래 걸려도 된다.** 다만 **몇 %인지 사용자에게 계속 보여야 한다.** 그래서 "30초 안 컴파일"은 더 이상 중단 조건이 아니다. 대신 두 가지를 본다.
  - 진행률을 표시할 수 있는가
  - 그동안 화면이 멈추지 않는가
- **웹 페이지는 ANGLE 백엔드를 고를 수 없다.** 실제 사용자는 Windows Chrome 기본값인 D3D11을 쓴다.
  - `--angle=gl` 등 다른 백엔드에서 정상이어도 해결책이 아니다. 원인을 가리는 진단용으로만 쓴다.
  - 결론은 반드시 D3D11 기준으로 낸다.

## 1. 먼저 읽는다

- `AGENTS.md`, `.agents/skills/sjn-workflow/SKILL.md`
- [0~1단계 결과](../pathtracer-spike-results-20260925.md): 조사표, 측정값, 발견한 제약
- 시험 코드
  - `tests/pathtracer-spike-page.ts`: `trace`, `diagnose`, `silhouette`, `cycle`, `deepDispose`
  - `tests/pathtracer-spike-browser.ts`: 실행 옵션
- 시험용 렌더러 메서드: `src/lib/room-viewer/renderer.ts`의 `exportFrame`
- 라이브러리 소스
  - `node_modules/three-gpu-pathtracer/src/core/WebGLPathTracer.js`: `setScene`/`setSceneAsync(…, { onProgress })`, `renderSample`, 컴파일
  - `src/materials/pathtracing/PhysicalPathTracingMaterial.js`: 주 루프, `matte`, `DEBUG_MODE`
  - `src/shader/structs/material_struct.glsl.js`

## 2. 작업 환경

- 브랜치 `claude/pathtracer-spike`, 작업 트리 `.claude/worktrees/pathtracer-spike`에서 이어서 한다. 이전 변경은 아직 커밋되지 않았다. 초기화하지 않는다.
- bare `git stash`는 쓰지 않는다. 커밋·푸시는 사용자가 요청할 때만 한다.
- 이전 측정은 배터리 상태(`BatteryStatus=1`)였다. 시작할 때 사용자에게 전원 연결을 요청하고 상태를 기록한다.

실행 예:

```text
node tests/run-browser-test.mjs tests/pathtracer-spike-browser.ts gpu --label=<이름> --profile=<프로필> --diagnose=4
node tests/run-browser-test.mjs tests/pathtracer-spike-browser.ts gpu --angle=gl --label=gpu-gl --profile=gl --diagnose=4
node tests/run-browser-test.mjs tests/pathtracer-spike-browser.ts gpu --lightings=B --checkpoints=16,32,64,128,256,512 --max-seconds=400 --label=<이름>
```

- `--diagnose=N[:debugMode]`: N샘플 뒤 누적 float 값(벽·변기·바닥·배경)과 재질 플래그를 `diagnose-*.json`에 쓴다.
- `--profile=<이름>`: `test-results/pathtracer-spike/profiles/<이름>`을 Chrome 프로필로 써서 셰이더 캐시를 다음 실행까지 남긴다.
- `--angle=<백엔드>`: 진단용 ANGLE 백엔드 선택이다.

## 3. 질문과 중단 조건 (순서대로)

### 질문 1. 라이브러리 예제 수준의 최소 장면도 D3D11에서 검게 나오는가?

- 장면: 구 하나 + 바닥 평면, m 단위, `MeshStandardMaterial`(단면), 균일 환경, 기본 설정. 이 저장소의 방·설비 코드는 쓰지 않는다.
- D3D11에서 `--diagnose=4`와 `--diagnose=4:1`(`DEBUG_MODE 1`, 경로 깊이 출력)을 돌린다.
- **검게 나오면** 라이브러리·ANGLE·드라이버 쪽 문제다. 아래 세 가지만 추가로 확인한다.
  1. 같은 최소 장면을 `--angle=gl`로 한 번 그린다(원인이 D3D11에 한정되는지 확인).
  2. `three-gpu-pathtracer`·`three-mesh-bvh`의 바로 이전과 최신 버전을 시험용으로 한 번 비교한다. 끝나면 `0.0.24`·`0.9.15`로 되돌린다.
  3. upstream(gkjohnson/three-gpu-pathtracer, ANGLE)에서 같은 증상을 찾아 링크와 요약을 적는다. 이슈를 새로 올리지는 않는다.
  - 그래도 D3D11에서 검으면 **중단**하고 보고한다(6절).
- **정상이면** 우리 장면 쪽 문제다. 질문 2로 간다.

### 질문 2. 우리 장면의 어떤 요소가 D3D11 출력을 망가뜨리는가?

- `exportFrame` 장면에서 요소를 하나씩 바꿔 가며 D3D11 `--diagnose=4`를 본다. 결론이 나면 멈춘다.
  1. 단위: mm → m로 축소(루트 스케일 0.001)
  2. 재질 면: `DoubleSide` → `FrontSide`. 천장은 양면이 필요했으니 두 장의 단면으로 대체한다.
  3. 텍스처: 텍스처 없는 재질만 있는 경우 빈 텍스처 배열인지 확인하고, 1×1 더미 텍스처를 넣어 본다.
  4. 형상: 변기 템플릿 형상 ↔ 단순 상자
  5. 조명: SpotLight만 / 환경만 / 둘 다
- 원인을 찾으면 **시험 코드의 장면 변환 단계에서 우회**한다. 운영 코드는 바꾸지 않는다. D3D11에서 정상 출력(물체 픽셀 ≠ 0, 실루엣 IoU ≥ 0.9)을 확인한다.
- 위 목록으로 못 찾으면 **중단**하고, 좁힌 범위를 보고한다.

### 질문 3. 첫 로딩 동안 진행률(%)을 보여 줄 수 있는가? (30초 기준 대체)

D3D11 정상 출력 설정에서 첫 로딩을 단계별로 잰다.

- **단계 목록**
  - 장면 변환
  - BVH 생성: `setSceneAsync`의 `onProgress`로 진행률이 나오는지 확인한다. 워커가 필요하면 `setBVHWorker`도 시험한다.
  - 재질·텍스처 업로드
  - 셰이더 컴파일(냉간)
  - 첫 샘플
  - 목표 샘플까지 누적
- **캐시**: 같은 `--profile`로 두 번 연달아 실행해, 두 번째 실행의 단계별 시간을 잰다(디스크 셰이더 캐시 효과).
- **화면 멈춤**: 각 단계 동안 메인 스레드가 얼마나 막히는지 잰다. Long Tasks API와 `requestAnimationFrame` 간격을 쓴다. 특히 셰이더 컴파일과 첫 `renderSample` 호출을 본다.
  - `KHR_parallel_shader_compile` 지원 여부와, three `compileAsync`가 실제로 막힘 없이 기다리는지 확인한다.
  - 한 번에 1초 넘게 막히면 % 표시가 멈춘다. 이때는 워커 + `OffscreenCanvas`로 경로 추적을 옮기는 방식을 최소 장면으로 시험한다. 메인 스레드 막힘이 사라지는지, 결과가 같은지 본다.
- **% 모델 설계와 시험 표시**
  - 단계별 가중치로 전체 %를 만든다.
  - 측정 가능한 단계(BVH, 샘플 수)는 실제 값을 쓴다.
  - 컴파일처럼 진행 신호가 없는 단계는 예상 시간 대비 경과로 추정한다. 이전 측정값이 있으면 그것을 쓰고, 끝나기 전에는 최대 95%에서 멈춘다.
  - %는 뒤로 가지 않아야 한다.
  - 시험 페이지에 %와 단계 이름 표시를 붙여, 로딩 내내 갱신되는지 기록한다(초당 갱신 횟수, 최장 멈춤). 운영 UI는 만들지 않는다. 운영 표시는 [AI 모델 로딩 진행률](ai-model-loading-progress.md) 작업의 공용 컴포넌트를 5단계에서 재사용한다.
- **판단**
  - 첫 로딩 내내 %가 1초 넘게 멈추지 않고 갱신되면 통과다. 총 시간은 기록만 한다.
  - 워커로 옮겨도 멈춤을 없앨 수 없으면 **중단**을 권한다.

### 질문 4. (1~3 통과 시) D3D11에서 1단계 측정 다시 하기

- 조명 A·B 모두 16~512샘플
- 수렴: k샘플과 2k샘플 평균 절대차 ≤ 2. 이번에는 컴파일이 끝난 뒤부터 30초 안인지 본다.
- 실루엣 IoU, ΔE2000(기록만), 3회 반복 자원(deep dispose)

### 질문 5. 오동작 자가 검사

- 확장 검사와 `CompatibilityDetector`는 D3D11 오동작을 못 잡았다. 64×64의 아는 색 평면을 1~2샘플 그려 값을 확인하는 자가 검사를 시험 코드에 넣는다.
- 우회 전(검은 출력) 설정과 우회 후(정상) 설정에서 판정이 각각 맞는지 기록한다.
- 자가 검사 시간이 첫 로딩에 얼마나 더해지는지도 적는다.

## 4. 반드시 지킬 조건

- AI 호출과 비용이 드는 외부 호출은 없다.
- 사용자에게 보이는 동작(UI, 내보내기, 편집 렌더)을 바꾸지 않는다. 운영 경로에서 라이브러리를 import하지 않는다.
- 시스템 설정(GPU 드라이버, 전원, 레지스트리)과 Chrome 전역 플래그는 바꾸지 않는다. 테스트 브라우저 실행 옵션만 쓴다.
- 시험용으로 설치한 다른 버전은 끝나면 `0.0.24`·`0.9.15`로 되돌린다. `package.json`과 lock 차이가 이전 상태와 같은지 확인한다.
- 줄바꿈은 작업 사본 CRLF, 저장소 LF다. Prettier는 쓰기에 `--end-of-line crlf --write`, 검사에 `--end-of-line auto`를 쓴다. typecheck 뒤 `next-env.d.ts`를 되돌린다.
- 결과 문서의 표 안에 `|`가 들어가면 칸이 깨진다. 수식은 표 밖에 쓰거나 `\|`로 이스케이프한다. 기존 결과 문서의 "레이 오프셋" 줄도 같은 이유로 깨져 있으니 고친다.

## 5. 검증

- `npm run typecheck` 후 `next-env.d.ts`를 되돌린다. 변경 파일에 ESLint와 Prettier를 돌린다.
- `renderer.ts`를 다시 건드렸다면 다음을 확인한다.
  - `render-realism-browser.ts` 기준선 대비 픽셀 차이 0
  - `flux-grounding-browser.ts`, `room-viewer-render-browser.ts` 통과

## 6. 문서와 보고

- **`docs/pathtracer-spike-results-<실행일>-d3d11.md`**
  - 질문별 결과와 근거, 멈춘 지점
  - 백엔드별 출력(진단용), 원인 또는 좁힌 범위, upstream 링크
  - 첫 로딩·두 번째 로딩의 단계별 시간, 메인 스레드 최장 막힘, % 갱신 기록, 워커 시험 결과
  - (통과 시) D3D11 1단계 수치, 자가 검사 결과
- **`docs/verification.md`** 맨 위에 항목을 추가한다.
- **사용자 보고**
  - D3D11에서 쓸 수 있는지(예/아니오/조건부와 조건)
  - 첫 로딩과 두 번째 로딩 시간, % 표시가 끊김 없이 되는지
  - 2단계 진행 의견. 중단한다면 대안을 적는다: 래스터 렌더 추가 개선, FLUX 실제 프로젝트 확인·개선, 사실감 작업 중단. WebGPU·서버 렌더는 비용·규모와 함께 적는다.
