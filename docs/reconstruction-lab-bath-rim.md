> 과거 검증 기록: 이 문서에서 사용한 옛 Lab 화면·관련 UI와 해당 화면 재생 스크립트는 2026-09-16 소스 정리에서 제거했습니다. 아래 결과와 명령은 당시 기록이며 현재 실행 가이드가 아닙니다.

# Lab 후보의 욕조 테두리 연결

2026-09-13. 저장된 분석 결과에 사용자가 확인한 관계를 추가하는 기능이다. 기존 Before의 표준 욕조 연결을 재사용하며, Qwen/DeepLab 모델·원 관측·사진은 변경하지 않는다.

## 사용법

1. `/reconstruction-lab`의 개선 후보 목록에서 욕조의 종류·실물 여부·설치 방식을 확인한다. 필요한 경우 욕조를 수동 위치로 배치한다.
2. 유리 파티션의 설치 방식을 바닥으로 확인하고 수동 위치 입력을 켠다. `유리 지지면`에서 `욕조 테두리`를 고른다.
3. `연결할 욕조 후보`를 선택하고 테두리(욕조 자체의 좌·우·앞·뒤)와 중앙 기준 거리(mm)를 조절한다. 처음 선택은 앞쪽 테두리 중앙이다. 앞·뒤 테두리의 양수는 욕조 오른쪽, 좌·우 테두리의 양수는 욕조 앞쪽이다.
4. 유리의 위치·방향·하단 높이는 부모 모형에서 계산하므로 해당 입력은 잠긴다. 유리 규격은 별도로 수정한다. 부모가 보류됐으면 이유를 표시하며 유리를 임의의 위치에 보여주지 않는다.
5. `사용자 보정으로 다시 보기`로 별도 결과를 만든다. `이 결과로 공간 만들기`는 이 결과를 실제 로컬 Before로 저장한다. After는 빈 공간이다.

관계와 거리는 사용자 확인이며 치수 기본값은 실측값이 아니다. 욕조 기본 높이600mm의 수전 포함 전체 모형에서 실제 테두리는 약560.9mm다. 독립 높이 입력을 선택할 수도 있지만, 그 값은 실제 욕조 연결로 간주하지 않는다.

## 보존과 검증 경계

- 입력 초안과 `correctionSnapshot.input.manualPlacements`에는 `bathRim.parentCandidateId`를 보관한다. 후보 목록 순서와 관계없이 부모 욕조 계획을 먼저 검증한다. 계산용 가상 부모는 helper 내부에서만 사용하며 저장하거나 실제 제품이라고 표시하지 않는다.
- 부모가 실제 생성된 뒤 `RaisedGlassSupport.bathRim.parentFixtureId`에 실제 fixture ID를 넣는다. 사용자 관계 출처는 `parent/side/offset:user`, 높이는 `support.provenance.height:parent`다. 후보 ID를 fixture 참조로 저장하지 않는다.
- 부모가 누락·보류·제외·반사·다른 종류로 변경되면 유리는 보류하고 관계 초안과 이유를 남긴다. 욕조가 살아 있으면 테두리 폭·두께·거리·공간 경계를 그대로 검증한다. 유리를 축소하거나 바닥 높이0으로 바꾸지 않는다.
- 직접 API/복원 입력에 욕조 관계와 벽 설치면·벽 기준 거리·별도 독립 지지면이 동시에 있으면 오류로 거절한다. 정상 UI는 모순된 입력을 만들지 않는다.
- 자동 결과, 원 모델 텍스트, `automaticUnderstanding`은 사용자 보정과 분리해 유지한다. 결과의 `userBathRimLinks`는 연결/보류와 계산 높이를 별도 기록한다. 결과 입력 복원도 같은 부모·테두리·거리로 돌아온다.
- 저장된 프로젝트는 원 분석 보고서와 보정 스냅샷을 `comparison.labSource`에 보관한다. Before의 부모 이동·삭제·실행 취소·재진입·복제는 기존 연결 로직을 사용한다. Lab 목록 자체는 페이지 메모리이므로 새로고침하면 비워지며 저장 프로젝트는 남는다.
- 후보/cache revision은 `structured-scene-v8-user-bath-rim-link-1`이다. baseline revision과 Qwen prompt/model/settings는 변경하지 않았다. 예전 결과는 기존 실행 식별자를 그대로 보존한다.

변경 경로: `candidate-bath-rim.ts`, `candidate-pipeline.ts`, `index.ts`, `lab-correction.ts`, `lab-manual-placement.ts`, `lab-engine.ts`, `lab-bath-rim-controls.tsx`, `manual-placement-editor.tsx`, `reconstruction-lab.tsx`. 영속 fixture 스키마와 공통 렌더는 기존 Before 연결 형식을 재사용한다.

## 실제 검사

- `npx vitest run tests/reconstruction-lab-bath-rim.test.ts tests/reconstruction-candidate-pipeline.test.ts tests/reconstruction-bath-rim.test.ts tests/reconstruction-lab-correction.test.ts`: **4파일68개 통과**, 새 관계15개 포함. 후보 순서, 두 ID 공간, 원 입력 불변, 부모 누락/보류/종류/반사, 초과 규격·거리, 부모 위치/방향/높이, 독립 기존 높이, 스냅샷 복원, 모순된 직접 입력을 확인했다.
- 담당11파일 ESLint 통과. 전역 타입/Next/vinext 빌드는 루트 통합 검사 대상이다.
- `node --experimental-strip-types tests/reconstruction-lab-bath-rim-browser.ts`: **통과**. Chrome headless + SwiftShader, 별도 localhost, 실제 Lab 컴포넌트/AppProvider/생산 보정 함수/공통 renderer/LabProjectAction/IndexedDB를 사용했다.
- 최초 baseline·candidate만 사용자01의 **과거 실제 보고서/PNG**를 읽는 검사 어댑터를 썼다. 원 실행 ID는 `e474d930-87e0-4932-b440-85c6f00b36ed`. 이후 보정 두 번은 생산 함수를 실행했다. 새 Worker는 차단했으며 기록된20요청은 localhost GET12개와 해당 origin Blob8개다. AI POST·모델 다운로드·외부 전송은0회다.
- 사용자 역할 입력: 욕조 `item_03`, floor, u=.6/v=.2/높이0/방향0, 기본1500×600×750mm. 유리 `item_05`, floor, 욕조 앞쪽 테두리, 중앙 거리-200mm, 기본800×1800×8mm. 이는 사진에서 측정한 위치·치수가 아니다.
- 부모 제외→유리 보류/초안 보존→부모 재확인→연결 결과→PNG 다운로드→입력 복원→실제 로컬 프로젝트 저장→부모 삭제 보류→undo→재저장→새로고침 후 실제 부모ID 연결을 확인했다. 원 보고서·자동 이해는 그대로이고 After는 빈 공간이다.
- 최종 보정 시간은 **2.112초**(배치·사진/모형 준비0.901초, PNG렌더1.212초). 이번 baseline 분석0초, 추가 모델0초다. SwiftShader 검사 시간이며 실제 AI 처리 성능으로 해석하지 않는다.
- 화면 Blob과 다운로드 PNG의 SHA256이 같았다. 실제 PNG에서 유리 하단이 표준 욕조 테두리에 닿고 뒤 타일이 비치는 것을 확인했다. 이 검사에서는 관계 확인에 필요한 욕조·유리2개만 사용자 배치했다. 전체 원사진 재현 성공이나 새 AI 검출2개로 집계하지 않는다.
- 최초 브라우저 실행은 검사 입력에서 유리의 기존 unknown 설치 방식을 floor로 확인하지 않아 지지면 UI를 찾지 못했다. 두 번째는 기능 검사가 모두 끝난 뒤 요청 검사기가 내부 Blob 읽기도 HTTP로 한정해 실패했다. 세 번째에서 같은 origin Blob을 별도 허용해 통과했다. 후속 직접 API 모순 입력 guard는 단위 검증했으며 정상 UI 경로는 바뀌지 않았다.

증거: [비교 HTML](../test-results/reconstruction-lab-bath-rim-20260913/comparison.html), [연결 PNG](../test-results/reconstruction-lab-bath-rim-20260913/connected.png), [연결 보고서](../test-results/reconstruction-lab-bath-rim-20260913/connected.json), [부모 제외 보고서](../test-results/reconstruction-lab-bath-rim-20260913/parent-excluded.json), [저장/재진입 검사](../test-results/reconstruction-lab-bath-rim-20260913/verification.json), [요청 목록](../test-results/reconstruction-lab-bath-rim-20260913/requests.json).

## 한계

표준 v2 욕조만 부모로 선택한다. 실제 상품 PNG, 수전과 유리의 상세 간섭, 임의 욕조 형상·시공 안전성은 검증하지 않는다. 부모 자체 배치는 기존 표준 모형 검증과 정규화에 의존한다. 자동으로 사진 속 부모 관계를 찾는 기능이 아니며 원래 누락된 설비나 잘못 추정한 공간 구도를 이 연결 기능만으로 해결하지 않는다. 실제 Supabase 연결·배포는 실행하지 않았다.
