# 자재 방향 사진 만들기 결과 (2026-10-13)

자재 폼의 "AI로 방향 사진 만들기"([자재 이미지](material-images.md))를 만들기 전에 한 시험과, 만든 뒤의 실제 호출을 기록한다. 이미지·장부는 git에서 뺀 폴더에 있다.

## 1. 구현 전 시험 (2026-10-13, 사용자 승인 AI 호출 20회)

- 자료: `test-results/product-representation/real/gen/`
  - 시트: `sheet-flux-bathtub.png`(사진+문장), `sheet-models-bathtub.png`(모델 비교), `sheet-4b-end.png`(새 문장·곧은 가이드), `sheet-guides.png`·`sheet-4b-guide.png`(3D 가이드)
  - 장부: `ledger.jsonl`·`ledger-results.jsonl`, `ledger-big.jsonl`, `ledger-4b-v2.jsonl`, `ledger-4b-v3.jsonl`
  - 참고 도구: `tools/guide3d-bathtub.mjs`(욕조 가이드 렌더러), `tools/flux-test-worker.js`(시험용 Worker, 요청당 한 번 호출)
- 입력: 타원형 독립 욕조 사진(`test-results/product-representation/real/input/` 61 흰 배경 사선, 54 위에서, 55 연출 배경 사선), 1700 × 560 × 750 mm.

| 시험 | 호출 | 결과 |
| --- | --- | --- |
| 사진 + 문장만(klein 4B) | 4회(정면 2, 왼쪽 2), 14~27초 | 정면은 됐다. "짧은 끝에서 본 모습"을 요청한 왼쪽 2장 모두 사선의 긴 면을 그렸다 |
| 더 큰 모델(klein 9B, FLUX.2 dev) | 4회 | 둘 다 왼쪽 요청에 긴 면을 그렸다. 편집 모델이라 image 0(사진)의 구도를 유지하려 한다 |
| 새 문장(A) / 곧은 사다리꼴 가이드(B), klein 4B | 4회 | A는 사선으로 남았고 연출 사진의 파란 바닥이 욕조 색에 섞인 답이 있었다. B는 1장은 욕조, 1장은 "플라스틱 수납통"이 됐다 |
| 3D 가이드(image 0) + 실제 사진 2장(images 1~2), klein 4B | 8회(정면 4, 왼쪽 4), 10~28초 | **8장 모두** 가이드의 시점·비율·모양을 따랐고 재질·테두리도 자연스러웠다 |

- 3D 가이드의 남은 문제: 프롬프트에 적은 세부(오버플로 홈)를 그 시점에서 안 보이는 곳에 그렸다(8장 중 3장). 배수구를 벽에 그렸다(8장 중 1장). 같은 조건에서도 결과가 흔들린다.
- 가이드 품질이 결과를 정한다. 곧은 사다리꼴 가이드는 수납통이 됐고, 실제 곡선·턱·비율을 넣은 3D 렌더는 욕조가 됐다.
- 연출 배경(파란 바닥, 소품)이 있는 참고 사진은 그대로 넣으면 결과에 섞일 수 있다.
- 사용량: 공식 요금표로 추정하면 회당 약 75~125뉴런이다(입력 타일 5.37, 출력 타일 26.05).

## 2. 그래서 만든 것

- image 0은 그 종류의 **표준 모형을 등록 크기로 그린 가이드**다(무광 회색, 약 10° 위, 직교, 흰 바탕, 바닥 제품만 옅은 접지 그림자). 욕조의 타원형 독립 욕조는 시험 렌더러의 모양(곡선 벽·턱·평평한 테두리·안쪽 벽과 바닥)을 표준 모형에 넣었다.
- images 1~3은 **배경을 지운 참고 사진**(흰 바탕)이다.
- 방향마다 **"이 시점에서는 X가 안 보인다"**를 쓰고, 세부 묘사 문장(오버플로 등)은 쓰지 않는다(자유 입력 없음).
- 결과가 흔들리므로 방향마다 **후보 2장**을 만들어 고르게 했다.
- 모델은 klein 4B만 쓴다(9B·dev는 옆모습에서 나을 게 없었고 비싸다).

### 가이드 형태와 방향 문장

| 종류 | 형태(enum) | 가이드 |
| --- | --- | --- |
| 욕조 | `oval-freestanding`(기본), `rectangular` | 타원형 독립 욕조(시험 모양) / 기존 사각 욕조 표준 모형 |
| 변기 | `lid-closed`(기본), `lid-open` | 표준 변기 모형(뚜껑 닫힘·열림). 바닥형·매립형만 |
| 세면대 | `wall-round`·`wall-rectangular`·`pedestal-round`·`pedestal-rectangular` | 벽걸이/받침대 × 둥근/사각 그릇. 기본은 설치 방식이 벽걸이면 `wall-round`, 아니면 `pedestal-round` |

방향 문장(서버가 씀, [prompt](../src/lib/direction-photo/prompt.ts)):

- 욕조: 정면 "The view shows the long side of the tub." / 왼쪽·오른쪽 "The view shows the narrow rounded end of the tub; the long sides are not visible."(사각은 "narrow end") / 뒤 "The view shows the long back side of the tub."
- 변기: 정면 "…from the front: the bowl faces the camera and the tank is behind it." / 왼쪽 "…from its left side: the bowl points to the left of the picture and the tank is on the right." / 오른쪽은 좌우를 바꾼 문장 / 뒤 "…the back of the toilet: the tank faces the camera and the bowl is behind it."
- 세면대: 정면 "…from the front, where a person stands." / 왼쪽 "…from its left side: its front points to the left of the picture and its back, the wall side, is on the right." / 오른쪽은 좌우를 바꾼 문장 / 뒤(받침대만) "…the back of the washbasin, the side that goes against the wall."

안 보이는 것("In this view … is/are not visible; do not draw it/them."): 10° 위에서 기하로 가려지는 것만 쓴다.

- 욕조(모든 방향): the drain in the bottom of the tub. 그리고 "Draw no hole, drain or overflow on the outside of the tub."(시험에서 배수구를 바깥 벽에 그린 답이 있었다)
- 변기: 정면 the back of the tank, the waste pipe / 옆 the waste pipe / 뒤 the front of the bowl. 모든 방향에 the water in the bowl(가장자리 아래 낮게 있다).
- 세면대: 정면 the drain hole in the bowl과 the waste pipe(벽걸이는 and the wall fixings) / 옆 the drain hole in the bowl / 뒤 the inside of the bowl.

카테고리별 앞 정의는 [product-photo-prompt](../src/lib/product-photo-prompt.ts)의 문장을 그대로 쓴다(변기: 앉은 사람의 다리 쪽, 욕조: 방을 향한 긴 면, 세면대: 사람이 서는 쪽).

## 3. 구현 후 실제 호출 (2026-10-14 00:07, 사용자 승인 상한 8회)

- **방법:** 실제 화면을 그대로 돌렸다(`tests/direction-photo-real/run.mjs`). 로컬 개발 서버(`npm run dev`)의 `wrangler.dev.jsonc`에 원격 AI 바인딩을 이 시험 동안만 붙였다가 되돌렸다(커밋 안 함). 관리자 자재 등록 → 욕조 1700 × 560 × 750 mm, 바닥형, 타원형 독립 욕조, 좌우 대칭 순서로 진행했다. 참고 사진은 61(흰 배경)과 55(연출 배경: 파란 바닥, 조명, 소품) 두 장이다. 가이드·배경 제거(BiRefNet)·라우트·프롬프트는 모두 앱 코드다. 스크립트가 라우트 요청마다 장부를 남기고 8회를 넘으면 보내지 않는다. 자재는 저장하지 않았다.
- **호출:** klein 4B 8회, 모두 200, 9.2~20.5초. 처음 실행은 정면 2·왼쪽 2·뒤 2(화면 예상 "AI 요청 6회 · 약 513뉴런")였고, 이어서 사람이 하듯 "왼쪽 다시 만들기"로 2회를 더 했다. 사용량은 공식 요금표로 추정하면 약 750뉴런이다(정면·뒤 496×192 가이드 회당 약 68, 왼쪽 448×496 회당 약 120). 응답에서 잰 값은 아니다.
- **자료(git 제외):** `test-results/direction-photo-real/`
  - 시트 `sheet.png`: 사진과 배경 지운 사진, 가이드 4장, 답 8장, 칸에 들어간 사진과 기준점
  - 장부 `ledger.jsonl`, 보낸 가이드·사진 `sent-*.png`, 답 `answers/`, 화면 `screen-*.png`, 측정 `measure.json`
- **배경 제거:** 연출 사진의 파란 바닥·조명·소품이 지워져 흰 바탕의 욕조만 보냈다. 답에 파란색이 섞인 것은 없었다.
- **가이드를 따랐는가**(`tests/direction-photo-real/measure.mjs`: 흰색이 아닌 윤곽을 상자에 맞춰 늘린 뒤 겹침, 상자의 가로/세로 비율):

| 방향 | 가이드 비율 | 답(비율 · 겹침) | 시험(2026-10-13) |
| --- | --- | --- | --- |
| 정면 | 2.50 | #1 2.04 · 0.90, #2 2.26 · 0.96 | 2.33~2.42 · 0.90~0.97 (4장) |
| 왼쪽(짧은 끝) | 0.89 | #3 1.26 · 0.80, #4 0.94 · 0.93, #7 1.38 · 0.90, #8 0.95 · 0.91 | 0.84~0.88 · 0.74~0.97 (4장) |
| 뒤 | 2.50 | #5 2.18 · 0.85, #6 2.38 · 0.94 | (시험 안 함) |

- **결과 해석**
  - 정면·뒤 4장은 모두 가이드의 긴 면·타원 모양을 따랐다. 다만 정면은 가이드보다 조금 높게(비율 2.04~2.26) 그렸고 화면을 77~80%만 채웠다(시험 약 90%). 방은 사진의 보이는 영역을 쓰므로 화면을 덜 채운 것은 문제가 아니다.
  - **짧은 끝(왼쪽)은 4장 중 2장(#4, #8)만 가이드의 비율을 지켰다.** 2장(#3, #7)은 폭이 넓은 다른 각도의 짧은 욕조처럼 그렸다(비율 1.26, 1.38). 시험은 4장 모두 지켰다(0.84~0.88). 그래서 후보를 고르고 다시 만들 수 있게 한 것이 필요하다. 4장씩이라 표본이 작다.
  - 시험과 다른 점은 둘이다. 가이드가 조금 어둡다(제품 평균 회색 194~197 대 207, 시험 가이드에는 오버플로 표시가 있었다). 프롬프트에 사양서가 정한 문장(카테고리 앞 정의 "Its front is the long side facing the room …", 안 보이는 것, 크기)을 더했다. 옆모습에서 "long side"라는 말이 긴 면을 그리게 했을 수 있다. 상한(8회)을 다 써서 원인을 가르는 시험은 하지 않았다.
  - 다음에 할 시험(승인 필요): 같은 사진·가이드로 지금 프롬프트와, 옆모습에서 앞 정의·크기 문장을 뺀 프롬프트를 seed를 같게 4장씩 비교한다.
- **칸에 넣기:** 스크립트는 방향마다 첫 후보를 골랐다(사람의 선택이 아니다). 왼쪽은 첫 후보 #7(비율이 어긋난 답)이 들어갔고 오른쪽은 그 반전이다. 정면·왼쪽·오른쪽·뒤 칸이 모두 채워졌다. 기준점은 정면 (50, 84)%, 왼쪽·오른쪽 (50, 75)%, 뒤 (50, 87)%다. 답의 아래 여백만큼 위로 올라간 값이며, 배경을 지운 윤곽의 아래 가운데다. 스크립트가 뒤 칸 그림을 다 불러오기 전에 읽어 `slot-뒤.png`는 저장되지 않았다(기준점 값은 읽었다). 스크립트는 이후 그림을 기다리게 고쳤다.
