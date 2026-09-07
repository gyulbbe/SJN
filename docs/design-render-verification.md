# 시안 미리보기·비교 렌더링 검증

현재 시안 생성·복제 한도는 **5개**이며 비교도 **5개**다. 이전 10개 한도에서의 측정·시험 기록은 아래에 보존했다. [5개 한도 변경과 기존 자료 호환](five-design-limit.md) 참고.

검증일: 2026-09-07. 로컬 모드, 외부 서비스 연결·업로드 없음.

## 구현 경로

- `src/components/designs/design-manager.tsx`: 최대 10개 시안 관리, 활성 시안 표시, 복제·이름 변경·확인 후 삭제, 최대 5개 비교 선택. 한도·이름은 상태 계층의 공통 규칙을 사용한다.
- `src/components/designs/design-comparison.tsx`: 2/3개는 한 줄, 4개는 2×2, 5개는 3×2. 좁은 화면에서는 2열 또는 1열로 바뀐다. 모든 카드의 이미지 비율을 유지한다. 확대·이동 동기화는 기본으로 켜져 있고, 끄면 개별 좌표로 탐색한다.
- `src/lib/render/design-preview.ts`: 프로젝트별 한 개 `PhotoCompositor`를 참조 수로 공유하는 직렬 큐. 이는 DOM/WebGL 렌더러이며 Web Worker에서 실행되는 것으로 표시하지 않는다. 편집 중인 캔버스와 별도이며 비교 화면 진입 시 편집 캔버스는 종료된다.
- 각 요청은 호출 시 scene과 사용 중인 불변 자재 버전을 복사하고, project/design/shared revision·이미지 참조·자재 내용·렌더러 버전·출력 크기로 키를 만든다. 같은 채널의 이전 요청은 취소하며, 대기/렌더/인코딩/캐시 단계 뒤에도 최신 요청 여부를 확인한다.
- 확대·이동은 이미지의 `translate3d`와 `scale`만 바꾸고 합성을 다시 실행하지 않는다. 이미지의 `left/top` 레이아웃 변경을 없애고 `will-change: transform`으로 합성 레이어를 유지한다. scene/자재 JSON 직렬화는 입력이 달라질 때만 수행하며 NextImage도 정지된 이미지 props로 메모화한다. 크기 변경은 화면 맞춤 크기와 DPR을 기준으로 512/1024/1536/2048px 중 필요한 미리보기 크기를 다시 고를 수 있다. 500% 확대에서는 원본보다 흐릿할 수 있으며 개별 PNG는 전체 공간을 원본/GPU 한도 내 최대 4096px로 내보낸다.
- 썸네일은 긴 변 최대 360px, 비교는 최대 2048px이다. 비교용 타일 atlas 입력은 실제 셀 크기(최대 512px), 명암 입력은 256px로 읽어 원본의 큰 캔버스를 계속 보유하지 않는다. 일반 편집/원본 내보내기 해상도 규칙은 유지한다.
- 완성 PNG의 메모리 캐시는 24개/32MiB, 별도 IndexedDB(`gongganmiri-design-previews-v1`) 캐시는 100개/64MiB/7일 한도다. 프로젝트/자재/자산 문서에 PNG나 URL을 넣지 않으며 서버 자산 저장소에 업로드하지 않는다.
- 캐시 쓰기는 단일 트랜잭션이며 실패하면 정리와 쓰기를 모두 취소한다. 캐시 오류는 문서 저장 성공 상태를 바꾸지 않는다. 홈 썸네일 조회는 시안 revision과 공통 공간 revision이 일치하는 이미지에만 응답한다.
- 마지막 화면 구독이 끝나면 다음 task에서 참조 수를 다시 확인하고 렌더러·텍스처·디코딩 캐시를 정리한다. 같은 React effect 교체 중 재구독은 기존 디코딩 결과를 유지한다. object URL은 교체/화면 종료 시 해제한다.

## 자동 검증

```sh
npx vitest run tests/design-preview.test.ts tests/design-preview-cache.test.ts
node --experimental-strip-types tests/design-preview-browser.ts
npx tsc --noEmit
npx eslint src/components/designs src/lib/render/design-preview.ts src/lib/render/design-preview-cache.ts src/lib/render/design-comparison-view.ts src/lib/render/compositor.ts tests/design-preview.test.ts tests/design-preview-cache.test.ts tests/design-preview-browser.ts
```

- Vitest **16개 통과**: 단일 직렬 처리, 다섯 작업, 기존 revision의 늦은 완료 무시, 입력 스냅샷 보존, dispose 취소, 재구독 시 캐시 유지, 출력 크기/색감, 사용 자재와 공통 공간 변경의 캐시 무효화, 같은 비율의 배치, 사진 좌표 동기화와 포인터 기준 확대, 캐시 한도/삭제 범위/기한/용량 오류 rollback.
- 전체 TypeScript 검사와 위 소유 파일 ESLint 검사 통과.
- 실제 WebGL 검증 **통과**. 원본 4096×2730, 타일 2048×2048, 동일한 면 1개와 타일 이미지 1개를 공유하고 전체 노출만 다르게 설정한 시안 5개를 사용했다. 생성 이미지는 테스트에서 직접 제작한 단색 자산이다.

| 확인 항목                          | 결과                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| 다섯 시안에 생성한 WebGL 컨텍스트  | 1개                                                                              |
| 첫 비교 준비에서 읽은 이미지       | 배경 2회(1024px/명암256px), 타일 1회(512px)                                      |
| 다섯 시안 가운데 RGB               | `[85,119,93]`, `[92,129,101]`, `[100,140,110]`, `[109,151,119]`, `[118,163,129]` |
| 개별 PNG                           | 4096×2730, 해당 시안 미리보기 RGB와 일치                                         |
| 다섯 시안 비교 PNG                 | 4096×1820, 각 칸이 해당 시안 RGB와 일치                                          |
| 비교의 빈 여섯 번째 칸             | 중립 배경 `[243,244,242]`                                                        |
| 종료 후 이미지/텍스처 캐시 항목 수 | 각각 0                                                                           |
| 브라우저 JS 오류                   | 0                                                                                |

실측 원본은 `test-results/design-preview/webgl.json`이다. Windows 10, Headless Chrome 152, NVIDIA GeForce RTX 4070 Ti / ANGLE Direct3D11 환경에서 다섯 cold preview의 디코딩·준비·PNG 인코딩 완료까지 **449.5ms**였다. 같은 컴퓨터에서 기존 UI 회귀 테스트가 병행 실행되었으므로 고립된 벤치마크 결과가 아니다. 이 값은 입력 조작 FPS 또는 임의의 복잡한 사진 장면의 준비 시간을 나타내지 않는다.

## 화면·사용 흐름 확인

`e2e/designs.spec.ts`의 3개 시나리오가 통과했다. 시안 복사 뒤 타일/제품/견적 독립 수정, 재진입, 개별 PNG, 2·3·4·5개 비교, 동기/개별 탐색, 모바일, 반복 개폐, 시안 개수와 비교 개수 한도를 포함한다. `test-results/designs-browser`의 `compare-2.png`부터 `compare-5.png`, `compare-mobile.png`, `two-designs.png`에 결과가 있다. 데스크톱 5개 배치와 390px 모바일 화면도 이미지로 확인했다.

## 5개 동기 이동 성능 재검증

처음 병행 회귀 실행 중에는 17.89fps/p95 87.5ms로 목표 30fps에 못 미쳤다. 다른 브라우저 테스트·빌드·HMR 작업을 중지하고 동일한 비교 시나리오를 격리 실행했을 때도 수정 전에는 24.67fps였다. 따라서 병행 실행 부하만의 문제로 처리하지 않고 실제 이동 경로를 수정했다.

개선은 이미지의 left/top을 매번 바꾸는 레이아웃 갱신을 제거하고 transform으로만 이동시키는 것, 바뀌지 않은 scene/사용 자재의 직렬화와 NextImage 재렌더를 건너뛰는 것이다. 새로운 PNG 합성 요청이나 픽셀 결과 변경은 추가하지 않았다. 저해상도 atlas와 기존 직렬 큐 규칙도 유지했다.

동일한 `e2e/designs.spec.ts`의 2·3·4·5개 비교 시나리오를 사용했다. 1920×1080, 캐시 이미지 준비 완료 후 5개 동기화 켜기, 확대 125%, 각 프레임에 좌우 이동 키를 번갈아 전달하며 90회의 requestAnimationFrame 타임스탬프를 기록했다. 열기·닫기 3회, 모바일 각 카드 탐색, 동기/개별 좌표·화면 맞춤 검사도 같은 테스트에서 수행한다.

| 조건                                          | 평균 rAF 속도 | 프레임 간격 p95 | 50ms 이상 long task |
| --------------------------------------------- | ------------: | --------------: | ------------------: |
| 수정 전 격리 / Chrome SwiftShader             |      24.67fps |          45.8ms |                   0 |
| 수정 후 격리 / Chrome SwiftShader             |     154.84fps |           8.4ms |                   0 |
| 수정 후 격리 / Chrome RTX 4070 Ti·ANGLE D3D11 |     224.92fps |           8.3ms |                   0 |

각 focused 테스트는 통과했다. 수정 후 실제 GPU는 테스트 종료 시 WebGL debug renderer로 확인했으며 Chrome 버전은 152였다. 하드웨어 환경에서 2/3/4/5개 비교 준비는 각각 377/225/239/247ms였다. 이는 순서대로 비교 선택을 늘리면서 얻은 수치라 일부 자산/PNG 캐시가 준비된 상태를 포함한다.

원본 측정 결과는 아래 디렉터리 내 해당 시나리오의 `comparison-performance.json`으로 보존했다.

- `test-results/design-comparison-isolated-before`: 코드 수정 전 격리 측정
- `test-results/design-comparison-isolated-after`: 코드 수정 후 SwiftShader 측정
- `test-results/design-comparison-hardware-after`: 코드 수정 후 RTX 4070 Ti 측정, 실제 GPU 식별 포함

재현 명령:

```sh
npx playwright test e2e/designs.spec.ts --grep '2·3·4·5개' --output test-results/design-comparison-isolated-after --reporter=line
npx playwright test --config tests/design-hardware.playwright.config.ts e2e/designs.spec.ts --grep '2·3·4·5개' --reporter=line
```

이 속도는 실제 UI의 이미지 좌표를 바꾸는 동안 측정한 rAF 콜백 속도이며 GPU에서 표시가 끝난 프레임 수를 별도 계측한 값은 아니다. 짧은 90프레임 시험이고, 사용된 기본 공간/자재 및 해당 브라우저·컴퓨터 조건의 결과다. 모든 저사양 기기나 복잡한 사용자 장면에서 같은 속도를 보장하지 않는다. 목표 30fps는 이 수정 후 두 격리 조건에서 충족했다.

## 범위와 한계

- 화면 비교는 저장된 동일 카메라/공간의 After 장면을 사용한다. 카드에 편집 핸들이 없으며 PNG도 장면 렌더러 결과만 포함한다. 카드 제목, 버튼, 확대 위치는 내보내기에 포함하지 않는다.
- 서로 다른 조명·자재가 많은 실제 사용자 장면의 픽셀 품질/속도를 이 단색 시험으로 보장하지 않는다. 투명 도기와 복잡한 마스크는 기존 렌더러의 합성 한계를 따른다.
- 모든 렌더링이 메인 스레드에서 순차적으로 실행되므로 매우 큰 첫 자산 디코딩이나 4096px 내보내기 중 입력 지연은 발생할 수 있다. 준비 작업 사이에는 브라우저에 제어를 돌려준다.
- 이 문서는 Supabase/R2 연결, 서버 사용자 격리 또는 외부 파일 업로드 검증을 통과로 표시하지 않는다.

최종 통합 브라우저 재실행(`test-results/designs-final-browser`)은 신규/장애 복구 7개가 모두 통과했다. 이때 비교 준비 2/3/4/5개는 454/288/192/196ms, 수정 시안의 비교 복귀는 440ms였다. GPU probe로 확인한 SwiftShader에서 90프레임 동기 이동은 평균 138.72 rAF/s, p95 12.5ms, long task 0이었다. PNG와 현재 편집 캔버스의 정규화 픽셀 비교 및 모바일 5개 카드의 실제 스크롤 도달도 통과했다.
