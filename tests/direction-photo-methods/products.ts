/**
 * The products of the direction-photo methods trial (docs/direction-photo-methods-results-20261105.md):
 * the 14 basins the user gave (photos in test-results/direction-photo-methods/user-photos/basin, sizes
 * from the closest item of the 2026-11-02 catalogue snapshot: the basins have left the public
 * catalogue since), the public toilets with real side photos, and the earlier trials' bath.
 *
 * `set` splits development from the final check: a `holdout` product is read only by the final round.
 * `b0` is the app's closest guide form; `b2` the trial-only shape (shapes.ts) when none fits.
 */
import type { DirectionPhotoSpec, DirectionPhotoView } from '../../src/lib/direction-photo/contract';

export type Category = 'basin' | 'toilet' | 'bath';
export type B2Shape =
  | 'vessel-rect'
  | 'vessel-soft'
  | 'counter-shelf-right'
  | 'counter-shelf-left'
  | 'column-rect'
  | 'column-round'
  | 'stand-bowl'
  | 'semi-round'
  | 'semi-taper'
  | 'cube';
export type Product = {
  id: string;
  category: Category;
  /** What the product is, for the record (the catalogue item it was matched to, or the earlier trial's). */
  name: string;
  /** How sure the match to the catalogue item is (its size is that item's). */
  match?: 'sure' | 'likely' | 'guess';
  set: 'dev' | 'holdout';
  /** The app's spec without the direction, with the closest form the app has. */
  spec: Omit<DirectionPhotoSpec, 'direction'>;
  b2?: B2Shape;
  /** The input photos (paths from the main checkout's test-results), the first the main one. */
  photos: string[];
  /** The photos need the screen's background removal (a backdrop, or not pure white). */
  cutout: boolean;
  /** The directions the app makes for it (planDirections; right only when not mirrored). */
  views: DirectionPhotoView[];
  /** The side the input photo shows besides the front (the "near" side), if any. */
  near?: 'left' | 'right';
  /** Real photos of the product from a direction (the catalogue's), for scoring only: never sent. */
  answers?: Partial<Record<DirectionPhotoView, { asset: string; mirrored?: boolean }>>;
  note?: string;
};

const basin = (
  id: string,
  name: string,
  match: Product['match'],
  set: Product['set'],
  form: 'wall-round' | 'wall-rectangular' | 'pedestal-round' | 'pedestal-rectangular',
  sizeMm: [number, number, number],
  b2: B2Shape,
  floor: boolean,
  symmetric: boolean,
  file = `${id}.jpg`,
  note?: string,
): Product => ({
  id,
  category: 'basin',
  name,
  match,
  set,
  spec: { category: 'basin', form, installation: floor ? 'floor' : 'wall', sizeMm },
  b2,
  photos: [`direction-photo-methods/user-photos/basin/${file}`],
  cutout: file.endsWith('.png'),
  views: ['front', 'left', ...(symmetric ? [] : (['right'] as const)), ...(floor ? (['back'] as const) : [])],
  // The user's photos show the front and the side on the picture's right: the product's left.
  near: 'left',
  ...(note ? { note } : {}),
});

export const PRODUCTS: Product[] = [
  // ---------- basins (the user's 14 photos, 320 px, front and left side seen from above) ----------
  basin(
    'b01',
    'LAUCHE 새니 유광 LL-812 (수건걸이 벽걸이)',
    'likely',
    'dev',
    'wall-rectangular',
    [500, 150, 400],
    'vessel-rect',
    false,
    true,
  ),
  basin(
    'b02',
    'LAUCHE 그레타 2350 WH (탑볼 사각, 수전 구멍)',
    'likely',
    'dev',
    'wall-rectangular',
    [500, 130, 420],
    'vessel-rect',
    false,
    true,
  ),
  basin(
    'b03',
    'LAUCHE 그레타 2342 BK (탑볼 사각, 검정)',
    'likely',
    'dev',
    'wall-rectangular',
    [420, 130, 420],
    'vessel-rect',
    false,
    true,
  ),
  basin(
    'b04',
    'LAUCHE 그레타 2360 WH (탑볼 사각, 넓음)',
    'likely',
    'holdout',
    'wall-rectangular',
    [600, 130, 420],
    'vessel-rect',
    false,
    true,
  ),
  basin(
    'b05',
    'LAUCHE 라일라 G10L (탑볼 경사 슬랩)',
    'guess',
    'dev',
    'wall-rectangular',
    [800, 150, 450],
    'vessel-rect',
    false,
    true,
  ),
  basin(
    'b06',
    'LAUCHE 뉴바네스 G63L (L) (상판형, 오른쪽 선반)',
    'guess',
    'dev',
    'wall-rectangular',
    [1200, 200, 460],
    'counter-shelf-right',
    false,
    false,
  ),
  basin(
    'b07',
    'LAUCHE 뉴바네스 G63L (R) (상판형, 왼쪽 선반)',
    'guess',
    'dev',
    'wall-rectangular',
    [1200, 200, 460],
    'counter-shelf-left',
    false,
    false,
  ),
  basin(
    'b08',
    'LAUCHE 오클리 2150 WH (탑볼 둥근 모서리)',
    'likely',
    'dev',
    'wall-rectangular',
    [500, 135, 400],
    'vessel-soft',
    false,
    true,
  ),
  basin(
    'b09',
    'LAUCHE 샤나 Z26L (바닥 사각 기둥)',
    'likely',
    'holdout',
    'pedestal-rectangular',
    [500, 850, 360],
    'column-rect',
    true,
    true,
  ),
  basin(
    'b10',
    'LAUCHE 모레나 Z08L (바닥 원통)',
    'likely',
    'dev',
    'pedestal-round',
    [500, 850, 500],
    'column-round',
    true,
    true,
  ),
  basin(
    'b11',
    'LAUCHE 탑볼스탠드 Z01L (바닥 ㄱ자 스탠드 + 탑볼)',
    'sure',
    'dev',
    'pedestal-round',
    [400, 680, 400],
    'stand-bowl',
    true,
    false,
  ),
  basin(
    'b12',
    'LAUCHE 루나 LL-822 (반다리 둥근형)',
    'sure',
    'dev',
    'wall-round',
    [415, 375, 400],
    'semi-round',
    false,
    true,
  ),
  basin(
    'b13',
    'LAUCHE 마스 LL-821 (반다리 사다리꼴)',
    'sure',
    'holdout',
    'wall-rectangular',
    [485, 390, 425],
    'semi-taper',
    false,
    true,
  ),
  basin(
    'b14',
    'LAUCHE 큐브 LL-823 (큐브, 회색 벽 배경)',
    'sure',
    'dev',
    'wall-rectangular',
    [400, 415, 420],
    'cube',
    false,
    true,
    'b14.png',
  ),

  // ---------- toilets (public catalogue; sizes as width × height × depth, swapped ones put right) ----------
  {
    id: 't-dio-bidet',
    category: 'toilet',
    name: 'LAUCHE 디오 비데일체형 LC-500/LC-500S',
    set: 'dev',
    spec: {
      category: 'toilet',
      form: 'tankless',
      lid: 'closed',
      installation: 'floor',
      sizeMm: [395, 517, 666],
      photoAngles: ['front'],
    },
    photos: ['catalog:front'],
    cutout: true,
    views: ['front', 'left', 'right'],
    note: '카탈로그 크기 666×517×395는 깊이와 폭이 바뀌어 있어 395×517×666으로 씀',
  },
  {
    id: 't-ark-1p',
    category: 'toilet',
    name: 'LAUCHE 아크 원피스 LC-3100J',
    set: 'dev',
    spec: {
      category: 'toilet',
      form: 'one-piece',
      lid: 'closed',
      installation: 'floor',
      sizeMm: [395, 580, 690],
      photoAngles: ['front-right'],
    },
    photos: ['catalog:cover', 'catalog:front'],
    cutout: true,
    views: ['front', 'left', 'right'],
    near: 'right',
  },
  {
    id: 't-ark-2p',
    category: 'toilet',
    name: 'LAUCHE 아크 투피스 LC-2100',
    set: 'dev',
    spec: {
      category: 'toilet',
      form: 'two-piece',
      lid: 'closed',
      installation: 'floor',
      sizeMm: [395, 700, 690],
      skirt: 'skirted',
    },
    photos: ['catalog:cover', 'catalog:front'],
    cutout: true,
    views: ['front', 'left', 'right'],
    near: 'right',
  },
  {
    id: 't-fore-1p',
    category: 'toilet',
    name: 'LAUCHE 포레 원피스 LC-3200',
    set: 'dev',
    spec: {
      category: 'toilet',
      form: 'one-piece',
      lid: 'closed',
      installation: 'floor',
      sizeMm: [395, 580, 690],
      photoAngles: ['front-right'],
    },
    photos: ['catalog:cover', 'catalog:front'],
    cutout: true,
    views: ['front', 'left', 'right'],
    near: 'right',
  },
  {
    id: 't-castello',
    category: 'toilet',
    name: '카스텔로 원피스 양변기 CCAS2025-111A410K0',
    set: 'dev',
    spec: {
      category: 'toilet',
      form: 'one-piece',
      lid: 'closed',
      installation: 'floor',
      sizeMm: [360, 780, 710],
      photoAngles: ['front'],
    },
    photos: ['catalog:front'],
    cutout: true,
    views: ['front', 'left', 'right'],
    note: '카탈로그 크기 710×780×360을 360×780×710으로 씀',
  },
  {
    id: 't-fore-2p',
    category: 'toilet',
    name: 'LAUCHE 포레 투피스 LC-2200',
    set: 'holdout',
    spec: {
      category: 'toilet',
      form: 'two-piece',
      lid: 'closed',
      installation: 'floor',
      sizeMm: [395, 670, 690],
      skirt: 'skirted',
    },
    photos: ['catalog:cover', 'catalog:front'],
    cutout: true,
    views: ['front', 'left', 'right'],
    near: 'right',
  },
  {
    id: 't-flo',
    category: 'toilet',
    name: 'LAUCHE 플로 원피스 LC-3500',
    set: 'holdout',
    spec: {
      category: 'toilet',
      form: 'one-piece',
      lid: 'closed',
      installation: 'floor',
      sizeMm: [400, 450, 680],
      photoAngles: ['front'],
    },
    photos: ['catalog:front'],
    cutout: true,
    views: ['front', 'left', 'right'],
    note: '카탈로그 크기 680×450×400을 400×450×680으로 씀',
  },
  // The earlier trials' toilets without catalogue answers: the near side's T4 not seen on Cloudflare.
  {
    id: 'u5',
    category: 'toilet',
    name: '지난 시험 u5 (원피스, 오른쪽 버튼)',
    set: 'dev',
    spec: {
      category: 'toilet',
      form: 'one-piece',
      lid: 'closed',
      installation: 'floor',
      sizeMm: [380, 700, 700],
      photoAngles: ['front-right'],
    },
    photos: ['toilet-side/input/extra/u5.jpg'],
    cutout: true,
    views: ['left', 'right'],
    near: 'right',
  },
  {
    id: 'u9',
    category: 'toilet',
    name: '지난 시험 u9 (투피스, 발 드러남)',
    set: 'dev',
    spec: {
      category: 'toilet',
      form: 'two-piece',
      lid: 'closed',
      installation: 'floor',
      sizeMm: [380, 760, 700],
    },
    photos: ['toilet-side/input/extra/u9.jpg'],
    cutout: true,
    views: ['left', 'right'],
    near: 'right',
  },

  // ---------- bath (the 2026-10-13 bath; no second bath exists, so no final check) ----------
  {
    id: 'bath61',
    category: 'bath',
    name: '2026-10-13 욕조 (61 흰 바탕 사선)',
    set: 'dev',
    spec: { category: 'bath', form: 'oval-freestanding', installation: 'floor', sizeMm: [1700, 560, 750] },
    photos: ['product-representation/real/input/61-bathtub-3q-white.png'],
    cutout: false,
    views: ['front', 'left', 'right', 'back'],
  },
];

export const productById = (id: string) => {
  const product = PRODUCTS.find((p) => p.id === id);
  if (!product) throw new Error(`no product ${id}`);
  return product;
};

/** The products a round may read: the final check alone opens the held-out ones. */
export function productsFor(round: 'dev' | 'holdout', category?: Category): Product[] {
  return PRODUCTS.filter((p) => p.set === round && (!category || p.category === category));
}
