# 사진 → Before 품질 개선·사용자 사진 15장 검증 (2026-09-14)

## 실제 품질 판정

**원본 재현 품질 목표는 아직 달성하지 못했다.** 기존 9장의 벽걸이 세면대 3건·실제 거울 1건의 관측을 보정했지만, 자동 배치는 직전 결과와 같은 3개다. 설비가 있는 8장 중 7장은 여전히 빈 결과다. pc-04의 창·거울·변기를 유지했고, 설비 미설치 사진 remote-05는 올바르게 0개를 유지했다.

사용자가 추가한 TEST 화장실4~9.jpg 6장도 포함해 **총 15장을 최종 코드에서 실제 재실행**했다. 새 6장 중 4·7번 사진에만 2개·3개의 설비가 배치됐으며, 나머지 4장은 빈 결과다. 배치된 경우도 크기·방향·상대 위치·열린 변기 형태가 부족하다. 생성 수를 재현율이나 품질 통과로 계산하지 않는다.

추가 사진의 첫 실행에서 상판 세면볼을 벽걸이로 잘못 바꾸는 새 오류를 발견했다. 보호 규칙을 추가한 뒤 15장을 다시 실행해 잘못된 확정을 차단했다. **최종 15장 렌더는 첫 형태 v2 실행과 픽셀이 동일**하다. 이 변경은 오보정 방지이며 화면 품질 향상은 아니다.

## 비교 자료와 입력

최종 산출물 루트: `test-results/reconstruction-quality-next/`.

- 기존 9장 원본 / 직전 자동 / 최종 자동: `final-v3-comparison/comparison.html`, `final-v3-comparison/nine-photos-before-after.png`.
- 새 6장 원본 / 최종 자동: `final-v3-additional-comparison/comparison.html`, `final-v3-additional-comparison/additional-six-results.png`.
- 원본 경로·SHA-256: `fifteen-photo-manifest.json`, 반복 테스트 목록: `docs/reconstruction-user-photo-corpus-15.md`.
- 시각 평가: 각 비교 폴더의 `human-evaluation.json`. 첫 결과 직접 시각 대조와 최종 픽셀 일치 검증을 구분했다.
- 최종 전체 원문: `final-v3-fifteen/all-report.json`. 전후 후보·픽셀 검증: `final-v3-verification-delta.json`.
- 후보별 첫 보류·제외 원인: `final-v3-quality-summary/summary.json`; 추가 6장의 첫 v2 진단은 `additional-six/actual-evaluation-agent.json`에 별도 보존했다.

기존 9장의 전후 기준은 직전 `test-results/reconstruction-nine-photo/after-01`이다. 새 6장에는 이전 후보 실행이 없으므로 브라우저 기본 분석을 '직전 개선 결과'로 표기하지 않았다. 기본 공간은 전후 모두 **2400×2400×2400mm**, 공통 표시 카메라·출력 크기를 유지했다. 실측 치수·실제 카메라 정답은 없다. 15장은 이미 본 개발 사례이며 독립적인 일반화 성능 평가가 아니다.

15장 원본 바이트 해시는 실행 전후 모두 일치했다. 원사진·기존 사용자 프로젝트·불변 자재 버전은 변경하지 않았고, 테스트는 분리된 브라우저 저장소에서 진행했다. 원본/비교 PNG는 실제 SJN 출력이며 수동 배치나 생성형 이미지 보정은 없다.

## 확인한 원인과 실제 수정

### 고정 ID 형태·거울 관측

기존 4B 모델의 별도 관측 단계를 **목록 → 형태 → 설치 → 분할·기하 → 배치** 흐름에 연결했다. 후보 ID·bbox·원목록은 보존한다. 지원 대상은 기존 basin/vanity/mirror/mirrorCabinet이며 새 후보·좌표·설치 벽을 만들지 않는다.

- pc-01·remote-04: 도기 몸체를 하부장형으로 보던 값을 벽걸이 세면대 구조로 보정.
- remote-02: 원 kind가 vanity여서 설치 v2만으로 변경할 수 없던 사례를 별도 형태 계약으로 basin/wall 제안.
- pc-02: 실제 거울 패널을 reflected로 제거하던 값을 physical로 보정. 거울 내부의 반사 복제본과 구분.
- pc-03: 새 모델 관측이 실제 기둥형을 벽걸이로 잘못 판단했지만 알려진 floor 지지와 충돌해 보정 격리.
- 추가 6번: 상판 위 별도 세면볼을 wall로 제안한 오류를 발견. **다른 유효한 physical vanity 후보가 세면볼 하부와 겹치거나 접하며 아래로 이어지는 경우** 경쟁 지지 근거로 보정 격리. 본인/부모의 기존 partOf 관계도 보호.

화면상 겹침을 실제 3D 지지 관계로 확정하지 않는다. 상판형이라고 자동 재분류하거나 관계를 추가하지 않고 원값을 유지한다. `competingSupportCandidateIds`와 이유를 남긴다. 공통 정규화 좌표 허용치를 사용하며 사진명·해시·특정 사진 좌표 분기는 없다. 우연한 화면 겹침이 보류를 늘릴 수 있다는 한계가 있다.

계약은 `fixture-identity-v1`, prompt 1, 최종 규칙 `fixture-identity-rules-v3`다. original/proposed/final과 applied/confirmed/quarantined/unobserved, `rule-inferred` 보정 및 `model` 관측 출처를 저장한다. 같은 모델의 재관측이며 독립적인 정답 검증이 아니다. 자유 서술문을 코드로 실행하거나 키워드만으로 지지를 확정하지 않는다.

### 기하·접점·충돌 조사와 미채택 실험

- 7쌍 벽 후보의 minimax 평면 적합 대안은 기존 법선·잔차 검사를 통과하지 못했다. 단순 최대 평면 선택·일괄 임계값 완화는 미채택.
- pc-03의 두 가설은 접점이 비슷해도 기본 모형이 방 왼쪽을 약 47mm 넘었다. yaw 90°라면 들어가지만 설치 벽/방향 관측이 부족하므로 강제 회전하지 않았다.
- remote-01의 두 가설은 깊이 차이가 약 197mm이며, 한 접점은 실제 깊이상 변기 몸체, 다른 접점은 관측 제품 하단보다 약 51px 아래였다. 방 안에 들어간다는 사실만으로 접지 합의를 만들지 않았다.
- pc-04는 모형 중심·하부 지지대 앞면·관측 bbox 하단이 서로 다르다. 실제 표준 모형 Box3와 지지 형상을 대조했지만 잘린 사진의 어떤 점을 지지점으로 삼을지 확인되지 않았다. 임의 축소·이동은 미채택.
- remote-02 변기 bbox의 DeepLab 실제 픽셀은 basin 약 55.1%, toilet 약 12.5%였다. 단순 bbox 사각형 겹침/3D 충돌 문제가 아니다. 고정 12% 문맥 crop은 변기 픽셀을 늘렸지만 파편이 남고 세면대 대조군이 악화해 미채택.

제한된 가설 합의 helper는 **진단 실험용이며 운영 배치 경로에 연결하지 않았다**. 더 많은 자동 배치 기능을 구현했다고 보고하지 않는다. 세부 근거는 `geometry/findings.md`, `placement/findings.md`, 모형 원점·실제 분할 실험 자료에 있다.

## 추가 6장 평가

| 사진 | 최종 자동 배치 | 남은 문제 |
|---|---:|---|
| TEST 화장실4.jpg | 기둥 세면대·변기 2개 | 좌우 순서는 남지만 제품이 방에 비해 작게 보임. 열린 변기는 닫힌 기본 형태. 색·타일·위치 부족. |
| TEST 화장실5.jpg | 0개 | 주요 5종은 원후보에 있으나 설치·카메라·분할 근거에서 막힘. 거울장 여부는 원본에서도 불확실. |
| TEST 화장실6.jpg | 0개 | 상판 세면볼·변기·거울 누락. 잘못된 벽걸이 자동 보정은 v3에서 격리. 비거울 수납장/유리 문을 여러 종류로 중복 관측한 문제는 남음. |
| TEST 화장실7.jpg | 기둥 세면대·변기·창 3개 | 중앙 뒤쪽으로 몰려 세면대가 변기를 많이 가림. 오른쪽 벽 설치·앞뒤 관계·열린 변기·거울 수납장 재현 부족. |
| TEST 화장실8.jpg | 0개 | 주요 5종은 원후보에 있지만 설치·카메라·픽셀 충돌로 보류. 유리·아치 거울도 실제로 나타나지 않음. |
| TEST 화장실9.jpg | 0개 | 욕조를 찾았지만 잘못 붙은 basinStyle 때문에 검증 보류. 세면대·변기·거울도 설치/기하에서 막힘. |

새 6장 모두 충분한 원본 재현 기준에는 미달이다. 없는 유리·거울을 투명도/반사 처리 성공으로 계산하지 않는다. 화면상 가림을 검증 없이 실제 3D 충돌로 단정하지 않는다. 비거울 벽수납장·건축 상판 등 미지원 구조도 별도 한계다. 자동 생성된 가격·견적 수량은 추가하지 않았다.

## 실제 실행·캐시·보존

- 모델은 기존 Ollama `qwen3-vl:4b-instruct-q4_K_M`, digest `ee4b975b58c17ce268cd19d40db35d5edc64603035d2ffc1fee1968eb0947f7b`, MoGe `Ruicheng/moge-2-vits-normal@26b477f41595707c5db6770294c0d1721e8ed4ed`, DeepLab ADE20K WASM 그대로다. 새 모델·패키지·환경 설치 없음.
- 형태 실험의 새 Qwen 27회와 추론 전에 끝난 요청 검증 실패 9건을 분리 보존했다. 원문 재생은 새 추론으로 세지 않는다.
- 첫 형태 v2 9장 실행은 PC 4장 성공 뒤 원격 5장이 다른 분석 잠금으로 추론 전에 거절됐다. 같은 시간 다른 Ollama 요청은 확인했지만 호출 주체는 확정하지 못했다. 그 5장만 단독 재시험했고 최초 실패·조립기 오류 기록도 보존했다.
- 추가 6장 첫 실행은 Qwen 18개와 **새 MoGe CUDA 추론 6개**를 수행했다. 이후 추가 6번 오보정을 발견해 규칙 v3을 만들었다.
- **최종 v3은 15장 한 세션**에서 새 Qwen 41개(목록 15·형태 12·설치 14)와 검증된 MoGe 전체 결과 캐시 15개를 사용했다. 실제 요청 56개, 실행 오류·사진 외부 POST 0개다. 같은 프롬프트를 실제로 다시 실행했으며 저장된 형태 응답을 새 추론으로 가장하지 않았다.
- 최종 15개 candidate 진단은 새로고침 뒤 모두 다운로드 검증했다. 기존 보관 한도 20개에 따라 candidate 15 + baseline 5가 남고, 전체 30개 실행은 별도 전체 보고서에 있다. 저장 한도를 늘리거나 전체 보존으로 오기하지 않았다.
- 최종 15장 픽셀과 첫 v2 픽셀은 모두 동일하다. 새 원문에서도 추가 6번 item02가 item03 경쟁 지지 후보 때문에 `identity-competing-support`로 격리되고 후속 배치 입력에서도 원값을 유지했다. 상판형 정확 복원 성공으로 세지 않는다.

시작 소스 해시: `9167a4add7fe12c56603a2aea5745d1c99f7b96cc67c0e13d9c15872746c939b`.
최종 111개 분석 소스 해시: `e1fda4c68227a96324b8a76523cacdb451c26cb756b0dcc6d9a12f577fdced08`.
현재 quality revision은 `local-quality-v1-identity-geometry-4`, candidate revision은 `structured-scene-v15-fixture-identity-3`이다.

## 시간·메모리·실행 조건

Windows 11 Home 10.0.26200, Ryzen 7 7800X3D, RAM 약 31.1GiB, RTX 4070 Ti 12GB/드라이버 591.86, Chrome 152.0.7977.83. 출력은 headless ANGLE SwiftShader이므로 실제 GPU 편집 FPS 측정이 아니다. Qwen/MoGe 모델은 기존 로컬 환경을 사용했다. 최종 Qwen 실행 중 다른 모델 추론을 병행하지 않았다. 단위 테스트는 앞선 브라우저 기본 분석 구간에만 겹쳤다.

최종 15장 후보 전체 시간은 **36.035~94.683초/장**, 렌더 **1.929~6.377초/장**이다. 15장 목록·진단을 함께 유지하는 배치 조건이며 첫 6장 단독 실행과 동등한 성능 조건이 아니다. 메인 페이지 JS heap peak는 **282.409~471.265MiB**다.

최종 MoGe는 검증된 전체 결과 캐시를 사용해 새 추론 0개이며 현재 Python RSS/CUDA peak는 측정되지 않았다. 이전 캐시 메모리를 현재 값으로 쓰지 않았다. 별도의 첫 추가 6장 새 MoGe 추론은 0.91~1.62초, Python RSS 1588~1595MiB, CUDA allocated 1143~1159MiB·reserved 1432~1450MiB였다. 이 두 실행을 섞지 않는다.

Ollama RAM/VRAM·분석 Worker/WASM 전체·시스템 총량은 미측정이다. Python RSS·CUDA allocated/reserved·JS heap을 더하지 않는다. 새 모델 다운로드 0건이며 별도 다운로드 시간은 측정하지 않아 null이다. load/prompt/generate/request/geometry/render 등 포함 관계인 시간을 합산하지 않는다. 최종 상세는 `final-v3-metrics/metrics.json`·`metrics.md`, 최초 실행은 `metrics.json`·`metrics.md`다.

## 변경 코드와 기존 동작 유지

- `identity-observation.ts`: 고정 후보 형태 계약·원문 파싱·모순/경쟁 지지/사용자값 보호.
- `local-engine-client.ts`, `local-engine-server.ts`: 기존 단일 실행 잠금·시간 제한·취소·모델 해제 경로에 identity 연결.
- `quality-core.ts`, `quality-contract.ts`: 단계 연결·원문 재검증·digest/사진/prompt/rule/geometry revision 일치 확인·늦은 응답 차단.
- `lab-engine.ts`, `lab.ts`, `lab-diagnostics.ts`, `lab-candidate-trace.ts`: revision·시간·출처·후보별 제안과 실제 보류 원인 기록.
- `depth-room-hypothesis-agreement.ts`: 운영에서 쓰지 않는 제한된 가설 진단 실험.
- 관련 identity/core/client/server/integration/trace/cache 테스트와 `e2e/reconstruction-local-quality.spec.ts` 수정. 전체 파일 해시 차이는 `runtime-changes-v3.json`.

과거 저장 관측은 읽기 호환을 유지하되 현재 계약 재사용으로 위장하지 않는다. 재사용 실패 시 이전 기록을 유지하고 자동으로 다른 엔진을 실행하지 않는다. 사진 → 재구성 Before·같은 치수의 빈 After, 사진 없이 → 양쪽 빈 공간, 공통 표시 카메라·After 시안·자재 내역·undo/redo·저장·출력을 유지했다. 복잡한 레이어/마스크 UI나 기본 벽·바닥 삭제를 추가하지 않았다. 거울에 원사진 반사 풍경을 붙이지 않았다.

## 검증 기록

- 최종 전체 단위: **139개 파일, 1,715개 통과**, 35.18초. 최초 누락된 identity mock export 때문에 1개 suite가 실패했던 로그도 보존했고 수정 후 전체가 통과했다.
- 관련 브라우저 회귀: **18개 통과·3개 명시적 opt-in 제외**, 3.9분. 보호 규칙 v3 전 검사이며 관련 UI 코드는 이후 바뀌지 않았다. 제외를 통과로 세지 않는다.
- **최종 v3 일반 화면 실제 AI 2개 통과**, 2.9분. 생성·저장·새로고침·Before 수정/undo/redo·재분석·빈 After/targetFrame 보존·선택 도구 없는 비교 PNG·활성 Qwen 취소를 확인했다.
- WebGL/QuotaExceeded 실패를 주입한 브라우저 경계 2개 통과. 원본·이전 저장본·현재 폼 보존, 안내, 재시도, 새로고침을 검증했다. 실제 디스크를 채우지 않았다. 원인 미확정 404 console 메시지 1개는 기록에 남았고 복구 검증은 통과했다.
- 실제 취소는 진행 중 앱 POST와 Ollama 모델 상주를 확인한 뒤 실행했다. 요청 종료·모델 해제·후속 추론 미호출·프로젝트 미생성을 확인했다. 서버 내부 POST 직접 추적이나 OS/GPU 전체 자원 최고치 측정은 아니다.
- 최종 lint·타입 검사·Next.js 16.3.4·vinext 빌드 모두 통과했다. vinext의 기존 punycode/glob 및 향후 native config loader 확장자 경고는 남았다. 실제 배포는 하지 않았다.

증거: `vitest-v3-final.log`, `browser-regression.log`, `normal-flow-v3.log`, `normal-flow-v3/`의 integration/cancellation evidence·PNG·진단 archive, `failure-evidence/report.json`. 정상 화면에서 사용자가 확인/수정한 설비는 자동 품질 평가 15장에 넣지 않았다.

## 사용법·다음 결정

일반 생성 창의 **로컬 정밀 분석**, 기존 Before의 **사진 다시 분석**, Lab의 **개선 후보 전체 실행**에서 같은 엔진을 사용한다. 형태 제안·경쟁 후보·첫 보류 이유는 설비 확인 목록과 **진단 로그 JSON**에서 확인한다. 다음 회귀 검사에도 기존 9장과 새 6장을 모두 사용한다.

Qwen3-VL 8B 양자화 비교안과 동일 조건 입력은 `model-proposal/proposal.md`에 준비했지만 **사용자 승인 전이라 다운로드·로드·추론하지 않았다**. 제안은 기존 개발 PC의 Ollama에서 약 6.1GB 모델을 비교하는 것이며 방문자 브라우저에 추가 다운로드하거나 서비스 기본 모델을 변경하는 작업이 아니다. 라이선스·실행 조건·메모리 미검증·중단 기준은 해당 문서의 공식 자료와 함께 기록했다.

더 큰 모델이 종류 관측을 개선해도 평면 모호성·설치 기준점·분할 충돌·미지원 상판 구조까지 자동으로 해결하지 않는다. 채택 판단에는 전체 15장의 실제 배치·렌더 개선이 필요하다. 이번 Python/CUDA 로컬 분석은 개발 환경 전용이며 Cloudflare Workers/production 미지원이다. 실제 연결·배포·유료 API·사진 외부 전송은 실행하지 않았다. TripoSR와 제품 배경 제거 모델은 변경하지 않았다.

최종 빌드 산출물 7,087개(Next)·195개(vinext), Next trace 24개를 검사해 개인 사진 해시·실험 경로·모델 가중치 파일이 없음을 확인했다. 전체 비밀정보 감사가 아니라 해당 파일/경로·해시 검사의 범위다. 근거는 `build-artifact-audit-v3.json`, 검증 종합은 `verification-summary-v3.json`이다. 최종 빌드 이후 분석 소스 해시도 실제 15장 추론 스냅샷과 일치했다. `next-build-v3-final.log`, `vinext-build-v3-final.log`, `typecheck-v3-final.log`, `lint-v3-final.log`에 실행 결과를 보존했다.
