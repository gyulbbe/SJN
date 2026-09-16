# 표준 설비·추정 지지·선택 모형 검증 (2026-09-15)

이번 문서는 모형과 저장 계약의 검증이다. 실제 사진 AI 인식의 성공률 또는 15장 품질 통과를 의미하지 않는다.

## 변경

- `shower`, `wallCabinet`, `lowPartition` 표준 모형 및 종류·스키마·자산 판별·3D 뷰어 지원을 추가했다. 벽 선반·샤워·벽 수납장과 바닥 낮은 칸막이의 설치 규칙을 구분한다.
- 유리의 욕조 테두리 및 낮은 칸막이 상단 지지에 `inferred` 출처와 근거 배열을 지원한다. 후보 ID는 부모 생성 이후 실제 fixture ID로 변환한다. 부모를 임의로 생성하지 않는다.
- 추정 근거가 없거나 부모 종류·규격·바닥 접촉·방 범위·유리 폭/두께/전체 높이가 잘못되면 배치를 보류한다. 잘못된 데이터를 이동·축소해 성공으로 바꾸지 않는다. 삭제된 부모 참조와 교정 입력은 남겨 undo로 복원한다.
- 부모 지지 연결은 이동·회전·높이/배율 변경을 따른다. 뷰어와 출력은 저장 원본을 수정하지 않고 복사본에서 관계를 해석한다.
- 속성 패널과 Lab 입력은 추정 부모를 그대로 보존한다. 사용자가 offset만 바꾸면 offset 출처만 `user`로 바꾸고 추정 부모를 사용자 확인으로 바꾸지 않는다.
- 욕조의 선택적 `bathLiningColor`가 외장과 안쪽/테두리 색을 분리한다. 새 분석 계획은 `#eeefeb`, 출처 `default`를 쓴다. 일반 제품 등록 및 기존 모형에는 자동 삽입하지 않는다. 안쪽 색도 속성에서 수정할 수 있다.
- 일반 거울의 선택적 `mirrorShape`는 `rectangular`, `oval`, `arched`이다. 원형은 폭/높이를 같게 지정한 oval이다. 표면에는 원사진 반사를 사용하지 않는다.
- 기존 vanity/세면대 하부장 조합의 `vanityStyle: open-counter`는 닫힌 문 없이 상판 위에 볼을 둔다. `counterSupport`는 `wall`, `left-panel`, `right-panel`, `both-panels`이며 선택한 패널만 만든다.
- 벽 지지 개방형의 모형 전체 높이는 기본 330mm, 하단 650mm이다. 패널형은 전체 높이 950mm, 하단 0mm이다. 폭1000mm/깊이550mm와 함께 모두 수정 가능한 기본값이며 실측값이 아니다. 빈 하부 공간을 벽걸이 모형의 높이에 포함하지 않는다.
- 새 선택값이 없는 이전 모형은 기존 형상/재질을 유지한다. 저장·복사·실행 취소의 일반 중첩 복사 경로를 사용하고 기존 불변 자재를 덮어쓰지 않는다.

## 검증

- 관련 모형·지지·후보·배치·뷰어·저장 단위 회귀 179개 통과(12파일). 이후 부모 욕조 물리 검사 추가 뒤 관련 52개 재통과.
- 신규 모형 17개, 추정 지지8개, 욕조 안쪽색5개, 선택 거울/상판15개 단위 검증 포함.
- TypeScript `tsc --noEmit` 통과. 수정 범위 ESLint 통과. Next client 지시문은 파일 첫 줄에 유지했다.
- Chrome Headless / Windows / SwiftShader WebGL에서 실제 생성 API, 속성 UI, IndexedDB, undo/redo, 복사, 공통 PNG 출력 검증. 모델 추론/외부 사진 전송/모델 다운로드 없음.
- 미리보기 PNG와 내려받는 PNG 바이트 일치. 내부색만 바뀌고 자재 ID가 같은 경우도 공통 렌더 캐시가 갱신됨.
- 기존10종 × v1/v2: 시작 시점 스냅샷과 정점·법선·정점색·인덱스·재질 색/거칠기/금속성/투명도 20/20 동일.
- 실제 출력 PNG를 확대해 아치 거울의 상부 곡선, 떠 있는 상판, 상부 세면볼, 오른쪽/양쪽 패널, 욕조 외장과 내부색 분리를 직접 확인했다.

증거 위치: `test-results/reconstruction-fifteen-rebuild/20260915-start/`

- `evaluation-rubric.json`, `evaluation-rubric.md`: 15장 원본을 직접 본 평가 기준. AI 결과를 정답으로 사용하지 않음.
- `additional-fixtures-preview.png`, `additional-fixtures-validation.json`: 최초 신규3종 형상 검증.
- `estimated-support/verification.json`, `connected.png`, `parent-moved.png`, `reloaded.png`.
- `bath-lining/verification.json`, `old-preserved.png`, `separate-lining.png`, `legacy-model-equality.json`.
- `fixture-variants/verification.json`, `oval.png`, `arched.png`, `open-wall.png`, `left-panel.png`, `right-panel.png`, `both-panels.png`, `legacy-model-equality.json`.

브라우저 재현 명령:

```powershell
node tests/run-browser-test.mjs tests/reconstruction-estimated-support-browser.ts
node tests/run-browser-test.mjs tests/reconstruction-bath-lining-browser.ts
node tests/run-browser-test.mjs tests/reconstruction-fixture-variants-browser.ts
```

## 남은 통합 검증

- 사진별 실제 관측→선택 모형 적용 연결과 15장 재구성 품질 평가는 별도 통합 실행에서 판단한다. 이 문서의 합성 입력을 AI 인식 성공으로 집계하지 않는다.
- 공통 Next.js/vinext 빌드와 전체 서버 검증은 주 작업에서 수행한다. 실제 배포는 하지 않았다.
- 욕조 내부의 형상 자체는 이전 모형을 유지했다. 이번 욕조 변경은 외장/내부 색 분리이며 정확한 깊이/곡면 복원이 아니다.
- 열린 상판·거울은 표준 모형이다. 미관측 패널·내부 수납·정밀 반사나 실제 치수를 자동 생성했다는 의미가 아니다.