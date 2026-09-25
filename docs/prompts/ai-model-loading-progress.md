# AI 모델 로딩 진행률(%) 표시: 모델을 불러오는 모든 화면

SJN에서 브라우저가 AI 모델을 내려받거나 준비하는 **모든 화면**에, 사용자가 **몇 %인지** 볼 수 있는 로딩 표시를 넣어줘. 첫 로딩은 오래 걸려도 된다. 그동안 진행률이 계속 보이고 멈춘 것처럼 보이지 않는 것이 목표다. 조사나 계획 설명에서 멈추지 말고 구현, 테스트, 문서 갱신, 결과 보고까지 끝낸다.

## 0. 현재 상태 (2026-09-25 코드 확인)

| 모델                                                                         | 어디서 불러오나                                                                                                                 | 진행 신호                                                                                                                                 | 지금 화면                                                                                            |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 배경 제거 (ONNX)                                                             | 자재 폼 → `BackgroundRemovalTest`(`src/components/materials/background-removal-test.tsx`), `src/lib/background-removal/*`       | `BackgroundRemovalProgress`: stage(loading-runtime·checking·download·initializing·processing·encoding), 다운로드 `loadedBytes/totalBytes` | **다운로드 단계에서만** `<progress>`와 MB 표시. 실행 엔진·초기화 단계는 문구만                       |
| 360° 입체화 (ONNX)                                                           | 자재 폼 → `Product3dEditor`(`src/components/materials/product3d-editor.tsx`), `src/lib/product3d/*`                             | `Product3dProgress`: 다운로드 바이트, 단계                                                                                                | 다운로드 `<progress>`만 있고 **% 숫자 없음**. 다른 단계는 문구만                                     |
| MoGe 형상 (ONNX, 약 140MB, Hugging Face)                                     | 사진으로 시작(`project-home` → `ReconstructionDialog`), 사진 다시 분석(`reconstruction-rebuild`), `/reconstruction-performance` | `MogeProgress`: checking·cache·downloading·verifying·loading-runtime·initializing·…, `loaded/total`, `cacheSource`                        | `cloud-quality.ts`가 단계 문구 끝에 `NN%`를 붙여 `onStage` 글로만 보낸다. **막대 없음, 전체 % 없음** |
| DeepLab 분할 (TFJS, `/models/deeplab-ade20k` 약 2.4MB + `/models/tfjs-wasm`) | 편집기 사진 자동 분석(`editor.tsx` `analyzePhoto` → `segmentRoom`), 사진 분석 파이프라인, `/reconstruction-performance`         | **없음**. `loadGraphModel`은 `onProgress`(0~1)를 지원하지만 쓰지 않는다                                                                   | 단계 문구만                                                                                          |

- 사진 분석의 Gemma(Cloudflare)와 AI 현장 사진 변환(FLUX)은 브라우저가 모델을 불러오지 않는다. 서버가 진행률도 주지 않는다. **이번 범위가 아니다**(7절에 제안만).
- 경로 추적 내보내기(`claude/pathtracer-spike`)는 아직 시험 단계다. 이번 작업의 공용 컴포넌트를 나중(5단계)에 재사용할 수 있게 만든다.

## 1. 먼저 읽는다

- `AGENTS.md`, `.agents/skills/sjn-workflow/SKILL.md`와 관련 references(프로젝트 설명, 개발 환경)
- `node_modules/next/dist/docs/`의 클라이언트 컴포넌트 관련 문서
- 위 표의 파일 전부. 특히 다음을 본다.
  - 각 `model-cache.ts`의 진행 이벤트 발생 방식(주기 80~120ms, 캐시 적중)
  - 워커 메시지 형식(`types.ts`, `protocol.ts`)
  - CPU 재시도(`cpuRetried`)와 취소 처리
- `src/lib/reconstruction/index.ts`의 `ReconstructionProjectOptions`(`onStage` 등), `cloud-quality.ts`, `geometry-browser-client.ts`, `src/lib/segmentation/index.ts`·`worker.ts`
- `src/app/globals.css`: 레이어 밖의 `p{margin:0}`가 Tailwind 여백을 덮는다. 표시 요소에는 `<p>` 대신 `<div>`를 쓴다.
- 관련 E2E: `e2e/background-removal*.spec.ts`, `e2e/product3d.spec.ts`, `e2e/reconstruction-analysis-profile.spec.ts`, 사진 분석·편집기 관련 spec. 모델 요청을 어떻게 모의하는지 본다.

## 2. 작업 환경

- `C:\app\SJN`의 main에서 새 브랜치 `claude/ai-model-loading-progress`를 만든다(워크트리 사용 가능).
- bare `git stash`는 쓰지 않는다. 커밋·푸시는 사용자가 요청할 때만 한다.

## 3. 구현

### 3-1. 공용 진행률 계산 (순수 함수, 단위 테스트 대상)

`src/lib/ai-progress.ts`(이름은 기존 구조에 맞게 정한다)

- **단계 가중치로 전체 %를 만든다.** 예: 실행 엔진 5 · 다운로드 80 · 검증 5 · 초기화 10.
  - 모델마다 실제 측정 시간을 보고 가중치를 정한다.
  - 캐시 적중이면 다운로드 몫은 캐시 읽기로 빠르게 채운다.
- **바이트를 아는 단계**(다운로드, 캐시 읽기)는 실제 비율을 쓴다.
  - 전체 크기를 모르면 모델 목록의 예상 크기를 쓴다.
  - 그것도 없으면 %를 추정하지 않고 "NN MB 받음"과 움직이는 표시를 쓴다.
- **신호가 없는 단계**(실행 엔진 로드, 세션 생성)는 끝날 때 그 몫을 채운다.
  - 오래 걸리면 경과 시간에 따라 몫 안에서 천천히 오르게 할 수 있다.
  - 이때 추정치임을 문구로 드러낼지 판단해 보고한다.
- **규칙**
  - %는 뒤로 가지 않는다.
  - 완료 전에는 최대 99%다.
  - 완료하면 100%를 잠깐 보인 뒤 다음 화면으로 넘어간다.
- **재시도·대체**(WebGPU 실패 → WASM/CPU 재시도 등): %를 0으로 되돌리지 않는다. 남은 구간 안에서 이어 가고 "다른 방식으로 다시 준비하는 중" 문구를 보인다.
- **여러 모델을 차례로 부르는 흐름**(사진 분석: DeepLab → MoGe)
  - "AI 모델 준비 1/2 · 45%"처럼 현재 모델과 전체를 함께 보인다.
  - 모델 준비가 끝난 뒤의 분석 단계(추론, Gemma 호출)는 %가 아니라 지금처럼 단계 문구로 둔다. 가능하면 "3/5 단계" 같은 순서를 붙인다.
- **화면 갱신 제한**: 100ms 또는 1%p 이상 바뀔 때만 상태를 갱신해 불필요한 재렌더를 막는다.

### 3-2. 공용 표시 컴포넌트 (Tailwind)

`ModelLoadingProgress`(이름은 기존 규칙에 맞춘다)

- 한 줄 제목(예: "배경 제거 AI 모델 준비 중"), **큰 % 숫자**, 막대
- 세부: "63.2 / 140.0 MB", 현재 단계 문구, 캐시 적중이면 "저장된 모델을 불러오는 중"
- 네트워크 첫 다운로드일 때 안내: "처음 한 번만 내려받아요. 다음부터는 저장된 모델을 써요." 캐시 정책상 저장하지 않는 모드(관리자 타인 프로젝트, 임시 분석)에서는 이 안내를 빼거나 맞게 바꾼다.
- 접근성
  - `role="progressbar"`, `aria-valuemin/max/now`, `aria-valuetext`(예: "MoGe 모델 45%, 63.2MB 중 140MB")
  - 화면 낭독기 알림(`aria-live="polite"`)은 10% 단위와 단계 변경 때만 한다.
- 390px 폭에서 넘침 없음, 어두운 테마 대응(기존 색 토큰 사용)
- 기존 취소 버튼과 오류 표시는 그대로 둔다. 취소하면 표시가 바로 사라진다.

### 3-3. 연결

- **배경 제거**: 다운로드만이던 막대를 공용 표시로 바꾼다. 실행 엔진 로드부터 초기화까지 전체 %로 보인다. 처리·인코딩 단계는 기존 문구를 유지한다.
- **360° 입체화**: 같은 방식으로 % 숫자와 전체 %를 보인다.
- **DeepLab**
  - 워커의 `loadGraphModel`에 `onProgress`를 연결한다.
  - wasm 실행 파일 로드도 단계로 넣는다.
  - 새 진행 메시지를 워커 프로토콜에 추가하고 `segmentRoom`에 선택 콜백을 더한다. 기존 `onStage` 문구 콜백은 유지한다.
- **MoGe**: `MogeProgress`를 문구로만 바꾸던 경로(`cloud-quality.ts`)에 더해, 구조화된 진행 콜백을 `ReconstructionProjectOptions`까지 올린다. 예: `onModelProgress`. 기존 `onStage`는 유지한다.
- **화면**
  - 사진으로 시작 대화상자(`ReconstructionDialog`), 사진 다시 분석(`reconstruction-rebuild`), 편집기 사진 자동 분석(`editor.tsx`의 감지 상태 표시), `/reconstruction-performance`(`BrowserAnalysisLab`)에 공용 표시를 넣는다.
  - 모델 준비가 끝나면 기존 단계 문구 표시로 돌아간다.
- **바꾸지 않는 것**
  - 모델 URL·파일, 무결성 검증, 캐시 정책(관리자·임시 분석의 `transient` 포함)
  - Hugging Face 요청의 `referrerPolicy: 'no-referrer'`, 취소·시간 제한, 로그인 요구
  - 진행 이벤트를 늘리려고 다운로드 방식을 바꾸지 않는다.

## 4. 반드시 지킬 조건

- AI 추론이나 클라우드 AI를 추가로 호출하지 않는다. 비용이 드는 외부 호출도 없다.
- 실제 모델 파일을 테스트마다 새로 내려받지 않는다. E2E는 모델 요청을 모의(작은 가짜 바이트를 천천히 스트리밍)하거나 기존 방식을 따른다.
- 사용자 입력이나 사진 데이터를 진행 이벤트·로그에 넣지 않는다.
- 줄바꿈은 작업 사본 CRLF, 저장소 LF다. Prettier는 쓰기에 `--end-of-line crlf --write`, 검사에 `--end-of-line auto`를 쓴다. typecheck 뒤 `next-env.d.ts`를 되돌린다.

## 5. 검증

- **단위 테스트**(새 파일): 진행률 계산
  - 가중치, 단조 증가, 99% 상한, 100% 완료
  - 전체 크기 모름, 캐시 적중, 재시도 이어 가기
  - 여러 모델 순서, 갱신 제한, MB·% 표기
- 기존 `model-cache`·워커 관련 단위 테스트가 그대로 통과해야 한다.
- **E2E**(모의 모델 응답): 화면마다 다음을 확인한다.
  1. 로딩 중 %가 보이고 늘어난다.
  2. `progressbar`의 aria 값이 맞다.
  3. 완료 뒤 사라지고 다음 단계로 넘어간다.
  4. 도중에 취소할 수 있다.
  5. 390px에서 넘침이 없다.
  - 대상: 자재 폼(배경 제거·입체화), 사진으로 시작, 사진 다시 분석, 편집기 사진 자동 분석, `/reconstruction-performance`
- `npm run typecheck`, `npm run lint`, 변경 파일 Prettier
- 전체 `npx vitest run`
  - 이미 알려진 환경 실패가 있다: `reconstruction-corpus` 해시, `reconstruction-source-plane-mapping` 기준 파일 없음, 로컬 D1/R2 첫 연결 5초 초과(`storage-server`, 가끔 `d1-storage`).
  - 그 밖의 실패가 없어야 한다.
- 3000번 포트를 먼저 확인한다. 포트 고갈(`TIME_WAIT`)로 인한 D1/R2 실패는 환경 문제로 구분한다.
- 화면 캡처: 화면마다 로딩 중 모습(데스크톱·390px)을 `test-results/ai-model-loading-progress/`에 남기고 직접 본다.

## 6. 문서

- 사용자에게 보이는 동작이 바뀌므로 `.agents/skills/sjn-workflow/references/project-overview.md`의 해당 설명을 맞춘다.
- 관련 문서의 로딩 설명을 갱신한다: `docs/material-images.md`(배경 제거·입체화), `docs/reconstruction-cloud-browser-setup.md`(MoGe·DeepLab).
- `docs/verification.md` 맨 위에 항목을 추가한다.

## 7. 보고

- 화면별 전후 캡처와 %가 움직이는 모습
- 모델별 단계 가중치와 근거(측정 시간)
- 추정 구간이 있는 단계와 그 표시 방식
- 파일마다 바뀐 코드와 이유, 테스트 결과(숫자, 실패 원인)
- **범위 밖 제안**: Gemma 분석·FLUX 변환처럼 서버가 진행률을 주지 않는 대기에는 실제 %를 보일 수 없다. "경과 n초"나 "보통 10초 정도 걸려요" 같은 표시가 필요한지 의견만 적는다.
- 커밋·푸시는 사용자가 요청할 때만 한다.
