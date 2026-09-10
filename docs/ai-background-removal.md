# AI 배경 제거 테스트

제품 방향 사진을 실제 AI 모델로 처리해 원본·결과·시간을 확인하는 **비파괴 테스트**다. 결과를 등록 자재에 자동 적용하거나 기존 원본·방향 이미지·수동 지우기 결과를 덮어쓰지 않는다.

## 사용법

1. 자재 관리의 **자재 등록 / 자재 수정**, 또는 편집기의 **신규 자재 등록**을 연다.
2. 타일이 아닌 제품 카테고리를 선택하고 **제품 방향 이미지 올리기**로 사진을 올린다.
3. 각 사진 미리보기의 **배경 수동 지우기** 옆 **AI 배경 제거 테스트**를 누른다. 누른 사진만 처리한다.
4. 결과 창에서 원본과 결과를 나란히 확인한다. 체크무늬·흰색·검은색을 바꾸고, 확대와 이동으로 흰색 제품 내부·얇은 부품·배경 잔여물을 확인한다.
5. **투명 PNG 다운로드**는 원본 해상도의 결과 파일만 저장한다. 창을 닫으면 자재 편집 상태로 돌아간다. 실패 이유가 표시되면 **다시 시도**로 실행한다.

모델 준비와 처리 중에는 중복 실행을 막는다. 테스트 결과를 저장된 제품 이미지로 쓰려면 내려받은 PNG를 사용자가 별도로 방향 사진으로 등록해야 한다.

## 모델, 라이선스와 브라우저 조건

확인일: **2026-09-10**.

| 구성          | 선택값                                                                                | 원문                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AI 모델       | `studioludens/birefnet-lite-512`, revision `4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7` | [모델 카드](https://huggingface.co/studioludens/birefnet-lite-512)                                                                                                       |
| 상위 모델     | `ZhengPeng7/BiRefNet_lite`, MIT                                                       | [상위 모델](https://huggingface.co/ZhengPeng7/BiRefNet_lite), [라이선스](https://github.com/ZhengPeng7/BiRefNet/blob/main/LICENSE)                                       |
| 브라우저 추론 | `onnxruntime-web@1.29.0`, MIT                                                         | [고정 버전 라이선스](https://github.com/microsoft/onnxruntime/blob/v1.29.0/LICENSE), [브라우저 지원표](https://onnxruntime.ai/docs/get-started/with-javascript/web.html) |

모델 카드의 MIT 표시와 상위 모델·런타임의 MIT 라이선스를 확인했다. 상업적 사용을 허용하고 별도 유료 API가 필요하지 않으며, 배포 시 저작권·허가 고지를 유지한다. 고지 원문은 [BiRefNet MIT](../public/licenses/birefnet-MIT.txt), [ONNX Runtime MIT](../public/licenses/onnxruntime-MIT.txt)에 보관한다. 모델 서비스와 배포 방식의 향후 변경까지 보장하는 의미는 아니다.

ONNX Runtime 공식 문서는 Windows Chrome/Edge의 WebGPU를 지원 대상으로 명시하며, FP16은 Chrome 121+/Edge 122+를 요구한다. 실제 선택은 브라우저 버전 문자열 대신 어댑터·기능 지원을 확인한다. 저장된 FP32 모델이 있으면 CPU로 우선 재사용한다. 캐시가 없는 경우 WebGPU를 먼저 선택하며, WebGPU가 불가능하거나 GPU 초기화·추론에 실패하면 WebAssembly CPU 대체 처리를 수행한다. WASM의 브라우저 지원 범위가 넓더라도 모델의 실제 실행은 기기 메모리와 지원 명령에 좌우된다. 두 경로 모두 실행할 수 없으면 실패 원인을 알린다. HTTPS 또는 localhost의 보안 컨텍스트, Web Worker, 이미지 디코딩과 Canvas 기능이 필요하다.

## 처리 방식과 시간 해석

- 사용자가 처음 테스트를 누른 시점에 Worker·런타임·모델을 준비한다. 모델 가중치는 고정 revision URL을 사용한다. 저장된 모델을 먼저 확인해 재사용한다. FP32가 있으면 CPU로 시작하고 FP16을 추가 다운로드하지 않는다. FP16만 있으면 지원되는 GPU에서 그 파일을 사용한다. 창을 닫을 때 Worker와 추론 세션을 정리하고, 다음 테스트는 캐시에서 모델을 읽어 새 세션을 준비한다.
- WebGPU용 FP16 모델은 **98,484,532바이트(약 94 MiB)**, WASM용 FP32는 **191,877,254바이트(약 183 MiB)**다. WebGPU가 FP16을 지원하지 않으면 FP32를 사용한다. 첫 실행에는 런타임 파일도 필요하다. GPU 실행 실패로 CPU로 전환할 때 FP32가 없으면 추가 다운로드한다. CPU 추론과 PNG 생성이 모두 성공한 뒤 고정 revision의 FP16 캐시만 삭제한다. 실패·취소한 작업은 성공 후 정리를 실행하지 않으며 FP32·다른 revision·제품 자산을 삭제하지 않는다. 모델 네트워크 다운로드 오류는 GPU 연산 실패와 구분하여 다른 모델 다운로드로 이어지지 않는다.
- ONNX Runtime의 JSEP WASM은 27,797,172바이트여서 [Cloudflare 정적 자산의 25 MiB 한도](https://developers.cloudflare.com/workers/platform/limits/#static-assets)를 넘는다. 고정 버전 런타임 CDN 경로를 사용한다. 모델과 런타임 GET 다운로드는 외부 요청이지만 **제품 사진을 서버에 업로드하지 않는다**.
- Worker에서 **512×512 분석 입력**을 준비해 ImageNet RGB 정규화, 실제 ONNX 추론, sigmoid 마스크, 원본 크기로 마스크 확대, PNG 합성을 수행한다. 단순히 흰색 픽셀을 지우는 방식이 아니다. 결과의 WebGPU 표시는 선택한 ONNX 실행 경로이며, 런타임 내부에서 일부 연산을 CPU로 처리할 가능성까지 배제하는 표시는 아니다.
- 저장 해상도는 방향이 정규화된 업로드 원본 기준이다. 편집 미리보기의 2048px 제한과 다르다. 단, 이미 수동 지우기·보정을 적용한 사진은 그 편집 이미지의 픽셀·해상도를 유지한다. 기존 수동 도구가 축소한 세부를 되살리거나 편집 전 원본으로 바꾸지 않는다. 원래 투명하거나 반투명했던 픽셀은 `원본 알파 × AI 마스크`로 처리해 더 불투명해지지 않는다.
- **모델 다운로드 시간**, **초기화 시간**, **이미지 처리 시간**, **순수 추론 시간**을 분리한다. 이미지 처리에는 전처리·추론·마스크 확대·PNG 인코딩이 포함된다. 모델 캐시 상태에 따라 첫 실행과 이후 실행 시간은 달라진다. 캐시 검사·성공 후 정리 시간은 모델 준비 시간에 포함하고 이미지 처리 시간에 섞지 않는다.
- 결과 표시·배경색·확대·PNG는 메모리의 테스트 결과를 사용한다. IndexedDB 제품/자재 변경, 서버 저장, 합성 결과 업로드를 수행하지 않는다.

## 모델 캐시 선택·정리 정책 (2026-09-10 변경)

| 실행 시작 시 유효한 캐시 | 선택 |
| --- | --- |
| FP32 있음 (FP16 동시 존재 포함) | CPU로 FP32 재사용. GPU 모델 추가 다운로드 없음 |
| FP16만 있고 GPU/FP16 지원 | GPU로 FP16 재사용 |
| 없음 | 기기 지원 확인 후 GPU 우선, 불가능하면 CPU |
| FP16만 있으나 현재 환경에서 실행 불가 | 필요한 FP32를 다운로드해 CPU 또는 지원되는 FP32 GPU로 처리 |

GPU 실행에 실패하면 기존 Worker를 종료하고 새 Worker에서 CPU FP32로 한 번 재시도한다. 실패한 GPU 런타임을 같은 Worker에서 재사용하면 CPU 초기화가 정지하는 사례를 실제 테스트로 확인하여 격리했다. 모델 캐시는 Worker 종료와 무관하게 유지하고 두 시도의 다운로드·초기화·처리 시간을 합산한다. 종료된 GPU Worker의 늦은 이벤트는 CPU 결과에 영향을 주지 않는다. 모델 파일 다운로드 오류는 GPU 실행 오류와 구분해 CPU 재시도 조건에 포함하지 않는다. **CPU가 결과 PNG까지 완성한 뒤에만** FP16 캐시를 제거하고 결과 창에 정리 사실을 표시한다. 이후에는 남아 있는 FP32를 사용하므로 GPU가 다시 지원되더라도 FP16을 자동으로 받지 않는다. 기존에 두 파일을 저장한 사용자도 다음 CPU 성공 시 FP16이 정리된다.

새 모델 다운로드는 HTTP 캐시에 중복 보관하지 않고 앱의 CacheStorage에서 관리한다. 이전 버전이 남긴 HTTP 캐시까지 웹앱이 선택적으로 삭제하는 것은 아니며, 그 항목은 브라우저의 일반 만료·정리 정책을 따른다. 캐시 검사는 이름이나 헤더만 믿지 않고 실제 Blob 크기를 확인한다. 불완전한 파일은 삭제하고 다시 받는다. 브라우저 캐시 자체가 삭제·회수됐거나 저장 권한/용량 문제가 있으면 영구적인 재다운로드 방지를 보장할 수 없다. 캐시 삭제가 거부돼도 완성된 PNG는 전달한다. CPU/GPU가 공용으로 쓸 수 있는 FP32를 GPU 전용 파일로 간주해 지우지 않는다.

## 재현 가능한 검증

일반 UI 확인에는 모델 다운로드를 요구하지 않는다. 실추론 테스트는 공개 실사 사진을 준비하고 환경변수로 명시적으로 실행한다. 결과 PNG를 대체하거나 모델 응답을 모킹하지 않는다.

```powershell
node --experimental-strip-types tests/prepare-background-removal-fixtures.ts
npm run test:background-removal
$env:SJN_AI_BACKGROUND_REAL = '1'
npm run test:background-removal -- --output=test-results/background-removal-e2e-real
Remove-Item Env:SJN_AI_BACKGROUND_REAL
```

Cloudflare 빌드로 같은 브라우저 검증을 수행하려면 먼저 `npm run build:vinext`를 실행하고 `SJN_AI_BACKGROUND_TARGET=cloudflare`를 설정한다. 전용 설정은 `npm run start:vinext`의 로컬 Wrangler 주소 `http://127.0.0.1:8787`를 사용한다. 실제 서버 배포는 하지 않는다. CPU 대체 경로만 검증하려면 `SJN_AI_BACKGROUND_WASM=1`로 실행한다. 이 테스트는 Chrome의 `WebGPUService` 기능을 끄고 실제로 어댑터가 없음을 검사한 뒤 FP32 모델을 실행한다.

```powershell
npm run build:vinext
$env:SJN_AI_BACKGROUND_TARGET = 'cloudflare'
$env:SJN_AI_BACKGROUND_REAL = '1'
npm run test:background-removal -- --output=test-results/background-removal-cloudflare-real
Remove-Item Env:SJN_AI_BACKGROUND_REAL
$env:SJN_AI_BACKGROUND_WASM = '1'
npm run test:background-removal -- --grep '실제 WASM' --output=test-results/background-removal-cloudflare-wasm
Remove-Item Env:SJN_AI_BACKGROUND_WASM
Remove-Item Env:SJN_AI_BACKGROUND_TARGET
```

기본 Playwright의 강제 SwiftShader 설정을 이 테스트에서는 사용하지 않는다. Chrome의 실제 WebGPU 어댑터·기능·CPU 스레드 수와 실행 시간, PNG 크기·알파 통계를 `real-inference-measurements.json`에 기록한다. 비교 스크린샷과 다운로드 PNG도 테스트 출력 폴더에 남긴다. 캐시가 준비된 실행과 최초 네트워크 실행을 별도로 해석해야 한다.

| 실제 사진                         | 확인 대상                                         | 출처·저작자·라이선스                                                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `white-toilet.jpg` / 1536×2048    | 흰색 도기와 복잡한 욕실 배경                      | [White toilet.JPG](https://commons.wikimedia.org/wiki/File:White_toilet.JPG), Doug Coldwell, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)                                                                      |
| `retro-desk-lamp.jpg` / 4608×3072 | 얇은 스탠드, 어두운 배경, 거울에 비친 제품        | [Retro desk lamp.jpg](https://commons.wikimedia.org/wiki/File:Retro_desk_lamp.jpg), WANGYIFAN2024, [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)                                                                  |
| `garden-chair.jpg` / 2333×3500    | 장식 철제의 작은 구멍과 얇은 부품, 장작·자갈 배경 | [Cast iron garden chair at Boreham, Essex, England.jpg](https://commons.wikimedia.org/wiki/File:Cast_iron_garden_chair_at_Boreham,_Essex,_England.jpg), Acabashi, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| 흰색 도기 사진의 기존 알파 변형   | 투명/반투명 입력 보존                             | 위 도기 사진에 테스트 코드가 가장자리 투명/반투명 영역만 추가. 같은 라이선스이며 품질 정답 마스크가 아니다.                                                                                                                       |

사진은 `.gitignore` 대상인 `test-results/background-removal/fixtures`에만 내려받고 앱 기본 이미지나 배포 자산에 넣지 않는다. CC BY-SA 사진의 배경 제거 결과·알파 변형을 공유할 경우 해당 원저작자·출처·CC BY-SA 4.0 표시와 수정 사실을 함께 유지한다. 이 사진 라이선스를 앱 소스 코드의 라이선스로 적용한다는 의미는 아니다.

### 실제 실행 기록

**2026-09-10, Windows 11, Chrome 152.0.0.0 headless, AMD Ryzen 7 7800X3D / NVIDIA GeForce RTX 4070 Ti / RAM 약 32 GB**, WebGPU FP16 경로에서 실행했다. 소프트웨어 GPU를 강제로 사용하지 않았다. 아래 시간은 해당 기기·사진·당시 네트워크 조건의 실측이며 일반 사용자 기기의 속도를 보장하지 않는다.

| 실제 입력                 | 저장 해상도 | 모델 다운로드 | 모델 준비 | 이미지 처리 | 그중 AI 추론 |
| ------------------------- | ----------- | ------------- | --------- | ----------- | ------------ |
| 흰색 도기                 | 1536×2048   | 17.18초       | 5.70초    | 3.29초      | 3.17초       |
| 거울 앞 램프              | 4608×3072   | 0.00초 · 캐시 | 5.52초    | 3.45초      | 3.06초       |
| 장식 철제 의자            | 2333×3500   | 0.00초 · 캐시 | 5.32초    | 3.54초      | 3.26초       |
| 기존 알파가 있는 도기 PNG | 1536×2048   | 0.00초 · 캐시 | 5.21초    | 3.14초      | 3.02초       |

네 사진을 이어서 처리하는 동안 모델 요청은 최초 고정 revision FP16 파일 **1회**였고 이후 세 번은 캐시를 사용했다. 모든 다운로드 PNG의 해상도가 입력과 같고 기존 알파보다 불투명해진 픽셀은 **0개**였다. 상품/버전/자산 데이터 변경, 외부 업로드, 브라우저 페이지 오류가 없었다. 분석 해상도는 네 경우 모두 512×512다.

| 검증                                              | 실제 결과                                                                                                                                                                                       |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e/background-removal.spec.ts` · Next.js        | **2/2 통과 · 1.4분**. 버튼 위치·지연 모델 로드, 실사 3종+기존 알파 변형의 실제 추론·3가지 배경·확대·원본 크기 투명 PNG 다운로드·비파괴·캐시 재사용                                              |
| `e2e/background-removal-failures.spec.ts`         | **4/4 통과 · 31.1초**. 실제 요청 차단으로 실패·재시도, 처리 중 취소·중복 방지, Worker 미지원·모바일 하단 버튼. 실제 수동 브러시 지우기·저장 후 편집된 알파와 AI 입력 Blob SHA-256 일치 확인. 실패 테스트는 가짜 결과를 반환하지 않음 |
| 기존 편집·자재 입력 회귀 | **4/4 통과 · 33.2초**. 제품 방향·배치·잠금·삭제·재진입, 잘못된 이미지 거절, 자동 저장 전 이동 복원, 수량·가격 입력 검증 |
| Vitest                                            | **43파일 / 419개 통과**. 엔진·마스크·알파·캐시·원본 연결, 캐시 우선 선택·성공 후 삭제 순서 테스트 포함                                                                                                                         |
| ESLint / TypeScript                               | **통과**                                                                                                                                                                                        |
| `npm run build`                                   | **통과**                                                                                                                                                                                        |
| `npm run build:vinext`                            | **통과**. 사용하지 않는 약 25.7 MB 런타임 자산을 배포물에 포함하지 않으며 큰 실행 파일은 고정 CDN에서 지연 로드                                                                                 |
| Cloudflare 로컬 빌드의 실제 WebGPU 추론           | **2/2 통과 · 1.6분**. 같은 실사 3종+기존 알파 변형의 원본 크기 PNG·비교·배경색·확대·캐시·비파괴 검사를 로컬 Wrangler에서도 통과                                                                 |
| WebGPU를 끈 실제 WASM FP32 추론 · Cloudflare 로컬 | **1/1 통과 · 45.5초**. CPU 경로의 실제 512×512 분석, 1536×2048 투명 PNG, 처리 중 배경색 버튼 반응을 확인                                                                                        |

로그는 `test-results/background-removal-real.log`, `background-removal-failures-final.log`, `background-removal-regression.log`, `background-removal-unit.log`, `background-removal-lint.log`, `background-removal-types.log`, `background-removal-next-build.log`, `background-removal-vinext-build.log`에 있다. 실추론 JSON·전후 스크린샷·PNG는 `test-results/background-removal-e2e-real/`에 있다.

**Cloudflare 로컬 WebGPU 확인:** vinext의 빌드 결과를 로컬 Wrangler로 실행한 `http://127.0.0.1:8787`에서 같은 네 입력을 검증했다. 첫 도기 사진의 모델 다운로드 **32.97초**, 모델 준비 **5.48초**, 이미지 처리 **3.08초**, 그중 추론 **2.97초**였다. 이 차이를 프레임워크의 속도 차이로 판단하지 않는다. 로그: `test-results/background-removal-cloudflare-real.log`, 결과: `test-results/background-removal-real-cloudflare/`. 실제 Cloudflare 계정 배포는 실행하지 않았다.

**CPU 대체 경로 실측:** 같은 PC의 Chrome에서 `--disable-features=WebGPUService`로 실제 어댑터가 없는 상태를 확인하고, Cloudflare 로컬 빌드에서 흰색 도기 사진을 WASM FP32로 처리했다. 모델 다운로드 **26.81초**, 모델 준비 **3.94초**, 이미지 처리 **7.73초**, 그중 추론 **7.61초**였다. 처리 중에도 검은색 배경 버튼이 반응했다. WASM은 별도 Worker에서 단일 스레드로 실행하며, 속도는 다른 기기에서 달라질 수 있다. 로그: `test-results/background-removal-wasm.log`, PNG·진행 단계·측정 JSON: `test-results/background-removal-wasm-cloudflare/`.

Windows 검증 환경에서는 브라우저가 프로젝트 폴더에 만든 임시 다운로드 파일을 Node가 읽을 때 `EPERM`이 발생했다. 별도 다운로드 실험에서 원인을 확인하고 **테스트용 Chrome 다운로드 위치만 시스템 TEMP로 지정**했다. 실제 다운로드 이벤트·PNG 바이트를 그대로 검증하며, 제품 코드의 다운로드 방식이나 AI 결과를 대체하지 않는다.

육안 검토 결과:

- **흰색 도기:** 흰색 뚜껑·변기 본체·받침과 내부 음영은 남고 벽·바닥이 제거됐다. 물탱크 뒤쪽 일부는 사라졌고, 옆 휴지통·휴지걸이가 함께 남았다.
- **거울 앞 램프:** 어두운 배경은 많이 제거됐지만 두 갓(실제 제품과 반사상)이 함께 남았다. 얇은 스탠드·받침 손실이 크고 뒤의 목재·전구 일부가 남아, 이 사진은 만족스러운 단일 제품 분리에 실패한 사례다.
- **장식 철제 의자:** 주요 윤곽·다리·등받이 장식이 상당 부분 유지되고 장작·자갈 배경은 제거됐다. 미세한 구멍 안의 잔여물과 경계는 확대 확인이 필요하며 완벽한 정답 마스크로 판정하지 않았다.

## 품질과 검증 범위의 한계

- 512×512 마스크를 원본 크기로 확대하므로 저장 픽셀이 많아도 분석에서 놓친 얇은 부품·구멍·머리카락 같은 세부가 복구되지는 않는다.
- 모델은 사진에서 눈에 띄는 전경을 추출한다. 제품 여러 개, 거울 속 반사, 손·소품이 함께 보이면 사용자가 원하는 단일 제품과 다를 수 있다.
- 흰색 제품과 밝은 배경, 투명 유리, 반사 금속의 경계에는 손실·색 번짐·잔여 배경이 생길 수 있다. 전경 RGB는 원본 색을 유지하므로 배경색 오염을 별도로 복원하는 기능은 없다.
- 정답 마스크가 없는 공개 사진은 전후 육안 비교 사례이며 IoU 같은 정량 정확도나 모든 상품에 대한 성능 보증으로 취급하지 않는다.
- 모바일·Safari·Firefox 및 메모리가 작은 기기의 실제 품질·속도는 실행한 환경과 구분해 기록한다. Cloudflare 빌드 검증은 배포 및 실제 원격 기기 검증과 다르다.

## 캐시 정책 변경 검증

- 새 캐시 단위 검사 **16개**, Worker 제어 흐름 검사 **13개**, Worker 교체·취소·시간 합산 검사 **14개**를 포함해 전체 Vitest **419개 통과**.
- Worker 단위 검사는 런타임을 모킹한 제어 흐름 검사다. GPU 세션 준비/추론 오류의 CPU 재시도, CPU 또는 PNG 실패 시 FP16 보존, 캐시 FP32 우선, 네트워크 오류 시 추가 모델 다운로드 방지를 확인한다. 실제 AI 성능 측정으로 취급하지 않는다.
- 기존 AI UI·실패·취소·수동 지우기 브라우저 검사 **5개 통과 (16.1초)**. 별도 opt-in 실추론 3개는 해당 기본 실행에서 제외했다.
- ESLint, TypeScript, Next.js 빌드와 vinext/Cloudflare 빌드 통과. 로그: `test-results/background-cache-unit.log`, `background-cache-regression.log`, `background-cache-lint.log`, `background-cache-types.log`, `background-cache-next-build.log`, `background-cache-vinext-build.log`.

캐시 전환의 실추론 검사는 다음 명령으로 별도 실행한다. 테스트용 GPU 장치 생성 실패와 PNG 인코딩 대기만 주입하며, 모델·추론·PNG 결과는 실제 실행한다.

```powershell
$env:SJN_AI_BACKGROUND_CACHE = '1'
npm run test:background-removal -- e2e/background-removal-cache.spec.ts --output=test-results/background-cache-real
Remove-Item Env:SJN_AI_BACKGROUND_CACHE
```


**Next.js 실제 전환 검증: 1/1 통과 (1.7분).** 실제 FP16 모델을 받은 뒤 테스트가 GPU 장치 생성을 실패시키고, 앱이 새 Worker에서 FP32를 다운로드해 실제 CPU 추론을 실행했다. PNG 인코딩 직전에는 두 모델을 모두 보존하고, PNG 완료 후 FP16만 삭제함을 확인했다. GPU 실패 주입을 해제하고 새 Worker로 다시 실행했을 때도 저장된 FP32를 사용했으며, 모델 요청은 **0회**, 표시 다운로드 시간은 **0.00초**였다. 두 결과 모두 실제 **1536×2048 투명 PNG**다. 이는 제어 흐름 검증이며 저사양 기기 성능 측정이 아니다. 로그: `test-results/background-cache-real-next-isolated.log`, 결과·측정 JSON: `test-results/background-cache-real-next-isolated/`.


**Cloudflare용 vinext 로컬 빌드: 동일 실추론 검사 1/1 통과 (1.8분).** 실제 GPU 실패 후 새 CPU Worker에서 PNG를 완성하고 FP16만 삭제했으며, 재진입 모델 요청은 0회였다. 로그: `test-results/background-cache-real-cloudflare-isolated.log`, 증거: `test-results/background-cache-real-cloudflare-isolated/`. 원격 배포는 하지 않았다.

Next.js 검사에서는 최초 CPU 결과와 재진입 CPU 결과 PNG가 각각 2,028,328바이트로 SHA-256까지 같았다. 브라우저 실험은 같은 고성능 테스트 PC에서 실행한 오류 전환·캐시 동작 검증이며, 일반 사용자 기기의 처리 속도를 입증한 결과로 해석하지 않는다.
