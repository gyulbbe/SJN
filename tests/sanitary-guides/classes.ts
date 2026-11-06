/**
 * Sanitary-ware classes for guide images (2026-11-06): the 200 LAUCHE and CLINS products collected from
 * myhwashin.com (test-results/위생도기-화신-20261106/목록.csv) sorted by the shape a guide must have.
 * Each class has a typical catalogue size (W × H × D in mm, the app's order), a representative product
 * and its members (the site's product_cd). The model is the app's standard model, a direction-photo
 * trial shape, or a shape of tests/sanitary-guides/shapes.ts. No app code uses this.
 */
import type { B2Shape } from '../direction-photo-methods/products';
import type { SanitaryShape } from './shapes';

export type ClassModel =
  | { from: 'app'; form: 'one-piece' | 'two-piece' | 'tankless' | 'oval-freestanding'; skirt?: 'skirted' }
  | { from: 'trial'; shape: B2Shape }
  | { from: 'new'; shape: SanitaryShape };
export type Installation = 'floor' | 'wall' | 'embedded';
export type SanitaryClass = {
  id: string;
  kind: '양변기' | '세면대' | '소변기' | '욕조';
  name: string;
  /** The app's kind for an app model (urinals have none: drawn as basins would be, by a trial shape). */
  category: 'toilet' | 'basin' | 'bath' | 'urinal';
  installation: Installation;
  sizeMm: [number, number, number];
  model: ClassModel;
  /** The representative product (its photo goes beside the guides). */
  rep: number;
  members: number[];
  note?: string;
};

const toilet = (
  id: string,
  name: string,
  sizeMm: SanitaryClass['sizeMm'],
  model: ClassModel,
  rep: number,
  members: number[],
  note?: string,
  installation: Installation = 'floor',
): SanitaryClass => ({
  id,
  kind: '양변기',
  category: 'toilet',
  name,
  installation,
  sizeMm,
  model,
  rep,
  members,
  note,
});
const basin = (
  id: string,
  name: string,
  installation: Installation,
  sizeMm: SanitaryClass['sizeMm'],
  model: ClassModel,
  rep: number,
  members: number[],
  note?: string,
): SanitaryClass => ({
  id,
  kind: '세면대',
  category: 'basin',
  name,
  installation,
  sizeMm,
  model,
  rep,
  members,
  note,
});
const trial = (shape: B2Shape): ClassModel => ({ from: 'trial', shape });
const shaped = (shape: SanitaryShape): ClassModel => ({ from: 'new', shape });

export const CLASSES: SanitaryClass[] = [
  // ---------- 양변기 (sizes: catalogue D × W × H, turned to W × H × D) ----------
  toilet(
    'T1',
    '원피스',
    [395, 580, 690],
    { from: 'app', form: 'one-piece' },
    93341,
    [93341, 90381, 91671, 74641, 51187, 74767],
  ),
  toilet(
    'T2',
    '원피스 낮은 탱크(직수)',
    [400, 450, 680],
    shaped('toilet-low-tank'),
    92511,
    [92511],
    '탱크가 뚜껑 바로 위까지만 옴',
  ),
  toilet(
    'T3',
    '투피스 스커트형',
    [395, 700, 690],
    { from: 'app', form: 'two-piece', skirt: 'skirted' },
    88611,
    [
      88611, 88621, 92481, 92471, 75864, 75857, 54831, 54847, 93241, 93411, 93541, 85993, 71941, 93431, 71954,
      97281, 97271, 65414, 65402, 93391, 74077, 92101, 96021, 92111,
    ],
    '몸통이 매끈한 치마로 덮임. 상·하 품목은 같은 세트',
  ),
  toilet(
    'T4',
    '투피스 트랩 보임',
    [395, 735, 740],
    { from: 'app', form: 'two-piece' },
    40321,
    [
      40321, 40337, 93691, 93221, 60723, 88591, 93421, 88601, 60732, 41511, 93381, 87701, 87711, 81051, 81067,
      41534, 41527, 45421,
    ],
    '받침과 배수 굴곡이 보이는 옛 모양',
  ),
  toilet(
    'T5',
    '비데일체형(탱크 없음)',
    [395, 517, 666],
    { from: 'app', form: 'tankless' },
    92911,
    [92911, 92891],
  ),
  toilet('T6', '유아용 투피스', [360, 650, 640], { from: 'app', form: 'two-piece' }, 53217, [53217, 53201]),
  toilet(
    'T7',
    '탱크 없는 변기(후레쉬밸브)',
    [350, 370, 640],
    shaped('toilet-bowl'),
    78411,
    [78411],
    '벽의 후레쉬밸브는 제품이 아니라 그리지 않음',
  ),
  toilet(
    'T8',
    '화변기',
    [270, 300, 560],
    shaped('squat-pan'),
    75841,
    [75841],
    '바닥에 묻는 제품',
    'embedded',
  ),

  // ---------- 세면대 (catalogue W × D × H) ----------
  basin(
    'B1',
    '탑볼 사각',
    'wall',
    [600, 130, 420],
    trial('vessel-rect'),
    83901,
    [74868, 74878, 74882, 83901, 97021, 84449, 84430, 49937, 49969, 90191, 65138],
  ),
  basin(
    'B2',
    '탑볼 둥근 사각',
    'wall',
    [500, 135, 400],
    trial('vessel-soft'),
    84462,
    [84457, 84462, 78435, 74849, 65077, 65084, 75181],
    '나탈리 2138 BK는 11-06에 B3에 넣었다가 11-07에 옮김(둥근 사각)',
  ),
  basin(
    'B3',
    '탑볼 원형(원통)',
    'wall',
    [360, 120, 360],
    shaped('vessel-round'),
    74830,
    [74824, 74830, 38824],
  ),
  basin(
    'B4',
    '탑볼 그릇형',
    'wall',
    [420, 170, 420],
    shaped('vessel-bowl'),
    38771,
    [38771, 38787, 24301, 24321, 34179],
    '유리볼 포함',
  ),
  basin(
    'B5',
    '탑볼 타원·자유형',
    'wall',
    [660, 155, 430],
    shaped('vessel-oval'),
    65061,
    [49944, 65061, 65090],
  ),
  basin(
    'B6',
    '탑볼 긴 사각(LAR)',
    'wall',
    [800, 150, 450],
    trial('vessel-rect'),
    71794,
    [83482, 71794, 71808, 71789],
  ),
  basin(
    'B7',
    '벽걸이 사각+수건걸이',
    'wall',
    [500, 210, 400],
    shaped('wall-towelbar'),
    91701,
    [91711, 93361, 91701, 93351, 97011, 91731, 91721, 91691, 91681],
    '높이에 수건걸이 60mm 포함',
  ),
  basin('B8', '벽걸이 둥근 대야(LAR)', 'wall', [600, 140, 400], trial('vessel-soft'), 83496, [84289, 83496]),
  basin(
    'B9',
    '벽걸이 선반형(선반 오른쪽)',
    'wall',
    [1200, 200, 460],
    trial('counter-shelf-right'),
    86451,
    [86451, 71822, 82231, 68094],
    '품명의 (L): 대야가 왼쪽',
  ),
  basin(
    'B10',
    '벽걸이 선반형(선반 왼쪽)',
    'wall',
    [1200, 200, 460],
    trial('counter-shelf-left'),
    86463,
    [86463, 79863, 82247, 68105],
    '품명의 (R): 대야가 오른쪽',
  ),
  basin(
    'B11',
    '상판 일체형(선반 없음)',
    'wall',
    [1054, 216, 609],
    shaped('counter-deck-right'),
    71818,
    [71818],
  ),
  basin(
    'B12',
    '벽걸이 아래 수납칸형',
    'wall',
    [600, 280, 400],
    shaped('wall-box-under'),
    85231,
    [85231, 82191],
  ),
  basin(
    'B13',
    '반다리 원형',
    'wall',
    [450, 380, 450],
    trial('semi-round'),
    88101,
    [92381, 88101, 89671, 52277, 74048, 91021, 87038],
  ),
  basin(
    'B14',
    '반다리 사각',
    'wall',
    [450, 400, 415],
    shaped('semi-square'),
    88091,
    [88091, 91301, 89691, 88111, 89681, 75221, 96301, 89751],
  ),
  basin(
    'B15',
    '반다리 사다리꼴',
    'wall',
    [485, 390, 425],
    trial('semi-taper'),
    92401,
    [92401, 97561, 71021, 86102, 87046],
  ),
  basin('B16', '반다리 큐브', 'wall', [400, 415, 420], trial('cube'), 92391, [92391]),
  basin(
    'B17',
    '반다리 넓은 대야+둥근 다리',
    'wall',
    [560, 370, 460],
    shaped('semi-skirt-round'),
    80744,
    [73837, 80744, 87691, 95091, 62137],
  ),
  basin(
    'B18',
    '반다리 넓은 대야+사각 다리',
    'wall',
    [520, 360, 455],
    shaped('semi-skirt-rect'),
    62121,
    [62121, 94991],
    'HSL 602J는 사이트 분류가 없어 사진으로 넣음',
  ),
  basin(
    'B19',
    '긴다리 둥근 대야',
    'floor',
    [580, 800, 465],
    shaped('pedestal-oval'),
    39984,
    [52511, 39984, 82984, 39990, 65797, 65966, 45887, 42071, 42087, 65997, 65981, 55967, 55951],
    '상(대야)·하(다리) 품목은 같은 세트',
  ),
  basin(
    'B20',
    '긴다리 사각 대야',
    'floor',
    [515, 810, 390],
    shaped('pedestal-rect'),
    67936,
    [92781, 92791, 67936, 67948, 40014, 87301, 73287, 96991, 97001, 66517, 66526],
  ),
  basin('B21', '유아용 긴다리', 'floor', [405, 540, 365], shaped('pedestal-oval'), 50121, [50121, 50137]),
  basin('B22', '기둥형 사각', 'floor', [400, 850, 400], trial('column-rect'), 74252, [74252, 68115]),
  basin('B23', '기둥형 원형', 'floor', [450, 850, 450], trial('column-round'), 68121, [77341, 68121]),
  basin('B24', '스탠드+탑볼', 'floor', [400, 680, 400], trial('stand-bowl'), 71834, [71834]),
  basin(
    'B25',
    '언더볼',
    'wall',
    [495, 200, 440],
    shaped('undermount'),
    74011,
    [97571, 74011],
    '상판 아래에 붙는 제품',
  ),
  basin('B26', '수채', 'wall', [565, 620, 450], shaped('utility-sink'), 74751, [74751]),

  // ---------- 소변기 (catalogue W × D × H) ----------
  {
    id: 'U1',
    kind: '소변기',
    category: 'urinal',
    name: '스탠딩',
    installation: 'floor',
    sizeMm: [380, 920, 380],
    model: shaped('urinal-floor'),
    rep: 15102,
    members: [15080, 15102, 15111, 15124, 82748],
  },
  {
    id: 'U2',
    kind: '소변기',
    category: 'urinal',
    name: '스탠딩 센서내장',
    installation: 'floor',
    sizeMm: [365, 1005, 390],
    model: shaped('urinal-floor-sensor'),
    rep: 76137,
    members: [76137],
  },
  {
    id: 'U3',
    kind: '소변기',
    category: 'urinal',
    name: '벽걸이(유아용)',
    installation: 'wall',
    sizeMm: [340, 685, 320],
    model: shaped('urinal-wall'),
    rep: 50144,
    members: [50144],
  },

  // ---------- 욕조 (catalogue L × W × H; all "이동식" on the site) ----------
  {
    id: 'A1',
    kind: '욕조',
    category: 'bath',
    name: '타원형',
    installation: 'floor',
    sizeMm: [1500, 600, 800],
    model: { from: 'app', form: 'oval-freestanding' },
    rep: 68030,
    members: [86943, 68030, 75807, 82955, 86932, 70915, 86952],
  },
  {
    id: 'A2',
    kind: '욕조',
    category: 'bath',
    name: '달걀형(위로 벌어짐)',
    installation: 'floor',
    sizeMm: [1700, 580, 800],
    model: shaped('bath-egg'),
    rep: 68054,
    members: [70902, 68054, 71912, 75791, 68001],
  },
  {
    id: 'A3',
    kind: '욕조',
    category: 'bath',
    name: '사각형',
    installation: 'floor',
    sizeMm: [1500, 600, 800],
    model: shaped('bath-rect'),
    rep: 74238,
    members: [86976, 74238, 79852, 68068, 71927, 79831, 79844],
  },
  {
    id: 'A4',
    kind: '욕조',
    category: 'bath',
    name: '슬리퍼형(한쪽이 높음)',
    installation: 'floor',
    sizeMm: [1300, 700, 700],
    model: shaped('bath-slipper'),
    rep: 68024,
    members: [68024],
  },
  {
    id: 'A5',
    kind: '욕조',
    category: 'bath',
    name: '클로풋(다리 달림)',
    installation: 'floor',
    sizeMm: [1500, 770, 710],
    model: shaped('bath-clawfoot'),
    rep: 71757,
    members: [71757],
  },
];

/** The guide's directions: a floor product's back can be seen; a wall or set-in product's cannot. */
export const directionsOf = (c: SanitaryClass) =>
  c.installation === 'wall'
    ? (['정면', '왼쪽', '오른쪽'] as const)
    : (['정면', '왼쪽', '오른쪽', '뒤'] as const);
