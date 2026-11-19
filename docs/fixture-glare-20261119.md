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
