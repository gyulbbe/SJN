# 15장 재구성: 뚜껑 관측 연결·속성 편집 수정 검증

기록: 2026-09-15. **이번 두 수정은 채택했다. 15장 전체의 재구성 품질 목표는 아직 미달이다.** 이전 사진·모델 관측·실패 결과·프로젝트·불변 자재와 기존 Git 변경사항은 보존했다.

## 수정한 원인

1. pc-03의 기존 픽셀 분류 관측에는 연결된 변기 뚜껑/볼 근거가 있었다. 기존 열린 뚜껑 추론 함수도 이를 반환했다. 그러나 추론이 엄격한 설치 위치 계산 성공 분기에 묶여 있어 위치가 보류되면 추정 배치로 전달되지 않았다. 종류·실물/반사·중복·입력 검증·최고 IoU 대응 보호 조건은 유지하면서 관측을 위치 계산과 분리했다. 최신 사용자의 뚜껑 선택이 추정보다 우선한다. 다른 사진을 파일명이나 좌표로 분기하지 않았다.
2. 실제 Properties 검사에서 뚜껑만 닫아도 종류·벽·설치·위치를 모두 사용자 확인으로 바꾸는 기존 문제가 드러났다. 처음과 마지막 폼을 비교해 실제 바뀐 필드만 기록하도록 수정했다. 원후보의 검토 필요 상태와 변경하지 않은 판단 근거는 유지한다. 다른 종류의 기본 폼 값이 제품 정보에 섞이지 않도록 했다.

## 관련 코드

- [뚜껑 관측과 사용자 우선순위](C:/dev/SJN/src/lib/reconstruction/candidate-toilet-lid.ts)
- [엄격한 후보 배치](C:/dev/SJN/src/lib/reconstruction/candidate-pipeline.ts)
- [추정 배치](C:/dev/SJN/src/lib/reconstruction/estimated-layout.ts), [Lab 연결](C:/dev/SJN/src/lib/reconstruction/estimated-room-layout.ts)
- [변경 필드 판정](C:/dev/SJN/src/lib/reconstruction/fixture-property-changes.ts), [속성 편집 UI](C:/dev/SJN/src/components/reconstruction/reconstruction-properties.tsx)

공통 뚜껑 정책은 `independent-semantic-v1`이며 대조용 기존 정책은 남겼다. 배치 revision은 `visible-relation-layout-v9-independent-toilet-lid`다. 원관측 모델·프롬프트·AI 캐시와 일반 생성의 프로필 선택은 바꾸지 않았다.

**아래 15장 사진 비교는 별도 Lab의 추정 배치 경로다.** 일반 앱의 `local-quality-v1` 엄격 경로도 공통 뚜껑 관측 수정을 사용하지만, 이 작업으로 추정 배치 전체를 일반 앱 기본으로 승격하지 않았다. 엄격 경로에서 위치가 보류된 설비가 이 수정만으로 자동 표시되는 것은 아니다.

## 실제 검증

- 같은 저장 AI 관측으로 기존/수정 15장, 총30조건을 실제 렌더했다. pc-03에서만 덮개가 열린 표현으로 바뀌었고 나머지14장의 PNG42개는 정확히 같았다. 모든 카메라와 빈 After는 유지됐다. 11장의 명시적 기본 뚜껑 출처 추가는 이미지 변경과 구분해 원본 차이 보고서에 남겼다.
- 기본값 연결 뒤 다시15장/30조건을 실행했다. 앞서 눈으로 평가한 수정 결과와 PNG45개·배치·카메라가 전부 같았다. 이 재검증은67.737초였다.
- 실제 pc-03 Properties→store→로컬 저장 경로에서 추정 열림→사용자 닫힘→undo/redo→사용자 열림→undo/redo→저장·재열기를 검증했다. 뚜껑 값과 그 출처만 바뀌었고 원후보 차이는 없었다. 출력 비교9조건이 통과했고 UI 표시는 PNG에 들어가지 않았다.
- 별도 합성 거울1개로 실제 Properties의 가로 위치 .35→.60 이동을 확인했다. 설치 높이600mm와 세로 기준 .75가 유지됐다. 이 합성 검사는 AI 인식 성공으로 계산하지 않았다.
- 전체 **166파일·2,336개 테스트**, 린트, 타입 검사, Next.js와 vinext 빌드가 통과했다. 빌드 중 Next가 생성한 타입 참조 경로만 바뀌었으며 구현 소스 변경은 없었다. 범위 밖의 모든 브라우저 E2E를 다시 실행했다고 주장하지 않는다.

이 단계의 새 AI 추론·신규 모델 다운로드·사진 외부 전송·배포는 모두0회다. 로컬 Chrome152/SwiftShader에서 저장 관측을 재생한 시간이므로 실제 전체 AI 처리 시간이나 사용자 PC 성능으로 해석하면 안 된다. 새로운 최대 메모리 측정도 수행하지 않았다.

## 결과와 남은 한계

[최종 실행·보존·검사 영수증](C:/dev/SJN/test-results/reconstruction-fifteen-rebuild/20260915-start/lid-default-fifteen-2026-09-15T10-21-43.994Z/root-final-verification.json)

[실제 UI 독립 검증](C:/dev/SJN/test-results/reconstruction-fifteen-rebuild/20260915-start/lid-properties-2026-09-15T10-19-52.017Z/independent-ui-review.md)

[전체 테스트·빌드 기록](C:/dev/SJN/test-results/reconstruction-fifteen-rebuild/20260915-start/validation-final-lid-properties-20260915T1026/validation.json)

15장 원본/결과 한 장 비교 이미지는 이번 채팅에 이미 표시했다. 최종 기본값 재검증이 동일 출력임을 확인했으므로 같은 이미지를 중복 전송하지 않았다. 원본은 [019 비교 이미지](C:/dev/SJN/test-results/reconstruction-fifteen-rebuild/20260915-start/lid-controlled-fifteen-2026-09-15T09-55-00.293Z/review-mobile-trial.jpg)에 보존되어 있다.

남은 문제는 잘못된 설비 종류·부착 벽·방향·크기와 누락된 주요 구조다. 열린 뚜껑 연결 수정과 속성 데이터 보존은 그중 제한된 문제를 해결한다. 탐색 폭128 확대는 실제 이미지에서 퇴행해 채택하지 않았다. 불확실한 사진 내 관계 점수 실험은 별도로 검토하며, 수치 점수 하락을 사진 품질 개선으로 간주하지 않는다. 추가8B 모델은 사용자 승인 전까지 다운로드하거나 실행하지 않는다.
## 후속 020 관계 실험 — 미채택

같은 기존 관측·box/beam8 기준에 불확실한 사진 내 관계의 강한 점수만 보류하는 실험을 수행했다. 계산된30개 결과를 동결된 실제 렌더러에 연결한15장 비교이며 새로운 모델 추론은 아니다. 기준45PNG와 수치30조건이 일치했고, 다른14장은 PNG42개가 같았다. 전체 실행은65.272초였다.

추가06에서 수납장이 화면 안으로 들어온 점은 개선됐지만, 변기 탱크가 더 잘리고 상판 방향·중앙 패널 오류가 그대로였다. 주 작업자와 독립 검토 모두 국소적·혼합된 결과로 판단해 **기본값에는 반영하지 않았다**. 사진 영역이 겹쳐 관계가 불확실하다는 것만으로 그 관계가 틀렸다고 판단할 수는 없다.

020은012를 기준으로 한 독립 실험이다. 019의 열린 뚜껑 수정과 결과를 섞지 않았다. 이 조건으로15장 원본/실험 결과를 한 장에 정리해 채팅에 직접 표시했다. 현재 채택 소스는 앞에서 검증한019 그대로다.

[020 실행 보고서](C:/dev/SJN/test-results/reconstruction-fifteen-rebuild/20260915-start/photo-relation-uncertainty-render-fifteen-2026-09-15T10-29-35.313Z/report.md) · [독립 시각 검토](C:/dev/SJN/test-results/reconstruction-fifteen-rebuild/20260915-start/photo-relation-uncertainty-render-fifteen-2026-09-15T10-29-35.313Z/independent-visual-review.md)

새8B 모델 다운로드는 사용자 승인 대기 상태다. 현재 개발 서버는 전체 빌드 후 HTTP200 응답을 확인했다. 이 기록 시점에 진행 중인 검증 브라우저·실험 서버·검사 프로세스는 없다.