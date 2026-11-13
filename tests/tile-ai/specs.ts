/**
 * The tile AI trial's scenes as data (docs/tile-ai-trials-20261113.md): eight for development and two
 * held out until the last round, chosen by tile (size, finish, printed pattern, layout). The room and
 * the products are the same throughout, and there is no ledge or niche. Public tiles of the 2026-11-02
 * snapshot and standard models, built by the export trial's scene builder.
 */
import type { SceneSpec, StandardSpec } from '../export-photoreal/scene-builder';

const TILE = {
  scoredWhite: '7461b294-fd28-4e0f-8960-846385923a45', // HS 3654, glossy white 600 × 300 scored 2 × 5
  patchwork: '9eae17d5-7c80-4f75-80d0-2f19e6bd189a', // HE 미티올 그리스, 600 × 200, printed patchwork
  marble: '3f912baf-70b9-41e2-897b-19fe8b253203', // HE 판다 화이트6 12 LP, polished 600 × 1200
  charcoal: '1eb07934-5468-453f-81d9-06b9cfde8eb0', // HE 텍스처 테트라 블랙, matte 750 × 250
  subway: '708bcdaf-9811-4c07-8c5d-c2ae0af8757a', // HS 글로시 그레이, glossy 300 × 100
  beige: 'fa200ebb-ab87-442c-9346-d685529d4ec4', // DW 9453, matte beige 600 × 300
  large: '77d67741-2a97-4d64-9fc0-f6724dc2750f', // BASALTINA BEIGE 612, 600 × 1200
  white: '2f761ce4-eb52-4eda-9abf-dfac7f855444', // DW 9451, matte white 600 × 300
  accent: '81660434-cffb-4375-b8d2-00dabe4cae24', // HS FM 131, matte charcoal 200 × 200
  romanBrick: '9d4e3ac5-bbca-4a25-96c8-cd2ba51701b6', // ROMAN OLVIE-G, olive brick sheet, glossy
  smallWhite: '13069710-4603-40c1-b9f2-4b9f7ad9a4b8', // DFJ 3394, matte white 200 × 200
  stoneFloor: '591b59df-0c9c-473b-bd86-4a78a8d67050', // FOR-GRIGIO, grey stone 600 × 600
  greyFloor: 'c6aa6574-e315-4583-b375-5c1addf6a4bc', // 66517, glossy grey 600 × 600
  darkFloor: '39f7bfaa-8ec4-4fec-969c-d6d01db2e421', // 300x300 코스모 다크, matte 300 × 300
};
const toilet: StandardSpec = {
  id: 'toilet',
  kind: 'toilet',
  face: 'floor',
  u: 0.72,
  v: 0.28,
  widthMm: 400,
  heightMm: 750,
  depthMm: 680,
};
const basin: StandardSpec = {
  id: 'basin',
  kind: 'basin',
  face: 'left',
  u: 0.4,
  v: 0.62,
  widthMm: 520,
  heightMm: 380,
  depthMm: 420,
  baseHeightMm: 780,
  extra: { basinVariant: 'wall' },
};
const ROOM = { widthMm: 2400, depthMm: 2400, heightMm: 2400 };
export type TileSpec = SceneSpec & {
  /** The wall tile laid in a half-offset (brick) bond instead of the catalogue's grid. */
  wallPattern?: 'brick';
  /** Whether the current method is expected to keep these tiles (criterion 5's control scenes). */
  control?: boolean;
};
const scene = (id: string, label: string, over: Partial<TileSpec> & { wall: string }): TileSpec => ({
  id,
  label,
  room: ROOM,
  floor: TILE.stoneFloor,
  standard: [toilet, basin],
  azimuth: 0,
  ...over,
});

export const TILES = TILE;
export const SPECS: TileSpec[] = [
  scene('scored', '가로로 긴 작은 흰 유광(한 장 안에 2 × 5칸)', { wall: TILE.scoredWhite }),
  scene('patchwork', '회색 무늬 조각 타일', { wall: TILE.patchwork }),
  scene('marble', '큰 유광 대리석 무늬', { wall: TILE.marble, floor: TILE.greyFloor }),
  scene('charcoal', '어두운 무광 750 × 250', { wall: TILE.charcoal, floor: TILE.greyFloor }),
  scene('subway', '엇갈림 배열 300 × 100 유광', { wall: TILE.subway, wallPattern: 'brick' }),
  scene('beige', '300 × 600 무광 격자(대조)', { wall: TILE.beige, control: true }),
  scene('large', '600 × 1,200 큰 타일(대조)', { wall: TILE.large, control: true }),
  scene('accent', '뒷벽 가운데만 다른 타일', {
    wall: TILE.white,
    regions: [
      { face: 'back', materialId: TILE.accent, leftMm: 600, topMm: 0, widthMm: 1200, heightMm: 2400 },
    ],
  }),
  scene('roman', '(마지막) 올리브 벽돌 시트', {
    wall: TILE.romanBrick,
    floor: TILE.greyFloor,
    holdout: true,
  }),
  scene('small', '(마지막) 작은 정사각 + 어두운 바닥', {
    wall: TILE.smallWhite,
    floor: TILE.darkFloor,
    holdout: true,
  }),
];
