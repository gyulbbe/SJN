# Before/After 90° 공간 둘러보기 결과 · 2026-09-14

## 사용법과 구현 범위

편집기 상단 Before/After 도구 옆의 **공간 둘러보기**를 누른다. 현재 편집을 확정한 뒤 읽기 전용 보기 창이 열린다. 제품·벽·바닥의 배치나 수량은 이 창에서 수정하지 않는다.

- 왼쪽·오른쪽·위·아래 버튼은 현재 화면 축을 기준으로 정확히 90°씩 이동한다. 같은 버튼 네 번 또는 반대 버튼으로 원위치에 돌아온다. 위/아래를 반복하면 뒤집힌 방향도 볼 수 있다.
- 보기 영역에 포커스가 있을 때만 방향키가 동작한다. 드래그는 이동, 휠·핀치는 확대/축소다. 터치에는 같은 방향 버튼을 사용한다.
- **화면 맞춤**은 방향을 유지하며 확대·이동만 초기화한다. **기본 시점**은 모두 초기화한다.
- Before·After·겹쳐 비교·나란히 비교가 같은 카메라를 사용한다. 시안을 바꿔도 방향은 유지된다.
- 마지막 시점은 쓰기 탭에서 기존 500ms 자동 저장으로 보관된다. 읽기 전용 탭은 창 안에서만 둘러본다.
- 다운로드는 현재 시점의 After 또는 Before/After를 PNG/JPG로 만든다. 전체 긴 변은 원본/GPU/4096px 중 작은 한도다. 화면 도구와 안내 문구는 파일에 들어가지 않는다.

**이 구현은 방의 3D 좌표를 다시 렌더링한다. 기존 사진을 CSS 회전하거나 AI로 새 각도를 생성하는 기능이 아니다.** 기존 정면 편집기·수량 패널·제품 360° 자재 편집은 유지한다.

## 조사한 원인과 변경

기존 `createRoomCamera`, 타일 quad·사진 마스크, 제품 PNG·표준 모델 compositor는 정면 편집을 위한 경로였다. 카메라만 돌리면 타일과 PNG가 기존 사진 좌표에 남고, 90°에서 퇴화한 quad가 생긴다. 표준 모델 사이에 PNG가 있으면 렌더 묶음별 깊이도 분리된다.

새 보기에는 전용 세계 좌표 렌더 경로를 두었다. 기존 `room-geometry.ts`, `render/compositor.ts`, `standard-model-render.ts`, 재구성 모형과 원래 카메라 함수는 변경하지 않았다.

| 파일 | 역할 |
|---|---|
| `src/components/rooms/room-viewer.tsx`, `.module.css` | 보기 창, 조작·모바일·포커스, 준비/오류/저장 상태, 출력 |
| `src/components/editor/editor.tsx` | 진입 버튼, 진행 중 편집 확정, 자동 저장 연결, 보기 중 기존 단축키 차단 |
| `src/lib/room-viewer/view-state.ts` | 정규화 quaternion, 90° 회전, 공통 카메라·화면 맞춤 |
| `src/lib/room-viewer/renderer.ts` | 한 WebGL context, 두 장면의 공통 카메라·깊이, 색감·캐시·출력·해제 |
| `src/lib/room-viewer/lighting.ts` | Three 0.185.1 PBR 조회 텍스처의 보기별 수명 격리 |
| `src/lib/room-viewer/surfaces.ts` | mm 단위 벽·바닥·밴드·타일·줄눈·seed, 가까운 외피 생략 |
| `src/lib/room-viewer/fixtures.ts` | 표준 모형·저장 메시·방향 PNG·단일 PNG, 오류와 제한 |
| `src/lib/types.ts`, `comparison.ts`, `editor-store.ts` | 프로젝트 공통 `roomView`, 저장·복제·방 크기 전체 복원과 기존 자료 호환 |
| `src/lib/supabase/validation.ts` | 선택적 보기 상태의 구조·유한값·범위 검증 |

기본 정면에서 좌표축은 다음과 같다. 이후에는 현재 화면의 오른쪽/위쪽 축으로 동일한 규칙을 적용한다.

| 입력 | 카메라가 위치하는 쪽 | 중심 |
|---|---|---|
| 기본 | +Z, 정면 | 방의 가운데 |
| 오른쪽 | +X | 동일 |
| 왼쪽 | −X | 동일 |
| 위 | +Y | 동일 |
| 아래 | −Y | 동일 |

회전마다 원본 설비에 `projectReconstructionFixture`를 다시 적용하지 않는다. 한 카메라의 quaternion·position·up·FOV·near/far·aspect·pan/zoom과 공통 콘텐츠 범위를 두 장면에 사용한다. 방에서 과도하게 벗어난 설비는 화면 맞춤 범위를 무한히 늘리지 않고 안내한다.

타일 UV는 실제 면의 mm 좌표에 고정된다. 카메라가 바뀌어도 규격·줄눈·반장 배열·시작점·회전·무늬 seed는 움직이지 않는다. 겹치는 밴드는 두 겹으로 덮지 않고 명확한 구간만 나눈다. 가까운 벽과 바닥은 보기에 한해 생략한다. 벽 부착 설비는 그대로 남고 앞벽·천장·견적 항목은 추가하지 않는다.

실제 브라우저 검사 중 다음 오류도 찾아 수정했다.

1. 캐시에 있는 시안으로 돌아올 때 React가 준비 `false→true`를 한 번에 묶어 이전 그림이 남았다. 준비된 스냅샷의 렌더러·장면 키를 추적하고 준비 완료마다 프레임을 다시 그린다. 다른 장면을 준비 중이면 출력도 막는다.
2. WebGL 연결이 유휴 상태에서 끊기면 다음 클릭까지 실패가 보이지 않았다. 캔버스 이벤트를 받아 즉시 안내하고 새 렌더러로 재시도한다.
3. 저장 재시도가 성공해도 편집기의 과거 저장 오류가 남았다. 해당 저장 오류만 성공 후 해제하고 다른 오류는 보존한다.
4. Three 0.185.1의 전역 DFG LUT 텍스처가 닫힌 WebGLRenderer의 dispose 리스너를 보유했다. 보기 창별 텍스처 복사본으로 수명을 분리하고 닫을 때 해제했다. 전역 텍스처·다른 편집기·node_modules는 변경하지 않는다. 설치 버전의 `dfgLUT` uniform 계약과 공개 `onBeforeCompile`, `Texture.clone/dispose` API를 이용한다. 의존성 업그레이드 때 이 계약과 수명 테스트를 재확인해야 한다. [상세 조사·출처](room-viewer-renderer-contract-20260914.md)

## 지원 범위와 한계

| 자료 | 새 보기의 표현 |
|---|---|
| 재구성 표준 설비 | 실제 저장된 mm 위치·벽·설치 높이·자세·지지 관계의 기존 3D 모형 |
| 유효한 저장 `product3d` | 저장 메시와 선택 PNG에 연결된 자세 사용. 모델 재다운로드·AI 추론 없음 |
| 방향별 PNG | 명시된 방향 메타데이터가 대응할 때만 그 사진 사용. 임의 이름에서 방향 추측하지 않음 |
| 단일 PNG | 설치 기준의 평면. 옆에서 얇아지거나 보이지 않으며, 뒷면을 복원하지 않음 |
| `roomPlacement`가 없는 제품 | 임의 깊이를 만들지 않고 항목과 이유 안내 |
| 공간 치수가 없는 과거 사진 편집 | 새 각도 보기 미지원 안내 후 기존 정면 편집으로 복귀 가능 |
| 사진 마스크·수동 복원·사진 명암/그림자 | 새 방향에 그대로 붙이지 않음. 기존 정면 편집 데이터는 유지 |
| 누락 자산·손상 메시 | 해당 항목 오류를 표시하고 나머지 공간은 표시. 원본/불변 버전은 수정하지 않음 |

유리는 독립 반투명 모형이고 원사진을 불투명하게 붙이지 않는다. 중립 거울을 유지한다. 새 보기의 조명과 그림자는 방 좌표에 고정한다. 기존 사진의 빛을 정밀 복원한 결과는 아니다. 유리의 정밀 굴절·실시간 거울 반사·포토리얼 렌더링은 범위 밖이다.

새 보기에서 사용하는 메시의 깊이는 저장 형상의 비율에 따른다. 선택한 PNG의 폭·높이·기준점에 맞추며, 제품의 보이지 않는 형상 정확도를 보증하지 않는다. 기존 TripoSR 변기의 회색 색감·부수 형상도 원래 메시의 한계로 기록했다.

## 비교 이미지와 실제 자료의 구분

[여섯 방향 비교 갤러리](../test-results/room-viewer-20260914/comparison.html)

`real-data-run03`에는 기존 네 욕실의 사용자 보정 설비(각 6/3/4/4개)를 읽어 만든 정면·오른쪽·뒤·왼쪽·위·아래 비교와 출력 PNG를 보관했다. **배치는 기존 저장 자료이고, 타일과 After 변경은 기능 검사 목적으로 직접 만든 테스트 조합**이다. 새 AI 인식 성공 또는 원사진 재현 정확도로 보고하지 않는다.

첫 번째 After에는 과거에 저장한 실제 TripoSR 메시(55,956정점)와 단일 PNG도 배치했다. 원래 메시 배열·PNG·보고서는 읽기만 했다. 유효한 등록 상태를 재현하기 위해 기존 메시를 현재 기본 자세로 다시 캡처하여 PNG/pose/alpha 경계/기준점을 맞췄으며 AI는 실행하지 않았다. 처음 검사에서 서로 다른 제품의 기준점을 복사했던 테스트 데이터 오류는 run02에서 수정했고 최종 조명 수명 수정 뒤 run03으로 다시 검증했다. run01·run02는 진단 자료로 남겼다.

- [정면 비교](../test-results/room-viewer-20260914/real-data-run03/user-01-front.png)
- [오른쪽 비교](../test-results/room-viewer-20260914/real-data-run03/user-01-right.png)
- [뒤쪽 비교](../test-results/room-viewer-20260914/real-data-run03/user-01-back.png)
- [왼쪽 비교](../test-results/room-viewer-20260914/real-data-run03/user-01-left.png)
- [위쪽 비교](../test-results/room-viewer-20260914/real-data-run03/user-01-top.png)
- [아래쪽 비교](../test-results/room-viewer-20260914/real-data-run03/user-01-bottom.png)

## 저장과 원본 보존

`roomView`는 프로젝트 공통 보기 정보다. 회전·확대·이동은 시안/장면 revision, 실행 취소 기록, 제품 수량·금액, 원본 자산 참조를 변경하지 않는다. 실제 저장 시 충돌 검사용 storage revision만 기존 규칙대로 증가한다. 늦은 이전 저장 응답이 현재 시점의 미저장 상태를 덮지 않는다.

시안 복사·전환에는 공통 시점을 유지한다. 프로젝트 복제도 보기 값을 함께 복제한다. 방 크기 변경은 방향을 유지한 채 새 치수로 카메라를 계산하고, 크기 변경 직전 전체 복원/다시 실행에는 당시 보기도 복원한다. 옛 복원본에 값이 없으면 기본 시점이다. 과거 문서는 읽을 때 메모리에서만 보정하며 읽기만으로 저장하지 않는다.

작업 시작 시 538개 파일의 SHA-256과 git 상태를 기록했다. 최종 보존 검사와 변경 목록은 `test-results/room-viewer-20260914/preservation.json`에 남긴다. 기존 변경사항을 초기화하거나 원본 사진·메시·불변 자재를 덮어쓰지 않았다. 브라우저 검증은 별도 Playwright 저장소/새 테스트 프로젝트에서 실행했다. 패키지·잠금 파일과 외부 연결 설정도 유지한다.

## 검증 결과

최종 생산 코드에서 다음을 실행했다. 명령 로그·원시 JSON은 `test-results/room-viewer-20260914/`에 보관한다.

| 검사 | 결과 | 증거 |
|---|---|---|
| `npm test -- --reporter=dot` | 114파일, **1,453개 통과**, exit 0 | `final-post-lut-vitest.log` |
| `npm run lint` | 경고·오류 없이 exit 0 | `final-post-lut-lint.log` |
| `npm run typecheck` | Next route typegen + TypeScript exit 0 | `final-typecheck.log` |
| `npm run build` | Next.js 16.3.4 exit 0 | `final-next-build.log` |
| `npm run build:vinext` | vinext 1.0.0-beta.9 / Vite 8.2.2 exit 0 | `final-vinext-build.log` |
| 새 편집기 E2E | **5개 통과**, exit 0 | `e2e-run-05/summary.json` |
| 기존 편집·시안·금액·정면 출력 E2E | **22개 통과**, exit 0 (최종 조명 수명 수정 뒤 재실행) | `regression-run-02/summary.json` |
| 독립 WebGL | **19항목 통과** | `renderer/post-lut/verification.json` |
| 실제 저장 자료의 브라우저 렌더 | **4공간×6방향**, 저장 메시 로드·출력·원본 불변 검사 통과 | `real-data-run03/verification.json` |
| 조명 수명 수정 전/후 | **29/29 PNG 픽셀·파일 바이트 동일** | `real-data-run03/lighting-pixel-comparison.json` |
| 반복 수명 검사 | **10회**, 해제된 렌더러가 남지 않음 | `resource-cycles/post-lut/verification.json` |
| 비교 갤러리 | 24 이미지, 390px 가로 넘침 없음 | `gallery-verification.json` |

새 단위 테스트 65개는 회전·카메라·저장 26, 설비 24, 면·타일 9, 조명 수명 6개다. 저장 어댑터 단위 검사의 IndexedDB는 `fake-indexeddb`이며, 실제 브라우저 IndexedDB 저장/새로고침/다중 탭/주입한 quota 실패 복구는 E2E에서 따로 확인했다.

새 E2E에는 네 방향 각 네 번, 혼합 조작, 슬라이더/두 패널 정렬, 50회 전환·10회 개폐, PNG/JPG, 보기만 저장한 뒤 장면 revision 불변, 모바일·키보드, 읽기 전용 탭, 실제 WebGL context loss·재시도, 저장 실패·복구, 시안 복사/재선택, 실제 사용자 보정 Before 6설비·빈 After·저장 재진입이 들어 있다. 그림은 직접 시각 검사했다. 자동 테스트의 잘못된 높이 반올림 기대값·불필요하게 엄격한 리샘플링 허용값과 실제 발견한 생산 오류는 구분했으며, 이전 실패 폴더를 남겼다.

실행 명령 예시(PowerShell):

```powershell
$env:SJN_VIEWER_REAL_REPORT='1'
npx playwright test e2e/room-viewer.spec.ts --output test-results/room-viewer-new-e2e --reporter line
node tests/run-browser-test.mjs tests/room-viewer-render-browser.ts
$env:SJN_VIEWER_REAL_OUTPUT='test-results/room-viewer-new-real-data'
node tests/run-browser-test.mjs tests/room-viewer-real-data-browser.ts
node tests/run-browser-test.mjs tests/room-viewer-resource-browser.ts
```

전체 기존 회귀 명령과 AI 경로 제외 목록은 `regression-run-02/summary.json`에 있다. 새 AI 실행·모델 다운로드를 수반하는 분석 시나리오는 이번 보기 기능의 검증 대상으로 실행하지 않았다. 이들을 통과 수에 포함하지 않는다.

Next 개발 서버를 종료한 상태에서 타입 검사 → Next 빌드 → vinext 빌드를 순서대로 실행했다. vinext에서는 기존 설정의 확장자 없는 import에 대한 향후 `configLoader: native` 호환 안내와 Node의 `punycode` deprecation/실험적 glob 안내가 나왔으며 빌드는 성공했다. 이를 숨기거나 경고를 끄는 설정은 추가하지 않았다.

## 성능·자원 측정

Windows 11 계열(10.0.26200), Ryzen 7 7800X3D 8코어/16스레드, 물리 메모리 약 31.15GiB, Node 22.13.1. Chrome 152 headless의 **ANGLE SwiftShader 소프트웨어 렌더링**으로 측정했다. 실제 사용자 GPU의 FPS 측정이 아니며, 자동 검증 실행 중의 관측값이라 다른 작업과 브라우저 초기화 영향이 있다.

- 편집기 기본 2400×2400×2400mm, 네 타일 면, 1440×1000 브라우저: 최초 열기 265.5ms. 준비 후 50회 클릭→렌더 호출 후 프레임 상태 관측의 중앙값 **116.6ms**, p95 **162.8ms**, 최대 **171.7ms**. Playwright 클릭/폴링 오버헤드를 포함하며 실제 화면 표시 완료 시각이나 GPU 단독 시간은 아니다.
- 표준 설비 Before 5개 / After 5개+단일 PNG, 900×600 비교: 준비 36.6–97.4ms, 새 context의 첫 프레임 353.7–576.7ms. 렌더 뒤 `readPixels`로 GPU 작업 완료를 기다린 캐시 준비 후 50개 전환은 중앙값 **91.9ms**, p95 **106.2ms**. 순간 전환 방식으로 애니메이션 FPS를 만들지 않았다.
- 실제 기존 자료 네 건: 준비 220.4/21.2/13.2/44.0ms. 첫 사례에는 실제 55,956정점 메시와 PNG 로딩이 추가돼 다른 세 건과 작업량이 다르다. 사진 분석 시간은 아니다.
- 50회 회전 중 메시·타일 준비 횟수와 자산 읽기 수가 늘지 않았다. 브라우저 테스트의 AI/모델/이미지 업로드 요청은 0이다.
- 10회 완전 종료 후 CDP가 관측한 `RoomViewerRenderer`, `WebGLRenderer` 인스턴스는 매회 **0**. 보기 소유 장면·타일·제품·LUT 캐시는 모두 0이다. 검사에 남아 있는 전역 기하/텍스처 객체 수는 일정했다.
- GC 후 메인 페이지 JS heap은 첫 회 3,472,872바이트에서 열 번째 4,040,888바이트였다. 워밍업 후 약 0.57MB 늘었으므로 전체 heap이 완전히 일정하거나 모든 메모리 누수가 없다고 보고하지 않는다. 이번에 확인한 회차당 renderer 1개 누적은 제거했다. 전체 RAM/VRAM, 최대 메모리, 실제 저사양 기기의 안정성은 측정하지 않았다.

조명 수명 변경은 실제 자료의 29개 PNG를 전수 비교하여 색·그림자·가림·저장 메시가 바뀌지 않았음을 확인했다. Three.js `renderer.info`의 context 해제 후 카운터는 과거 값을 남길 수 있어 살아 있는 VRAM으로 해석하지 않는다.

## 요구사항별 완료 점검

| 프롬프트 항목 | 구현/검증 근거 |
|---|---|
| 1. 조사·보존 | 시작 manifest, 기존 5개 파일의 제한된 연결 변경, 새 전용 모듈, 원본 해시 |
| 2. 정확한 조작·모바일 | 회전 수학 단위, 4방향·혼합 입력·포커스·390px 터치 E2E |
| 3. 공통 비교 | 같은 카메라/합친 콘텐츠 범위, B/A 픽셀·슬라이더·시안 재전환 검증 |
| 4. 공통 공간 렌더 | mm 면/UV, 밴드 분리, 공통 깊이·투명도·고정 조명·외피 생략, 여섯 방향 이미지 |
| 5. 자료별 지원 | 표준/실제 저장 메시/방향 PNG/단일 PNG/손상·누락·위치 없는 분기 검사, 제한 UI |
| 6. 저장·캐시·비동기 | view-only 저장/충돌/전체 복원, 늦은 응답·시안 캐시 복귀·닫기·자원 검사 |
| 7. 출력 | 현재 시점 복사 후 PNG/JPG 인코딩, 원본/GPU/4096 제한, 출력 중 회전 격리, UI 제외 |
| 8. 실제 검사·빌드 | 아래 명령/종료 결과와 독립 결과 폴더. 중간 실패는 숨기지 않고 수정 후 별도 실행 |
| 9. 인계 | 이 문서, 비교 갤러리, 원시 JSON·스크린샷·로그 |

## 미실행·남은 제한

- 실제 Supabase 연결·서버 RLS·배포는 실행하지 않았다. 로컬 모드와 서버 입력 스키마만 검증했다.
- 새 AI 모델·사진 업로드·추론을 실행하지 않았다. 인식/복원 품질 개선으로 보고하지 않는다.
- 실제 저사양 PC, 모바일 Safari/Firefox, 실제 모바일 GPU에서 성능을 측정하지 않았다. 390px 검사는 데스크톱 Chrome의 터치 에뮬레이션이다.
- JS heap·소유 자원 진단은 사용자 PC의 전체 RAM/VRAM 사용량이 아니다. 수치와 측정 조건을 분리했다.
- 단일 PNG의 보이지 않는 뒷면, 옛 사진 마스크의 깊이, 정밀 거울 반사는 새로 만들어내지 않는다.
