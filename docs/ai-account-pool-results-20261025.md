# Cloudflare AI 추가 계정 결과 · 2026-10-25

Workers AI 무료 할당은 계정마다 하루 10,000뉴런이고 UTC 00:00(한국 09:00)에 초기화된다. 내 계정 것만으로는 부족해서, 다른 계정 하나를 **추가 계정**으로 등록해 먼저 쓰고, 그 계정이 하루 할당을 다 쓰면 내 계정(`AI` 바인딩)을 쓴다.

## 1. 사용자 결정
| 질문 | 결정 |
| --- | --- |
| 비밀값 이름 | `AI_EXTRA_1_ACCOUNT_ID`, `AI_EXTRA_1_TOKEN`(운영 Runtime secrets에 사용자가 넣음) |
| 계정 수 | 1개만(`AI_EXTRA_1_*`) |
| Gemma 게이트웨이 | 선택값 `AI_EXTRA_1_GATEWAY`가 없으면 게이트웨이 없이 바로 부른다 |
| 사용량 | 처리한 계정을 응답 진단에 번호로만 남긴다(`extra-1` / `own`). 서버 기록·추가 분석 토큰 없음 |

## 2. 설계 (`src/lib/ai-pool/pool.ts`)
- **한 곳을 거친다.** FLUX의 `openFluxRequest`(AI 변환·제품 다듬기·방향 사진)와 Gemma의 `binding()`(결과 확인·사진 분석)이 바인딩 대신 `pooledBinding`을 돌려준다. 바인딩과 같은 `run(model, input, options)` 모양이라 응답을 읽는 코드는 그대로다.
- **순서:** 추가 계정 → 내 계정 바인딩.
  - 바인딩이 없는 실행 환경(일반 Next 개발 서버)에서는 추가 계정만 쓴다. 둘 다 없으면 지금처럼 503 `binding_unavailable`이다.
- **추가 계정 호출:** REST `POST https://api.cloudflare.com/client/v4/accounts/<계정ID>/ai/run/<모델>`, `Authorization: Bearer <토큰>`.
  - Gemma(JSON): 본문은 바인딩에 주던 입력의 JSON이다. 내 계정은 지금처럼 `sjn-gateway`를 쓴다. 추가 계정은 `AI_EXTRA_1_GATEWAY`가 있을 때만 `cf-aig-gateway-id` 헤더로 그 계정의 게이트웨이를 거친다.
  - FLUX(multipart): 본문은 바인딩에 주던 multipart 바이트와 content-type 그대로다.
- **넘어가는 조건**
  - 하루 할당 소진(3036 등 `classifyCloudGemmaFailure`의 `quota_exhausted`): 그 계정을 기억하고 다음 계정으로.
  - 401·403(토큰 회수·권한 부족): 건너뛰고 다음 계정으로. 진단에는 `extra-1:auth`만 남는다.
  - 그 밖(5xx, 3040 혼잡, 시간 초과, 잘못된 입력, 네트워크·취소 예외): 넘어가지 않고 그 답이 요청의 답이다. 자동 재시도 없음 원칙 그대로다.
- **소진 기억:** 소진된 계정은 다음 UTC 00:00까지 이 Worker 인스턴스의 메모리에만 기억하고 그 전에는 요청 없이 건너뛴다. D1·KV에는 쓰지 않는다. 새 인스턴스는 한 번 429를 받고 다시 기억한다(429는 뉴런을 쓰지 않는다).
- **본문 다시 만들기:** multipart 스트림은 한 번 읽으면 끝나므로, 추가 계정이 있을 때는 먼저 바이트로 읽고 시도마다 같은 바이트로 새 본문을 만든다. 추가 계정이 없으면 스트림을 그대로 바인딩에 넘긴다(예전과 같은 호출 1회).
- **시간 제한·취소:** 호출하는 쪽의 신호(FLUX 180초 + 요청 취소, Gemma 마감)를 모든 시도에 넘긴다. 그래서 시도를 합쳐 지켜진다.
- **응답과 화면**
  - 처리한 계정: 실패 진단 `aiAccount`·`aiSkipped`, 사진 분석은 성공 진단에도, FLUX·결과 확인 성공은 응답 헤더 `X-SJN-AI-Account`. 모두 번호(`extra-1` / `own`)뿐이다.
  - 추가 계정 하나가 소진된 것만으로는 화면에 아무것도 보이지 않는다(내 계정이 답한다). **모든 계정이 소진됐을 때만** 지금의 429 `quota_exhausted`와 `limit`이 가고, 그때만 화면 띠와 버튼 옆 안내가 보인다.
- **비밀값:** 계정 ID와 토큰은 `pool.ts` 밖으로 나가지 않는다. 응답·진단·오류 문구·클라이언트 코드에 없다(시험이 응답 문자열을 검사). 계정 ID가 32자리 16진수가 아니거나 토큰이 비면 그 계정은 없는 것으로 본다. **설정이 없으면 지금과 똑같이 동작한다.**

## 3. 공식 문서 (2026-10-25 확인)
- REST 주소와 인증: https://developers.cloudflare.com/workers-ai/get-started/rest-api/ (`/accounts/{account_id}/ai/run/{model}`, `Authorization: Bearer`, 토큰 권한 Workers AI Read·Edit)
- 오류 코드: https://developers.cloudflare.com/workers-ai/platform/errors/ — 3036 "Account limited"(429, 하루 무료 할당 소진), 3040 "Out of capacity"(429, 일시 혼잡이라 넘어가지 않음)
- 게이트웨이: https://developers.cloudflare.com/ai-gateway/usage/rest-api/ — Workers AI REST 요청에 `cf-aig-gateway-id` 헤더로 게이트웨이를 지정한다.
- FLUX.2 klein 4B: https://developers.cloudflare.com/workers-ai/models/flux-2-klein-4b/ — 입력은 `multipart` 하나다. REST의 multipart 필드 이름은 문서에 펼쳐져 있지 않아, 바인딩에 주던 것과 같은 multipart 본문을 그대로 보낸다. 실제 호출 확인은 6절.

## 4. 시험 (`tests/ai-pool.test.ts`, 실제 AI 호출 없음)
- 설정 읽기(형식 오류·빈 토큰은 없음), 설정 없음 → 바인딩 1회·`fetch` 0회(같은 인자)
- 추가 계정 먼저(REST 주소·토큰 헤더·JSON 본문), 3036·401·403에서만 넘어감, 500·3040·400은 그대로
- 소진 기억과 다음 UTC 00:00 해제, multipart 본문이 두 계정 모두 같은 바이트
- 게이트웨이 헤더는 추가 계정 게이트웨이가 있을 때만, 바인딩 없음 + 추가 계정, 취소 시 다음 계정 없음, Gemma `binding()` 경유
- 방향 사진 라우트 전체: 추가 계정 소진 → 내 계정 200(한도 없음), 추가 계정 200, 모두 소진 → 429 `quota_exhausted`+`limit`, 응답에 토큰·계정 ID 없음
- 기존 라우트 시험(`flux-export`, `flux-product-server`, `direction-photo-server`, `flux-check`, `reconstruction-cloud-gemma`, `service-limit*`) 189개는 바꾸지 않고 통과
- 화면 띠는 응답이 지금과 같은 429일 때만 뜬다(`service-limit-notice`). 추가 계정 소진이 화면에 닿지 않는 것은 위 라우트 시험이 보인다.

## 5. 한계
- 인스턴스마다 처음 한 번은 소진된 추가 계정에 요청해 429를 받는다(뉴런 0).
- 계정별 사용량을 한 화면에서 보지 못한다. `/admin/ai-usage`는 내 계정만 보인다. 추가 계정 사용량은 그 계정 대시보드에서 본다.
- 추가 계정은 1개만 읽는다.
- 추가 계정 토큰이 회수돼도 관리자에게 따로 알리지 않는다(진단의 `extra-1:auth`로만 보인다). 관리자 화면 안내는 필요하면 따로 만든다.

## 6. 실제 확인
- 사용자가 로컬 `.dev.vars`에 같은 이름의 값을 넣은 뒤, 승인을 받고 방향 사진 1회(FLUX)와 결과 확인 1회(Gemma)를 부른다. 성공 응답의 `X-SJN-AI-Account: extra-1`과 그 계정 대시보드의 사용량을 확인한다.
- 결과: (실행 뒤 적는다)
