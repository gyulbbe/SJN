# 프로젝트 설명

> 확인 기준: 2026-09-16 저장소의 현재 소스. 기능이 구현된 상태와 실제 운영 적용 상태는 별개다. 운영 연결 상태는 [개발 환경](development-environment.md)의 구분을 따른다.

## 목적과 이용자

공간미리(SJN)는 사진 또는 치수로 준비한 공간에 타일·제품을 배치하고 여러 인테리어 시안을 비교하는 한국어 웹 앱이다. 화면은 React/Next.js, 편집 상태는 Zustand, 공간 표현·이미지 출력은 Three.js를 사용한다. Cloudflare 배포는 현재 vinext 빌드 경로를 사용한다.

클라우드 작업 공간에서는 비로그인 사용자가 공개 자재를 열람하고, Google로 로그인한 회원이 본인 프로젝트를 생성·편집한다. 관리자는 공용 자재와 기준 분류를 관리한다. 관리자라도 다른 회원의 프로젝트를 임의 조회하는 권한은 없다. 로컬 개발의 IndexedDB 기능은 운영 인증 정책과 별개다.

| 화면 | 역할 |
| --- | --- |
| `/` | 프로젝트 목록과 기본 공간·사진 기반 시작 |
| `/projects/[id]` | Before/After 편집, 시안 관리·비교, 자재 적용, 내보내기 |
| `/materials` | 공개 자재 목록·상세·검색 |
| `/login` | Google로 시작하기; 첫 로그인 가입과 재로그인 |
| `/admin/materials` | 관리자 자재 등록·버전 수정·비활성화 |
| `/admin/catalog` | 관리자 하위 카테고리·색상·브랜드·재질·마감 관리 |
| `/reconstruction-performance` | Gemma·브라우저 MoGe·전체 재구성의 성능 확인 화면 |

화면 진입점은 [App Router](../../../../src/app/), 접근 규칙은 [DB 문서](database.md)와 [인증·공개 범위 상세](../../../../docs/database-design.md)를 참고한다. 옛 `/reconstruction-lab` 주소는 현재 성능 확인 화면으로 이동한다.

## 주요 작업 흐름

### 공간과 시안

- 기본 공간은 가로·깊이·높이로 빈 방을 만든다. 사진으로 비교 공간을 만드는 경우 참고 사진에서 편집 가능한 Before 초안을 추정하고 같은 카메라의 빈 After에서 새 디자인을 시작한다. 자동 초안은 실측 결과나 실제 상품 형상 복원이 아니다.
- Before 보정과 After 편집을 분리한다. 공간 크기 변경은 공통 공간과 시안에 반영하며, 비교는 동일한 구도를 사용한다.
- 프로젝트마다 시안을 최대 5개 만들고 최대 5개를 비교한다. 공통 Before와 독립적인 After·자재 설정·편집 이력을 유지한다. 시안 생성·복제·전환 자체가 AI 추론을 실행하지 않는다.
- 자재 수량·금액은 현재 시안의 After를 기준으로 계산한다. 기본 공간은 설정 치수, 사진에서 불확실한 시공 면적은 사용자의 입력을 사용한다. 세금·공임·현장 여유분을 자동 가산하지 않는다.

근거: [시안 계약과 한도](../../../../src/lib/comparison.ts), [시안 작업](../../../../src/lib/designs.ts), [자재 집계](../../../../src/lib/material-usage.ts). 상세: [Before/After 안내](../../../../docs/reconstructed-comparison.md), [다중 시안](../../../../docs/designs-verification.md), [자재 수량·금액](../../../../docs/material-usage.md).

### 자재와 이미지

- 타일은 텍스처·규격·줄눈과 시공 패턴을, 제품은 방향 이미지·실제 크기·배치 기준점을 사용한다. 목록 표시는 제품 정면을 우선하고 없으면 첫 사진, 타일은 첫 텍스처를 사용한다.
- 제품 사진은 배경 제거 결과를 비교한 뒤 선택한 사진에 적용할 수 있다. 360° 입체화는 TripoSR로 모형을 만들고 원하는 각도의 이미지를 추가·수정한다. 저장한 입체 데이터를 다시 열 때는 재추론 없이 각도를 편집한다.
- 최종 자재 등록·수정 때 이미지와 선택 값을 확정한다. 자재 버전은 불변이며 과거 프로젝트는 당시 버전을 유지한다.
- 하위 카테고리·속성은 관리자가 등록한 값의 ID로 선택한다. 검색어는 값으로 저장하지 않는다. 브랜드·하위 카테고리는 단일, 색상·재질·마감은 복수 선택이다.
- 사진 분석으로 만든 유사 모형은 프로젝트용 내부 자원이며 공개 카탈로그 상품으로 자동 등록하지 않는다.

근거: [자재 컴포넌트](../../../../src/components/materials/), [분류 계약](../../../../src/lib/catalog/contract.ts). 상세: [이미지 정책](../../../../docs/material-images.md), [배경 제거](../../../../docs/ai-background-removal.md), [360° 편집](../../../../docs/product3d-editor.md). 저장·공개 조건은 [DB](database.md), 파일 경로는 [개발 환경](development-environment.md)에 둔다.

### 내보내기

일반 PNG/JPG 내보내기는 현재 시안이나 Before/After 비교를 렌더링하며 편집 도구를 이미지에 포함하지 않는다. FLUX 비교는 현재 After의 동일 PNG를 기준으로 4B·9B를 사용자가 각각 실행하고 결과를 미리 본 뒤 PNG로 다운로드한다. 결과는 내보내기 창에서 관리하며 프로젝트 장면을 자동 교체하지 않는다. 사진처럼 보여도 실제 현장 촬영본은 아니다.

근거: [AI 내보내기 UI](../../../../src/components/editor/ai-export.tsx), [FLUX 계약](../../../../src/lib/ai-export/contract.ts), [서버 경로](../../../../src/app/api/export/photoreal/route.ts). 상세: [FLUX 비교](../../../../docs/flux-export.md).

## 현재 AI 구성

| 역할 | 현재 모델·실행 위치 | 근거 |
| --- | --- | --- |
| 설비 종류·형태·설치 방식 등 사진 의미 분석 | `@cf/google/gemma-4-26b-a4b-it`, Cloudflare Workers AI | [Gemma 계약](../../../../src/lib/reconstruction/cloud-gemma-contract.ts) |
| 깊이·법선·평면 추정 | MoGe-2 ViT-S Normal ONNX, 사용자 브라우저 Worker; WebGPU 우선·CPU/WASM 대체 | [MoGe 아티팩트](../../../../src/lib/reconstruction/moge-browser/artifact.ts), [실행기](../../../../src/lib/reconstruction/moge-browser/worker.ts) |
| 벽·바닥 영역 분류 | DeepLabV3 MobileNetV2 ADE20K, 브라우저 TensorFlow.js WASM | [분할 추론](../../../../src/lib/segmentation/worker.ts) |
| 제품 배경 제거 | `studioludens/birefnet-lite-512`, 브라우저 ONNX Runtime Web | [모델 설정](../../../../src/lib/background-removal/model.ts) |
| 제품 입체화 | `dcharlot65-aurasense/triposr-onnx-web`, 브라우저 ONNX Runtime Web | [모델 설정](../../../../src/lib/product3d/model.ts) |
| 내보내기 사진화 비교 | `@cf/black-forest-labs/flux-2-klein-4b` 및 `flux-2-klein-9b`, Cloudflare Workers AI | [FLUX 계약](../../../../src/lib/ai-export/contract.ts) |

Gemma·FLUX는 사진을 Cloudflare로 보내며 동일 `AI` 바인딩과 `sjn-gateway`를 사용한다. 브라우저 모델은 사용자의 기기에서 실행하지만 모델·런타임 다운로드는 발생할 수 있다. 기기별 지원·속도·메모리 한계가 있고, 코드에 연결되어 있다는 사실만으로 무료 사용·추론 성공을 보장하지 않는다.

새 분석의 Qwen/Ollama·Python/CUDA MoGe 서버 경로는 종료했다. 과거 결과를 읽는 호환 코드나 수치 대조용 Python 도구를 현재 서비스 실행 경로로 설명하지 않는다. 현재 연결·실행 절차는 [Gemma + 브라우저 MoGe 가이드](../../../../docs/reconstruction-cloud-browser-setup.md)에 둔다.

## 코드 구조와 저장 경계

| 영역 | 주된 위치와 책임 |
| --- | --- |
| 화면·HTTP 경로 | [src/app](../../../../src/app/): 페이지와 서버 API |
| UI·편집 상태 | [components](../../../../src/components/), [editor-store](../../../../src/lib/editor-store.ts): 사용자 조작과 Zustand 상태 |
| 저장 문서 계약 | [types](../../../../src/lib/types.ts), [comparison](../../../../src/lib/comparison.ts): 직렬화 가능한 프로젝트·시안·장면, 이전 문서 정규화 |
| 렌더링 | [render](../../../../src/lib/render/), [room-viewer](../../../../src/lib/room-viewer/): 편집 미리보기·공간 모형·이미지 출력 |
| 사진 재구성 | [reconstruction](../../../../src/lib/reconstruction/): 관측·추정·보정·모형 변환과 분석 공급자 |
| 저장소 | [repositories](../../../../src/lib/repositories/), [storage](../../../../src/lib/storage/), [d1](../../../../src/lib/d1/): 로컬/클라우드 분리, 저장·충돌·복구 |
| 인증·분류 | [auth](../../../../src/lib/auth/), [catalog](../../../../src/lib/catalog/): 회원·관리자 검사와 공개 자재/기준 데이터 |

프로젝트 v3는 공통 공간과 독립 시안을 저장한다. 이미지 Blob을 문서에 복제하지 않고 자산 ID로 참조하며, 원본·파생 자료·편집 이력에 필요한 자산을 보존한다. 로컬 자료는 브라우저 IndexedDB, 클라우드의 메타데이터·권한·참조는 D1, 큰 프로젝트 스냅샷·파일은 비공개 R2에 둔다. 로그인만으로 로컬 자료를 업로드하지 않는다.

기존 문서 정규화와 참조 보존 규칙을 바꿀 때는 [DB 문서](database.md)도 읽는다. 화면·기능·AI 역할·시안 한도·코드 책임이 바뀌면 이 문서를 갱신하고, 연결 주소·모델 호스팅·환경 설정까지 바뀌면 [개발 환경](development-environment.md)도 함께 갱신한다.

