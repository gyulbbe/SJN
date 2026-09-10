# Cloudflare 첫 배포 (로그인·DB 없음)

현재 Cloudflare 구성은 `local` 저장 모드 전용이다. 사이트는 인터넷으로 제공하고 사진·자재·프로젝트는 방문자의 브라우저 IndexedDB에 저장한다. Supabase, KV, R2, Cloudflare Images 계정 연결은 필요하지 않다.

## 로컬 확인

```powershell
npm ci
npm run typecheck
npm run lint
npm test
npm run build:vinext
npm run start:vinext
```

`start:vinext`는 생성된 `dist/server/wrangler.json`을 사용해 로컬 Workers 런타임에서 실행한다. 표시된 로컬 주소로 접속한다. 기존 Next.js 개발은 `npm run dev`, Workers용 개발은 `npm run dev:vinext`이다.

빌드 후 브라우저 검증:

```powershell
npm run test:cloudflare
```

테스트는 Chrome을 사용하고 8787 포트에서 Workers 서버를 시작한다. 기본 공간 생성·저장·새로고침, 사진 분석 자산, 비활성 서버 API를 확인한다.

## AI 배경 제거 테스트의 브라우저 실행

제품 사진 미리보기의 AI 테스트는 Cloudflare AI나 별도 서버를 사용하지 않습니다. 브라우저의 모듈 Worker에서 ONNX 추론을 실행합니다. 결과 확인·다운로드만으로는 자재를 바꾸지 않으며, 투명 PNG 업로드를 누르면 선택한 저장소의 새 제품 자산으로 저장합니다. 로컬 모드에서는 IndexedDB에만 저장합니다. 모델은 고정 Hugging Face 리비전에서, ONNX WASM 실행 파일은 버전이 고정된 jsDelivr 주소에서 처음 실행할 때 다운로드합니다. 이 두 외부 호스트를 차단하면 테스트 창에 다운로드 실패를 안내합니다.

Vite는 Worker를 ES 모듈로 빌드하고, client 환경의 기본 resolve 조건에 `onnxruntime-web-use-extern-wasm`을 추가합니다. 실제 CDN 경로를 사용하는 실행 파일이 배포 파일에 중복 포함되는 것을 막습니다. 기존 TensorFlow Worker의 환경 보정도 유지합니다. 상세 버전·라이선스·조건은 [AI 테스트 문서](ai-background-removal.md)에 기록합니다.

`npm run build:vinext` 후 다음 명령으로 배포용 산출물의 실제 AI 테스트를 실행할 수 있습니다. 공개 검증 사진을 먼저 준비해야 하며 모델 다운로드가 발생합니다.

```powershell
$env:SJN_AI_BACKGROUND_TARGET = 'cloudflare'
$env:SJN_AI_BACKGROUND_REAL = '1'
npm run test:background-removal
```

## GitHub main 자동 배포

코드와 `package-lock.json`을 함께 커밋하고 GitHub `main`에 반영한다. Cloudflare의 **Workers & Pages → Create application → Import a repository**에서 GitHub `gyulbbe/SJN`을 연결한다.

| 항목               | 값                                             |
| ------------------ | ---------------------------------------------- |
| Worker 이름        | `sjn` (`wrangler.jsonc`의 name과 동일) |
| Production branch  | `main`                                         |
| Root directory     | 저장소 루트 `/`                                |
| Build command      | 비워 둠                                        |
| Deploy command     | `npm run deploy:vinext`                        |
| 비운영 브랜치 빌드 | 처음에는 끔                                    |

`deploy:vinext`가 빌드와 배포를 함께 수행한다. Node 버전은 루트 `.node-version`으로 고정한다. 저장 모드는 빌드 설정과 Wrangler에서 `local`로 지정하므로 추가 환경변수나 Supabase 키를 등록할 필요가 없다. 기존 빌드 환경변수에 `NEXT_PUBLIC_STORAGE_MODE=supabase`가 있으면 제거한다.

**Save and Deploy** 후 제공된 주소에서 동작을 확인한다. 이후 GitHub main으로 push하거나 PR을 merge하면 자동 배포된다. 로컬 commit만으로는 배포되지 않는다. 기존 Worker는 **Settings → Builds → Connect**에서 연결한다.

개인 도메인은 Cloudflare에 활성화한 뒤 **Settings → Domains & Routes → Add → Custom Domain**으로 연결한다. 개발 주소, workers.dev 주소, 개인 도메인은 서로 다른 브라우저 저장 공간이다. 자료가 자동으로 이동하거나 기기 간 동기화되지 않는다.

## 배포 경계와 나중에 DB 연결할 때

- `build/cloudflare-local.ts`는 Vite에서 `src/app/api/cloud/**/route.ts` 모듈을 의존성 없는 503 응답으로 대체한다. 이 경로의 sharp와 Supabase 서버 코드가 Workers 번들로 들어가지 않는다.
- 원본 서버 API와 이미지 손상 검증 코드는 보존된다. 기존 Next.js 실행 경로는 이 Vite 플러그인을 사용하지 않는다.
- `NEXT_PUBLIC_STORAGE_MODE=supabase`만 설정해 서버 저장을 활성화할 수 없다. Cloudflare 빌드는 이 설정을 오류로 처리한다. DB를 연결할 때는 서버 이미지 검증의 Workers 호환성을 해결한 뒤 배포 경계와 환경변수 설정을 함께 변경해야 한다.
- Vite의 Worker 전용 설정은 vinext의 `typeof window` 최적화를 수정한다. TensorFlow.js가 Web Worker에서 `window` 대신 실제 전역 객체를 선택하게 하며, 메인 화면의 환경 정의는 복사하여 보존한다.
- 로컬 Workers 상태 파일은 `.wrangler/state`에 저장하여 Windows에서 `dist` 재빌드 시 파일 잠금을 피한다. 미리보기 서버는 빌드 전에 종료한다.
- vinext와 Next.js가 `.next/types/routes.d.ts`를 각각 생성하므로 `typecheck`는 `next typegen`을 먼저 실행한다.
- 초기화는 이미 완료되어 있다. `vinext init`을 다시 실행하면 선택했던 KV·Images 설정이 재생성될 수 있다.

공식 안내: [Next.js on Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/), [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/), [vinext](https://github.com/cloudflare/vinext).
