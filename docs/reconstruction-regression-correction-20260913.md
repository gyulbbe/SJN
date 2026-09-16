> 과거 검증 기록: 이 문서의 전체 Lab 화면 재생 스크립트는 해당 화면 종료 후 2026-09-16 소스 정리에서 제거했습니다. 아래 결과와 증거 경로는 당시 실행 기록이며 현재 실행 가이드가 아닙니다.

# 별도 평가 사진의 후속 사용자 보정 회귀

2026-09-13. 기존 [평가3장](reconstruction-evaluation-split-20260913.md)의 원사진과 실제 보고서를 검토하고 **prospective-03 한 장**에서 현재 Lab 사용자 보정 경로를 확인했다. 세 사진은 이미 결과에 노출되어 이 검사는 회귀다. 이전 평가 프로토콜·주석·결과를 변경하지 않았다.

prospective-01은 현재 모형으로 표현되지 않는 쪼그려 쓰는 변기, prospective-02는 접이식 스크린/창짝의 형태·재료 불확실성이 있다. 우선 prospective-03의 세면대·거울·변기 핵심3개를 선택했다. 나머지 두 사진의 보정 UI는 아직 실행하지 않았다.

| 단계 | 실제 결과 |
|---|---|
| 기존 실제 관측 | 세면대 vanity/rectangular, 거울/거울장 중첩 후보, 커튼/샤워 트레이를 bath로 관측 |
| 현재 코드 재생 | 원문/관측 그대로 처리, 자동 배치0개. 새 모델/DeepLab 실행 없음 |
| 필요한 사용자 보정 | 세면대 wall/round·설치 벽/위치·하단 높이, 거울 벽/위치/높이, 변기 위치, 중복 거울장 및 욕조 오탐 제외 |
| 결과 | 곡면 벽걸이 세면대·중립 거울·변기3개. 규격 입력은 비워 각 폭/높이/깊이 default 유지 |
| 보존·출력 | 원 모델/원문/자동 결과 불변, 교정 스냅샷 별도. 실제 PNG1600×1067과 미리보기 SHA256 일치 |
| 검사 | 첫 브라우저 실행 exit0, 새 파일 scoped Prettier/ESLint 통과. 새 AI/Worker/외부통신/POST/pageerror0 |

당시 `tests/reconstruction-lab-regression-correction-browser.ts`는 실제 production Lab과 파이프라인/renderer를 사용한다. 기준선은 저장 보고서, 초기 후보는 저장된 `model.understanding`을 현재 API의 reuseReport+override로 재생한다. 이 API가 붙이는 correctionOfRunId는 초기 **표시 복사본에서만** 제거해 후보 열에 넣고, 실제 반환 보고서는 별도로 그대로 보존한다. 이 하네스를 일반 사용자의 신규 모델 호출 검사로 설명하지 않는다. 스크립트 입력17개는 인간의 최소 입력량·시간 측정이 아니다. 위치/높이는 임시 사용자 역할 값이며 실측이 아니다.

실제 PNG를 직접 보니 세 핵심 종류와 거울-세면대 높이 관계는 알아볼 수 있다. 다만 밝은 도기가 갈색으로 보인다. 기존 DeepLab 색 세면대 `#978370`·변기 `#8a7767`을 그대로 사용하며 최종 appearance 출처는 default다. 색상/출처 개선 필요를 루트에 보고했고 이 테스트에서 색을 바꾸지 않았다. 곡면 볼의 세부 외곽·수전·배관, 가려진 변기 탱크는 원사진과 일치한다고 할 수 없다.

거울장 종류/두께는 미확정이라 일반 거울 하나를 사용자 근사 표현으로 골랐다. 커튼·샤워 트레이·문·선반은 핵심3개 결과에 표현되지 않았고 공통2400mm 공간은 실제 좁은 구도를 재현하지 못한다. 따라서 사용자 보정3개를 자동 인식 성공이나 전체 Before 재현 완료로 보고하지 않는다. 후보 기본 분석기 채택 판단도 바꾸지 않는다.

비공개 증거: [검증 상세](../test-results/reconstruction-lab-regression-correction-20260913/README.md), [verification.json](../test-results/reconstruction-lab-regression-correction-20260913/verification.json), [비교 화면](../test-results/reconstruction-lab-regression-correction-20260913/comparison.html), [실제 보정 PNG](../test-results/reconstruction-lab-regression-correction-20260913/corrected.png). 원사진 저작자/라이선스는 기존 고정 manifest를 유지하며 이번에 새 다운로드나 외부 전송을 하지 않았다. 실행 중 앱 소스 hash도 변하지 않았다.


## 후속 run-02: 거울의 위치 참고 경로

첫 성공 자료와 테스트 원본을 보존한 뒤, 새 UI에서 같은 사례를 **참고 설비 선택 → 위에 위치 맞추기**로 다시 검사했다. `SJN_LAB_ALIGNMENT=1`의 실제 브라우저 첫 실행 exit0. 거울의 수동 위치 체크/설치 방식/벽/u/하단 높이를 다시 입력하지 않아도 앞서 보정한 세면대를 참고해 back/u.28/하단1120mm를 가져왔다. 650mm 하단 + 320mm 모형 전체높이(수전 포함) + 기본간격150mm로 계산한 값이며 실측이 아니다.

교정 스냅샷에는 부모 candidate ID·당시 plan·room·결과 위치와 gapSource=default가 저장됐다. 한 번의 사용자 위치 복사이며 AI 관측 관계나 부모 이동을 따르는 실시간 연결이 아니다. 원 모델 relations와 raw/automaticUnderstanding은 변하지 않았다. 자동0→사용자3개, 규격default, 새AI/외부통신/pageerror0, PNG와 미리보기SHA 일치를 확인했다.

스크립트의 거울 입력5개를 참조 선택/적용2개로 바꾸면서 전체 의미 입력 기록은17→14개였다. 이는 이 하네스에서 정한 이벤트 수 차이이며 인간 최소 입력량/완료시간을 측정한 수치가 아니다. 기본 간격150을 그대로 두고 실제 PNG를 확인했으며 거울은 세면대 중심 위에 위치하고 잘림·겹침이 보이지 않았다. 사진의 정확한 상대높이·벽 구도와 같다고 주장하지 않는다. 색상 및 다른 설비 누락 한계는 그대로다.

[run-02 상세](../test-results/reconstruction-lab-regression-correction-20260913/run-02-alignment/README.md), [검증 JSON](../test-results/reconstruction-lab-regression-correction-20260913/run-02-alignment/verification.json), [새 실제 PNG](../test-results/reconstruction-lab-regression-correction-20260913/run-02-alignment/corrected.png), [이전 입력 방식과 비교](../test-results/reconstruction-lab-regression-correction-20260913/run-02-alignment/comparison.html). 루트 전역 검사는 브라우저 종료 후 별도로 실행하며 이 문서에서 미실행 결과를 앞서 기재하지 않는다.


## 후속 run-03: 위치 참고 정보의 실제 프로젝트 저장

2026-09-14 한국 시간, 새 `SJN_LAB_SAVED_ALIGNMENT=1` 모드에서 같은 위치 참고 결과를 실제 **이 결과로 공간 만들기** 버튼으로 저장했다. 프로젝트 `9db75260-cd5b-4167-8748-063ffc2399b0`를 IndexedDB에서 읽고 `readLabProjectReport`로 복원한 뒤 페이지 새로고침 후에도 다시 확인했다. Lab 목록은 비워졌지만 저장 프로젝트와 원 보고서는 유지됐다.

거울의 `positionReference` 전체—부모 candidate ID와 당시 plan, 기본간격150mm/gapSource=default, 방 크기, back/u.28/하단1120mm 결과—가 그대로 보존됐다. 원 모델/원문/자동 이해도 불변이고 Before3개/After빈 상태다. 실제 저장은 LabProjectAction에서 수행했고 하네스에는 읽기 helper만 추가했다. 새 AI·외부통신·페이지 오류는0, PNG는 run-02와 동일했다.

브라우저 첫 실행 exit0. 테스트 예약 변수명으로 생긴 초기 lint 오류는 변수명만 고친 뒤 scoped lint와 이 테스트 전용 타입검사 exit0으로 확인했다. 생산 코드를 수정하거나 기존 글로벌 검사/빌드를 반복하지 않았다. 이 결과는 사용자 참고 스냅샷의 저장 호환성 검증이며 원래 전체 재현 품질의 한계는 그대로다.

[run-03 상세](../test-results/reconstruction-lab-regression-correction-20260913/run-03-savedalignment/README.md), [검증](../test-results/reconstruction-lab-regression-correction-20260913/run-03-savedalignment/verification.json), [저장 프로젝트](../test-results/reconstruction-lab-regression-correction-20260913/run-03-savedalignment/stored-project.json), [재로드한 원 보고서](../test-results/reconstruction-lab-regression-correction-20260913/run-03-savedalignment/read-lab-project-report.json), [scoped 검사](../test-results/reconstruction-lab-regression-correction-20260913/run-03-savedalignment/scoped-checks.json).
