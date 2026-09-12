> 이전 세 방향 기능의 역사 기록입니다. 해당 UI와 자동 정면 추정은 360° 편집기로 교체됐습니다. 현재 사용법은 [360° 제품 편집기](product3d-editor.md)를 참고하세요. 이전 소스·테스트는 `docs/archive/retired-three-view/`에 체크섬과 함께 보관했습니다.

# AI 3방향 생성 검증 기록

2026-09-11 기준. 실추론, 실제 추론 결과의 재생, 모의 응답 UI 검증을 구분한다.

## 현재 확인한 결과

| 검증 | 실제 결과 | 증거 |
| --- | --- | --- |
| 정면 변기 JPG → 실제 BiRefNet → 실제 TripoSR → 세 방향 PNG → 적용 → 새 버전 저장 → 재진입 | 통과. 최초 사진의 버전은 유지되고 세 방향은 모두 새 자산 ID. 이 실행의 다운로드 버튼 단계는 진단용으로 건너뜀 | `test-results/multiview-real-full-6a.log`, `multiview-live-6a/measurements.json` |
| 왼쪽 사선 의자 JPG → 배경 제거 → 세 방향 생성 → 적용·저장·재진입 | 통과, 26.4초. 세 PNG는 768×768, 서로 다른 SHA-256, 투명 영역 유지. 다운로드 버튼은 진단용으로 건너뜀 | `multiview-chair-left.log`, `multiview-chair-left/measurements.json` |
| 실제 브라우저 CPU 대체 처리 | WebGPU adapter가 없는 Chromium에서 GPU 검사 실패 → 새 Worker → 같은 FP16 가중치의 WASM 추론 → 실제 mesh와 PNG 3장 생성까지 성공. 이 단일 테스트는 이후 다운로드 파일 복사 권한 문제로 실패했으므로 전체 통과로 세지 않음 | `multiview-chromium-gpu/progress.jsonl`의 `backend: wasm`, 실제 `*-preview.png`·`mesh-*.bin` |
| 위 실제 CPU PNG 3장의 표준 브라우저 다운로드 | 별도 새 Chrome context에서 표준 `image/png` Blob 다운로드 3/3 성공. 브라우저 종료 후 입력/출력 바이트 수와 SHA-256 모두 일치 | `multiview-cpu-download-standard.log`, `multiview-cpu-download-standard/results.json` |
| 정면 각도 보정 | 실제로 추론했던 의자 mesh를 production client/render에 재생하여 0/+15/+30/+45° 확인. +30°에서 세 PNG가 모두 변경되고 투명성 유지. Worker는 최초 1개, 보정 때문에 추가된 Worker·모델 요청 0. 보정한 세 장 일괄 적용 통과 | `multiview-calibration-browser.log`, `multiview-calibration/measurements.json`, `front-0.png`·`front-15.png`·`front-30.png`·`front-45.png` |
| UI/실패 보존 | 배경 결과 연결, 세 장 저장 실패 시 기존 사진 유지·재시도, 중복 실행 방지, 생성 취소 후 늦은 응답 무시, 보정 중 닫기와 늦은 PNG 무시 통과 | `multiview-calibration-browser.log`: 모의 응답 3개 + 실제 mesh 재생 1개, 총 4개 통과 (9.4초) |
| 단위 테스트 | 47개 파일, 442개 테스트 통과 | `multiview-all-unit.log` |
| ESLint·TypeScript | 전체 lint 및 타입 검사 통과 | `multiview-all-lint.log`, `multiview-validation-types.log` |
| Next.js·vinext/Cloudflare production build | 성공 로그 확인 | `multiview-next-build.log`, `multiview-vinext-build.log` |

위 경로는 모두 `test-results/` 아래다. PNG·mesh·브라우저 프로필은 검증 산출물이며 제품에 배포되는 샘플 자산이 아니다. 실제 서버 연결·배포는 실행하지 않았다.

## 속도와 자원 조건

- GPU 실기: Windows, Google Chrome 152.0.7977.83, RTX 4070 Ti 12GB, NVIDIA driver 591.86. 별도 사용자 프로그램이 GPU를 사용 중이었다. 테스트가 그 프로그램을 종료하거나 변경하지 않았다.
- 캐시가 준비된 변기: TripoSR 실제 처리 약 **4.10초**, PNG 렌더링을 포함한 화면 표시 **4.25초**, 모델 준비 약 **2.85초**, 모델 다운로드 **0초**. 전체 UI 흐름은 **22.2초**였다.
- 왼쪽 사선 의자: TripoSR 처리 약 **4.84초**, PNG 렌더링 포함 **4.97초**, 모델 준비 약 **3.21초**, 모델 다운로드 **0초**.
- CPU 실기: Playwright bundled Chromium 153.0.8010.12 headless shell에서 WebGPU adapter가 없어 WASM으로 전환했다. TripoSR 실제 처리 **358.90초(약 6분)**, 모델 준비 약 **2.94초**, TripoSR 가중치 다운로드 **0초**였다. CPU 추론 도중 주 작업 프로세스의 작업 집합 한 번 측정값은 약 **2.83GB**였다. 이는 최대 사용량이나 저사양 기기 보장값이 아니다.
- 같은 TripoSR FP16 파일 세 개를 GPU·CPU에서 사용한다. CPU용 추가 TripoSR 모델을 받지 않았다. CPU 실행 앞의 BiRefNet 모델은 별도 기능이므로 자체 FP32 파일을 받았다.
- 측정은 해당 하드웨어·브라우저·입력 사진의 결과다. 저사양 PC, 모바일, 모든 브라우저에 대한 성능 보장 시험은 하지 않았다.

## 실제 품질과 방향의 한계

한 mesh에서 세 장을 새로 렌더링했으므로 원본 사진 한 장을 그대로 끼워 넣거나 좌우로 뒤집어 결과인 것처럼 보여주지 않는다. 모든 출력은 새 PNG다.

입력에서 고르는 왼쪽·정면·오른쪽은 카메라 방향의 추정값이다. 사선 각도가 고정된 값과 다르면 최초 정면이 비껴갈 수 있다. 실제 의자에서 이 현상을 확인했으며, **정면 각도 보정**으로 같은 mesh의 카메라를 조절하도록 보완했다. 실제 의자 mesh는 +30°에서 개선됐고 +45°가 더 정면에 가까워 보였다. 보정은 AI를 다시 실행하지 않으며 세 방향을 함께 갱신한다. 이는 일반 물체의 정면을 자동으로 정확히 판별한다는 보장은 아니다.

정면 변기 사진의 BiRefNet 결과에는 옆 휴지통과 거치대가 남았고, TripoSR도 이를 함께 복원했다. 얇은 의자 장식의 구멍·다리, 광택, 보이지 않는 면에는 변형이나 부정확한 형상이 있었다. 제품 자체가 뚜렷하고 배경 제거 결과가 깨끗한 입력일수록 유리하다.

추가로 전시장 프레임이 크게 나온 `toto-inwall.jpg`를 그대로 시험했다. BiRefNet이 모두 투명한 결과를 반환해, 3방향 엔진은 **“제품이 보이지 않는 투명 이미지예요.”**로 중단했다. 유효한 3D 결과로 표시하지 않았으며 기존 재료 버전 1개와 방향 사진 1개는 유지됐다 (`multiview-toto-left/preserved-versions.json`). 이 사진은 성공 사례로 세지 않는다. 원본을 자르거나 수정하여 실패를 숨기지 않았다.

TOTO 사진: [Charles & Hudson의 TOTO in Wall Toilet Tank](https://commons.wikimedia.org/wiki/File:TOTO_in_Wall_Toilet_Tank_(5202621769).jpg), [CC BY-SA 2.0](https://creativecommons.org/licenses/by-sa/2.0/). QA 전용 원본이며 상세 출처·해시는 `test-results/multiview-fixtures/sources.json`에 보관했다. 기존 변기·의자 사진 출처는 [AI 배경 제거 문서](ai-background-removal.md)를 따른다.

## 다운로드 자동화에서 분리한 문제

기존 persistent Chrome QA 프로필에서 PNG 다운로드 시 네이티브 종료 코드 `3221225477`이 재현됐다. 같은 PNG가 새 Chrome context와 bundled Chromium에서는 다운로드됐으므로 앱 전체의 다운로드 실패로 일반화하지 않는다. 사용자 개인 프로필에는 접근하지 않았다.

또한 Windows에서 브라우저가 보유한 다운로드 파일을 바로 Node에서 읽거나 복사하면 `EPERM`이 발생했다. 검증 하네스는 현재 다운로드 임시 경로를 `os.tmpdir()`로 지정하고, 이미지 품질은 메모리 PNG에서 확인한 뒤 다운로드 파일 SHA-256은 **browser/context 종료 후** 검사하도록 수정했다. 별도 3장 다운로드 시험으로 이 정책을 확인했다. 이 수정 뒤의 전체 CPU 6분 추론 테스트는 중복 실행하지 않았다. 기존 단일 CPU Playwright 실행은 실패 기록을 유지하고, 실추론·PNG 생성 성공과 별도 다운로드 성공을 합쳐 위 결과를 보고한다.

## 재현

```powershell
# 작은 UI 검증 + 존재하는 실제 mesh fixture의 각도 재생 (AI 모델 실행 없음)
npx playwright test --config playwright.multiview.config.ts --grep '모의 응답 UI|실제 AI 메시 재생'

# 실제 JPG → 배경 제거 → 3방향 → PNG 다운로드 → 적용·저장
# bundled Chromium 설치는 개발용 브라우저 준비이며, 앱 이용자는 설치할 필요가 없다.
npx playwright install chromium
$env:SJN_MULTIVIEW_REAL='1'
$env:SJN_MULTIVIEW_CHANNEL='chromium'
$env:SJN_MULTIVIEW_PROFILE='tmp/multiview-chromium-profile'
$env:SJN_MULTIVIEW_DIRECT='0'
$env:SJN_MULTIVIEW_OUTPUT='test-results/multiview-reproduction'
npx playwright test --config playwright.multiview.config.ts --grep '실제 로컬 모델'
```

이 환경의 bundled Chromium headless shell은 CPU로 처리하므로 수 분을 기다려야 한다. 실제 실추론은 모델/Worker 응답을 모의 처리하지 않는다. `SJN_MULTIVIEW_REAL=1`을 주지 않으면 큰 모델을 받는 실추론 테스트는 건너뛴다.

추가 설정:

- `SJN_MULTIVIEW_INPUT`: 직접 준비한 원본 사진 경로. 미지정 시 `test-results/background-removal/fixtures/white-toilet.jpg`.
- `SJN_MULTIVIEW_DIRECTION`: `정면`(기본), `왼쪽 측면`, `오른쪽 측면`.
- `SJN_MULTIVIEW_DIRECT=1`: 기존 실제 BiRefNet 투명 PNG 결과를 사용해 배경 제거 단계를 건너뛴다.
- `SJN_MULTIVIEW_CPU=1`: Chrome에서 WebGPU를 끄는 개발용 테스트 플래그. 제품 코드 설정이 아니다.
- `SJN_MULTIVIEW_DOWNLOAD=0`: 다운로드 하네스 문제와 적용/저장을 분리하는 진단 전용 모드. `measurements.json`에 `downloadsVerified: false`를 남기며 다운로드 통과로 세지 않는다.
- `SJN_MULTIVIEW_REPLAY_DIR`: 실제 추론 mesh가 저장된 폴더. 기본값은 `test-results/multiview-chair-left`. fixture가 없으면 실제 mesh 재생 검증을 건너뛴다.

모델 캐시는 테스트 전용 `tmp/multiview-*-profile`에 보관한다. 브라우저 실행 상태를 확인하지 않고 프로필을 동시에 열거나 삭제하지 않는다. 진행은 출력 폴더 `progress.jsonl`, 실측은 `measurements.json`, 형상은 `mesh-positions.bin`·`mesh-indices.bin`·`mesh-colors.bin`에 남는다.

초기 엔진 디버깅에서는 GPU 버퍼 캐시 `disabled`의 메모리 검증 오류와 backbone 출력 이름 불일치를 고쳤고 `simple` 캐시로 실제 추론을 검증했다. 처음 나타났던 GPU device lost는 사용자 GPU 동시 부하가 큰 환경에서의 한 번의 실패이며 원인을 단정하지 않는다. 이후 GPU 및 같은 가중치의 CPU 경로를 실제로 확인했다.

## 2026-09-12 표면 줄무늬 수정 후속 검증

위의 실제 추론·저장·다운로드 통과는 사진과 같은 품질을 보장한다는 뜻은 아니다. 이후 사용자 세면대 결과의 검푸른 줄무늬를 확인하고, 기존 실제 mesh에서도 같은 현상을 재현해 등밀도 표면 추출의 보간 오차를 조사했다. 로그 밀도 보간·실제 밀도 반복 탐색과 원래 방식의 제품 색/표면 normal 비교, 그리고 세면대 원본 미확보에 따른 검증 한계는 [표면 줄무늬 품질 검증](multiview-quality-validation.md)에 별도로 기록한다.
