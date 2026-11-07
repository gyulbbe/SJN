# AI 방향 사진: 고칠 점과 세면대 두 문장 (2026-11-07)

사용자 요청(11-07):

1. 그 부분만 다시 만들기: 이미 있는 "{방향} 다시 만들기"로 충분하다고 답함. 새로 만들지 않았다.
2. 고칠 점을 직접 쓰게 하고, 이전 사진과 같이 보내 그 사진에 대한 피드백이라고 알린다.
3. 아직 앱에 넣지 않은 것(세면대의 찍은 각도 문장과 도면 옆면·뒷면 문장)과 고칠 점 빠른 선택 문장을 쓴다.

## 1. 앱에 넣은 것

- **고칠 점**([화면](../src/components/materials/direction-photo-generator.tsx), [서버](../src/lib/direction-photo/server.ts), [문장](../src/lib/direction-photo/prompt.ts) `feedbackSentence`):
  - 후보를 고르면 그 아래에 접힌 "고른 후보 고치기"가 생긴다. 빠른 선택 5개와 직접 쓰기(한 줄 200자)가 있다.
  - "{방향} 고쳐서 다시 만들기"는 고른 후보를 가이드 크기로 줄여 참고 사진 앞 2장과 함께 2번 보낸다(klein 4B 입력 4장 한도). 고친 후보 2장은 원래 후보 뒤에 붙는다.
  - 모델 입력은 image 0 가이드, 1~n 참고 사진, n+1 이전 후보다. 문장 끝에 고칠 점 문단을 붙인다.
  - 직접 쓴 글은 이 라우트가 받는 유일한 자유 글이다. 공백을 정리하고 `"`를 `'`로 바꿔 따옴표 안에 넣는다. 저장·기록하지 않는다(진단에는 빠른 선택과 글자 수만).

  | 버튼 | 코드 | 서버 문장(image k = 이전 후보) |
  | --- | --- | --- |
  | 똑바로 본 모습 | `straight` | Image k is turned toward the camera or seen at a slant; make the view exactly that of image 0, straight on, with no perspective and no turn. |
  | 사진 색 그대로 | `colour` | The colour or material in image k is not the real product's; take the colour, material and finish from the product photos. |
  | 벽·그림자 없이 | `background` | Image k shows a wall, a floor or a shadow; draw the product alone on pure white, with no wall, no floor and no cast shadow. |
  | 없는 물건 빼기 | `extras` | Image k has parts the real product does not have; leave out everything that is not on the real product in the photos. |
  | 가이드 모양 그대로 | `shape` | The shape or proportions in image k differ from image 0; keep the outline, proportions and size exactly as in image 0. |

  - 문단 앞뒤: "Image k is an earlier attempt at this photo that the person wants changed." … "The person's request about image k, in their own words: "…"." … "Make the new photo from image 0 and the product photos as said above, keep what image k already got right and change only what is asked."
- **세면대 두 문장**(별도 커밋, 사용자 결정 대기: 4절):
  - 세면대도 참고 사진마다 찍은 각도를 묻고 보낸다(`photoAngleTold`). 서버는 없어도 받는다(그 전에 연 화면).
  - 세면대 왼쪽·오른쪽 끝에는 변기와 같은 도면 옆면 문장, 받침대형 세면대 뒤에는 도면 뒷면 문장을 붙인다(`BACK_ELEVATION`).
  - 욕조와 투피스 변기는 그대로다.

## 2. 고칠 점 방식 고르기: 무료 FLUX (13:45~14:05 KST, 25장, 비용 0)

- 이전 답: 11-07 위생도기 시험의 Cloudflare 실패 답 5개(B1 왼쪽 사선, B6 왼쪽 회색, B15 왼쪽 벽 그림자, U2 왼쪽, B12 왼쪽 선 그림). 가이드와 참고 사진은 그 시험의 준비물이다(`tests/direction-photo-feedback/`).
- 방식 A: 가이드가 image 0, 이전 답이 마지막. 방식 B: 이전 답이 image 0("이 사진을 고쳐라"), 가이드가 마지막.
- 글: 빠른 선택(영어 문장) / 한국어 직접 쓰기. 5 × 2 × 2 = 20장, seed 1001, 블라인드 채점(`review/local`).
- 미리 정한 기준: 5곳 중 "따랐고 나머지(방향·종류)도 지킴"이 많은 방식을 쓴다(같으면 A). 한국어 글이 5곳 중 3곳 이상 따르면 그대로 보낸다.

| 방식 | 글 | 따름 | 나머지 지킴 | 둘 다 | 이전보다 나음/같음/못함 |
| --- | --- | --- | --- | --- | --- |
| A | 빠른 선택 | 3/5 | 5/5 | 3/5 | 4/0/1 |
| A | 한국어 글 | 3/5 | 5/5 | 3/5 | 4/0/1 |
| B | 빠른 선택 | 3/5 | 1/5 | 1/5 | 2/3/0 |
| B | 한국어 글 | 3/5 | 1/5 | 1/5 | 2/3/0 |

- 판단: A(6/10 대 2/10). 한국어 글은 빠른 선택과 같게 따라(3/5) 그대로 보낸다(번역 없음).
- 무료 FLUX는 모두 회색으로 그려 B6(색)은 채점할 수 없었다. U2는 고른 이전 답(G2)에 "큰 상자"가 없어(상자는 G 답에 있었음) 판단에서 뺐다.
- **대조군:** A에 아무것도 쓰지 않은 5장(`review/local-control`)도 A 결과와 거의 같았다. 무료 FLUX에서는 나아진 것이 글 때문이 아니라 가이드와 다시 만든 데서 왔다. 그래서 Cloudflare에서도 대조군을 함께 돌렸다.
- 그림: `test-results/direction-photo-feedback-20261107/고칠점-local.png`

## 3. 고칠 점 Cloudflare 확인 (사용자의 두 번째 계정, 1장씩)

| 곳 | 문제 | 보낸 글 | 글을 넣은 답 | 대조군(아무것도 안 씀) |
| --- | --- | --- | --- | --- |
| B6 왼쪽 | 회색 | 한국어 "사진처럼 흰색으로 해 주세요" | **흰색으로 바뀜**(각도는 그대로 사선) | 회색 그대로 |
| B15 왼쪽 | 벽 그림자 | 빠른 선택 벽·그림자 없이 | 벽 없음, 평평한 옆 | 벽 없음, 평평한 옆 |
| B1 왼쪽 | 사선으로 돎 | 빠른 선택 똑바로 본 모습 | 이전 답처럼 사선 | 이전 답처럼 사선 |
| B12 왼쪽 | 선 그림 | 한국어 "가이드 모양대로 실제 사진처럼 그려 주세요" | 얇은 판 그대로 | 선 그림 그대로 |

- Cloudflare는 이전 답을 많이 따라 그린다(각도, 구멍, 색까지). 글이 색처럼 겉모습을 바꾸라고 하면 따르고, 한국어도 알아듣는다. 하지만 각도와 모양은 이전 답을 따라가서 고치지 못했다(각 1곳).
- 그래서 방향·모양이 틀린 후보는 "고치기"보다 "{방향} 다시 만들기"가 맞다. "똑바로 본 모습"·"가이드 모양 그대로" 버튼을 둘지는 사용자에게 묻는다.
- 그림: `고칠점-cf.png`. 표는 `review/cf/table.md`.

## 4. 세면대 두 문장: 앱 가이드로 비교

- **무료 짝 비교(비용 0):** 11-07에 앱 가이드와 지금 앱 문장으로 만든 무료 답(C0, seed 1001, 세면대 26분류의 정면·옆·뒤 62곳)과, 바꾼 앱 문장(C0G2, 찍은 각도는 시험의 `PHOTO_FROM`)을 같은 seed로 만들어 블라인드로 비교했다(`위생도기-방향사진-20261107/review/local-c0g2`).

  | 62곳 | 지금 앱 문장 | 두 문장 더함 |
  | --- | --- | --- |
  | 방향 맞음 | 35 | 56 |
  | 방향 틀림 | 23 | 4 |
  | 벽이 같이 그려짐 | 37 | 5 |
  | 방향·종류 모두 맞음 | 6 | 9 |

  - 방향이 달라진 21곳은 모두 새 문장 쪽이 맞았다. 그림은 `앱세면대-무료-달라진곳.png`.
  - **미리 정한 기준("방향·종류 맞음"이 5곳 이상 늘어야 넣음)에는 못 미쳤다(+3).** 앱 가이드가 수전이 달린 표준 모형이라, 종류는 두 문장 모두에서 대부분 사진과 달랐다. 기준을 바꾸지 않고 넣을지 사용자에게 묻는다. 세면대 부분은 별도 커밋이라 그 커밋만 되돌리면 빠진다.
- **Cloudflare(두 번째 계정, 3곳 짝):** B1·B15·B21 왼쪽에서 지금 문장과 새 문장이 같았다(맞음 2, 살짝 돎 1씩). 새 문장의 B15는 베이지색으로 나왔다.

## 5. 비용

- 무료 FLUX: 고칠 점 25장, 세면대 62장.
- Cloudflare: 14회, 추정 1,548(고칠 점 8, 세면대 6), 사용자의 두 번째 계정(`CF_ACCOUNT=second`)이다. 그 계정의 그날 추정 사용량은 3,136 → 4,684(하루 몫 5,000)였다. 실제 사용량 화면은 보지 않았다.

## 6. D1과 화면 호출

- 이 라우트가 D1에서 하는 일은 요청마다 로그인 확인 한 번(`getD1Actor`)뿐이다. 새 SQL은 없고, 고치기도 한 번에 일반 만들기처럼 후보마다 요청 1번이다.
- e2e(`e2e/direction-photo-ai.spec.ts`)가 "고쳐서 다시 만들기" 한 번에 `/api/materials/direction-photo` POST가 정확히 2번인지 확인한다. 그 사이 다른 `/api/` 요청은 화면의 30초 권한 확인이 겹칠 때의 1번까지만 허용한다.

| 경로 | 쿼리 수/회 | rows_read/회 | rows_written/회 | 예상 호출/일 |
| --- | --- | --- | --- | --- |
| `POST /api/materials/direction-photo`(고치기 포함) | 로그인 확인만(바뀌지 않음) | 세션 확인만(바뀌지 않음) | 0 | AI 하루 몫에 묶임(추정 10,000뉴런 ÷ 약 120 = 80회 안팎) |

## 7. 다시 돌리기

```bash
node tests/run-browser-test.mjs tests/direction-photo-feedback/run.ts local
```

```bash
node tests/direction-photo-feedback/review.mjs sheets local
```

```bash
bash tests/direction-photo-feedback/cf-check.sh
```

- 무료 FLUX 서버(`tests/direction-photo-real/local-flux/server.py`, :8798)를 먼저 띄운다. GPU 메모리 약 8.4GB가 필요하다(게임이 GPU를 쓰면 멈춘다).
- 채점은 `ratings-claude.txt`를 쓴 뒤 `table`(키를 연다)과 `picture`로 한다. `ARMS=A:fix,A:ko,A:none`·`NAME`으로 보일 묶음과 폴더를 고른다.
- 세면대 짝 비교: `run.ts local <B1…B26> C0G2 rep 1001`, `METHODS=C0,C0G2 NAME=local-c0g2 review.mjs sheets local rep`, `versus`, `changes`.

## 8. 한계

- 고칠 점의 Cloudflare 확인은 4곳, 1장씩이다. 겉모습(색)은 고쳤고 각도·모양은 고치지 못했다는 정도만 말할 수 있다.
- 세면대 두 문장의 Cloudflare 확인은 3곳뿐이다. 무료 FLUX의 큰 차이가 Cloudflare에서도 나는지는 더 봐야 한다.
- 직접 쓴 글은 그대로 모델에 간다. 로그인한 사용자만 쓸 수 있고 200자로 막지만, 내용은 걸러내지 않는다.
