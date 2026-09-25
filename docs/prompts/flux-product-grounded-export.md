# AI 현장 사진 변환에서 설비가 바뀌는 문제 — 실제 배치 제품 정보를 함께 전달

SJN의 "AI로 현장 사진처럼"(FLUX.2 klein) 변환이 배치한 제품을 다른 물건으로 바꾸지 않도록 개선해줘. 저장소는 `C:\app\SJN`이다(워크트리에서 작업하면 그 경로를 쓴다). 조사나 계획 설명에서 멈추지 말고 구현, 테스트, 사용자 승인 뒤 실제 변환 비교, 문서 갱신, 결과 보고까지 끝낸다.

## 0. 발생한 문제

사용자가 기본 공간에 벽걸이 세면대, 샤워 수전, 바닥 양변기를 배치하고 변환했다.

- 결과 사진에서 **양변기가 스테인리스 쓰레기통으로 바뀌었다.**
- 세면대 모양과 샤워기 위치도 조금 달라졌다.

원인은 모델이 이미지 한 장만 보고 물건이 무엇인지 추측하기 때문이다.

- 지금은 After 이미지를 긴 변 496px로 줄여(`FLUX_INPUT_EDGE`) 고정 영어 지시문 하나(`FLUX_PROMPT`)와 함께 보낸다. 이 크기에서 변기는 20~30px밖에 안 된다.
- 지시문은 "모든 설비의 개수·위치·모양을 유지하라"고만 하고, 어디에 **무엇이** 있는지는 알려 주지 않는다.
- FLUX.2 [klein]은 프롬프트를 자동으로 보강하지 않는다. BFL 문서도 klein에는 자세한 서술형 프롬프트를 쓰라고 한다.

**목표:** 이미지에만 의존하지 않는다. 사용자가 실제로 배치한 제품이 무엇이고 어디에 어떤 모양·색·크기로 있는지를 구조화된 정보로 전달한다. 가능하면 실제 제품 사진도 참조 이미지로 넘긴다. 그래서 변환 뒤에도 같은 종류, 같은 위치의 제품이 남게 한다.

## 1. 먼저 읽고 현재 구조를 확인한다

`AGENTS.md`와 `.agents/skills/sjn-workflow/SKILL.md`(프로젝트 설명·개발 환경 references), `node_modules/next/dist/docs/`의 관련 문서, 현재 git 상태를 먼저 본다. 이미 수정된 파일을 초기화하지 않는다. 다음 파일도 읽는다.

- `docs/flux-export.md`: FLUX 연결, 게이트웨이 미사용 이유, 검증 기록
- `src/lib/ai-export/contract.ts`: 모델 ID, `FLUX_INPUT_EDGE`, `FLUX_PROMPT`, `fluxDimensions`
- `src/lib/ai-export/client.ts`: `prepareFluxImage`는 흰 여백으로 16px 격자에 맞춘다. `requestFluxImage`는 multipart로 `image`, `model`, `seed`를 보낸다.
- `src/lib/ai-export/server.ts`: `runFluxExport`가 필드를 검증하고 `input_image_0` 하나와 prompt·width·height·seed를 `AI.run`에 multipart로 넘긴다. 게이트웨이는 쓰지 않는다.
- `src/components/editor/ai-export.tsx`: 받는 것은 `capture` 콜백(현재 After PNG)뿐이라 장면 정보가 없다.
- `src/components/editor/editor.tsx`
  - `captureExport(...)`(AiExport에는 1024px로 전달)
  - `roomContext`: 벽 구조가 있으면 3D `RoomViewerRenderer`, 없으면 2D `PhotoCompositor`
- `src/lib/types.ts`
  - `FixtureInstance`: `position`/`width`/`height`/`anchor`/`rotation`은 정규화 이미지 좌표, 그 밖에 `projectedQuad`, `roomPlacement`, `reconstruction.kind/color/widthMm…`
  - `MaterialVersion`: `category`, `categoryLabels`, `color`, `finish`, 치수, `installation`, `views[].assetId`, `coverAssetId`
  - `Surface.tile`
- `src/lib/room-fixtures.ts`의 `projectRoomFixture`, `src/lib/reconstruction/projection.ts`, `src/lib/reconstruction/templates.ts`: 표준 모형의 종류와 세부 형태(벽걸이·바닥형, 원피스 등)
- 현재 main에는 4B·9B 비교 UI가 있다. 9B 제거 커밋은 로컬 브랜치 `claude/flux2-klein-9b-cleanup-1a3200`(95e8f1a)에만 있고 병합되지 않았다. 9B 처리 방침은 작업 전에 사용자에게 확인한다. 이번 개선은 모델과 무관하게 모든 호출에 적용한다.

Cloudflare FLUX.2 klein 제약은 공식 문서에서 다시 확인한다.

- multipart로 `input_image_0`~`input_image_3`, 최대 4장, 각 512×512 미만
- 프롬프트에서 "image 1"처럼 번호로 참조 가능
- 출력 최대 4MP
- 프롬프트 최대 길이는 문서에 없다. 실제로 확인하고, 모르면 보수적으로 제한한다
- 근거: https://developers.cloudflare.com/workers-ai/models/flux-2-klein-4b/ , https://developers.cloudflare.com/changelog/post/2026-01-15-flux-2-klein-4b-workers-ai/ , https://docs.bfl.ai/flux_2

## 2. 구현 방향

### 2-1. 장면 설명을 구조화해서 보낸다 (클라이언트)

- `AiExport`에 `capture` 외에 **현재 After 장면의 설명**을 주는 콜백을 추가한다. 내보내기 캡처와 같은 스냅샷에서 만든다. 항목은 아래와 같다.
  - 설비마다:
    - 범주: `MaterialCategory` 또는 `reconstruction.kind` enum
    - 세부 형태: 표준 모형이면 벽걸이/바닥형, 원피스/투피스, 핸드샤워/레인샤워 같은 enum
    - 설치 면: 바닥, 뒷벽, 좌·우벽
    - 대표색: hex. 제품 사진에서 추출하거나 `reconstruction.color`
    - 마감: `finishAppearance`의 분류
    - 실제 크기: mm
    - **변환 입력 이미지 기준의 경계 상자**: 0~1 정규화
  - 벽·바닥 타일마다: 대표색 hex, 타일 크기(mm), 배열(격자·엇갈림), 줄눈 색·폭, 마감
- 경계 상자는 FLUX에 실제로 보내는 이미지 좌표로 맞춘다. `prepareFluxImage`의 축소와 흰 여백(가운데 정렬)을 반영해야 하고, 여백을 빼먹으면 위치가 어긋난다.
  - 2D 경로: `position`/`width`/`height`/`anchor`/`rotation` 또는 `projectedQuad`로 계산한다. 표준 모형은 기존 투영 함수로 계산한다.
  - 3D 경로(벽 구조가 있는 프로젝트): `RoomViewerRenderer`에 현재 시점에서 설비의 화면 경계 상자를 돌려주는 메서드를 추가한다. 캡처와 같은 카메라여야 한다.
  - 화면 밖이거나 거의 가려진 설비는 빼고, 부분만 보이면 보이는 범위로 자른다.
- 사용자가 입력한 제품명·브랜드 같은 **자유 문자열은 기본으로 보내지 않는다.** 모델에 도움이 적고, 지시문을 흔드는 텍스트가 섞일 수 있다. 꼭 필요하면 길이 제한·제어문자 제거·따옴표 인용을 거친 짧은 참고 정보로만 넣는다.

### 2-2. 제품 참조 이미지 (선택 가능한 최대 3장)

- `input_image_0`은 지금처럼 After 이미지다. 남은 `input_image_1`~`3`에는 **작게 보이는 설비부터** 실제 제품 사진을 넣는다.
  - 우선순위: 변기 > 세면대·하부장 > 욕조 > 샤워 설비 > 기타
  - 같은 종류 여러 개는 면적이 큰 것부터
  - 사진: 선택한 방향의 `views[viewIndex].assetId`(배경 제거된 PNG가 있으면 그것), 없으면 `coverAssetId`
  - 크기: 512px 미만, 16px 격자, 비율 유지·여백 채움
- 사진이 없는 표준 모형은 참조 이미지 없이 텍스트로만 설명한다. 필요하면 해당 모형만 단독으로 렌더링한 작은 이미지를 참조로 쓰는 방안을 검토한다.
- 참조 이미지를 붙이면 입력 타일 비용(512×512당 $0.000059)과 전송량이 늘어난다. 측정해서 보고한다.

### 2-3. 프롬프트는 서버가 만든다

- 클라이언트는 정해진 형식의 **구조화 데이터만** 보낸다. 서버가 zod로 검증한 뒤 서버의 영어 템플릿으로 문장을 만든다. 클라이언트가 만든 문장을 그대로 모델에 넘기지 않는다(기존 테스트의 "caller prompt 거부" 원칙 유지).
- 검증 기준:
  - 설비 12개 이하, 범주·형태·설치 면은 enum
  - 숫자는 범위 확인, 경계 상자 0~1, hex는 `#rrggbb`
  - 참조 이미지 3장 이하, 각각 형식·크기(512px 미만)·바이트 확인, 참조 번호는 실제 첨부된 이미지와 일치
- 프롬프트 구성 예시(표현은 실측으로 다듬는다):
  1. 기존의 보존 지시(카메라·구도·기하·재질 유지, 사진 사실감만 향상)
  2. 설비별 문장. 예: "At the lower right (x 62–71%, y 70–93% of image 0) there is a white floor-standing one-piece toilet (about 380 × 720 × 700 mm). It must remain a toilet with the same shape and position; it is the product shown in image 1."
  3. 장면에 있는 설비 종류 전체와 개수, 그리고 "새 물건을 추가하거나 다른 물건으로 바꾸지 말 것"
  4. 타일 요약. 예: "Walls: light grey stone-look 600 × 600 mm tiles, grid, #cfd0cc grout 2 mm, matte; floor: …"
  - FLUX에는 네거티브 프롬프트가 없으므로 "무엇을 유지할지"를 긍정문으로 구체적으로 쓴다. hex 색 지정은 BFL 문서에서 지원한다고 한다.
- 프롬프트 길이 상한을 두고, 넘치면 작은·중요도 낮은 항목부터 요약한다. 같은 입력이면 항상 같은 프롬프트가 나오게(순서 고정) 하고 단위 테스트한다.
- 실패 시 `diagnostics`에 모델·단계와 함께 **프롬프트 길이·설비 수·참조 수**만 남긴다. 이미지와 사용자 문자열은 남기지 않는다.

### 2-4. 결과 확인 보조

- 결과 카드 옆에 "배치한 제품" 목록(범주와 위치)을 보여 줘서 사용자가 바로 비교할 수 있게 한다.
- 선택 과제, 사용자 승인 필요: 결과를 Gemma로 한 번 검사해 배치 설비가 사라졌거나 다른 물건으로 바뀌었으면 경고한다. Gemma 호출 비용(뉴런)이 추가되므로 기본으로 켜지 않는다. 구현 전에 비용과 정확도를 보고하고 사용자에게 묻는다.
- 대안 검토만: 설비 영역을 원본 렌더 픽셀로 되돌리는 "제품 영역 보존 합성". 정체성은 보장되지만 경계가 어색할 수 있다. 이번 작업에서는 실험 결과만 보고한다.

## 3. 반드시 지킬 조건

- **비용:** 한 번 누르면 한 번만 호출하고, 자동 재시도·자동 모델 전환은 하지 않는다. 기존 한도 오류 처리, 동일 출처, 로그인 검사는 그대로 둔다.
- **게이트웨이:** FLUX는 계속 게이트웨이 없이 `AI` 바인딩으로 직접 호출한다(multipart 스트림 제약).
- **개인정보·보안:** 제품 사진은 사용자가 이미 올린 자산 중 해당 설비에 쓰인 것만 보낸다. 다른 자산이나 원본 사진 전체는 보내지 않는다. 관리자 타인 프로젝트 편집 중에도 같은 규칙을 따른다.
- **입력 제한:** 전체 요청은 기존 2MB 상한을 유지하거나, 참조 이미지 몫을 명시해 새 상한을 정한다. 서버가 크기·개수·형식을 먼저 거절해야 추론 비용이 나지 않는다.
- **안내 문구:** 결과는 여전히 AI 시각화라 제품을 바꿀 수 있다고 안내하고, 원본과 결과를 나란히 보여 준다.
- **실제 AI 호출은 사용자 승인 후에만 한다.** 호출 횟수와 예상 비용을 먼저 알린다.

## 4. 진행 순서

1. 현재 동작 재현. 사용자가 보낸 장면(기본 공간, 벽걸이 세면대, 샤워 수전, 바닥 양변기)과 비슷한 테스트 장면을 만든다. 지금 코드가 보내는 입력 이미지와 프롬프트를 기록한다. 실제 호출은 하지 않는다.
2. 장면 설명 추출: 2D·3D 경로 모두, 여백 반영 경계 상자 포함. 단위 테스트와, 경계 상자를 입력 이미지 위에 그린 확인용 PNG로 위치가 맞는지 직접 본다.
3. 서버 계약: 검증, 참조 이미지, 프롬프트 템플릿. 단위 테스트한다.
4. UI: 배치 제품 목록과 안내 문구. E2E는 모의 응답으로 전송 필드를 검사한다(scene JSON, 참조 이미지 수와 순서, 변기 참조가 먼저인지).
5. **사용자 승인 후 실제 비교.** 같은 장면·seed로 "기존 방식"과 "제품 정보 전달 방식"(참조 이미지 있음·없음)을 각각 1~2회 호출하고, 결과 이미지를 나란히 붙여 보여 준다. 설비별로 종류 유지, 위치, 모양, 색을 표로 판정한다. 호출 수와 뉴런 사용량(관리자 AI 사용량 화면 또는 추정)을 기록한다.
6. 결과에 따라 템플릿 문구, 참조 우선순위, 경계 상자 표현(백분율과 "lower right" 같은 말 중 무엇이 나은지)을 조정하고, 필요하면 한 번 더 비교한다.

## 5. 검증

- 단위:
  - 장면 설명 추출: 2D 회전·원근 quad, 3D 투영, 여백 좌표 변환, 화면 밖 제외
  - 프롬프트 빌더: 결정성, 길이 상한, 순서
  - 서버 검증: 설비 수, enum, 참조 수·크기·형식 초과 거절, 참조 번호 불일치 거절, 자유 문장 거절
- 기존 `tests/flux-export.test.ts`, `tests/reconstruction-cloud-gemma.test.ts`
- E2E: `e2e/flux-export.spec.ts` 갱신(모의 응답)
- `npm run typecheck`, `npm run lint`, 변경 파일 Prettier(`--end-of-line auto`)
- 3000번 포트에 다른 서버가 떠 있지 않은지 확인한다. 로컬 포트 고갈(`TIME_WAIT` 급증)로 D1/R2 연결이 실패하면 환경 문제로 구분해 보고한다.

## 6. 문서와 보고

- `docs/flux-export.md`: 새 요청 형식, 프롬프트 구성 원칙, 참조 이미지 규칙, 한계
- `docs/verification.md`에 항목 추가
- 사용자에게 보이는 동작이 바뀌면 `.agents/skills/sjn-workflow/references/project-overview.md`의 내보내기 설명을 맞춘다.
- 보고할 것:
  - 실제 비교 이미지(기존 vs 개선)와 설비별 판정표
  - 호출 수와 비용
  - 파일마다 바뀐 코드와 이유
  - 남은 한계. 예: 작은 수전·거울은 여전히 바뀔 수 있음
