# Before 표준 설비 재구성 v2

## 사용법

사진으로 공간을 만든 뒤 **기존 공간 수정 → 초안 보정**을 엽니다. **빠진 기구 추가**에서 유리 파티션·세면대·거울 수납장·벽 선반을 추가하고, 모형을 선택해 오른쪽 속성을 수정합니다. 세면대는 벽걸이·기둥·하부장형 및 볼 형태를 선택할 수 있습니다. 설치 높이는 바닥에서 모형 하단까지의 거리이며 세면대 전체 높이는 수전을 포함합니다. 입력 후 **재구성 설정 적용**으로 한 번에 확정합니다.

미배치 후보는 실패 이유를 보존합니다. 종류를 선택하고 **모형 추가**를 누르면 추가 위치가 추정인지 기본 위치인지 안내합니다. 수납장 분류만 있는 후보를 세면대 하부장으로 확정하지 않습니다. 원본에서 확인되지 않은 치수는 실측값으로 표시하지 않습니다. 벽걸이 세면대 기본 규격은 가로600×깊이450×전체높이320mm(수전 포함), 하단650mm입니다. 계획의 180mm 본체 높이를 수전 포함 전체 상자 높이로 쓰면 납작해지는 문제를 확인해 전체 높이를 구분했습니다.

이전 재구성은 자동 변경되지 않습니다. 선택한 기존 모형의 **표준 모형으로 변환**은 해당 항목만 새 형상으로 바꾸며 실행 취소할 수 있습니다. 원래 자재 버전 ID를 참조로 보존하고 원본 사진도 유지합니다. 일반 제품 사진을 새 모형으로 자동 변환하지 않습니다.

## 원인과 코드

- `reconstruction/analysis.ts`: 세면대를 일괄 바닥 설치로 간주하던 경로를 설치 판단과 배치로 분리했습니다. 바닥에 닿지 않고 하나의 관측 벽에 위치한 세면볼은 벽걸이형으로 추정합니다. 불확실하면 보류하고 근거를 남깁니다.
- `reconstruction/candidates.ts`: 세면볼과 결합하지 못한 수납장을 후보로 유지합니다. 거울 내부 겹침과 분류 근거를 함께 사용해 반사 의심 후보를 보류합니다. 단순 사각형 겹침만으로 앞쪽 설비를 제거하지 않습니다.
- `reconstruction/types.ts`, `lib/types.ts`: 재구성 종류·설치 방식·형태·출처를 추가했습니다. 프로젝트는 v3를 유지하며 재구성 메타데이터만 v2를 지원합니다. 후보 trace는 분석·후보·설치·배치·모형 단계를 구분합니다.
- `reconstruction/index.ts`: 새 거울·창에 원본 사진 crop을 사용하지 않습니다. 기존 v1을 갱신할 때는 기존 방식 유지, 명시 변환 때만 v2로 변경합니다. 내부 모형 자재는 가격 없는 불변 버전입니다.
- `reconstruction/templates.ts`, `projection.ts`, `position.ts`: 표준 모형과 공통 물리 좌표 변환. 벽걸이 설비의 뒤쪽 하단 기준점·깊이 offset, 유리의 하단 높이·yaw, 드래그 역투영을 공유합니다.
- `render/standard-model-render.ts`, `compositor.ts`: 같은 WebGLRenderer의 깊이 있는 RGBA target에서 연속된 v2 모형들을 함께 그립니다. 불투명 설비와 유리를 구분하고 부분 가림의 색/깊이를 일치시킵니다. 선형 색상으로 합성하고 최종 출력에서 한 번만 sRGB로 변환합니다.
- `reconstruction-properties.tsx`, `reconstruction-fixture-controls.tsx`, `reconstruction-review.tsx`: 간단한 설비 목록과 속성, 확인 상태, 변환 버튼. 복잡한 레이어/수동 마스크/다각형 도구는 추가하지 않았습니다.
- `room-editing.ts`, `repositories/references.ts`, `supabase/validation.ts`: 설치 높이·저장·전체 복원·원래 자재 참조·서버 입력 검증. Supabase 프로젝트 문서는 JSONB이므로 테이블/MIME 변경은 필요하지 않습니다. 실제 서버 연결 검증은 미실행입니다.

사진으로 시작한 Before와 빈 After는 같은 방 치수·공통 카메라를 유지합니다. 새 설비는 After의 자재비에 자동 가산되지 않습니다. 장면 문서에 Three.js 객체나 중복 카메라 행렬을 넣지 않으며 기존 RenderSnapshot을 미리보기·PNG/JPG 출력에 사용합니다.

## 실제 사진 기준선

검증 사진은 399×501px입니다. 사진과 원시 응답, 결과 PNG는 ignored `test-results`에만 두고 Git에 추가하지 않았습니다.

기존 분석은 주 세면대 후보를 실제 검출했습니다(semanticPixels3629, meanMargin2.338). 검토 flag가 아닌 바닥 배치가 실패했습니다. 접점을 바닥으로 역투영하면 v=-0.6666으로 허용 범위 밖입니다. 결과에는 변기·욕조·거울만 있었고 거울에 원본 천장 반사가 붙었습니다. 생성23.659초, TFJS WASM 단일 스레드·격리 Chrome/SwiftShader 조건입니다. 프로세스 트리 작업집합 단일 표본1095.3MiB는 최고 메모리나 모델 단독 사용량이 아닙니다.

최종 자동 생성은36.615초였습니다(다른 브라우저 검사와 동시 실행). 직전 동일 형상 실행은25.144초였으며, 경합 조건이 달라 시간 차이를 모형 변경 비용으로 해석하지 않습니다. Headless Chrome152·16논리스레드·TFJS WASM단일스레드·SwiftShader·399×501입력 조건입니다. 메인페이지 JS heap 표본 최고값은17,030,341바이트이며 Worker·WASM·GPU·프로세스 전체 메모리는 제외하므로 모델 메모리 요구량으로 해석할 수 없습니다.

새 자동 결과는 주 세면대가 벽걸이형으로 추가되고 거울은 중립 표면입니다. 유리·거울장·선반의 자동 인식 성공으로 보고하지 않습니다. 설치 벽은 기존 벽 분석 때문에 정면으로 추정되며 원본의 왼쪽 설치를 사용자가 확인해야 합니다. 타일 무늬·줄눈·방 형태도 여전히 추정입니다. 수동 추가/보정한 결과는 자동 결과와 분리합니다.

검증 사진의 항목별 결과:

| 항목 | 실제 자동 결과 | 사용자 보정 후 |
| --- | --- | --- |
| 세면대 | 인식 후보를 벽걸이 표준 모형으로 배치. 설치 벽은 정면으로 잘못 추정 | 왼쪽 벽·사각 볼·하단720mm로 직접 설정 |
| 유리 파티션 | 미검출 | 독립 반투명 모형 추가. 욕조·타일이 뒤로 보임 |
| 거울 수납장 | 일반 거울로 분류, 사진 반사 제거 | 종류를 거울 수납장으로 바꾸고 두께·문 분할 지정 |
| 오른쪽 선반 | 미검출 | 오른쪽 벽 수건 선반으로 추가 |
| 반사 중복 | 거울 겹침·분류 근거로 의심 후보 보류. 일반적인 제거 정확도는 미검증 | 사용자가 후보 목록에서 확인 가능 |
| 공통 구도·빈 After | 유지 | 보정 후에도 같은 치수·카메라, 빈 After 유지 |

수동 비교 이미지에는 기존 추정 변기의 과도한 크기와 위치도 사용자가 보정한 내용을 포함합니다. 사진 한 장에 맞춘 앱 좌표 규칙을 추가하지 않았으며, 테스트의 수동 입력을 AI 출력으로 집계하지 않습니다.

아티팩트:
- `test-results/reconstruction-planning-baseline`: 변경 전 실제 모델 결과·Before·After·분석 영역
- `test-results/reconstruction-improved`: 변경 후 실제 모델 자동 결과, `user-corrected-before.png`는 명시적인 사용자 보정 결과
- `test-results/reconstruction-standard-render`: 독립 렌더 검증과 GPU 측정
- `test-results/reconstruction-qwen-evaluation`: 개발용 Qwen 원시 응답·메모리/시간 표본

## 검증 명령

```powershell
npm test
npm run lint
npm run typecheck
npm run test:reconstruction:quality
npm run test:reconstruction:standard
npx playwright test e2e/reconstruction.spec.ts e2e/reconstruction-standard.spec.ts
npx playwright test e2e/simple-editor.spec.ts e2e/room-fixtures.spec.ts e2e/material-usage.spec.ts e2e/designs.spec.ts
npm run build
npm run build:vinext
```

실제 개인 사진은 `RECONSTRUCTION_PHOTO`, 출력 경로는 `RECONSTRUCTION_OUTPUT` 환경변수로 지정합니다. 원래 Node strip-types 실행기의 extensionless TypeScript import 실패는 `tests/run-browser-test.mjs`의 일시적인 esbuild 번들로 해결했습니다. 테스트가 끝나면 runner를 지우며 저장소 소스나 모델을 변경하지 않습니다.

Qwen은 앱에 연결하지 않은 개발용 CLI입니다. `npm run test:reconstruction:qwen -- --photo "로컬 파일" --pull`을 명시 실행할 때만 모델을 준비합니다. 사용자 브라우저의 모델 다운로드 목록은 늘지 않습니다.

## 남은 한계

단일 사진과 현재 DeepLab의 종류·벽 구분 한계 때문에 유리, 거울장, 선반의 자동 식별과 설치 위치를 보장하지 않습니다. 실제 상품 식별·실측·물리적 시공 가능성도 판정하지 않습니다. Qwen의 별도 실제 비교에서도 거울장 오분류·반사 중복 등이 있어 기본 분석기 교체를 권하지 않습니다. 모델 출력 형식 통과와 올바른 물체 인식은 별도로 평가합니다.

일반 업로드 PNG와 표준 모형의 교차는 원래 합성 순서를 우선합니다. 여러 투명 유리의 교차와 정확한 굴절/거울 반사는 지원하지 않습니다. GPU 측정 결과를 낮은 사양 PC나 실제 UI 전체 FPS의 보장으로 해석하면 안 됩니다. 외부 사진 전송·유료 API·서버 배포·TripoSR/배경 제거 모델 변경은 없습니다.

## 검증 결과 (2026-09-13)

- 정적 검사: 전체 ESLint 및 최종 TypeScript 검사 통과. Next.js16.3.4 프로덕션 빌드 및 vinext1.0.0-beta.9/Cloudflare 빌드 5단계·사전 렌더 통과. vinext에는 기존 punycode/glob 및 향후 Vite native config의 확장자 없는 import 경고가 남아 있으며 빌드 실패는 아닙니다.
- 최종 단위 테스트: 59개 파일, **545개 통과**. 설치 판단·후보 보류·출처·물리 배치·면별 드래그·기존 버전 보존·자산 참조·저장 검증·독립 이력을 포함합니다.
- 재구성 브라우저: 기존7개+신규3개 **10개 시나리오 통과**. 실제 사진 자동→수동 보정, 벽걸이/기둥/하부장 전환, 유리·거울장·선반 설정, 원본/기존 버전 유지, 명시 변환과 undo/재진입, 공통 크기·Before/After·PNG출력을 검사했습니다. 구형 projectedQuad 기대는 v2물리배치 계약으로 갱신했고, Windows의 파일 참조/다운로드 경로 읽기 오류는 업로드 bytes 및 실제 다운로드 stream 검증으로 처리했습니다.
- 기존 편집 브라우저 회귀: 시안 관리/5개 비교/자재비/방 치수/제품 배치/기본 면 삭제 방지 **10개 시나리오 통과**. 최초 실행에서 한 시나리오는 공간 준비 중 기본5초 대기로 종료되어, 준비 대기를30초로 명시하고 단독 재실행하여 가격 수정·최신 가격·단위 변경까지 통과했습니다. 이 초기 시간 초과를 기능 검증 성공으로 집계하지 않았습니다.
- `test:webgl`: 기존 합성11개 검사 통과. 이동 잔상·보호/가림·Before 정렬·PNG비교·4096px출력·출력 실패 후 미리보기 복원을 검사했습니다.
- `test:failure`: WebGL 시작 실패/복구, IndexedDB 용량 오류 후 이전 저장본·작업 유지/재시도/새로고침 복원 통과. 실패는 테스트에서 주입했으며 실제 디스크를 채우지는 않았습니다. 처리되지 않은 페이지 오류는 없으며 콘솔404 한 건은 원시 보고서에 남겼습니다.
- 독립 렌더 재검토: 표준 모형 draw에 한 번 예외를 주입한 뒤 재렌더, `WEBGL_lose_context`로 실제 컨텍스트 손실→복구 후 재렌더 모두 기준 이미지와 픽셀 차이0. 손실 중 렌더 차단도 확인했습니다(`test-results/standard-independent-review/result.json`).
- 실제 모델 추론과 테스트용 인공 후보/실패 주입/수동 설비 추가를 분리했습니다. Qwen평가는3장×2회 실제 실행이며 형식 검증4/6통과는 인식 정확도가 아닙니다. 자세한 결과는 [모델 평가](reconstruction-model-evaluation.md)에 있습니다.

1620×1080, RTX4070Ti/D3D11의 격리Chrome, 캐시 준비된 표준 모형3개에서120프레임 갱신을 측정했습니다. 모형 위치 변경→물리 투영→스냅샷 갱신→렌더→동기 픽셀 읽기를 포함한 중앙값0.9ms,95백분위3ms, 관측238fps였습니다. React와 실제 포인터 이벤트를 제외한 렌더 경로이며 저사양 기기나 앱 전체 FPS를 보장하지 않습니다.

불투명 모형 배열을 뒤집어도 픽셀 차이0, 유리 뒤 배경58,477픽셀 변화와 앞 세면대 내부4,702픽셀 보존을 확인했습니다. 부분 가림은4,375개 내부픽셀에서 기대한 앞/뒤 표면만 나타났고 미리보기와PNG 차이는0입니다. 4회 반복 개폐 후 geometry0·소유WebGL컨텍스트해제를 확인했습니다. Three.js 내부 texture계수1이 남는 것은 별도 기록했으며 애플리케이션 GPU 자원이 전부0이라고 주장하지 않습니다.

실제 Supabase 연결/RLS격리/배포, 약한GPU·CPU전용Qwen·모바일메모리 측정은 미실행입니다.

### 비교 이미지

- [변경 전 자동 Before](../test-results/reconstruction-planning-baseline/before.png)
- [변경 후 자동 Before](../test-results/reconstruction-improved/before.png)
- [사용자가 종류·위치·규격을 수정한 Before](../test-results/reconstruction-improved/user-corrected-before.png)
- [빈 After](../test-results/reconstruction-improved/after.png)
- [설비 보정 UI](../test-results/reconstruction-improved/user-corrected-ui.png)

위 파일은 개인 검증 자료이므로 로컬에만 존재하며 Git/배포에 포함되지 않습니다.


열린 변기와 기둥형 세면대의 추가 회귀, 전체 세면대 기본 규격 적용, 타일 줄눈·엇갈림 보완은 [후속 검증 보고서](reconstruction-open-toilet.md)에 기록했다.
