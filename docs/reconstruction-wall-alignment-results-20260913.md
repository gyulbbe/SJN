# 설치 관계를 참고하는 위치 복사와 세면대 전용 입력

2026-09-13. 원래 사진→Before 목표의 최소 사용자 확인 경로를 확장했다. 자동 촬영 기하를 새로 추론하거나 미확정 카메라를 승인한 변경은 아니다.

## 실제 화면 변경

사진 재구성 테스트의 후보 **필드 확인 / 사용자 교정**에서 거울·거울 수납장·벽 선반에 **세면대·하부장 위에 맞추기**를 제공한다. 먼저 세면대 또는 하부장의 위치를 정한 뒤 참고 설비를 선택하면 설치 벽·가로 중심·하단 높이를 함께 확인할 수 있다. 기본 간격150mm는 화면에 기본값으로 표시하고 수정할 수 있다. **위에 위치 맞추기**를 눌러야 사용자 배치에 반영된다.

위치는 선택 시점의 복사본이다. 이후 참고 설비의 이동·삭제를 따라가지 않으며 화면에도 이를 명시한다. 기존 위치·크기 편집으로 따로 조정할 수 있다. 모형의 상단과 간격을 사용한 사용자 확인값이며 실제 사진의 설치 높이를 측정한 결과가 아니다.

- 벽 설치 부모는 실제 선택된 설치 면을 유지한다. 바닥 부모는 설치 벽을 명시해야 하고, 부모 방향과 그 벽이 맞지 않으면 보류한다. 기본 yaw만으로 벽을 추정하지 않는다.
- 반사·중복·종류 충돌·부품 상태가 미해결인 부모, 위치가 없는 부모, 잘못된 수치 또는 지지 형태를 자동 복사하지 않는다. 미완성 수치 한 항목 때문에 다른 부모 선택지까지 사라지지 않도록 한다.
- 부모와 자식 모두 기존 전체 모형 범위 검사를 거친다. 공간 밖으로 나가는 결과는 이유를 표시하고 적용을 막는다. 크기 축소·좌표 보정으로 성공시키지 않는다.
- 자식의 빈 규격은 그대로 비워 두고 기본값 출처를 유지한다. 위치·벽은 사용자 보정이며, 간격은 default/user를 별도로 기록한다.
- `LabManualDraft.positionReference`는 복사 당시 부모 모형·종류·벽·간격·공간 치수·결과를 교정 스냅샷에 남긴다. 라이브 설비 참조나 AI 관측이 아니므로 원래 관계 그래프를 바꾸지 않는다. 기존 문서는 선택적 필드 없이 그대로 읽는다.
- 원래 모델, 자동 결과, 자재·시안 데이터는 덮어쓰지 않는다. 현재 생성 API가 기존 PNG/프로젝트 저장 경로를 사용하며 새 AI 호출이나 업로드는 없다.

별도로 **세면대 지지 구조** 선택은 세면대에만 표시하도록 고쳤다. 하부장 등 다른 종류에서 이 값을 선택하면 의미 검증 실패를 스스로 만들 수 있었기 때문이다. 기존 잘못된 값은 숨겨 버리지 않고 설명과 **세면대 전용 지지값 지우기** 버튼을 제공한다. 종류를 왕복하면 원래 선택값은 보존하고, 삭제는 명시적 사용자 보정으로 기록한다. 하부장의 볼 개수 선택은 유지한다.

## 코드

- `src/lib/reconstruction/wall-alignment.ts`: 벽 좌표와 상단 높이의 순수 계산·검증. 사진 좌표나 새 모델이 필요하지 않다.
- `src/components/reconstruction/lab-wall-alignment.tsx`: 선택·간격·미리보기·명시적 위치 복사·과거 참고 기록.
- `src/components/reconstruction/manual-placement-editor.tsx`: 기존 위치 편집에 연결.
- `src/components/reconstruction/reconstruction-lab.tsx`: 현재 유효한 설비 위치 공급과 종류별 필드 적용.
- `src/lib/reconstruction/lab-correction.ts`: 선택적 사용자 참고 이력. 실제 배치는 기존 수동 배치 계약을 그대로 사용한다.

## 실제 사진 검증

이전에 평가한 `prospective-03`을 현재는 회귀 사진으로 취급했다. 실제 저장된 모델 관측을 현재 파이프라인에 재생하고 production Lab에서 필요한 사용자 보정을 수행했다. 초기 자동 배치0개는 유지됐다. 새 모델 추론이 아니다.

첫 보정에서는 세면대·거울·변기3개를 만들었다. 후속 보정에서는 거울의 설치 방식·벽·가로 위치·높이를 각각 입력하던 대신, 이미 보정한 세면대를 선택하고 위에 맞추기를 사용했다. 세면대 상단과 기본150mm 간격으로 거울 하단1120mm, 정면 벽·가로0.28이 생성됐다. 기본 규격·원문·원관측·기존 자동 결과가 유지되고 다운로드 PNG와 미리보기 SHA256이 일치했다. 새 AI·외부 통신·페이지 예외는0이다.

첫 실행의 하단1300mm 결과와 입력 기록도 보존했다. 스크립트의 의미 입력17→14는 인간의 최소 클릭 수나 작업 시간을 측정한 결과가 아니다. 어느 높이도 실측 정답으로 주장하지 않는다.

실제 PNG에서는 세 종류와 거울/세면대 상하 관계를 알아볼 수 있다. 다만 원사진의 흰 도기가 갈색으로 나타나고, 좁은 구도·마감·커튼·문·선반은 충분히 표현되지 않았다. 기존 색 추정과 공간 기하의 한계는 이번 사용자 보정 기능과 별도 문제다. 이 결과를 전체 자동 재현이나 후보 모델 채택 성공으로 보고하지 않는다.

사진·JSON·비교: [회귀 결과 문서](reconstruction-regression-correction-20260913.md), [위치 맞춤 비교](../test-results/reconstruction-lab-regression-correction-20260913/run-02-alignment/comparison.html), [실제 검증 JSON](../test-results/reconstruction-lab-regression-correction-20260913/run-02-alignment/verification.json).

## 검사

- 새 위치 계산30개와 기존 벽 기준10개가 통과했다. 세 면의 방향,0mm 간격, 크기 초과·잘못된 부모·대각 방향·입력 불변을 검사한다.
- 세면대 전용 입력은 관련 단위39개와 실제 RunFindings 브라우저에서 확인했다. 데스크톱·390px, 종류 왕복·명시 삭제·키보드·disabled·원문 보존을 검사했다. 이 시험의 종류 변경과 과거 오류 입력은 UI 기능 시험이며 AI 관측 성공이 아니다. [브라우저 기록](../test-results/reconstruction-lab-field-applicability-20260913/verification.json).
- 전역 ESLint16.757초, 타입5.962초, Vitest100파일1,240개 통과(명령8.151초). Next.js50.934초→vinext21.457초 순차 빌드 exit0. [전체 로그](../test-results/reconstruction-wall-alignment-final-20260913/checks/checks.json).

Windows 로컬 테스트 환경에서 수행했다. 다른 기능 검사와 개발 작업이 있는 실행 환경이며 시간은 독립 성능 벤치마크가 아니다. 이번 작업에서 새 모델 시간·전체 프로세스 메모리·GPU 최고 메모리를 측정하지 않았다. 실제 Supabase 연결·배포는 실행하지 않았다.


## 2026-09-14 최종 추가 검증

종류 변경 후 숨은 볼 개수도 명시적으로 지울 수 있게 보완했다. 실제 user04의 하부장2볼 관측을 보존한 채 변기로 바꿀 때 경고가 나타나고, 사용자 삭제 후 의미 검증을 통과한다. 종류를 되돌리면 기존2볼이 유지된다. 신규3개 포함 관련40개 단위 및 실제 필드 UI/검증기, 키보드/390px/잠금/원문불변 검사가 통과했다. [최종 필드 기록](../test-results/reconstruction-lab-field-applicability-20260913/run-02-bowl-count/verification.json).

최종 전역100파일1,241개 통과, lint16.844초·타입5.221초·테스트 명령8.528초·Next14.163초→vinext21.104초 모두 exit0. [최종 checks](../test-results/reconstruction-wall-alignment-final-20260913/run-02-fields/checks/checks.json). 앞 절의1,240개는 마지막 볼 개수 수정 전 기록으로 유지한다.

합성 부모 입력을 쓰는 production 위치 UI18항목도 통과했다. parent 이동/삭제 후 고정 복사 위치 유지, 재적용 보류, 범위/방향/잘못된 값/disabled/출처를 확인했다. [결과](../test-results/reconstruction-wall-alignment-ui-20260913/run-01/verification.json). 이 검사는 실제 모델 정확도가 아니다.

새 run-03에서는 실제 LabProjectAction 저장 버튼→IndexedDB load→페이지 reload→readLabProjectReport를 실행했다. positionReference의 부모 snapshot·room·기본간격150·결과높이1120과 원관측/모델을 보존하고 Before3/After빈·동일PNG를 확인했다. [저장 결과](../test-results/reconstruction-lab-regression-correction-20260913/run-03-savedalignment/verification.json). 새 테스트의 scoped lint/type도 통과했다.

네 사용자 사진도 실제 Next 보정·저장·새로고침·undo/redo·시안·4096px 비교PNG까지4개 통과했다. 마지막 볼 개수 UI 수정 직전의 전체흐름 검사와 최종 필드/전역 검사를 구분한다. [전체 인계와 남은 품질 한계](reconstruction-completion-20260914.md).
