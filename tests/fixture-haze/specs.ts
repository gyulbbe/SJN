/**
 * The fixture-haze trial's new scenes (docs/fixture-haze-20261116.md, section 4): toilets whose 정면·왼쪽·
 * 오른쪽 photos are real (catalogue LC-3500, LC-500, 카스텔로) and the three basins registered locally
 * with direction photos (register.mjs), seen from the front (0°) and the right (90°) so that both the
 * front and the side photos are drawn: a wall basin hangs on the left wall (as the added-objects
 * trial's `side` scene), the toilet stands at the back. Two scenes are held out until the last check.
 */
import type { SceneSpec, StandardSpec } from '../export-photoreal/scene-builder';

const TILE = {
  white: '630d6290-9ec9-4027-97d7-ce0001ba3c8d', // DWJ 9854, white 600 × 300 matte
  charcoal: '1eb07934-5468-453f-81d9-06b9cfde8eb0', // HE 텍스처 테트라 블랙, 750 × 250 matte
  streaks: '629208cc-1632-4f5e-9109-7d899e4a2e93', // DWJ 9829, grey streaks 600 × 300
  waves: 'fa200ebb-ab87-442c-9346-d685529d4ec4', // DW 9453, grey wave relief 600 × 300
  glossyWhite: '7461b294-fd28-4e0f-8960-846385923a45', // HS 3654, white 600 × 300 glossy
  cream: '1c910e9f-a52a-4947-9184-ba62b0694060', // HE 미티올 크레마, 600 × 200
  stoneFloor: '591b59df-0c9c-473b-bd86-4a78a8d67050', // FOR-GRIGIO, grey stone 600 × 600
  greyFloor: 'c6aa6574-e315-4583-b375-5c1addf6a4bc', // 66517, grey 600 × 600 glossy
};
/** Registered on the local dev server (register.mjs), id prefixes. */
const BASIN = {
  ll821: '9c02991e-', // 시험용 마스 LL-821: semi-pedestal, tapered (wall)
  ll802: '31909f82-', // 시험용 위니 LL-802: semi-pedestal, round (wall)
  z65l: '23109f28-', // 시험용 아델레 Z65L: round column (floor)
};
const TOILET = {
  lc3500: 'cc37e1a1-', // LAUCHE 플로 원피스 LC-3500
  lc500: '30aa65a5-', // LAUCHE 디오 비데일체형 LC-500
  castello: '3181084b-', // 카스텔로 원피스 양변기
};
const ROOM = { widthMm: 2400, depthMm: 2400, heightMm: 2400 };
type Placed = { id: string; prefix: string; face: 'floor' | 'left' | 'right'; u: number; v: number };
const toilet = (prefix: string): Placed => ({
  id: 'photo-toilet',
  prefix,
  face: 'floor' as const,
  u: 0.72,
  v: 0.2,
});
const basin = (prefix: string): Placed =>
  prefix === BASIN.z65l
    ? { id: 'photo-basin', prefix, face: 'floor' as const, u: 0.1, v: 0.5 }
    : { id: 'photo-basin', prefix, face: 'left' as const, u: 0.4, v: 0.62 };

const DRAFTS: { id: string; wall: string; floor: string; products: Placed[]; holdout?: number }[] = [
  {
    id: 'white',
    wall: TILE.white,
    floor: TILE.stoneFloor,
    products: [basin(BASIN.ll821), toilet(TOILET.lc3500)],
  },
  {
    id: 'streaks',
    wall: TILE.streaks,
    floor: TILE.greyFloor,
    products: [basin(BASIN.ll802), toilet(TOILET.lc500)],
  },
  {
    id: 'charcoal',
    wall: TILE.charcoal,
    floor: TILE.stoneFloor,
    products: [basin(BASIN.z65l), toilet(TOILET.castello)],
  },
  {
    id: 'waves',
    wall: TILE.waves,
    floor: TILE.greyFloor,
    products: [basin(BASIN.ll802), toilet(TOILET.lc3500)],
  },
  // Held out: one side each.
  {
    id: 'cream',
    wall: TILE.cream,
    floor: TILE.stoneFloor,
    products: [basin(BASIN.z65l), toilet(TOILET.lc500)],
    holdout: 0,
  },
  {
    id: 'glossy',
    wall: TILE.glossyWhite,
    floor: TILE.greyFloor,
    products: [basin(BASIN.ll821), toilet(TOILET.castello)],
    holdout: 90,
  },
];
export const AZIMUTHS = [0, 90];

/**
 * The fixture-streaks trial's bathtub scenes (docs/fixture-streaks-20261117.md): the added-objects
 * trial's `large` room (standard bathtub on the back wall, toilet, wall basin; that scene is held out
 * there) with other walls, for the development set only (its `large` results stay the last check).
 */
const BATH_ROOM = { widthMm: 3000, depthMm: 2400, heightMm: 2400 };
const BATH_STANDARD: StandardSpec[] = [
  { id: 'bath', kind: 'bath', face: 'floor', u: 0.27, v: 0.17, widthMm: 1500, heightMm: 560, depthMm: 750 },
  {
    id: 'toilet',
    kind: 'toilet',
    face: 'floor',
    u: 0.85,
    v: 0.25,
    widthMm: 400,
    heightMm: 750,
    depthMm: 680,
  },
  {
    id: 'basin',
    kind: 'basin',
    face: 'right',
    u: 0.6,
    v: 0.62,
    widthMm: 520,
    heightMm: 380,
    depthMm: 420,
    baseHeightMm: 780,
    extra: { basinVariant: 'wall' },
  },
];
const BATHS = [
  { id: 'white', wall: TILE.white, floor: TILE.stoneFloor, azimuth: 0 },
  { id: 'charcoal', wall: TILE.charcoal, floor: TILE.stoneFloor, azimuth: 0 },
  { id: 'waves', wall: TILE.waves, floor: TILE.greyFloor, azimuth: 0 },
];
/**
 * The fixture-streaks trial's scenes with registered products only (`reg`, the reviewer's ask 11-17:
 * "자재 등록을 통해서 등록된 각각 좌우정면 방향의 위생도기들로"): four more catalogue toilets and basins
 * whose 정면·왼쪽·오른쪽 photos were checked by eye, at 0° and 90°, and the two LAUCHE bathtubs registered
 * locally (register.mjs louise, marta; 정면 only) with a registered toilet and wall basin, at 0°.
 */
const MORE_TOILET = {
  lc3200: '1a226a9e-', // LAUCHE 포레 원피스 LC-3200
  lc2200: '6e8f9d83-', // LAUCHE 포레 투피스 LC-2200
  lc3100j: 'a857131f-', // LAUCHE 아크 원피스 LC-3100J
  // LC-2100 (d841bc75) was dropped: 58% of its side photos' pixels are half transparent (drawn dark).
  hsc606: 'd41fd984-', // HSC 606J/608J 투피스
};
const MORE_BASIN = {
  z08l: '2841a4db-', // LAUCHE 모레나 Z08L: round column (floor)
  z23l: '79b490cf-', // LAUCHE 모니카 Z23L: square pedestal (floor)
  z01l: '373e7b1e-', // LAUCHE 탑볼스탠드 Z01L: bowl on a stand (floor)
};
const BATH = { louise: '3aec8f7b-', marta: '6c3bb1c5-' };
const floorBasin = (prefix: string): Placed => ({ id: 'photo-basin', prefix, face: 'floor', u: 0.1, v: 0.5 });
const REG: {
  id: string;
  wall: string;
  floor: string;
  products: Placed[];
  azimuths: number[];
  room?: typeof ROOM;
}[] = [
  {
    id: 'white',
    wall: TILE.white,
    floor: TILE.stoneFloor,
    products: [floorBasin(MORE_BASIN.z08l), toilet(MORE_TOILET.lc3200)],
    azimuths: AZIMUTHS,
  },
  {
    id: 'charcoal',
    wall: TILE.charcoal,
    floor: TILE.stoneFloor,
    products: [floorBasin(MORE_BASIN.z23l), toilet(MORE_TOILET.lc2200)],
    azimuths: AZIMUTHS,
  },
  {
    id: 'streaks',
    wall: TILE.streaks,
    floor: TILE.greyFloor,
    products: [floorBasin(MORE_BASIN.z01l), toilet(MORE_TOILET.lc3100j)],
    azimuths: AZIMUTHS,
  },
  {
    id: 'waves',
    wall: TILE.waves,
    floor: TILE.greyFloor,
    products: [basin(BASIN.ll821), toilet(MORE_TOILET.hsc606)],
    azimuths: AZIMUTHS,
  },
  {
    id: 'bath-white',
    wall: TILE.white,
    floor: TILE.stoneFloor,
    room: { widthMm: 3000, depthMm: 2400, heightMm: 2400 },
    products: [
      { id: 'photo-bath', prefix: BATH.louise, face: 'floor', u: 0.27, v: 0.17 },
      { ...toilet(TOILET.lc3500), u: 0.82 },
      { id: 'photo-basin', prefix: BASIN.ll802, face: 'right', u: 0.6, v: 0.62 },
    ],
    azimuths: [0],
  },
  {
    id: 'bath-charcoal',
    wall: TILE.charcoal,
    floor: TILE.stoneFloor,
    room: { widthMm: 3000, depthMm: 2400, heightMm: 2400 },
    products: [
      { id: 'photo-bath', prefix: BATH.marta, face: 'floor', u: 0.27, v: 0.17 },
      { ...toilet(TOILET.lc500), u: 0.82 },
      { id: 'photo-basin', prefix: BASIN.ll821, face: 'right', u: 0.6, v: 0.62 },
    ],
    azimuths: [0],
  },
];
/** Which new scenes: this trial's (`new`), the fixture-streaks trial's standard bathtubs (`bath`) or its registered products (`reg`). */
export type Group = 'new' | 'bath' | 'reg';
export function groupArg(argv: readonly string[]): Group {
  const i = argv.indexOf('--group');
  return i > 0 && (argv[i + 1] === 'bath' || argv[i + 1] === 'reg') ? (argv[i + 1] as Group) : 'new';
}
/** Layer and result id prefix of a group's scenes. */
export const GROUP_PREFIX: Record<Group, string> = { new: 'n', bath: 'b', reg: 'r' };

/** Every scene at each side (`<id>-<azimuth>`); the held-out ones at their one side. */
export function resolveSpecs(materialIds: readonly string[], group: Group = 'new'): SceneSpec[] {
  if (group === 'reg') {
    const one = (prefix: string) => {
      const found = materialIds.filter((id) => id.startsWith(prefix));
      if (found.length !== 1) throw new Error(`product ${prefix}: ${found.length} matches`);
      return found[0];
    };
    return REG.flatMap((d) =>
      d.azimuths.map((azimuth) => ({
        id: `${d.id}-${azimuth}`,
        label: `reg ${d.id} ${azimuth}°`,
        room: d.room ?? ROOM,
        wall: d.wall,
        floor: d.floor,
        products: d.products.map((p) => ({
          id: p.id,
          materialId: one(p.prefix),
          face: p.face,
          u: p.u,
          v: p.v,
        })),
        azimuth,
      })),
    );
  }
  if (group === 'bath')
    return BATHS.map((b) => ({
      id: `${b.id}-${b.azimuth}`,
      label: `bath ${b.id} ${b.azimuth}°`,
      room: BATH_ROOM,
      wall: b.wall,
      floor: b.floor,
      standard: BATH_STANDARD,
      azimuth: b.azimuth,
    }));
  const full = (prefix: string) => {
    const found = materialIds.filter((id) => id.startsWith(prefix));
    if (found.length !== 1) throw new Error(`product ${prefix}: ${found.length} matches`);
    return found[0];
  };
  return DRAFTS.flatMap((d) =>
    (d.holdout === undefined ? AZIMUTHS : [d.holdout]).map((azimuth) => ({
      id: `${d.id}-${azimuth}`,
      label: `${d.id} ${azimuth}°`,
      room: ROOM,
      wall: d.wall,
      floor: d.floor,
      holdout: d.holdout !== undefined,
      products: d.products.map((p) => ({
        id: p.id,
        materialId: full(p.prefix),
        face: p.face,
        u: p.u,
        v: p.v,
      })),
      azimuth,
    })),
  );
}
