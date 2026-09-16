# 사진 분석: Cloudflare Gemma + 브라우저 MoGe

일반 사진 생성과 Before 재분석의 AI 정밀 분석은 DeepLab 분할, Cloudflare Gemma 설비 관측, 브라우저 MoGe 형상 계산, 기존 배치·검토 흐름을 사용한다. 대형 모델을 동시에 기동하지 않고 순차 처리한다. 일반 사용자는 Python·Ollama·CUDA 설치가 필요 없다. 기존 Qwen/Ollama와 Python·CUDA MoGe 실행 경로는 제거했다. 과거 결과를 읽는 데이터 계약만 유지한다.

## 서버 설정과 접근 정책

- Worker 이름: `sjn`, Workers AI 바인딩: `AI`, Gateway: `sjn-gateway`.
- 모델: `@cf/google/gemma-4-26b-a4b-it`.
- API: `/api/reconstruction/cloud`. 서버 `getRuntimeEnvironment()`로 바인딩을 읽는다. API 토큰을 브라우저에 보내지 않는다.
- `npm run build:vinext` 출력 `dist/server/wrangler.json`에 `ai.binding=AI`가 전달되는 것을 확인했다.
- 현재 소스는 `APP_ENV=local`, `STORAGE_MODE=auto`이며 D1 바인딩은 없다. Dashboard에만 있는 바인딩과 소스를 배포 시 일치시키는 작업은 기존 배포 가이드를 따른다. 이 개발 검증은 운영 배포가 아니다.

사용자 승인에 따라 의도적으로 로컬 저장을 선택한 공개 사이트에서도 같은 출처의 HTTPS 요청은 로그인 없이 AI를 사용할 수 있다. 서버의 저장 모드가 실제로 `local`이고 명시적으로 선택됐거나, `APP_ENV=local`에서 `STORAGE_MODE=local/auto`인 경우에 해당한다. 잘못된 설정으로 로컬 저장에 떨어진 경우를 익명 허용으로 취급하지 않는다. D1 저장 모드에서는 기존 D1 세션과 계정 검사를 유지하며, 인증 실패 후 익명으로 전환하지 않는다. 개발용 loopback HTTP는 기존 제한을 유지한다. 다른 출처의 요청과 POST의 Origin 누락은 거부한다. 이 API 정책은 사이트의 저장 모드·ASSETS·D1 바인딩·로그인 설정을 변경하지 않는다.

Next 개발 서버 `npm run dev`에는 Cloudflare AI 바인딩이 없다. MoGe 단독 검사는 가능하지만 Gemma는 준비되지 않았다고 표시한다. Cloudflare 연결 검증에는 인증된 Wrangler 환경이나 기존 Worker가 필요하다. Wrangler 로그인은 개발 도구의 계정 인증이며 방문자가 설치하거나 수행할 절차가 아니다.

2026-09-16 사용자가 Workers Free와 `sjn-gateway`의 Workers AI Billing = Standard billing을 확인했다. Workers AI를 사용하는 로컬 개발 요청도 사진을 보내는 실제 원격 호출이다. 이 확인은 정확한 실시간 잔여량을 보증하지 않는다. 한도·인증 오류가 나면 중단하고 완료된 단계를 보존한다. 요금제 변경이나 다른 유료 모델로의 대체는 없다. 새 전역 분당 제한은 넣지 않았다.

### 실제 AI를 연결하는 개발 실행

```powershell
npm run build:vinext
npm run start:vinext
```

`start:vinext`는 `wrangler dev --config dist/server/wrangler.json --port 8787 --persist-to .wrangler/state`를 실행한다. 로컬 workerd에서 앱을 실행하면서 AI 바인딩은 원격 Workers AI에 연결한다. **실제 AI 검사에 `--local`을 추가하지 않는다.** 이 플래그는 원격 바인딩을 끄므로 `Binding AI needs to be run remotely` 오류가 발생한다. 반대로 Worker 전체를 원격에서 실행하는 `--remote` 플래그도 필요 없다.

`GET /api/reconstruction/cloud`의 준비 상태는 바인딩·접근 정책 확인이며, 모델 추론 성공을 뜻하지 않는다. 실제 사진 POST의 응답 검증까지 확인해야 한다. Next와 vinext 빌드는 공유 `.next/types`를 갱신하므로 순차 실행한다.

## 브라우저 모델 URL과 캐시

- `Ruicheng/moge-2-vits-normal-onnx`, FP32, 140852051 bytes.
- revision: `e50ffda41565591092adea54c6ac83d6212e1e23`.
- SHA-256: `24eacb5dc7a2c54c7bc98f7de085ffbed79ad006ea5b664c2c2cdc02ff3a52f0`.
- 기본값은 위 고정 revision의 Hugging Face model.onnx URL이다. 실제 CORS 다운로드·SHA 검증 완료.
- 선택 설정 `NEXT_PUBLIC_MOGE_MODEL_URL`은 빌드 시 모델 제공 URL만 바꾼다. 동일 SHA만 허용하므로 다른 모델로 교체하는 설정은 아니다. R2를 쓰면 모델 전용 공개 경로를 사용하고 사용자 사진 버킷 전체를 공개하지 않는다.
- ONNX Runtime Web 1.29.0. WASM은 같은 버전 jsDelivr 경로를 사용한다. 141MB 모델은 public이나 Workers Static Assets에 포함하지 않는다.

실행 버튼을 처음 누를 때 모델을 다운로드하며 버전별 Cache Storage를 재사용한다. 무결성 오류·용량 부족·취소를 처리한다. GPU 실행 실패 시 검증한 바이트를 새 CPU Worker에 넘겨 중복 다운로드하지 않는다. 기본은 WebGPU 우선이며 테스트에서는 GPU/CPU 강제 선택도 가능하다. crossOriginIsolated와 SharedArrayBuffer 조건이 없으면 WASM 단일 스레드다. 일반 서비스의 헤더를 이번 작업에서 바꾸지 않았다.

Gemma 완료 단계 캐시는 브라우저에 최대64개를 보관하고 24시간 뒤 만료된다. 사진·입력·프롬프트·출력 계약·공급자·접근 범위를 구분한다. D1은 계정 해시, 공개 익명 모드는 사이트 origin 해시, 개발 loopback은 `local-dev` 범위를 사용한다. 익명 origin 범위는 사용자 인증이나 사용자별 할당량이 아니며, 다른 방문자의 브라우저 캐시를 서버에서 공유한다는 뜻도 아니다. 캐시가 만료되거나 제거되면 실제 호출이 다시 필요하므로 재사용을 가정하지 않고 결과의 캐시 표시를 확인한다.

MoGe 캐시에는 모델 SHA, 전후처리·평면 알고리즘, 해상도·토큰·정밀도·분할 마스크가 포함된다. 기존 Python 결과와 새 브라우저 결과는 별도다. Cloudflare가 제공하지 않는 가중치 해시는 만들지 않는다.

## 사용과 로그

홈의 사진으로 비교 공간 만들기에서 AI 정밀 분석을 선택한다. 기존 프로젝트의 Before 재분석에도 연결돼 있다. 사진으로 새로 시작할 때 Before와 동일 크기·공통 카메라를 쓰는 빈 After를 만든다. 재분석으로 기존 After를 덮어쓰지 않는다. 실패를 기본 분석 성공으로 바꿔 표시하지 않으며 기본 분석은 직접 선택할 수 있다.

`/reconstruction-lab`의 Gemma · 브라우저 MoGe 성능 테스트 링크를 통해 `/reconstruction-performance`에서 다음을 검사한다.

1. Gemma 설비 분석: `inventory-extended` 한 종류의 관측 JSON과 얻을 수 있는 토큰 사용량. API의 모든 관측 단계를 검사하는 버튼은 아니다.
2. MoGe 형상 + DeepLab: 깊이·법선·바닥/벽 관측 지지 영역과 단계별 시간.
3. 전체 분석 → Before 생성: 일반 생성 코드를 사용하되 프로젝트·자재 저장은 하지 않는 검사.

JSON 다운로드로 모델 ID·버전·캐시·시간·관측 근거를 보관한다. `cloudUsage`는 이번 실행에서 확인한 AI 바인딩 호출 수와 미확인 수, 캐시와 토큰을 구분한다. HTTP 요청 수를 모델 완료 횟수나 청구 횟수로 해석하지 않는다. 브라우저 실행 메모리는 측정 불가로 표시하며 파일 크기로 대신하지 않는다.

설비 분석용 사진은 Cloudflare로 전송된다. MoGe와 DeepLab 계산은 사용자 기기에서 수행한다. 모델 다운로드 서버로 사진을 전송하지 않는다.

### 15장 검증 하네스

`tests/reconstruction-cloud-integrated15.mjs`는 실제 성능페이지를 조작한다. 기본 실행은 원본·소스 해시와 시험 입력을 검증해 새 결과폴더에 기록하는 dry run이며 브라우저·서버·AI를 실행하지 않는다. 실제 실행은 별도로 켜 둔 Wrangler 서버와 `--execute`가 필요하다.

```powershell
node tests/reconstruction-cloud-integrated15.mjs --help
node tests/reconstruction-cloud-integrated15.mjs --output test-results/cloud-check-dry
node tests/reconstruction-cloud-integrated15.mjs --execute --kind gemma --cases pc-03 --output test-results/cloud-check-gemma --profile test-results/cloud-check-profile
node tests/reconstruction-cloud-integrated15.mjs --execute --kind full --cases pc-03 --output test-results/cloud-check-full-one --profile test-results/cloud-check-profile
node tests/reconstruction-cloud-integrated15.mjs --execute --kind full --cases all --output test-results/cloud-check-full15 --profile test-results/cloud-check-profile
```

위 결과폴더명은 예시다. `--output`은 아직 존재하지 않는 경로를 지정하고 기존 검증 결과를 덮어쓰지 않는다. 한 장의 모델 응답·계약·사용량과 전체 Before 경로를 확인한 뒤15장으로 확대한다. 모든 사진은 manifest 순서로 한 장씩 실행한다. `--kind gemma`는 설비 목록 관측만, `--kind full`은 일반 생성 코드의 `cloud-browser-v1` 전체 경로를 사용한다. 전체 경로의 조건부 관측·거울 재확인도 실제 호출된 범위를 기준으로 보고한다.

기본 주소는 `http://127.0.0.1:8787/reconstruction-performance`, 기본 MoGe 모드는 `auto`다. `--url`, `--mode auto|webgpu|wasm`, `--room estimated|control`로 조건을 명시할 수 있다. `estimated`는 기존 `room-estimates-20260915.json`의 미실측 시험 치수, `control`은2400mm 정육면체다. 치수 변경을 AI 인식 개선으로 집계하지 않는다.

중단한 같은 실행은 다음처럼 이어간다.

```powershell
node tests/reconstruction-cloud-integrated15.mjs --execute --resume test-results/cloud-check-full15
```

resume은 소스·설정·원본과 완료 산출물을 확인한 뒤 완료 사진을 건너뛰고 같은 격리 Chrome profile을 사용한다. 소스가 바뀌면 새 `--output`이 필요하며 `--profile`을 재사용해 앱의 유효한 단계 캐시만 활용할 수 있다. 모델 응답을 주입하거나 수정하지 않는다. 기본은 첫 오류에서 멈추며, `--continue-on-error`를 써도 한도·인증 오류에서는 중단한다.

UI가 내보낸 JSON, 실제 Before PNG, 원본, 화면·단계 로그, API 요청 필드 해시·원응답, 소스 해시와 시도 이력을 보관한다. 하네스의 실행 완료와 시각 품질 통과는 별도다. `evaluation-rubric.json`을 평가에만 사용해 원본/기존019/새 Before를 직접 비교한다. 기존019의 기준 이미지는 `lid-default-fifteen-2026-09-15T10-21-43.994Z/{id}/trial/photo-aspect-before.png`이며, 같은 실행의 `adopted/`는 이전 대조 결과다. 평가표·기존 기준·시험 치수는 모두 `test-results/reconstruction-fifteen-rebuild/20260915-start/`에 있다.

## 현재 검증 범위

기존 자료: `test-results/reconstruction-browser-cloud/2026-09-15T14-37-49-793Z/`.

- `moge-runtime-validation.md`: 실제 GPU15장, GPU 미지원 자동CPU3장, isolation조건 4스레드CPU, 실패·캐시 검사.
- `moge-browser-numeric-validation-pcg64.md`: 공식 Python 후처리·평면 대조. 같은 dense16장 모두 평면 수와 지지 픽셀 일치.
- `ui-mocked/scope.md`: HTTP/Worker 모의 경계로 일반 생성·재분석·저장·모바일 등16개. 실제 AI 품질 검증으로 보지 않는다.

후속 실검증은 `test-results/reconstruction-fifteen-rebuild/2026-09-16T02-41-56-428Z-cloud-gemma/`에 기록했다. v5 전체 15장, v6 대표 3장과 전체 15장이 실제 분석·Before 생성을 마쳤다. v6 고정 핵심 품질 기준은 **2장 통과·13장 실패**이며 전체 목표는 미완료다. 실행 완료나 일부 복구를 품질 통과로 해석하지 않는다.

같은 Gemma의 thinking 비교는 실제 2회 후 품질 복구에 실패해 채택하지 않았다. 4장 통제 실험을 거친 grouped inventory와 reflection v2 적용 조건은 v7 회귀 후보이며 수정 후 실제 전체 15장 회귀는 진행 중이며 최종 품질은 아직 미판정이다. v7 lint·typecheck·Next·vinext는 통과했다. 첫 전체 단위 검사의 transport 취소 테스트 동기화 경합을 테스트에서 수정한 뒤 192파일 2,881개가 모두 통과했고, v7 모의 UI 12개도 실제 AI 없이 통과했다. 이 자동 검사 결과를 실제 사진 품질 통과로 해석하지 않는다.

v5/v6 전체 배치의 JSON 다운로드는 건너뛰었고 UI DOM JSON 보관은 다운로드 성공 검증이 아니다. 별도 v6 additional-09 전체 앱에서는 Cloud AI·geometry 캐시를 사용한 실제 JSON 다운로드 1회가 DOM/파일 SHA 일치와 브라우저 생존으로 통과했다(새 AI 0회). 이전 Chrome 충돌 원인과 새 GPU 처리 뒤 재현 여부는 미해결이다. 최신 집계·남은 거울/반사 오류와 실험 한계는 [v6 이후 검증 기록](reconstruction-cloud-browser-results-20260916-v6.md)을 따른다.

개발PC: Ryzen 7800X3D, RTX 4070 Ti, RAM 약32GB. 저사양 PC·실제 모바일·Safari/Firefox 성능은 미검증이다. 추가05·08의 좁은 바닥 지지는 기존 Python도 확정하지 못한다. 전체 Gemma+MoGe 재구성 품질과 실측 정확도는 계산 이식의 일치만으로 통과라고 하지 않는다.

공식 자료: [Gemma 입력·출력](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/), [Workers AI 무료 한도와 요금](https://developers.cloudflare.com/workers-ai/platform/pricing/), [MoGe 소스](https://github.com/microsoft/MoGe), [고정 ONNX](https://huggingface.co/Ruicheng/moge-2-vits-normal-onnx/tree/e50ffda41565591092adea54c6ac83d6212e1e23).

## 과금 확인과 Gateway 로그 권한

Workers Free와 `sjn-gateway`의 **Workers AI Billing = Standard billing**은 사용자 확인을 받았다. 기존 Wrangler 인증도 동작한다. 요금제·Gateway 상세 API의403 기록은 이 사용자 확인과 구분한다. 현재 토큰의 Gateway 상세·로그 접근 권한은 여전히 별도이며, 응답의 Gateway request ID가 로그 열람이나 과금 검증을 대신하지 않는다. 가능한 계정의 Dashboard에서 실제 요청과 로그를 대조하고, 열람할 수 없으면 미확인으로 기록한다.

AI analytics에 기록이 없더라도 정확한 실시간 잔액이나 사용0의 확정 근거로 삼지 않는다. Gateway Unified billing은 별도의 선불 크레딧 경로이므로 현재 확인한 Standard billing과 혼동하지 않는다. [공식 Gateway 과금 설명](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)
