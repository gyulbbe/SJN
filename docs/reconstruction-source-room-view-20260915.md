# 공통 사진 시점 opt-in 구현 및 검증 (2026-09-15)

기존 기본 공간 보기/정면 편집은 유지한다. 새 추정 결과를 명시적으로 채택한 경우에만 사진 시점 정보를 저장하고 공간 둘러보기 및 같은 렌더의 PNG에 사용한다. 사진 시점은 추정값이며 실측 또는 인식 성공을 의미하지 않는다.

## 상태와 좌표

- `sourceRoomView(SourceCamera, room)`로 `RoomViewState.sourceCamera`에 mm 위치, 정규화 quaternion, 수직 FOV, 원본 width/height, 기준 공간 치수, estimated/user 출처를 저장한다. 기존 state 구조(version=1, quaternion, zoom, pan)는 그대로 읽으며 새 필드는 선택적이다.
- 카메라와 방 좌표는 동일하다: x 중심, y=0 바닥, z=0 뒤 벽, z=depth 앞쪽. 기본 사진 보기에서 SourceCamera의 정확한 위치/회전/화각을 사용한다. 기존 기본 카메라 또는 전체 공간 fit 거리로 다시 계산하지 않는다.
- 사진 보기 quaternion은 원본 카메라에 대한 추가 회전이다. q=qSource×qDelta, 카메라 위치는 방 중심을 기준으로 q×inverse(qSource)만큼 회전한다. 기본 qDelta에서 불필요한 연산을 건너뛰어 원본 투영을 보존한다.
- 이동은 원본 이미지 좌표의 principal-point offset이다. 깊이에 따라 시차가 생기지 않으며 기존 드래그 방향을 유지한다. 확대는 카메라 zoom이다.
- 화면 크기가 바뀌어도 원본 이미지 비율을 유지한다. 각 Before/After 패널 안에 같은 크기의 letterbox viewport를 만들고 같은 카메라를 공유한다. 바깥 여백에는 자재 색감 보정을 적용하지 않는다.

## 사용자 동작과 저장

- `사진 시점 보기` / `전체 공간 보기` 버튼으로 명시적으로 전환한다. 전체 공간 보기는 기존 camera-fit 경로다. 전환/기본 시점 초기화 후에도 원본 사진 카메라 메타데이터는 유지한다.
- 90도 회전·이동·확대·화면 맞춤·키보드 동작은 장면과 견적을 수정하지 않으며 장면 revision/history를 증가시키지 않는다. 기존 자동 저장 및 storage revision 조건부 쓰기 경로를 사용한다.
- 공간 치수가 바뀌면 이전 사진 카메라를 재조정한 것처럼 사용하지 않는다. referenceRoom과 사진 카메라를 보존하면서 전체 공간 보기로 전환한다. 크기 변경 직전 전체 복원/다시 실행에서 해당 checkpoint의 정확한 카메라도 복원한다. 열린 보기 창도 외부 workspace 복원에 따라 갱신한다.
- 기존 시안 복사/프로젝트 깊은 복사/저장에는 common roomView가 포함된다. 사진 카메라만 바뀌어도 시각 장면 geometry cache를 재생성하지 않는다.
- Supabase strict schema에도 새 선택 필드를 검증한다. 유한 좌표, 범위, 단위 quaternion, FOV 5~150, 이미지 비율, 기준 공간 크기, 출처를 검사한다. 서버 연결/배포는 하지 않았다.

## 공통 렌더 API

`src/lib/room-viewer/render-snapshot.ts`:

```ts
const view = sourceRoomView(chosenSourceCamera, room);
project.roomView = view;
await renderRoomSnapshotImage(
  {scene: activeAfter, beforeScene: commonBefore, materials: versionMap, roomView: view},
  assetReader,
  {renderer: 'room-view', mode: 'before', longEdge: 1200, format: 'png'},
);
```

명시적인 `renderer: 'legacy-front'`는 기존 PhotoCompositor를 사용한다. Helper는 이미지를 저장하거나 업로드하거나 AI를 실행하지 않는다. 리소스 준비/렌더/파일 복사가 끝나면 생성한 GPU 자원을 해제한다. 크기는 기존 원본 장면·GPU·4096 제한을 적용한다. 모형의 질감·색감은 각 장면 그대로이며 조작 UI는 출력에 없다.

기존 정면 2D 편집의 사진 좌표, 타일 quads, picking, PhotoCompositor 투영은 바꾸지 않았다. 사진 시점 결과를 확인하려면 공간 둘러보기/명시적인 helper 경로를 사용해야 한다. 최종 Lab/create 채택은 선택한 추정 camera와 room을 연결해야 한다. 카메라 수정이 누락된 설비 인식, 공간 치수 정확도, 표준 모형의 기하 정확도를 개선했다는 주장을 하지 않는다.

## 실제 검증

- `vitest`: room-view-state 32 + room-viewer-surfaces 9 + room-viewer-fixtures 24 = **65개 통과**. 원본 카메라 투영/회전/이동/화면 비율/기존 view 호환/잘못된 저장/시안 복사/일반 undo/공통 치수 복원 및 저장 충돌을 포함한다.
- `room-source-view-browser.ts`: 실제 Chrome + SwiftShader WebGL + production RoomViewer + IndexedDB. 이 테스트 장면은 작성한 기능 검증 데이터이며 AI 인식 결과가 아니다.
- 8개 공간 꼭짓점의 원본 카메라 vs 사진 보기 투영 오차 **0**, 미리보기 vs 공통 helper PNG 픽셀 불일치 **0**, 위로 90도 4회 후 픽셀 불일치 **0**.
- 같은 장면 Before/After 비교는 총 960,000 채널 중 **2채널이 1/255 차이**. 두 패널의 shader UV 계산에 따른 극소수 반올림 차이이며 기하 투영은 동일하다.
- 모드 전환, 실제 마우스 이동·확대, 원본/장면 revision 보존, IndexedDB 재진입, PNG 다운로드, 모바일 420px, 열린 창에서 크기 변경/전체 복원/다시 실행을 확인했다.
- 기존 `room-viewer-render-browser.ts` **19체크 통과**. 기본 공간, tile/fixture, 가림, 출력, 반복 회전, 자원 정리를 검사했다.
- 마지막 tsc 및 수정 파일 ESLint 통과. 전체 Next/vinext 빌드와 15장 실제 AI 재검증은 상위 작업에서 별도 실행한다.

증거: `test-results/reconstruction-fifteen-rebuild/20260915-start/source-room-view/verification.json`, `source.png`, `whole-room.png`, `compare.png`, `ui-source.png`, `ui-download.png`, `mobile-source.png`. source/whole-room 이미지는 직접 열어 시점 차이와 여백을 확인했다. 이 카메라 경로는 사진에 보이지 않거나 추정이 틀린 모형을 보정하지 않는다.

## Lab 연결 추가 검증

`tests/reconstruction-lab-source-camera-browser.ts`는 segmentation/inventory/identity/installation/geometry/appearance/layout 추론 함수만 `tests/fixtures/room-source-inference-boundary.ts`의 작성된 계약 데이터로 대체한다. 제품 코드의 `runReconstructionLabCase`, quality-core, 실제 추정 배치, 표준 모형 생성, source camera 채택, 공통 렌더, `saveLabResultAsProject`, IndexedDB는 모두 그대로 실행한다. 실제 모델 추론·15장 품질 검증·인식률 측정이 아니다.

- Lab report.renderView = 완료 bundle.document.roomView = 저장 후 읽은 project.roomView = 저장 보고서의 renderView를 확인했다.
- Lab Before PNG와 저장 프로젝트를 공통 helper로 다시 출력한 PNG의 픽셀 불일치 0.
- 작성한 변기 관측 하나가 Before 모형 하나로 생성되고 After는 빈 상태를 유지했다. 생성 위치/형태의 실사 정확도를 검증한 것은 아니다.
- report와 bundle 카메라가 불일치하면 저장 거부, 미리 취소한 실행은 프로젝트를 생성하지 않음, baseline 실행은 기존 legacy-front 렌더와 source camera 없는 상태를 유지함을 확인했다.
- 저장한 결과를 production RoomViewer로 열어 사진 시점 버튼과 실제 렌더를 확인했고 페이지 새로고침 후 값도 일치했다.
- 증거: `test-results/reconstruction-fifteen-rebuild/20260915-start/lab-source-camera-contract/{verification.json,lab-before.png,reopened-export.png,saved-project-viewer.png}`. 실제 화면 이미지도 직접 확인했다.

사진 시점 브라우저 검사에 추가한 실패 사례: Before 없는 snapshot 및 WebGL 컨텍스트 생성 실패에서 명확한 오류를 반환하고 기존 project JSON이 변하지 않았다. letterbox에서도 가로 25px/세로 30px 마우스 이동이 사진에 같은 거리로 반영되는지 검사했다. 최종 TypeScript 및 추가 파일 ESLint 통과.
