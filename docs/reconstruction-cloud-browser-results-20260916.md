# Cloudflare Gemma + 브라우저 MoGe 구현·검증 기록 (2026-09-16)

> 역사 기록: 아래 본문은 같은 날의 실제 Gemma 호출 전 상태를 보존한다. 이후 실제 v5 15장 실행, v6 개선·검증과 남은 제약은 [v6 후속 보고서](reconstruction-cloud-browser-results-20260916-v6.md)를 참고한다. 아래의 미실행·전송 0회 문구는 현재 상태가 아니다.

**브라우저 모델 실행과 기존 생성 흐름 연결을 구현하고 검증했다. 실제 Gemma 설비 인식과 Gemma를 포함한15장 최종 공간 품질 검증은 미실행이다.** 이 기록을15장 재구성 품질 목표의 완료 보고로 사용하지 않는다. 기존 채택 결과019와 이후024/025 및 원본은 보존했다.

실행폴더: `test-results/reconstruction-browser-cloud/2026-09-15T14-37-49-793Z/`. 출발258개소스해시, Git상태와 현재624개검증소스해시를 별도 보관했다. 기존 큰 dirty worktree를 초기화하거나 커밋·푸시·운영배포하지 않았다.

## 변경과 원인

- `src/app/api/reconstruction/cloud/route.ts`, `cloud-gemma-{contract,server,errors,cache-contract}.ts`: 별도 Workers API, AI바인딩과 sjn-gateway, Gemma의 이미지 data URL·max_completion_tokens·thinking off·JSON schema, 출력 Zod검증. 기존 Node전용API를 그대로 올리지 않는다.
- `analysis-provider.ts`, `local-engine-client.ts`, `quality-core.ts`: 로컬Qwen digest와 Cloudflare provider-managed identity 분리. 저장된 관측도 provider·contractRevision을 검증한다. 가중치 해시를 발명하지 않는다.
- `analysis-transport.ts`, `cloud-usage.ts`: 같은단계공유, 완료단계캐시, 제한된429/503재시도와 Retry-After. 한도·인증·입력오류는 자동재시도하지 않는다. IDB쓰기실패때메모리캐시를놓치고AI를재호출하던오류와 경고추가로checksum이달라지던오류를수정했다. 실패전호출·부분거울재확인도checkpoint에남긴다.
- `moge-browser/`: 고정FP32 ONNX·SHA검증·모델캐시·Worker·WebGPU/CPUfallback. 공식후처리, 초점/shift/intrinsics·metric scale·mask·평면/64×64support까지이식했다. GPU실패시검증바이트를새CPUWorker로넘긴다.
- `plane-random.ts`, `planes.ts`: xorshift와Python PCG64차이로같은관측에서도벽조각수가달랐다. NumPy2.2.6 PCG64와표본선택을이식하고 v2-pcg64로캐시버전을올렸다. Python원기준이나사진별규칙을바꾸지않았다. MIT/BSD공지보존.
- `geometry-browser-client.ts`, `geometry-contract.ts`, `depth-room-geometry.ts`: 실제입력·모델·후처리·평면버전검증, 결과캐시무결성, 정수해상도축소의반올림을기록. 원본intrinsics를몰래변경하거나모델추정m를실측으로표시하지않는다.
- `index.ts`, `cloud-quality.ts`, `analysis-profile-picker.tsx`: 일반사진생성과Before재분석에새경로연결. Cloudflare연결준비와실제추론성공을구분한다. 기존기본/개발로컬분석은유지한다. 사진의Cloudflare전송설명변경.
- `candidate-pipeline.ts`, `types.ts`, Supabase검증, review UI: Gemma관측출처를Qwen이라고저장·표시하던오류수정. 기존Qwen/user호환유지.
- `/reconstruction-performance`, `browser-analysis-test.ts`, `browser-analysis-lab.tsx`: 실제Gemma단독·MoGe단독·전체생성검사, 원본·깊이·법선·평면·Before·JSON, CPU/GPU선택·취소. 테스트는프로젝트/자재저장하지않는다. 평면배경0을전체평면으로칠하던UI오류도수정했다.
- `wrangler.jsonc`: AI바인딩추가. 기존ASSETS·저장모드·인증설정보존. `.env.example`에선택모델URL설명추가.

## 실제 모델과 이미지 검증

Windows Chrome152, Ryzen7800X3D, RTX4070Ti, RAM약32GB. 실제브라우저peak RAM/VRAM은측정불가다.

|검사|결과|근거|
|---|---|---|
|15장실제DeepLab+MoGe GPU|추론0.47~1.23초, DeepLab9.89~29.78초. 바닥13장/2장확인필요|moge-runtime-validation.md|
|GPU없는환경의자동CPU|가로·정방형·세로3장실제성공. 단일스레드추론10.93~11.47초|moge-no-gpu-auto/|
|조건을갖춘CPU4스레드|COOP/COEP설정테스트서버에서4.12초. 일반서비스헤더변경없음|moge-isolated-wasm/|
|공식Python후처리대조|같은raw의points/depth차최대약7.15e-7모델추정m|postprocess-parity-initial/|
|원Python평면대조|15장+별도1장모두평면수·inlier·64×64support일치|moge-browser-numeric-validation-pcg64.md|
|실제Next제품화면|MoGe+DeepLab→3개미리보기→JSON다운로드성공. 첫30.99초/캐시4.93초|moge-next-product-ui/|
|다운로드실패·취소|통제HTTP503/손상/취소실브라우저검증. 모델품질검사와구분|moge-transport/|

원본과평면관측진단은 `planes-support-audit/`에15장보존했다. 대표remote03/04, pc03, additional05는확대확인했다. remote03은6→3벽조각으로원기준과일치하지만유리주변오분절과additional05/08의좁은바닥지지는남아있다. 그림은3D완성본이아니다. 재추론없이실제저장dense를후처리한대조는재생이라고명시했다.

저사양PC·실제모바일·Safari/Firefox의원활한동작, 설비인식정확도, 실측치수정확도는이검증으로주장하지않는다. 모의응답을실제Gemma인식성공으로집계하지않았다.

## 코드·화면·빌드 검증

- 전체단위테스트2657개통과: `final-unit-tests.json`. 이후테스트내필수의존성guard추가로타입검사보완(제품코드변화없음).
- 전체lint통과, `npm run typecheck`통과.
- UI모의16개: 생성→Before재분석→After보존→저장/새로고침, 취소/한도오류/캐시/모바일/JSON. `ui-mocked/`에모의범위와회차보존. 실제모델검증과구분.
- Next와vinext빌드통과. 두도구를동시에빌드하면 `.next/types`를서로갱신하여Next타입검사가실패했다. 순차typegen/Next빌드로해결했으며 검사를끄거나소스오류를무시하지않았다.
- 실제local workerd:cloud GET200(binding준비만),cross-originPOST403,기존로컬AI경로비활성,성능페이지200. `workers-runtime-boundary-after-review/`.
- `vinext-boundary-audit.json`:AI바인딩전달,ASSETS·vars보존, 금지된Python/child_process/sharp실행모듈import0,25MiB초과client파일0,ONNX파일0,개인사진명0. 공개파일정적검사범위이며실제Gemma호출검증을대체하지않는다.
- 기존favicon404와ORT일부shape CPU할당경고는로그에보존했다.

## Cloudflare 실제 확인과 남은 작업

Wrangler로그인이회복되어sjn Worker AI바인딩을실제읽어확인했다. 오늘UTC AIanalytics는기록0건이지만잔액원장이나실시간0사용의확정근거는아니다. 계정subscriptions와sjn-gateway상세는403으로요금제/Standard대Unified billing/Gateway로그를확인하지못했다. **실제AI호출0,사진외부전송0**.

사용자에게Workers Free확인을요청했다. Gateway의Workers AI Billing도Standard인지확인해야한다. 무료조건을확인하면한장·소량으로실제JSON/모델/Gateway로그를검증한뒤통합품질평가를이어간다. 유료대체나요금제변경은하지않는다.

공개사이트의로컬저장모드에익명AI접근을허용하는수정은자동승인검토가쿼터·비용악용위험으로거절했다. 사용자선택을요청했고,답변전에는기존D1세션/loopback개발제한을유지했다. 인증설정을이번작업편의를위해변경하지않았다.

미완료: 실제Gemma9단계응답/성능/Gateway관찰, Gemma+DeepLab+브라우저MoGe의15장자동Before최종비교판·품질평가,저사양성능. 따라서전체목표는계속진행상태다.

설정·사용가이드: [reconstruction-cloud-browser-setup.md](reconstruction-cloud-browser-setup.md).
