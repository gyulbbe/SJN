/**
 * The photo-product trial's new scenes (docs/photo-products-20261115.md): products registered with
 * photos of kinds the export trial's one photo scene (`photos`, LL-801 + LC-2100) does not cover, each
 * with a photo toilet, on white, grey and dark walls. Public tiles and products of the 2026-11-02
 * catalogue snapshot. Two are held out until the last check.
 */
import type { SceneSpec } from '../export-photoreal/scene-builder';

const TILE = {
  white: '630d6290-9ec9-4027-97d7-ce0001ba3c8d', // DWJ 9854, white 600 × 300 matte
  charcoal: '1eb07934-5468-453f-81d9-06b9cfde8eb0', // HE 텍스처 테트라 블랙, 750 × 250 matte
  streaks: '629208cc-1632-4f5e-9109-7d899e4a2e93', // DWJ 9829, grey streaks 600 × 300
  waves: 'fa200ebb-ab87-442c-9346-d685529d4ec4', // DW 9453, grey wave relief 600 × 300
  glossyWhite: '7461b294-fd28-4e0f-8960-846385923a45', // HS 3654, white 600 × 300 glossy
  greige: '9eae17d5-7c80-4f75-80d0-2f19e6bd189a', // HE 미티올 그리스, 600 × 200
  cream: '1c910e9f-a52a-4947-9184-ba62b0694060', // HE 미티올 크레마, 600 × 200
  stoneFloor: '591b59df-0c9c-473b-bd86-4a78a8d67050', // FOR-GRIGIO, grey stone 600 × 600
  greyFloor: 'c6aa6574-e315-4583-b375-5c1addf6a4bc', // 66517, grey 600 × 600 glossy
};
const BASIN = {
  strip: 'b67bb2f1-', // G62L 870 wall-hung: its front photo is a thin slab
  angled: 'd1a0a8bc-', // LL-821 wall-hung: three-quarter photo, the bowl shows
  round: '67286091-', // LL-802 wall-hung: round, the bowl shows
  column: 'bc20c3c9-', // Z65L floor-standing column
  black: '65439941-', // 1035 BK countertop bowl (black), on the wall as the app lets it be placed
  box: '54be51f5-', // LL-803 wall-hung: its front photo is a plain square (as LL-801)
  slab: '40bee968-', // LL-812 wall-hung: its front photo is a thin slab
};
const TOILET = {
  lc3100: 'a857131f-', // LC-3100J one-piece
  lc2200: '6e8f9d83-', // LC-2200 two-piece
  lc500s: '7c61ea3b-', // LC-500S one-piece with bidet
  lc3200: '1a226a9e-', // LC-3200 one-piece
};
const ROOM = { widthMm: 2400, depthMm: 2400, heightMm: 2400 };
type Prefix = string;
const wallBasin = (prefix: Prefix, u = 0.3) => ({
  id: 'photo-basin',
  prefix,
  face: 'back' as const,
  u,
  v: 0.62,
});
const floorBasin = (prefix: Prefix, u = 0.3) => ({
  id: 'photo-basin',
  prefix,
  face: 'floor' as const,
  u,
  v: 0.2,
});
const toilet = (prefix: Prefix, u = 0.72) => ({
  id: 'photo-toilet',
  prefix,
  face: 'floor' as const,
  u,
  v: 0.2,
});

/** Specs with product ids as prefixes; `resolveSpecs` fills the full ids from the snapshot. */
const DRAFTS = [
  {
    id: 'strip',
    wall: TILE.greige,
    floor: TILE.stoneFloor,
    products: [wallBasin(BASIN.strip), toilet(TOILET.lc3100)],
  },
  {
    id: 'angled',
    wall: TILE.streaks,
    floor: TILE.greyFloor,
    products: [wallBasin(BASIN.angled), toilet(TOILET.lc2200)],
  },
  {
    id: 'round',
    wall: TILE.charcoal,
    floor: TILE.stoneFloor,
    products: [wallBasin(BASIN.round), toilet(TOILET.lc500s)],
  },
  {
    id: 'column',
    wall: TILE.glossyWhite,
    floor: TILE.greyFloor,
    products: [floorBasin(BASIN.column), toilet(TOILET.lc3200)],
  },
  {
    id: 'black',
    wall: TILE.cream,
    floor: TILE.stoneFloor,
    products: [wallBasin(BASIN.black), toilet(TOILET.lc3100)],
  },
  {
    id: 'box',
    holdout: true,
    wall: TILE.waves,
    floor: TILE.greyFloor,
    products: [wallBasin(BASIN.box), toilet(TOILET.lc2200)],
  },
  {
    id: 'slab',
    holdout: true,
    wall: TILE.white,
    floor: TILE.stoneFloor,
    products: [wallBasin(BASIN.slab), toilet(TOILET.lc3200)],
  },
];

export function resolveSpecs(materialIds: readonly string[]): SceneSpec[] {
  const full = (prefix: string) => {
    const found = materialIds.filter((id) => id.startsWith(prefix));
    if (found.length !== 1) throw new Error(`product ${prefix}: ${found.length} matches`);
    return found[0];
  };
  return DRAFTS.map((d) => ({
    id: d.id,
    label: d.id,
    room: ROOM,
    wall: d.wall,
    floor: d.floor,
    holdout: d.holdout,
    products: d.products.map((p) => ({ id: p.id, materialId: full(p.prefix), face: p.face, u: p.u, v: p.v })),
    azimuth: 0,
  }));
}
