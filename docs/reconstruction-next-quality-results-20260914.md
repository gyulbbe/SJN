> 과거 검증 기록: 아래에 언급된 `lab-product-color.tsx` 등 종료된 Lab 화면 코드는 2026-09-16 소스 정리에서 제거했습니다. 분석·대표색·프로젝트 호환 로직과 당시 검증 결과는 보존합니다.

# 사진 → Before 후속 품질 개선 결과

**2026-09-14 · 후속 구현·검증 인계.** 색상·설치 참고 추천·기둥 단면, strict placement의 실제 관측 재생과 유효 사용자 보정, 실제 보류 후보 Review 수정·재추가·저장 검증을 완료했다. 아래에 기록한 전역 107파일 1,336개 테스트와 lint·타입·Next.js→vinext 순차 빌드는 종료 0이다. 마지막으로 추가한 Review 브라우저 테스트도 실제 실행과 scoped lint/type이 통과했다. 마지막 Review 테스트를 포함한 전체 lint/type 재확인도 종료 0이며, 검사한 생산 파일 160개의 해시가 최종 코드와 같음을 확인했다.

이 문서는 `e55ca677-54e3-422c-b7d3-2ef7f6709e03/goal-objective.md`의 후속 목표를 기준으로 한다. [초기 감사](reconstruction-next-quality-audit-20260914.md)에 있는 색상·추천·기둥 단면의 ‘미구현/확인 필요’ 문구는 당시 조사 기록이다. 현재 해당 구현과 전용 검증은 존재한다. 반대로 [이전 목표 완료 보고](reconstruction-completion-20260914.md)의 1,241개 테스트·완료 판단으로 이번 목표를 완료 처리하지 않는다.

## 실제 수정 원인과 결과

### 제품 관측색과 재료색

기존 `candidates.ts`는 bbox 전체 평균이 아니라 semantic 연결 영역의 밝은 픽셀을 사용했다. bbox 평균이 오염 원인이라는 가설은 이번 자료로 확인되지 않았다. 다만 경계 혼합을 따로 제외하지 않았고, 따뜻하고 어두운 사진 RGB를 중립 조명의 모형 재료로 사용하면 흰 도기가 갈색 제품처럼 보였다. prospective-03의 보존 관측은 세면대 `#978370`, 변기 `#8a7767`이었다. 또 관측색을 복사하면서 `provenance.appearance`를 항상 default로 기록하는 오류가 있었다.

`product-color.ts`는 실제 semantic 연결 마스크를 한 픽셀 침식해 내부를 사용하며, 색상군과 밝기 극단을 구분한다. 애매한 따뜻한 도기는 관측색을 보존하고 **중립 기본색·확인 필요**를 선택한다. 실제 파란 하부장·변기와 합성 회색/검정 대조는 흰색으로 일괄 변경하지 않는다. 회색/검정은 이번 실제 사진 평가가 아니라 단위 대조다.

`LabProductColor`에서 자동 판단 유지, 중립 기본색 확인, 직접 색 및 흰색/아이보리/회색/검정/청록색을 선택할 수 있다. 사용자 확인은 user로 저장하며, 자동 기본색 선택은 default다. 거울·거울장·유리·창은 반사 풍경/뒤 배경을 고유색으로 사용하지 않고 중립 표면을 유지한다.

원사진 sRGB→Three 선형 재료→선형 렌더 표적→compositor 최종 sRGB 경로에서 중복 감마 변환은 발견하지 않았다. 추가 감마 보정을 넣지 않았다. 한 장의 사진에서 조명과 고유색을 완전히 분리한 결과는 아니며, 실제 베이지 도기는 사용자 확인이 필요하다.

주요 파일: `src/lib/reconstruction/product-color.ts`, `candidates.ts`, `index.ts`, `candidate-pipeline.ts`, `types.ts`, `src/components/reconstruction/lab-product-color.tsx`, `reconstruction-lab.tsx`, `src/lib/supabase/validation.ts`. [색상 원인·실제 픽셀/렌더 증거](reconstruction-product-color-results-20260914.md).

### 설치 참고 후보

기존 ‘세면대·하부장 위에 맞추기’의 선택 시점 위치 복사를 유지했다. `wall-alignment-suggestions.ts`는 같은 원사진의 유효한 관측 bbox, 현재 정상 후보 및 배치한 부모를 이용해 최대 3개 참고 후보를 보여 준다. 상하/가로 겹침은 **규칙 제안**이며 실제 연결이나 mm 거리가 아니다. 사진 왼쪽을 왼쪽 벽으로 바꾸지 않는다.

반사/반사 미확정, 의미 충돌, 중복/부품, 가림/투명 중첩/불확실 관계, 격리된 잘못된 관계는 추천에 이용하지 않는다. 정상 세면볼→하부장 partOf는 기존 결합을 유지하며 같은 모형을 두 부모로 추천하지 않는다. 벽이 없으면 확인이 필요한 채로 남고, 방향/모형 전체 범위가 맞지 않으면 위치를 강제로 줄이거나 옮기지 않는다.

**이 위치로 맞추기 · 사용자 확인**을 누를 때만 부모 중심/상단과 선택한 간격으로 한 번에 적용한다. 간격 150mm는 기본값이고, 비운 규격은 기본값을 유지한다. 추천의 사진 근거/출처와 사용자 선택을 스냅샷에 저장한다. 부모를 나중에 이동·삭제해도 복사한 위치는 유지된다. 욕조→유리의 기존 실제 부모 연결과 이 위치 복사를 혼동하지 않는다.

주요 파일: `wall-alignment-suggestions.ts`, `wall-alignment.ts`, `lab-correction.ts`, `src/components/reconstruction/lab-wall-alignment.tsx`, `manual-placement-editor.tsx`, `reconstruction-lab.tsx`. [구현·새 단위/실제 UI/저장 증거](reconstruction-installation-suggestions-20260914.md).

### 볼 형태와 기둥 단면

기존 `templates.ts`는 사각 세면볼도 기둥은 원통으로만 만들었다. 이제 **기둥 단면**을 볼 모양과 별도 선택값으로 두고, 사용자가 원형/사각형을 확인할 수 있다. 볼이 사각이라는 이유로 기둥 단면까지 추정하지 않는다. 옵션이 없는 과거 자료는 기존 원통을 유지한다.

`templates.ts`의 모형, `standard-model-render.ts` 캐시 키, 간단한 설비 속성, Lab 보정 스냅샷 및 Supabase 선택적 검증에 연결했다. 실제 user03 프로젝트 E2E에서 `pedestalShape=rectangular`, `provenance.pedestalShape=user`와 저장/새로고침을 확인했다. 가려진 기둥 전체 형태나 실제 단면 치수를 복원했다고 보고하지 않는다.

[전용 브라우저 기록](../test-results/reconstruction-pedestal-shape-20260914/run-02-formatted/verification.json)은 production controls/모형/캐시의 합성 검사다. 볼/기둥 조합 6개 PNG, legacy=명시 원형, 사각형은 다른 PNG, 실제 compositor 1,675픽셀 변화와 초기화 차이 0, 키보드·잠금·390px를 확인했다. AI 인식이나 실제 사진의 형상 정확도 검사는 아니다. gallery+cache 시간 784.3ms, 메모리 미측정.

### 원래 배치 제안 보존과 보류 증가

strict-placement.ts, index.ts, projection.ts의 placementPolicy: preserve 경로는 요청한 좌표·규격을 방에 강제로 끼워 넣지 않는다. 모형 전체의 실제 방 범위, 바닥 접지와 벽의 v/설치 높이 일치를 검사하여, 맞지 않으면 원래 제안·이유·범위 초과량을 보류 정보로 남긴다. 유효한 사용자 보정은 생성 이후 화면 투영에서 다시 이동하거나 축소하지 않는다.

**이 변경은 자동 재현 품질 개선으로 보고하지 않는다.** 같은 실제 DeepLab 원관측을 현재 production 생성 경로에 재생한 결과, 자동 배치는 아래처럼 오히려 줄었다. 이전 결과가 숨겼던 범위 밖 좌표를 더는 보정하여 배치하지 않기 때문이다. 새 AI 추론·사용자 보정·카메라 보정은 이 실행에 없다.

| 실제 관측 재생 | strict 전 배치 | strict 후 배치 | 추가 보류 |
|---|---:|---:|---|
| user01 | 2 | 0 | 2 · 변기, 욕조 |
| user02 | 1 | 0 | 1 · 변기 |
| user03 | 2 | 0 | 2 · 변기, 세면대 |
| user04 | 3 | 2 | 1 · 변기 |
| prospective03 | 4 | 0 | 4 · 변기 2개, 욕조, 거울 |
| 합계 | 12 | 2 | **10개 추가 보류** |

[실제 자동 재생 기록](../test-results/reconstruction-strict-placement-20260914/run-02-provenance/summary.json)은 원관측 불변, 저장/재진입, 복제 보존, 빈 After를 5건 모두 확인한다. 보류 사유는 모형 일부의 방/벽 범위 초과이며, 일부는 요청 u/v 자체도 0–1 범위를 벗어난다. 기존부터 종류·설치 벽·높이가 미확정인 후보는 이 추가 10개와 별개다. prospective03의 변기 중복 후보도 이 검사에서 자동 인식 오류를 수정한 것으로 세지 않는다.

반면 기존의 **유효한 사용자 보정 6/3/4/4개**는 strict 변경 후에도 그대로 배치된다. 네 corrected.png의 SHA256은 각각 strict 전후 완전히 같으며, 저장/새로고침/실행 취소/독립 시안 복사도 유지됐다. [네 PNG 동일성 및 저장 대조](../test-results/reconstruction-next-quality-20260914/strict-valid-corrections-comparison.json).

보류 후보 UI 감사에서 발견한 3건을 수정하고 [실제 원관측 Review 검증](reconstruction-strict-review-verification-20260914.md)으로 확인했다. 유한하지만 저장 스키마 한도를 넘는 수치와 NaN은 문서에 기록하지 않고 마지막 유효 제안을 유지한다. 위치만 수정하면 기본 규격의 각 출처를 보존하고, 종류/설치 방식 변경은 새 기본 제안으로 명시 초기화한 뒤 화면에 표시된 후속 입력을 그대로 적용한다.

실제 user03 raw 관측을 production 생성 경로로 재생한 최초 Before는 **0개**였다. Review에서 사용자가 변기 위치를 가로·깊이 50%로 바꾸어 추가하면 400×750×680mm/default를 유지했다. 세면대는 종류와 벽걸이형을 선택한 뒤 가로 37%, 폭 620mm, 설치 높이 680mm로 추가했으며, 폭만 user이고 바꾸지 않은 높이 320mm·깊이 450mm는 default다. 이 **사용자 확인 후 2개**는 자동 배치 성공이 아니다.

가로 위치 1e9%와 빈 입력 두 번은 예상된 오류를 표시하고 편집 revision·후보 문서를 바꾸지 않았다. 실제 저장소에 저장한 뒤 페이지 reload에서도 모형·검토·색상 근거·빈 After와 원관측을 유지했다. [실제 결과](../test-results/reconstruction-strict-placement-20260914/review-ui/verification.json)의 입력/생산 소스 해시는 전후 동일하고 Worker·외부 요청·페이지 오류는 0이다. 저장은 repository 명시 호출이며 자동 저장 500ms 타이밍 검증은 아니다. 최초 실행의 Chrome 차단 포트 오류와 재실행 기록도 보존했다.

## 다섯 사진의 전후

[통합 비교](../test-results/reconstruction-next-quality-20260914/comparison.html)는 원본/이전/이번 결과 15개 이미지, 5개 사진 구간을 제공한다. [실제 표시 검증](../test-results/reconstruction-next-quality-20260914/comparison-verification.json)에서 15개 모두 로드되고 1440×1100 및 390×844 화면에서 표시됨을 확인했다. 외부 요청·페이지 오류는 0이다. 네 사용자 사진과 prospective-03 모두 이미 결과를 본 **개발 회귀**다. 오른쪽은 저장된 실제 관측에 명시적인 사용자 역할 보정을 적용한 것이며 새 AI 인식 성공으로 세지 않는다.

| 사진 | 이전 / 이번 이미지 | 확인한 변화와 보존 | 아직 다른 점 |
|---|---|---|---|
| user01 · TEST 화장실.jpg | [이전](../test-results/reconstruction-completion-20260914/images/user-01-userCorrected.png) / [이번](../test-results/reconstruction-next-quality-20260914/final-e2e/reconstruction-lab-four-ph-55cf9--저장-reload-undo-redo-시안-PNG/corrected.png) | 도기 3종을 중립 기본색·확인 필요로 표현. 중립 거울장, 욕조 연결 유리 뒤 배경 유지. 보정 후 6개, 선반은 사용자 추가 | 거울장 전체 폭·유리의 방향/높이·숨은 형상은 기본/사용자 근사. 원사진과 정밀 일치 아님 |
| user02 · TEST 화장실2.jpg | [이전](../test-results/reconstruction-completion-20260914/images/user-02-userCorrected.png) / [이번](../test-results/reconstruction-next-quality-20260914/final-e2e/reconstruction-lab-four-ph-60b19--저장-reload-undo-redo-시안-PNG/corrected.png) | 흰 계열 세면대/변기 보존, 벽걸이 곡면 볼과 위 거울, 열린 변기 3개 | 좁은 방/문틀·마감·촬영 구도는 공통 기본 공간과 다름 |
| user03 · test 화장실3.jpg | [이전](../test-results/reconstruction-completion-20260914/images/user-03-userCorrected.png) / [이번](../test-results/reconstruction-next-quality-20260914/final-e2e/reconstruction-lab-four-ph-f7fb6--저장-reload-undo-redo-시안-PNG/corrected.png) | 사각 볼과 별도로 사용자 사각 기둥 단면 적용. 유리/샤워 턱·열린 변기·거울 4개 유지 | 앞 변기에 기둥이 가려짐. 이 E2E는 과거 ensemble 관측색 재생이라 회색 도기를 유지하며, 최종 primary 내부색 실험과 혼합하지 않음. 유리 폭/방향·단면 실측은 미확정 |
| user04 · images.jpg | [이전](../test-results/reconstruction-completion-20260914/images/user-04-userCorrected.png) / [이번](../test-results/reconstruction-next-quality-20260914/final-e2e/reconstruction-lab-four-ph-e7e9b--저장-reload-undo-redo-시안-PNG/corrected.png) | 파란 하부장/변기를 흰색으로 바꾸지 않음. 모델 관측 두 볼과 사용자 형태/배치, 중립 거울·창 4개 | 하부장 실제 길이·창 분할·가림/촬영 카메라는 근사 |
| prospective03 · 별도 회귀 | [이전 갈색](../test-results/reconstruction-lab-regression-correction-20260913/run-02-alignment/corrected.png) / [이번 자동 기본색](../test-results/reconstruction-next-quality-20260914/ui/2026-09-13T23-29-25-389Z/automatic-color-corrected.png) / [사용자 색](../test-results/reconstruction-next-quality-20260914/ui/2026-09-13T23-29-25-389Z/corrected.png) | 같은 방/사용자 위치에서 갈색 관측을 보존하고 흰 중립 도기로 표시. 거울 참고 제안 선택, 중립색 확인 및 흰 세면대/청록 변기 변경·저장 확인. 3개 | 갈색 벽·넓은 기본 구도·커튼/문/선반 미재구성은 그대로. 청록 변기는 UI 검증용 사용자 선택이며 원사진 판정 아님 |

이번 네 PNG와 prospective03 자동/사용자색 PNG는 독립 감사에서도 직접 확인했다. 설비 전체가 알아보이는지, 상대 설치와 색이 유지되는지를 확인한 것이며 mm 정확도 평가는 아니다. 다섯 보정 결과의 source-camera는 `held / none / unresolved`다. 실제 모형을 원사진 카메라로 재투영한 오차는 **not-evaluable**이며 입력 bbox를 재투영 결과로 대체하지 않았다.

## 실제 실행과 시간 구분

| 실행 종류 | 확인한 범위와 시간 |
|---|---|
| 실제 DeepLab 전체 실행 5회 | 첫 색 정책 평가. 사진별 22.282/12.213/22.389/27.668/27.520초. 중간 밝기 정책의 user03 회귀를 발견했으며 이 결과를 최종 정책으로 이름 바꾸지 않음 |
| 최종 색 정책 재생 | 동일 실제 primary semantic mask/RGBA의 후처리. 네 장은 보존 자료, prospective03은 실제 primary 1회(4.739초) 캡처 후 재생. 최종 색 후처리 28.12/18.52/27.67/34.92/16.68ms. 전체 flip/crop 분석·AI 추론 시간이 아님 |
| 색상 전후 WebGL | 11쌍, 동일 모형/카메라/조명에서 표면색만 비교. [비교/원값](../test-results/reconstruction-product-color-20260914/final-colour-render/comparison.html). 모델/배치는 검사용 기본값이며 인식 성공 아님 |
| 네 실제 Next 프로젝트 E2E | 저장 관측+사용자 입력. strict 전 교정 준비+렌더 2.208/1.498/1.720/2.016초. strict 후 최종 전체 자동화 시나리오 20.834/20.405/20.075/20.345초. 서로 다른 범위의 기록이며 인간 보정 시간/최소 클릭 수 아님 |
| prospective03 Full Lab | 저장 관측+사용자 입력. 자동색/중립 확인/사용자색 교정 준비+렌더 1.506/1.475/1.419초. 새 AI 0. [실제 verification](../test-results/reconstruction-next-quality-20260914/ui/2026-09-13T23-29-25-389Z/verification.json) |
| strict 자동 관측 재생 5건 | 최종 run-02-provenance, 새 추론 0. 생성 741.1/297.3/282.7/568.6/303.6ms, 출력 렌더 644.6/547.4/533.8/1094.6/514.2ms. 미배치 후보가 증가한 실행이므로 기존보다 빠른 AI/품질 개선으로 해석하지 않음 |

네 E2E의 기록된 사용자 역할 입력 이벤트는 39/21/28/24개다. 기존 명시 배치를 수행한 자동화 기록이며, 사람의 최소 입력 수나 기존 대비 UX 절감률로 주장하지 않는다. 새 참고 추천은 전용 테스트에서 표시만으로 상태 변경 0, 명시 버튼/Enter 한 번으로 복사 명령 1개임을 확인했다.

환경 기록은 Windows 10.0.26200, Ryzen 7 7800X3D, 시스템 RAM 용량 33,444,208,640바이트, Chrome 152.0.7977.83 headless/SwiftShader, TFJS WASM 단일 스레드다. 시스템 RAM 용량은 사용량이 아니다. 새 전체 프로세스 RAM/WASM/GPU 최고 사용량은 측정하지 않았다. 과거 Ollama 모델 할당량을 이번 측정으로 인용하지 않는다. [환경/입력/소스 해시](../test-results/reconstruction-product-color-20260914/actual-baseline/environment-all.json).

## 저장·편집·출력 확인

strict 변경 후 [최종 E2E](../test-results/reconstruction-next-quality-20260914/final-e2e)는 8개 통과했다(루트 실행 handle 52938, 종료 코드 0; .last-run.json passed). 네 사진 verification에서 실제 Before 저장, 빈 After, 공통 방, 보고서 보존, 프로젝트 새로고침, After undo/redo, 독립 시안 복사와 4096×1366 비교 PNG를 확인했다. 6/3/4/4개는 사용자 보정 후 배치 수다. AI 요청/외부 요청/페이지 예외는 모두 0이며 용량 실패 주입은 이 실행에서 하지 않았다. 사진 없는 기본 공간과 자재 수량·0원·실행 취소·재진입·출력 UI 제외 회귀도 이 최종 실행에 포함된다.

prospective03 Full Lab은 실제 LabProjectAction→IndexedDB load→페이지 reload→readLabProjectReport까지 수행했다. Before 3개와 색 근거/추천 스냅샷을 보존하고 After는 빈 한 시안이다. PNG 다운로드와 현재 preview의 SHA256은 `4833bb92595f78fd42280c107fd3ee7696a14841d7a5552b6d4cce6cdccd23a7`로 같다. 편집 도구·색 선택 UI·확인 문구는 PNG에 포함되지 않았다. 원모델 understanding/automaticUnderstanding/rawText와 초기 결과도 불변이다.

[Before 색상 속성 재검증](../test-results/reconstruction-properties-color-20260914/run-02-preserve/verification.json)은 production 속성 화면·렌더러·실행 취소·실제 저장소·페이지 reload의 **12개 항목**을 확인했다. default/custom/중립 사용자 확인 색은 위치·규격만 편집해도 유지되고, 관측색과 후보 근거가 보존된다. 취소한 색상은 문서를 바꾸지 않으며, 원래 불변 자재 버전·빈 After·390px 표시를 유지한다. 합성 fixture의 기능 검사이며 AI 색 인식 정확도나 자동 저장 스케줄러의 검증이 아니다. 실제 repository 저장을 명시 호출했다. 소스 해시 전후 동일, Worker/외부 요청/페이지 오류는 0이다.

8개 E2E와 Before 색상 속성 재검증은 strict 적용 후이지만 **마지막 Review 입력·출처 및 관측 캐시 수정 전**의 실행이다. 이후 수정이 끝난 생산 코드로 run-02-provenance 5건, 전체 107파일 1,336개 및 lint/type·Next→vinext 검사를 수행했고, 마지막으로 실제 user03 Review UI를 추가 검증했다. 8개 E2E가 이 마지막 UI 분기를 이미 검사한 것으로 소급하지 않는다. prospective03 Full Lab도 앞선 실행 결과를 그대로 보존한다.

Review UI 검증 추가 이후 해당 테스트의 scoped lint/type이 종료 0이고, 마지막으로 전체 npm run lint → npm run typecheck도 루트 실행 handle 21794에서 종료 0을 확인했다. [검사한 최종 생산 해시](../test-results/reconstruction-next-quality-20260914/checked-final-source-hashes.json)의 160개가 최종 생산 코드와 모두 일치한다. 앞선 전역 성공과 이 마지막 새 테스트 포함 재확인은 별도 실행이다.

## 원문 요구사항별 증거 감사

| 요구 | 현재 증거·판단 |
|---|---|
| 지정 지침/기존 보고서 조사, 중복 구현 방지 | AGENTS/설치 Next use-client 및 지정된 기존 6자료 조사. 기존 관측/부품/보호/UI를 재사용하고 색상·추천·단면을 확장 |
| 픽셀 선택→추정→출처→재료→색공간 원인 추적 | 색상 보고서와 실제 픽셀/소스/11쌍 렌더. bbox 평균 원인/중복 감마 오류는 확인되지 않음으로 구분 |
| 제품 내부 사용, 흰색/유색 보존, 광학 표면 유지 | 내부 마스크 정책+5사진 primary 재생+11쌍 PNG+색상 단위 검사. 회색/검정은 합성 대조임을 명시 |
| 모호한 색·필드 출처·사용자 수정/저장 | auto/default/user와 observedColor 보존. Full Lab neutral/custom, 실제 저장/재진입 및 PNG 검증 |
| 기존 세 관계 조사·복사와 동적 연결 구분 | wall copy / bath-rim / partOf를 구분. 신규 24+기존30+관계21 단위 통과, 기존18·새8 UI 검사 |
| 2~3 대안 또는 필요한 벽/방향/높이, 선택 전 추정·선택 후 user | 최대3 참고 후보, 벽 미확정 유지, 사진 번호/근거/간격 출처. 실제 추천 버튼·명령1개·스냅샷 보존 확인 |
| 사진 좌우=벽·볼 bbox=발 접점·하드코딩·강제 이동/축소 금지 | 추천 검사 및 preserve 생성/투영에 반영. 최종 실제 원관측 5건에서 추가 10개 보류. 유효 사용자 보정 PNG 4개는 변경 전후 동일. 실제 보류 후보 UI는 원제안 표시·사용자 수정 후 정확 적용 확인 |
| 촬영 기하/관측/오프라인 실험 조사 | 초기 감사의 실제 실험·소스 대조. 기존 미확정 depth/평면/카메라 가설을 채택하지 않음 |
| 새 기하 구현 시 경계/광학 오인 검증 | 새 카메라 추정 엔진은 추가하지 않았으므로 조건부 요구. strict 방 범위/원요청 보존은 실제 관측 재생으로 확인. 이것을 원사진 카메라 재투영 검증으로 대체하지 않음 |
| source 재투영 vs 공통 카메라, 실측 없는 정확도 금지 | 5결과 source camera held, 재투영 not-evaluable. 공통 방/카메라 비교 유지. mm 정답률 산출 없음 |
| 모델 역할·채택·라이선스/환경 조건 | DeepLab 픽셀 관측, 로컬 Qwen 설비 이해, Three 표준 모형 역할 유지. 새 모델 없음이므로 추가 모델 라이선스 비교 조건 미발생. Qwen 기본 채택 근거 없음 |
| 대형 기본 다운로드·TripoSR/배경 제거 교체·유료 API·외부 전송·배포 금지 | 이번 테스트에서 새 모델/외부 요청 0, 기존 DeepLab만 새 관측에 사용. 해당 모델 교체·배포 작업 없음 |
| 홈/Lab 유지, 같은 사진/방/관측, 전후 보존 | 동일 fingerprint·2400 기본 방·보존 원관측. 기존/새 결과 별도 폴더와 비교 링크 |
| 5회귀 사례·색/형태/설치/상대높이/누락/중복/보정량/시간 | 위 5사례 표와 actual verification·사용자 입력/시간. 이미 노출된 자료이며 blind 성과 아님 |
| 실제 AI/보존 관측/사용자/모의 실패 및 실행 핸들 구분 | 실제5+primary1, 최종 마스크 재생, UI 사용자 보정 분리. 라이브 실행은 같은 handle 완료까지 추적. Review에서 1e9/NaN 두 입력 오류를 의도적으로 검사했고 새 AI·저장 실패 주입은 없음 |
| 저장→reload→undo/redo→시안→비교 PNG | strict 후 E2E 8개 및 네 사진 verification·PNG 동일성, Full Lab 색/추천 근거. 마지막 Review/cache 변경 후 실제 보류 후보 0→사용자 추가2→repository save/reload 별도 확인. 실행 시점 구분 |
| 사진 Before/빈 After, 사진 없음 양쪽 빈 공간 | final-e2e의 네 사진 및 무사진 기본 공간 회귀 통과. After 자재 변경 후 Before 보존 포함 |
| 가격/수량·원본/불변버전·기본벽/바닥·간단 UI 보존 | final-e2e 자재 수량/0원·기본 공간 회귀, Before 속성 run-02의 불변 자재·빈 After 확인. 최종 전역 107파일 1,336개에서 fixed-room-editing/material-usage/저장·복사 회귀 통과 |
| 관련 단위/브라우저/lint/type/Next 다음 vinext | 마지막 생산 변경 후 전역 107파일 1,336개, ESLint·타입·Next 다음 vinext 순차 빌드 종료0. 이후 추가한 Review 테스트의 실제 브라우저/scoped lint/type도 종료0. 마지막 새 테스트 포함 whole lint/type도 종료0 |
| 전후 이미지·원인/파일·출처·시간/환경·미해결·메모리 | 이 인계와 전용 보고서/actual artifacts에 연결. 비교 15이미지/5구간 desktop/mobile 확인. 메모리 실제 사용량 미측정 |
| 범위 충족 후 완료, 새 완벽함 게이트 추가 금지 | 명시한 구현·검증 범위를 인계한다. 남은 자동 배치·색조명·가림·구도는 선명히 공개하며 자동 재현 완료로 주장하지 않음. 마지막 160개 생산 해시 일치 및 전체 lint/type 종료0 확인 |

## 완료된 검사와 실행 범위

| 검사 | 확인한 결과 | 실행 기록 |
|---|---|---|
| 관련 설치 단위 | 75개 통과 | 담당 실행 및 설치 보고서 |
| 관련 색상 단위 | 신규19 포함 관련68개 통과 | 색상 보고서. 최종 전역 결과로 다시 확인 |
| 추천/기존 위치 실제 브라우저 | 신규8+기존18항목 통과 | 설치 보고서 링크 |
| Full Lab 색상/추천/PNG/저장 | 통과, 소스 해시 전후 동일 | ui/2026-09-13T23-29-25-389Z |
| 최종 실제 Next E2E | 8개 통과 · 루트 handle 52938 종료 0 | final-e2e/.last-run.json passed 및 네 사진 verification |
| strict 전후 유효 보정 PNG | 네 장 SHA256 각각 동일 · 사용자 보정 6/3/4/4 유지 | strict-valid-corrections-comparison.json |
| Before 색상 속성 | strict 후 12개 항목 통과 · 합성 fixture 기능 검사 | reconstruction-properties-color-20260914/run-02-preserve/verification.json |
| 기둥 controls/model/cache | 전용 run-02-formatted 통과 | 합성 기능 검사 범위 |
| strict 자동 관측 재생 | 5건 완료 · 자동 배치 0/0/0/2/0 · 추가 10개 보류 | reconstruction-strict-placement-20260914/run-02-provenance/summary.json |
| 보류 Review UI 감사 3건 수정 및 실제 후보 재추가 | 실제 user03 원관측 Before0→사용자 확인2→저장/reload 통과 | [실제 결과](../test-results/reconstruction-strict-placement-20260914/review-ui/verification.json) · scoped lint/type 종료0 |
| 최종 전체 Vitest | **107파일 1,336개 통과**, 명령7.013초 | [로그](../test-results/reconstruction-next-quality-20260914/checks-final/vitest.log) |
| 최종 전체 ESLint | 종료0,11.677초 | [로그](../test-results/reconstruction-next-quality-20260914/checks-final/lint.log) |
| 최종 타입 검사 | 종료0,6.183초 | [로그](../test-results/reconstruction-next-quality-20260914/checks-final/typecheck.log) |
| Review 테스트 추가 후 전체 lint/type 재확인 | lint 다음 typecheck 순차 종료0 | 루트 handle 21794 · 최종 생산 160개 해시 일치 |
| Next.js build | 종료0,18.607초 | [로그](../test-results/reconstruction-next-quality-20260914/checks-final/next-build.log) |
| vinext build · Next 다음 순차 | 종료0,17.886초 | [로그](../test-results/reconstruction-next-quality-20260914/checks-final/vinext-build.log) |
| 최종 비교 문서 표시/링크 | 15/15 이미지 · 5구간 · 1440px/390px 확인 | comparison-verification.json · 외부/페이지 오류 0 |

검사 명령·시작/종료 시각·종료 코드는 [checks-final/checks.json](../test-results/reconstruction-next-quality-20260914/checks-final/checks.json)에 있다. 첫 타입 검사는 새 테스트가 필요한 숫자를 optional로 받는 반환형 때문에 실패했고, 실제 함수의 보장과 반환 타입을 맞춘 후 통과했다. [첫 실패 로그](../test-results/reconstruction-next-quality-20260914/checks/typecheck.log)는 보존했다. 빌드 시간은 병행 로컬 작업과 캐시를 포함하며 독립 성능 측정이 아니다.

run-02-provenance는 당시 색 관측 v6의 저장 raw를 재생한 배치 검사다. 최종 색 정책 v7의 새 추론이나 자동 캐시 적중으로 취급하지 않는다. [첫 strict 재생](../test-results/reconstruction-strict-placement-20260914/summary.json)과 과거 실패 로그를 보존하고, 이 보고서의 최종 strict 수치·시간은 run-02-provenance를 따른다.

관측 캐시는 최종 밝은 몸체 선택 정책 v7과 배치 출력 baseline v9/candidate v12를 구분한다. 중간 밝기 회귀가 있던 실제 v6 자료는 자동 캐시로 승격하지 않고 명시적 과거 관측 재생에만 사용한다. 모델 파일을 교체한 것은 아니다. [엄격 배치·출처·관측 캐시 근거](reconstruction-strict-placement-results-20260914.md).

## 남은 한계와 채택 판단

파이프라인은 사용자에게 종류·설치·형태·색을 확인할 수 있는 표준 Before를 제공한다. 한 장의 사진에서 조명과 제품 고유색, 가려진 제품, 실측 깊이·단면, 좁은 촬영 카메라를 완전히 복원하지 않는다. semantic 모델이 내부를 잘못 분류하면 마스크 침식으로 종류 오류가 해결되지 않는다. 여러 재질의 하부장/세면볼을 단일 표면색으로 나타내는 한계도 남는다.

이번 색·설치 참고·단면 개선을 자동 인식/배치 정확도 개선률로 바꾸어 보고하지 않는다. 현재 증거만으로 Qwen을 기본 엔진으로 바꾸거나 기존 depth/평면 가설을 자동 승인할 이유는 없다. 구현·사용자 보정·저장·검증 결과를 인계하며, 자동 배치 0/0/0/2/0의 한계를 줄이는 다음 관측·설치 실험은 별도 작업으로 다룬다. 실제 서버 연결·배포·외부 사용자 격리 검사는 이번 범위 밖이며 수행하지 않았다.

다음 작업의 요청 문안은 [자동 배치·재현 품질 개선 프롬프트](prompts/before-reconstruction-placement-quality.md)에 있다. 이번 사용자 보정 성공을 자동 배치 성공으로 바꾸지 않고, 부족한 설치 근거와 최소 확인 흐름을 다음 검증 대상으로 삼는다.
