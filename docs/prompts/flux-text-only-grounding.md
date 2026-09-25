# AI 현장 사진 변환: 참조 이미지를 빼고 제품 정보 문장만 보내기 (B 방식)

SJN의 "AI로 현장 사진처럼"(FLUX.2 klein 4B) 변환을 **After 이미지 + 서버가 만든 제품 정보 문장**만 보내는 방식으로 정리해줘. 지금 브랜치에 구현된 제품 참조 이미지(`input_image_1`~`3`)는 모두 걷어낸다. 조사나 계획 설명에서 멈추지 말고 코드 정리, 테스트, 문서 갱신, 결과 보고까지 끝낸다.

## 0. 왜 B인가: 실제 비교 결과 (2026-09-25, 사용자 승인 후 6회 호출)

사용자 테스트에서 바닥 양변기가 스테인리스 쓰레기통으로 바뀌었다. 그래서 편집기가 아는 배치 정보를 함께 보내도록 구현했고(`docs/prompts/flux-product-grounded-export.md`), 같은 장면·seed로 세 방식을 실제로 비교했다.

- 장면: 기본 방 2D 합성 경로. 석재풍 벽, 밝은 바닥 타일, 왼벽 벽걸이 세면대·핸드샤워, 바닥 표준 양변기. 496×336 입력에서 변기는 약 35×60px이다.
- 방식
  - A: 기존. 이미지와 고정 지시문(`FLUX_PROMPT`)
  - B: A에 설비별 문장과 개수 요약, 타일 문장을 더한 것
  - C: B에 참조 이미지 3장(변기·세면대·샤워 crop)을 더한 것
- seed는 424242와 777001이다. 6회 모두 200이었다.

|                                                              | A 기존                     | B 제품 정보 문장            | C 문장 + 참조 이미지          |
| ------------------------------------------------------------ | -------------------------- | --------------------------- | ----------------------------- |
| 변기·세면대·샤워 유지                                        | 2/2                        | 2/2                         | 종류는 유지, 크기·위치 틀어짐 |
| 변기 높이 (원본 20%)                                         | 19~20%                     | 19~20%                      | **30~33%**                    |
| 없던 물건 추가                                               | 유리 칸막이 2/2, 손잡이 등 | 손잡이 1/2, 1장은 추가 없음 | **문 2/2**, 휴지걸이          |
| 원본과의 화면 차이 (62×42 회색조 평균 절대차, 낮을수록 좋음) | 34.6~48.4                  | **26.6~41.6**               | 65.9~68.4                     |
| 응답 시간                                                    | 7~9초                      | 9초                         | **27~29초**                   |

- 결론: B가 구도와 설비를 가장 잘 지켰다. C는 참조 이미지 때문에 카메라를 당겨 구도를 다시 잡았다. 그래서 설비가 커지고 없던 문이 생겼다. 느리고 입력 타일 사용량도 더 든다.
- 한계: 이 장면에서는 쓰레기통 현상이 A에서도 재현되지 않았다. B가 그 문제를 고친다는 증거는 아직 없고, 배포 뒤 실제 프로젝트에서 확인한다. 방식마다 2장이라 표본도 작다.
- 증거: `test-results/flux-compare-20260925/`(git 제외). `comparison-sheet.png`, 결과 6장, `log.json`, 입력·상자·참조 이미지, `scene.json`, `prompt-A/B/C.txt`가 있다. **`prompt-B.txt`가 실제로 검증한 B 프롬프트다.**

## 1. 현재 상태 (먼저 확인)

`AGENTS.md`, `.agents/skills/sjn-workflow/SKILL.md`와 관련 references, `node_modules/next/dist/docs/`의 관련 문서를 먼저 읽는다. `git status`로 상태를 확인한다. 이미 수정된 파일은 초기화하지 않는다.

- 워크트리 `C:\app\SJN\.claude\worktrees\flux2-klein-9b-cleanup-1a3200`, 브랜치 `claude/flux-product-grounded`
- 커밋은 `3dfcb56`(9B 제거)까지다. 그 위에 C 방식 구현이 **커밋되지 않은 채** 있다.
  - 수정: `e2e/flux-export.spec.ts`, `src/components/editor/ai-export.tsx`, `src/components/editor/editor.tsx`, `src/lib/ai-export/client.ts`, `contract.ts`, `server.ts`, `src/lib/room-viewer/renderer.ts`, `tests/flux-export.test.ts`, 문서 3개
  - 새 파일: `src/lib/ai-export/scene-contract.ts`, `scene.ts`, `prompt.ts`, `tests/flux-prompt.test.ts`, `tests/flux-scene.test.ts`, `tests/flux-grounding-browser.ts`, `docs/prompts/flux-product-grounded-export.md`, 이 문서
  - 임시: `tests/flux-compare-payload-tmp.ts`(비교용 장면 생성기). 이번 작업에서 지운다.
- 걷어내기 전에 `prepareFluxReference`, `FLUX_MAX_REFERENCES`, `FLUX_MAX_REFERENCE_BYTES`, `reference_`, `references`, `.reference`를 검색해 다른 호출처가 없는지 확인한다.

## 2. 바꿀 것

### 남긴다 (B의 핵심)

- 장면 계약: 설비 종류·형태·면·색·마감·mm 치수·입력 이미지 기준 상자, 타일 면. enum·숫자·hex만 쓰고 자유 문자열은 두지 않는다.
- 서버의 zod 검증과 서버가 쓰는 영어 프롬프트
- 2D 상자 계산(`fixtureImageBox`, `toInputBox`)과 3D `RoomViewerRenderer.fixtureBounds`
- 설비 순서(`orderFixtures`, `FLUX_KIND_PRIORITY`): 프롬프트가 길어 줄일 때 중요한 설비가 앞에 남게 한다.
- 변환 창의 "변환에 전달한 제품" 목록

### 파일별 변경

- `src/lib/ai-export/scene-contract.ts`
  - `reference` 필드, `FLUX_MAX_REFERENCES`, `FLUX_MAX_REFERENCE_BYTES`, 참조 중복 `refine`을 지운다.
  - `strictObject`는 유지한다. 그래서 `reference` 키를 보내면 스키마에서 거부된다.
- `src/lib/ai-export/prompt.ts`
  - `buildFluxPrompt(scene)`로 인자를 줄인다.
  - "Images 1–N are close-up references…" 문장과 "It is the exact product shown in image N…" 문장을 지운다.
  - 나머지 문장, 순서, 길이 줄이기 규칙은 그대로 둔다. **비교 장면에서 새 코드가 만든 프롬프트는 `prompt-B.txt`와 글자 하나까지 같아야 한다.**
- `src/lib/ai-export/scene.ts`
  - `FluxGrounding`은 `{ scene, placed }`로, `FluxPlacedProduct`에서 `reference`를 뺀다.
  - 참조 이미지 만들기를 지운다. 대상은 crop, 20% 여유, 제품 사진 → 참조 변환이다.
  - 사진 제품의 대표색은 계속 제품 사진의 불투명 픽셀 평균으로 구한다. 사진은 브라우저에서 읽기만 하고 보내지 않는다. 그 밖에는 캡처 영역 평균을 쓴다.
  - 주석을 새 동작에 맞춘다. 면적 0.02% 미만 제외, 보류된 욕조 테두리 유리 제외, 설비 12개 상한은 그대로 둔다.
- `src/lib/ai-export/client.ts`
  - `prepareFluxReference`를 지운다.
  - `requestFluxImage(image, seed, signal, userId?, scene?)`로 바꾸고 `scene` JSON만 보낸다. 필드 순서는 `image`, `seed`, `scene`이다.
- `src/lib/ai-export/server.ts`
  - 허용 필드는 `image`·`seed`(필수)와 `scene`(선택)이다. `reference_*`는 다른 모르는 필드처럼 **추론 전에 400**이다.
  - 요청 상한을 `FLUX_MAX_IMAGE_BYTES + FLUX_MAX_SCENE_BYTES + 4096` 정도로 되돌린다(현재 약 3.6MB).
  - 모델에는 `input_image_0`만 넘긴다. `diagnostics`에는 `promptLength`, `fixtures`만 남긴다.
- `src/components/editor/editor.tsx`
  - AiExport 캡처 크기를 **1024px로 되돌린다.** 2048은 crop 품질 때문에 올린 것이었다.
  - `inspect` 콜백과 3D `fixtureBounds` 호출은 유지한다.
- `src/components/editor/ai-export.tsx`
  - 목록에서 "· 참조 이미지 N"을 지운다.
  - 안내 문구에서 "제품 사진"을 뺀다. 예: "버튼을 누를 때 현재 After 이미지와 배치한 제품의 종류·위치·크기·색 정보를 Cloudflare로 보내 변환해요…"
  - AI가 제품을 바꿀 수 있다는 안내는 유지한다.
- `src/lib/ai-export/contract.ts`(`fluxInputLayout`)와 `src/lib/room-viewer/renderer.ts`(`fixtureBounds`)는 그대로 둔다.
- `tests/flux-compare-payload-tmp.ts`를 지운다.

## 3. 반드시 지킬 조건

- **이번 작업에서는 실제 AI 호출을 하지 않는다.** B는 이미 실측했다. 추가 호출이 꼭 필요하다고 판단되면 호출 수와 예상 뉴런을 먼저 알리고 사용자 승인을 받는다.
- 한 번 누르면 한 번만 호출한다. 자동 재시도·자동 모델 전환은 하지 않는다. FLUX는 계속 게이트웨이 없이 `AI` 바인딩으로 직접 호출한다.
- 사용자가 입력한 제품명·설명은 모델로 보내지 않는다. 문장은 서버만 만든다.
- 동일 출처, 로그인, 한도 오류 처리는 그대로 둔다. 창을 닫을 때 요청 중단과 URL 정리도 그대로 둔다.
- Gemma 결과 검사는 넣지 않는다(사용자 결정 보류).

## 4. 테스트 갱신

- `tests/flux-prompt.test.ts`
  - 참조 관련 기대를 지운다.
  - 설비 문장, 개수 요약, 타일 문장, 결정성, 길이 상한은 유지한다.
  - 프롬프트에 `image 1`·`Images 1`이 나오지 않는지 확인한다.
  - 스키마가 `reference` 키를 거부하는지 확인한다.
- `tests/flux-scene.test.ts`: 참조 관련 부분만 맞춘다. 상자, 설명, 순서, 마감 테스트는 유지한다.
- `tests/flux-export.test.ts`
  - 참조 거부 케이스를 지운다.
  - `reference_1`을 보내면 400이고 AI가 호출되지 않는지 확인한다.
  - 요청 상한 초과 테스트를 새 상한에 맞춘다. C에서 5MB로 바꾼 값을 되돌린다.
  - 모델 입력에 `input_image_0`만 있는지 확인한다.
  - `diagnostics`에 `references`가 없고 문장·이미지도 없는지 확인한다.
  - 클라이언트 필드 순서 `['image','seed','scene']`를 확인한다.
- `tests/flux-grounding-browser.ts`
  - 참조 이미지 저장과 "변기가 image 1" 검사를 지운다.
  - 2D·3D 모두 스키마 통과, 순서(변기→세면대→샤워), 상자 그림 저장은 유지한다.
  - `scene.fixtures`에 `reference`가 없는지 확인한다.
- `e2e/flux-export.spec.ts`(모의 응답): 전송 필드 `['image','scene','seed']`를 확인한다. 제품 목록에 "참조 이미지"가 없는지 확인한다.
- **B 프롬프트 일치 확인(1회성, 커밋하지 않음)**
  - `test-results/flux-compare-20260925/scene.json`에서 `reference`를 뺀다.
  - 새 `buildFluxPrompt`에 넣은 결과가 `prompt-B.txt`와 같은지 비교한다. 예: 스크래치 vitest 파일이나 esbuild 한 줄.
  - 다르면 차이를 보고한다.

## 5. 검증 명령

- `npx vitest run tests/flux-export.test.ts tests/flux-prompt.test.ts tests/flux-scene.test.ts tests/reconstruction-cloud-gemma.test.ts`
- `node tests/run-browser-test.mjs tests/flux-grounding-browser.ts`(실제 WebGL, AI 호출 없음). `test-results/flux-grounding/*-boxes.png`를 직접 보고 상자가 맞는지 확인한다.
- `npx playwright test e2e/flux-export.spec.ts`. 3000번 포트에 다른 서버가 없는지 먼저 확인한다. 포트 고갈(`TIME_WAIT`)로 D1/R2가 실패하면 환경 문제로 구분한다.
- `npm run typecheck`
  - 끝나면 `next-env.d.ts`를 되돌린다.
  - `.next/dev/types/validator.ts`가 반쯤 쓰인 채 남아 문법 오류가 나면 `.next/dev/types`를 지우고 다시 돌린다.
- `npm run lint`
- 변경 파일 Prettier. 쓰기는 `--end-of-line crlf --write`, 검사는 `--end-of-line auto`로 한다. `project-overview.md`의 표 정렬 경고는 원래부터 있던 것이다.
- 전체 `npx vitest run`
  - 이 워크트리에서 이미 알려진 실패 6개가 있다: `reconstruction-corpus` 해시, `reconstruction-source-plane-mapping` 기준 파일 없음.
  - 그 밖의 실패가 없는지만 본다.

## 6. 문서

- `docs/flux-export.md`
  - "제품 정보 전달" 절에서 참조 이미지 내용을 지운다.
  - 요청 필드를 `image`·`seed`·`scene`으로 고친다.
  - 요청 상한과 사용량을 호출당 약 110뉴런으로 맞춘다. 사용량은 참조가 없어 기존과 같다.
  - **"참조 이미지를 쓰지 않는 이유"** 로 0절의 비교표와 한계를 요약한다.
  - 검증 목록과 공식 API 근거 문장(`input_image_0`만 사용)을 고친다.
- `docs/verification.md`: 2026-09-25 "배치 제품 정보 전달" 항목을 B 기준으로 고친다. 실제 비교 6회 결과와 B 선택 이유를 넣고, 쓰레기통 현상은 미재현이라고 적는다.
- `.agents/skills/sjn-workflow/references/project-overview.md`: 내보내기 설명에서 "제품 참조 이미지 최대 3장"을 지운다.
- `docs/prompts/flux-product-grounded-export.md`와 이 문서는 기록으로 함께 둔다.

## 7. 보고

- 파일마다 바뀐 코드와 이유를 쓴다. 지운 것과 남긴 것을 구분한다.
- 테스트·검사 결과를 숫자로 적는다. 실패가 있으면 원인을 적는다.
- B 프롬프트 일치 확인 결과를 적는다.
- 남은 한계를 적는다.
  - 쓰레기통 현상은 실제 프로젝트에서 확인이 필요하다.
  - 기본 방 렌더의 방 바깥 회색 영역을 A·B가 흰 벽으로 바꾸는 경향이 있다(이번 범위 밖).
  - 작은 수전·거울은 여전히 바뀔 수 있다.
- 커밋·푸시는 사용자가 요청할 때만 한다. 요청받으면 기능 코드·테스트와 문서를 나눠 커밋하는 안을 제시한다.
