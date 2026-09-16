# 15장 재구성: 실제 모형 투영 실험과 배치 검색 조사

전체 품질 기준은 아직 충족하지 못했다. 이번 문서는 새 완성본 인계가 아니라, 기존 채택 결과를 보존한 상태에서 수행한 비교 실험 기록이다. 생산 코드의 마지막 채택은 `012-curtain-divider-support`이며 이후 실험을 섞어 현재 제품 결과로 표시하지 않는다.

## 실제로 확인한 결과

`actual-hull-four-condition-fifteen-2026-09-15T07-18-05.992Z`에서 15장에 네 조건을 적용해 60개 장면을 만들었다. 실행은 2026-09-15 07:48:49.509–07:51:07.322 UTC, 총 137.813초다.

1. 기존 크기 상자의 투영과 현재 카메라 후보.
2. 실제 표준 모형의 외곽 투영과 현재 카메라 후보.
3. 기존 크기 상자의 투영과 거리 정보로 추가한 카메라 후보.
4. 실제 모형 외곽 투영과 추가 카메라 후보.

기존 관측을 재생한 실험으로 새 AI 추론은 0회다. 실제 형상은 기존 렌더러의 표준 모형을 사용했다. 이미지 생성 도구나 수동 정답 배치는 사용하지 않았다. 방 크기는 사용자가 허용한 추정값이며 실측이 아니다.

통제군의 PNG 45개는 현재 채택 결과와 정확히 같고, 세 번째 조건의 PNG 45개는 직전 카메라 실험과 같다. 60개 After는 모두 빈 공간이다. 원본과 보호한 소스의 해시도 유지됐다.

독립 검토자는 원본과 네 조건의 15장 전체를 보고 네 사례를 확대했다. root는 원본과 두 번째 조건을 나란히 놓은 15쌍을 직접 확인하고, 같은 이미지를 채팅에 실제 이미지로 표시했다. 휴대폰에서 사용자가 확인했다는 응답은 아직 없다. 비교표의 실제 열 순서는 원본 / 기존 / 모형 외곽 / 거리 카메라 / 두 변경 결합이다.

변기 등 일부 전경 설비의 크기는 개선되는 방향이다. 그러나 세면대 형태·상판 방향, 낮은 벽과 홈 누락, 중복 설비가 남아 있어 전체 사진이 사용 가능한 수준은 아니다. 이미지가 잘렸다는 이유만으로 악화라고 판단하지 않았다. remote04 세면대와 additional05 변기는 원본에서도 잘려 있다.

새 조건의 object-ID 픽셀 마스크 정량 검사는 하지 않았다. 캐시 숫자 배열의 최대 크기 1,899,120바이트를 RAM·VRAM 최고 사용량으로 환산하지 않는다. 모형 캐시 생성 총 442회는 AI 모델 실행 횟수가 아니다. 캐시 해제와 near-plane 대체 처리 횟수 0은 실행 로그에서 확인했다.

## 확인한 공통 원인과 남은 조사

기존 점수는 모형을 감싸는 빈 상자의 모서리 8개를 사진 영역에 맞췄다. 직전 실험에서 이 점수는 좋아져도 실제 변기 실루엣이 작아질 수 있음을 실제 렌더 픽셀과 비교해 확인했다. 이번 실험은 이미지 점수만 실제 모형 외곽으로 바꾸고, 물리 범위·충돌·관계 점수·카메라 후보·세면볼 및 샤워 부분 관측 경로는 보존했다. 사진 영역이 항상 완제품 전체를 뜻한다는 보장은 별도 한계로 남는다.

remote01에서 새 계획을 원래 점수로 다시 계산했더니 3.635443으로, 기존 검색이 같은 카메라에서 선택한 7.667947보다 낮았다. 12개 카메라 점수 재생은 원보고서와 1e-9 이내로 일치했다. 창의 변화 대부분은 직접적인 외곽 개선보다 카메라·설치 높이 선택의 연쇄였다.

후속 추적에서는 새 승자 계획의 모든 설비가 원래 후보에 있었고, 설비별 상위 36개에도 포함됐음을 확인했다. 변기는 10위였는데 첫 단계에서 조합을 8개만 유지하면서 탈락했다. 8위와 점수 차이는 약 0.01635였으며 이후 유리와의 관계를 평가하기 전이었다. 현재는 조합 유지 개수만 공통으로 늘리는 통제 실험을 준비하고 있다. 점수가 낮은 해를 찾는 것과 사진에 맞는 배치를 찾는 것은 구분한다.

## 보존과 검증 상태

- 새 모델·새 환경·외부 사진 전송·배포 없음. 기존 8B 제안은 여전히 승인되지 않았다.
- 생산 코드는 이전 전체 검사 이후 변경하지 않았다. 당시 단위 2284개, lint·타입 검사·Next.js·vinext 빌드가 통과했다. 이 숫자를 이번 실험의 새 전체 검사라고 표시하지 않는다.
- 별도 `016-storage-architecture-hold`는 pc02의 잘못된 불투명 벽장 하나를 보류하는 제한된 개선이었다. 이번 네 조건에 합치지 않았고 아직 생산에 채택하지 않았다.
- 원본, 이전 실험, 실패 기록과 현재 상태 파일 갱신 전 사본을 보존했다. 최종 품질 완료가 아니므로 일반 사용자 생성 경로에 새 실험을 기본 적용하지 않았다.

## 로컬 기록

기준 디렉터리는 `test-results/reconstruction-fifteen-rebuild/20260915-start/`다.

- `current-state.json`, `progress.md`: 현재 채택 상태와 진행 중 작업.
- `iterations/016-storage-architecture-hold/iteration.json`, `iterations/017-actual-hull-image-objective/iteration.json`: 구분된 실험 기록.
- 이번 실행의 `manifest.json`, `remote01-causal-audit/report.md`, `remote01-causal-audit/execution-summary.json`: 실행 계보·재현·시간.
- `independent-visual-review.json/.md`: 독립 15장 평가와 확대 범위·정정 내용.
- `review-mobile-hull-current.jpg`, `review-mobile-hull-current-lineage.json`, `root-phone-delivery.json`: 채팅 표시한 동일 조건 15쌍과 원본·결과 해시. 이미지 SHA-256은 `a9d2ca93301b28162c89f0d097345b456ab3f69bd64387e443db5660a29bba20`이다.

다음 채택 판단은 공통 알고리즘을 고정한 15장 전체 결과로 한다. 사진마다 다른 실험의 좋은 부분을 선택하지 않는다.

### 2026-09-15T09:46:21.732Z — iteration018 actual beam128 rejected

15 photos ×4 conditions completed in143.915s, baseline90PNG and all60 numeric conditions reproduced; After60empty, collisions0, no AI/DB/source changes in this run. Root viewed all15 original/four-condition row images; independent reviewer zoomed regressions. pc03 hull128 foreground scale, remote03 box128 facing direction, additional09 toilet occlusion regress. Neither128 condition adopted. Existing objective/search improvement is not photographic accuracy. Current production freeze released for independently reviewed lid-evidence patch, which is a separate limited code fix, not a claim that15 quality is met. New8B download remains pending explicit approval.
