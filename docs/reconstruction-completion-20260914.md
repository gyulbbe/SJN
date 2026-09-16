# 사진 → Before 개선·검증 최종 인계

2026-09-14. 요청한 **관측·설치·표준 모형 연결 개선, 간단한 사용자 보정, 테스트 화면·저장 호환과 실제 검증**을 완료했다. 자동으로 모든 사진의 정확한 공간·형상을 복원한 상태는 아니다. 자동 배치가 보류되면 원래 관측과 이유를 남기고 사용자가 확인할 수 있다. 아래 한계는 구현 완료와 별도로 유지한다.

**DeepLab 기본 경로는 유지하고 Qwen은 개발용 로컬 비교 후보로 남긴다.** 새로운 대형 모델의 기본 다운로드, TripoSR/제품 배경 제거 교체, 외부 사진 전송·유료 API·배포는 하지 않았다.

## 사용자에게 달라진 점

홈의 **사진 재구성 테스트**(`/reconstruction-lab`)에서 여러 사진을 독립적으로 검사한다. 분석 정상 종료, 일부/전체 배치 확인 필요, 실패, 취소를 구분하고 원후보·정리 후·실제 배치·확인 필요 수를 표시한다. 원문·단계·시간·종료 이유와 보정 전후 자료를 별도로 다운로드할 수 있다.

후보의 **필드 확인 / 사용자 교정**에서 종류·볼 형태·지지 구조·볼 개수·설치 벽·높이·규격을 조정한다. AI를 다시 실행하지 않는다. 벽 기준 그림 이동, 욕조 테두리/샤워 턱 위 유리, 거울·거울장·선반의 **세면대·하부장 위에 맞추기**를 제공한다. 마지막 기능은 선택 시점의 위치 복사이며 이후 부모 이동을 따라가는 관계는 아니다.

종류를 바꾼 뒤 숨은 세면대 지지값 또는 볼 개수가 남아 검증을 막는 문제도 수정했다. 적용되지 않는 값은 설명과 명시 삭제 버튼을 제공하며 원모델 값은 보존한다. 사용자 위치·참고 설비 스냅샷도 저장된다.

**이 결과로 공간 만들기**를 누르면 명시적으로 로컬 프로젝트에 저장한다. 보정 결과는 Before, 같은 방·카메라의 빈 공간은 After가 된다. 사진 없이 생성할 때 양쪽 빈 공간인 기존 의미도 유지한다. Lab 세션 목록 자체는 페이지 메모리이므로 일반 새로고침 후 복구되는 대상은 저장한 프로젝트다.

## 수정한 공통 원인과 주요 파일

| 원인 | 구현·확인 |
|---|---|
| 후보를 찾은 상태와 실제 배치가 혼합됨 | `candidate-pipeline.ts`, `pipeline-contract.ts`, `lab-report.ts`: 원관측·정리·설치·공간·모형·보류를 구분. 전체 카메라가 보류돼도 독립적으로 판단한 지지 방식 유지. |
| 중복·종류 충돌·반사·부품·유리 중첩의 혼동 | `candidate-resolution.ts`, `scene-understanding.ts`, `inventory-observation.ts`: 정상 후보 보존, 의미 모순 격리, JSON 손상은 실패. 상판 볼/하부장 결합과 두 볼 관측을 별도 처리. |
| 볼 모양과 지지 방식이 하나의 기본 세면대로 대체됨 | `basin-observations.ts`, `templates.ts`, `types.ts`, `standard-model-render.ts`: 사각/곡면, 벽걸이/기둥/하부장, 1/2볼, 열린 변기. 거울은 중립 표면, 유리는 독립 반투명 모형. |
| 벽/바닥 기준·접점·규격 혼합 | `installation.ts`, `observed-placement.ts`, `observed-support-contact.ts`, `source-camera.ts`: 같은 사진의 검증된 연속 기둥 하단과 출처를 연결. 기둥형 볼 bbox 하단의 바닥 투영은 보류. 바닥 제품 bbox를 벽 homography로 mm 환산하던 경로 제거. |
| 기본 구도와 원사진 구도 혼동 | 공통 Before/After 카메라는 유지하고 source-camera를 별도 해석. 근거 없는 방 모서리를 채우거나 벽 침범을 강제 이동으로 통과시키지 않음. |
| 보정 입력과 설치 관계 유지 부족 | `manual-placement-editor.tsx`, `lab-wall-alignment.tsx`, `wall-alignment.ts`, `lab-correction.ts`, `bath-rim.ts`: 벽 기준 입력·위치 복사·욕조 연결과 원문/사용자 스냅샷 분리. |
| 종료/오류/캐시 진단 부족 | `lab.ts`, `lab-engine.ts`, `lab-cache.ts`, `local-engine-client.ts`, `local-engine-server.ts`, `reconstruction-lab.tsx`: 간결한 v2 관측 계약, 종료·토큰·시간·오류 보존, 호환 관측 재사용, 취소/늦은 응답 차단. |
| 저장과 편집 보존 | `lab-project.ts`, 저장소 참조/검증, `room-editing.ts`: Before와 빈 After·원보고서 저장, 선택적 필드/과거 문서 호환, 기본 면 보호. |

경로는 `src/lib/reconstruction/` 및 `src/components/reconstruction/` 기준이다. 상세 연결은 [설치 분리](reconstruction-independent-support-results-20260913.md), [바닥 규격](reconstruction-baseline-floor-size-20260913.md), [벽 기준 이동](reconstruction-wall-drag.md), [욕조 연결](reconstruction-lab-bath-rim.md), [위치 참고](reconstruction-wall-alignment-results-20260913.md)에 기록했다. 사진별 좌표는 테스트의 사용자 역할 입력에만 있으며 제품 코드의 파일명·해시 예외로 넣지 않았다.

## 실제 모델 결과와 시간

다음은 `after-installation-shape-final`에 보존한 **v5 실제 DeepLab/Qwen 실행**이다. 최초 사용자 첨부와 다른 후속 실행이며 현재 v10 UI 재생 결과로 이름을 바꾸지 않는다. 기본 관측 v7/후보 v10의 후속 코드 변경은 별도 재생·기능 검사로 검증했다.

표의 개수는 **원출력/정리/배치/확인 필요**, 시간은 초다. 후보는 같은 사진의 기존 분석을 재사용하므로 전체 시간에 과거 DeepLab 시간이 포함되지 않는다. 추가 모델 시간에는 입력 준비·통신·검증이 포함된다. 배치 준비도 순수 배치 계산만의 시간이 아니다.

| 사진·엔진 | 개수 | 이번 전체 | 기존 분석 | 추가 모델 | 배치 준비 / 렌더 |
|---|---:|---:|---:|---:|---:|
| 01 기존 | 15/15/2/13 | 27.209 | 24.964 | 0 | .883 / 1.356 |
| 01 후보 | 6/6/0/6 | 9.436 | 재사용 | 8.389 | .380 / .666 |
| 02 기존 | 4/4/1/3 | 14.094 | 12.359 | 0 | .633 / 1.096 |
| 02 후보 | 4/3/0/3 | 7.987 | 재사용 | 6.847 | .439 / .701 |
| 03 기존 | 13/13/2/11 | 33.203 | 31.035 | 0 | .894 / 1.267 |
| 03 후보 | 5/5/0/5 | 8.428 | 재사용 | 7.415 | .387 / .626 |
| 04 기존 | 17/17/3/14 | 42.016 | 39.525 | 0 | .940 / 1.545 |
| 04 후보 | 4/4/1/3 | 9.320 | 재사용 | 7.463 | .528 / 1.329 |

이 후보 네 실행은 모두 실제 새 Qwen 요청이며 `done=true`, `doneReason=stop`이다. 정상 종료를 재구성 성공으로 세지 않는다. 설치 벽·높이 미확정, 잘린 하단, 지지 기준점/부품 충돌, 공간 범위 검증 때문에 배치가 보류된다. **최초 user02 실패는 당시 원문·종료 진단이 없어 정확한 원인을 소급 확정할 수 없다.** 이후 진단 보존과 실제 정상 종료 기록을 그 실패의 원인 증명으로 사용하지 않는다.

[원필드·해시·사유·시간 요약](../test-results/reconstruction-wall-alignment-final-20260913/actual-model-summary.json). 실제 모델 실행 기록의 관측과 별도 사용자 보정을 혼합하지 않는다.

측정 환경은 Windows 10.0.26200, Ryzen 7 7800X3D, 32GB RAM, RTX 4070 Ti, Chrome152 headless/SwiftShader, TFJS WASM 단일 스레드, 로컬 `qwen3-vl:4b-instruct-q4_K_M`/prompt8이다. 과거 실행의 Ollama 모델 VRAM 할당 관측은 4,235,345,264바이트이며 전체 프로세스 RAM/GPU 최고 사용량이 아니다. 이번 최종 UI 검사에서 새 메모리 측정이나 저사양 기기 성능 측정은 하지 않았다.

## 사진별 실제 확인과 한계

[원본·기존 분석·최종 사용자 보정 비교](../test-results/reconstruction-completion-20260914/comparison.html)는 비공개 로컬 이미지12개를 그대로 보여준다. 오른쪽은 사용자 확인 결과이며 자동 인식 성공률이 아니다.

| 사진 | 보정 후 확인한 핵심 설비 | 관측/기본/사용자 구분과 미확정 항목 |
|---|---|---|
| TEST 화장실.jpg | 변기·사각 벽걸이 세면대·욕조·거울장·욕조 연결 유리·선반 6개 | 거울장 종류는 사용자 설명, 선반은 수동 추가. 중립 거울과 유리 뒤 설비는 표현됨. 거울 전체 폭·유리 방향·모든 세부 형상까지 사진과 일치한 결과는 아님. |
| TEST 화장실2.jpg | 곡면 벽걸이 세면대·거울·열린 변기 3개 | 볼 형태는 실제 관측과 연결, 설치와 반사·열림은 사용자 확인. 세면대가 바닥에 내려앉지 않음. 방의 좁은 구도·문/문틀·마감 정밀도는 미해결. |
| test 화장실3.jpg | 사각 기둥 세면대·열린 변기·거울·턱 위 유리 4개 | 기둥/사각형 관측을 유지하고 위치·턱 규격은 사용자 역할의 추정 입력. 사각 기둥 단면·앞쪽 변기의 가림·유리 폭은 근사. |
| images.jpg | 두 볼 하부장·중립 거울·창·변기 4개 | 두 볼은 후보 관측, 곡면·설치·위치는 사용자 확인, 치수는 기본/사용자 값. 하부장 실제 길이·창 분할·정밀 카메라는 확정하지 않음. |

별도3장은 결과 전에 기준·해시를 고정하고 실제 모델을 한 번씩 실행했다. 원사진 선정 노출이 있어 완전 blind set은 아니다. 후보 bbox 대응9/9는 알려진 종류의 영역 대응이며 배치 성공률이 아니다. 후보 배치는3장 모두0개였다. [별도 평가](reconstruction-evaluation-split-20260913.md)에 누락/오탐과 모든 실패를 남겼다.

그중 prospective-03은 결과 노출 이후 **회귀**로 사용자 보정했다. 세면대·거울·변기3개와 ‘위에 맞추기’ 및 실제 저장을 확인했다. 흰 도기가 갈색으로 나타나고 커튼·문·선반 등이 빠지는 한계는 그대로 기록했다. 나머지2장의 사용자 보정 UI는 실행하지 않았다. [회귀 전후](reconstruction-regression-correction-20260913.md).

## 최종 검사

마지막 숨은 볼 개수 수정 이후 전역 검사 `run-02-fields/checks`는 모두 종료0이다.

| 검사 | 실제 결과 |
|---|---|
| ESLint | 통과,16.844초 |
| 타입 검사 | 통과,5.221초 |
| Vitest | **100파일1,241개 통과**, 명령8.528초 |
| Next.js build | 통과,14.163초 |
| vinext build | Next 다음 순차 실행 통과,21.104초 |

[최종 로그](../test-results/reconstruction-wall-alignment-final-20260913/run-02-fields/checks/checks.json). 빌드 시간은 캐시와 다른 개발 작업의 영향을 포함하며 독립 성능 벤치마크가 아니다. 실패 후 수정 기록도 과거 로그에 보존했다.

- 네 사진 실제 Next 프로젝트 E2E **4개 통과,2.4분**. 현재 파이프라인에서 저장된 실제 관측을 사용해 사용자 보정→Before/빈 After 저장→새로고침→After undo/redo→독립 시안 복사→4096×1366 비교 PNG를 확인했다. AI/외부 요청·페이지 예외0. 마지막 볼 개수 UI 수정 직전 실행이며 마지막 수정은 아래 전용 브라우저 및 최종 전역 검사로 확인했다. [실행 출력 폴더](../test-results/reconstruction-wall-alignment-final-20260913/e2e).
- 위치 복사 순수 계산30개, 실제 production 위치 UI의 합성 입력18항목 통과. atomic 적용·기본/사용자 간격·규격 출처·삭제/이동 이후 동작·범위 실패·직접 수정·disabled를 검사. 이는 AI 정확도 검사가 아니다. [UI 결과](../test-results/reconstruction-wall-alignment-ui-20260913/run-01/verification.json).
- 종류별 입력 신규3개 포함 관련40개, 실제 필드 UI/의미 검증기 브라우저 통과. 종류 왕복, 숨은 지지/볼 값 명시 삭제,390px/키보드/잠금/원문 불변. [최종 필드 결과](../test-results/reconstruction-lab-field-applicability-20260913/run-02-bowl-count/verification.json).
- prospective-03 `run-03-savedalignment`: 실제 Lab 저장 버튼→IndexedDB load→페이지 reload→readLabProjectReport. 참고 부모/방/기본간격150/결과높이1120·원모델 보존, Before3/After빈, 같은 PNG 확인. 마지막 테스트 보완 후 scoped lint/typecheck도 통과. [저장 검증](../test-results/reconstruction-lab-regression-correction-20260913/run-03-savedalignment/verification.json).
- 이전 실제 여러 사진 분석·HTTP503 실패 주입 후 실제 모델 재시도·JSON/PNG 다운로드 기록은 [실제 모델/브라우저 보고](reconstruction-improvement-results-20260913.md)에 있다. 실패 주입을 실제 모델 실패로 합산하지 않는다.
- 기본 벽/바닥은 `normalizeRoomScene`이 보호하고 `fixed-room-editing.test.ts`에서 change/preview/commit/changeProject 네 경로를 검사한다. 원사진·불변 자재·시안·수량/금액 보존 및 과거 문서 호환 검사는 전역 회귀에 포함된다.

개인 사진·원문·보고서·비교 이미지는 Git에서 제외한 로컬 `test-results/`에만 있다. 실제 Supabase 연결·원격 사용자 격리·배포 검사는 수행하지 않았다.

## 채택 판단과 후속 범위

후보는 세면대 형태/부품·유리 존재 등 관측 정보를 늘렸지만 실제 설치·공간 배치가 안정적으로 개선됐다는 근거가 부족하다. 기본 분석기로 채택하지 않는다. 오프라인 depth/평면/카메라 대안 실험도 자동 승인하거나 일반 사용자에게 기본 연결하지 않았다.

후속 우선순위는 **제품 색상 보존, 설치 관계를 이용한 확인량 감소, 관측에 근거한 공간·방향 추정**이다. 남은 형태·가림·구도 문제는 해결됐다고 보고하지 않으며 별도 개선 과제로 인계한다. [후속 구현 프롬프트](prompts/before-reconstruction-next-quality.md).


최종 비교 문서의 이미지12개 로딩·확대·390px 가로 넘침 없음도 확인했다. 최초 file:// 로딩 timeout은 별도 기록하고, 자료를 같은 로컬 폴더에 모은 뒤 임시 loopback 서버 검사에서 통과했다. 모델/앱 분석 실패와 무관한 문서 로딩 검사다. [비교 문서 검사](../test-results/reconstruction-completion-20260914/comparison-verification.json).
