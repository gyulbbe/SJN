# 사진 시점 깊이 정밀도 수정 검증 — 2026-09-15

## 확인된 원인

실제 pc-01 추론 결과를 저장한 동일 번들을 읽어 Three.js 렌더러에서만 조건을 바꿨다. 새로운 AI 추론, 사진 전송, 원본·프로젝트·불변 자재 변경은 없다.

1. 기존 사진 시점은 계산용 createSourceCamera의 near=0.1mm, far=10,000,000mm를 렌더링에도 사용했다.
2. 거울의 중립 앞면과 본체 앞면은 약 0.64mm 떨어져 있다. 수 미터 거리의 투시 depth buffer에서 둘의 깊이가 충분히 구분되지 않아 줄무늬가 생겼다.
3. 그림자 전체 OFF, 거울 receiveShadow OFF, 앞쪽 유리 숨김에서도 줄무늬가 남았다. 따라서 그림자가 주원인이라는 최초 가설은 기각했다.
4. 모형·색·그림자를 그대로 두고 near/far만 10mm/50,000mm 또는 50mm/50,000mm로 바꾸면 줄무늬가 사라졌다. 고정 숫자는 원인 검증용이며 제품 코드에 넣지 않았다.

비교: test-results/reconstruction-fifteen-rebuild/20260915-start/neutral-surface-shadow-ab-final/cause-comparison.png
전체 장면: 같은 폴더 before-after.png. 원래 깊이 / 그림자 OFF / 실제 수정 순으로 직접 확인했다.

## 수정과 호환성

- src/lib/room-viewer/depth-clip.ts: 실제 보이는 Before와 After의 메시별 경계를 함께 모아 카메라 시야와 교차시킨다. 가시 최소·최대 깊이에 여유를 두어 공통 near/far를 파생한다.
- src/lib/room-viewer/renderer.ts: 사진 시점일 때만 렌더 직전에 적용한다. 미리보기·PNG가 같은 경로이며 진단에 sourceDepthClip을 남긴다.

position/quaternion/FOV/aspect, 화면 좌표, 저장된 roomView, 기존 전체 공간 카메라, 표준 모형 geometry, 중립면 색, 그림자 설정을 유지했다. source-camera.ts의 계산용 카메라와 저장 형식은 바꾸지 않았다.

pc-01의 파생 범위는 near=330.0632324648895mm, far=3201.5860518020663mm. 가시 경계 42개에서 실제 깊이 1320.252929859558~3049.129573144825mm를 얻었다. 사진 ID·좌표별 예외는 없다.

카메라가 메시 경계 안에 있거나 가시 표면이 눈앞까지 교차하면 기존 최소 near=0.1mm를 보수적으로 사용한다. 이 극단 상황에서는 작은 간격의 artifact가 다시 생길 수 있지만 임의로 가까운 물체를 잘라내지 않는다.

## 실제 검증

tests/neutral-surface-shadow-browser.ts를 정규 node tests/run-browser-test.mjs로 실행했다.

- 실제 pc-01 저장 번들의 SHA-256 및 원본 바이트 불변.
- Chrome 152 / ANGLE NVIDIA RTX 4070 Ti Direct3D11. 그림자를 유지한 수정 결과에서 줄무늬가 사라진 것을 실제 PNG로 확인.
- 원래 near/far, 그림자 OFF, 유리 숨김, receive/cast flag, near 10/50mm, polygon offset 대조.
- 수정 결과와 중립면 polygonOffset을 켠 결과는 PNG 바이트까지 같다. 원래 깊이 범위에서는 offset이 결과를 바꿨다.
- authored 거울·거울장·창 × v1/v2, 총 6개 표준 모형을 실제 렌더하고 직접 확인. 중립면·문 분할·창틀이 보이며 castShadow와 receiveShadow 유지. 이는 AI 인식 결과가 아닌 렌더 회귀다.
- 신규 추론·모델 다운로드·외부 사진 전송 0회. 비교표만 합성하며 실제 PNG를 이미지 보정하지 않았다.
- pc-01의 거울 중복, 유리 방향, 설비 잘림 등 인식·배치 문제는 별도 미해결이다. 정밀 반사 거울도 이번 범위가 아니다.

수치와 출력: 위 artifact 폴더 verification.json, original-depth.png, normal.png, neutral-regressions.png.

## 회귀

- room-source-depth-clip.test.ts 7개 통과: 0.625mm 간격 depth 분리, 방 안/밖, 상하좌우 90도, 1mm 근접, 제품 내부 카메라, 최소/최대 방, 확대 0.25~8배, pan, 공통 Before/After, 가시 표본 잘림 없음, 화면 좌표·geometry·material 불변.
- room-view-state.test.ts 기존 32개 통과: 저장·시안 복사·undo·공통 크기 변경과 전체 복원.
- room-source-view-browser.ts 통과: 방 모서리 8개 투영 오차 0px, 미리보기/PNG 차이 0, 네 번 90도 회전 차이 0. Before/After 960,000채널 중 2개만 1/255 반올림 차이. UI·모바일·IndexedDB·재진입·resize/restore·실패 처리 확인.
- room-viewer-render-browser.ts 기존 19개 검사 통과: whole-room-fit 정책 유지.
- reconstruction-lab-source-camera-browser.ts 통과: 모의 추론 경계 + 실제 Lab/모형/렌더/저장 연결. AI 품질로 세지 않는다. 저장 PNG 차이 0.
- npx tsc --noEmit 및 변경 파일 ESLint 통과.

처음 두 기존 브라우저 테스트를 npx tsx로 직접 실행했을 때 __name is not defined 하네스 변환 오류가 났다. 정규 browser runner로 재실행하여 통과했다.

최종 Next/vinext 빌드와 15장 같은 번들 재생은 주 작업에서 소스를 동결한 뒤 진행한다. 여기서는 그 결과를 미리 통과로 기록하지 않는다.
