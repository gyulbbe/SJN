# 벽 방향을 유지하는 위치 보정

2026-09-13. Lab의 기존 **벽 기준 거리로 배치**에서 뒤쪽 벽을 선택한 후, 바닥 그림을 누르거나 끌어 제품 위치를 바꿀 수 있다. 선택한 벽을 등지는 방향은 유지하고 벽을 따른 중심 거리와 뒤쪽 간격이 함께 갱신된다. 방향키와 모바일 터치도 같은 입력 경로를 사용한다.

벽을 고르지 않았거나 제품 깊이가 유효하지 않으면 그림 입력을 잠근다. 그림에서 제품을 벽과 겹치게 옮기면 음수 간격과 검증 오류를 유지한다. 자동으로 경계 안에 밀어 넣지 않으며, 다시 유효한 위치로 이동해 복구할 수 있다. 제품 깊이를 숫자로 바꿀 때는 이전과 같이 뒤쪽 간격을 유지한다. 욕조에 연결된 유리는 기존 부모·테두리 입력으로만 이동한다.

`src/components/reconstruction/manual-placement-editor.tsx`에서 기존 역변환 `wallReferenceFromPlacement`를 재사용한다. AI 관측이나 입력 규격 출처는 변경하지 않는다. 교정 PNG를 생성하기 전까지는 폼 입력이며, 적용 시 기존 사용자 교정 스냅샷에 저장한다.

## 검증

- `node tests/run-browser-test.mjs tests/reconstruction-manual-placement-browser.ts`: 통과. 세 벽의 실제 마우스 이동, 방향 유지, 드래그·방향키·모바일 터치, 잘못된 간격 표시와 복구, 깊이 변경 후 간격 유지, 벽 설치/자유 배치 전환을 검사했다.
- `node tests/run-browser-test.mjs tests/reconstruction-placement-picker-browser.ts`: 기존 자유 배치의 마우스·드래그·방향키·잠금·터치·벽 하단 기준점·모바일 너비 회귀 통과.
- 해당 두 편집 파일 ESLint 통과. Windows / Headless Chrome 152.0.7977.83. 페이지 오류와 외부 요청은 0이다.
- 실제 캡처 `test-results/reconstruction-wall-distance-drag-20260913/mobile.png`를 확인했다. 기능 검사에 입력한 숫자는 사진의 실측 또는 AI 검출 결과가 아니다. UI 흐름 검증을 자동 재현 정확도 개선으로 집계하지 않는다.

이 변경은 확인이 필요한 설비의 보정 조작을 줄이는 부분이다. 자동 설치 벽·규격·카메라 문제와 전체 재구성 목표의 완료 여부는 별도 검증한다.
