# 표준 욕조와 유리의 명시적 연결

2026-09-13. Before 설비 보정에서 **이미 배치한 표준 욕조**를 선택하고 유리를 테두리에 연결한다. 새 욕조를 자동 생성하거나 사진 속 관계를 인식했다고 표시하지 않는다.

## 사용법

1. Before에서 표준 유리 파티션을 선택하고 `유리 지지면`을 `욕조 테두리 위 · 직접 확인`으로 바꾼다.
2. `실제 배치한 욕조와 연결`에서 욕조를 선택한다. 처음 선택은 문구에 표시된 앞쪽 테두리 중앙이다.
3. 욕조 자체의 왼쪽·오른쪽·앞쪽·뒤쪽 테두리와 중앙 기준 거리(mm)를 조절하고 `재구성 설정 적용`을 누른다.
4. 연결한 유리의 바닥 위치·하단 높이·방향은 욕조에서 계산한다. 해당 입력은 잠기고 유리 자체 규격·투명도는 계속 바꿀 수 있다.
5. 욕조 이동·회전·규격·배율 변경을 따라가되 유리 규격을 자동으로 줄이지 않는다. 연결을 해제하면 마지막 높이를 사용자가 확인한 독립 높이로 유지한다.

테두리의 평평한 구간보다 폭·두께가 크거나, 거리 입력 때문에 끝을 넘거나, 공간 경계를 벗어나면 이유와 함께 보류한다. 부모가 삭제되거나 다른 제품으로 바뀌어도 유리와 부모 ID는 삭제하지 않는다. Before 기구 목록에서 보류 이유를 확인하고 다시 욕조를 선택하거나 연결을 해제할 수 있다. 부모 삭제를 실행 취소하면 원래 연결이 복원된다.

## 데이터와 실제 모형 기준

`RaisedGlassSupport.bathRim`에 `parentFixtureId`, `side`, `offsetMm`, 사용자 확인 출처(`parent/side/offset: user`)를 저장한다. 연결 높이 출처는 `support.provenance.height: parent`이며 사진 실측이 아닌 부모 표준 모형에서 계산한 값이다. 기존 `user/default` 독립 지지면과 선택 필드가 없는 과거 자료는 그대로 읽힌다.

욕조는 수전까지 포함해 전체 규격에 맞춘 모형이다. 따라서 유리 하단을 단순히 욕조 전체 높이에 두지 않는다. `standardBathRimGeometry`가 기존 모형의 정규화 비율과 테두리의 평평한 구간을 계산한다. 일반 욕조 1500×600×750mm의 실제 모형 테두리는 약 560.9mm이다. 욕조 둥근 테두리의 가장자리 영역은 설치 가능 폭에서 제외한다. 세 모형 규격의 실제 테두리 메시 높이·중심과 계산 결과를 비교한 테스트를 둔다.

`normalizeRoomScene`과 공간 크기 변경의 부모 처리 다음에 연결 유리를 동기화한다. 같은 편집 명령·실행 취소 프레임에 부모와 자식 변화가 함께 들어간다. 읽기·미리보기·내보내기는 입력 장면을 수정하지 않는 사본에서 현재 관계를 계산한다. 유효하지 않은 연결은 공통 렌더에서 제외하지만 저장 장면에 남긴다. 별도의 중복된 `held` 저장 상태를 만들지 않는다.

시안 복사·프로젝트 복제는 부모 ID도 새 ID로 변환한다. 전체 프로젝트의 Before/After와 이력의 모든 장면에 같은 ID 변환기를 사용한다. 이미지·불변 자재 버전은 공유하고 덮어쓰지 않는다. 유리만 단독 복제하면 같은 부모 참조를 유지하며, 욕조만 단독 복제하면 기존 유리가 새 욕조로 자동 연결되지 않는다.

변경 경로: `src/lib/reconstruction/bath-rim.ts`, `bath-rim-geometry.ts`, `types.ts`, `raised-glass-support.ts`, `index.ts`, `templates.ts`(이름만), `src/lib/room-editing.ts`, `designs.ts`, `render/compositor.ts`, `supabase/validation.ts`, Before의 `bath-rim-controls.tsx`, `reconstruction-fixture-controls.tsx`, `reconstruction-properties.tsx`, `reconstruction-review.tsx`. 원래 욕조의 메시·재질은 변하지 않으므로 template renderer revision9를 유지했다.

## 검증 결과

- `npx vitest run tests/reconstruction-bath-rim.test.ts tests/reconstruction-shower-curb.test.ts tests/reconstruction-raised-support.test.ts tests/design-storage.test.ts tests/fixed-room-editing.test.ts`: **5파일 75개 통과**, 새 욕조 연결 14개 포함.
- 실제 정규화된 테두리의 높이·중심, 네 측면의 이동·회전·부모 크기 변경, 규격·거리 초과, 부모 누락, 구 지지면 유지, 저장 스키마, 시안·전체 프로젝트·이력 부모 ID 변환, undo/redo, read-only 해석을 확인했다.
- 담당 소스와 새 검사 파일 scoped ESLint 통과. 전체 typecheck/Next/vinext 빌드는 루트 통합 검사에서 수행한다.
- `node --experimental-strip-types tests/reconstruction-bath-rim-browser.ts`: **실제 Before 속성/기구 목록, Zustand 명령·이력, IndexedDB, 공통 renderer 검사 통과**. Chrome headless + SwiftShader, 별도 loopback origin, 새 AI/모델 Worker 0회, 외부 사진 전송 0회.
- 입력은 사용자01의 기존 실제 분석을 사용자 역할로 보정한 보고서(`test-results/reconstruction-manual-ui-user01-02/user-01/corrected.json`)의 5개 설비다. 이 모형을 새 로컬 검사 저장소에 재생성한 후 유리와 연결 관계만 기능 검증용으로 추가·수정했다. **사진에서 자동으로 유리를 찾거나 정확한 설치 위치를 알아낸 성공이 아니다.** 원 보고서는 변경하지 않았다.
- 실제 UI에서 연결→거리 초과 거절→유효 거리 적용→부모 90° 회전·이동·높이 변경→부모 삭제 보류→기구 목록 재선택→보류 상태 저장·다시 읽기→undo 복원→저장·재진입→프로젝트 복제 부모 ID를 확인했다. After는 끝까지 빈 공간이다.
- 연결 직후·부모 이동 후·부모 누락·재진입 네 상태 모두 1200×800 미리보기와 PNG 다운로드의 **RGBA 채널 차이 0**이다. 편집 도구는 출력하지 않는다.

증거: [비교 HTML](../test-results/reconstruction-bath-rim-20260913/comparison.html), [검증 JSON](../test-results/reconstruction-bath-rim-20260913/verification.json), [픽셀 비교](../test-results/reconstruction-bath-rim-20260913/preview-export-comparison.json), [초기 실패·거절 기록](../test-results/reconstruction-bath-rim-20260913/validation-notes.json).

실제 PNG를 확인했을 때 유리 하단이 욕조 테두리에 닿고, 부모를 회전한 뒤에도 접촉을 유지했다. 부모 전체 높이650mm+유리1800mm 조합은 실제 테두리 높이를 합치면 2400mm 공간을 약7.6mm 넘으므로 보류됐다. 정상 연동 경로는 부모 전체 높이620mm로 확인했다. 유리를 줄이거나 바닥에 내리는 우회는 하지 않았다.

## 범위와 남은 한계

Before 속성은 표준 욕조 fixture ID를 사용한다. 같은 날 후속 작업에서 **Lab 후보 보정에도 명시적 부모 욕조 선택을 연결**했다. Lab 후보 ID는 부모 모형 생성 후 실제 fixture ID로 변환하며, 독립 수동 높이를 자동 연결로 바꾸지 않는다. 후속 사용법·별도 실제 검사·범위는 [Lab 욕조 테두리 연결](reconstruction-lab-bath-rim.md)에 기록했다.

부모는 현재 표준 욕조(v2)만 지원한다. 부모 욕조 자체의 공간 안 배치는 기존 정규화에 의존한다. 연결 helper는 부모를 별도로 이동·축소하거나 부모 전체 경계를 재판정하지 않고, 그 부모 모형의 테두리와 연결된 유리의 공간 경계를 검증한다. 업로드한 제품 PNG, 실제 상품의 상세 테두리 구조, 수전·다른 설비와의 전체 충돌 및 시공 안전성까지 검증하지 않는다. 욕조 수전이 놓인 뒤쪽 테두리를 선택할 때도 전체 제품 간 충돌 검사는 별도 과제다. 네 원본 사진의 전체 공간 복원 정확도를 이 기능의 배치 개수로 평가하지 않는다. 실제 Supabase 연결·배포 검증은 이번 범위 밖이며 스키마 검증만 실행했다.
