# 도기 비침 시험 (2026-11-19)

- 남은 문제: 도기 비침이 강한 장면이 있다.
  - "도기에 덜 비치는 B를 고를게"(`r-white-90-424242`, 11-19 좁힌 문장 쪽이 더 비침)
  - "위생도기들 빛 비침이 너무 심해"(11-17)
- 지금 앱(main `aee02c7`)이 기준선이다.
  - 사진 제품 장면은 좁힌 문장 결과(`narrow`)가 지금 앱이다.
  - 표준 모형 장면은 11-18 그림(`sb5lkf`)이 지금 앱이다(문장이 같음).
  - 시험 그림에서는 둘 다 `base`라 부른다.
- 시험 도구는 `tests/fixture-glare/`, 그림은 `test-results/fixture-glare-20261119/`(git 제외)에 있다.

## 1. 비침 숫자 (AI 없음)

- `glare-score.ts`가 앱 그림의 도기마다 잰다. 렌더 도기에서도 같이 잰다.
  - `bright`: 중앙값보다 8 L\* 넘게 밝은 픽셀 비율
  - `peak`: p98 − p50
  - `bands`: 진한·밝은 띠
- 사용자가 더 비친다고 고른 `r-white-90-424242` 변기는 좁힌 문장 쪽 `bands`가 4.72로, 이전 문장 3.43보다 높다. 사람 판단과 맞는다.
- 렌더보다 `bands`가 1.15배 넘게 센 도기는 89장 중 75장에 있다.
- **좁힌 문장의 문제 하나:** 같은 장면에서 원기둥 세면대를 대야 없이 뚜껑 덮인 원통(휴지통 모양)으로 그렸다.

## 2. 평가 기준 (사용자 평가 전에 적음)

1. 도기 비침·반짝임이 그림 전체에서 눈에 띄게 준다.
2. 도기가 평평하거나 앱 그림처럼 보이지 않는다.
3. 없던 물건·다른 물건이 늘지 않는다.
4. 원래 white인 표준 모형 장면이 지금과 같거나 낫다.
5. 처리 시간과 AI 호출 수를 적는다.

## 3. 후보

| 이름 | 쉬운 말 | 하는 일 |
| --- | --- | --- |
| G1 | 다듬기로 밝은 띠 줄이기(AI 없음) | `glare-method.ts`. 도기 `bands`가 렌더의 1.15배를 넘으면, 중앙값보다 밝은 쪽 L\*를 (렌더 × 1.15) ÷ `bands`만큼(최소 0.45) 줄인다. `g1d`는 어두운 쪽도 줄이는데, 도기가 회색으로 평평해져 평가에서 뺐다. |
| soft | 고정 문장의 "ceramic glaze, metal reflections"를 "soft ceramic glaze without mirror-like reflections, metal reflections only on taps"로 | `run-glare.ts`, AI 호출 필요 |
| nometal | 같은 자리를 "soft ceramic glaze"로(금속 반사를 뺌, 문장이 17자 짧아짐) | `run-glare.ts`, AI 호출 필요 |

- **호출(사용자 승인 11-19, 20회·추정 약 2,200):** 두 번째 계정 20회, 추정 2,191뉴런.
  - 19회 200이다. `reg streaks-90-424242` `soft` 1회는 Cloudflare가 "output has been flagged"(400)로 거절해 다시 보내지 않았다.
  - 장면: 사진 제품 `r-white-90-424242`·`r-streaks-90-424242`·`r-charcoal-0-777001`·`n-waves-90-777001`, 표준 모형 `t-marble-777001`·`t-charcoal-777001`·`t-large-424242`·`t-accent-777001`·`b-charcoal-0-424242`·`x-side-424242`(마지막 확인)
- **내가 본 것:**
  - 두 문장 모두 세로 반사 띠가 조금 약해졌다.
  - `r-white-90-424242`는 두 문장 모두 뚜껑 원통 대신 대야와 수전이 있는 세면대로 그렸다.
  - `soft`는 `n-waves-90-777001`의 벽 세면대를 수건으로, 변기를 비데처럼 그렸다(다른 물건).
  - G1은 밝은 띠가 조금 옅어지고 조금 무광처럼 보인다.
- **세트 `g1`:** 지금 앱(`base`) 대 `soft` 9쌍, `nometal` 10쌍, G1 10쌍. 그림 전체, 도기만 보고, 좌우 반반(15/29).
  - 만들기: `node tests/fixture-glare/review-build.mjs --set g1 --keep soft,nometal,baseg1 --base base --ids …`
  - 보기: `node tests/ledge-ai/review/server.mjs --root fixture-glare-20261119 --set g1 --port 8794`
  - 채점: `node tests/fixture-glare/review-score.mjs --set g1`
- **결과(11-19, `review-score.mjs --set g1`):**

| 후보 | 낫다 | 비슷하다 | 못하다 |
| --- | --- | --- | --- |
| `soft` (9쌍) | 3 (`r-white-90-424242`, `t-large-424242`, `x-side-424242`) | 5 | 1 (`n-waves-90-777001`) |
| `nometal` (10쌍) | 2 (`x-side-424242`, `r-white-90-424242`) | 7 | 1 (`n-waves-90-777001`) |
| G1 (10쌍) | 0 | 10 | 0 |

  - 글:
    - "둘 다 변기 유광 비침이 너무 강하다"(`r-white-90-424242`, G1 쌍)
    - "A는 좀 이상한데? 변기에 세면대가 달리고 수건이 걸려있고…"(`n-waves-90-777001`, A = `soft`)
  - **사용자 목표(11-19):** "내가 궁극적으로 원하는 것은 유광 자재들 빛 비침이 적은 것을 원해. 이걸 위주로 보고 평가했어."
    - 도기만이 아니라 유광 타일 등 유광 자재 전체의 비침이다([남은 문제](open-issues-20261116.md) 4번과 이어진다).
  - G1은 그림 전체에서 느껴지지 않아 쓰지 않는다.
  - 두 문장은 효과가 작다. `soft`는 다른 물건으로 바꾼 장면이 있다.

## 4. 유광 자재 전체 비침 (사용자 결정 11-19: "유광 자재 전체 비침 시험")

- **후보(`run-glare2.ts`):** 고정 문장의 빛 부분 "physically plausible lighting, contact shadows, subtle material texture, ceramic glaze, metal reflections and transparent glass."를 바꾼다.
  - `diffuse`: "soft diffuse lighting, contact shadows and subtle material texture; glossy tiles and ceramics show only faint, soft highlights, with no mirror-like reflections, light streaks or glare; transparent glass."
  - `diffsemi`: `diffuse`에 더해 타일·제품의 "glossy"·"polished"를 "semi-gloss"로 말한다.
  - 두 문장 모두 2,400자 안이다.
- **3D 그림의 환경 반사 줄이기:** 렌더러(`render/finish.ts` 유광 거칠기 0.24)에 시험용 설정을 넣고 장면·빈 방 그림을 모두 다시 그려야 해서 이번에는 하지 않았다. 문장으로 부족하면 다음에 한다.
- **호출:** 두 번째 계정 24회, 추정 2,630뉴런. 23회 200이다. `dev charcoal 777001 diffuse` 1회는 내용 필터 거절이라 다시 보내지 않았다.
  - 장면: 유광 타일 `n-glossy-90-424242`·`t-scored-424242`·`t-subway-777001`·`x-structure-424242`·`t-marble-424242`(폴리싱)·`t-roman-424242`(올리브 유광 벽돌, 마지막 확인), 도기 `r-white-90-424242`·`r-streaks-90-424242`·`n-white-90-424242`·`t-charcoal-777001`·`b-charcoal-0-424242`, 물건이 바뀌던 `n-waves-90-777001`
  - `n-white-90-424242`의 `base`는 11-18 그림이다(좁힌 문장 결과가 없음).
  - 11-19(UTC) 이 계정 사용 추정은 4,821이다.
- **내가 본 것:**
  - 두 문장 모두 도기가 눈에 띄게 덜 반짝인다(`r-white-90-424242` 변기의 세로 반사 띠가 크게 준다).
  - 유광 타일 벽은 앱 다듬기가 이미 빛을 1/4만 남겨 세 그림이 비슷하다.
  - 다른 물건으로 바뀐 것은 못 찾았다.
- **세트 `g2`:** 지금 앱 대 `diffuse` 11쌍, `diffsemi` 12쌍. 질문: "어느 쪽 유광 자재(도기·유광 타일)의 빛 비침이 더 적고 자연스럽나".

## 5. 등록 자재로만 다시 (사용자 요청 11-19)

- 사용자 글: "실제 등록된 자재 이미지로 테스트 하게 해줘. 너가 3d로 만들지 말고"
  - 표준 3D 모형 장면(`t-*`·`x-*`·`b-*`)을 빼고, 자재 등록으로 올린 사진 제품과 등록 유광 타일만 쓴다.
  - 세트 `g2`는 평가하지 않고 닫았다.
- **새 장면 `gloss`**(`tests/fixture-haze/specs.ts`, 그룹 `g`):

| 장면 | 벽 | 제품 | 방향 |
| --- | --- | --- | --- |
| `olive` | SI ROMAN OLVIE-G(올리브 유광 벽돌) | 모레나 Z08L + 포레 LC-3200 | 0°·90° |
| `black` | HE 비셀라도 니그로 브릴로(검정 유광) | 마스 LL-821 + 포레 투피스 LC-2200 | 0° |
| `beige` | 타일의 기준 6134P(베이지 폴리싱) | 모니카 Z23L + 아크 LC-3100J | 90° |
| `white` | HSC DW 9467(흰 유광) | 탑볼스탠드 Z01L + HSC 606J | 0° |

  - 그리기: `scenes.ts --group gloss`, `behind.ts --new --group gloss`
- **호출(사용자 승인 11-19, 24회·추정 약 2,630):** `run-glare3.ts`, 지금 앱 문장(`app`)·`diffuse`·`diffsemi`. 22회 200이다.
  - `olive-90`·`beige-90`의 `diffuse` 2회는 내용 필터 거절이다. `diffuse`는 지금까지 4회 중 3회가 옆 시점·변기 장면에서 걸렸다.
  - 11-19(UTC) 이 계정 사용 추정은 7,451이다.
- **내가 본 것:**
  - 도기는 두 문장 모두 덜 반짝인다.
  - 올리브·검정 벽에 남는 천장 조명 반사 점은 3D 그림(캡처)에 있던 것이다. 줄눈 되돌리기가 렌더의 결을 다시 넣어 남는다. AI 문장으로는 줄지 않는다.
  - 벽의 비침을 줄이려면 AI에 보내는 3D 그림의 유광 반사를 줄여야 한다(`render/finish.ts` 유광 거칠기 0.24).
- **세트 `g3`:** 등록 자재만, 지금 앱 대 `diffuse` 10쌍·`diffsemi` 12쌍. 새 장면 8개와 앞의 등록 제품 장면 4개(`r-white-90-424242`·`r-streaks-90-424242`·`n-waves-90-777001`·`n-glossy-90-424242`). 좌우 반반(11/22).
- **결과(11-19, `review-score.mjs --set g3`):**

| 후보 | 낫다 | 비슷하다 | 못하다 |
| --- | --- | --- | --- |
| `diffsemi` (12쌍) | 4 (`r-white-90-424242`, `g-olive-90-424242`, `g-beige-90-424242`, `g-olive-0-777001`) | 8 | 0 |
| `diffuse` (10쌍) | 3 (`r-white-90-424242`, `g-black-0-424242`, `n-glossy-90-424242`) | 4 | 3 (`n-waves-90-777001`, `g-black-0-777001`, `g-white-0-777001`) |

  - 글:
    - "B너무 빛비침이 심하다 변기"(`r-white-90-424242`, B = 지금 앱)
    - "A는 왼쪽벽에 거울인가? 좀 이상하다"(`g-black-0-424242`, A = 지금 앱)
    - "A처럼 세면대 손잡이가 생긴다든가 이런 게 너무 많다"(`g-beige-90-424242`, A = 지금 앱: AI가 지어낸 수전)
    - "둘 다 변기 윗 부분 물 넣는 곳 이 찌그러져 있지?"(`g-olive-0-424242`), "변기 윗부분 두 사진 다 찌그러져있음"(`g-black-0-424242`): 두 쪽 공통, 문장과 다른 문제
  - **`diffsemi`가 앞선다.** 못하다가 없다. `diffuse`는 못하다 3에 내용 필터 거절도 잦다.

## 6. 앱에 넣기 (사용자 결정 11-19: "diffsemi 앱에 + 3D 반사 시험")

- **바뀐 것** (`src/lib/ai-export/contract.ts`·`prompt.ts`):
  - 고정 문장의 빛 부분을 "soft diffuse lighting, contact shadows and subtle material texture; glossy tiles and ceramics show only faint, soft highlights, with no mirror-like reflections, light streaks or glare; transparent glass."로 바꿨다.
  - 설비 문장과 타일 문장에서 `glossy`·`polished` 마감을 `semi-gloss`로 말한다(`finishWord`). 금속(`metal`) 설비는 그대로다.
  - 빈 방 문장(합성 내보내기, `FLUX_EMPTY_ROOM_PROMPT`)은 그대로 둔다. 시험하지 않았다.
- **길이:** 고정 문장이 75자 길어졌다.
  - 2,400자를 넘는 장면은 전처럼 뒤 설비부터 위치·크기를 뺀다.
  - 시험 장면 20개 중 9개는 앱 글이 시험 때 보낸 글과 다르다. 마지막 설비 하나의 위치·크기가 빠진다(`tests/fixture-glare/app-prompt-check.ts`).
  - 대상: `b-charcoal-0`, `g-beige-90`, `g-black-0`(seed 둘 다), `g-olive-90`, `n-waves-90`, `n-white-90`, `r-streaks-90`, `r-white-90`.
  - 이 9개는 앱 글 그대로 다시 보내 확인할 것(호출 필요, 여쭤본 뒤).
- **시험:**
  - `tests/flux-prompt.test.ts`: 반광 말하기, 빈 방은 그대로. 짧은 문장 시험은 고정 5개 설비 대신 설비 2~7개로 순서를 본다.
  - `tests/export-photoreal.test.ts`: 옛 장면의 글에 `withSoftLight`를 거친 뒤 줄여서 앱 글과 같다.
- **다음:** AI에 보내는 3D 그림의 유광 반사 줄이기 시험(벽의 천장 조명 반사 점). 장면 다시 그리기, 약 16회·추정 1,760, UTC 날짜가 바뀐 뒤 여쭤보고 보낸다.

## 7. AI에 보내는 3D 그림의 유광 반사 줄이기 (AI 없음, 11-19)

- **까닭:** 유광 벽에 남는 천장 조명 반사 점은 3D 그림(캡처)에 있고, 줄눈 되돌리기가 렌더의 결을 다시 넣어 결과에도 남는다(5장).
- **방법:** `tests/fixture-haze/scenes.ts`에 `SCENES_SOFTEN`을 더했다. 캡처와 줄눈 넓힌 그림 두 뷰어에서 금속이 아닌 면의 거칠기를 정한 값까지 올리거나 환경 반사를 줄인다. 앱 코드는 그대로다.
  - `base`: 그대로. 앞서 AI에 보낸 장면과 픽셀까지 같다(5장면).
  - `r45`: 거칠기 0.45 미만(유광 0.24·폴리싱 0.12)을 0.45로(반광 값)
  - `r60`: 0.6으로
  - `env05`: 환경 반사 세기 절반
  - 그림: `test-results/fixture-glare-20261119/soft-scenes/<후보>/gloss/scenes/`, `sheet.png`, `spots.png`(뒷벽 위쪽 확대)
- **내가 본 것(유광 타일 장면 5개):**
  - `r45`: 올리브·베이지 벽의 조명 점이 없어진다. 검정 벽은 넓고 옅은 빛이 남는다. 타일 결·줄눈은 그대로다.
  - `r60`: 셋 다 점이 없다. 베이지 옆벽이 조금 밝아진다.
  - `env05`: 점은 그대로고 방 전체가 어두워진다. 뺀다.
  - 숫자: 줄눈과 흰 바탕이 섞여 넓은 범위의 밝기 분위수로는 차이가 잡히지 않았다. 그림으로 판단했다.
- **다음(AI 호출 필요, 여쭤본 뒤):** `r45`·`r60` 캡처로 지금 앱 문장(diffsemi)을 보내 결과의 벽 비침과 타일 모양을 본다.
- **배경 층:** `behind.ts`도 `BEHIND_OUT`·`SCENES_SOFTEN`으로 같은 거칠기로 그린다(`soft-scenes/<후보>/behind/`). `base`는 앞의 층과 픽셀까지 같다.

## 8. 4차 호출 (사용자 승인 11-19: "Check 9 first", "0.45 and 0.6 both")

- `run-glare4.ts`, UTC 11-20이 된 뒤 보낸다. 25회, 추정 약 2,739(승인 29회·3,190 안).
  - `final` 9회: 앱 글이 시험 때 보낸 글과 다른 9개 장면을 앱 글 그대로
  - `r45`·`r60` 각 8회: 3차의 유광 타일 장면 8개(5장면, 비교할 seed가 있는 것만)
- 기록은 `round4/ledger.jsonl`에 따로 둔다(따로 승인받은 회차라 시험 합계를 새로 센다). 앞 회차 기록은 그날 계정 사용량에 그대로 들어간다(하루 9,000).
- 그림: `variant-pictures.ts --variants final,r45,r60`. `r45`·`r60`은 부드럽게 그린 장면과 배경 층으로 다듬는다(`sources.ts` `glare-r45`·`glare-r60`).

## 9. 이어서 할 일 (11-19 밤 정리, PC 끔)

- **상태:** 브랜치 `claude/fixture-glare`(워크트리 `C:\dev\SJN-wall-drawing`), 로컬 커밋까지. main(`aee02c7`)에는 아직 안 올렸다. 4차 호출은 **보내지 않았다**(기다리던 작업을 멈춤, `round4/` 기록 없음).
- **1. 4차 호출 보내기**(사용자 승인 있음, UTC 11-20 이후):
  - 먼저 `--dry`로 25회·추정 약 2,739인지, 그날 계정 사용량을 본다.
  - `node tests/run-browser-test.mjs tests/fixture-glare/run-glare4.ts`
  - 429면 멈추고 다시 보내지 않는다. 내용 필터 거절은 건너뛴다.
- **2. 그림:** `node tests/run-browser-test.mjs tests/fixture-glare/variant-pictures.ts --variants final,r45,r60`
- **3. 내 평가:**
  - `final` 9개는 다른 물건으로 바뀌거나 나빠진 것이 없는지 본다. 비교 대상은 `diffsemi`와 지금 main 앱(`app`).
  - `r45`·`r60`은 벽 조명 점·타일 모양을 본다. 비교 대상은 같은 장면의 `final`(있으면) 또는 `diffsemi`.
- **4. 사용자 블라인드 세트:** 새 세트 이름(`g4` 등)으로 만든다. 이미 평가한 세트는 한 번 눌러도 완료되기 때문이다.
  - 만들기: `review-build.mjs --set g4 --keep … --base …`
  - 보기: `node tests/ledge-ai/review/server.mjs --root fixture-glare-20261119 --set g4 --port 8794`
  - 질문: 유광 자재 빛 비침 위주
- **5. main에 올리기:** `final` 확인이 괜찮으면 사용자에게 여쭤본 뒤 올린다(자동 배포).
  - `r45`·`r60`이 나으면, 앱의 AI 캡처(`editor.tsx` `captureAiInput`, 배경 층 포함)에 같은 거칠기를 넣는 것을 따로 제안한다.
