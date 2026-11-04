# 내보내기 "AI로 현장 사진처럼": 방법 시험과 선별 (2026-11-04~)

내보내기 AI 변환을 더 실제 현장 사진처럼 만들 방법을 같은 장면, 같은 기준으로 시험한다. 앱은 바꾸지 않는다(화면·라우트·계약·렌더러·저장 형식·배포 그대로). 도구는 `tests/export-photoreal/`, 결과 자료는 본 폴더 `test-results/export-photoreal/`(git 제외)에 있다.

## 1. 사용자 결정

| 질문 | 결정(2026-11-04) |
| --- | --- |
| 무엇을 먼저 볼까 | 설계 유지 우선: 타일·제품·배치가 그대로인 결과 중 가장 사진 같은 것 |
| AI 예산 | 10,000뉴런, 이틀 이상. 하루 6,000 이하. 9B 없음 |
| AI 없이 렌더러만 | 가능성만 짧게(반나절, 작은 장면) |
| 장면 | 시험 장면 10개(개발 8, 마지막 확인 2) |

## 2. 명세·코드와 달랐던 것

- **계정 집계를 읽을 수 없다:** 본 폴더와 워크트리의 `.dev.vars`에 `CLOUDFLARE_ACCOUNT_ID`·`CLOUDFLARE_ANALYTICS_TOKEN`이 이름만 있고 값이 비어 있다. 그래서 장부 추정만 적는다. 값이 들어오면 `usage.ts`로 모델별 실제 뉴런을 함께 적는다. SD 계열은 비용을 확인할 수 없어 모델당 1회만 부른다(3절).
- **가격표:** `wrangler ai models list --json`(2026-11-04)에 FLUX 세 모델은 가격 항목이 없다(partner). 그래서 이전 문서의 공식 요금표 값(4B 입력 타일 5.37, 출력 타일 26.05)을 쓴다. SD 네 모델은 "beta, 단계당 $0"으로 나온다. flux-2-dev는 가격을 다시 읽을 수 없어 명세대로 뺀다.
- **SD 스키마:** 네 모델 모두 `prompt, negative_prompt, height, width, image, image_b64, mask, num_steps, strength, guidance, seed`를 받고 PNG를 돌려준다(`wrangler ai models schema`). `stable-diffusion-v1-5-img2img`는 목록에 없다(6002).
- **이전 결과:** `test-results/tile-regions/`에는 `render-baseline`만 있고 2026-10-22 실제 AI 결과가 없다.
- **AI 없는 렌더 비교:** 일반 3D 다운로드는 공간 둘러보기 시점·회색 배경이다. 비교를 맞추려고 같은 궤도 시점에서 32장 겹쳐 찍기 + 사진 효과(`PHOTO_EFFECTS`)로 그리고 흰 배경에 얹었다.
- **CLIP을 WebGPU로 돌리면 답이 틀린다:** q8 CLIP을 onnxruntime-web 1.29.0 WebGPU로 돌리면 틀린 값이 나왔다(2026-11-04).
  - 글 쪽은 모든 문장이 시작 토큰 값이 됐다.
  - 이미지 쪽은 다른 그림에 같은 벡터를 냈다.
  - 그래서 CLIP은 WASM으로 돌린다. 다른 브라우저 모델에도 같은 일이 있을 수 있어, 결과 값을 따로 점검한다.

## 3. 탈락 기준 (라운드를 돌리기 전에 적음)

결과를 본 뒤 낮추지 않는다. 바꿀 때는 이유를 적고 사용자에게 묻는다.

- **2라운드(소량 확인) 4B 변형:** 같은 장면 3개(흰 타일·숯색 타일·실제 제품 사진), seed 424242에서 지금 방식과 비교한다. 다음 중 하나면 탈락이다.
  - 구도 정렬 0.4 미만(배경 되돌리기·색 보정을 못 함)인 장면이 지금 방식보다 많다.
  - 제품이 사라지거나 바뀐 수가 지금 방식보다 많다. 판정은 제품 상자 안 BiRefNet 윤곽 겹침이 0.5 미만이거나 Gemma 확인이 "없음/다른 것"인 경우다.
  - 큰 추가 물건(유리 칸막이·창문·문·벽 조각, Gemma 확인)이 지금 방식보다 1개 넘게 많다.
  - 짧은 사람 평가에서 "내 설계와 같은가" 평균이 지금 방식보다 1점 이상 낮다.
  - 남은 변형 중 "실제 사진 같은가" 평균이 가장 높은 1개를 3라운드로 올린다. 지금 방식보다 높은 것이 없으면 올리지 않는다.
- **2라운드 SD 계열(모델당 1회, 흰 타일 장면):** 다음 중 하나면 탈락이다.
  - 입력을 무시했다(구도 정렬 0.2 미만).
  - 구도가 바뀌었다(정렬 0.4 미만).
  - inpainting이 마스크를 무시했다(제품 픽셀이 평균 10 넘게 바뀜).
  - 비용을 확인할 수 없다. 계정 집계가 없으면 그 모델은 더 부르지 않고 "비용 미확인"으로 남긴다.
  - 1회에서 통과해도 3라운드에는 계정 집계로 1장 220뉴런 이하가 확인될 때만 올린다.
- **추천(5·6라운드, 설계 유지 우선):** 방법마다 같은 장면·seed 묶음의 사람 평가로 판단한다.
  1. "내 설계와 같은가" 평균이 지금 방식보다 0.2 넘게 낮지 않다.
  2. 큰 문제(제품 바뀜·사라짐, 물건 추가, 구도 바뀜) 표시 비율이 지금 방식 이하다.
  3. 1·2를 넘은 것 중 "실제 사진 같은가" 평균이 가장 높은 것을 고른다.
  4. 지금 방식을 바꾸자고 하려면 "실제 사진 같은가"가 0.5 이상 높아야 한다. 아니면 "지금 방식 유지"다.
  5. 마지막 확인(남긴 장면 2개 × seed 2)에서 고른 방법이 1·2를 다시 넘는지 본다. 넘지 못하면 그렇게 보고하고 조정하지 않는다.
- **뒤처리(ⓐ 빛만 AI, ⓑ 위치별 색, ⓒ 확대):** 같은 결과에 적용 전후를 사람이 평가한다. 다음을 모두 만족하면 채택이다.
  - "실제 사진 같은가"가 0.3 이상 오른다.
  - "내 설계와 같은가"가 0.2 넘게 내려가지 않는다.
  - 문제 표시가 늘지 않는다.
- **ⓓ 자동 고르기:** seed 2장 중 자동 점수로 고른 쪽이 사람 평가 합(사실감 + 설계)에서 높은 경우가 60% 이상이면 채택이다. 그 자동 점수의 사람 평가 상관이 0.5 이상이어야 한다.
- **자동 점수:** 사람 평가와 Spearman 순위 상관이 0.5 이상인 점수만 선별에 쓴다. 상관값은 모두 적는다.
- **렌더러 가능성:** 다음이면 "해볼 만함"이다.
  - WebGPU 화면 효과가 이 PC(실제 GPU 어댑터)에서 깨지지 않고 그려진다.
  - 사람 평가에서 32장 렌더보다 "실제 사진 같은가"가 0.5 이상 높다.
  - 경로 추적은 지금 Chrome(D3D11)에서 검은 화면이 사라졌거나, 라이브러리에 WebGPU 경로가 생겼으면 "다시 볼 만함"이다.

## 4. 장면

공개 자재 스냅숏(`test-results/catalog-match/snapshot`, 2026-11-02)의 타일·제품으로 만들었다. 앱의 배치 함수(`createPlacedFixture`·`createRoomPlacement`·`projectRoomFixture`, `projectReconstructionFixture`, `applyRoomSurfaceRegion`, 벽 구조, SMC 천장)를 그대로 쓴다. 캡처는 변환 창과 같다: 궤도 정면(옆 장면만 오른쪽), 렌즈 20°, 흰 배경, 1024px → 모델 입력 496×336.

| 장면 | 벽 / 바닥 | 제품 | 비고 |
| --- | --- | --- | --- |
| 흰 타일 | DWJ 9854 흰색 600×300 / FOR-GRIGIO 600 | 표준 변기·벽걸이 세면대·핸드 샤워 | |
| 숯색 타일 | HE 텍스처 테트라 블랙 750×250 / 66517 | 같음 | |
| 무늬 타일 | DWJ 9829 회색 줄무늬 / FOR-GRIGIO | 변기·세면대 | |
| 부분 타일 | 흰색 + 뒷벽 민트 세로 띠(900mm) | 변기·세면대 | |
| 벽 구조 | HS 3654 흰 유광 | 변기·세면대 | 뒷벽 닫힌 벽감, 오른벽 선반(높이 1,000) |
| SMC 천장 | DW 9453 물결 / 66517 | 변기·세면대·샤워 | 천장 보임 |
| 실제 제품 사진 | HS 비비드 화이트 / FOR-GRIGIO | LAUCHE 아크 투피스 변기, 지니 LL-801 세면대(사진) | C 대상 없음 |
| 좁은 방 | 흰색 / 66517 | 변기·세면대 | 1,200×2,400 |
| (마지막) 큰 방 | HE 미티올 그리스 / FOR-GRIGIO | 욕조·샤워·변기·세면대 | 3,000×2,400 |
| (마지막) 옆 장면 | HE 미티올 크레마 / 66517 | 변기·세면대 | 오른쪽 궤도 |

- 프롬프트는 2,051~2,394자다(상한 2,400). 장면 정보는 모두 스키마를 통과했다.
- 지금 방식 재현: 개발 8장면 모두 `buildFluxPrompt`와 문자열이 같고, 입력 크기가 `fluxInputLayout`과 같다(`tests/export-photoreal.test.ts`).

## 5. 라운드별 결과

### 1라운드 — AI 없음

- **AI 없는 렌더 기준선:** 장면마다 `render32.png`(32장 + 사진 효과)
- **브라우저 모델(`lab-check.json`, WebGPU 어댑터 정보는 headless에서 비어 있음)**
  - **CLIP "실제 사진" 확률:**
    - 3D 렌더는 중앙값 0.041(0.015~0.126), 32장 렌더는 0.021이다.
    - 이전 실제 FLUX 결과 27장은 중앙값 0.035(0.011~0.211)다.
    - 렌더와 FLUX 결과를 가르지 못한다. 사람 평가와의 상관을 보고 정하지만, 선별에 쓰기 어려울 것으로 본다.
  - **BiRefNet:** 흰 타일 장면 변기 크롭의 컷아웃이 3D 실루엣과 0.997 겹친다. 제품 윤곽 점수로 쓸 수 있다.
  - **Swin2SR x2(fp32, WebGPU):**
    - 1024×683 한 장에 30초다.
    - 2배 결과를 다시 줄이면 원본과 평균 0.12 차이다(정상 동작).

### 2라운드 — AI 소량 확인(2026-11-04, 사람 평가 완료)

- **4B:** 지금 방식 + 변형 ①②③⑤를 장면 3개(흰 타일·숯색 타일·실제 제품 사진)에 seed 424242로 1장씩 돌렸고, ④는 2장이다. 17회 모두 200이었다. 응답은 3.8~7.3초(중앙값 5.0초)다.
- **SD:**
  - SDXL base와 SDXL lightning은 `3030: Model input is not valid: input tensor image is not present in the model`이었다. 사진을 받지 않으므로 탈락이다. base는 거절까지 96초가 걸렸다.
  - dreamshaper-8-lcm(768×512, 8단계, strength 0.45)과 SD 1.5 inpainting(768×512, 20단계, strength 0.75, 벽·바닥만 흰 마스크)은 이미지를 돌려줬다.
- **사람 평가(`review/r2`, 22장, 1~5점):**

| 방법 | 실제 사진 같음 | 내 설계와 같음 | 큰 문제 표시 | 구도 정렬(최소) | Gemma: 못 찾은 제품 / 큰 추가 |
| --- | --- | --- | --- | --- | --- |
| 지금 방식 | 5.0 | 4.33 | 1(실제 제품 사진: 물건 추가) | 0.77 | 1 / 0 |
| ① 사진 문장 | 4.67 | 4.67 | 0 | 0.57 | 1 / 0 |
| ② 짧은 프롬프트 | 5.0 | 4.0 | 1 | 0.79 | 1 / 0 |
| ③ 타일 참조 | 5.0 | 4.33 | 1 | 0.75 | 1 / 0 |
| ④ 큰 입력(2장) | 5.0 | 5.0 | 0 | 0.71 | 0 / 0 |
| ⑤ 방 안 눈높이 | 5.0 | 4.67 | 1 | **0.30** | 2 / 1(유리 칸막이) |
| AI 없음(32장 + 사진 효과) | 3.0 | 5.0 | 0 | – | – |
| SD dreamshaper(1장) | 3 | 5 | 0 | 0.89 | 1(샤워) / 0 |
| SD inpainting(1장) | 2 | 2 | 1 | 0.86 | 1(샤워) / 0, 거울·벽판 추가 |

- "실제 제품 사진" 장면의 세면대(정면 사진이 벽에 평평하게 놓인 판)는 Gemma가 모든 방법에서 "없음"이라고 했다. 입력부터 그렇게 보이는 것이다.
- **자동 점수와 사람 평가(Spearman, 19~22장):**
  - Gemma(못 찾은 제품 + 큰 추가) 대 설계 0.78
  - 구도 정렬 0.11, 색 차이 0.19, 밝기 차이 −0.19
  - BiRefNet 최소 겹침 −0.12, CLIP 대 사실감 0.13
- **BiRefNet 제품 판정은 쓰지 않는다:** "0.5 미만 = 바뀜"이 19장 중 8장에서 나왔지만, 사람이 "제품 바뀜"을 표시한 결과는 0장이다. 흰 벽 앞 흰 변기의 윤곽을 잘못 딴 것이다. 명세의 원칙(사람과 맞지 않는 자동 점수는 선별에 쓰지 않음)에 따라 3절의 제품 조건은 Gemma와 사람 표시로 판정했다. 이 해석은 평가 전에 사용자에게 알렸다.
- **판정**
  - ⑤ 방 안 눈높이는 탈락이다. 구도 정렬 0.4 미만이 1장(지금 방식 0장)이고, Gemma가 못 찾은 제품이 2(지금 방식 1)다. 원래 비교용이다.
  - ①②③④는 탈락 조건에 걸리지 않았다.
  - 지금 방식의 "실제 사진 같음"이 이미 5.0(만점)이라, 그보다 높은 변형이 없다. 3절대로 3라운드에 올리는 변형은 없다. 1~5점 척도가 이 수준에서 더 가르지 못한 것(천장 효과)도 결과의 일부다.
  - SD 두 모델은 비용을 확인할 수 없다(계정 집계 없음). 사람 평가도 지금 방식보다 낮아 3라운드에 올리지 않는다.
  - 사람 평가로는 AI 변환이 AI 없는 렌더보다 사실감이 2점 높았다(5.0 대 3.0).

### 3라운드 — AI 본 시험(2026-11-04)

- **돌린 것**
  - 지금 방식: 개발 8장면 × seed 2(424242, 777001), 16장. 2라운드의 3장은 다시 썼다.
  - 실험 A(빈 방)·B(회색 자리): 장면 4개(흰 타일·숯색·부분 타일·SMC 천장) × seed 424242
  - 실험 C(제품별 다듬기): 같은 장면 중 3개. SMC 천장은 하루 한도(6,000) 때문에 다음 날로 미뤘다.
- **C의 빈 방은 A의 결과를 다시 썼다:** 같은 요청(빈 방 입력·프롬프트·seed)이기 때문이다. 제품 요청은 장면마다 표준 모형 수만큼이다.
- **호출 결과**
  - FLUX 모두 200이다. 지금 방식은 중앙값 5.0초(최대 7.5), A·B는 6.5~6.7초, 제품 다듬기는 3.6초다.
  - Gemma 확인 21회는 중앙값 1.9초다.
- **C의 제품 판정(앱 규칙, 겹침 0.90):**
  - 변기 3/3 다듬어짐(0.97), 세면대 3/3(0.95~0.96)
  - 샤워 2/2는 3D 렌더로 남음(0.46·0.50, "모양이 3D 제품과 달라요")
- **구도:** 21장 모두 정렬 0.4 이상(0.65~0.91)이라 배경 되돌리기·색 보정을 했다.
- **Gemma 큰 추가 물건:** 지금 방식 16장 중 2장(부분 타일 777001 유리 칸막이, 벽 구조 424242 창문). A·B는 0장이다.

### 4라운드 — 뒤처리(AI 없음)

- ⓐ 빛만 AI, ⓑ 위치별 색 맞춤: 지금 방식 seed 424242 8장에 적용했다(`post-variants.ts`). 한 장에 1.8초·4.4초다.
- ⓒ Swin2SR x2: 4장에 적용했다(992×672 → 1984×1344, WebGPU 18~30초).
- ⓓ 자동 고르기: 사람 평가와 맞는 자동 점수가 Gemma뿐이라 Gemma(못 찾은 제품 + 큰 추가)로 seed 2장 중 하나를 골랐다.

### 5라운드 — 사람 평가(2026-11-04, 57장, 사용자 완료)

| 방법 | 장수 | 실제 사진 같음 | 내 설계와 같음 | 큰 문제(제품·추가·구도) |
| --- | --- | --- | --- | --- |
| **지금 방식** | 16 | **4.88** | 5.00 | 5(31%), 모두 "물건 추가" |
| 실험 A 빈 방 | 4 | 2.25 | 5.00 | 0 |
| 실험 B 회색 자리 | 4 | 2.00 | 5.00 | 0 |
| 실험 C 제품별 다듬기 | 3 | 2.33 | 5.00 | 0 |
| AI 없음(32장 + 사진 효과) | 8 | 2.38 | 5.00 | 0 |
| ⓐ 빛만 AI | 8 | 4.50 | 5.00 | 0 |
| ⓑ 위치별 색 | 8 | 5.00 | 4.88 | 1 |
| ⓒ 확대 | 4 | 5.00 | 5.00 | 1 |
| 렌더러 확인: WebGL 한 장 / 경로 추적 | 1 / 1 | 2 / 3 | – | – |

- **같은 결과에 뒤처리 전후(seed 424242 같은 장면 대비)**
  - ⓐ: 사실감 −0.50, 설계 ±0, 문제 표시 −2(실제 제품 사진 장면의 "물건 추가"가 사라짐, 대신 사실감 5→2). 탈락이다(+0.3 필요).
  - ⓑ: 사실감 ±0, 설계 −0.13, 문제 표시 ±0. 탈락이다.
  - ⓒ: 사실감 ±0, 설계 ±0. 탈락이다. 화면 크기 평가에서는 2배 확대의 차이가 보이지 않는다.
  - ⓓ: Gemma 점수가 두 seed에서 다른 쌍은 8쌍 중 2쌍뿐이다. 고른 쪽이 사람 평가 합에서 높은 경우는 1쌍(50%)이라 탈락이다(60% 필요).
  - 5라운드에서는 설계 점수가 모두 5여서, Gemma와 설계의 상관을 다시 잴 수 없었다.
  - "물건 추가" 표시 5장과 Gemma 큰 추가는 2장만 겹친다.
- **자동 점수:** CLIP 대 사실감 0.38(57장)이다. 기준 0.5에 못 미쳐 쓰지 않는다.
- **추천 판정(3절 1~4)**
  - 설계 조건(1)과 큰 문제 조건(2)은 A·B·C·ⓐ·ⓑ·ⓒ 모두 통과한다.
  - 그중 사실감이 가장 높은 것은 ⓑ·ⓒ(5.0)이다. 지금 방식(4.88)보다 0.5 이상 높지 않다.
  - 그래서 **지금 방식 유지**다. A·B·C는 설계는 같지만 사실감이 AI 없는 렌더와 비슷하다(2.0~2.33 대 2.38).
- **천장 효과:** 사용자는 지금 방식 16장 중 14장에 사실감 5를 줬다. 1~5점으로는 지금 방식보다 나은 방법을 가를 여지가 거의 없었다. 지금 방식의 약점은 사실감이 아니라 없던 물건이 생기는 것(31%)이다.

### 렌더러 가능성(AI 없음, 반나절)

- **경로 추적: 다시 볼 만함**
  - three-gpu-pathtracer에 `WebGPUPathTracer`가 생겼다(0.0.25, 2026-09-28; 0.0.28은 three ≥0.187 필요).
  - 0.0.27을 임시 폴더(`tmp/export-photoreal/render-probe`, 앱과 분리)에 설치해 작은 방(도형 변기·세면대, 천장 패널 빛)을 그렸다.
  - 이 PC(NVIDIA, lovelace 어댑터, 대체 어댑터 아님)에서 물체가 검게 나오지 않았다. 9월의 D3D11 문제는 WebGL 경로의 일이다.
  - 60초에 13,008라운드(992×672)였다. 아직 입자가 거칠고, 노이즈 제거는 붙이지 않았다.
  - 단색 환경 텍스처를 넣으면 WGSL 검증 오류(`unresolved value 'nodeUniform13_sampler'`)가 났다.
  - 사람 평가는 경로 추적 3 대 WebGL 한 장 2다(1장씩).
- **WebGPU 화면 효과(SSGI + TRAA): 판정 못 함**
  - 이 PC에서 그려졌다(48프레임 0.5초).
  - 다만 TRAA를 빼도 전체가 붉게 나왔다. 효과를 엮은 방식(MRT 합성)의 오류로 보이고, 정해 둔 시간 안에 고치지 못했다.
- **다시 시작한다면:** 앱 렌더러의 실제 장면(타일 셰이더, `onBeforeCompile`)을 WebGPU 노드 재질로 옮기는 일이 먼저다. 사용자 기기의 WebGPU 지원 비율도 재야 한다.

### 여기서 멈춤(2026-11-04 UTC, 라운드 경계)

- 이날 장부 5,886뉴런으로 하루 몫(6,000)에 거의 닿았다.
- 다음 날 남은 일
  - SMC 천장의 실험 C(약 224)
  - 6라운드 마지막 확인: 남긴 2장면 × seed 2 × 지금 방식, 약 440 + 확인 약 45
  - 짧은 사람 평가
- 고른 방법이 지금 방식이라 마지막 확인도 지금 방식만 돌린다. 마지막 확인 장면은 아직 열지 않았다.

## 7. 비용

- 장부: `test-results/export-photoreal/ledger.jsonl`.
- **2라운드(2026-11-04 UTC):** 2,620뉴런이다(계정 집계 없이 장부만).
  - FLUX 17회: 2,010
  - SD 4회: 400. 가격을 몰라 1회 100으로 셌고, 실패 2회도 셌다.
  - Gemma 확인 19회: 210. 응답의 토큰으로 셌고, 회당 약 11.1이다
- **3라운드(같은 날):** 3,266뉴런, 실패 0이다.
  - 지금 방식 13회: 1,424
  - A·B 8회: 876
  - C 제품 8회: 772
  - Gemma 21회: 192
- **누적:** 5,886뉴런(예산 10,000, 도구 한도 9,000). 2026-11-04 UTC 하루 5,886이다.
- 결과 1장 비용(추정): 지금 방식 약 110 + 확인 약 11, C는 빈 방 110 + 제품당 57~110이다.
- 브라우저 모델 다운로드: CLIP 글 쪽 q8 64.5MB + tokenizer 2.2MB, Swin2SR x2 54.4MB. revision·SHA-256은 `tmp/export-photoreal/models/models.json`에 있다. CLIP 이미지 쪽은 catalog-match에서 받은 것을 다시 썼다.

## 8. 다시 돌리기

작업 폴더(워크트리)에서 실행한다.

```bash
node tests/export-photoreal/models.mjs
```

```bash
node tests/run-browser-test.mjs tests/export-photoreal/scenes.ts --gpu
```

```bash
node tests/run-browser-test.mjs tests/export-photoreal/lab-check.ts --gpu
```

```bash
npx vitest run tests/export-photoreal.test.ts
```

AI를 부르는 단계는 임시 Worker를 먼저 띄운다(이 PC의 wrangler 로그인 계정, 실제 사용량이 든다).

```bash
npx wrangler dev --config tests/export-photoreal/ai-worker/wrangler.jsonc --ip 127.0.0.1 --port 8805
```

```bash
node tests/run-browser-test.mjs tests/export-photoreal/run.ts --round r2 --methods current,photo,short,tileref,inroom --scenes white,charcoal,photos --seeds 424242
```

```bash
node tests/run-browser-test.mjs tests/export-photoreal/run.ts --round r2 --methods large --scenes white,charcoal --seeds 424242
```

```bash
node tests/run-browser-test.mjs tests/export-photoreal/sd.ts
```

```bash
node tests/run-browser-test.mjs tests/export-photoreal/run.ts --round r3 --methods current --scenes white,charcoal,pattern,partial,structure,smc,photos,narrow --seeds 424242,777001
```

```bash
node tests/run-browser-test.mjs tests/export-photoreal/run.ts --round r3 --methods empty,placeholders --scenes white,charcoal,partial,smc --seeds 424242
```

```bash
node tests/run-browser-test.mjs tests/export-photoreal/post.ts --check --round r3
```

```bash
node tests/run-browser-test.mjs tests/export-photoreal/refine.ts --scenes white,charcoal,partial,smc
```

AI 없이 하는 측정과 뒤처리다.

```bash
node tests/run-browser-test.mjs tests/export-photoreal/products.ts --gpu
```

```bash
node tests/run-browser-test.mjs tests/export-photoreal/mask-check.ts
```

```bash
node tests/run-browser-test.mjs tests/export-photoreal/post-variants.ts --scenes white,charcoal,pattern,partial,structure,smc,photos,narrow --seeds 424242 --steps light,local
```

```bash
node tests/run-browser-test.mjs tests/export-photoreal/post-variants.ts --scenes white,charcoal,pattern,photos --seeds 424242 --steps upscale
```

렌더러 확인은 임시 폴더에 라이브러리를 먼저 설치한다(`tmp/export-photoreal/render-probe`에서 `npm install`, package.json은 three 0.185.1·three-gpu-pathtracer 0.0.27·three-mesh-bvh 0.9.16).

```bash
node tests/run-browser-test.mjs tests/export-photoreal/render-probe/probe.ts
```

평가 화면(127.0.0.1만)과 채점이다. `--set`은 r2, r5다.

```bash
node tests/run-browser-test.mjs tests/export-photoreal/review/build.ts --set r5
```

```bash
node tests/export-photoreal/review/server.mjs --set r5 --port 8793
```

```bash
node tests/run-browser-test.mjs tests/export-photoreal/review/score.ts --set r5
```

## 9. 한계

- 표본이 작다. 지금 방식 16장, A·B 4장, C 3장, 뒤처리 4~8장이고 평가자는 한 명이다. 같은 입력·seed로 다시 불러도 결과가 다르다.
- 사실감 점수가 거의 만점에 몰렸다(천장 효과). 지금 방식보다 조금 나은 방법은 이 척도로 가려지지 않는다.
- 설계 점수도 대부분 5였다. 그래서 자동 점수와 설계의 상관은 2라운드 19장에서만 잴 수 있었다.
- 계정 집계를 읽지 못해(2절) 뉴런은 장부 추정뿐이다. SD 두 모델의 실제 비용은 모른다.
- 장면은 공개 자재로 만든 시험 장면이다. 사용자 프로젝트·사진 조명 맞춤 장면은 없다.
- 렌더러 확인은 도형으로 만든 작은 방 하나다. 앱의 실제 장면이 아니다.
