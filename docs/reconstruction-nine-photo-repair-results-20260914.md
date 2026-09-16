# 사진 → Before 재구성: 9장 실제 검증과 호출 경로 개선 (2026-09-14)

이 문서는 이번 구현과 실제 실행을 기록한다. 기존 기록은 덮어쓰지 않았다. 자동 배치 수와 원본 재현 품질을 구분하며, 미확정 후보를 수동으로 옮긴 결과를 자동 인식 성공으로 집계하지 않는다.

## 수정한 원인과 동작

1. **설비 관측과 배치 사이의 기하 입력이 비어 있었다.** 기존 inventory 계약은 종류·사진 영역만 관측하고 `wall/anchor/roomLayout`을 미확정으로 두었다. 이 계약 자체를 억지로 채우지 않고, `quality-core.ts`에서 실제 설치 보완과 MoGe-2 공간 관측을 호출해 `buildCandidatePipeline`의 기하 인자에 전달했다. 일반 생성, Before 재분석, Lab 후보 분석이 같은 경로를 쓴다.
2. **실제 설치 2차 응답이 모두 null인 사례가 있었다.** pc-04/remote-01의 원응답에서 확인했고, 브라우저 입력과 Ollama에 전달된 이미지 바이트 해시가 일치함을 검증했다. 이미지 누락 문제는 아니었다. 짧은 A/B 프롬프트는 답이 늘었지만 바닥형 변기를 벽걸이로 오분류해 폐기했다. 최종 v2는 바닥 받침·전체 공중 간격·벽 연결·상판 지지 코드만 관측해 설치 방식만 보완한다. 벽 방향·좌표·반사 관계는 넣지 않는다. 알려진 설치 방식과 충돌하거나 잘린 물체의 전체 지지를 주장하면 이전 후보를 보존하고 격리한다.
3. **원관측의 `unknown`이 후속 보완을 가려 진단이 모순됐다.** 원값과 적용값을 분리해 `rawMounting/effectiveMounting/mountingSource` 및 규칙·지지 관측 원문을 함께 기록한다. 모델 후보 수, 배치된 모형 수, 첫 보류 원인을 별도 집계한다.
4. **후보 자체를 평면 추출에서 제외한 뒤 그 중심에 벽 픽셀을 요구할 수 없었다.** 후보 바깥의 두 방향 이상에서 실제 지지 픽셀을 확인하고 광선 교차와 일치할 때만 벽을 제안하도록 했다. 단순 bbox 중첩이나 사진 좌우만으로 설치 벽을 정하지 않는다.
5. **잘못된 텍스트 방 모서리가 독립 깊이 관측까지 막았다.** 텍스트 모서리 실패는 해당 카메라 후보만 무효화한다. 검증을 통과한 별도 깊이 카메라는 사용할 수 있고, 깊이도 부족하면 보류한다.
6. **불완전하거나 오래된 관측 재사용을 제한했다.** 사진 해시·크기, 분석 revision, 설치 계약·프롬프트·모델 digest, 원문 재파싱 결과, 기하 모델·추출 revision과 유한 수치를 확인한다. 손상 자료를 조용히 AI 재실행으로 대체하지 않는다. 과거 결과는 보존하고 재분석이 필요함을 알린다.

서로 인접한 평면 조각은 엄격한 합동 평면 적합을 통과할 때만 합친다. 저장된 실제 관측 세 사례의 재생에서는 합칠 수 있는 쌍이 0개였다. 따라서 이 기능만으로 모호한 방 구조가 해결됐다고 보고하지 않는다. 단일 사진의 추정 깊이는 실측이 아니며 방 밖 모형을 자동 이동·축소하지 않는다.

## 코드와 사용 방법

- 공통 분석: `src/lib/reconstruction/quality-core.ts`, `quality-contract.ts`, `index.ts`, `lab.ts`
- 설치 관측·검증: `installation-observation.ts`, `local-engine-client.ts`, `local-engine-server.ts`
- 공간 관측: `geometry-contract.ts`, `geometry-local-client.ts`, `geometry-local-server.ts`, `scripts/reconstruction-geometry-worker.py`, `scripts/reconstruction_geometry/`
- 카메라·설치 벽: `candidate-pipeline.ts`, `depth-room-geometry.ts`
- 진단: `project-diagnostics.ts`, `lab-candidate-trace.ts`, `lab-diagnostics.ts`, `lab-diagnostic-storage.ts`
- 일반 화면: `analysis-profile-picker.tsx`, `reconstruction-dialog.tsx`, `reconstruction-rebuild.tsx`
- 환경별 실행·저장: `build/cloudflare-local.ts`, `src/lib/supabase/validation.ts`

위 상대 파일명은 `src/lib/reconstruction/` 또는 `src/components/reconstruction/`의 문맥을 따른다. [로컬 실행·환경 변수 가이드](reconstruction-local-quality.md)에 전체 경로와 설정법이 있다.

일반 **사진으로 비교 공간 만들기 → 사진 분석 방식 → 로컬 정밀 분석**을 선택한다. 두 로컬 서비스가 준비된 개발 환경에서는 새 생성의 기본 선택이며, 기존 프로젝트는 저장된 프로필 또는 브라우저 기본 분석을 유지한다. 재분석도 같은 선택을 제공한다. 로컬 모델이 없거나 Workers/production이면 미지원 이유를 표시한다. 실패 시 브라우저 기본 분석으로 조용히 대체하지 않는다.

Before에는 재구성 표준 모형이 들어가고 After는 같은 크기·공통 표시 카메라의 빈 공간이다. 원사진 촬영 카메라는 위치 해석에만 쓰며 공통 표시 카메라를 덮어쓰지 않는다. 표준 설비에는 판매 가격을 추가하지 않는다. 기존 설비 확인 화면과 기본 벽·바닥 삭제 방지를 유지했다.

## 재현과 원자료

- 변경 전 새 실행: `test-results/reconstruction-nine-photo/before-01/`
- 최종 새 실행: `test-results/reconstruction-nine-photo/after-01/`
- 설치 질문 대조 원문: `test-results/reconstruction-nine-photo/installation-ablation/`
- 입력 평가 참고: `test-results/reconstruction-nine-photo/evaluation-reference.json`
- 최종 비교와 요약: `test-results/reconstruction-nine-photo/comparison/`

모든 원본은 기존 위치를 유지한다. 실행 폴더 manifest에 9장 경로·바이트 크기·SHA-256을 기록하고 비교표 생성 시 원본 해시를 다시 검증한다. 이 사진들은 이미 본 개발 사례이며 독립적인 미공개 평가 세트가 아니다. 사진·응답·로그는 git 제외된 결과 폴더에만 있고 공개 업로드하지 않았다.

```powershell
# 로컬 모델·CUDA Python 준비 및 npm run dev 실행 후, 새 결과 폴더 이름을 사용한다.
$env:SJN_CASES = ''
node test-results/reconstruction-nine-photo/snapshot-code.mjs test-results/reconstruction-nine-photo/new-run
node test-results/reconstruction-nine-photo/run-quality.mjs test-results/reconstruction-nine-photo/new-run
node test-results/reconstruction-nine-photo/make-final-report.mjs test-results/reconstruction-nine-photo/before-01 test-results/reconstruction-nine-photo/new-run test-results/reconstruction-nine-photo/new-comparison

# 일반 생성·저장·재분석 실제 AI E2E (추론 중에는 중복 실행하지 않는다)
$env:SJN_RECONSTRUCTION_TEST_PHOTO = 'C:/Users/H/Downloads/images.jpg'
npx playwright test e2e/reconstruction-local-quality.spec.ts
```

## 실제 결과

**구현·실행 연결은 완료했지만, 원본 재현 품질 목표는 아직 충족하지 못했다.** 9장 중 부분 개선 1장, 자동 재현이 부족한 7장, 미설치 설비 0개 유지 1장이다. 전체 정밀 복원 통과는 0장으로 기록했다.

[9행 × 3열 비교 PNG](../test-results/reconstruction-nine-photo/comparison/nine-photos-before-after.png) · [확대 가능한 HTML](../test-results/reconstruction-nine-photo/comparison/comparison.html) · [기계용 summary.json](../test-results/reconstruction-nine-photo/comparison/summary.json) · [실제 이미지 판정](../test-results/reconstruction-nine-photo/comparison/human-evaluation.json)

| 사례      | 모델 후보 | 자동 배치 전→후 | 확인 필요 | 후보 실행 | 판정           |
| --------- | --------: | --------------: | --------: | --------: | -------------- |
| pc-01     |         6 |           0 → 0 |         6 |    52.7초 | 자동 재현 부족 |
| pc-02     |         4 |           0 → 0 |         3 |    34.5초 | 자동 재현 부족 |
| pc-03     |         5 |           0 → 0 |         5 |    42.9초 | 자동 재현 부족 |
| pc-04     |         4 |           1 → 3 |         1 |    51.2초 | 부분 개선      |
| remote-01 |         5 |           0 → 0 |         5 |    52.6초 | 자동 재현 부족 |
| remote-02 |         6 |           0 → 0 |         6 |    57.2초 | 자동 재현 부족 |
| remote-03 |         6 |           0 → 0 |         6 |    57.7초 | 자동 재현 부족 |
| remote-04 |         4 |           0 → 0 |         4 |    55.5초 | 자동 재현 부족 |
| remote-05 |         0 |           0 → 0 |         0 |    27.5초 | 설비 0개 유지  |

모델 원후보는 합계 40개로 변경 전과 같다. 최종 배치는 3개, 보류 36개, 명시 제외 1개이며 추적 누락은 0개다. 설치 2차 관측이 추가됐지만 설비 종류·bbox 1차 원응답은 전후 9장 모두 같았다. 원응답을 재생해 만든 최종 결과가 아니라 같은 digest·seed로 실제 모델을 다시 실행한 기록이다.

pc-04의 창 1개에 변기와 거울이 더해졌다. 원본 사진의 반사를 붙이지 않은 거울이며, 변기 색도 원본의 청록 계열을 유지한다. 그러나 이중 세면대 하부장은 기본 모형이 방 범위를 넘어 보류됐고, 창·변기의 상대 크기와 공간 비율은 원본과 다르다. 3개가 보인다는 이유로 위치·크기 정확성을 통과시키지 않았다.

pc-01/02/03 및 remote-01/03/04는 출력에 주요 설비가 없고 원본 재현이 여전히 부족하다. 원본 촬영 카메라는 pc-04와 remote-02에서만 추정됐다. 나머지는 비슷하게 정면을 향하는 벽 조각 또는 같은 축의 여러 옆벽 때문에 보류됐다. remote-02는 카메라를 얻었지만 잘린 제품·설치 방식·벽 대응 문제가 남아 배치 0개다. 즉 **기하 호출 누락은 해결됐으나, 관측의 신뢰도와 제품 설치 연결 문제는 남았다.**

remote-05는 설치된 주요 설비를 생성하지 않아 음성 대조 조건을 유지했다. 벽 홈·단차·배관까지 복원한 것은 아니다. 유리는 최종 자동 결과에 하나도 생성되지 않았으므로 투명도·뒤쪽 욕조와 가림 품질을 이번 자동 출력의 성공 항목으로 기록하지 않는다. 거울 반사 속 중복이 출력되지 않았더라도 모두 배치 보류된 사진에서는 반사 인식 성공으로 집계하지 않는다.

### 실행·로그 검증

변경 전 9장, 변경 후 9장 모두 기존 분석과 후보 분석을 실제 실행했다. 최종 로컬 요청은 목록 9회·설치 8회·기하 9회(총 26회)였고, 설비 목록이 비어 있는 remote-05의 설치 단계만 명시 생략했다. 새 MoGe 추론은 9회이며 모델/결과 캐시 적중은 0회다. 준비된 가중치는 디스크에서 로드했으며 새 다운로드는 없다. 실패·브라우저 오류·외부 POST는 0건, 새로고침 뒤 진단 18회가 보존됐다. 기존 사진·자료를 덮어쓰거나 외부로 사진을 업로드하지 않았다.

후보 분석은 사진당 27.5–57.7초, 합계 431.8초다. 그 전에 수행한 기본 분석 9회의 합계는 291.3초여서 두 분석 합계는 약 12.1분이다. 화면 조작·스크린샷·JSON 내보내기 시간은 별도다. MoGe 자체 로드 0.46–0.65초, 추론 0.86–1.43초, 평면 추출 0.34–1.32초, 최종 소프트웨어 WebGL 렌더는 0.88–1.93초였다. 전체 후보 시간이 MoGe 순수 추론 시간과 다른 이유는 Qwen 두 단계·분할 준비·통신·표준 모형 생성 등이 포함되기 때문이다.

MoGe Python RSS 표본 최고치는 사례별 약 1.67–1.71GB, CUDA allocator 최고치는 1.20–1.21GB였다(십진 GB). 메인 페이지 JS heap 최고치는 198–308MB다. 이 값을 더해 전체 시스템 요구 메모리로 해석하지 않는다. Qwen RAM/VRAM·브라우저 Worker/WASM 및 시스템 전체 최고치는 미측정이다.

### 코드 상태 일치

9장 실행 시작·종료의 108개 런타임 소스 해시는 동일했다: `cf89759dd2941f82cb2702e11b0f6b924eb34755a9f3b0168daafe735251157a`. 사진·모델 파일·환경변수는 이 소스 스냅샷에서 제외했다.

이후 일반 Before **재분석에만** 선택적 `targetFrame`을 추가해 기기별 GPU 한도가 달라졌을 때의 프레임 불일치를 수정했다. 기존 크기 배경을 AI 실행 전에 준비하며, 지원하지 못하면 사진 저장·AI 실행 전에 안내한다. 신규 생성과 Lab은 옵션을 전달하지 않아 동일 인자·동일 순서임을 회귀 테스트로 확인했다. 변경 후 소스는 `final-code/code-state.json`에 별도 보존했으며, 이후 일반 생성·재분석 실제 E2E로 검증을 완료했다. 이 변경을 이유로 9장 자동 결과를 새 추론 결과처럼 다시 기록하지 않았다.

### 인식과 배치를 분리한 다음 수정 우선순위

[케이스별 후보 분석](../test-results/reconstruction-nine-photo/case-analysis.json)과 [원인 요약](../test-results/reconstruction-nine-photo/concise.md)을 남겼다. 이번 변경으로 원후보 인식 자체가 개선됐다는 증거는 없다.

- **공간 좌표 기준:** 카메라 보류 6장은 비슷한 정면 벽 조각, remote-03은 같은 축의 여러 옆벽 때문이다. 다음 기하 실험은 한 조각을 임의 선택하거나 임계값을 느슨하게 하는 방식이 아니라, 실제 지지 점·경계·직교 관계를 함께 검증하는 방 구조 가설을 비교해야 한다. 현재 기본 치수 안에 맞추기 위한 강제 축소는 하지 않는다.
- **세면대 조립체:** pc-01/remote-02/remote-04는 벽걸이 제품을 하부장형으로 해석한다. 전체 제품의 받침·노출 배관·아래 빈 공간을 종류 관측과 함께 확인해야 한다. 이번 설치 v2는 기존 종류를 변경하지 않으므로 이 오분류까지 고치지 않는다.
- **물리 거울과 반사 물체:** pc-02는 물리적 거울 패널 자체를 reflected로 잘못 제외했다. 반사 여부와 ‘반사하는 표면’ 종류를 분리한 관측 계약의 검증이 필요하다. 모델이 반환한 reflected 값 하나를 품질 정답으로 취급하면 안 된다.
- **선반의 위치별 식별:** remote-01은 실제 높은 수건 랙 대신 수전·병 받침을 wallShelf로 관측한다. 이름 일치만으로 랙 인식 성공을 계산하지 않는다. remote-04의 반벽·턱도 선반/수납장으로 혼동한다.

더 큰 모델이나 다른 깊이 모델을 채택할 근거는 아직 없다. 다음 비교는 위 항목별 실제 오류 감소, 처리 시간, RAM/VRAM을 같은 9장에서 확인해야 한다. 이번에 실패한 A/B 프롬프트처럼 응답 항목만 늘고 오분류가 증가하면 채택하지 않는다. 추가 모델 다운로드·교체는 수행하지 않았다.

## 측정 조건과 해석

실측 없는 기본 방 크기는 전후 모두 **2400×2400×2400mm**다. Windows 11 Home 10.0.26200, Ryzen 7 7800X3D(8코어/16스레드), 사용 가능 물리 RAM 33,444,208,640바이트, RTX 4070 Ti 12,282MiB, 드라이버 591.86에서 실행했다. Chrome 152.0.7977.83 headless의 **ANGLE SwiftShader 소프트웨어 WebGL**이며 렌더 시간을 사용자 GPU 성능처럼 해석하지 않는다. 개발 도구와 단위 테스트가 일부 병행돼 독립 벤치마크는 아니다.

Qwen은 `qwen3-vl:4b-instruct-q4_K_M`, 실제 digest `ee4b975b58c17ce268cd19d40db35d5edc64603035d2ffc1fee1968eb0947f7b`다. 목록 프롬프트 8/`fixture-inventory-v2`, 설치 프롬프트 2/`fixture-installation-v2`를 사용한다. MoGe는 `Ruicheng/moge-2-vits-normal@26b477f41595707c5db6770294c0d1721e8ed4ed`, 추출 알고리즘 `moge2-semantic-planes-v2-consensus-support`다. 공통 분석 revision은 `local-quality-v1-support-geometry-2`다.

현재 준비된 가중치를 사용하므로 모델 다운로드는 수행하지 않는다. Qwen의 메모리 로드·이미지/프롬프트 처리·토큰 생성 시간과 MoGe 로드·추론·평면 추출 시간을 별도 기록한다. Lab 후보 실행은 직전에 완료한 기본 분석 결과를 재사용하지만, 기하용 분할 맵을 얻기 위한 새 DeepLab 처리가 발생할 수 있다. `quality.timing.geometryMs`는 그 준비까지 포함하고 MoGe 순수 추론 시간은 `geometry.measurement.inferenceMs`다. Qwen 1단계는 Lab 바깥에서 이미 실행해 전달될 수 있어 `quality.timing.inventoryMs=0`만 보고 모델을 생략했다고 판단하지 않는다. 실제 시간은 `pipeline.model.measurement`와 `reuse`를 함께 읽는다.

메모리 범위는 메인 페이지 JS heap, Python RSS 20ms 표본, PyTorch CUDA allocator 최고치 각각이다. 브라우저 Worker/WASM, Ollama RSS/VRAM, OS·전체 PC 최고치는 이번 최종 실행에서 측정하지 않는다. MoGe 캐시 적중이면 새 추론 메모리 측정과 분리한다. 원사진 치수·배치에 대한 실측 정답이 없으므로 mm 정확도 점수는 산출하지 않는다.

## 기능·회귀 검증 결과

| 검사                                | 실제 결과                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Vitest 전체                         | 137파일, 1,661개 통과 (`unit-final-with-frame.log`)                                                          |
| Python 평면·지지 회귀               | 13개 + 독립 수학 self-test 4항목 통과. 합성 관측/수학 테스트이며 AI 인식 성공을 뜻하지 않음                  |
| 분석 프로필 브라우저                | 7개 통과. 준비/미지원/저장된 선택/취소 등 UI 경계, 가용성 응답은 모의 테스트                                 |
| 기존 편집·시안·실패·재구성 브라우저 | 대상 24개 중 최종 20개 통과, 환경변수 필요한 4개 미실행. 첫 실행 4실패 후 의미를 확인해 해당 4개 재검증 통과 |
| 일반 로컬 정밀 분석 실제 E2E        | 1개 통과. 모델 응답 모의 없음. 생성·저장·재진입·Before 편집·undo/redo·비교 PNG·재분석·전체 복원 확인         |
| 타입 검사                           | `npm run typecheck` 통과                                                                                     |
| lint                                | 전체 `npm run lint` 통과. 추가 targetFrame 파일도 scoped ESLint 통과                                         |
| 빌드                                | Next.js 및 vinext 최종 순차 빌드 통과. 개발 전용 모델·검증 자료의 Next trace 포함 0개 확인                   |

기존 브라우저 회귀는 `reconstruction.spec.ts`, `reconstruction-standard.spec.ts`, `reconstruction-open-toilet.spec.ts`, `reconstruction-lab.spec.ts`, `reconstruction-pipeline-lab.spec.ts`, `designs.spec.ts`, `design-failures.spec.ts`다. 미실행 4개는 별도 실제 사진/기존 보고서 입력 환경변수를 요구한 opt-in 테스트다. 이를 통과로 계산하지 않았다. 최종 9장 실제 분석과 일반 로컬 E2E는 별도로 실행했다.

첫 회귀 실패는 (1) 감지된 세면대가 반드시 모형으로 배치된다는 오래된 기대, (2) 새 관측 사진 img를 출력 PNG로 잘못 고른 선택자, (3) 진단 메타데이터 추가 후 전체 오류 객체 동일성 기대, (4) 바닥 직접 지지 유리를 높이 550mm로 띄우는 부적절한 테스트 입력 등이었다. 원후보·보류 이유·기존 오류 내용·실제 출력 일치·지지면 명시를 검사하도록 바꿨다. 실제 모델 누락을 가짜 성공으로 교체하지 않았다.

### 일반 화면 실제 실행

최종 결과는 [실제 E2E 증거](../test-results/e2e-local-quality-final-03/reconstruction-local-quali-4791b-ean-PNG-and-reanalysis-undo/local-quality-integration-evidence.json), [진단 원문](../test-results/e2e-local-quality-final-03/reconstruction-local-quali-4791b-ean-PNG-and-reanalysis-undo/actual-local-diagnostic-archive.json), [실제 비교 PNG](../test-results/e2e-local-quality-final-03/reconstruction-local-quali-4791b-ean-PNG-and-reanalysis-undo/05-comparison-after-editor.png)에 있다.

이 검사는 pc-04 사진과 입력 가능한 비기본 치수 **3200×2600×2400mm**로 기능을 확인했다. 9장 품질 평가의 2400mm 기본값과 구분한다. 자동 변기·창·거울 3개가 생성됐고 실제 생성한 변기의 폭을 수정해 undo/redo를 검사했다. 사용자 추가 모형으로 대체하지 않았다. 하부장은 여기서도 범위 초과로 보류됐다.

생성 57.663초, 재분석 52.337초, 전체 검사 131.357초다. Qwen 목록·설치 각 2회 및 기하 요청 2회가 모두 200 응답이었다. Qwen은 새 추론이며 **MoGe는 두 번 모두 실제 저장 캐시를 재사용**했다(요청 약 2.52/2.55초, 새 추론 0초·새 메모리 측정 없음). 이는 최종 9장 MoGe 새 추론 결과와 구분한다. 브라우저 외부 HTTP 시도와 uncaught 오류는 0건이다.

재분석 전후 4096×2731 프레임·비율·카메라 버전·After 전체 시안·원본 참조를 유지했다. 비교 PNG는 4096×1366이며 선택/해제 상태에서 내보낸 두 이미지의 raw RGBA가 완전히 같았다. Before 편집 중에는 기존 정책대로 내보내기가 비활성이고 After로 돌아와 비교 출력했다. 직접 확인한 PNG에는 손잡이·선택 테두리·금액 패널이 없다. Before/After의 색·모형 차이를 보이는 샘플 픽셀 비율 48.0%는 출력 경로 검사값이며 재현 정확도 점수가 아니다.

앞선 `final-01/02`는 실제 생성만 완료한 뒤 테스트 기본값/선택자 가정 때문에 중단됐다. 실패 기록을 보존하고 최종 통과 기록 `final-03`과 분리했다. 전체 기록이 모두 기능 통과한 것처럼 합산하지 않았다.

### 최종 빌드와 추적 범위

`next-build-final-clean.log`의 Next.js 빌드는 경고 없이 종료 코드 0, 이어 실행한 `vinext-build-final-clean.log`도 종료 코드 0이다. vinext는 4개 정적 경로를 만들고 17개 동적/API 경로의 사전 렌더를 생략했다. 실제 Cloudflare 배포는 수행하지 않았다.

첫 Next 빌드는 개발 전용 Python 실행 경로를 동적으로 추적하면서 `tmp`·`test-results`까지 포함하는 경고를 냈다. `geometry-local-server.ts`의 경로 해석·프로세스 실행 인자 두 곳에 공식 빌드 진단에서 제시한 `/*turbopackIgnore: true*/` 주석만 추가했다. 함수 동작은 바꾸지 않았으며 주석 제거 전후 소스 및 방출 JavaScript의 동일성을 `geometry-trace-ignore-equivalence.json`에 기록했다.

재빌드 뒤 24개 trace 전체의 `tmp`·`test-results`·모델 가중치·첨부·환경파일 포함은 모두 0개다. 기하 API의 추적 파일 수는 8,487개에서 105개로 줄었다. 전후 근거는 `geometry-trace-before-ignore.json` 및 `geometry-trace-after-ignore.json`이다. 이 manifest 확인은 로컬 산출물 검사이며 사진이 외부에 배포됐다는 의미가 아니다.

최종 109개 소스 해시는 `9167a4add7fe12c56603a2aea5745d1c99f7b96cc67c0e13d9c15872746c939b`이며 `final-code-build/code-state.json`에 보존했다. 실제 일반 E2E 이후 차이는 위 빌드 전용 주석뿐이다. 관련 12개 테스트·scoped ESLint와 재빌드 후 `npm run typecheck`가 통과했다. 주석 변경 때문에 동일 AI 추론을 다시 실행하지 않았다.

vinext에는 Node `punycode` 사용 중단, `glob` 실험 기능, 향후 Vite native config loader의 import 확장자 경고가 남는다. 현재 빌드 실패나 재구성 오류는 아니며 경고를 숨기는 설정을 추가하지 않았다. vinext가 `.next/types`를 생성한 직후 직접 `tsc`를 호출하면 Next 생성 타입과 혼재할 수 있었다. 저장소의 정상 검사 명령 `npm run typecheck`는 먼저 `next typegen`으로 타입을 재생성하며 최종 통과했다.

## 미지원 환경과 남은 범위

현재 정밀 경로는 같은 PC의 Next 개발 서버·Ollama·CUDA Python이 필요하다. Cloudflare Workers 또는 `next start`에서는 명시적으로 미지원이며 브라우저 기본 분석을 선택할 수 있다. 유료 API, 외부 사진 전송, D1/R2/Supabase 실제 연결·배포, CPU 전용 MoGe, 신규 PC 설치·저사양 성능 검증은 하지 않았다. 제품용 TripoSR/BiRefNet은 변경하지 않았다.

공식 모델·코드의 라이선스, 고정 버전, 준비 방법은 [실행 가이드](reconstruction-local-quality.md)에 있다. 모델 교체 여부는 실제 인식 누락과 기하 실패를 분리해 판단해야 한다. 답변 필드를 늘렸다는 이유로 더 많은 정보를 맞혔다고 보지 않으며, 이번 A/B 대조처럼 잘못된 설치 정보를 늘리는 변경은 채택하지 않는다.
