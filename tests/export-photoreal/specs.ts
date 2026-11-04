/**
 * The trial's ten scenes as data: eight for development and two held out until round 6. Public
 * tiles and products of the 2026-11-02 snapshot; standard models where the reconstruction would
 * put them (the 2026-09-27 comparison room's places).
 */
import type { SceneSpec, StandardSpec } from './scene-builder';

const TILE = {
  white: '630d6290-9ec9-4027-97d7-ce0001ba3c8d', // DWJ 9854, white 600 × 300 matte
  charcoal: '1eb07934-5468-453f-81d9-06b9cfde8eb0', // HE 텍스처 테트라 블랙, 750 × 250 matte
  streaks: '629208cc-1632-4f5e-9109-7d899e4a2e93', // DWJ 9829, grey streaks 600 × 300
  mint: '04b9a906-b001-43c1-9f58-edc5efa294dd', // HS 비비드 데코 민트, ribbed 600 × 300
  waves: 'fa200ebb-ab87-442c-9346-d685529d4ec4', // DW 9453, grey wave relief 600 × 300
  glossyWhite: '7461b294-fd28-4e0f-8960-846385923a45', // HS 3654, white 600 × 300 glossy
  vividWhite: '4ed4152e-31bc-46ee-a18e-2a528be9af3c', // HS 비비드 화이트, 600 × 300 matte
  greige: '9eae17d5-7c80-4f75-80d0-2f19e6bd189a', // HE 미티올 그리스, 600 × 200
  cream: '1c910e9f-a52a-4947-9184-ba62b0694060', // HE 미티올 크레마, 600 × 200
  stoneFloor: '591b59df-0c9c-473b-bd86-4a78a8d67050', // FOR-GRIGIO, grey stone 600 × 600
  greyFloor: 'c6aa6574-e315-4583-b375-5c1addf6a4bc', // 66517, grey 600 × 600 glossy
};
const PRODUCT = {
  toilet: 'd841bc75-42b8-49e0-8273-d98a240c0fa8', // LAUCHE 아크 투피스 LC-2100
  basin: '7ed24cb4-14cf-421d-bfcd-81951dc7c620', // LAUCHE 지니 LL-801(무타공)
};
const toilet = (u = 0.78, v = 0.28): StandardSpec => ({
  id: 'toilet',
  kind: 'toilet',
  face: 'floor',
  u,
  v,
  widthMm: 400,
  heightMm: 750,
  depthMm: 680,
});
const basin = (face: 'left' | 'right' | 'back' = 'left', u = 0.35): StandardSpec => ({
  id: 'basin',
  kind: 'basin',
  face,
  u,
  v: 0.62,
  widthMm: 520,
  heightMm: 380,
  depthMm: 420,
  baseHeightMm: 780,
  extra: { basinVariant: 'wall' },
});
const shower = (face: 'left' | 'right' = 'left', u = 0.8): StandardSpec => ({
  id: 'shower',
  kind: 'shower',
  face,
  u,
  v: 0.3,
  widthMm: 200,
  heightMm: 1100,
  depthMm: 120,
  baseHeightMm: 900,
  color: '#c8ccd0',
  extra: { showerVariant: 'handheld-rail' },
});
const ROOM = { widthMm: 2400, depthMm: 2400, heightMm: 2400 };
const id = (n: number) => `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, '0')}`;
export const SPECS: SceneSpec[] = [
  {
    id: 'white',
    label: '흰 타일',
    room: ROOM,
    wall: TILE.white,
    floor: TILE.stoneFloor,
    standard: [toilet(), basin(), shower()],
    azimuth: 0,
  },
  {
    id: 'charcoal',
    label: '숯색 타일',
    room: ROOM,
    wall: TILE.charcoal,
    floor: TILE.greyFloor,
    standard: [toilet(), basin(), shower()],
    azimuth: 0,
  },
  {
    id: 'pattern',
    label: '무늬 타일',
    room: ROOM,
    wall: TILE.streaks,
    floor: TILE.stoneFloor,
    standard: [toilet(), basin()],
    azimuth: 0,
  },
  {
    id: 'partial',
    label: '부분 타일',
    room: ROOM,
    wall: TILE.white,
    floor: TILE.stoneFloor,
    regions: [{ face: 'back', materialId: TILE.mint, leftMm: 1350, topMm: 0, widthMm: 900, heightMm: 2400 }],
    standard: [toilet(0.25, 0.28), basin()],
    azimuth: 0,
  },
  {
    id: 'structure',
    label: '벽 구조',
    room: ROOM,
    wall: TILE.glossyWhite,
    floor: TILE.stoneFloor,
    features: [
      {
        version: 1,
        id: id(1),
        kind: 'closed-niche',
        face: 'back',
        leftMm: 300,
        topMm: 900,
        widthMm: 600,
        heightMm: 450,
        depthMm: 150,
        source: 'user',
      },
      {
        version: 1,
        id: id(2),
        kind: 'ledge',
        face: 'right',
        leftMm: 0,
        bottomMm: 0,
        heightMm: 1000,
        widthMm: 2400,
        depthMm: 200,
        source: 'user',
      },
    ],
    standard: [toilet(0.6, 0.28), basin()],
    azimuth: 0,
  },
  {
    id: 'smc',
    label: 'SMC 천장',
    room: ROOM,
    wall: TILE.waves,
    floor: TILE.greyFloor,
    ceiling: { kind: 'smc', light: true },
    standard: [toilet(), basin(), shower()],
    azimuth: 0,
  },
  {
    id: 'photos',
    label: '실제 제품 사진',
    room: ROOM,
    wall: TILE.vividWhite,
    floor: TILE.stoneFloor,
    products: [
      { id: 'photo-toilet', materialId: PRODUCT.toilet, face: 'floor', u: 0.72, v: 0.2 },
      { id: 'photo-basin', materialId: PRODUCT.basin, face: 'back', u: 0.3, v: 0.62 },
    ],
    azimuth: 0,
  },
  {
    id: 'narrow',
    label: '좁은 방',
    room: { widthMm: 1200, depthMm: 2400, heightMm: 2400 },
    wall: TILE.white,
    floor: TILE.greyFloor,
    standard: [toilet(0.5, 0.25), basin('left', 0.7)],
    azimuth: 0,
  },
  {
    id: 'large',
    label: '큰 방(욕조·샤워)',
    holdout: true,
    room: { widthMm: 3000, depthMm: 2400, heightMm: 2400 },
    wall: TILE.greige,
    floor: TILE.stoneFloor,
    standard: [
      {
        id: 'bath',
        kind: 'bath',
        face: 'floor',
        u: 0.27,
        v: 0.17,
        widthMm: 1500,
        heightMm: 560,
        depthMm: 750,
      },
      shower('left', 0.25),
      toilet(0.85, 0.25),
      basin('right', 0.6),
    ],
    azimuth: 0,
  },
  {
    id: 'side',
    label: '옆에서 본 장면',
    holdout: true,
    room: ROOM,
    wall: TILE.cream,
    floor: TILE.greyFloor,
    standard: [toilet(), basin()],
    azimuth: 90,
  },
];
