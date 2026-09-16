# 2026-09-16 Cloudflare + 브라우저 재구성 v9 실제 검증

목표는 미완료다. 동결 v9 소스로 15장 모두 실제 분석·Before 저장까지 완료했지만 고정 핵심 기준 통과는4장, 주요 품질 실패10장, 설비 기준만 통과하고 구조가 미해결인 사진1장이다. 수동 보정 복사본을 실제로 완성한 검증은0건이다. API 성공이나 낮은 solver 점수를 품질 통과로 바꾸지 않았다.

## 실제 실행과 출처

- 결과: `test-results/reconstruction-fifteen-rebuild/2026-09-16T02-41-56-428Z-cloud-gemma/full15-ui-v9-01`
- source SHA: `503d766030b69d6c68d786dca15597eadb84390ea4b17f55ce03c7da6e1d0130`,298파일, 실제 실행 전후 동일.
- 2026-09-16 06:40:15–06:55:10 UTC, 약14분55초.15장 전부 완료, 실행 실패/빈 결과0.
- 전체배치 HTTP POST100, 알려진 binding 호출100, 단계 캐시0. 알려진 입력151,287/출력18,393토큰. 계정 청구량·무료 잔여량의 측정이 아니다.
- usage 원본의 unknownCallCountStages/unknownTokenStages는 각각3으로 보존했다. remote01/03/05 identity가 `no-eligible-candidates`로 건너뛰어 호출 측정이 null인 집계 표기이며, 실제 요청100개에는 이 identity 호출이 없다. 추가 미지의 유료 호출로 계산하지 않았다.
- 별도 정상 UI 검증은 추가 POST7/binding7이다. 위100회에 합치지 않았다. 이후 회전·다운로드 재검증은 AI0회.
- JSON 버튼 다운로드는 전체배치에서 skip/미검증. 실제 화면의 `report-dom.json`, 원 provider 원문, 요청 사진·보드, exact Before PNG, source/입력 SHA를 보존했다. DOM JSON을 성공한 다운로드 파일로 바꾸지 않았다.
- `analysisDiagnostics.baselineReview`와 전체 `pipeline`이15장 모두 저장돼 원관측·선택/대안·가설·조립체·배치 경로를 추적할 수 있다.
- 원사진·과거 실행·사용자 프로필 보존. 새 모델/실행환경 설치, 과금 설정 변경, 유료 대체, 커밋·배포 없음.

## 고정 품질 판정

원본·v7·v9 실제 이미지를 직접 보고 기존 `fifteen-original-visual-rubric-v1`을 유지했다. 공통 방 카메라를 쓰므로 원사진 촬영 각도 일치를 강제하지 않았다. 유리 edge-on만으로 누락/잘못된 yaw를 판정하지 않았다.

| 사진 | 핵심 판정 | 개선과 남은 주요 문제 |
|---|---|---|
| pc01 | 실패 | unary54 유리 가설로 욕조 앞뒤 관계 복구. 랙 누락·거울장→평면 거울 오분류 지속. |
| pc02 | 실패 | 세면대 부속 수전과 별개인 벽 상단 샤워/수전 장치 누락. 둥근 볼이 사각형. |
| pc03 | 통과·보정 미검증 | 거울과 오른쪽 샤워 구획 복구, 사각 기둥 유지. 세부 샤워형·가림막 깊이 한계 별도. |
| pc04 | 통과·보정 미검증 | 창 복구. 이중 볼1조합·아치 거울·청록 도기 유지. 치수는 추정. |
| remote01 | 실패 | 선반2개 복구. 긴 샤워 조합을 작은 hand-spray 기본형으로 축약. 회전 시 유리 면 존재 확인. |
| remote02 | 실패 | 세면대/거울/창 설치 벽 오류. 오버헤드 부품을 일반 전체 샤워로 생성, 볼 윤곽 불일치. |
| remote03 | 통과·보정 미검증 | 변기1개 유지, 허위 세면대/욕조/샤워 없음. 형상 세부와 치수 정확도는 주장하지 않음. |
| remote04 | 실패 | 샤워 복구. 유리를 추가 거울로 바꾸고 낮은 불투명 구획은 누락. |
| remote05 | 설비 통과·구조 미해결 | 공사 배관을 설치된 샤워로 만들지 않음. 실제 벽 단차/요철 자동복원은 미해결로 완전통과에 미포함. |
| additional04 | 통과·보정 미검증 | 둥근 볼·원형 기둥·좌우 관계 유지. 열린 시트와 연결 호스 한계. |
| additional05 | 실패·악화 | v7 샤워가 appearance에서 유리로 변해 유리2개/샤워0개. 긴 뒤벽 턱도 누락. |
| additional06 | 실패·일부개선 | 중복 볼/상판을1조합으로 합치고 타원 거울 복구. 개방 상판을 닫힌 하부장으로 만들고 벽 수납장 설치벽 오류. |
| additional07 | 실패·일부개선 | 실제 거울장 대표 복구. 실제 창은 appearance에서 또 다른 거울장으로 변경, 변기 벽/방향 오류. |
| additional08 | 실패 | 아치 거울·볼·샤워 유지. 유리와 긴 턱 누락, 변기 방향 오류, 작은 선반 삭제. |
| additional09 | 실패 | 주요5종 유지. 긴 턱 누락, 넓은 거울을 좁은 세로형, 둥근 볼을 사각형으로 표현. |

전체 비교판은 `full15-ui-v9-01/comparison-original-v7-v9-15.html`과15행3열 PNG다. JSON에 원본/양쪽 Before/report SHA와 두 독립 평가 보고서 SHA가 있다. 상세 원문·candidate ID·최초 실패 단계는 `quality-review-v9-pc-additional.json` 및 `quality-review-v9-remote.json`을 따른다.

개선 원인은 구분했다. pc01은 pair 평가 전 후보36개 제한을 제거한 선택 증거가 실제 unary54로 남았다. pc03/pc04처럼 원 모델 응답 자체가 달라진 경우 정책 변경 하나의 효과로 단정하지 않았다. 추가06의 조립체 중복 해소는 개방 지지형태를 맞췄다는 의미가 아니다.

## 검사와 정상 편집기

- v9 단위199파일/3,040개, lint, typecheck, Next 빌드, vinext 빌드 PASS. 해당 로그를 run root에 보존했다.
- `normal-ui-v9-01`: 실제 일반UI 공간 생성→Before/빈 After→저장/재진입→타일 등록/After편집→Before 재분석→After보존→undo/redo→재진입→선택 UI없는 PNG 검증까지 통과했다. 새 AI 응답이 있어 full15 inventory와 동일하다는 검사값은 false로 보존한다.
- 원 테스트의 최종 status는 failed 그대로다. 추가 회전 검사에서500ms autosave가 끝나기 전에 roomView를 읽어 undefined와 저장 quaternion을 비교한 테스트 race였다. 제품 저장실패로 바꾸지 않았다.
- 별도 재검증은 매 회전마다 실제 IndexedDB roomView가 화면 quaternion과 같아질 때까지 기다렸다. 네 방향 저장, 닫기/reload/재진입, comparison/designs 불변을 통과했다.
- OS Chrome152는 회전하지 않은 경우도 PNG 다운로드 때0xC0000005 접근위반으로 종료했다. 추가 GPU플래그를 제거해도 동일, pageerror0. 작은 일반 Blob은 성공했다. 세부 native 원인은 미확정이다.
- 기존 설치 Playwright headless shell153에서 같은 프로젝트 프로필 복사본의 PNG2회 다운로드(4096×1366), 보기Before/After와 독립적인 동일 비교PNG, UI미포함, 재진입을 모두 통과했다. 신규 설치·제품수정·추가AI0회. 원 테스트 프로필은 복사만 했다.
- 회전 재검증은 작업소스 변경과 분리해 제공 중인 frozen dist227파일 SHA `97f8a865a75fb168c87734ed43b25e99b0884e90d528810689648f106c32b9ab`를 전후 확인했다. 상세는 `download-ui-v9-diagnosis.md/json`.

## v10 준비와 재생 한계

기존 하네스는 `--channel chromium`일 때 channel 속성을 생략해 headless shell을 사용한다. 직접 Playwright에 `channel:'chromium'`을 주는 full Chromium 모드와 다르다. 별도 옵션 추가 없이 실행 가능하지만 shell의 MoGE WebGPU 실제 추론은 아직 미검증이다. 기존 Chrome의 실제 geometry 경로와 shell의 다운로드 성공을 동일한 검증으로 합치지 않는다.

새 소스는 별도 고정·검사·빌드 뒤 새 run 디렉터리를 사용한다. 변경된 source/config를 v9 `--resume`으로 이어 붙이지 않는다. 공유 프로필은 앱이 검증한 단계 캐시만 재사용하고 호출/캐시 실측을 다시 기록한다.

v9 baseline/full pipeline15장과 appearance66후보는 `v10-preparation/inputs`에 역사적 원문·원 영수증 그대로 준비했다. 오프라인 정책 재생은 현재 정책에 대한 반사실 비교이며 실제 v10 AI/UI 검증이 아니다. 구 영수증에 새 revision/signature를 붙이지 않는다. 분류 회복으로 새 샤워가 생기면 원 v9에 해당 설치 상태 관측이 없을 수 있으므로 새 full 분석이 필요하다. 미수집 설치상태를 기존 다른 후보/단계 원문으로 채우지 않는다.

실제 저사양/모바일 메모리, Gateway 대시보드의 청구/잔여량, 전체 구조 복원과 미해결 품질은 여전히 완료되지 않았다.
