> 이전 세 방향 기능의 역사 기록입니다. 해당 UI와 자동 정면 추정은 360° 편집기로 교체됐습니다. 현재 사용법은 [360° 제품 편집기](product3d-editor.md)를 참고하세요. 이전 소스·테스트는 `docs/archive/retired-three-view/`에 체크섬과 함께 보관했습니다.

# 3방향 생성 표면 줄무늬 품질 검증

2026-09-12, 사용자 세면대 결과에서 보이는 검푸른 줄무늬를 조사했다. 저장된 실제 AI mesh를 이용한 비교에서 **활성화된 밀도를 선형 보간하는 기존 방식 대신 실제 등밀도 표면을 반복 탐색하면 줄무늬가 크게 줄어드는 것**을 확인했다. 색을 흰색으로 덮거나 제품 사진을 바꾸지 않았다.

원인 분리에는 이전 실제 추론의 중간 데이터를 재사용했다. 이어서 흰 도기 사진으로 수정 전·후 production Worker의 전체 GPU 추론을 실제 실행하고 세 방향 PNG를 비교했다. 사용자가 올린 세면대 원본 mesh는 아직 확보하지 못했으므로 그 제품 자체의 개선은 확인하지 못했다.

## 결과

- 이전 실제 GPU 추론으로 저장한 흰 변기의 뚜껑·변좌와 정원 의자의 좌판에서도 사용자 결과와 비슷한 반복 줄무늬를 재현했다.
- 동일 mesh를 CPU decoder로 다시 색칠하거나 FP32 decoder로 바꾼 것만으로는 눈에 띄는 개선이 없었다. GPU에만 생기는 색 손상을 주원인으로 보기 어렵다.
- 로그 밀도 보간은 좌판의 검푸른 가는 줄을 크게 줄였다. 하지만 표면 normal 진단에서는 규칙적인 가로 층이 일부 남았다.
- 실제 decoder 밀도를 확인하며 7회 이분 탐색한 mesh는 검푸른 가로줄과 normal의 가로 층을 더 줄였다. 다리·팔걸이·등받이 외형과 제품 색, 좌판의 타공 무늬는 유지된다. 이 결과가 production 수정의 검증 근거다.
- 삼각형 중복, 잘못된 index, 카메라 near/far 클리핑은 이 두 표본에서 원인으로 확인되지 않았다. 단순 순백 대조군만으로 겹친 면이나 학습된 형상 오류를 모두 배제하지는 않는다.

비교 자료 `test-results/multiview-quality/geometry-comparison.png`의 위 행은 원래 제품 색, 아래 행은 진단용 표면 normal이다. 열은 기존 방식, 로그 밀도 보간, 7회 표면 탐색 순서다. normal 이미지는 실제 제품 색이 아니며 사용자에게 제품 결과로 적용하지 않는다.

## 수정 전후 실제 전체 GPU 추론

흰 도기의 수정 전·후 실제 Worker 추론 후, 같은 production renderer와 yaw 0/768×768 설정으로 왼쪽·정면·오른쪽 PNG를 생성해 직접 확인했다. 세 방향 모두 뚜껑 테두리·변좌·휴지거치대의 검푸른 반복 줄이 크게 줄었다. normal 진단에서도 가로 층이 줄었다. 여전히 입력의 배경 제거 결과에 남아 있던 휴지거치대/휴지통도 함께 복원된다. 이는 이번 표면 보간 수정과 별개의 입력 분리 한계다.

다음 SHA-256이 수정 전·후 **모두 동일**하여 제품 사진이나 backbone의 복원 장면을 바꾸지 않은 비교임을 확인했다.

| 데이터 | SHA-256 |
| --- | --- |
| 원본 투명 PNG | `09fa86ed05b3d326d4999f70b0be00ca9203897118db1bddb49bf0d54f80b3ab` |
| 전처리 모델 입력 `input.f32` | `40e9839315e66f9f3df2d0ee2a93615ff0eecbeb0539d947a446500bb44f7528` |
| backbone 출력 `scene.f32` | `8667f5fffe5448a6bd2ada40849fb0618e5b4212bf37271070e173e2bd11da4d` |

동일 모델 revision `e23007c3ce90bb968eae014c0168981871fe2d0d`, WebGPU의 실제 `processingMs`는 **3,959.8 → 4,144.8ms**였다. 한 번씩 실행한 값이며 추가 표면 탐색의 비용은 이 조건에서 185ms였다. 다른 기기의 속도를 보장하지 않는다.

이 실행의 모델 URL은 기존 pinned 모델 파일을 제공하는 로컬 loopback 서버로 연결했다. `timings.json`의 `downloadMs`/`network` 표시는 외부 다운로드가 아닌 로컬 테스트 파일 전달 시간이다. 모델 캐시 동작이나 인터넷 다운로드 성능의 검증값으로 사용하지 않는다. production 캐시 코드는 변경하지 않았다.

- 원본 데이터: `test-results/multiview-quality-toilet-{before,after}/`의 mesh, 입력, 장면, timing.
- 렌더 결과: `test-results/multiview-quality-toilet-{before,after}-render/`.
- `test-results/multiview-quality-toilet-after-render/input-comparison.json`: 전후 SHA와 타이밍.
- `test-results/multiview-quality-toilet-after-render/three-direction-comparison.png`: 위 행 수정 전, 아래 행 수정 후; 왼쪽/정면/오른쪽.
- `test-results/multiview-quality-toilet-after-render/before-after.png`: 좌측 수정 전, 우측 수정 후; 위 원색, 아래 normal.

## 실제 브라우저 검사

별도 `e2e/multiview-quality.spec.ts`는 production `renderThreeViews`를 esbuild로 묶어 실제 WebGL에서 실행한다. 순백 및 normal은 명시적으로 분리한 진단 대조군이다. 모든 실행은 Chrome 152.0.7977.83에서 수행했다.

| 검사 입력 | 결과 | 실행 시간 | 로컬 결과 폴더 |
| --- | --- | ---: | --- |
| 기존 실제 흰 변기·의자 mesh, 원색/순백/normal | 1 테스트 통과 | 3.4초 | `test-results/multiview-quality` |
| 동일 의자 mesh, CPU decoder 색 재계산 | 1 테스트 통과 | 2.8초 | `test-results/multiview-quality-cpu-recolor` |
| 동일 의자 mesh, FP32 decoder 색 | 1 테스트 통과 | 3.5초 | `test-results/multiview-quality-fp32` |
| 로그 밀도 보간 의자 mesh | 1 테스트 통과 | 2.5초 | `test-results/multiview-quality-log16` |
| 7회 이분 탐색 의자 mesh | 1 테스트 통과 | 2.9초 | `test-results/multiview-quality-refined16` |
| 새 실제 GPU 흰 도기, 수정 전 | 1 테스트 통과 | 4.3초 | `test-results/multiview-quality-toilet-before-render` |
| 새 실제 GPU 흰 도기, production 수정 후 | 1 테스트 통과 | 4.3초 | `test-results/multiview-quality-toilet-after-render` |

기본 검사는 실제 저장 mesh 2개 × 원래 색/순백 색 × 3방향 = 12개 PNG, smooth/flat normal 정면 4개를 추가해 총 16개 768×768 PNG를 생성한다. CPU 색 재계산 표본 검사는 normal 대조군을 추가하기 전에 수행해 6개 PNG다. 나머지 단일 표본은 각각 8개다.

각 원색/순백 쌍의 alpha SHA-256이 동일하다. 순백 결과의 불투명 픽셀에서 254 미만 RGB는 0개다. 모든 출력에 실제 제품 실루엣이 있으며 투명 여백이 유지된다. 입력 typed array의 SHA-256은 렌더 전후 동일하다. 이 렌더 테스트 자체에서는 모델 요청, 새 AI 추론, 사진 업로드, 자재 등록/교체를 하지 않았다. 위의 전체 GPU 추론은 별도 실제 Worker 캡처에서 수행했다.

검증 파일의 ESLint와 `npx tsc --noEmit`도 통과했다. 이 테스트의 통과는 렌더·데이터 무결성을 확인하며, 시각 품질의 완벽함을 자동 판정하지 않는다.

## 원인 분리와 수치의 해석

기존 의자 표면의 목표 밀도는 25였지만, 실제 decoder에 추출 정점 좌표를 다시 넣으면 중앙값이 약 14.52이고 ±10% 범위에 들어온 정점은 약 16%에 불과했다. 활성화된 지수 밀도의 선형 보간으로 표면 위치가 밀도 경계 안쪽으로 어긋나고, 그 위치의 다른 색을 가져오는 문제가 의심됐다. geometry 진단의 원 데이터는 `test-results/multiview-decoder-precision`과 `test-results/multiview-decoder-refined`에 있다.

목표 밀도와의 오차 또는 수렴 비율은 **등밀도 표면의 수치 정확도**다. 실제 제품과 같은 정도나 사진 품질 점수가 아니다. 이미지의 보이지 않는 뒷면·얇은 부품 등은 여전히 단일 사진 모델의 추정이다.

기존 mesh의 통계:

| 항목 | 흰 변기 | 정원 의자 |
| --- | ---: | ---: |
| 정점 | 55,956 | 38,955 |
| 삼각형 | 111,912 | 77,924 |
| 잘못된 좌표·색·index | 0 | 0 |
| 중복·퇴화 삼각형 | 0 | 0 |
| 경계 모서리 | 0 | 4 |
| 비다양체 모서리 | 0 | 0 |
| 가장 긴 모서리(모델 좌표) | 0.018897 | 0.018935 |
| 보수적으로 계산한 object depth | 2.001~3.335 | 2.155~3.592 |
| 카메라 near/far | 0.01 / 7.670 | 0.01 / 8.183 |

## 증거와 재현

각 결과 폴더의 `measurements.json`에는 mesh 통계, 입력/PNG SHA-256, alpha SHA-256, opaque 픽셀 수, 오류/요청 기록이 있다. `*-learned-{left,front,right}.png`는 원래 제품 색을 가진 결과다. `*-uniform-*.png` 및 `*-normals-*.png`는 진단 대조군이다.

기본 실제 mesh 입력은 `test-results/multiview-live-6a/mesh-*.bin`와 `test-results/multiview-chair-left/mesh-*.bin`다. 원래 추론의 출처와 한계는 `docs/multiview-validation.md`에 기록했다. 생성 이미지/mesh는 로컬 검증 산출물이며 제품 기본 자산으로 등록하지 않는다.

```powershell
$env:SJN_MULTIVIEW_QUALITY='1'
npx playwright test e2e/multiview-quality.spec.ts --reporter=line
```

새 실제 mesh에 대한 검사:

```powershell
$env:SJN_MULTIVIEW_QUALITY='1'
$env:SJN_MULTIVIEW_QUALITY_MESH='test-results/실제-세면대-mesh'
$env:SJN_MULTIVIEW_QUALITY_OUTPUT='test-results/multiview-quality-basin'
$env:SJN_MULTIVIEW_QUALITY_YAW='15'
npx playwright test e2e/multiview-quality.spec.ts --reporter=line
```

입력 폴더에는 `mesh-positions.bin`/`mesh-colors.bin`(Float32), `mesh-indices.bin`(Uint32)이 있어야 한다. 모델을 다시 불러오지 않고 결과를 비교한다. 원본 사진을 확보한 세면대 전체 생성은 별도 검증 항목으로 남아 있다.


## 최종 변경과 회귀 검사

2026-09-12 최종 구현은 `src/lib/multiview/geometry.ts`와 `worker.ts`에서 공유 정점의 격자 경계를 보존하고, 실제 decoder로 7회 표면 정밀화를 수행한 뒤 해당 좌표의 RGB를 조회한다. 기존 이미지/자재 버전에는 손대지 않는다. 수정 효과를 얻으려면 이전 결과의 카메라 각도만 바꾸는 것이 아니라 원본에서 3방향 생성을 다시 실행해야 한다. 모델 ID·가중치·캐시 정책·출력 크기는 그대로다.

- `npm test`: **47개 파일 / 448개 테스트 통과** (`test-results/multiview-quality-unit.log`). 이 중 표면/카메라 테스트 14개는 비선형 평면·곡면 수렴, 공유 정점, 원본 불변, 정확한 경계, 최종 좌표 색 샘플링, 부분 배치, 잘못된 출력과 FP16 밀도 overflow를 검증한다.
- 생성 UI 회귀: **4개 통과, 1.5분** (`test-results/multiview-quality-ui.log`). 모의 응답 UI 3개와 기존 실제 mesh 재생 1개이며, 새 AI 추론으로 계산하지 않는다. 적용 실패 시 원본 보존, 재시도, 중복 실행, 취소/닫기 후 늦은 응답, 각도 변경 및 모델 재요청 없음을 검사했다.
- 전체 ESLint 통과 (`test-results/multiview-quality-lint.log`), 최종 수정 파일 ESLint도 통과.
- Next.js production build 통과 (`test-results/multiview-quality-next-build.log`).
- vinext/Cloudflare production build 및 별도 `npm run typecheck` 모두 통과. 결과는 각각 `test-results/multiview-quality-vinext-build.log`, `test-results/multiview-quality-types.log`에 기록한다. 두 빌드는 순차 실행한다. 중간에 vinext가 생성한 `.next/types` 파일을 Next.js가 교체하는 동안 실행한 별도 tsc 실패는 최종 소스 타입 오류와 구분한다.

수정 후 전체 CPU 추론 성능과 사용자 세면대 원본은 아직 재검증하지 않았다. CPU/GPU 공통 표면 알고리즘과 실제 CPU decoder 비교는 확인했지만 저사양 기기의 성공 또는 처리 시간은 보장하지 않는다. 외부 서버 연결·배포는 수행하지 않았다.
