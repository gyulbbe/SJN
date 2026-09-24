# 사진 분석의 Cloudflare 무료 사용량 확인

현재 서비스 구조는 설비 분석만 Cloudflare Workers AI의 Gemma를 사용하고, DeepLab과 MoGe 형상 분석은 사용자 브라우저에서 실행한다. 사진 1장 분석은 AI 호출 1회가 아니다. 설비 목록·형태·설치·거울·샤워·배치 확인이 별도 호출될 수 있으며, 유효한 단계 캐시는 새 추론 없이 재사용한다.

## 무료 한도와 확인 기준

- Workers AI 무료 할당은 **계정 전체 하루 10,000 Neurons**, 초기화는 **UTC 00:00 / 한국 오전 9시**다.
- 고정된 '하루 몇 회' 한도가 아니다. 입력 사진·프롬프트와 출력 토큰이 늘면 한 번의 호출에 쓰는 양도 늘어난다.
- Workers Free에서는 무료량 소진 후 요청이 실패한다. 코드에서 `quota_exhausted`를 일시적인 혼잡과 구분하며 자동 재시도하지 않는다. 요금제 변경·유료 모델 대체는 수행하지 않는다.
- 다른 Worker나 다른 AI 기능도 같은 계정의 무료량을 사용할 수 있다. 한 사진 테스트 로그만으로 계정 전체 잔여량을 계산하지 않는다.

공식 근거: [Workers AI 가격표](https://developers.cloudflare.com/workers-ai/platform/pricing/), [오류 코드](https://developers.cloudflare.com/workers-ai/platform/errors/).

## 관리자 화면에서 확인

관리자 메뉴 **AI 사용량**(`/admin/ai-usage`)은 아래 값을 보여 준다.
- 오늘(UTC) 계정 전체의 뉴런·호출 수, 무료 10,000 뉴런 대비 남은 양과 사용 비율, 한국 시간 09:00 초기화까지 남은 시간
- 모델별 사용(Gemma, FLUX 4B 등)과 최근 7일의 날짜별 뉴런
- 무료량을 넘으면 Workers Paid 기준 추정 과금(1,000 뉴런당 $0.011)을 표시하고, Workers Free라면 요청이 실패한다고 안내한다

동작 방식:
- 서버가 Cloudflare GraphQL Analytics(`aiInferenceAdaptiveGroups`, `sum.totalNeurons`, `dimensions.modelId`·`datetimeHour`)를 읽기만 하고, AI를 호출하거나 요금제를 바꾸지 않는다.
- 새로고침할 때마다 GraphQL 요청이 2번 나간다. Cloudflare 제한은 5분에 300회다.
- 표본 집계라 실제 청구와 조금 다를 수 있고 몇 분 늦게 반영된다. 같은 계정의 다른 Worker 사용량도 포함한다.

### 설정

1. Cloudflare 대시보드 → My Profile → API Tokens → Create Custom Token으로 토큰을 만든다. 권한은 **Account · Account Analytics · Read** 하나, 계정 범위는 이 계정만 둔다. 토큰 값은 채팅·소스·브라우저에 넣지 않는다.
2. 운영에 등록: `npx wrangler secret put CLOUDFLARE_ANALYTICS_TOKEN`, `npx wrangler secret put CLOUDFLARE_ACCOUNT_ID`. 계정 ID는 대시보드 주소에 보이는 32자리 값이다. 로컬 Workers 개발에서는 `.dev.vars`에 같은 이름으로 넣는다.
3. 값이 없거나 형식이 틀리면 화면에 설정 안내가 나온다. 토큰 권한이 부족하면 권한 안내, 조회 한도를 넘으면 5분 뒤 다시 확인하라는 안내가 나온다.

2026-09-25 구현 시점에는 실제 토큰이 없어 모의 응답으로만 검증했다. `totalNeurons` 필드 이름과 7일 범위 허용 여부는 토큰 등록 뒤 첫 실제 조회에서 확인해야 한다(미확인). 7일 범위를 받지 못하면 오늘 값만 표시한다.

## 이번에 측정한 규모

2026-09-16 17:33 KST 기준 계정 Analytics 집계는 **442회, 8,047.727 Neurons(80.48%)**였다. 이는 당시의 기록이며 현재 남은 양을 보장하지 않는다. 초기 thinking/별도 관측 실험도 포함하므로 실제 사용자 사진 처리 횟수와 다르다.

정상 v9 전체 분석은 15장에 binding 호출100회, 입력151,287/출력18,393 토큰이었다. 공식 Gemma 계수(입력100만 토큰당9,091N, 출력100만 토큰당27,273N)를 적용한 참고치는 다음과 같다.

| 항목 | 당시 조건의 환산 |
| --- | ---: |
| 15장 전체 | 약1,877 Neurons |
| 사진당 평균 | 약125 Neurons / 6.7회 호출 |
| 무료10,000N으로 가능한 장수 | 평균 기준 약80장 |
| 당시 개별 사진의 비용 범위 | 약62~185 Neurons |

**약80장은 보장량이 아니다.** 재시도, 분석 단계 추가, 토큰 길이, 캐시에 따라 달라진다. 품질 개선 실험을 여러 번 하는 개발 비용과 최종 사용자가 같은 사진을 한 번 분석하는 비용도 구분한다.

## 로그에서 구분하는 값

1. 사진 수: 완료된 사진 수와 중간 실패한 사진 수.
2. HTTP 요청 수: 브라우저가 서버에 요청한 횟수. 캐시 확인이나 실패 요청도 포함될 수 있다.
3. binding 호출 수: SJN이 `AI.run`을 실제 부른 횟수. 반환 실패와 재시도도 구분한다.
4. 공급자 inference 집계: 계정 GraphQL Analytics의 count. adaptive sampling과 반영 지연이 있을 수 있다.
5. 사용량: 공식 계정 Neurons 집계와 응답별 관측값, 토큰 기반 계산값을 별도 표시한다. 값이 없으면 미측정이며 0으로 바꾸지 않는다.

## 개발 환경에서 다시 확인

기존 Wrangler 로그인으로 읽기 전용 조회 스크립트를 실행한다. API 토큰을 채팅·소스·브라우저에 넣지 않는다.

```powershell
node test-results/reconstruction-fifteen-rebuild/2026-09-16T02-41-56-428Z-cloud-gemma/cloudflare-daily-usage-01/read-current-usage.mjs
```

현재 UTC일을 조회하고 타임스탬프별 JSON을 별도로 보존한다. 인증이 만료됐으면 조회만 실패하며 AI를 호출하거나 요금제를 변경하지 않는다. 이 스크립트는 이번 테스트 PC의 기존 인증 위치를 쓰는 로컬 진단 도구다. 배포된 브라우저에서 실행하는 기능이 아니다.

실제15장 실행기는 `tests/reconstruction-cloud-integrated15.mjs`이며, quota/auth 오류에서 다음 사진을 시작하지 않는다. 완료된 원본·분석 JSON·PNG와 부분 단계는 실행 디렉터리에 남긴다. 일일 한도를 소진하면 사용자 지시에 따라 당일 추가 호출을 멈추고 미완료 항목을 보고한다.
