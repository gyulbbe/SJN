# 360° 입체화(TripoSR) 제거

2026-10-04에 한 장 사진으로 3D 제품을 만드는 기능(자재 폼의 **AI 360° 입체화**, **360° 각도 편집**, TripoSR 모델, 3D 방의 메시 표시)을 모두 지웠다.

- **이유:** 한 장 사진에서 복원한 형상은 품질이 한계라서(뭉툭하고 점토 같은 모양, 사진에 없는 면은 추측) 쓰지 않기로 했다. 앞으로 제품 이미지는 사용자가 **방향별 사진**을 직접 등록한다.
- **마지막 코드:** 커밋 `0fe8748`(되살릴 때 쓴다). 별도 보관 폴더는 만들지 않았고 git 기록이 보관본이다. 예: `git show 0fe8748:src/lib/product3d/model.ts`, 통째로 되살리려면 이 제거 커밋들을 되돌린다(`git revert`).

## 남긴 것

360°와 이름만 비슷하거나 함께 쓰이던 것은 그대로다.

- 방향별 제품 사진 등록: 촬영 방향(정면·왼쪽·오른쪽·위·아래·뒤), 방향마다 한 장·최대 6장, 사진 교체·이름 변경·삭제(`AngleNameSelect`, `src/lib/product-direction.ts`). 이름이 방에서 제품이 향하는 방향을 정하는 규칙은 평면 사진에도 그대로 쓴다([방 크기](room-dimensions.md)).
- 3D 방(three.js)과 평면 사진 제품(빌보드), 제품 속성의 각도 썸네일로 사진 바꾸기.
- AI 배경 제거(BiRefNet)와 자재 폼의 "AI 배경 제거 테스트"(360° 입체화로 넘기던 버튼만 지움).
- AI 변환(FLUX), 색 보정, 실험 A/B/C, 사진 재구성(reconstruction). 실험 C가 다듬는 대상만 달라졌다(아래).

## 지운 것

- 화면: `product3d-editor.tsx`, `product3d-viewport.tsx`, 자재 폼의 입체화·각도 편집 버튼과 연결, 깊이 칸 아래의 "3D 비율" 안내, 작은 사진(짧은 변 512px 미만) "흐리게 입체화돼요" 안내(`src/lib/image-size-hint.ts`).
- 라이브러리 `src/lib/product3d/` 전체(32개): 모델·캐시·워커·형상 정리·맞춤·사진 색·광택·자동 저장·자세 계산 등. `ai-progress.ts`의 입체화 진행 설정(`PRODUCT3D_LOAD`)도 지웠다.
- 3D 방의 메시 분기(`src/lib/room-viewer/fixtures.ts`): `createSavedProductGeometry`, 광택 재질, 메시 캐시. 바닥에 놓는 입체 제품을 바닥에 붙이던 규칙도 사라졌다.
- 테스트·설정: `tests/`와 `tests/helpers/`의 360° 전용 파일 44개(`product3d-*`, `mixed-metrics.ts`, `silhouette-raster.ts`, `outline-level`·`silhouette-tilt` 단위 테스트 등), `e2e/product3d.spec.ts`, `playwright.product3d.config.ts`, `public/licenses/TripoSR-*.txt`. 모델 설정(HF 모델 `dcharlot65-aurasense/triposr-onnx-web`, 캐시 `sjn-multiview-model-v1`)은 `src/lib/product3d/model*.ts`와 함께 지웠다. `onnxruntime-web`은 배경 제거와 재구성이 쓰므로 남겼다. 사용하지 않게 된 패키지는 없었다.
- 문서: 이 문서 외에 `product3d-editor.md`, `product3d-validation.md`, `front-alignment-validation.md`, `multiview-generation.md`, `multiview-quality-validation.md`, `multiview-validation.md`. 지난 실험 결과 문서(`docs/reconstruction-*`, `docs/flux-*-results-*`)와 `docs/verification.md`의 지난 항목은 당시 기록이라 그대로 두었다(지운 파일의 이름이 나온다).

## 옛 360° 자재는 어떻게 보이나 (읽기 호환)

D1/R2에는 `views[].product3d`(메시 자산·자세 등)가 든 자재 버전과 `kind: 'product-mesh'` 자산이 있을 수 있다. 자재 버전은 불변이고 프로젝트가 참조하며 저장 스키마는 `.strict()`라서, 코드만 지우고 스키마에서 필드를 빼면 기존 자재를 읽다가 실패한다. 그래서 **읽기만** 남겼다.

- 옛 3D 각도의 `assetId`는 저장 당시 자세로 캡처한 1024px 투명 PNG다. 지금은 이 사진을 **평면 사진**으로 보여 준다. 자재 목록·상세·자재 폼, 프로젝트 배치(제품 속성의 각도 썸네일), 3D 방(방향별 사진 평면), AI 변환 입력이 모두 이 사진을 쓴다.
- 메시와 입력 사진 자산은 **참조만 유지하고 열지 않는다.** 메시를 디코딩하는 코드(`codec.ts`)는 지웠다.
- 옛 자재를 다시 저장해도(새 버전) `product3d` 참조는 그대로 따라가고(이미지 자산이 지워지지 않게), 사진을 배경 제거로 바꾸면 그 각도의 참조는 빠진다(기존 동작).
- 새 메시 자산은 만들지 않는다. D1 자산 업로드는 `kind: 'product-mesh'`를 400으로 거절한다("360° 입체 형상은 더 이상 저장하지 않아요").
- 실험 C(제품별 다듬기)의 대상은 **표준 모형**만이다. 옛 360° 자재는 평면 사진이라 "이미 사진"인 제품과 같이 다듬지 않는다(예전에는 저장된 입체 제품의 입력 사진이 AI에 참조로 갔다). 서버 계약의 선택 필드 `reference`는 그대로 두었다.

### 읽기 호환이 남은 곳

| 위치                                                                                                                                      | 하는 일                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/lib/types.ts`                                                                                                                        | `Product3dReference` 타입(옛 필드 모양), `ProductMeshAssetRecord`·`isImageAsset`, `derivation: 'ai-product3d'` |
| `src/lib/storage/validation.ts`                                                                                                           | `product3dReferenceSchema`(`.strict()` 그대로), 자산 메타데이터의 `product-mesh` 종류          |
| `src/lib/d1/materials.ts`                                                                                                                 | 자재 버전을 저장할 때 메시·입력 사진 참조가 올바른지만 확인                                    |
| `src/lib/d1/assets.ts`                                                                                                                    | 메시 읽기(GET)는 그대로, 새 메시 업로드는 거절                                                 |
| `src/lib/repositories/references.ts`                                                                                                      | 자재 버전이 참조하는 메시·입력 사진 자산이 정리 대상이 되지 않게 함                            |
| `src/lib/background-removal/source.ts`                                                                                                    | `ai-product3d` 사진의 출처 문구("옛 360° 편집으로 만든 제품 사진")                              |
| `src/components/materials/material-form.tsx`                                                                                              | 옛 자재를 다시 저장할 때 `product3d`를 그대로 넘김                                             |
| `room-fixtures.ts`·`render/compositor.ts`·`reconstruction/lab.ts`·`editor.tsx`·`inspector.tsx`·`asset-image.tsx` 등의 `'product-mesh'` 검사 | 자산 종류 타입을 좁히는 검사(이미지가 아니면 거절)                                              |

## 데이터 정리 (이번 작업에서 실행하지 않음)

운영 D1과 R2의 옛 360° 데이터는 이번에 건드리지 않았다. 되돌릴 수 없는 일이라 따로 승인을 받고 한다. 방법만 적는다.

1. **조사(읽기만).** 옛 자재와 메시 자산이 얼마나 되는지 센다.
   ```sql
   SELECT COUNT(*) FROM d1_material_versions WHERE payload_json LIKE '%"meshAssetId"%';
   SELECT COUNT(*) FROM d1_assets WHERE metadata_json LIKE '%"kind":"product-mesh"%';
   ```
2. **어느 쪽으로 정리할지 정한다.**
   - **그대로 둔다(권장).** 평면 사진으로 잘 보이고, 메시는 R2에 수 MB씩 남아 있을 뿐이다. 자재 버전은 불변이라 건드리지 않는 편이 안전하다.
   - **새 버전으로 갈아탄다.** 자재를 열어 저장하면 새 버전이 만들어지는데, 이때도 `product3d` 참조는 따라간다. 참조를 빼려면 폼에서 사진을 바꾸거나(배경 제거 등) 데이터를 직접 고쳐야 한다.
   - **지운다(되돌릴 수 없음).** ① 버전의 `payload_json`에서 `views[].product3d`를 빼고, `d1_material_assets`에서 그 버전의 메시·입력 사진 행을 지운다(불변 규칙을 깨므로 승인 필요, 먼저 D1 백업). ② 어떤 버전·프로젝트도 참조하지 않는 `product-mesh` 자산과 입력 사진 자산은 기존 정리 작업(`cleanup`, `GRACE_MS` 뒤)이 `deleting=1`로 표시하고 R2 객체를 지운다. ③ 지우기 전에 위 조사 쿼리의 개수와, 프로젝트가 참조하는 자산이 아닌지(`d1_project_assets`)를 확인한다.
3. **정리 뒤 확인.** 옛 자재를 열어 폼·목록·프로젝트 배치·3D 방이 평면 사진으로 오류 없이 보이는지 본다.

## 지운 테스트와 고친 테스트

- **지운 이유가 있는 것:** `tests/flux-refine-browser.ts`, `tests/flux-product-crops-browser.ts`는 2026-10-03에 기록한 실제 FLUX 결과 12장(저장된 3D 제품의 클로즈업에 대한 답)으로 크롭·합성을 다시 재던 도구라서, 그 크롭을 다시 만들 3D 제품이 없어져 같은 것을 평면 사진이나 표준 모형으로 재현할 수 없다(새 실제 AI 호출 없이는 새 결과도 만들 수 없다). `tests/flux-product-refine-measure.ts`는 기록된 이미지 폴더만 읽으므로 남겼다. 합성·정렬·서버 계약은 `tests/flux-refine.test.ts` 등 단위 테스트가 계속 확인한다.
- **고쳐서 남긴 것(3D 메시 대신 평면 사진·옛 360° 자재 읽기·표준 모형으로):**
  - `tests/room-viewer-fixtures.test.ts`: 메시 테스트를 지우고 옛 360° 각도가 저장된 캡처 평면으로 나오고(메시·입력 사진을 읽지 않음) 방향별로 바뀌는지, 보이는 영역·기준점이 크기를 정하는지, 사진을 못 읽으면 오류로 알리는지, 닫은 뒤 늦은 읽기가 캐시를 살리지 못하는지, 방향 이름×벽에서 사진 평면이 벽에 닿는지를 평면 사진으로 확인한다. 벽걸이 세면대의 오른쪽 각도가 왼쪽 벽에서 방 안쪽을 보는 규칙은 이 파일의 "오른쪽 사진은 왼쪽 벽에 어울린다"와 `tests/product-direction.test.ts`가 계속 확인한다.
  - `tests/product-direction.test.ts`: 이름 목록·옛 이름 읽기·벽 규칙은 그대로, 360° 자세 계산 묶음만 지웠다.
  - `tests/d1-storage.test.ts`: "메시 바이트 검증" 테스트를 "새 메시 거절, 옛 360° 자재 저장·읽기 유지(메시 자산 행을 직접 넣어)"로 바꿨다. `tests/material-images.test.ts`, `tests/helpers/legacy-local-repositories.ts`는 열지 않는 메시 자산(`tests/helpers/legacy-mesh-asset.ts`)으로 같은 보존 규칙을 확인한다.
  - `tests/ai-progress.test.ts`: 여러 파일 모델의 진행률 합산을 제품 모델 대신 같은 모양의 사양으로 확인한다.
  - `e2e/flux-refine.spec.ts`: 표준 모형 변기를 방에 두고(저장된 프로젝트에 표준 모형 설비를 써 넣어) 같은 실험 C 흐름(비용 안내, 진행 표시, 한도 초과, 취소, 요청 수)을 확인한다. 제품 사진 참조(`reference`)는 더 보내지 않아 그 확인만 "보내지 않음"으로 바뀌었다.
  - `e2e/material-images.spec.ts`: 작은 사진 안내 테스트를 "안내 없이 올라가고 여러 장이 모두 추가된다"로 바꿨다. `e2e/model-loading-progress.spec.ts`는 360° 항목만 지웠다.
  - `tests/product-direction-browser.ts`, `tests/room-viewer-real-data-browser.ts`, `tests/room-viewer-resource-browser.ts`: 메시 부분(8종 실제 메시, 저장 메시 배치)을 지우고 평면 사진 부분과 실제 사진 설비 확인을 남겼다.

## 확인한 것

[검증 기록](verification.md)에 결과가 있다. 로컬 DB에 남아 있던 옛 360° 자재(곰 변기·스마트 변기·사각 욕조·벽걸이 세면대의 3D 각도)를 실제로 열어 자재 목록·상세·수정 폼과 프로젝트 배치, 3D 방(정면·옆·위)이 오류 없이 평면 사진으로 보이는지 확인했다.
