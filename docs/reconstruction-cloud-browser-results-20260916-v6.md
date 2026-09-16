# Cloudflare Gemma + 브라우저 MoGe v6 검증 기록 (2026-09-16)

**v6 구현·코드 검증과 실제 15장 전체 회귀를 마쳤지만, 직접 시각 평가의 핵심 기준은 2장 통과·13장 실패다. 재구성 품질 목표는 미완료이며 v6 변경 묶음을 최종 채택하지 않았다.** v5의 15장 실행 완료, v6 대표 사진의 일부 복구, 고정 품질 기준 통과는 서로 구분한다.

이 문서는 같은 날 작성한 [이전 보고서](reconstruction-cloud-browser-results-20260916.md) 이후의 기록이다. 이전 보고서의 “실제 AI 호출 0 / 사진 외부 전송 0 / 미실행”은 당시 상태다. 현재 설정과 실행 방법은 [setup](reconstruction-cloud-browser-setup.md)을 따른다.

증거 루트: `test-results/reconstruction-fifteen-rebuild/2026-09-16T02-41-56-428Z-cloud-gemma/` (이하 runRoot). 원본·기존 채택 019·이전 결과와 작업 중 변경사항은 보존했다. 운영 배포, 커밋·푸시, 요금제 변경, 새 모델 도입은 하지 않았다.

## 변경 내용과 근거

- Gemma 입력의 `bbox_2d`는 공급자 계약에 맞게 `[ymin,xmin,ymax,xmax]` 0..1000으로 준비하고, 내부 좌표는 기존 canonical 형식을 유지한다. 준비된 provider prompt/schema 해시를 기록하고 대상 재확인 receipt도 실제 전송된 준비 입력의 해시를 사용한다. 해시는 providerResponseFormat과 함께 읽는다. inventory의 json_object 요청에는 response_format schema 본문이 없으므로 schema 진단 해시를 전송된 schema 바이트의 증명으로 해석하지 않는다. 응답 원문은 별도로 보존한다.
- 실제 관측한 정확한 `@cf/google/gemma-4-26b-a4b-it-external` 응답 별칭만 추가 허용한다. 임의 suffix나 다른 모델은 허용하지 않는다. 원래 응답 모델명·완료 상태·사용량은 검증 실패 때도 진단에 남긴다.
- v6의 inventory 단계는 `json_object`를 사용한다. 동일 사진·프롬프트·설정의 통제 비교에서 기존 strict schema보다 창문·유리·이중 볼 누락이 일부 줄었다. 서버의 JSON/관측 구조 검증은 유지한다. appearance 등 나머지 단계의 JSON schema와 혼동하지 않는다. 이 변경만으로 전체 사진의 검출 정확도가 확보됐다고 보지 않는다.
- appearance는 동일한 전체 사진과 ID crop board를 함께 보낸다. 후보 종류나 이전 정답을 이미지에 주입하지 않고, 기존 ID와 관측 상자로만 crop·padding·라벨을 만든다. 숫자 좌표만 native 형식으로 바꾼 실험은 충분한 개선이 없어 채택하지 않았다.
- `cloud-fixture-crops.ts`는 브라우저 canvas로 보드를 만들고, 원사진/보드 바이트 SHA·크기·후보 ID 순서·영역·레이아웃 receipt를 생성한다. 서버와 클라이언트는 실제 입력과 receipt를 검증한다. 이는 바이트와 메타데이터 일치 검증이며 서버가 보드 픽셀을 다시 생성해 출처를 증명하는 계약은 아니다. 최대 24개, 보드 최대 1536px, 이미지별 8MiB와 기존 전체 요청 경계를 유지한다. 취소·실패 때 bitmap/canvas를 정리한다. Worker에 sharp/Node 이미지 처리 실행 코드를 넣지 않았다.
- Cloudflare appearance에 `pedestalShape`를 독립 관측으로 추가했다. 볼 외곽과 기둥 단면을 분리하고, 관측 근거가 있을 때만 모형 옵션과 model provenance로 전달한다. 기존 로컬 Qwen 계약을 이 필드로 강제 변경하지 않았다.
- v6 실행의 provider contract는 `sjn-gemma-v6`이다. 완료 단계 캐시는 provider 계약과 FormData의 원사진·보드·receipt를 포함해 구분한다. 오류 진단에서는 유용한 메시지를 유지하면서 Bearer/Basic, Cookie, X-auth-key와 이미지 데이터를 정리한다.
- 사용자가 승인한 의도적 로컬 저장 설정은 공개 HTTPS 같은 출처에서도 익명 AI를 허용한다. 잘못된 설정의 fallback은 허용 근거로 쓰지 않으며, D1 세션/사용자 ID 검증과 인증 실패 차단은 유지한다. 원격 익명 캐시는 origin 해시, 계정 캐시는 actor 해시, 개발 loopback은 `local-dev`로 분리한다. DB 접근 범위를 넓히지 않았다.

정확한 board 레이아웃·receipt·취소 규약은 [crop 프로토콜](../test-results/reconstruction-fifteen-rebuild/2026-09-16T02-41-56-428Z-cloud-gemma/cloud-fixture-crops-protocol-v1.md)에 기록했다. v6 대표 실행에는 v5 room-view와 다른 legacyfront 프레이밍이 사용됐으므로 화면 구도 차이를 인식 개선 점수로 계산하지 않는다.

## 코드·빌드·모의 UI 검증

| 검증 | 결과 | runRoot 증거 |
|---|---|---|
| 전체 단위 테스트 | 190파일, 2,835개 통과 | `unit-v6-01.log` |
| 전체 ESLint | 통과 | `lint-v6-01.log` |
| `npm run typecheck` | typegen + tsc 통과 | `typecheck-v6-01.log` |
| Next 빌드 | 통과 | `next-build-v6-01.log` |
| vinext 배포 산출물 빌드 | 통과 | `vinext-build-v6-01.log` |
| crop board 관련 단위 회귀 | 4파일, 124개 통과 | `crop-board-focused-02.log` |
| Cloud UI 모의 회귀 | 12개 통과, 실제 AI/모델 다운로드 0 | `mock-cloud-ui-v6-all.log` |

Next와 vinext의 빌드/typegen은 공유 타입 산출물 때문에 순차 실행했다. 빌드 성공은 운영 배포나 실제 공급자 품질 보증이 아니다.

UI 모의 12개는 기존 10개와 새 receipt 경계 2개다. 모의 서버가 실제 브라우저에서 생성된 FormData의 사진·보드·receipt를 읽어 검증 후 echo한다. 응답의 board SHA만 변조한 경우 결과 적용과 후속 layout 호출이 차단되는 것도 확인했다. 기존 생성·재분석·Before 이력·After 보존·저장/재진입·취소·한도 표시·JSON/PNG 다운로드·모바일 화면을 검증했다. HTTP/모델 Worker는 모의이며 이 결과를 설비 인식 품질로 집계하지 않는다. [모의 회귀 범위](../test-results/reconstruction-fifteen-rebuild/2026-09-16T02-41-56-428Z-cloud-gemma/mock-board-ui-v6-summary.md)

## 실제 사진 검증

### v5 전체 15장: 실행 완료, 품질 통과 아님

`full15-ui-01/state.json`에 15장의 실제 UI 결과가 보존됐다. 실제 Before PNG, API 요청·응답, 화면에 표시된 JSON을 근거로 PC·remote·additional 그룹을 직접 비교했다. `complete-pending-visual-review`는 실행과 증거 수집 상태이며 품질 승인 표시가 아니다.

원본 대비 누락·오분류가 확인됐다. 대표적으로 pc-04의 창문/이중 볼, remote-01의 변기·샤워 오분류, remote-04의 실제 샤워를 반사로 처리한 누락, additional-07의 변기/기둥 세면대 혼동이 있었다. pc-03의 둥근 기본 기둥도 사각 지지 형태 기준과 달랐다. 상세는 `full15-ui-01/quality-review-{pc,remote,additional}.md`에 보존했다.

완료 report의 집계는 알려진 바인딩 호출 75회, 캐시 5단계, 입력 73,518/출력 11,892토큰이다. 호출·토큰 수가 미확인으로 표시된 stage는 각각 3개다. 이것은 해당 실행 report의 관측 집계이며 청구 완료 횟수나 계정 총사용량이 아니다. pc-01은 기존 완료 단계 캐시를 사용했으므로 15장을 모두 새로 원격 추론했다고 쓰지 않는다.

### 통제한 appearance 입력 실험

같은 모델·Gateway·사진 바이트·후보 ID·출력 schema·temperature 0·thinking off를 유지했다. baseline은 저장 응답을 재사용했고, prior kind나 정답은 추가하지 않았다.

| 사례 | 숫자 좌표만 native로 변경 | 전체 사진 + ID crop board |
|---|---|---|
| remote-01 | 변기/샤워 미복구, 기존 유리를 변기로 오분류 | 변기·샤워·유리 모두 해당 종류와 physical로 관측 |
| remote-04 | shower로 종류는 복구되지만 reflected 유지 | shower/reflected 유지, 최종 누락 문제 미해결 |
| additional-07 | 해당 arm 미실행 | 기둥 세면대·변기 혼동 해소, 거울장 종류 유지 |

실제 호출은 native 2회 + crop board 3회 = 5회, 모두 HTTP/upstream 200와 Gateway cache MISS였다. 입력 6,721/출력 915토큰, 자동 재시도 0회다. 한 사례·arm당 1응답으로 안정성이나 전체 코퍼스 품질을 보증하지 않는다. [통제 비교 보고서](../test-results/reconstruction-fifteen-rebuild/2026-09-16T02-41-56-428Z-cloud-gemma/appearance-grounding-probe-report-20260916T1310.md)

### v6 대표 3장: 일부 복구 확인, 핵심 누락 잔존

`v6-narrow-01`의 pc-03, remote-01, additional-07은 실제 전체 분석과 Before 생성까지 마쳤다. 알려진 바인딩 호출 19회, 캐시 0단계, 입력 21,817/출력 2,853토큰이다. report의 호출/토큰 미확인 stage는 remote-01 identity 항목 각 1개이며 별도로 유지한다. 세 실행의 UI report 전체 시간은 약 20.47~43.95초다. 공급자 추론 시간이나 저사양 예상 시간으로 해석하지 않는다.

| 사진 | 확인한 복구·전달 | 남은 문제 |
|---|---|---|
| pc-03 | 사각 기둥 독립 관측 → model option/provenance → 실제 사각 기둥 PNG 전달. 변기·세면대·샤워·유리 유지 | 사진 상부에 잘린 실제 거울이 inventory/최종에 없음. 낮은 경계턱·관계도 별도 평가 대상. 전체 고정 기준 미통과 |
| remote-01 | v5에서 잃었던 변기·샤워를 복구하고 유리 유지, 후속 샤워/가림막 단계도 실행 | 종류 복구를 전체 배치·색·비율 통과로 확대하지 않음 |
| additional-07 | 실제 창문·변기·기둥 세면대 복구, 허위 하부장/두 번째 세면대 제거 | 실제 거울장이 appearance에서 mirror/reflected로 바뀌어 최종 누락. 전후 관계/방향과 열린 변기 표현도 별도 평가 |

additional-07 대상 재확인 원문은 직접 보이는 전체 거울장 관측을 반환했지만, v6 reflection 적용 조건과 응답 context가 달라 held로 남았다. reflection 여부와 mirror/mirrorCabinet subtype 복구도 별개다. 이 조건은 아래 reflection v2에서 수정·단위 검증했으나 수정 후 실제 사진 복구는 아직 확인하지 않았다. [대표 사진 읽기 평가](../test-results/reconstruction-fifteen-rebuild/2026-09-16T02-41-56-428Z-cloud-gemma/v6-narrow-01/quality-review-pc03-additional07.md)

### v6 전체 15장: 실행 완료, 품질 미달

`full15-ui-v6-01`은 같은 v6 소스·설정에서 15장 모두 실제 분석→장면→PNG 생성을 마쳤다. 관측 HTTP POST/알려진 바인딩 호출 66회, 캐시 재사용 18단계, 호출 횟수 미확인 POST 0개다. 캐시 재사용을 새로운 추론으로 세지 않았다. `execution-summary.json`에 사진별 실행 수와 시간을 보존했다.

원본·v5·v6 실제 이미지를 모두 직접 확인했고, 고정된 핵심 품질 기준에서 **remote-03과 additional-04만 통과, 나머지 13장은 주요 설비 누락 또는 종류·설치 오류로 실패**했다. 이는 사용자의 미적 승인이 아니며, 회귀용으로 반복 확인한 15장의 판정이다.

개선: pc-03 사각 기둥, pc-04 이중 볼, remote-01 변기·샤워, remote-02 실제 창, additional-05/08 샤워, additional-07 변기·기둥 세면대·실제 창. 악화: pc-01 욕조, pc-03 거울, remote-02 유리, additional-05 유리, additional-09 거울의 누락 및 additional-06 열린 상판을 닫힌 하부장으로 바꾼 오류. remote-05의 미설치 배관→샤워 오인식은 그대로다.

근거는 `quality-review-v6-pc-additional.json/.md`, `quality-review-v6-remote.json/.md`의 후보 ID·원문·PNG 해시와 연결했다. 단순 후보 수 증가나 다른 카메라 프레이밍을 품질 개선으로 계산하지 않았다.

### 후속 통제 실험과 v7 후보: 실제 전체 회귀 대기

같은 승인된 Gemma에서 thinking 설정과 grouped inventory를 각각 별도로 비교했다. 잘된 일부 실험 결과를 v6 전체 실행에 섞지 않는다.

- **Thinking은 채택하지 않았다.** 동결한 v6 입력·프롬프트에서 thinking을 켜고 출력 상한을 4,096→8,192로 함께 바꾼 실제 호출 2회만 수행했다. remote-05 inventory의 허위 shower는 1개→3개로 악화됐고, additional-06 appearance의 잘못된 세면대/하부장 분류는 unknown/held로 바뀌었으나 실제 열린 상판 조합은 복구하지 못했다. 둘 다 HTTP 200/완료 stop, Gateway MISS였으며 새 downstream PNG는 만들지 않았다. 두 설정을 함께 바꾼 비교이므로 thinking 단독 효과로 일반화하지 않는다. 제품은 thinking off를 유지한다. [두 호출 요약](../test-results/reconstruction-fifteen-rebuild/2026-09-16T02-41-56-428Z-cloud-gemma/thinking-probe-01/summary.md)
- **Grouped inventory는 v7 회귀 후보다.** pc-03·remote-01·remote-04·remote-05 각 1회, 총 4회가 HTTP 200/완료 stop 및 엄격한 파싱을 통과했다. 입력 10,090/출력 906토큰이다. 거울·창·선반·샤워 관측이 일부 늘었지만 부품 중복 가능성·유리/구획 누락·remote-05 허위 샤워는 남았다. 전체 사진의 품질 통과 근거가 아니다. 원문은 5그룹 그대로 보존하고 명시한 계약을 검사한 뒤 고정 순서로 펼쳐 native 좌표를 한 번 변환한다. 실험과 제품의 provider prompt 전문·schema 해시는 일치한다. [실험·연결 검토](../test-results/reconstruction-fifteen-rebuild/2026-09-16T02-41-56-428Z-cloud-gemma/inventory-grouped-probe-01/quality-review.md)
- **Reflection v2는 구현·단위 검증 후 실제 복구 대기다.** 기존 거울 충돌 후보에서 whole-object와 직접 보이는 surface/object를 모두 받되 reflectivePanel=present를 요구한다. sameObjectAs/partOf가 있으면 보류하고, mirrorCabinet 복구에는 몸체/문 구조 증거가 필요하다. 종류 변경 출처는 model이며 원관측·사용자 값은 보존한다. 거울장→일반 거울 강등이나 샤워 자격 확대는 하지 않는다. 구버전 기록은 저장·열기 가능하고 새 규칙으로 분석 재사용만 차단한다. 관련 6파일 207개 단위 검사와 ESLint를 통과했다. [변경·검증 범위](../test-results/reconstruction-fifteen-rebuild/2026-09-16T02-41-56-428Z-cloud-gemma/reflection-v2-summary.md)

v7 첫 전체 단위 실행은 192파일 중 191파일 통과·1파일 실패, 2,880개 중 2,879개 통과·1개 실패와 unhandled error 1개였다. 원인은 transport 제품 오류가 아닌 테스트 구독 동기화 경합으로 확인했고 테스트만 수정했다. 전체 재실행은 192파일 2,881개 모두 통과했다(`unit-v7-02.log`). 별도 전체 lint·typecheck·Next·vinext 순차 빌드도 통과했다. 새 grouped 계약을 반영한 v7 모의 UI 12개는 50.0초에 모두 통과했고(`mock-cloud-ui-v7-all.log`), 실제 AI/모델 다운로드 0회이며 소유 Next3000 종료를 확인했다. 실제 v7 전체 15장 회귀는 진행 중이고 최종 시각 품질 및 일반 생성/재분석 실흐름은 아직 미판정이다. 초기 실패 기록과 재실행 결과를 모두 보존한다.

## 권한·개인정보·미확인 범위

- 사용자가 Workers Free와 `sjn-gateway`의 Workers AI Billing = Standard billing을 확인했고, 기존 Wrangler 인증으로 승인된 사진 검증을 수행했다. 새 유료 모델 대체·요금제 변경은 없다. 정확한 실시간 잔여량이나 청구 총액은 확인하지 않았다. 한도/인증 오류는 무한 재시도하지 않는다.
- 설비 분석용 원사진과 그 후보 crop board는 기존 Cloudflare Workers AI/Gateway로 전송된다. MoGe·DeepLab 계산은 사용자 기기에서 수행하며, 모델 다운로드 서버로 사진을 보내지 않는다. 원본·파생 이미지·모델 원응답은 로컬 runRoot에 보존하고 문서에는 사진을 임베드하거나 계정 토큰·개별 인증 정보를 복사하지 않았다. 이 문서는 관측 수와 사용량 집계만 제시한다.
- **Gateway 상세/로그 대조는 미확인이다.** 상세 API 접근 403과 사용자 요금제 확인은 다른 사실이다. 응답에서 Gateway request ID와 cache MISS를 보았다는 이유로 Dashboard 로그 열람·과금 확인을 완료했다고 하지 않는다.
- **실제 전체 앱 JSON 다운로드 1회는 통과했지만 이전 충돌의 원인은 미해결이다.** Chrome 152 전체 실행에서 다운로드 때 access violation 종료가 있었다. 동일 197,629-byte JSON의 격리 페이지 검사는 Chrome/Chromium headless에서 8회 바이트 일치로 성공했지만 전체 앱 문제를 재현하지 못했다. 일반 Chromium 3회는 시작 전에 실패했다. 이후 짧은 별도 profile에서 v6 additional-09 전체 앱 결과를 실제 다운로드했고 DOM JSON/다운로드 SHA 일치와 브라우저 생존을 확인했다. 이 1회는 Cloud AI와 geometry 완료 캐시를 모두 사용했으며 새 AI 호출 0회였다. 새 GPU 처리 직후 경로의 회귀나 기존 충돌 원인 해결을 증명하지 않는다. [전체 앱 1회 다운로드 증거](../test-results/json-dl-v6-01/evidence.json). v5/v6 실제 15장 배치는 JSON 다운로드를 명시적으로 건너뛰고 `report-dom.json`을 저장했으므로 별도 1회 성공으로 과거 전체 배치의 다운로드 상태를 바꾸지 않는다. 모의 UI 다운로드 성공도 이 제한을 대체하지 않는다. [격리 다운로드 진단](../test-results/reconstruction-fifteen-rebuild/2026-09-16T02-41-56-428Z-cloud-gemma/download-isolated-repro-20260916T1242/diagnosis.md)
- **저사양 PC·실제 모바일·Safari/Firefox 성능은 미측정이다.** 현재 개발 PC는 Ryzen 7800X3D, RTX 4070 Ti, RAM 약32GB다. 브라우저 peak RAM/VRAM도 측정하지 않았다. 모델 추정 치수를 실측 정확도로 표시하지 않는다.

전체 목표는 계속 진행 중이다. 다음 갱신은 후속 공통 수정의 대표 사진 검증·15장 회귀와 실제 서비스 흐름 재검증을 근거로 한다.