/**
 * The ledge AI trial's scenes as data (docs/ledge-ai-trials-20261111.md): seven for development and two
 * held out until the last round. Public tiles of the 2026-11-02 snapshot and standard models, built by
 * the export trial's scene builder with the app's own placement functions.
 */
import type { SceneSpec, StandardSpec } from '../export-photoreal/scene-builder';
import type { WallFeatureV1 } from '../../src/lib/wall-features';

const TILE = {
  white: '630d6290-9ec9-4027-97d7-ce0001ba3c8d', // DWJ 9854, white 600 × 300 matte
  charcoal: '1eb07934-5468-453f-81d9-06b9cfde8eb0', // HE 텍스처 테트라 블랙, 750 × 250 matte
  glossyWhite: '7461b294-fd28-4e0f-8960-846385923a45', // HS 3654, white 600 × 300 glossy
  greige: '9eae17d5-7c80-4f75-80d0-2f19e6bd189a', // HE 미티올 그리스, 600 × 200
  brick: '9d4e3ac5-bbca-4a25-96c8-cd2ba51701b6', // ROMAN OLVIE-G, olive brick sheet, glossy
  stoneFloor: '591b59df-0c9c-473b-bd86-4a78a8d67050', // FOR-GRIGIO, grey stone 600 × 600
  greyFloor: 'c6aa6574-e315-4583-b375-5c1addf6a4bc', // 66517, grey 600 × 600 glossy
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
const id = (n: number) => `eeeeeeee-eeee-4eee-8eee-${String(n).padStart(12, '0')}`;
type Ledge = Extract<WallFeatureV1, { kind: 'ledge' }>;
const ledge = (n: number, over: Partial<Ledge>): WallFeatureV1 => ({
  version: 1,
  id: id(n),
  source: 'user',
  kind: 'ledge',
  face: 'back',
  leftMm: 0,
  bottomMm: 0,
  widthMm: 1200,
  heightMm: 1000,
  depthMm: 100,
  ...over,
});
const niche = (n: number, over: Partial<WallFeatureV1>): WallFeatureV1 =>
  ({
    version: 1,
    id: id(n),
    source: 'user',
    kind: 'closed-niche',
    face: 'back',
    leftMm: 300,
    topMm: 900,
    widthMm: 600,
    heightMm: 450,
    depthMm: 150,
    ...over,
  }) as WallFeatureV1;
/** A thin L: 1200 along the back wall from its left corner, 1000 on along the left wall, as one. */
const thinL = (depthMm = 2400): WallFeatureV1[] => [
  ledge(1, {}),
  // The left wall's u runs from the room's front to the back wall; the end meets the back ledge's front.
  ledge(2, { face: 'left', leftMm: depthMm - 100 - 1000, widthMm: 1000 }),
];

export const SPECS: SceneSpec[] = [
  {
    id: 'thin-l',
    label: '얇은 ㄱ자(밝은 무광)',
    room: ROOM,
    wall: TILE.white,
    floor: TILE.stoneFloor,
    features: thinL(),
    standard: [toilet()],
    azimuth: 0,
  },
  {
    id: 'thin-l-dark',
    label: '얇은 ㄱ자(어두운 타일)',
    room: ROOM,
    wall: TILE.charcoal,
    floor: TILE.greyFloor,
    features: thinL(),
    standard: [toilet()],
    azimuth: 0,
  },
  {
    id: 'full-back',
    label: '뒷벽 통 젠다이',
    room: ROOM,
    wall: TILE.white,
    floor: TILE.stoneFloor,
    features: [ledge(1, { widthMm: 2400, depthMm: 200 })],
    standard: [toilet(0.5, 0.26)],
    azimuth: 0,
  },
  {
    id: 'floating',
    label: '떠 있는 젠다이',
    room: ROOM,
    wall: TILE.greige,
    floor: TILE.stoneFloor,
    features: [
      ledge(1, { face: 'left', leftMm: 500, widthMm: 1500, bottomMm: 1000, heightMm: 120, depthMm: 150 }),
    ],
    standard: [basin('back', 0.5), toilet()],
    azimuth: 0,
  },
  {
    id: 'stair',
    label: '계단형(900 + 600)',
    room: ROOM,
    wall: TILE.white,
    floor: TILE.greyFloor,
    features: [
      ledge(1, { leftMm: 300, widthMm: 900, heightMm: 900, depthMm: 200 }),
      ledge(2, { leftMm: 1200, widthMm: 900, heightMm: 600, depthMm: 200 }),
    ],
    standard: [toilet(0.82, 0.3)],
    azimuth: 0,
  },
  {
    // The export trial's scene of 2026-11-04, where the niche came back a window and the ledge a slab.
    id: 'structure',
    label: '지난 벽 구조(홈 + 오른벽 젠다이, 유광)',
    room: ROOM,
    wall: TILE.glossyWhite,
    floor: TILE.stoneFloor,
    features: [niche(1, {}), ledge(2, { face: 'right', widthMm: 2400, depthMm: 200 })],
    standard: [toilet(0.6, 0.28), basin()],
    azimuth: 0,
  },
  {
    id: 'deep',
    label: '깊은 방(1500 × 3600)',
    room: { widthMm: 1500, depthMm: 3600, heightMm: 2400 },
    wall: TILE.white,
    floor: TILE.greyFloor,
    features: [ledge(1, { face: 'left', widthMm: 3600, depthMm: 150 })],
    standard: [toilet(0.6, 0.15)],
    azimuth: 0,
  },
  {
    id: 'brick-l',
    label: '(마지막) 벽돌 ㄱ자, 오른쪽에서',
    holdout: true,
    room: ROOM,
    wall: TILE.brick,
    floor: TILE.greyFloor,
    features: thinL(),
    standard: [toilet(0.7, 0.6)],
    azimuth: 90,
  },
  {
    id: 'busy',
    label: '(마지막) 젠다이 + 홈 + 제품 많음',
    holdout: true,
    room: { widthMm: 3000, depthMm: 2400, heightMm: 2400 },
    wall: TILE.greige,
    floor: TILE.stoneFloor,
    features: [
      ledge(1, { leftMm: 1500, widthMm: 1500, heightMm: 1100, depthMm: 180 }),
      niche(2, { face: 'left', leftMm: 1300, topMm: 1000, widthMm: 500, heightMm: 350, depthMm: 120 }),
    ],
    standard: [toilet(0.78, 0.3), basin('left', 0.3), shower('right', 0.75)],
    azimuth: 0,
  },
];
