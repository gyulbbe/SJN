> 과거 검증 기록: 이 문서에서 사용한 옛 Lab 화면·관련 UI와 해당 화면 재생 스크립트는 2026-09-16 소스 정리에서 제거했습니다. 아래 결과와 명령은 당시 기록이며 현재 실행 가이드가 아닙니다.

# 사용자 확인 높은 유리 지지면 — 2026-09-13

이번 변경은 욕조 테두리나 샤워 턱 위에 유리를 놓는 **사용자 보정** 기능이다. 새 모델 추론이나 사진 속 높이 측정 성공으로 집계하지 않는다. 이전 저장 관측과 이전 PNG는 보존했다.

## 동작과 저장

- Lab 설비 보정에서 유리 파티션을 선택하고 바닥 좌표의 수동 위치를 켠다. `유리 지지면`을 욕조 테두리 또는 샤워 턱으로 바꾸고 바닥에서 지지면까지 높이를 입력한다. 아무 값도 입력하지 않으면 적용할 수 없다.
- `support: {kind: 'bath-rim' | 'shower-curb', heightMm, provenance: {kind: 'user', height: 'user' | 'default'}}`를 시리얼라이즈한다. UI에서 직접 입력한 높이는 `user`, 사용자 확인한 제안 기본값을 전달하는 경우만 `default`를 보존한다. 설비 자체 높이의 기본값 출처와 구분한다.
- `baseHeightMm`는 지지 높이와 같아야 한다. 이 필드가 없는 이전 자료의 모습과 바닥 규칙은 그대로다. 일반 변기·욕조·세면대에 이 메타데이터를 붙여 공중 배치를 허용하지 않는다.
- 높은 지지는 version 2 유리 파티션·바닥 좌표에만 허용한다. 1mm 초과 하단 불일치, 유효하지 않은 종류/출처/높이, 천장·방 경계 초과는 거절한다. 명시 지지면이 있는 모형은 생성 단계에서 자동 축소하거나 이동하지 않는다.
- 지지면은 사용자가 확인한 **독립 높이**다. 욕조·턱의 새 모형을 생성하지 않고, 실제 지지 물체의 폭/범위·상판·충돌·접촉을 검증하거나 부모 자산을 연결하지 않는다. 욕조를 움직여도 유리가 자동 이동하지 않는다. 수치와 규격은 실측 결과가 아니다.
- PNG와 실시간 표준 모형은 기존 동일 물리 변환의 `baseHeightMm`를 사용한다. 지지 타입이 메시 형상을 바꾸지는 않는다. UI/확인 문구는 PNG에 포함되지 않는다.
- Supabase 문서 스키마에 타입·출처·종류·버전·높이 일치 및 바닥 좌표 교차 검증을 추가했다. 실제 서버 연결/배포 검사는 수행하지 않았다.

## 수정 경로

`types.ts`·`raised-glass-support.ts`에서 공통 형식과 엄격한 검사를 정의한다. `source-camera.ts`는 확인된 지지 높이를 접촉 기준으로 쓰며 나머지 경계 검사를 유지한다. `candidate-pipeline.ts`는 수동 입력만 전달하고 확인 이유를 남긴다. `index.ts`는 저장 메타데이터를 보존하고 잘못된 지지·규격을 자산 저장 전에 거절한다. `lab-correction.ts`·`lab-manual-placement.ts`와 `ManualPlacementEditor`는 입력/확정 스냅샷/복원 및 벽 기준 거리와의 조합을 연결한다. Lab 전체 화면과 프로젝트 Before 속성 연결은 상위 통합 작업에서 담당했다.

## 단위검사

6개 파일 **123개 통과**: 새 `reconstruction-raised-support` 21, 기존 생성 9, 수동 위치 9, 카메라 40, 후보 파이프라인 31, design-storage 13. 검사 항목은 일반 바닥 제품의 잘못된 상승 거절, 두 지지 타입, 잘못된 출처·높이·버전·벽 면 거절, 천장과 좌우 경계, 규격 자동 축소 금지, 원본/불변 버전 보존, 명시 해제, Before undo/redo, 시안 복제 독립성, IndexedDB 저장 재읽기와 서버 스키마이다. IndexedDB 단위는 fake-indexeddb 환경이며 실제 서버 검증이 아니다. 관련 파일 ESLint 통과. 직접 `tsc`에는 작업 중 `.next/types/routes.js`의 생성 export 오류 4개가 있어 생성물을 수정하지 않고 최종 통합 typecheck는 상위 작업에 맡겼다.

## 실제 저장 관측을 이용한 브라우저 검증

기존 실제 `after-partial-wall` 분석 보고서 및 일치하는 원본 JPEG SHA-256를 사용했다. 초기 보고서만 하네스에서 재생하고, 사용자 보정 제출 후 실제 production 파이프라인과 표준 PNG 렌더러를 실행했다. 모의 AI 응답으로 인식 성공을 만들어낸 검사가 아니다. 새 AI POST·Worker·외부 통신·브라우저 영속 저장은 차단했고 모두 0이었다. 아래 시간은 Chrome headless + SwiftShader에서 모형 준비와 PNG까지의 이번 보정 처리 구간이며 인간 입력 시간/모델 추론 시간과 다르다. 상위 작업의 컴파일 등과 경합 가능성이 있어 성능 보장 수치로 쓰지 않는다.

| 입력/범위 | 결과 | 모형 준비 | PNG 렌더 | 총 보정 처리 |
|---|---|---:|---:|---:|
| user-01 / 실제 RunFindings UI | 욕조 테두리 600mm 유리 포함 6개. 반사 후보 1개는 보류 유지 | 1.073초 | 1.383초 | 2.456초 |
| user-03 / 전체 Lab UI | 샤워 턱 100mm 유리 + 사각 기둥 세면대 + 열린 변기 + 거울, 총 4개. 종류 미확정 수전 후보는 보류 유지 | 0.981초 | 1.235초 | 2.216초 |
| user-04 / 전체 Lab 회귀 | 두 둥근 볼 하부장·열린 변기·거울·창 4개 유지 | 0.958초 | 1.458초 | 2.417초 |

원 모델 원문/automaticUnderstanding와 기준선 보고서는 동일했고, 지지면 종류/높이는 사용자 스냅샷에만 추가됐다. 적용 후 입력 복원에서 두 지지값이 유지됐다. user-03/04는 표시 Blob과 다운로드 PNG SHA-256 일치도 확인했다. 전체 UI 조작 로그 수는 user-01 46, user-03 33, user-04 27이며 실제 사람의 최소 수정 횟수/완료 시간은 아니다.

생성 PNG를 육안 확인했다. user-03 유리는 바닥 위에 떠 있는 지지 높이 100mm를 유지하며 뒤쪽 타일이 보인다. 턱 모형을 별도 생성하지 않으므로 화면에는 지지 구조물이 없다. user-01은 기존 기능시험 방향 90°를 그대로 써 유리가 좁은 옆면으로 보인다. 유리 하단은 600mm, 전체 높이는 1800mm로 보존돼 방 기본 높이 2400mm와 맞으며, 이를 원사진 방향 복원 개선으로 보고하지 않는다.

## 증거

- 공통 경로: `test-results/reconstruction-raised-support-20260913/`
- user-01: `user01.mjs`, `user-01/corrected.json`, `user-01/corrected.png`, `user-01/verification.json`, `user-01/comparison.png`. 소스 파일 SHA 목록 포함.
- user-03/04: `full-lab-user03-04/user-03/`와 `user-04/`의 `corrected.json`, `corrected.png`, `records.json`, `verification.json`, `comparison.png`.
- 재현: `node test-results/reconstruction-raised-support-20260913/user01.mjs user-01` 및 출력 경로를 새로 지정한 `node tests/run-browser-test.mjs tests/reconstruction-manual-user34-browser.ts`.
- 이전 유리 보류 결과 `reconstruction-manual-ui-user01-02` 및 `reconstruction-manual-ui-user03-04/run-04`는 그대로 보존했다.


## 실제 Before 속성과 브라우저 저장 추가 검사

`tests/reconstruction-raised-support-properties-browser.ts`도 통과했다. 테스트용 표준 유리 한 개를 실제 생성하고 production `ReconstructionProperties`를 Before 상태에 연결했다. 욕조 테두리 선택 시 기본 600mm(`default`) → 높이 500mm 직접 수정(`user`)에서 지지 높이와 모형 하단이 함께 바뀌었다. Before undo는 600mm/default로, redo는 500mm/user로 복원됐다. **실제 브라우저 IndexedDB**에 저장하고 다시 읽어 에디터에 재로딩한 뒤 선택값과 500mm가 유지됐다. After는 빈 상태였다.

바닥 직접 설치 선택 시 support 해제 + 하단 0, 샤워 턱 선택 시 기본 100mm, 이후 종류를 변기로 바꾸면 support 필드와 선택 UI가 제거되고 하단 0으로 저장되는 것까지 검사했다. 런타임 오류 0, 로컬 하네스 외 요청 0. 이는 합성 테스트 설비를 사용한 UI/저장 검사이며 사진 인식 성공이 아니다. 증거: `test-results/reconstruction-raised-support-20260913/before-properties/verification.json`, `raised-form.png`, `kind-changed.png`.

**남은 품질 문제:** user-03의 지지 턱이 실제 모형으로 존재하지 않으므로 유리가 떠 있는 것처럼 보인다. user-01도 특정 욕조 테두리에 접속한 것이 아니라 독립 확인 높이를 쓴다. 따라서 4/4 또는 6/6 모형이 배치됐다는 수치는 원본 공간을 완성도 있게 재현했다는 뜻이 아니다. 실제 지지물의 위치·폭·두께·상판 범위와 연결 관계를 보존하는 모델은 후속 작업이다.


후속 변경: [샤워 턱 표준 모형](reconstruction-shower-curb.md)은 명시적으로 추가한 `support.curb`가 있는 샤워 턱에 실제 받침 형상을 제공한다. 이 문서의 이전 검증 이미지와 높이만 자료는 그대로 보존했다. 욕조 테두리의 실제 욕조 연결 한계는 유지된다.
