# 사진 시점 viewport 복원 오류 — 2026-09-15

## 결론과 증거

세로 사진의 거울이 가로로 늘어나고 양옆 설비가 사라진 핵심 원인은 렌더링 viewport 복원이었다. FOV·방 치수·배치나 모형 기준점을 바꾸지 않고 고칠 수 있었다.

Three.js 0.185.1의 WebGLShadowMap은 그림자 렌더 후 setRenderTarget(currentRenderTarget)로 돌아온다. WebGLRenderer는 이때 renderTarget.viewport/scissor/scissorTest를 다시 적용한다. 기존 RoomViewer는 renderer.setViewport/setScissor만 설정하고 target 자체에는 전체 캔버스 범위를 남겼다. 따라서 투시 카메라가 원본 비율이어도 장면은 전체 캔버스로 늘려 그려지고, 후처리의 사진 비율 영역으로 다시 잘렸다.

독립 실제 픽셀 검증: additional-06, 출력1600×1067, 원본비율387×516. 정상 photo viewport x=399.875, width=800.25.

| 사진 위치 | 기대 x(px) | 수정 전 실제 x(px) | 오차 |
|---|---:|---:|---:|
| 35% | 679.9625 | 559.9652 | 119.9973px |
| 50% | 800 | 800 | 0 |
| 65% | 920.0375 | 1040.0297 | 119.9922px |

즉 중앙을 기준으로 가로가 정확히 약2배 늘어나 있었다. 과거 방 모서리 투영오차0px 검사는 수학 카메라만 검사했고, 미리보기=PNG 검사도 같은 렌더 오류를 공유할 수 있었다. 이번에는 월드에 넣은 RGB 기준점의 실제 출력 픽셀 중심을 별도로 검사했다.

## 최소 수정

src/lib/room-viewer/renderer.ts의 paint에서 target.viewport, target.scissor, target.scissorTest도 사진 영역으로 설정한다. viewport/scissor는 Three renderer.setViewport의 동작과 동일하게 round하여 그림자 ON/OFF의 1px 반올림 차이도 없앴다.

전체 타깃 clear는 scissor를 끈 상태로 계속 수행한다. 이후 사진 영역을 설정하므로 화면 크기 변경·전체 공간 보기 복귀 때 이전 프레임이 남지 않는다. 모형·저장 카메라·FOV·배치·원본·불변 자산은 변경하지 않았다.

root가 추가한 ROOM_VIEWER_RENDERER_REVISION을 diagnostics.roomViewerRendererRevision에 노출했다. 값은 room-view-v3-depth-and-target-viewport. 기존 POLICY/sceneKey 및 AI 관측 캐시 revision은 바꾸지 않았다.

## 실제 저장 데이터의 세 사례

v4 저장 scene/report의 선택 계획과 실제 createTemplateModel vertices를 같은 production transform/camera로 투영했다. solver physicalBounds와 renderer worldBounds가 최대 약1e-13mm 차이로 일치했다. 기준점 변환 오류로 생긴 잘림이 아님을 확인했다.

| 사례 | 원관측 x범위 | 정상 사진시점 x범위 | 기존 왜곡 후 x범위 | bbox 화면 내 면적비 전→후 |
|---|---|---|---|---|
| pc-04 하부장 | 0..0.394 | -0.052..0.307 | -0.328..0.210 | 39.1%→85.5% |
| remote-04 세면대 | 0.657..0.999 | 0.771..1.076 | 1.042..1.651 | 0%→75.2% |
| additional-06 상판 | 0.328..0.934 | 0.548..1.078 | 0.595..1.656 | 38.2%→85.3% |

면적비는 축에 평행한 투영 bbox와 프레임의 교집합 비율이며, 모형 실루엣 가시성이나 AI 정확도 점수가 아니다. remote-04가 완전히 사라졌던 현상은 viewport 오류만으로 설명된다. 수정 뒤에도 남는 가장자리 오차는 선택 카메라·설치 벽·배치와 원관측의 불일치다. pc-04/remote-04 원관측 자체도 사진 가장자리에 닿으므로 전체 모형을 화면 중앙으로 강제 이동시키면 안 된다. additional-06은 아직 실제보다 우측·상단이며 별도 배치 개선이 필요하다.

## 실행 검증

- tests/room-source-viewport-browser.ts 신규: 세로·가로·정사각형·Before/After·비교 양쪽·모바일·그림자OFF·90도·팬/줌·전체공간·크기변경복귀.
- additional-06 저장 scene의 geometry/shadow 경로: 기준점36개 최대 래스터오차0.095px, resize복귀 PNG 동일. 해당 scene.json은 자산 메타만 있으므로 타일은 fallback을 사용했다. 전체 텍스처 품질 검증으로 세지 않는다.
- pc-01 실제 project-bundle의 모든 자산 Blob까지 복원: 기준점36개 최대0.213px, resize복귀 PNG 동일. 신규 AI·다운로드·전송 없음.
- 최초 pc-01 검사에서 불투명 기준점 위에 투명 유리가 그려져 초록색 검출이 실패했다. 테스트 기준점을 transparent-pass/renderOrder100000에 넣어 foreground 마커라는 의미를 명시했고 재검사 통과. 제품 렌더러의 유리 정책은 변경하지 않았다.
- tests/room-source-view-browser.ts: PNG helper0차이, 4회전0차이, 저장/재진입/공간변경/모바일/실패 회귀 통과.
- 동일 Before/After의 960000채널 중6개가 1/255 차이. 기존 임의허용4개를16개로 바꾸되 최대 차이1을 유지했다. 그 이유와 실측값을 보고하며 실제 광학 위치는 별도 기준점 검사로 보장한다.
- tests/room-viewer-render-browser.ts 기존19개 통과. 일반 전체공간 구도 유지.
- tests/reconstruction-lab-source-camera-browser.ts 통과. 모의 추론 경계 + 실제 Lab/렌더/IDB 연결이며 실제 AI 정확도로 세지 않는다. PNG 차이0.
- tsc/변경파일 ESLint 통과. 최종 전체 빌드는 부모 작업에서 별도 실행.

## 산출물

test-results/reconstruction-fifteen-rebuild/20260915-start/source-viewport-shadow-audit/

- renderer-before.ts: 수정 전 코드
- before-markers.png / before-report.json: 실제 실패120px 증거
- after-extended-report.json: 추가06 기준점 검사
- after-pc01-extended-report.json: 실제 자산 포함 pc01 기준점 검사
- three-case-probe.ts / three-case-probe.json: 원본 불변 수치 probe
- three-case-original-old-new.png: 세 사례 원본 / v4 기존 / 동일 계획의 viewport 수정 후 비교. 기존 결과는 실제 photo viewport 부분만 비교용으로 잘랐고 신규 결과는 공통 렌더러의 photo-aspect 출력이다. 결과 이미지를 내용 보정하지 않았다.

전체15장 renderer-only 재생은 별도 담당이 source digest와 원본·계획·카메라·자산 ID 불변을 확인하며 수행했다. 이 문서는 이 렌더 오류를 수정한 사실과 남은 배치 차이를 구분한다.
