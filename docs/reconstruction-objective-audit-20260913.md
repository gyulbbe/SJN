# 사진 → Before 재구성 목표 완료 감사 — 2026-09-13

> 최신 후속 상태는 [현재 상태와 검증](reconstruction-current-status-20260913.md)을 읽는다. 아래 표는 이전 소스와 당시 증거의 역사적 감사이며, Lab 저장·높은 유리 지지·욕조 연결의 현재 부재를 뜻하지 않는다. 전체 자동 재현 품질은 아직 완료로 판정하지 않았다.

> 후속 상태: [유리 지지 높이·실험실 프로젝트 저장 통합 검증](reconstruction-support-project-results-20260913.md). 아래 감사 이후 명시적 저장 연결과 높은 지지면 입력, 실제 브라우저 저장/재진입, 1,036개 단위·타입·순차 빌드 검증이 추가됐다. 아래의 bridge 부재·유리 보류·검사 대기는 당시 기록이다. 자동 배치 기하와 실제 지지 형상은 여전히 미완료다.

이 문서는 사용자가 제공한 `pasted-text-1.txt`의 명시 요구사항을 구현과 현재 보존된 증거에 대조한 감사다. 소스 동결 중 수행한 읽기 조사이며, 코어 수정·신규 AI 실행·빌드·테스트 실행은 하지 않았다. 최종 8장 재평가, lint·타입·994개 단위 테스트·순차 빌드 및 개발 사진 4장 수동 보정의 보존 결과를 읽어 갱신했다. 실제 앱에서 별도로 실행 중인 4개 E2E는 아직 대기다. 뒤에 생성되는 결과는 이 문서가 자동으로 검증한 것으로 취급하지 않는다.

**종합 판정: 목표 전체는 미완료다.** 관측 목록 보존, 중복·관계 검증, 독립된 형태/지지 모형, 부분 벽 관측, 최소 보정 UI, 상태·실패 진단은 구현과 제한된 검증 근거가 있다. 최종 자동 후보는 43개 중 1개만 배치했고 정리 후 41개는 확인 필요다. 저장 관측을 이용한 사용자 역할 UI 보정은 핵심 조립체 17개 중 15개를 표현했지만 욕조 테두리·샤워 턱 위 유리 2개는 미지원이다. 사람의 최소 보정 비용과 실제 프로젝트 Before 저장·새로고침·시안까지의 연결은 미완료다. 후보 분석을 기본으로 채택할 근거도 부족하다.

## 판정과 증거의 범위

- **구현 확인**: 실제 코드 경로가 있다. 실제 사진 품질이 확인되었다는 뜻은 아니다.
- **범위 내 검증**: 지정한 단위/합성/실제 사진/브라우저 조건에서 근거가 있다. 그 밖의 사례나 현재 소스 전체로 확대하지 않는다.
- **부분 검증**: 요구사항 일부만 실제로 확인됐다.
- **미완료/대기**: 연결 경로가 없거나, 요구한 최종 증거가 아직 없다.
- 테스트 파일의 존재와 과거 실행 통과는 구분했다. 합성 응답, 저장 응답 재생, 새 실제 모델 실행, 명시적 사용자 보정은 서로 다른 결과다.

감사한 현재 버전 상수는 `src/lib/reconstruction/lab-engine.ts`의 `deeplab-observed-v5-basin-rim-2026-09-13` 및 `structured-scene-v5-installation-review-1`이다. 이전 보고서 숫자는 이 버전의 신규 실행 결과로 전용하지 않는다.

### 주요 증거 묶음

| 식별자 | 근거 | 검증한 것과 한계 |
|---|---|---|
| E0 | [원 진단](../test-results/user-reconstruction-review-20260913/diagnosis.md), 같은 폴더 `report-summary.json` | 네 개발 사진의 문제 출발점. 당시 기존 분석은 주 세면대를 네 장 모두 찾아 배치했다. 모든 문제를 세면대 검출 실패라고 일반화할 수 없다. |
| E1 | [부분 벽 단계 결과](reconstruction-partial-wall-results-20260913.md), `test-results/user-reconstruction-improvement-20260913/after-partial-wall/` | 기존 8장 실제 앱 분석·이미지와 당시 테스트. 현재 형태/설치/진단 변경 전 증거를 포함한다. |
| E2 | [세면대 모형 문서](reconstruction-basin-models.md), [형태 관측 결과](reconstruction-basin-observation-results-20260913.md) | 형태·지지·볼 수 독립 모형. 후자는 원본 JPG의 실제 관측 성분을 재생한 RGB 보완 검증이며 앱의 정규화 JPEG 전체 재실행과 다르다. |
| E3 | [관측 재사용 진단 재생](../test-results/reconstruction-observed-reuse-diagnostics-20260913/README.md), 같은 폴더 `summary.json` | 저장된 실제 8장 출력을 새 AI 없이 재생. 진단 전후 판단·좌표 동일, 실패 근거 전달 확인. 실제 브라우저를 새로 실행하거나 정확도를 개선한 평가가 아니다. |
| E4 | `test-results/reconstruction-photo-map/verification.json`, `reconstruction-lab-relations/verification.json`, `reconstruction-wall-distance-ui-20260913/verification.json` | 실제 브라우저의 선택·관계·벽 거리 기능, 모바일·키보드·원본 보존. 지정 입력을 통한 기능 시험이며 사진 속 실제 치수나 자동 인식 정답이 아니다. |
| E5 | `test-results/reconstruction-wall-reference-app-20260913/`의 `actual-ui-verification.json`, `test-results/reconstruction-partial-wall-ui-actual/` | 한 실제 사진의 로컬 후보 모델 실행 후 AI 추가 호출 없이 보정·스냅샷 복원, 기존 프로젝트 별도 E2E. 네 사진 전체 보정 완료/프로젝트 이관의 증거가 아니다. |
| E6 | `test-results/reconstruction-installation-shape-20260913/additional-regression/summary-all.json`, 같은 상위 폴더 `additional-regression-manifest.json` | bath-20/22/27/31의 **baselineOnly:true** 실행. RGB 변경 개발에 쓰지 않은 기존 평가 사례이며, 전 작업에서 처음 보는 데이터셋은 아니다. 후보 엔진 결과는 없다. |
| E7 | `tests/reconstruction-*.test.ts`, `e2e/reconstruction*.spec.ts`, E1/E2/E3의 실행 기록 | 회귀 항목의 구현된 테스트와 지정 시점의 통과 근거. 환경변수로 실제 사진 테스트가 생략될 수 있으므로 선언만으로 실행 통과를 인정하지 않는다. |
| E8 | [수동 검증 시나리오](../test-results/reconstruction-manual-scenarios-20260913/README.md), 같은 폴더 `scenarios.json` | 원본 사진을 보고 준비한 4장 사용자 역할 시나리오. 실제 치수·좌표 정답이나 실행 완료 증거가 아니다. 핵심 설비 조립체 17개(6/3/4/4). |
| E9 | `test-results/user-reconstruction-improvement-20260913/after-installation-shape-final/summary-all.json` 및 각 사진 baseline/candidate JSON·PNG | 최신 실제 앱 분석 8장 완주. codeHash `7dda8bf3e973c87e141fa6a540c667ab6d81d1645ffb4289f83b540342360f4e`. 모두 응답 stop·errors=[]·external=[]이나 자동 후보 배치는 1개뿐이다. |
| E10 | `test-results/reconstruction-installation-shape-20260913/checks-final.json`, `test-final.log` 등 | 최신 lint/type/test/Next/vinext exit 0. 단위 994개/86파일과 순차 빌드를 확인했다. 실제 사진 품질의 성공 판정은 아니다. |
| E11 | [user01/02 보정 결과](../test-results/reconstruction-manual-ui-user01-02/README.md)와 각 verification/corrected JSON·PNG | 기존 실제 after-partial-wall 관측을 현재 RunFindings에 전달한 사용자 역할 자동화. 생성·스냅샷 실제 함수 사용, AI/Worker/IndexedDB 0. 파일 업로드→분석·PNG 다운로드 버튼·프로젝트 저장은 이 하네스 범위 밖이다. |
| E12 | [user03/04 보정 결과](reconstruction-manual-user34-results-20260913.md), `test-results/reconstruction-manual-ui-user03-04/run-04/` | 실제 ReconstructionLab의 첫 두 분석 결과만 기존 보고서로 재생, 그 뒤 실제 교정·스냅샷·렌더·다운로드. 새 모델 평가나 프로젝트 저장 검증이 아니다. |
## 명시 요구사항별 감사

### 1. 문제 범위와 기본 분석기

| 요구사항 | 증거·구현 | 검증 범위 / 미완료 |
|---|---|---|
| 기존 변경을 보존하고 원 진단과 현 코드를 대조 | E0~E3, `candidate-pipeline.ts`, `observed-placement.ts`, `lab-engine.ts` | 부분 벽·열린 뚜껑·사진 선택기·스냅샷을 유지하는 방향은 확인. 최신 lint·타입·86개 파일 994개 단위 검사와 순차 빌드는 통과했다(E10). 별도 실제 앱 E2E 4개는 대기다. |
| 표준 모형으로 종류·형태·설치 관계를 알아볼 수 있게 재구성 | `candidate-pipeline.ts`, 표준 모형 생성/렌더 코드, E1/E2 | 모형 표현 가능성과 일부 관측 개선은 확인. 최신 자동 결과와 사용자 보정 PNG는 있다(E9/E11/E12). 사용자 핵심 표현은 5/6·3/3·3/4·4/4이며 유리 2개가 남아 전체 품질 완료는 아니다. |
| 사진 붙이기·사진별 좌표 하드코딩 금지 | `reconstruction-standard-render.test.ts`는 거울/창에 원본 사진을 붙이지 않는 모형을 검증. E2 RGB 규칙은 관측 성분 기반 | E8의 사용자가 입력할 임시 위치·기본 규격은 기능 확인용이며 앱 규칙에 반영하면 안 된다. 원본 사진 전체를 표준 모형 결과로 대신하는 방식은 완료로 인정하지 않는다. |
| 후보 분석을 즉시 기본 엔진으로 교체하지 않음 | 일반 프로젝트 생성은 DeepLab, 후보는 lab의 명시적 선택. `reconstruction-pipeline-integration.test.ts` | 구현 확인. 현재 후보 자동 배치 성과는 기본 채택의 근거가 되지 못한다. |

### 2. 인식·관계·배치·모형의 단계 분리

| 요구사항 | 증거·구현 | 검증 범위 / 미완료 |
|---|---|---|
| 사진→관측 목록→관계 정리→설치 추정→모형 생성 | `inventory-observation.ts`, `scene-understanding.ts`, `candidate-resolution.ts`, `candidate-pipeline.ts` | 단위 테스트와 저장 출력에서 단계별 데이터 존재. 단계 분리가 자동 설치 관측의 충분성을 보장하지는 않는다. |
| 종류·사진 범위·형태/부품·지지/벽·근거/출처·확정/추정/미확인 유지 | 이해 결과, resolution, placement, modelPlans 및 보정 필드별 출처 | unknown/default/inferred/user를 표현할 수 있다. 현재 compact inventory-v2는 설치 벽·접점 자체를 수집하지 않으므로 해당 값이 unknown인 것은 계약의 실제 한계다. |
| 배치 상태/이유와 원응답→보정 추적 분리 | `lab-report.ts`, 수동 입력/스냅샷, `observedPlacementChecks`, E3/E5 | 원본 보존과 재사용 진단의 warning/placement trace 전달 확인. 보정 데이터의 **프로젝트 영속 저장**은 기존 기능 보존 실패가 아니라, 최소 보정 결과를 실제 Before로 사용하는 흐름의 별도 미완료다. |
| 기하 부족에도 인식 목록 보존, 가능한 항목만 배치 | `reconstruction-candidate-pipeline.test.ts`, `reconstruction-partial-wall.test.ts`, E1/E3 | 8장 저장 재생에서 43개 후보를 잃지 않고 최종 1개만 배치하는 동작은 확인. 목록을 보존한 것을 재구성 품질 성공이라고 할 수 없다. |
| 좌표를 임의 생성해 성공으로 표시하지 않음 | 소스 카메라/모형 범위/관측 재사용 테스트 | 밖으로 벗어난 점·몸체를 보류하고 임의 clamp/축소하지 않는다. 실제 측정이 없는 수동 입력은 사용자 확인 또는 기본값이어야 한다. |

### 3. 중복·충돌·부품·반사와 오류 격리

| 요구사항 | 증거·구현 | 검증 범위 / 미완료 |
|---|---|---|
| 같은 종류/위치 반복 및 거울·거울장·창 종류 충돌 검사 | `reconstruction-candidate-resolution.test.ts`, `reconstruction-candidate-pipeline.test.ts` | 합성 사례에서 중복/충돌 분리·원 ID 보존·보류 확인. 실제 8장 인식 수는 raw 43과 organized 42를 구분해야 한다. |
| 유리 앞/욕조 뒤의 실제 겹침 보존 | resolution/pipeline/scene-understanding 테스트 | 단순 bbox 겹침으로 삭제하지 않는 단위 근거가 있다. user-01·03 유리의 실제 설치 완료는 아직 별도 검증이 필요하다. |
| 세면볼/하부장 부품 관계와 반사를 구분 | scene-understanding/resolution 테스트, E4 관계 UI | 부품 연결·반사 해제·실물 확인 기능 확인. user-02 실제 거울을 모델이 반사로 잘못 분류한 saved 결과처럼 자동 관계의 오류는 남는다. |
| 애매한 충돌은 확인 대상으로 유지 | resolution 및 lab 보정/설치 테스트 | 위치만 보정해 종류/반사 충돌을 자동 해소하지 않는 범위 확인. 4장 UI 보정의 동작 로그는 확인했다(E11/E12). 하네스 이벤트 수는 인간의 최소 클릭 수가 아니며, 유리 2개는 확인해도 지원되지 않는다. |
| 의미 오류 후보 격리, 정상 후보 보존; 손상 JSON 임의 복구 금지 | `reconstruction-scene-understanding.test.ts`의 quarantine/invalid JSON 사례 | 구조적으로 유효한 응답의 일부 의미 오류와 전체 파싱 실패를 구분한다. 단위 결과를 실제 모델 무실패로 보고하면 안 된다. |
| 간결한 관측 출력과 제한된 재시도 | inventory-v2 prompt/schema, scene-understanding 테스트, E1 raw/진단 | 이전 8장 실제 출력은 종료 stop, 약 290~585 토큰으로 단축된 범위. 출력 단축은 확인되지만 설치 근거를 제외한 대가가 있다. 새 자동 retry를 추가하지 않았다는 사실을 무한 재시도 검증으로 과장하지 않는다. |

### 4. 세면대 형태·지지·부품

| 요구사항 | 증거·구현 | 검증 범위 / 미완료 |
|---|---|---|
| 사각/곡면과 벽걸이/기둥/상판/하부장을 독립 표현 | `reconstruction-basin-shape.test.ts`, 표준 모형/렌더 테스트, E2 | 사각 기둥형·곡면 벽걸이 등 모형 생성과 사용자 형태 전환은 확인. 사진별 자동 형태가 모두 맞는 것은 아니다. |
| countertop 볼 + floor 전체 지지 허용 | scene-understanding/resolution/pipeline의 부품 테스트 | 서로 다른 개체의 기준점을 구분할 때 허용. floor에 세면볼 상판 접점을 놓는 잘못된 응답은 여전히 격리한다. |
| 볼 수의 관측/규칙/기본/사용자 출처 구분 | basin-shape/resolution 테스트; E4/E5 | 폭만으로 2개를 새 관측으로 기록하지 않는다. user-04의 기존 baseline 1볼과 후보 item_04의 model 출처 2볼을 구분한다. 최신 후보에도 2볼과 two sinks 근거가 있고, 실제 수동34 결과는 이 값은 유지하고 round 형태만 user로 수정했다. 이전 잠정 감사의 ‘2볼 자동 근거 미충족’ 표현을 정정한다. |
| 관측 형태가 실제 모형에 반영 | E2 렌더 이미지 및 1↔2 볼 형태 전환, 원본 4장 성분 재생 | 원본 JPG 77개 성분 중 user-03 주 세면대 1개만 unknown→rectangular; 나머지 변화 없음. 최종 앱 정규화 JPEG의 user-03 baseline.json도 pedestal/rectangular/1볼을 보존하고 shape=inferred, dimensions=default다. 담당자가 해당 PNG를 육안 확인했다. 다른 사진 전체 형태 정확도로 확대하지 않는다. |
| 기존 문서·불변 자재 버전 호환 | basin-shape, material/repository 검증, 이전 선택 필드 수용 | 로컬/직렬화·오프라인 서버 스키마 근거가 있다. 실제 Supabase 연결 실행은 검증하지 않았다. 기존 폭 기반 legacy 모형과 새 명시 볼 수를 구분해야 한다. |

### 5. 설치 벽·높이·공간 기하와 최소 보정

| 요구사항 | 증거·구현 | 검증 범위 / 미완료 |
|---|---|---|
| 사진 좌우와 설치 벽 분리; 원본 카메라와 공통 Before/After 카메라 분리 | source-camera/supported-placement/candidate-pipeline 테스트 | `appearance region`을 실측 벽으로 재사용하지 않는다. 수동 표준 공간 배치는 source-camera 복원 성공이 아니다. |
| 비어 있는 roomLayout에 임의 직각 공간/모서리를 넣지 않음 | scene-understanding/source-camera 테스트, inventory 변환 | 8장 inventory의 빈 기하와 camera-held 상태를 유지. 이 때문에 후보가 대부분 보류되며, 해결됐다고 보고할 수 없다. |
| 기존 영상의 재사용 가능한 벽·바닥/접점 활용 | 부분 벽 관측, `inspectObservedPlacement`, E1/E3 | 대응 ID/종류·지지·실제 plane·접점 포함 여부를 통과해야 한다. 재사용 7개 중 모형 범위 검사에서 다시 6개 보류; 재사용 가능=최종 배치가 아니다. |
| 설치 벽/지지/높이/크기/공간 기준의 간단한 사용자 보정 | E4 벽 거리/선택/관계, E5 실제 app 보정 | 저장된 실제 관측으로 네 사진의 보정 UI를 실행했다(E11/E12). 누락 선반 추가·오탐/반사 분류 수정·뚜껑/형태·벽 배치는 검증했지만 유리 2개는 지지 높이 미지원이다. 별도 볼 두 개의 연결은 이 4장 최소 경로에서 실행하지 않았다. 인간의 최소 상호작용/시간은 미측정이다. |
| 복잡한 레이어·마스크·다각형 편집을 다시 넣지 않음 | lab의 사진 선택/행 보정·간단한 관계 조작 | 현재 구현 확인. 직접 사진 접점/기하를 새로 수집하는 개선을 추가하더라도 복잡한 편집 UI 회귀는 피해야 한다. |
| 제품 실제 치수인 척하지 않고 기본/추정/사용자 표시 | 치수 필드별 provenance, wall-relative placement, E4/E5 | 800/1600/100mm 등의 UI 시험 입력은 수학/기능 검증용이다. 원본의 실측값이나 사진 좌표 정답이 아니다. |
| AI 재실행 없이 보정, 원본과 별도 저장 | E5의 실제 모델 요청 1회 후 두 보정, 원본·baseline 불변·스냅샷 복원 | **세션 내 결과와 PNG/JSON 다운로드 범위만 확인**. 보정 결과를 프로젝트 자산과 함께 저장하고 새로고침 후 복원하는 경로는 없다. |

### 6. 실행 상태·진단·재사용·자원 정리

| 요구사항 | 증거·구현 | 검증 범위 / 미완료 |
|---|---|---|
| 실행 중/배치 완료/일부 또는 전체 확인 필요/실패/취소 구분 | `lab-report.ts`, lab 상태 UI, lab 테스트 | 완료 표현과 배치 상태를 구분하는 구현이 있다. 실제 실행 상태가 complete라는 것만으로 사진 재구성 성공을 뜻하지 않는다. |
| raw/정리 후/실제 배치/확인 필요 수 구분 | lab-report의 실배치 fixtureId 확인, resolution | 중복·부품·반사를 배치 성공으로 더하지 않는다. 데이터 집합마다 분모와 제외 이유를 함께 보고해야 한다. |
| 관측/종류·부품/기하/배치/보류·실패 중간 결과 노출 | RunFindings UI, pipeline trace, E3/E4 | 재사용 실패 사유가 기존 공통 camera 사유와 함께 사용자 warning으로 전달됨을 테스트/재생으로 확인. 새 진단 문자열의 실제 UI 화면 캡처는 해당 진단 재생 자체에는 없다. |
| 동일 입력·치수·모델/설정/버전의 baseline 재사용과 단계 기록 | lab-engine/lab, pipeline-integration 재사용 거부/원본 보존 테스트, E5 | 한 실제 후보 실행→보정에서 추가 모델 호출 없음 확인. E9는 고정 codeHash/입력 hash/모델 revision을 보존했고 후보의 baselineAnalysisMs=0, reuse에 원기준선 시간 별도 보존을 확인했다. |
| 전체/기존 분석/추가 모델/배치·렌더 시간 분리 | lab timing/report, E1/E2/E6 | 추가 모델 7~12초를 전체 처리 시간처럼 비교하면 안 된다. 원본 성분 replay 시간도 앱 전체·사용자 완료 시간과 다르다. E11/E12의 교정 엔진 시간은 약 2.25~3.03초, 자동화 입력 이벤트는 47/23/32/27개다. 인간의 최소 보정 완료 시간은 아직 측정하지 않았다. |
| 종료 이유·오류·단계·경과·가능한 토큰/제한/응답 보존 | lab 오류 진단/worker client tests, pipeline-lab injected failure E2E | 실패 주입과 실제 성공 출력 진단의 범위. 실제 모델의 모든 실패 유형이 재현된 것은 아니다. 토큰 값이 없으면 0이 아니라 미제공으로 보고해야 한다. |
| 민감한 사진·raw 응답을 로컬에 보관 | `.gitignore`의 `test-results/`, E4/E5/E6 external=[] | 지정 브라우저 실행의 외부 요청 0과 로컬 artifact 확인. 저장소 전체 비밀 정보 감사나 모든 가능 경로의 네트워크 증명으로 확대하지 않는다. 이 문서에는 원본 사진·raw 응답을 첨부하지 않았다. |
| 취소/실패 자원 정리·늦은 응답 차단 | lab `finally` renderer/memory dispose, worker 종료 경로; pipeline-integration/lab cancellation tests; lab batch E2E | 단위와 지정 브라우저 취소/실패 주입 테스트 근거. 메모리 전체 peak나 모든 장시간 조건의 자원 회수 측정은 없다. |

### 7. 개발 사진 4장 및 별도 회귀

| 사진 | 실제 자동 관측과 사용자 역할 보정 | 결과와 남은 제한 |
|---|---|---|
| user-01 / TEST 화장실.jpg | 기존 주 세면대 존재. 후보의 잘못된 vanity 지지를 wall로 보정하고 사각1볼 model 값을 유지. 사용자 확인 거울수납장, 반사 선반 제외, 실물 선반 수동 추가, 벽·위치 입력. | 핵심 **5/6 표현**. 욕조 테두리 유리는 하단600mm에서 공간 초과0이지만 바닥 미접지로 보류. 높이를0으로 낮춰 성공 수를 채우지 않음. 거울장 수납·실물 선반 추가는 AI 관측 성공이 아니다. |
| user-02 / TEST 화장실2.jpg | 실제 거울 item_03의 reflected→physical 분류 변경, 곡면 round/user·wall지지 유지, 열린 변기 user, 벽·높이 입력. 원본에는 reflectionOf 관계가 없어 이 사례를 관계 해제 시험이라고 부르면 안 됨. | 핵심 **3/3 표현**. 문틀은 보류, 수전·호스·소품/실제 비율·촬영 구도는 미완료. 기준선과 원모델 불변. 후보 최신 실제 실행은 stop/290토큰으로 정상 종료했지만 자동 배치0이다. |
| user-03 / test 화장실3.jpg | 최신 baseline에서 사각 기둥형/inferred 모형 확인. 수동 검사는 기존 candidate의 pedestal+rectangular+1볼 model 값을 유지하고 잘린 변기·거울 위치와 뚜껑을 user로 지정. | 핵심 **3/4 표현**. 샤워 유리 하단100mm는 바닥 미접지로 보류. unknown 수전 유지. 공통 카메라에서 앞 변기가 기둥 일부를 가리며, 잘린 거울의 전체 외곽·실제 치수는 기본 추정이다. |
| user-04 / images.jpg | 최신 자동 후보는 창1개만 배치. baseline1볼과 candidate item_04의 **bowlCount=2/model**을 구분. 수동 결과는 2볼을 유지하고 볼 형태 round만 user, 하부장 floor/설치 벽·위치를 확인. | 핵심 **4/4 표현**. 실제 거울1개·창·변기·하부장; 반사·휴지통을 추가 배치하지 않음. 별도 볼 두 개를 추가/연결한 것이 아니며 사진의 곡면 거울/창 분할·제품 치수·원본 카메라까지 일치하지 않는다. |

- E8 시나리오는 계획이며, 실행 근거는 E11/E12다. 기본 방·기본 제품 규격과 임시 사용자 위치는 실측 정답이 아니다. 핵심 **15/17 조립체 표현**은 사용자 보정 기능 결과이고 자동 검출 분모나 전체 사진 품질 점수가 아니다.
- user01/02는 입력 동작47/23개(유리 제한 재시도 포함), 교정 엔진2.2459/2.2827초, 자동화 전체10.340/5.643초다. user03/04는 이벤트32/27개, 교정 엔진2.838/3.025초, 자동화 전체7.831/6.965초다. 기록 범위가 서로 다르며 인간의 최소 클릭 수·보정 시간은 측정하지 않았다. 새 AI 시간은 모두0이다.
- user03/04는 이전 실패도 보존했다. 하네스 export/details 오류 뒤, run-03에서 vanity에 basin 전용 basinStyle=vanity를 입력해 의미 충돌이 발생했다. run-04는 해당 원필드를 unknown으로 유지하여 지원 범위3/4·4/4를 확인했다. 현재 vanity에도 세면대 전용 지지 필드가 노출되어 사용자를 혼동시킬 위험이 남는다.
- 최종 E9 8장은 user01~04와 bath04/08/12/16의 기존 개발/평가 사진이다. 이미 개발 과정에 관여했으므로 새 독립 평가8장이라고 부르지 않는다. 원본 성분 재생 E2, 저장 응답 재생 E3, 실제 모델 재실행 E9, 사용자 UI 보정 E11/E12를 별개로 유지한다.
- 추가 bath-20/22/27/31은 이번 RGB 규칙 개발에 쓰지 않은 기존 평가 사례다. E6의 **baseline-only** 배치 수0/1/0/2, 시간33.674/30.241/22.106/13.367초. 후보 실행이 없으므로 양 엔진12장 평가 완료라고 보고할 수 없다.

### 8. 기존 프로젝트 기능·회귀·완료 보고

| 요구사항 | 증거·구현 | 검증 범위 / 미완료 |
|---|---|---|
| 사진 Before + 빈 After, 공통 치수·카메라 유지 | 일반 `createReconstructionProject`, `reconstruction-pipeline-integration.test.ts`, 실제 프로젝트 E2E | **일반 DeepLab 프로젝트 경로**의 근거가 있다. candidate lab의 PNG가 실제 저장 프로젝트 Before인 것은 아니다. |
| 저장·새로고침·시안·실행 취소·비교·다운로드 보존 | editor의 projects.save/Before history/DesignManager, reconstruction E2E, 실제 open-toilet/standard E2E의 특정 조건 | 기존 프로젝트 경로와 수동 편집 기능은 존재한다. 보정된 candidate lab 결과에서 이 기능까지 연결하는 통합 경로와 실제 E2E는 미완료다. |
| 기본 벽/바닥 삭제 방지, 가격·견적 수량 임의 추가 금지 | 기존 편집 보호·자재 내역 회귀 | 코드/기존 테스트 범위. 최종 전체 회귀가 현재 변경으로 영향받지 않았는지 확인 필요. |
| TripoSR/제품 배경 제거/새 대형 모델 기본 다운로드/유료 API/사진 외부 전송/배포 금지 | 이번 관측·모형·보정·진단 변경 범위, 후보 opt-in, 지정 브라우저 external=[] | 감사 과정에서는 이 작업을 수행하지 않았다. 최종 변경 파일 목록과 실제 실행 네트워크 기록으로 보존 조건을 확인해야 한다. |
| 명시된 단위 테스트 10개 범주 | 아래 매핑 | 테스트 파일과 과거 부분 통과 근거는 존재. E10의 최신 lint/type 및 86개 파일 994개 unit 통과를 읽어 확인했다. 테스트의 인식 정확도 검증 범위를 넓히지는 않는다. |
| 여러 사진의 실제 브라우저 실행·비교·보정·재시도·다운로드 | lab/batch/pipeline-lab/standard E2E와 E4/E5 | E9는 실제 모델 8장, E11/E12는 저장 보고서 기반 실제 보정 UI다. user01/02 하네스는 다운로드 버튼을 실행하지 않았고 user03/04는 실제 Lab 다운로드를 확인했다. root의 실제 앱 E2E 4개는 별도 대기이며, 프로젝트 연결은 없다. |
| 관련 회귀/lint/타입 + Next→vinext 순차 빌드 | E1의 과거 전체 915 tests/80 files 및 빌드, E2/E3의 후속 부분 검사 | E10 최신 lint/type/test/Next/vinext 모두 exit 0, 994 tests/86 files 통과. Next 67.430초 종료 후 vinext 92.994초를 순차 실행했다. 과거 915/989 및 부분 52를 합산하지 않는다. |
| 원인/파일·사진별 전후·출처·수량/사유·시간/환경·한계·기본 채택 근거 보고 | E1~E6에 분산 | E9~E12를 포함한 이 갱신은 자동/수동과 남은 한계를 정리한다. 사용자 대상 전체 완료 보고와 별도 앱 E2E는 아직 남는다. 자동 관측/규칙 추론/기본/사용자 보정을 나란히 표시하고 누락·오탐을 포함해야 한다. |
| 메모리는 측정한 경우만 보고 | E6 manifest의 memoryScope | 시스템 RAM 33,444,208,640바이트는 용량이지 사용량이 아니다. Page JS heap은 Worker/WASM/GPU를 제외하고 Ollama size_vram은 보고된 모델 할당량이다. 전체 앱 peak memory로 부르면 안 된다. |

요구된 단위 테스트 범주의 코드 매핑:

| 범주 | 대표 파일 |
|---|---|
| 동일 후보 반복/종류 충돌, 유리 뒤 설비, 반사 | `tests/reconstruction-candidate-resolution.test.ts`, `reconstruction-candidate-pipeline.test.ts` |
| 정상 후보 보존/문제 격리, 손상 JSON | `tests/reconstruction-scene-understanding.test.ts` |
| 상판 볼/하부장 부품·기준점 | scene-understanding, candidate-resolution, candidate-pipeline 테스트 |
| 사각 기둥형/곡면 벽걸이/볼 수 실제 모형 | `tests/reconstruction-basin-shape.test.ts`, `reconstruction-standard-render.test.ts` |
| 공간 기하 부족 시 목록 유지 | candidate-pipeline, source-camera, partial-wall, observed-placement 테스트 |
| 사용자 보정과 AI 원본 분리 | `tests/reconstruction-lab-correction.test.ts`, `reconstruction-lab-manual-placement.test.ts`, `reconstruction-pipeline-integration.test.ts` |
| 취소/늦은 응답/오류 진단 | pipeline-integration 및 worker/lab 테스트, `e2e/reconstruction-lab-batch.spec.ts`, `reconstruction.spec.ts` |
| 기존 문서 호환 | basin-shape/toilet-lid/supported-placement 및 repository/material validation 테스트 |

## 실제 프로젝트 경로에서 확인된 경계

다음 경계는 테스트 부족만이 아니라 현재 코드 구조의 차이다.

1. 일반 생성창 `src/components/reconstruction/reconstruction-dialog.tsx:88`은 `createReconstructionProject(...)`를 실행하고 `:106`에서 `getRepositories().projects.create(project)`로 저장한다. 후보 이해/보정 결과를 전달하는 제품 UI 계약은 없다.
2. `src/lib/reconstruction/index.ts`는 내부 `transformAnalysis` 확장점을 갖고 Before와 빈 After의 프로젝트 문서를 만들 수 있다. 하지만 확장점의 존재는 lab 결과를 사용자 프로젝트로 적용하는 경로가 아니다.
3. `src/lib/reconstruction/lab.ts:110`의 반환은 `{ original: Blob, before: Blob, report }`다. `:121`은 IndexedDB/공유 카탈로그/서버 adapter 미생성을 명시하고, 메모리 저장소의 `projects.create/save` 등을 금지한다. `:209`는 프로젝트를 저장하지 않는 실행임을 명시한다. 종료 시 renderer와 임시 자산/버전 저장소를 dispose한다.
4. `src/components/reconstruction/reconstruction-lab.tsx:1327`, `:1333`, `:1370`의 결과 동작은 교정 PNG·JSON 다운로드와 편집 입력 복원이다. 프로젝트 Before 적용, 자산 이관, 프로젝트로 열기 기능은 없다.
5. `e2e/reconstruction-lab.spec.ts:275~277`은 새로고침 뒤 lab-case가 **0개**임을 기대한다. 이 테스트의 보존 대상은 기존 프로젝트 데이터다. lab 보정 결과의 영속 저장 테스트가 아니다.
6. `src/components/editor/editor.tsx:198`은 일반 프로젝트 저장, `:704/:718`은 Before undo/redo, `:1129` 이후는 시안 관리 경로다. 이 기능은 존재하지만 lab 보정 결과에 연결되어 있지 않다.

따라서 현재 정확한 설명은 **“기존 프로젝트 저장/시안 경로를 보존하면서, 실험실 안에서 후보 보정 결과를 미리보고 PNG/JSON으로 보관할 수 있다”**이다. “보정 결과를 Before로 저장하고 새로고침·시안까지 검증했다”는 주장은 근거가 없다.

원문이 특정 이름의 ‘가져오기 버튼’을 요구한 것은 아니다. 다만 후보 개선이 실제 프로젝트의 사진→Before 결과로 사용될 때까지 완료 범위를 잡는다면, 명시적 opt-in 적용/생성 등의 연결과 그 통합 검증이 필요하다. 이 연결을 추가하더라도 후보를 기본 분석기로 바꿀 필요는 없다. 기존 일반 프로젝트 회귀 보존과 이 신규 연결 완료는 별도로 판정해야 한다.

## 자동 배치가 거의 없는 실제 원인과 진단의 의미

`fixture-inventory-v2`는 종류·bbox·view·세면대 속성·짧은 관측 중심의 계약이다. 설치 벽, 접점, 공간 모서리, 원본 카메라와 실제 치수는 이 출력으로 받지 않는다. 파싱 후 설치 벽 unknown, 앵커 없음, 기하 없음으로 남기므로 단순히 형식 검증이 통과해도 source-camera 배치를 해결할 정보는 생기지 않는다. 사진의 left/right 표현이나 자유 서술을 임의의 실제 벽·mm·좌표로 읽어 메우면 안 된다.

E3에서 raw 후보 43개 중 직접 관측 재사용 시도는 36개였다. 첫 분기는 matching 없음 18, 잘림 3, 지지 불일치 1, 관측 plane 없음 4, 접점 plane 밖 3, 재사용 성공 7이다. 나머지 7개는 반사/unknown/충돌 등으로 재사용 미시도다. 재사용 7개도 이후 표준 모형 범위 검사에서 6개가 탈락하여 최종 배치는 1개다. 이들은 서로 다른 원인이므로 모두 “원본 카메라 부족” 한 문장으로 끝내면 사용자 보정에 필요한 정보를 놓친다.

user-01 욕조 item_03의 접점은 원본 **399×501px**에서 source-floor 윗경계 밖 **0.8215436619913067px**다. 진단은 실제 탈락 지점을 드러냈지만 임계값·영역·접점·모형 좌표를 바꾸지 않았다. 이 수치는 실측 mm, 카메라 재투영 오차 또는 허용오차가 아니다. 약 0.82px라는 이유만으로 안전하게 안쪽으로 옮길 수 있다고 결론 내릴 수 없다.

다음 개선 검증은 출력 문법을 다시 길게 만들기보다, 관측 대상 일치와 잘림, 물체의 실제 지지/접점 역할, 재사용 가능한 물리 벽·바닥 영역을 각각 확인해야 한다. 모델 bbox, 바닥 앞쪽 접점, 모형 중심, 벽 설치 기준점을 섞지 않는 것이 전제다. 현재 추가된 진단은 이 판단을 가능하게 하는 근거이며 자동 재구성 실패를 해결한 결과는 아니다.


### 최신 결과를 반영한 감사 상태

E9 실제 8장 실행은 동일 codeHash `7dda8bf3e973c87e141fa6a540c667ab6d81d1645ffb4289f83b540342360f4e`로 완주했다. 각 결과의 `status=complete`, errors/external 빈 배열을 확인했고 실제 모델 응답은 모두 done/stop이다. 담당자가 실행 종료 코드0을 확인했다. 이는 정상 종료의 근거이며 인식/배치 품질이 완성됐다는 뜻이 아니다.

| 사진 | raw / 정리 / 배치 / 확인 필요 | 기준선 실행 초 | 기준선 재사용 후 후보 실행 초 | 후보 중 실제 추가 모델 초 |
|---|---:|---:|---:|---:|
| user-01 | 6 / 6 / 0 / 6 | 27.209 | 9.436 | 8.390 |
| user-02 | 4 / 3 / 0 / 3 | 14.094 | 7.987 | 6.847 |
| user-03 | 5 / 5 / 0 / 5 | 33.203 | 8.428 | 7.415 |
| user-04 | 4 / 4 / 1 / 3 | 42.016 | 9.320 | 7.463 |
| bath-04 | 7 / 7 / 0 / 7 | 33.642 | 10.584 | 9.243 |
| bath-08 | 5 / 5 / 0 / 5 | 31.180 | 8.529 | 7.479 |
| bath-12 | 4 / 4 / 0 / 4 | 32.469 | 7.897 | 6.853 |
| bath-16 | 8 / 8 / 0 / 8 | 31.936 | 10.812 | 9.792 |
| 합계 | **43 / 42 / 1 / 41** | — | — | — |

카운트는 각 `execution.counts`를 읽었다. raw 보류 placements 행을 단순 합산하면 배치 대상에서 제외된 반사까지 포함하므로 사용자 표시 확인 필요41개와 혼동하면 안 된다. 후보 실행 시간은 `timing.totalMs`이며, baseline 재사용 때문에 해당 실행의 baselineAnalysisMs는0이다. 별도 기준선 실행 시간을 포함하는 전체 사진→비교 시간과 동일하지 않다. 추가 모델은 후보 시간의 일부이고 배치/준비·렌더도 따로 보존되어 있다.

환경은 Windows, Ryzen7 7800X3D, Headless Chrome152.0.7977.83, SwiftShader, TFJS WASM single-thread, Qwen3-VL4B q4_K_M/revision `ee4b975b...`이다. 출력은290~585토큰, 제한4096, prompt revision8이다. 모델 VRAM 샘플4,235,345,264바이트는 Ollama가 보고한 할당량이며 시스템 전체 peak 사용량이 아니다. 같은 PC에서 다른 검증 작업도 수행한 조건이므로 독점 벤치마크가 아니다.

최종 user-03의 baseline.json은 `basinVariant=pedestal`, `basinShape=rectangular`, `bowlCount=1`, shape/mounting=inferred, dimensions=default다. 담당자가 정상 앱 입력 경로의 PNG에서 사각 볼과 기둥을 육안 확인했다. 앞선 원본 JPG 성분 재생 결과만으로 최종 앱 효과를 주장했던 상태를 넘었으나, 공간/사진별 전체 정확도는 여전히 부분적이다.

최신 검사 E10은 lint18.901초, typecheck5.389초, test8.758초 모두 exit0이다. test-final.log의 실제 결과는 **86파일/994개 통과**다. Next build가11:06:03Z 시작해67.430초 후 끝났고, vinext는11:07:11Z 시작해92.994초 후 exit0으로 끝나 순차 실행을 확인했다. 과거 전체989개(뚜껑 보정 전), 별도 관련52개, 더 이전915개를 이 수치에 합산하지 않는다.

앞선 `after-installation-shape/` 실행은 7개 시점의 lab 뚜껑 UI 수정으로 source hash 변경을 감지하고 종료1로 중단됐다. 그 실패 자료는 보존하고 최종8 완주에 섞지 않는다. 최신 완주 근거는 `after-installation-shape-final/`이다.

별도로 root가 실제 앱에서 수행 중인 4개 E2E는 **아직 대기**다. 이 문서의 수동4사진 결과는 E11/E12의 저장 관측 기반 하네스이며, 해당 실제 앱 E2E나 새 AI 인식 평가를 대신하지 않는다.

## 완료 보고 전에 남은 확인

1. **목표 품질의 남은 구현**: 자동 후보 대부분은 계속 보류된다. 욕조 테두리/샤워 턱 유리의 별도 지지 높이2개는 사용자 확인 후에도 배치할 수 없다. vanity에 부적절한 전용 필드를 노출하는 UI 혼동도 남는다. 형태/카메라/실측 복원 한계를 유지해서 보고한다.
2. **사용자 보정 비용의 실제 범위**: 네 사진의 사용자 역할 기능 실행과 PNG는 확인했다. 인간의 최소 입력 수·완료 시간은 측정하지 않았으며, 하네스 이벤트나 자동화 속도로 대신하지 않는다. 관계 컨트롤의 별도 단위/브라우저 검증을 네 사진에서 모두 실행한 것처럼 합치지 않는다.
3. **추가4장과 앱 E2E**: 추가4장은 baseline-only 회귀로 보고한다. 후보까지 평가하려면 별도 실제 후보 결과가 필요하다. root의 실제 앱 E2E4개는 종료 상태·실제 수행 항목을 받아 갱신한다.
4. **제품 Before 연결**: lab 보정 결과를 실제 프로젝트 결과로 제공하려면 원본·자산·불변 버전·보정 출처를 함께 저장하는 명시 경로가 필요하다. 이후 동일 프로젝트에서 새로고침, 빈 After, 공통 치수/카메라, 시안, undo/redo, 비교 PNG를 확인한다. 현재 연결 부재는 **기존 저장/시안의 회귀가 아니라 최소 보정 결과를 실제 Before로 쓰는 흐름의 간극**이다.
5. **통합 완료 보고**: 최종 자동8장·추가 baseline4장·수동4사진·단위/빌드·실제 앱 E2E를 출처별로 구분한다. 전후 이미지와 종류/형태/설치/오탐/누락을 함께 제시하고, 정상 종료나 지원 범위15/17을 목표 전체 완료로 포장하지 않는다. 현 증거에서 후보 기본 채택은 보류가 타당하다.

이 갱신에서도 코어 소스 동결을 유지했고 감사 문서만 수정했다. 실제 확인된 완료 범위는 최신 실행·검사·지원되는 사용자 보정 기능이며, 전체 자동 재구성 품질과 실사용 프로젝트 연결은 미완료다.