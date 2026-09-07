# 예시 자산

## 벽·바닥 자동 인식 모델

`public/models/deeplab-ade20k/`는 Google의 DeepLabV3 MobileNetV2 ADE20K uint8 모델입니다. 예시 사진을 하드코딩한 마스크가 아니라 사용자가 올린 사진을 실제로 분석합니다. 모델 출처·해시·Apache 2.0 라이선스는 해당 폴더의 `upstream-metadata.json`과 `LICENSE`에 보관했습니다. `public/models/tfjs-wasm/`에는 TensorFlow.js 4.22.0의 WASM 실행 파일과 배포 안내를 포함합니다. 렌더링은 계속 Three.js가 담당하고 TensorFlow.js는 별도 Worker에서 분할 추론에만 사용합니다.

`src/lib/seeds.ts`의 라이트 스톤·웜 샌드·차콜 스톤·클라우드 화이트는 이 프로젝트에서 결정적 의사난수와 색상장으로 제작한 타일 질감입니다. 외부 상품 사진을 복사하지 않았으며 실제 판매 상품이나 실제 제조사 규격을 의미하지 않습니다.

이전 버전에서 자동 생성하던 예시입니다. 현재는 자동 생성을 하지 않고 선택 목록에서도 숨깁니다. 기존 프로젝트에서 참조한 자재 버전과 이미지, 사용자가 만든 개인 복제본은 보존합니다. 회귀 테스트의 자재는 테스트 전용 프로필에서 명시적으로 준비합니다.

자동 테스트의 단색·체크무늬·도형 이미지는 정확한 픽셀 비교를 위해 코드로 생성한 테스트 전용 입력입니다. 완성된 시공 결과나 실제 제품 이미지로 표시하지 않습니다.

## Before 재구성 모형

재구성 전용 변기·세면대·욕조는 이 프로젝트의 Three.js 기본 도형 코드로 직접 제작합니다. 거울·문·창은 Canvas로 직접 그린 평면 이미지이며 설치 벽의 원근으로 투영합니다. 외부 판매 상품 이미지·제조사 모델·로고를 사용하지 않습니다. 생성 이미지는 투명 PNG 자산으로 저장하고, 종류·색·규격과 생성 버전을 프로젝트에 남깁니다.

재구성 모형과 대표색 타일에는 내부 자재 메타데이터를 붙여 일반 상품 목록에서 구분합니다. 빈 기본 공간과 After에 자동으로 배치하지 않으며 실제 상품명이나 가격으로 안내하지 않습니다. 원본 사진에서 분석한 대표색은 재구성용으로 사용하지만 원본 이미지는 별도 참고 자산으로 보존합니다.

분석은 위의 로컬 ADE20K 모델을 사용하며, 이 경로에서 생성형 AI나 외부 이미지 서버를 호출하지 않습니다. 사용법·추정 범위·저장 계약은 [재구성 Before / After 안내](reconstructed-comparison.md)에 설명합니다.

## 욕실 사진

`public/examples/bathroom.png`: 2026-09-06, 내장 imagegen 도구로 이 프로젝트를 위해 제작한 1536×1024의 가상 욕실 BEFORE 사진입니다. 실제 주소·부동산·상품을 나타내지 않습니다. 현재는 홈 사진과 예시 시작 버튼을 제거했고, 이 파일은 자동 인식·합성 회귀 테스트 입력으로만 사용합니다. 생성한 After 이미지는 포함하지 않습니다.

생성 프롬프트:

> Use case: photorealistic-natural. Asset type: original BEFORE photo for a Korean bathroom remodeling simulator demo, landscape 1536x1024. Create a realistic ordinary compact empty apartment bathroom before renovation, photographed from doorway at adult eye height, straight verticals, wide 24mm view but no fisheye. Entire back wall and broad unobstructed floor clearly visible with clean planar perspective boundaries. Small aging off-white square wall tiles and old medium gray floor tiles. A simple white pedestal basin at back left under a rectangular mirror and a modest plain white toilet at back right; broad empty floor foreground. Small high window on right wall. Soft natural diffuse daylight, neutral accurate colors, realistic subtle grime and grout but clean overall. No people, text, watermarks, brand logos, UI, split screen, no After view, no product collage. Exact purpose is a fictional example photo, not an existing real property.

## 빈 기본 공간

새 기본 공간은 `src/lib/room-geometry.ts`와 `src/lib/room-background.ts`에서 입력한 가로·깊이·높이로 Three.js 면과 중립색 배경 PNG를 직접 생성합니다. 외부 사진·상품 이미지를 사용하거나 실행 중 생성형 AI를 호출하지 않습니다. 바닥·벽 3면·천장만 있으며 자재와 제품은 사용자가 등록합니다. 사용법과 저장 방식은 [공간 크기 안내](room-dimensions.md)에 기록합니다.

`public/backgrounds/empty-room.png`는 이전 고정 배경과 홈 예시를 위한 생성 이미지입니다. 새 기본 공간 생성에서는 사용하지 않습니다. 기존 프로젝트를 새 구조로 자동 변환하지 않으며 제작 정보와 원래 프롬프트는 [이전 기본 배경 출처](base-room-asset.md)에 보존합니다.

## 재구성 품질 보정 자산

세면대 하부장, 수납장 패널, 세면볼, 개선한 변기 받침·좌판은 직접 작성한 Three.js 도형입니다. 창·거울의 프레임과 유리 이미지는 사용자가 제공한 원본의 해당 영역에서 만들고 원본 자산을 참조합니다. 이 파생 이미지를 공용 자재나 배포 파일에 자동으로 넣지 않습니다. 품질 진단에 사용한 개인 사진은 저장소의 public 예제로 복사하거나 외부 서버로 전송하지 않았습니다.
