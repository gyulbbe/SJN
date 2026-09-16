> 과거 검증 기록: `reconstruction-next-quality-browser.ts`는 종료된 Lab 화면에 의존하여 2026-09-16 소스 정리에서 제거했습니다. 아래 결과는 당시 실행 기록이며 현재 실행 가이드가 아닙니다.

# 설치 관계 참고 후보 — 2026-09-14

기존 `세면대·하부장 위에 맞추기`의 위치 복사를 유지하면서, 같은 사진에서 위·아래에 있고 가로 범위가 겹치는 세면대·하부장을 **선택 가능한 참고 후보**로 먼저 보여 준다. 사용자가 **이 위치로 맞추기 · 사용자 확인**을 누를 때만 벽·가로 위치·하단 높이를 한 번에 복사한다. 이후 부모 이동을 따라가는 동적 연결은 아니다.

## 판단과 보존

- `wall-alignment-suggestions.ts`: 원모델과 동일한 후보 ID·정규화 bbox, 같은 입력 fingerprint, 현재 사용자 교정 및 후보 정리 결과를 이용한다. bbox를 바꾼 후보나 사용자 추가 설비를 원사진 관측인 것처럼 추천하지 않는다.
- 반사/반사 미확정, 의미 충돌, 중복·부품, 가림/투명 중첩/불확실 관계, 격리된 잘못된 관계는 추천에 이용하지 않는다. 정상 `partOf`는 기존 결합을 유지해 세면볼과 하부장이 두 부모로 추천되지 않는다.
- 사진의 상하·가로 겹침은 `inferred` 근거다. 사진 왼쪽을 왼쪽 벽으로 바꾸거나 픽셀 거리를 mm로 환산하지 않는다. 벽은 참고 설비의 현재 배치에서 가져오며, 벽이 없으면 선택을 유지하고 벽 확인이 필요하다고 표시한다.
- 최대 3개 대안을 표시한다. 각 대안에는 사진 번호/설비 이름, 설치 벽, 상단 간격, 실제 제안 높이·가로 위치, 판단 근거를 표시한다. 기존 대상 선택 목록도 남는다.
- 기존 `proposeWallAlignment`로 부모/대상 모형 전체의 방 침범과 방향을 검사한다. 맞지 않는 규격을 강제로 줄이거나 옮기지 않는다. 간격 기본값 150mm는 사진 실측값으로 기록하지 않는다.
- `LabManualDraft.positionReference.recommendation`에 원관측 bbox와 벽 출처·입력 fingerprint·규칙 근거를 복사하고, 실제 버튼 선택 후 `confirmation: user`로 저장한다. 원모델 관계 목록을 수정하거나 새 AI 관측으로 기록하지 않는다.

`lab-wall-alignment.tsx`와 `manual-placement-editor.tsx`는 이 추천을 표시하고 기존 `onChange` 한 번으로 복사한다. `reconstruction-lab.tsx`는 검증된 현재 관측을 전달하고 사진 번호를 연결한다. 추천 정보가 없는 과거 자료에서는 원래 선택·복사 UI가 그대로 동작한다.

## 함께 확인한 기존 관계

`lab-relations.ts`의 세면볼→하부장 `partOf`는 벽/반사/종류/사진 영역/순환/다중 부모를 검증하는 별도 사용자 확인이다. `candidate-bath-rim.ts`, `lab-bath-rim-controls.tsx`의 욕조→유리는 사용자 선택한 부모·테두리·거리를 유지하는 실제 연결이다. 위 거울의 위치 복사와 이 두 동작을 혼동하거나 자동 변환하지 않았다.

## 담당 범위의 검사

- 신규 단위 24개 + 기존 위치 복사 30개 + 관계 21개 = **75개 통과**. 반사·가림·잘못된 부품 관계·변경 bbox·빈 fingerprint·알 수 없는 벽·대안 수·방 침범·방향 모순·입력 불변을 검사했다.
- 기존 실제 `ManualPlacementEditor` 브라우저 회귀 **18항목 통과**. 이전 자료/합성 부모의 기본 복사·수정·삭제·잠금 동작, Worker/외부 요청/페이지 예외 0. 기록: `test-results/reconstruction-wall-alignment-ui-20260913/run-02/verification.json`.
- 실제 `prospective-03` 보존 관측과 이전 사용자 확인 세면대 위치를 사용한 새 UI 검사 **8항목 통과**. 추천 전 상태 변경 0, 키보드 Enter 후 복사 명령 1개, back/u=0.28/하단1120mm, 비운 규격 기본 출처, 원모델 불변, 사용자 확인 출처, 부모 이동·삭제 후 독립 위치, 5000mm 초과 보류, 잠금, 390px 가로 넘침 없음을 확인했다. 기록: `test-results/reconstruction-installation-suggestions-20260914/2026-09-13T23-24-38-488Z/verification.json`.
- 담당 소스와 테스트의 scoped ESLint 오류/경고 0. 전역 검사와 빌드는 통합 결과에서 별도로 기록한다.

위 8항목은 실제 production 위치 컴포넌트 검사이며 Full Lab 저장 검사로 확대 해석하지 않는다. 사진은 이미 결과를 본 개발 회귀다. 새 모델 추론이나 인간의 최소 클릭 수를 측정하지 않았다. 부모 위치가 먼저 확인돼 있어야 하며, 가려진 지지 접점·실제 방 폭/촬영 카메라·미관측 치수를 이 추천으로 해결했다고 주장하지 않는다.


## 실제 Lab·색상·저장 통합 확인

새 `tests/reconstruction-next-quality-browser.ts`는 과거 스크립트/결과를 덮어쓰지 않고 `test-results/reconstruction-next-quality-20260914/ui/2026-09-13T23-29-25-389Z/`에 별도 자료를 만들었다. 상태는 passed, 실행 전후 production 소스 해시가 동일했다.

- 실제 보존 관측을 현 pipeline에서 재생하고 같은 사용자 역할의 지지/곡면/위치 확인과 잘못된 거울장·욕조 후보 제외를 적용했다. 초기에 0개, 사용자 확인 후 세면대·거울·변기 3개이며 AI 인식 성공률은 아니다.
- 실제 `RunFindings`의 추천 버튼 한 번으로 거울을 back/u=0.28/하단1120mm에 복사했다. 추천 출처 inferred, 선택 user, 원모델 관계와 원문은 불변이다. 이 횟수는 자동화 이벤트이며 인간의 최소 조작 수가 아니다.
- 자동 색상은 세면대/변기의 원래 갈색 `observedColor`를 보존하고 legacy-observation/default/확인 필요를 기록하며 중립 도기로 렌더됐다. 중립색 확인 후 user, 흰색·청록색 preset 후 custom/user가 됐다. 거울은 neutral-optics/default를 유지한다.
- 자동색 PNG와 사용자 흰 세면대·청록 변기 PNG를 직접 비교했다. 같은 위치와 윤곽에서 색만 바뀌고, 거울은 세면대 위에 정렬된다. 갈색 벽, 넓은 공통 기본 구도, 가려진 문·커튼·선반의 미재구성은 그대로 남는다.
- PNG 다운로드 바이트와 현재 미리보기 SHA256이 같고, 핸들·확인 문구·색 선택 UI가 출력되지 않았다.
- 실제 LabProjectAction 저장 → repository load → 페이지 reload → readLabProjectReport에서 Before 3개와 색상/추천 스냅샷, 원모델 보고서를 보존했다. After는 한 시안의 빈 공간이다.
- 새 모델 실행/Worker 호출/외부 요청/페이지 예외 0. 현 pipeline 보존 관측 재생·사용자 보정이며 새 AI 추론 또는 실제 Next 프로젝트 E2E와 구분한다.
- 신규 FullLab 테스트 scoped ESLint 및 별도 non-incremental scoped TypeScript 검사 통과. 위치/관계 단위 75개도 최종 재실행 통과했다.
