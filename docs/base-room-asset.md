# 이전 고정 기본 공간 배경

현재 **기본 공간으로 시작**은 입력한 치수로 Three.js 배경을 생성합니다. 이 문서는 이전 고정 이미지의 출처를 보존하기 위한 안내입니다. 아래 PNG는 홈 예시 이미지와 이전 프로젝트 호환용으로 남아 있으며, 새 공간 생성에는 사용하지 않습니다. 기존 프로젝트를 자동 변환하거나 삭제하지 않습니다. 새 기능은 [공간 크기 안내](room-dimensions.md)를 참고하세요.

- 파일: `public/backgrounds/empty-room.png` (1536 × 1024 PNG)
- 제작: 2026-09-06, 내장 imagegen 도구. 외부 상품/부동산 사진을 사용하지 않은 생성형 가상 공간.
- 도기·거울·문·창·가구 없이 세 벽과 바닥으로 구성됩니다.
- `src/lib/base-room.ts`는 이전 배경에만 해당하는 수동 지정 마스크와 원근입니다. 이전 구조의 회귀 검증을 위해 유지하며 사용자 사진이나 새 치수 기반 방에 적용하지 않습니다.
- 이 고정 이미지의 치수는 편집을 위한 추정값입니다. 이전 프로젝트에서는 기존 면별 수동 조절 방식을 유지하며 새 공간의 치수 입력 기능을 자동으로 추가하지 않습니다.
- 배경은 앱에 포함되며 실행 시 생성형 AI API나 사용자 업로드가 필요하지 않습니다. 예시 상품은 생성하지 않습니다.

## 생성 프롬프트

Use case: photorealistic-natural. Asset type: empty base room background for a photo-based interior material editor, landscape 1536x1024. Create one realistic clean completely empty small rectangular room, photographed straight-on from the open front at adult eye height with an architectural wide-angle lens, absolutely straight verticals and no fisheye. Show a large back wall, both side walls, a generous floor foreground, and only a narrow plain ceiling strip. Aim for back-wall vertical corners near x=25% and x=75%, back ceiling line near y=12%, back wall/floor junction near y=64%; room fills the whole frame without a border. Three plain matte off-white plaster walls and a smooth pale warm-gray seamless floor, no existing tiles or grout. Soft diffuse daylight from behind the camera with subtle natural darker side walls, gentle contact shading in room corners, neutral colors, quiet bright mood. This is a clean neutral base for users to add their own tile materials and sanitary fixtures, so the room must contain ZERO objects or openings. No toilet, sink, mirror, furniture, bathtub, shower, fixtures, doors, door frames, windows, pipes, taps, outlets, light fixtures, baseboards, trim, decoration, people, text, logos or watermarks. Do not include comparison panels, a mockup UI, thumbnail framing, or any extra props.
