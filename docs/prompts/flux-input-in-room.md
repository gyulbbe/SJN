# AI 현장 사진 변환: 방 안 시점 입력(1)과 추가된 물건·타일 배열 변화 알림(2)

"AI로 현장 사진처럼" 결과가 **없던 벽·유리 칸막이·창문·선반을 만들고, 한 가지 벽 타일 사이에 다른 띠를 그리는** 문제를 줄이고 알려줘. 조사나 계획 설명에서 멈추지 말고 구현, 측정, 테스트, 문서, 보고까지 끝낸다. **유료 AI 호출은 5절의 승인 절차 뒤에만** 한다.

## 0. 사용자 사례와 원인 (2026-09-27)

- **사례 파일**(git 제외): `.claude/worktrees/flux2-klein-9b-cleanup-1a3200/test-results/flux-user-example-20260927/`
  - `input.png`: AI에 들어간 그림
  - `output.webp`: 결과
- **입력**: 벽 구조 없는 기본 방을 **방 바깥에서 들여다본 옛 구도**다. 방 상자 둘레가 회색 빈 여백이다.
  - 회색 무늬 벽, 진한 회색 바닥 타일, 왼벽 벽걸이 세면대·샤워, 뒤 오른쪽 변기
- **결과**
  - 여백이 벽으로 채워지고, 왼쪽에 벽 조각과 물 내림 버튼이 생겼다.
  - 유리 샤워 칸막이, 오른벽 창문, 선반, 천장 레인 샤워기가 생겼다.
  - 뒷벽 가운데에 다른 배열의 타일 띠가 생겼다.
  - 바닥이 밝은 회색으로 바뀌었다.
  - 도기 모양도 조금 달라졌다.
- **원인 1: 입력 그림**
  - 편집기 AI 변환 캡처(`editor.tsx`의 `captureExport('image/png', false, 1024, …)`)는 벽 구조가 있을 때만 3D 렌더러를 쓴다(`projectDesignPreviewRoomContext`). 나머지는 **2D 합성의 옛 구도(회색 여백)**다.
  - 1단계의 방 안 시점(`projection: 'room-eye'`, `roomEyeView(room, preset)`, 천장 포함)은 공간 둘러보기·고화질 다운로드에만 쓰인다.
  - 3단계 실측(방 안 시점 입력)에서는 구도·설비를 지켰고, 추가된 것도 작은 물건(휴지걸이·샤워헤드) 정도였다. **여백과 열린 천장이 없으면 지어내는 양이 줄어든다.**
- **원인 2: 모델 성향**: FLUX.2 klein 4B는 작은 편집 모델이고 입력이 512px 미만이다. 욕실을 "그럴듯하게 완성"하려 하고, "추가하지 말라"는 지시를 잘 따르지 않는다. 타일 무늬가 뭉개져 배열을 새로 지어낸다.
- **지금 있는 것**(main `18c2232`)
  - 프롬프트 색 보강
  - 면별 색 검사·보정(`src/lib/ai-export/color.ts`)
    - 면 마스크: 3D `RoomViewerRenderer.regionMask`, 2D `PhotoCompositor.exportImage`의 `onRegionMask`
    - 구도 정렬 기준 0.4. "방을 넓혀 그린 결과"는 0.34라 검사·보정을 건너뛴다. 이번 사례가 이 경우다.
  - Gemma 제품 확인(`check-contract.ts`, `check-server.ts`): 배치한 제품이 **있는지만** 본다. 한 클릭에 FLUX 1회 + 확인 1회.
  - 참고: [FLUX 문서](../flux-export.md), [자재 색 결과](../flux-material-color-results-20260927.md), [3단계 결과](../export-realism-stage-3-results-20260927.md)

## 1. 먼저 읽는다

- `AGENTS.md`, `.agents/skills/sjn-workflow/SKILL.md`와 references, `node_modules/next/dist/docs/`의 관련 문서
- `src/components/editor/editor.tsx`(`captureExport`, AiExport 연결)
- `src/components/editor/ai-export.tsx`
- `src/lib/ai-export/*`: `prompt.ts`, `scene.ts`, `scene-contract.ts`, `server.ts`, `check-*.ts`, `color.ts`
- `src/lib/room-viewer/renderer.ts`(`export`, `fixtureBounds`, `regionMask`), `view-state.ts`(`roomEyeView`, `RoomEyePreset`, `ROOM_EYE_*`)
- `src/lib/render/design-preview-context.ts`
- 테스트: `tests/flux-*.test.ts`, `tests/flux-grounding-browser.ts`, `tests/flux-material-color-payload.ts`, `tests/flux-stage3-payload.ts`, `e2e/flux-export.spec.ts`

## 2. 작업 환경

- `C:\app\SJN`의 main에서 새 브랜치 `claude/flux-input-in-room`을 만든다(워크트리 사용 가능).
- 기존 결과 자료는 `.claude/worktrees/flux2-klein-9b-cleanup-1a3200/test-results/`의 `flux-compare-20260925`, `export-realism-stage-3`, `flux-material-color`, `flux-user-example-20260927`에서 읽거나 복사한다.
- bare `git stash`는 쓰지 않는다. 커밋은 작업 단위로 한다. 푸시·main 병합은 사용자가 요청할 때만 한다.

## 3. 작업 1: FLUX 입력을 방 안 시점 3D 렌더로 (무료)

- **대상**: 방(`scene.room`)이 있는 모든 프로젝트(기본 방, 벽 구조, 사진으로 만든 비교 공간). AI 변환 입력을 `RoomViewerRenderer`의 **방 안 시점** 렌더로 바꾼다. 방이 없는 옛 프로젝트가 있다면 지금처럼 두고 그 조건을 적는다.
- **시점 고르기**
  - AI 변환 창에서 "방 안 · 가운데(기본) / 왼쪽 모서리 / 오른쪽 모서리"를 고른다(`roomEyeView` 프리셋).
  - 공간 둘러보기에서 방 안 시점을 저장해 두었다면 "저장한 방 안 시점"도 고를 수 있게 한다.
  - 방 바깥(궤도) 시점은 여백 때문에 지어내기가 늘어나므로 AI 입력으로 쓰지 않는다. 사진 시점(`source-photo`)을 둘지는 천장·여백이 보이는지 확인하고 판단해 적는다.
- **한 시점으로 모두 맞춘다**
  - 원본 칸에 보이는 그림, FLUX 입력, 설비 상자(`fixtureBounds`), 면 마스크(`regionMask`), 프롬프트의 설비 위치, 색 검사·보정이 **모두 같은 시점**을 쓴다.
  - 사진 조명 맞춤(`RenderSnapshot.lighting`)은 지금처럼 반영한다.
  - 겹쳐 찍기와 사진 효과는 넣지 않는다(3단계 판단 유지). 설비 그림자는 2단계 이후 한 장 렌더에도 있다.
- **천장 문장**
  - 방 안 시점에는 천장과 평판 등이 보인다. 장면 계약에 천장 정보(색, 등 1개)를 enum·hex로 더한다.
  - 서버 프롬프트에 "The ceiling is plain white (#…) with one flat light panel" 같은 문장을 넣는다.
  - 스키마는 엄격하게 두고, 이전 요청 형식(천장 없음)도 받는다.
- **"빈 벽" 문장**
  - 벽에 아무것도 없는 영역을 긍정문으로 알리는 문장을 만든다. 예: "Each wall is continuous tiles from floor to ceiling; the only objects are the fixtures listed."
  - 이 문장을 넣을지는 5절 비교로 정한다. 없는 물건 이름(창문 등)을 나열하면 오히려 불러올 수 있으니 피한다.
- **성능**
  - 벽 구조 없는 프로젝트에서 3D 렌더러를 새로 띄우는 시간을 Iris Xe(D3D11)와 SwiftShader에서 잰다.
  - 준비 단계는 기존 대기 표시(경과 시간)가 보이게 한다. 렌더러는 캡처 뒤 해제한다.
- **바꾸지 않는 것**: 편집 화면, 시안 미리보기, 일반 내보내기, 공간 둘러보기

## 4. 작업 2: 추가된 물건·타일 배열 변화 알리기 (호출 수 그대로)

### 제품 확인을 넓힌다 (같은 Gemma 한 번)

- 기존 확인 응답에 두 가지를 더한다.
  - `extras`: **목록에 없는 물건**. 종류 enum(창문, 문, 유리 칸막이, 선반, 수건걸이, 휴지걸이, 샤워헤드, 물 내림 버튼, 거울, 수납장, 욕조, 변기, 세면대, 기타)과 위치 enum(왼벽, 뒷벽, 오른벽, 바닥, 천장). 최대 8개.
  - `walls`: 보이는 벽마다 `uniformTiles: yes | no | unsure`. 한 가지 타일 사이에 다른 배열의 띠·판이 생겼는지 본다.
- 서버가 배치 제품 목록(종류·상자)을 넣어 질문을 만든다. 모델은 목록에 있는 것과 없는 것을 구별해 답한다. 응답은 엄격한 JSON 스키마로 받는다.
- 기존 규칙(동일 출처·로그인·`sjn-gateway`·재시도 1회·진단에는 크기만)을 그대로 따른다. 호출은 한 클릭에 1회 그대로다. 출력 토큰 증가에 따른 뉴런 변화를 실측한다(지금 회당 약 6.7뉴런).

### 기준 정답과 오프라인 평가

- 기존 결과 전부에 대해 **사람이 본 정답표**를 먼저 만든다. 눈으로 보고 추가된 물건과 타일 띠를 적는다.
  - 사용자 사례 1장
  - 2026-09-25 6장: A 유리 칸막이, C 문 등
  - 3단계 4장: 휴지걸이, 샤워헤드
  - 자재 색 8장
- 정답표는 호출 없이 만든다. 확인 호출은 5절 승인 뒤에 한다.

### 화면

- 결과 아래에 알린다. 예: "배치하지 않은 물건이 생겼을 수 있어요: 유리 칸막이(가운데), 창문(오른쪽 벽)", "뒷벽 타일 배열이 원본과 달라 보여요."
- 자동으로 다시 만들지 않는다. 다시 만들기를 권하는 문구만 둔다.
- 여러 알림(제품 확인, 추가 물건, 타일 배열, 색 경고, 구도 변경)이 한꺼번에 나와도 390px에서 읽기 쉽게 정리한다. 중요도 순서를 정한다.

## 5. 실제 비교 (사용자 승인 뒤에만)

- **먼저 호출 수와 예상 뉴런을 알리고 승인받는다.**
- **FLUX 6회**(약 660뉴런)
  - 사용자 사례와 비슷한 기본 방: 회색 무늬 벽, 진한 회색 바닥 타일, 왼벽 벽걸이 세면대·샤워, 뒤 오른쪽 변기
  - 입력 3가지 × seed 2개: 옛 구도(2D, 여백) / 방 안·가운데 / 방 안·왼쪽 모서리
  - "빈 벽" 문장 효과까지 보려면 호출을 2회 늘릴지 승인 때 함께 묻는다.
- **Gemma 확인 약 25회**(회당 약 7~10뉴런, 약 250뉴런): 새 결과 6장 + 기존 결과 19장
- **합계 약 910뉴런(약 $0.01)**, 하루 무료 한도 안
- **실행 방법**
  - 운영 `AI` 바인딩을 쓰는 로컬 임시 Worker(127.0.0.1, 호출 상한을 코드에 둠)로 앱 서버와 같은 요청을 보낸다.
  - 도구 권한 검사로 막히면 우회하지 않는다. 사용자에게 실행할 명령을 한 줄씩 주고 결과 파일을 받는다.
  - `wrangler whoami`로 로그인을 먼저 확인한다(로그인은 사용자가 한다).
- **판정표**(결과마다)
  - 새로 생긴 구조·물건 수(정답표 기준)
  - 제품 유지, 타일 띠
  - 면 색 ΔE(기존 색 검사), 구도 정렬 점수
  - 확인 응답의 참·거짓(추가 물건, 타일 배열)
- 결과 이미지는 `test-results/flux-input-in-room/`에 나란히 저장하고 직접 확인한다.

## 6. 채택 기준

- **작업 1**(방 안 입력)
  - 옛 구도보다 새로 생긴 구조·큰 물건(벽 조각, 창문, 문, 유리 칸막이)이 뚜렷이 줄었다. 예: 장당 평균 절반 이하.
  - 새 입력 결과의 구도 정렬이 모두 0.4 이상이라 색 보정이 적용된다.
  - 제품 유지가 나빠지지 않았다.
- **작업 2**(확인 확장)
  - 큰 추가 물건(창문·문·유리 칸막이·벽 조각)을 정답표 대비 90% 이상 잡는다.
  - 정상 결과에서 거짓 알림은 10장당 1개 이하다.
  - 타일 배열 판정은 거짓 알림이 많으면 화면에 넣지 않고 기록만 한다.
  - 작은 물건(휴지걸이 등)은 잡는 만큼 보인다. 놓침은 한계로 적는다.
- 기준이 애매하면 결과와 선택지를 사용자에게 보고하고 결정을 받는다.

## 7. 반드시 지킬 조건

- 유료 호출은 승인 뒤에만, 상한 안에서 한다. 실패해도 자동으로 다시 부르지 않는다.
- 한 클릭에 FLUX 1회 + 확인 1회를 넘지 않는다.
- 토큰·자격 증명을 채팅·소스·브라우저에 넣지 않는다. 사용자 자유 문장은 모델로 보내지 않는다. 진단에는 크기·개수만 남긴다.
- 편집 화면, 시안 미리보기, 일반 내보내기 출력은 바꾸지 않는다(기준선 픽셀 차 0).
- 저장된 프로젝트·시점을 그대로 읽는다.
- Tailwind를 우선 쓴다. `globals.css`의 `p{margin:0}` 때문에 여백이 필요한 표시 요소는 `<div>`로 만든다.
- 줄바꿈은 작업 사본 CRLF, 저장소 LF다. Prettier는 쓰기에 `--end-of-line crlf --write`, 검사에 `--end-of-line auto`를 쓴다. typecheck 뒤 `next-env.d.ts`를 되돌린다.

## 8. 검증

- **단위**
  - 시점 선택과 입력·상자·마스크 일치
  - 천장 계약·프롬프트 문장(결정성, 길이 상한, 이전 형식 호환)
  - 확인 스키마 확장(거절 규칙, 이전 응답 처리), 알림 정리 규칙
- **브라우저**
  - 벽 구조 없는 기본 방의 방 안 캡처와 `fixtureBounds`·`regionMask` 일치
  - `flux-grounding-browser.ts`
  - 렌더 기준선 불변(`render-realism-browser.ts`, `room-viewer-render-browser.ts`)
- **e2e**(모의 응답) `e2e/flux-export.spec.ts` 확장
  - 기본 방에서 방 안 입력 전송
  - 시점 선택
  - 추가 물건·타일 배열 알림
  - 390px, 다운로드
- `npm run typecheck`, `npm run lint`, 변경 파일 Prettier
- 전체 `npx vitest run`: 알려진 환경 실패(`reconstruction-corpus` 해시, `reconstruction-source-plane-mapping`, 로컬 D1/R2 첫 연결 초과) 외 실패 없음. CPU 부하 중 시간 초과는 환경 문제로 구분한다.

## 9. 문서와 보고

- `docs/flux-input-in-room-results-<실행일>.md`: 원인 검증, 정답표, 비교 판정표·이미지, 실제 호출 수·뉴런, 채택안과 이유
- `docs/flux-export.md`: 입력 시점 규칙, 천장 문장, 확인 확장, 알림 규칙 갱신
- 사용자에게 보이는 동작이 바뀌므로 `.agents/skills/sjn-workflow/references/project-overview.md`를 맞춘다.
- `docs/verification.md` 맨 위에 항목을 추가한다.
- **보고**
  - 사용자 사례 전후 비교
  - 채택안, 파일별 변경과 이유, 테스트 결과
  - 남은 한계(작은 물건 놓침, 도기 모양 미세 차이 등)
  - 다음 후보: 더 큰 편집 모델 비교(유료, 승인 대상)
