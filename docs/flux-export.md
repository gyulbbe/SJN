# FLUX 현장 사진 변환

편집기 → 내보내기 → AI로 현장 사진처럼에서 `flux-2-klein-4b`로 현재 After를 현장 사진처럼 변환한다. 결과와 기준 원본을 나란히 확인하고 PNG로 다운로드할 수 있다. 실제 촬영본이 아니라 AI 시각화이며 구조·자재가 완전히 보존된다는 보장은 없다.

## 연결

- 기존 Wrangler `AI` 바인딩을 쓰되 AI Gateway(`sjn-gateway`)는 거치지 않는다. FLUX는 참조 이미지를 multipart 스트림으로 받는데, 게이트웨이는 스트림 본문을 받지 않는다(`AI Gateway does not support ReadableStreams yet.`). 게이트웨이를 거치던 이전 코드는 운영에서 모든 변환이 "Cloudflare AI 요청을 완료하지 못했어요"로 실패했다. Gemma 설비 분석은 JSON 요청이라 지금처럼 게이트웨이를 쓴다. 추가 토큰 설정은 없다.
- POST `/api/export/photoreal`: 서버는 `@cf/black-forest-labs/flux-2-klein-4b`만 호출한다. 요청 필드는 `image`와 `seed`뿐이며 모델 선택 필드(`model`)를 보내면 추론 전에 400으로 거부한다.
- 기존 Gemma의 동일 출처 검사와 D1 로그인 / 명시적 로컬 저장 모드 접근 정책을 재사용한다.
- 일반 Next 개발 서버에는 Workers AI 바인딩이 없으므로 연결 필요 오류를 표시한다. 실제 사용은 Workers 개발 서버 또는 Cloudflare 배포에서 한다.
- 각 클릭은 한 번만 요청한다. 자동 재시도나 창을 열 때 사전 AI 호출은 없다. 바인딩 직접 호출은 스스로 재시도하지 않는다.
- 실패하면 응답 JSON의 `diagnostics`에 모델·단계(`provider-request`/`provider-response`)·상류 상태·요청 ID와 제공자 오류(자격 증명·이미지 데이터 제거, 길이 제한)를 남긴다. 화면에는 지금처럼 요약 문구만 보인다.
- 다시 만들기 버튼을 누르면 새로운 AI 요청이 발생한다. 요청당 사용량은 기존 Gemma 등과 같은 계정 한도를 사용한다. 유료 플랜에서는 과금될 수 있다. 코드 자체가 요금제나 잔여 할당량을 검증하는 것은 아니다.

## 입력과 seed

첫 클릭 시 현재 시안의 After를 PNG로 렌더링해 고정한다. Before/After 합성 다운로드 옵션과 파일 형식은 AI 변환에 영향을 주지 않는다. 기준 PNG와 서버 고정 지시문은 창을 닫을 때까지 같고, seed는 클릭마다 새로 만든다. 그래서 다시 만들기를 누르면 같은 원본에서 다른 결과가 나온다.

Cloudflare klein 편집 가이드의 512px 미만 참조 이미지 조건에 맞춰 입력은 긴 변 최대 496px, 16px 단위로 준비한다. 비율은 유지하고 필요한 부분은 흰 여백을 붙인다. 출력은 입력 크기의 두 배(최대 992px)를 요청한다. 원본 다운로드는 기존 최대 4096px 설정을 유지한다. 응답이 JPEG/WebP여도 브라우저에서 실제 PNG로 인코딩하여 저장한다.

결과는 이 내보내기 창에서만 보관한다. 창을 닫거나 프로젝트·시안·계정을 바꾸면 요청 대기를 중단하고 결과 URL을 정리한다. 이미 시작된 원격 처리는 중단을 보장하지 않으며 사용량이 발생할 수 있다. 다시 만들기가 실패해도 직전 성공 결과는 지우지 않는다.

## 검증

- `npx vitest run tests/flux-export.test.ts tests/reconstruction-cloud-gemma.test.ts`
- `npx playwright test e2e/flux-export.spec.ts`
- E2E의 모델 응답은 모의 이미지다. 서버 접근 거부, 요청 필드(`image`·`seed`), 다시 만들기의 동일 원본·새 seed, PNG 다운로드, 한도 오류 후 결과 보존, 창 닫기와 늦은 응답을 검증한다.
- 실제 원격 모델 호출 및 화질 비교는 자동 검증에 포함하지 않는다.
- 2026-09-24 사용자 승인으로 실제 호출 2회(4B, 496×336 합성 이미지, 로컬 임시 Worker에서 운영 `AI` 바인딩)로 원인을 확인했다. 게이트웨이 포함 요청은 위 스트림 오류로 즉시 실패했고, 게이트웨이 없이 같은 요청은 200과 992×672 JPEG(base64 JSON)를 반환했다.

## 공식 API 근거

- https://developers.cloudflare.com/changelog/post/2026-01-15-flux-2-klein-4b-workers-ai/
- https://developers.cloudflare.com/ai-gateway/usage/providers/workersai/

Workers AI binding의 `multipart: { body, contentType }`에 `input_image_0`, prompt, width, height, seed를 전달한다. `gateway` 옵션은 지정하지 않는다.
