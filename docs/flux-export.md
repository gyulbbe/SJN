# FLUX 현장 사진 변환 비교

편집기 → 내보내기 → AI로 현장 사진처럼에서 `flux-2-klein-4b`, `flux-2-klein-9b`를 각각 실행한다. 두 결과와 기준 원본을 나란히 확인하고 PNG로 다운로드할 수 있다. 실제 촬영본이 아니라 AI 시각화이며 구조·자재가 완전히 보존된다는 보장은 없다.

## 연결

- 기존 Wrangler `AI` 바인딩과 `sjn-gateway`를 재사용한다. 추가 게이트웨이나 토큰 설정은 없다.
- POST `/api/export/photoreal`: 서버가 허용된 두 모델만 호출한다.
- 기존 Gemma의 동일 출처 검사와 D1 로그인 / 명시적 로컬 저장 모드 접근 정책을 재사용한다.
- 일반 Next 개발 서버에는 Workers AI 바인딩이 없으므로 연결 필요 오류를 표시한다. 실제 사용은 Workers 개발 서버 또는 Cloudflare 배포에서 한다.
- 각 클릭은 한 모델에 한 번만 요청한다. 자동 재시도, 다른 모델로 자동 전환, 창을 열 때 사전 AI 호출은 없다. Gateway의 재시도도 한 번으로 제한한다.
- 재생성 버튼을 다시 누르면 새로운 AI 요청이 발생한다. 요청당 사용량은 기존 Gemma 등과 같은 계정 한도를 사용한다. 유료 플랜에서는 과금될 수 있으며, 9B의 사용량은 4B보다 크다. 코드 자체가 요금제나 잔여 할당량을 검증하는 것은 아니다.

## 동일 입력 비교

첫 클릭 시 현재 시안의 After를 PNG로 렌더링해 고정한다. Before/After 합성 다운로드 옵션과 파일 형식은 AI 비교에 영향을 주지 않는다. 동일한 기준 PNG, 서버 고정 지시문, seed를 두 모델에 전달한다. 서로 다른 모델이므로 같은 seed가 같은 생성 과정을 보장하는 것은 아니다.

Cloudflare klein 편집 가이드의 512px 미만 참조 이미지 조건에 맞춰 입력은 긴 변 최대 496px, 16px 단위로 준비한다. 비율은 유지하고 필요한 부분은 흰 여백을 붙인다. 출력은 입력 크기의 두 배(최대 992px)를 요청한다. 원본 다운로드는 기존 최대 4096px 설정을 유지한다. 응답이 JPEG/WebP여도 브라우저에서 실제 PNG로 인코딩하여 저장한다.

결과는 이 내보내기 창에서만 보관한다. 창을 닫거나 프로젝트·시안·계정을 바꾸면 요청 대기를 중단하고 결과 URL을 정리한다. 이미 시작된 원격 처리는 중단을 보장하지 않으며 사용량이 발생할 수 있다. 한 모델의 실패는 다른 모델의 성공 결과를 지우지 않는다.

## 검증

- `npx vitest run tests/flux-export.test.ts tests/reconstruction-cloud-gemma.test.ts`
- `npx playwright test e2e/flux-export.spec.ts`
- E2E의 모델 응답은 모의 이미지다. 서버 접근 거부, 동일 원본·seed, 개별 모델 호출, PNG 다운로드, 한도 오류 후 결과 보존, 창 닫기와 늦은 응답을 검증한다.
- 실제 원격 모델 호출 및 화질 비교는 이번 자동 검증에 포함하지 않는다.

## 공식 API 근거

- https://developers.cloudflare.com/changelog/post/2026-01-15-flux-2-klein-4b-workers-ai/
- https://developers.cloudflare.com/workers-ai/models/flux-2-klein-9b/
- https://developers.cloudflare.com/ai-gateway/usage/providers/workersai/

Workers AI binding의 `multipart: { body, contentType }`에 `input_image_0`, prompt, width, height, seed를 전달하고 `gateway.id`를 지정한다.
