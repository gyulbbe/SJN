# 재구성 후보 파이프라인 구현·검증 점검표

작업 기준: [전체 개선 요구사항](prompts/before-reconstruction-improvement.md). 2026-09-13 코드 고정 시점의 소스와 확인된 검사에 대한 감사다. 기존 DeepLab 경로는 기본 분석기로 유지하며 후보 파이프라인은 독립 테스트 화면에서 명시적으로 실행한다. 구현·단위 검증과 실제 사진 인식 품질을 구분한다.

실제 36장(개발 24장 / 최종 평가 12장)의 실행·집계를 완료했다. 후보 유효 10장도 모두 카메라 보류로 배치 0개여서 기본 엔진으로 채택하지 않았다. 자동 인식 성공과 기능 검사 통과를 구분한다. 평가 뒤 통신 자원 정리만 보완했으며, 고정 평가 소스는 별도로 보존했다. 최종 기능 검사는 아래 표와 [결과 문서](reconstruction-pipeline-results.md)에 기록한다.

| 요구사항 | 현재 구현과 파일 근거 | 상태·실제 검증 범위 |
|---|---|---|
| 기존 기준선 고정, 동일 사진·치수, 인식과 적용 분리 | `lab-engine.ts`의 baseline/model revision, `index.ts`의 선택적 분석 훅, `lab.ts`의 `rawSegmentationCandidates`·`rawReview`·`fixtures`. `tests/reconstruction-corpus-browser.ts`는 고정 입력·치수와 소스 해시를 기록 | 구현. 일반 프로젝트는 기존 DeepLab 경로 유지. 동일 자료 36장 실제 비교 완료; 후보 실패 26장 포함 |
| 독립된 설비·관계·기하·모형·확인 단계 | `pipeline-contract.ts` → `scene-understanding.ts` → `source-camera.ts` → `candidate-pipeline.ts` → `reconstruction-lab.tsx` | 구현. 검증 실패·보류를 빈 성공 장면으로 바꾸지 않음 |
| 후보 종류·설치·형태·관계·근거·unknown·필드별 출처 | `SceneUnderstanding`에 ID/사진 범위/설치 방식·벽/세면대 형태/반사/관계/근거/불확실성. `candidate-pipeline.ts`는 model·geometry/inferred·default·user를 분리 | 구현. unknown은 원자료와 확인 UI에 보존. 모델 설명은 독립 검증된 확률이나 사실로 표현하지 않음 |
| 분석기 근거 충돌·반사·유리·중복 처리 | `candidate-pipeline.ts`의 근거 대조·중복 보류, `source-camera.ts`의 reflectionOf 보류. visibleThrough의 뒤 설비는 독립 후보로 유지 | 단위 검증 통과. 수동 위치만 바꿔도 종류 충돌·반사가 자동 확정되지는 않음. 실제 사진 관측·배치 오류를 분리해 최종 비교표에 기록 |
| 원본 촬영 시점과 공통 출력 카메라 분리 | `source-camera.ts`는 사진 좌표→방 mm 좌표→사진 재투영에만 사용. `index.ts`/`projection.ts`의 공통 공간 카메라로 Before/After 출력 | 구현 및 통합 회귀 통과. 후보 카메라를 최종 Before에만 적용하는 경로 없음 |
| 관측 모서리·소실 방향·입력 방 크기의 기하 적합 | 완전 뒤 벽 네 점, 독립 비평면 named 모서리 6개 이상, 또는 두 축 이상의 평행선과 named 모서리의 거리 제약. `source-camera.ts`와 `tests/reconstruction-source-camera.test.ts` | 기하 단위 28개 통과. 부족한 제약·비직각·퇴화·큰 잔차는 보류. 원시 영상의 별도 자동 선 검출기나 실측 카메라 보정은 아님 |
| 올바른 접지/부착점, 잘림과 부착 벽 검증 | `pipeline-contract.ts`의 `OBSERVED_ANCHOR_BOUNDS_TOLERANCE`, `source-camera.ts` 및 `scene-understanding.ts`의 근거·영역·설치 종류 검사 | 구현 및 기하 회귀 통과. 다른 물체의 접점이나 빈 근거로 잘린 설비를 자동 배치할 수 없음. 벽걸이는 바닥 접점을 요구하지 않음 |
| 표준 모형 선택·방향·규격·설치 높이 | `candidate-pipeline.ts`가 기존 `types.ts`의 종류별 기본값과 `templates.ts`를 사용. 세면대 지지 형태와 사각/둥근 볼 선택. UI의 위치·규격·높이 보정, 바닥 방향 보정 | 구현 범위를 제한해 표시. 규격은 기본값/사용자 값이며 자동 실측 아님. 벽 설비는 설치 벽 방향을 따름. 외곽 오차를 최소화하는 연속적인 치수·형상·방향 최적화는 없음 |
| 모형이 바닥에서 뜨거나 방 밖으로 나가는지 검사 | `validateSourceFixture`는 실제 모형 상자·공간 범위·가시성을 검사하고 `modelChecks`에 남김. 실패 시 plans=null 및 placement/review 보류 일치 | 후보 단위 23개 통과. 후보를 조용히 삭제하거나 검사 통과를 위해 자동 축소·이동하지 않음 |
| 거울·유리의 표준 표현과 미지원 형태 정직한 표시 | 기존 v2 `templates.ts`/`standard-render.ts` 재사용. 은회색 거울·문 경계, 독립 투명 유리. 새 후보에는 원본 반사/벽 사진 크롭을 넣지 않음 | 구현 및 관련 후보 단위 검증. 비세면대 shape는 기본 모형과 차이 안내로 보존. 예: round 거울을 직사각 모형으로 출력해 원형 구현 성공으로 세지 않음 |
| 간단 확인, 누락 추가·제외·위치/크기 보정, 원모델 보존 | `reconstruction-lab.tsx`의 확인 목록·정답·추가/제외·보정 실행. `lab.ts`의 원분석 재사용, `automaticUnderstanding`와 보정 결과의 깊은 복사 | 통합 회귀 통과. unknown/held 항목도 확인 가능. 보정 시 새 AI 호출 없이 다시 렌더. 실제 후보 실행→교정→PNG UI 통과; 추가 AI 요청 없음 |
| 사진상 관측 오차와 사용자 추가의 구분 | `candidate-pipeline.ts`가 원래 자동 후보의 동일 ID bounds만 모형 외곽 오차에 사용. `source-camera.ts`의 `projectedBounds`·`bboxErrorPx` 분리 | 최신 단위 회귀 통과. 사용자 추가의 전체 화면 임시 bounds로 오차를 만들지 않음. 기존 후보 수동 보정은 원래 사진 영역 비교 유지. 픽셀 오차 기준 해상도는 source camera의 image에 명시 |
| Qwen의 실제 로컬 비교와 안전한 응답 검증 | `local-engine-client.ts`/`local-engine-server.ts`/`scene-understanding.ts`. 개발·loopback·동일 출처·명시 실행만 허용하고 고정 Ollama 엔드포인트/태그 사용. 좌표·ID·관계·설치 모순과 JSON 검증 | 구현, 실제 로컬 스모크 실행 확인. 스키마 검증 실패는 원문·측정값·실패 사유를 보존. 응답 길이 제한 등 더 이른 실패는 사유만 남아 원문/단계별 시간이 없을 수 있음. 단순 규칙/모의 응답을 새 AI 결과로 표시하지 않음. 36장 평가 완료. 일반 fetch/body 실패의 취소·해제 확인·재실행 차단은 평가 후 추가한 22개 런타임 단위 검증에 포함 |
| 모델·라이선스·런타임·다운로드 정체성 | `lab-engine.ts`의 Qwen tag/실제 digest/설정/prompt revision, [파이프라인 문서](reconstruction-pipeline.md)의 공식 모델·런타임 자료. TripoSR/BiRefNet 기존 기능 유지 | 공식 자료 확인 기록 존재. native Ollama CPU/GPU 구성이며 브라우저 4B 추론이 아님. 캐시된 로컬 모델을 요구하고 자동 pull·새 사용자 모델 기본 다운로드 없음. 저사양/OCI 성능 미검증 |
| 독립 lab 다중 사진·이력·PNG/JSON·엔진 연결 상태 | 기존 `/reconstruction-lab`, `lab.ts`의 메모리 저장소와 PhotoCompositor, `reconstruction-lab.tsx`의 순차 큐·원본/기준선/후보/보정 이력·확대·다운로드 | 구현. 미연결 엔진 실행 차단, 케이스별 치수 사용, 원기준선 유지. 실제 다중 사진·취소·다운로드와 후보 교정 UI 통과 |
| 시간·입력/출력 해상도·메모리 범위 | `lab.ts`의 원본/미리보기/분석/출력 크기와 생성·렌더·전체 시간. 로컬 모델 준비/이미지·프롬프트 평가/텍스트 생성/요청 시간 분리 | 구현. 합산 생성 시간을 순수 추론 시간으로 부르지 않음. 페이지 JS heap과 런타임 메모리는 별도 범위, 미측정 Worker/WASM/GPU/전체 프로세스를 0으로 표시하지 않음. 실제 사진별 집계 완료. 전체 프로세스·저사양 성능은 미측정 |
| 취소·오류·늦은 응답·자원 해제 | `segmentation/index.ts` 전용 Worker 취소/15분 제한, `lab.ts` finally의 renderer/메모리 저장소 정리, UI 실행 ID·케이스 확인 및 URL 해제, 로컬 후보 단일 추론 | lab·통합·전용 Worker 회귀 근거 존재. 공유 Worker를 취소하지 않음. 실제 취소·재시도·이전 결과 보존 UI 통과. 미완료 통신의 해제 확인 실패는 다음 추론 차단 후 연결 재확인으로 복구 |
| 실제 사진 30장 이상, 정답/실패 정의·분할 고정 | [평가 자료 문서](reconstruction-corpus.md), `tests/fixtures/reconstruction-corpus-v1.json`, 입력 검증/집계 도구 | 실제 36장·개발 24/최종 12·설비 114개와 해시 고정. 출처/라이선스 검토 완료. 독립 Codex 시각 주석이며 다인 합의·실측 정답 아님. 구현 전체보다 먼저 고정했다고 주장하지 않음 |
| 누락·오탐·종류·설치·벽·형태·반사·오차·수정량·시간·메모리 분리 | `tests/reconstruction-corpus-metrics.mjs`와 corpus runner; 동일 입력·치수와 인식/적용/사용자 보정 구분 | 평가 코드와 정의 구현. 전체 36장 및 heldout 비교·사진별 결과 완료, 후보 미채택. 실측 없는 위치 오차/사용자 수정량의 미측정 범위를 숨기지 않음 |
| 기존 Before/After·시안·저장·견적·출력 호환 | `index.ts`는 선택적 훅 없는 기본 경로 유지. lab은 임시 저장소만 주입하며 사용자 프로젝트·불변 자재·시안을 쓰지 않음. `tests/reconstruction-pipeline-integration.test.ts` | 관련 7개 통합 회귀 통과: 기본 DeepLab, null 계획 보류, 공통 카메라·빈 After, 원본 자산 보존·재사용·취소. 사진 없는 기존 빈 공간 경로와 기본 벽/바닥 보호 UI를 수정하지 않음. 기존 UI·저장 관련 브라우저 회귀 15개 통과, 선택 사진 1개 미실행 |
| 단위·브라우저·lint·타입·Next.js·vinext | 기하/후보/통합/lab 단위, `e2e/reconstruction-pipeline-lab.spec.ts`·기존 e2e, package 검증 명령 | 전체 단위 71파일·695개, lint·타입 통과. 기존 회귀 15개+lab 6개 통과(선택 사진 1개 스킵), 실제 비교 HTML 36카드·82이미지·46PNG 링크 검사 통과. 최종 Next.js·vinext 빌드 모두 통과. 생성물 충돌이 없도록 순차 실행하며 중간 실패와 재실행은 결과 문서에 구분 |
| 평가를 근거로 채택 결정·한계·미실행 공개 | [파이프라인 설명](reconstruction-pipeline.md), [기하 한계](reconstruction-source-camera.md), 실제 corpus 결과 보고서 | 기본 엔진 교체하지 않음. 실제 평가에서 자동 배치 개선 근거가 없어 후보 미채택. 전체 평가용 사진을 본 뒤 이를 새로운 독립 평가로 재사용하지 않음. 외부 배포·유료 API·서버 사용자 자료 이동은 미실행 |

파일명이 짧게 적힌 구현 경로는 `src/lib/reconstruction/` 아래이며 UI는 `src/components/reconstruction/`, Worker는 `src/lib/segmentation/` 아래다. 테스트 경로는 저장소 루트 기준이다.

## 완료 보고에서 구분할 사항

- **구현한 것:** 관측 구조·검증·소스 카메라 적합·명시적 보류·기본 모형 선택·간단 보정·원본과 보정 결과 분리·독립 실제 비교 실행 경로다.
- **자동으로 하지 않는 것:** 제품 실측, 연속적인 모형 치수/자세 최적화, 원형 거울 등 미지원 모형 형태 생성, 미관측 수납장 내부 추정, 후보 결과의 일반 프로젝트 자동 채택이다.
- **실제 평가 한계:** 입력 방 치수는 두 엔진에 같은 비교 조건이며 현장 실측이 아니다. 사진 주석은 대략적인 가시 영역과 관측 가능한 속성이고, 실제 카메라/제품 mm 정답이 없다. 수치 왕복 오차와 모델 외곽 진단은 독립 인식 정확도가 아니다.
- **실제 평가 완료:** 36장 원본·기준선·후보/실패·측정 결과 및 채택 결론을 보존했다. 후보 유효 10/36장·배치 0개이며 새 모델을 기본으로 적용하지 않았다. 사용자 수정량, 실제 제품 mm 오차, 저사양·OCI·모바일 기기 추론은 미측정이다.

## 평가 후 최종 수정

`local-engine-server.ts`의 일반 전송 실패에도 전용 요청 취소와 고정 모델 해제를 수행하도록 보완했다. 응답 완료·해제 실패·동시 요청 차단·연결 재확인 복구는 22개 모의 런타임 단위 검사로 확인했다. 이 모의 응답은 인식 평가에 포함하지 않았다. 실제 후보 UI는 별도로 Qwen POST 1회 후 사용자 교정과 PNG 일치를 확인했다.

`tsconfig.json`은 생성된 `test-results`와 `playwright-report`를 타입 검사에서 제외한다. 평가 소스 보존본은 현재 앱의 소스 트리가 아니며 원래 상대 의존성 전체를 복제하지 않았으므로, 보존본까지 검사하여 생긴 오류를 해결한 설정이다. 실제 앱·tests·e2e 타입 검사는 유지한다.
