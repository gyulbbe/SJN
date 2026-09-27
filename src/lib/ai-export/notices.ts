import type { FaceChange } from './color';
import {
  FLUX_LARGE_EXTRAS,
  type FluxCheckResult,
  type FluxCheckWall,
  type FluxExtra,
  type FluxExtraKind,
  type FluxExtraPlace,
} from './check-contract';
import type { FluxFace, FluxFixtureKind } from './scene-contract';

/**
 * What a FLUX result's checks mean for the user, as short Korean lines in one order of importance:
 * placed products that moved or vanished, objects nobody placed, a wall whose tile layout changed,
 * then colour. Pure, so the rules are unit-tested; the dialog only lays the lines out.
 */

/** Extra kinds that name the same object as a placed fixture kind. */
const SAME_AS_PLACED: Partial<Record<FluxExtraKind, readonly FluxFixtureKind[]>> = {
  window: ['window'],
  door: ['door'],
  glassPartition: ['glassPartition', 'showerCurtain'],
  wallSection: ['lowPartition'],
  shelf: ['wallShelf'],
  showerHead: ['shower'],
  mirror: ['mirror', 'mirrorCabinet'],
  cabinet: ['vanity', 'wallCabinet', 'mirrorCabinet'],
  bathtub: ['bath'],
  toilet: ['toilet'],
  basin: ['basin', 'vanity'],
};
/**
 * Whether an extra of a placed kind may still be that fixture: on its own wall or a neighbouring
 * one (the model names the wall of an object near a corner loosely: the left-wall shower in a
 * corner view came back "on the back wall"), or anywhere but the ceiling for something standing on
 * the floor. Only the facing wall, the ceiling and the middle of the room are far enough to mean a
 * second one (the user example's shower on the right wall). Without a known face: the fixture.
 */
function nearPlace(face: FluxFace | undefined, place: FluxExtraPlace) {
  if (!face || face === place) return true;
  if (face === 'floor') return place !== 'ceiling';
  if (face === 'back') return place === 'left' || place === 'right' || place === 'floor';
  return place === 'back' || place === 'floor';
}
/** A box touching the left or right edge shows the fixture cut off; "not there" is no evidence. */
const EDGE = 0.005;
const cutOff = (box?: readonly number[]) => !!box && (box[0] <= EDGE || box[2] >= 1 - EDGE);

export type FluxPlacedFixture = { kind: FluxFixtureKind; face?: FluxFace; box?: readonly number[] };
export type FluxCheckReading = {
  /** Placed fixtures (by index) the model did not find where they were. */
  missing: number[];
  /** Placed fixtures not found in place, whose kind the model sees far from where they were. */
  moved: { index: number; to: FluxExtraPlace }[];
  /**
   * What the dialog reports as added: a large, room-changing object (window, door, glass partition,
   * a piece of wall), or a second one of a placed kind far from it; large ones first.
   */
  extras: FluxExtra[];
  /**
   * Small unplaced objects the model named. Kept with the answer, not shown: in the 2026-09-27
   * comparison half of them were wrong (glass reflections as mirrors, a glass bar as a towel bar).
   */
  minor: FluxExtra[];
  /** Walls the model says show a band or panel of another tile layout (not shown, see the dialog). */
  tiles: FluxCheckWall[];
  /** Whether this answer covered added objects at all (an older server's does not). */
  extrasChecked: boolean;
};

export function readFluxCheck(
  result: FluxCheckResult,
  placed: readonly FluxPlacedFixture[],
): FluxCheckReading {
  const missing = new Set(
    result.fixtures.flatMap((entry, i) => (entry.present === 'no' && !cutOff(placed[i]?.box) ? [i] : [])),
  );
  const moved: FluxCheckReading['moved'] = [];
  const extras: FluxExtra[] = [];
  const minor: FluxExtra[] = [];
  const large = (extra: FluxExtra) => FLUX_LARGE_EXTRAS.includes(extra.kind);
  for (const extra of result.extras ?? []) {
    const kinds = SAME_AS_PLACED[extra.kind] ?? [];
    const candidates = placed.flatMap((fixture, index) => (kinds.includes(fixture.kind) ? [index] : []));
    if (!candidates.length) {
      (large(extra) ? extras : minor).push(extra);
      continue;
    }
    // A placed one the model did not find, seen elsewhere: moved. On its own wall or floor it only
    // drifted off its box, and the missing warning stays.
    const gone = candidates.find((i) => missing.has(i) && !moved.some((m) => m.index === i));
    if (gone !== undefined) {
      if (placed[gone].face !== extra.place) moved.push({ index: gone, to: extra.place });
      continue;
    }
    // The fixture itself (a part of it, or drawn a little off its box), or a second one far away.
    if (!candidates.some((i) => nearPlace(placed[i].face, extra.place))) extras.push(extra);
  }
  return {
    missing: [...missing].filter((i) => !moved.some((m) => m.index === i)),
    moved,
    extras: [...extras.filter(large), ...extras.filter((extra) => !large(extra))],
    minor,
    tiles: (result.walls ?? []).filter((wall) => wall.uniformTiles === 'no').map((wall) => wall.face),
    extrasChecked: !!result.extras,
  };
}

export const FLUX_EXTRA_LABELS: Record<FluxExtraKind, string> = {
  window: '창문',
  door: '문',
  glassPartition: '유리 칸막이',
  wallSection: '벽 조각',
  shelf: '선반',
  towelBar: '수건걸이',
  paperHolder: '휴지걸이',
  showerHead: '샤워기',
  flushButton: '물 내림 버튼',
  mirror: '거울',
  cabinet: '수납장',
  bathtub: '욕조',
  toilet: '변기',
  basin: '세면대',
  other: '다른 물건',
};
export const FLUX_PLACE_LABELS: Record<FluxExtraPlace, string> = {
  left: '왼쪽 벽',
  back: '뒷벽',
  right: '오른쪽 벽',
  floor: '바닥',
  ceiling: '천장',
  middle: '가운데',
};
const FACE_LABELS: Record<FluxFace, string> = {
  left: '왼쪽 벽',
  back: '뒷벽',
  right: '오른쪽 벽',
  floor: '바닥',
};

/** True when a Korean word ends in a final consonant (받침). */
function hasFinal(word: string) {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  return code >= 0 && code < 11172 && code % 28 !== 0;
}
/** 이/가 after a word. */
export const subject = (word: string) => word + (hasFinal(word) ? '이' : '가');
/** (으)로 after a word: 로 after a vowel or ㄹ. */
const toward = (word: string) => {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  return word + (hasFinal(word) && code % 28 !== 8 ? '으로' : '로');
};

const SHIFT_WORDS: Record<FaceChange['shift'], string> = {
  warmer: '따뜻하게(노랗게)',
  cooler: '차갑게(푸르게)',
  'more-saturated': '진하게',
  'less-saturated': '옅게',
  hue: '다른 색으로',
};
/** One phrase per surface kind: the face that changed most. */
export function colorChangeLines(warnings: FaceChange[]) {
  return (['wall', 'floor'] as const).flatMap((kind) => {
    const worst = warnings.filter((w) => w.kind === kind).sort((a, b) => b.colorDeltaE - a.colorDeltaE)[0];
    return worst
      ? [{ kind, text: `${kind === 'wall' ? '벽' : '바닥'} 타일 색이 원본보다 ${SHIFT_WORDS[worst.shift]}` }]
      : [];
  });
}

export type FluxProductLabel = { id: string; label: string; where: string; face?: FluxFace };
export type FluxNoticeInput = {
  /** The placed products in the check's order (the grounding's order). */
  products: readonly FluxProductLabel[];
  check?:
    | { status: 'checking' }
    | { status: 'done'; reading: FluxCheckReading }
    | { status: 'failed'; message: string };
  colors?: { status: 'corrected'; warnings: FaceChange[] } | { status: 'reframed' } | { status: 'failed' };
  /** Whether the colour-corrected result is on screen (else the model's own colours). */
  corrected: boolean;
  /** Tile-layout answers are shown only when they proved reliable enough. */
  showTiles: boolean;
};
export type FluxNoticeSection = { key: string; title?: string; lines: string[] };
export type FluxNotices = {
  /** Shown together in one alert box, most important first. */
  warnings: FluxNoticeSection[];
  /** Whether the box asks for a new variation (not for colour alone, which is corrected). */
  suggestRetry: boolean;
  /** Quiet lines under the box. */
  infos: { key: string; text: string }[];
};

export function fluxResultNotices(input: FluxNoticeInput): FluxNotices {
  const warnings: FluxNoticeSection[] = [];
  const infos: FluxNotices['infos'] = [];
  const { check, colors, products } = input;
  let retry = false;
  if (check?.status === 'done') {
    const { reading } = check;
    const productLines = [
      ...reading.moved.flatMap(({ index, to }) => {
        const product = products[index];
        if (!product) return [];
        const from = product.face ? FACE_LABELS[product.face] : product.where;
        return [`${subject(product.label)} ${from}에서 ${toward(FLUX_PLACE_LABELS[to])} 옮겨졌을 수 있어요.`];
      }),
      ...reading.missing.flatMap((index) =>
        products[index]
          ? [
              `${subject(products[index].label)} ${products[index].where}에서 보이지 않거나 다른 물건으로 바뀌었을 수 있어요.`,
            ]
          : [],
      ),
    ];
    if (productLines.length)
      warnings.push({ key: 'products', title: '배치한 제품이 바뀌었을 수 있어요', lines: productLines });
    if (reading.extras.length)
      warnings.push({
        key: 'extras',
        lines: [
          `배치하지 않은 물건이 생겼을 수 있어요: ${reading.extras
            .map((extra) => `${FLUX_EXTRA_LABELS[extra.kind]}(${FLUX_PLACE_LABELS[extra.place]})`)
            .join(', ')}`,
        ],
      });
    if (input.showTiles && reading.tiles.length)
      warnings.push({
        key: 'tiles',
        lines: [
          `${reading.tiles.map((face) => FACE_LABELS[face]).join('·')} 타일 배열이 원본과 달라 보여요.`,
        ],
      });
    retry = warnings.length > 0;
    if (!productLines.length)
      infos.push({
        key: 'check',
        text: `AI 제품 확인: 배치한 제품 ${products.length}개가 모두 보여요.${
          reading.extrasChecked && !reading.extras.length ? ' 배치하지 않은 큰 물건도 보이지 않아요.' : ''
        }`,
      });
  }
  if (colors?.status === 'corrected') {
    if (!input.corrected && colors.warnings.length)
      warnings.push({
        key: 'color',
        lines: colorChangeLines(colors.warnings).map((line) => `${line.text} 바뀌었을 수 있어요.`),
      });
    else
      infos.unshift({
        key: 'color',
        text: !input.corrected
          ? 'AI 원본 색이에요. 벽·바닥 색이 원본과 크게 다르지 않아요.'
          : colors.warnings.length
            ? `${colorChangeLines(colors.warnings)
                .map((line) => line.text)
                .join(', ')} 바뀌어 원래 자재 색으로 맞췄어요. 명암·질감과 제품·유리는 AI 결과 그대로예요.`
            : '벽·바닥 색을 원래 자재 색에 맞췄어요. 명암·질감과 제품·유리는 AI 결과 그대로예요.',
      });
  } else if (colors?.status === 'reframed')
    infos.unshift({
      key: 'color',
      text: 'AI가 구도를 바꿔 벽·바닥 색을 원본과 비교하지 못했어요. 자재 색은 원본과 직접 비교해 주세요.',
    });
  if (check?.status === 'failed')
    infos.push({ key: 'check', text: `AI 제품 확인을 하지 못했어요. ${check.message}` });
  return { warnings, suggestRetry: retry, infos };
}
