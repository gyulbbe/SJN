# 024: 벽 구조 표현·편집 연결 검증

**15장 자동 재구성 품질은 아직 미달이다.** 이 변경은 사진에 보이는 홈을 표현할 수 없던 기능 공백을 보완했다. 자동 구조 발견은 추가하지 않았고, source:user 입력으로만 홈을 만든다. 자동 결과를 수동 수정한 것으로 바꿔 보고하지 않았다.

## 실제 결과

15장 전체를 동일 코드로 재구성·렌더한 회귀에서 채택019와 계획15개·카메라15개·PNG45개가 같다. 새 AI 추론은0이다. root가 실제 비교판을 열어 remote04의 세면대 위치·낮은 벽 누락, remote05의 구조 누락, 추가06의 상판·지지, 추가09의 오생성 문제가 여전히 있음을 확인했다. 이들은 완료로 처리하지 않았다. 기존 비교판의 Original Lid trial 표기는 이전 harness 제목이며 새 품질 개선을 뜻하지 않는다.

회귀: [실제15 결과](C:/dev/SJN/test-results/reconstruction-fifteen-rebuild/20260915-start/wall-feature-no-feature-regression-fifteen-2026-09-15T13-05-06.694Z/comparison.html). 전체 근거: [integration-verification.json](C:/dev/SJN/test-results/reconstruction-fifteen-rebuild/20260915-start/wall-feature-integration-2026-09-15T12-46-53.127Z/integration-verification.json).

## 수정한 공통 원인과 코드

- Scene.wallFeatures에 닫힌 홈·바닥까지 열린 후퇴 공간을 추가했다. 검증·복사 ID·시안 이력·전체 복원·치수 변경·기본 빈After 분리를 연결했다.
- 평면 앞벽을 실제로 절개하고 후면·옆면·상하면·바닥 확장을 생성한다. 부모 자재·물리 타일 UV와 면적을 유지하며 불명확한 면적은 임의 계산하지 않는다.
- 구조가 있는 프로젝트는 메인 편집·공간 보기·시안 비교·목록·PNG에 공통3D 렌더를 쓴다. 전체 현재 시안의 구조 범위를 같은 카메라에 맞춘다.
- 새 장면 준비 중 과거 pick 사용, 실패한 요청이 최신 대기 요청을 버리는 문제, Escape 후 드래그 재적용을 막았다. 레거시 평면 출력이 구조를 조용히 누락하는 API는 출력할 장면에 구조가 있을 때 명시적으로 거부한다.
- D1/Supabase 요약에 공간 preview 키를 연결했다. D1 현재 요약은 추가R2읽기0, 구요약만 목록마다 원문N개를 순차로 읽는다. 읽기 시 기존 데이터는 덮어쓰지 않는다.

변경 파일48개의 정확한 목록과 검증 해시는 위 JSON에 있다. 원사진15개는 manifest SHA와 전부 일치한다. 기존 미관여 변경은 유지했다.

## 검증

| 범위 | 실제 결과 |
|---|---|
| 최종 단위 검사 | 175파일·2,528개 통과 |
| lint / Next / vinext / typegen / tsc | 모두 통과, 검사 동안584소스 불변 |
| 직접 작성 구조의 WebGL | 175assertion, raycast 깊이·부모타일·회전·PNG·공통Before·자원해제 |
| 실제 편집 UI | 추가·오류·취소·undo/redo·재진입·제품선택·이동·Escape·90도, 별도 임시DB |
| React 오류 경계 | 실제컴포넌트/store + 시험용renderer, 준비/실패pick0·최신요청회복·늦은응답 무시 |
| 원격 요약 | 모의DB/R2로 계약 검증, 실제 서버/DB/배포 미실행 |
| 자동 사진 품질 | 기존019와 같음, 목표 미달 |

최초 전체 검사 뒤 vinext가 생성한 routes 타입과 Next validator 타입이 충돌했다. 실패 로그를 보존하고 프로젝트의 표준 Next typegen을 실행한 뒤 전체 최종 검사를 통과했다. 타입 규칙은 끄지 않았다. 실제 UI 두 통과 실행 사이 원격요약3파일 변경은 별도 기록했고 로컬편집 경로에는 직접 영향이 없다. 실제15 렌더 이후 render-snapshot의 legacy guard와 summary optional type이 바뀌었으므로 전체 소스 동일이라고 주장하지 않는다. room-view/no-feature 동작은 해당 변경의 대상이 아니며 출력 경계42개 검사로 별도 확인했다.

## 성능·한계·다음 검증

WebGL 기능 검사는 기존 Chrome/SwiftShader의 임시 환경이다. 일반PC 30fps나 최대RAM/VRAM을 검증한 것이 아니다. 비교 렌더 캐시가 제한되고 dispose 후 context0인 것은 확인했다. Cloudflare dist 이미지/모델 확장자 파일0과25MB초과파일0을 확인했으나 실제 배포는 하지 않았다.

다음은 기존 승인4B 모델로, 확정 구조 분류 전에 보이는 면 접합을 발견하는 별도4장 실험이다. 기존 dense fixed-region 확인과 다른 미실행 가설임을 감사했다. 결과가 맞는 접합을 찾는지 먼저 보고, 유효하지 않으면 장면에 적용하지 않는다. 새 모델·외부 사진 전송은 사용자 답변 전까지 실행하지 않는다.
