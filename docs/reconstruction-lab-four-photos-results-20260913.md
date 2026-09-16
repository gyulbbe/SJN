# 네 개발사진의 Lab 보정 → 실제 프로젝트 연속 검증

2026-09-13. 이 문서는 AI 인식 정확도나 사진과 같은 공간을 자동 복원했다는 평가가 아니다. 최초 AI 관측만 저장된 실제 보고서로 재생하고, 이후 현재 UI의 보정·렌더·명시 저장·프로젝트 재진입·After 편집·시안·PNG 내보내기를 이어서 검증했다.

## 입력과 실행 방식

- 입력: `test-results/user-reconstruction-improvement-20260913/inputs/user-01.jpg`부터 `user-04.jpg`.
- 최초 관측: 같은 루트의 `after-installation-shape-final/user-01..04/{baseline,candidate}.json` 및 PNG. 원본 SHA와 보고서 inputFingerprint가 일치한다.
- 테스트: `e2e/reconstruction-lab-four-photos.spec.ts`.
- 실제 현재 Lab 컴포넌트와 AppProvider를 esbuild 하네스에 표시했다. 최초 분석 호출만 원 보고서로 바꾸며, 교정은 실제 `runReconstructionLabCase`를 실행한다. Next Link의 동일 href를 일반 링크로 연결하는 하네스 어댑터를 거쳐 저장된 실제 `/projects/{id}` 페이지로 이동한다.
- 이후 `/projects/{id}`는 기존 localhost:3000의 실제 Next 앱이다. 모델·기하·입력값을 대신 쓰는 테스트 어댑터는 없다.
- 입력 폼은 UI로 조작했고 각 확인값을 JSON에 기록했다. details를 펼치는 DOM 동작은 하네스가 처리하므로 이벤트 수는 인간의 전체 클릭 수나 최소 보정 횟수가 아니다.
- 규격은 기존 default 출처를 유지했다. 위치·높이·욕조 연결 위치·샤워 턱 치수는 기능 검사용 사용자 역할의 임시 추정값이며 실측 정답이 아니다.

## 사진별 확인 범위

| 사진 | 표현된 핵심 설비 | 사용자 보정과 남는 범위 |
|---|---|---|
| user-01 | 변기·벽걸이 세면대·욕조·거울장·욕조 연결 유리·벽 선반, 6개 | 사용자가 확인한 거울장으로 종류를 변경했다. 반사 속 선반은 제외하고 실제 선반을 수동 추가했다. 유리는 기존 욕조 후보에 연결해 실제 fixture ID와 부모 림 높이를 보존했다. |
| user-02 | 변기·벽걸이 세면대·거울, 3개 | 열린 뚜껑·둥근 볼·같은 뒤벽 배치를 직접 확인하고 잘못된 거울 반사를 해제했다. 불완전한 문/문틀은 핵심 3개 밖의 미보정 후보로 남는다. |
| user-03 | 변기·기둥 세면대·거울·샤워 턱 위 유리, 4개 | 열린 뚜껑과 기둥형 관측을 유지하고 임시 벽 기준 위치를 지정했다. 유리 아래 900×160×100mm 턱은 사용자 시험 입력이다. 별도 수전 unknown 후보는 미지원 범위다. |
| user-04 | 변기·창·거울·두 볼 하부장, 4개 | 둥근 볼 형태만 사용자 보정하고 모델의 볼 2개 관측은 유지했다. 벽과 위치는 시험 입력으로 명시했다. |

user-01 거울장의 수납 여부는 기존 사용자 확인에 따른 것이며 사진에서 내부 수납 구조를 새로 알아낸 결과가 아니다. 실제 선반을 수동 추가한 결과도 AI 검출 성공 수에 넣지 않는다. user-03 턱 크기와 user-01 테두리 front/offset -200mm를 원본에 대한 정확한 치수·방향이라고 주장하지 않는다.

## 연속 검증 내용

각 사진마다 새로운 브라우저 컨텍스트를 사용했다. 시안 편집의 재현성을 위해 기존 helper가 만든 네 개의 검증용 타일만 사전에 로컬 저장소에 준비했다. 이 자재는 사진 관측이나 설비 후보에 주입하지 않았다.

1. 원 기준선/후보의 JSON 불변과 교정의 automaticUnderstanding·rawText 보존, 추가 모델 시간 0을 확인했다.
2. 보정 PNG 생성까지 프로젝트·자산 저장소가 사전 상태와 동일함을 확인했다. 명시적인 **이 결과로 공간 만들기**에서만 저장된다.
3. 원본 사진 자산 SHA, 미리보기 자산과 자재 버전 참조, 완료 교정 보고서, Before 설비가 저장됨을 확인했다. 같은 방의 After는 설비와 적용 자재가 없는 상태로 시작했다.
4. 실제 프로젝트에서 Before/After의 서로 다른 렌더를 확인하고 새로고침 후 Before와 원 보고서 보존을 검사했다.
5. After 바닥 타일 적용 → 실행 취소 → 다시 실행을 검사했다. 이 검사는 타일 편집 history 범위이며 모든 종류의 Before 설비 편집 history를 대신 검증하지 않는다.
6. 시안을 복제한 뒤 복사본에 다른 타일을 적용하고 원 시안과 Before가 바뀌지 않았음을 확인했다. 재진입 시 시안 두 개와 활성 시안이 유지됐다.
7. 실제 내보내기에서 4096px 비교 PNG를 다운로드했다. 마지막 PNG의 After는 편집한 타일 상태다. 저장 직후 빈 After 캡처는 따로 보존했다.

성공 결과의 AI 실행 요청·모델/worker 요청·외부 HTTP 요청·페이지 예외는 모두 0이었다. 원래 보고서의 AI 실패/보류 상태를 사용자 보정 결과로 덮어쓰지 않았다. 저장 실패/재시도 주입은 기존 `reconstruction-lab-project.spec.ts`의 별도 검사이고 이번 네 사진 검사는 정상 명시 저장 경로다.

## 결과 파일과 재시도

- 집계: `test-results/reconstruction-lab-four-photos-20260913/summary.json`
- 안정적인 비교 페이지: `test-results/reconstruction-lab-four-photos-20260913/comparison/index.html`
- 사진별 고정 경로: `comparison/user-01..04/{original.jpg,corrected.png,project-before-after.png,project-after.png,verification.json,user-role-inputs.json}`.
- `original.jpg`는 입력 사진, `corrected.png`는 사용자 보정 Before, `project-before-after.png`는 Before와 편집한 After의 비교다.
- `run-01`: user02/03/04 성공. user01은 6개 설비 보정과 저장 후 첫 프로젝트 페이지 이동에서 20초 대기 제한을 초과했다. click 자체는 완료됐고 navigation 완료를 기다리다가 중단됐다. 실패 trace를 보존했다.
- `run-02`: 링크 이동 대기만 60초로 바꾼 user01 재검증 성공. 앱이나 보정값을 바꾸지 않았다.
- `run-03`: 최종 파이프라인의 모순 입력 방어가 추가된 뒤 동일 소스로 user02/03/04 재검증 완료. exit 0, 3 passed. 최종 완료 상태·각 시간·소스 SHA는 summary.json에 기록했다.

각 테스트는 선택한 앱 소스 11개에 대해 실행 전후 SHA가 같은지 확인한다. 초기 run-01과 run-02 사이 candidate-pipeline의 모순 입력 검증이 추가됐으므로 서로 다른 해시의 성공을 동일 소스 결과로 합치지 않는다. 최종 집계는 user01 run-02와 user02/03/04 run-03의 동일 해시만 채택한다.

최종 채택 결과는 **4장 모두 통과**이며, 11개 앱 소스 SHA가 사진 사이에도 모두 일치한다. candidate-pipeline SHA는 `96a7d0c7b1504454321f572939ae25b718d3baa6895078ad12e66fd9b03fa1a3`이다. 자동화 순서의 실행 시간은 user-01 60.48초, user-02 23.79초, user-03 58.54초, user-04 26.07초다.

## 육안 확인과 한계

실제 PNG 네 장을 원본과 함께 확인했다. user01은 거울장·세면대·변기·욕조와 연결 유리·추가 선반이 표현된다. user02는 둥근 벽걸이 볼과 실제 거울·열린 변기, user03은 기둥 세면대와 턱 위 유리, user04는 두 볼 하부장과 창·거울·변기가 표현된다.

그러나 표준 카메라와 기본 규격은 원본 촬영 구도·거리·제품 외곽의 정답이 아니다. user03에서는 앞의 변기가 세면대 기둥 일부를 가린다. user01의 거울장 크기·유리 방향, user04 하부장 길이·조명·창 분할 등의 시각적 일치는 이 기능 검증으로 입증되지 않는다. 소요 시간도 자동화 실행 시간이며 인간의 보정 완료 시간이나 실제 기기의 최대 성능 측정이 아니다.

```powershell
$env:SJN_LAB_FOUR_PHOTOS='1'
npx playwright test e2e/reconstruction-lab-four-photos.spec.ts --output=test-results/reconstruction-lab-four-photos-20260913/new-run --reporter=list
```