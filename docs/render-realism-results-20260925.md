# 렌더러 조명·재질 사실감 개선 결과 · 2026-09-25

[작업 프롬프트](prompts/render-realism-lighting-materials.md)의 1단계(AI 없이 렌더러만)를 구현한 결과다. 타일 색·무늬·크기·줄눈·배치, 제품 위치·크기, 견적은 바꾸지 않았다. 빛·그림자·광택·입체감만 바꿨다.

## 적용 범위

| 경로 | 쓰이는 곳 | 바뀐 것 |
| --- | --- | --- |
| 3D `RoomViewerRenderer` | 공간 둘러보기, 벽 구조가 있는 프로젝트의 편집·내보내기·시안 카드 | 천장 조명·환경맵·톤 매핑, 마감별 광택, 줄눈 입체, 구석·접지 그림자 |
| 2D `PhotoCompositor` | 벽 구조 없는 기본 방·사진 프로젝트의 편집·내보내기·FLUX 입력·시안 미리보기 | 줄눈 입체, 유광 하이라이트, 표준 설비 모형의 조명·톤 매핑 |
| `room-background.ts` | 새 기본 방·크기 변경·재구성 비교 배경을 만들 때만 | 구석 그림자를 배경에 굽는다. 저장된 배경 PNG는 바꾸지 않는다 |

## 구현

1. **조명과 톤 매핑** ([realistic-lighting](../src/lib/render/realistic-lighting.ts))
   - 바깥 햇빛 방향광과 환경광 1.6을 없앴다.
   - 대신 천장 중앙 SpotLight 하나를 둔다. 90° 원뿔에 완전 penumbra를 줘서 평판 등처럼 cos 감쇠하고, PCF 그림자 radius는 5다.
   - 렌더러마다 절차적 욕실 환경맵(PMREM)을 하나씩 만든다. 열린 앞면이 밝아 사진가 뒤쪽 빛처럼 뒷벽을 채운다.
   - 빛은 중립 흰색이다. 난색이 타일 색을 바꾸기 때문이다.
   - 반정밀도 색 타깃이 없으면 같은 밝기의 HemisphereLight로 대체한다.
   - 렌더 타깃에 그리므로 `renderer.toneMapping`은 적용되지 않는다. 그래서 조명 받는 재질 안에서 Khronos PBR Neutral을 적용하고, '원본 색' 제품과 사진 평면은 제외한다.
   - 2D 표준 설비 모형은 앞·위 키 라이트와 반구광을 쓴다.
2. **마감별 광택** ([finish](../src/lib/render/finish.ts), `tests/finish-appearance.test.ts`)
   - 매핑: 크롬·브러시드는 금속, 폴리싱 0.12, 유광 0.24, 반광 0.45, 무광·엠보는 0.83이다. 빈 값이나 모르는 값은 기존과 같은 0.83이다.
   - 3D: 줄눈은 항상 거칠고 비금속이다. 타일 반사는 0.6배로 줄여 어두운 유광 타일이 회색으로 씻기지 않게 했다.
   - 2D: `gloss × shading × 밝은 부분`으로 은은한 하이라이트를 더한다. 무광이거나 `shading` 0이면 0이다.
3. **줄눈과 모서리 입체**
   - 줄눈 안쪽은 12% 어둡게 한다.
   - 타일 모서리는 0.6~2.5mm 경사로 표현한다. 3D는 화면 미분 탄젠트 프레임으로 법선을 기울이고, 2D는 위쪽 빛 기준 밝기 변화로 표현한다.
   - `groutWidth` 0이면 효과가 없다. 경사가 픽셀보다 작아지면 사라지므로 미리보기 크기에서는 줄눈만 보이고 내보내기 크기에서 모서리가 보인다.
4. **구석·접지 그림자**
   - 방이 직육면체이므로 벽·바닥·천장까지의 mm 거리로 간접광을 줄인다. 반경 260mm, 강도 0.45, 천장 0.25다.
   - 바닥에 서 있는 설비는 최대 8개의 바닥 발자국 주변에 접지 그림자를 준다.
   - 화면 공간 AO가 아니므로 노이즈가 없고 결정적이다. 벽 구조 안쪽(방 밖)에는 적용하지 않는다.
   - 새 배경은 같은 식을 0.65배로 굽는다.

## 측정

조건: Chrome headless, ANGLE SwiftShader(소프트웨어 렌더링), 단색 타일, 2400mm 정육면체 방, 배경 3600×2400. 실행 도구는 [render-realism-browser](../tests/render-realism-browser.ts)다. 기준선은 main(ae5edbf)을 별도 작업 트리에서 같은 스크립트로 캡처했다.

### 색 정확도 ΔE2000 (벽·바닥 중앙 중간값과 타일 색 비교)

| 장면 · 영역 | 기준선 | 개선 후 |
| --- | --- | --- |
| 무광 · 3D 뒷벽 | 0.65 | 0.43 |
| 무광 · 3D 바닥 | 4.01 | 0.65 |
| 유광 · 3D 뒷벽 | 2.32 | 0.81 |
| 유광 · 3D 바닥 | 4.21 | 0.98 |
| 무광 · 2D 뒷벽 | 0.21 | 0.43 |
| 무광 · 2D 바닥 | 0 | 0 |
| 유광 · 2D 뒷벽 | 0 | 1.03 |
| 유광 · 2D 바닥 | 0 | 0.24 |

- 3D는 네 영역 모두 기준선보다 가깝다.
- 2D는 세 영역이 0.2~1.0 올랐다. 새 배경의 구석 그림자가 밝기 기준값을 바꾸고, 유광 하이라이트가 더해졌기 때문이다. 모두 ΔE2000 2 미만(나란히 봐도 구분하기 어려운 수준)이다.
- 기존에 저장된 배경은 바뀌지 않으므로, 기존 2D 프로젝트는 줄눈·광택 변화만 받는다.

### 시간 (900×600, SwiftShader, 한 픽셀 읽기로 GPU 완료 대기)

main과 번갈아 두 번씩 잰 값이다. 소프트웨어 렌더링이라 편차가 크다.

| 장면 | 준비(생성+장면) main → 개선 | 3D 한 장면 렌더 main → 개선 |
| --- | --- | --- |
| 무광 | 22–35ms → 96–122ms | 91–103ms → 87–241ms |
| 설비 | 47–138ms → 312–314ms | 93–185ms → 449–456ms |

- 환경맵을 끈 비교 실행에서 설비 장면은 준비 88ms, 렌더 310ms였다. 환경맵이 준비 약 225ms, 렌더 약 140ms를 더한다.
- 환경맵은 부드러운 반사광과 유광·도기·크롬 반사의 근거라 유지했다.
- 실제 GPU·모바일 기기의 시간은 **미확인**이다. SwiftShader 수치를 실제 기기 성능으로 해석하지 않는다. 느린 기기가 확인되면 소프트웨어 렌더러에서 환경맵을 끄는 품질 단계를 둘 수 있다(`createInteriorEnvironment`가 undefined를 반환하면 반구광으로 대체된다).
- 2D 합성 시간은 두 쪽 모두 150–1000ms로 흔들려 차이를 판단할 수 없었다. 셰이더 추가 연산은 몇 줄이다.

### 비교 이미지 (로컬 전용, `test-results/`는 커밋하지 않음)

`test-results/render-realism/compare/<장면>-<보기>.png`에 기준선과 개선 후를 나란히 붙였다.
- 장면: `matte`, `glossy`, `mosaic`, `fixtures`, `features`
- 보기: `viewer-front`, `viewer-right`, `compositor`, `viewer-detail`, `compositor-detail`
- 원본 캡처와 `metrics.json`은 `baseline/`, `final/`에 있다.

## 캐시 키와 부작용

- `ROOM_VIEWER_RENDERER_REVISION`을 `room-view-v5-realistic-lighting`으로 올려 3D 시안 카드 캐시를 새로 만든다.
  - 부작용: 저장된 프로젝트 요약의 `designPreviewRendererRevision`이 맞지 않게 된다. 프로젝트가 다시 저장될 때까지 목록 조회 때 프로젝트마다 R2 문서를 한 번씩 읽는다(`src/lib/d1/projects.ts` list). R2 읽기는 100만 회당 $0.36이다.
- `DESIGN_RENDER_REVISION`은 1 → 2로 올렸다. 2D 시안 미리보기(IndexedDB) 캐시를 새로 만든다.
- `TEMPLATE_RENDERER_REVISION`은 템플릿 형상이 그대로라 유지했다.

## 검증

- **단위**: `tests/finish-appearance.test.ts` 4개 통과. 전체 vitest는 3,183개 통과, 7개 실패였고 모두 렌더링과 무관하다.
  - 시간 초과·포트 충돌: storage-server, d1-reconstruction-diagnostics, d1-auth, tile-courses. storage-server는 main에서도 같은 실패를 확인했다.
  - 이 작업 트리에 없는 `test-results` 기록 파일: reconstruction-source-plane-mapping, reconstruction-corpus.
- **WebGL 7종 통과**: `render-browser`, `comparison-render-browser`, `room-viewer-render-browser`(4회 회전 픽셀 복귀, 분할 정렬, 비교 카드 채널당 1 이하), `room-viewer-resource-browser`(10회 개폐 후 렌더러 인스턴스 0), `shading-browser`, `restore-coverage-browser`(사진 밖 변경 픽셀 0), `room-wall-features-browser`.
- **E2E**(room-viewer, base-room, fixture-tiling, room-fixtures, simple-editor, 14개): 통과 9개, 건너뜀 1개, 실패 4개.
  - 통과 9개 중 3개는 첫 실행에서 실패했다가 재실행에서 통과했다.
  - 건너뜀: 실제 user01 저장 자료가 없어 건너뛴 `room-viewer:503`.
  - 기존 문제 2개: `base-room:302` 390px·320px는 09-18 모바일 '더보기' 메뉴 이동 뒤 '공간 크기' 버튼을 찾지 못하는 문제다. 테스트는 09-17 이후 수정되지 않았고, 이번 변경은 UI 컴포넌트를 건드리지 않는다.
  - 환경 문제 2개: `fixture-tiling:152`, `simple-editor:175`는 로컬 D1/R2 연결이 `EADDRINUSE`로 실패했거나, 화면에 "서버 저장에 실패했어요"가 떴다. 측정 시점에 TCP `TIME_WAIT` 연결이 20,288개로, 동적 포트 13,977개보다 많아 포트가 고갈된 상태였다.
- **정적 검사**: `npm run typecheck` 통과, 변경 파일 ESLint 통과, Prettier(`--end-of-line auto`) 통과.
- 실제 Cloudflare AI 호출과 배포는 하지 않았다.

## 한계와 다음 후보

- 실제 GPU·모바일 성능은 미확인이다.
- 사진 기반 실제 프로젝트는 로컬 자료가 없어 캡처하지 않았다. 2D 사진 픽셀 보존은 `restore-coverage-browser`로 확인했다.
- 2D 표준 설비 모형에는 접지 그림자가 없다. 사용자가 조절하는 기존 2D 그림자만 쓴다.
- 환경맵은 실제 방이 아니라 일반적인 욕실이라, 유광 타일에 비친 모습이 실제 벽 타일과 다르다. 필요하면 장면별 CubeCamera 캡처를 검토한다.
- 다음 단계 후보: AI 결과에서 조명만 가져오기, 내보내기 전용 경로 추적.
