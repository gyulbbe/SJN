# 경로 추적 시험 정리: 코드 제거, 기록 보존, main 반영

경로 추적(path tracing) 내보내기는 보류로 결정했다. Windows Chrome 기본 백엔드(ANGLE D3D11)에서 물체가 검게 나오기 때문이다(근거: `.claude/worktrees/pathtracer-spike/docs/pathtracer-spike-results-20260925-d3d11.md`). 이번 작업은 세 가지다.

- 경로 추적 관련 코드·의존성을 main에 남기지 않는다.
- 나중에 다시 볼 수 있게 시험 코드는 원격 브랜치에 보존한다.
- 결정 기록 문서만 main에 반영하고 푸시한다.

조사나 계획 설명에서 멈추지 말고 끝까지 진행한다.

## 0. 현재 상태 (2026-09-26 확인)

| 위치                                              | 브랜치                         | 상태                                                      |
| ------------------------------------------------- | ------------------------------ | --------------------------------------------------------- |
| `C:\app\SJN`                                      | `main`                         | `b25f987`, origin/main과 같다                             |
| `.claude/worktrees/pathtracer-spike`              | `claude/pathtracer-spike`      | `b25f987` 위에 **커밋 안 된 시험 작업**. 원격 브랜치 없음 |
| `.claude/worktrees/flux2-klein-9b-cleanup-1a3200` | `claude/flux-product-grounded` | main과 같다. 커밋 안 된 프롬프트 파일 있음                |

스파이크 작업 트리의 커밋 안 된 변경:

- **수정**: `package.json`·`package-lock.json`(devDependencies `three-gpu-pathtracer@0.0.24`, `three-mesh-bvh@0.9.15`), `src/lib/room-viewer/renderer.ts`(`exportFrame`, `exportSize`), `tests/render-realism-browser.ts`(ΔE 함수 분리), `docs/verification.md`(경로 추적 항목 2개)
- **새 파일**
  - 테스트: `tests/pathtracer-spike-page.ts`, `tests/pathtracer-spike-browser.ts`, `tests/pathtracer-bundle-probe.mjs`, `tests/helpers/delta-e.ts`
  - 결과 문서: `docs/pathtracer-spike-results-20260925.md`, `docs/pathtracer-spike-results-20260925-d3d11.md`
  - 프롬프트: `docs/prompts/pathtracer-stage-0-1-feasibility.md`, `docs/prompts/pathtracer-stage-1b-d3d11-investigation.md`
- 로컬 결과물: `test-results/pathtracer-spike/`(git 제외, Chrome 프로필 포함)

`claude/flux-product-grounded` 작업 트리의 커밋 안 된 프롬프트:

- `pathtracer-stage-0-1-feasibility.md`: 스파이크 쪽과 같은 파일
- `pathtracer-stage-1b-d3d11-investigation.md`: 스파이크 쪽 파일의 최신판
- `ai-model-loading-progress.md`: 다음 작업 프롬프트
- `pathtracer-closeout.md`: 이 문서

## 1. 먼저 읽는다

- `AGENTS.md`, `.agents/skills/sjn-workflow/SKILL.md`
- 두 결과 문서, `git status`, `git log --oneline -5`, `git worktree list`
- 커밋 메시지 형식은 최근 커밋(`git log -3 --format=%B`)을 따른다. 끝에 attribution 줄을 넣는다.

## 2. 할 일

### 2-1. 시험 코드 보존 (스파이크 브랜치, main에는 넣지 않음)

1. 스파이크 작업 트리에서 문서의 표기 오류를 먼저 고친다.
   - 범위 표시 `~~`는 GitHub에서 취소선이 된다(예: `3~~4분`). `~` 하나나 `–`로 바꾼다.
   - 첫 결과 문서의 "레이 오프셋" 줄처럼 표 안의 `|`는 칸을 깨뜨린다. 표 밖으로 빼거나 `\|`로 이스케이프한다.
2. 1b 프롬프트는 `claude/flux-product-grounded` 작업 트리의 최신판으로 덮어쓴다.
3. 모든 변경을 `claude/pathtracer-spike`에 한 커밋으로 남긴다. 예: "경로 추적 시험(보류): three-gpu-pathtracer 0~1b단계 코드와 결과".
4. `git push -u origin claude/pathtracer-spike`로 원격에 보존한다. 이 브랜치는 main에 병합하지 않는다.
5. 커밋 SHA를 기록한다(3단계 문서에 쓴다).

### 2-2. main에 결정 기록만 반영

1. main에서 새 브랜치 `claude/pathtracer-closeout`을 만든다. `claude/flux-product-grounded` 작업 트리에서 브랜치를 바꿔 진행해도 된다. 그 작업 트리의 커밋 안 된 프롬프트 파일이 따라온다.
2. **코드·의존성·테스트는 가져오지 않는다.** `package.json`, lock, `renderer.ts`, 테스트 파일은 main 그대로다.
3. 문서를 추가한다.
   - `docs/pathtracer-decision.md`(새 파일, 짧게)
     - 무엇을 왜 시험했는지
     - 결론: Windows Chrome D3D11에서 출력 무효, Vulkan은 정상이나 웹이 백엔드를 고를 수 없음, 첫 컴파일 3~4분
     - 다시 볼 조건: WebGPU용 경로 추적 라이브러리(upstream #547)
     - 코드 위치: 브랜치 `claude/pathtracer-spike`, 커밋 SHA
     - 두 결과 문서는 그 브랜치에 있다고 링크나 경로로 적는다.
   - `docs/verification.md` 맨 위에 경로 추적 항목을 **하나**로 요약해 추가한다. 스파이크 브랜치의 두 항목을 합친 것이다.
   - 프롬프트: `pathtracer-stage-0-1-feasibility.md`, `pathtracer-stage-1b-d3d11-investigation.md`, `pathtracer-closeout.md`(이 문서), `ai-model-loading-progress.md`를 `docs/prompts/`에 커밋한다. 이 저장소는 실행한 프롬프트를 기록으로 남긴다. 경로 추적 프롬프트 첫머리에는 "보류됨, 코드는 `claude/pathtracer-spike`"라는 한 줄을 단다.
4. `.agents/skills/sjn-workflow/references/`는 바꾸지 않는다. 사용자 동작 변화가 없다.
5. 결과 문서의 링크가 main에 없는 파일(시험 코드, 결과 문서)을 가리키면 깨진다. main에 넣는 문서에서는 브랜치 이름과 경로를 글로만 적는다.

### 2-3. main 병합과 푸시

1. `claude/pathtracer-closeout`을 커밋한다. 문서만 들어간 한 커밋이다.
2. `C:\app\SJN`(main)이 깨끗하고 origin/main과 같은지 확인한다. `git fetch`를 먼저 한다. 다르면 멈추고 보고한다.
3. `git -C C:\app\SJN merge --ff-only claude/pathtracer-closeout` 후 `git push origin main`
4. 로컬 main과 origin/main이 같은 SHA인지 확인한다.
5. 기능 브랜치 `claude/pathtracer-closeout`은 원격에 올리지 않는다(main에 들어갔으므로).

### 2-4. 로컬 정리 (사용자 확인 후)

- `.claude/worktrees/pathtracer-spike` 작업 트리 제거는 **사용자에게 묻고** 한다. 제거하면 `test-results/pathtracer-spike/`(비교 이미지, Chrome 프로필)가 함께 지워진다.
  - 남길 이미지가 있으면 먼저 사용자가 고르게 한다.
  - 원격 브랜치에 코드가 올라간 것을 확인한 뒤에만 제거한다.
- `claude/flux-product-grounded` 로컬 브랜치 정리도 묻고 한다. 이미 main에 병합됐다.

## 3. 반드시 지킬 조건

- main에는 문서만 들어간다. 확인 방법:
  - `git diff b25f987..main --stat`에 `docs/`만 있다.
  - `package.json`에 `three-gpu-pathtracer`가 없다.
- `--force` 푸시, bare `git stash`, 이력 재작성(rebase·amend로 푸시된 커밋 수정)은 하지 않는다.
- 푸시 대상은 `origin claude/pathtracer-spike`(보존)와 `origin main` 두 개뿐이다.
- 줄바꿈은 작업 사본 CRLF, 저장소 LF다. 문서 Prettier는 쓰기에 `--end-of-line crlf --write`, 검사에 `--end-of-line auto`를 쓴다.
- AI 호출은 없다.

## 4. 검증

- main 쪽: `npx prettier --check --end-of-line auto`로 새 문서를 검사한다. 코드 변경이 없으니 typecheck·테스트는 필요 없다. 그래도 `npm run lint`는 한 번 돌린다(문서만 바뀌어 영향이 없는지).
- 스파이크 쪽: 푸시 전에 `npm run typecheck`와 `npm run lint`를 돌려, 보존하는 시험 코드가 적어도 빌드되는 상태로 남게 한다. 실패하면 고치지 말고 커밋 메시지와 결정 문서에 적는다.
- 끝나면 `git worktree list`, 각 작업 트리의 `git status`를 보여 준다.

## 5. 보고

- 보존 커밋 SHA와 원격 브랜치 이름
- main에 들어간 커밋 SHA와 파일 목록
- 로컬 정리 여부(사용자 답에 따라)
- 다음 작업 후보: AI 모델 로딩 % 표시(`docs/prompts/ai-model-loading-progress.md`), 배포 후 FLUX 실제 확인
