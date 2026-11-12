/**
 * The ledge AI trial's arithmetic and text (docs/ledge-ai-trials-20261111.md), no AI call: what a view's
 * structures are said to be, the sentences written from them, how they fit the app's prompt, what a
 * method sends and when the budget lets a call out.
 */
import { describe, expect, it } from 'vitest';
import { FLUX_PROMPT } from '../src/lib/ai-export/contract';
import { buildFluxPrompt, FLUX_CUTAWAY_SENTENCE, FLUX_PROMPT_MAX_CHARS } from '../src/lib/ai-export/prompt';
import type { FluxScene } from '../src/lib/ai-export/scene-contract';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import { admit, BUDGET, DAILY, isLimit, type LedgerRow } from './ledge-ai/budget';
import { methodLabel, parseMethod, REFERENCE_SENTENCE, withSentences } from './ledge-ai/methods';
import { SPECS } from './ledge-ai/specs';
import {
  describeStructures,
  structureSentence,
  structureSentences,
  type FluxStructure,
  type WallProjector,
} from './ledge-ai/structures';

const room = { ...DEFAULT_ROOM };
const spec = (id: string) => SPECS.find((item) => item.id === id)!;
/** Every wall seen, each at its own place of the picture. */
const all: WallProjector = (face, u, v, outMm) => ({
  x: (face === 'left' ? 0 : face === 'back' ? 0.3 : 0.7) + u * 0.3 + outMm / 10000,
  y: 0.1 + v * 0.8,
});
const without =
  (hidden: string): WallProjector =>
  (face, u, v, outMm) =>
    face === hidden ? null : all(face, u, v, outMm);

describe('the structures a view shows', () => {
  it('names each shape with its runs, depth and height above the floor', () => {
    const shapes = (id: string) =>
      describeStructures(spec(id).room, spec(id).features, all).map((s) =>
        s.kind === 'ledge' ? [s.shape, s.partsMm, s.depthMm, s.bottomMm] : ['niche', s.sizeMm, s.toFloor],
      );
    // The two ledges of an L are one structure: the left wall's run, then the back wall's.
    expect(shapes('thin-l')).toEqual([
      [
        'corner',
        [
          [1000, 1000],
          [1200, 1000],
        ],
        100,
        0,
      ],
    ]);
    expect(shapes('full-back')).toEqual([['straight', [[2400, 1000]], 200, 0]]);
    expect(shapes('floating')).toEqual([['floating', [[1500, 120]], 150, 1000]]);
    expect(shapes('stair')).toEqual([
      [
        'stepped',
        [
          [900, 900],
          [900, 600],
        ],
        200,
        0,
      ],
    ]);
    expect(shapes('structure')).toEqual([
      ['straight', [[2400, 1000]], 200, 0],
      ['niche', [600, 450, 150], false],
    ]);
  });
  it('joins runs of one height, and tells nothing of a hidden wall', () => {
    const feature = (n: number, leftMm: number, widthMm: number) => ({
      ...spec('full-back').features![0],
      id: `eeeeeeee-eeee-4eee-8eee-00000000010${n}`,
      leftMm,
      widthMm,
    });
    const joined = describeStructures(room, [feature(1, 300, 800), feature(2, 1101, 700)], all);
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({ shape: 'straight', partsMm: [[1501, 1000]] });
    // The left wall is hidden: what is left of the L is the back wall's straight run.
    expect(describeStructures(room, spec('thin-l').features, without('left'))).toMatchObject([
      { shape: 'straight', partsMm: [[1200, 1000]] },
    ]);
    expect(describeStructures(room, spec('thin-l').features, without('back'))).toMatchObject([
      { shape: 'straight', partsMm: [[1000, 1000]] },
    ]);
    expect(describeStructures(room, spec('structure').features, without('right'))).toMatchObject([
      { kind: 'niche' },
    ]);
    expect(describeStructures(room, undefined, all)).toEqual([]);
  });
  it('gives the box in the picture, the same for the same scene', () => {
    const [first] = describeStructures(room, spec('full-back').features, all);
    expect(first.box[0]).toBeCloseTo(0.3, 6);
    expect(first.box[2]).toBeCloseTo(0.62, 6);
    expect(first.box[3]).toBeCloseTo(0.9, 6);
    expect(describeStructures(room, spec('thin-l').features, all)).toEqual(
      describeStructures(room, spec('thin-l').features, all),
    );
  });
});

const corner: FluxStructure = {
  kind: 'ledge',
  shape: 'corner',
  partsMm: [
    [1000, 1000],
    [1200, 1000],
  ],
  depthMm: 100,
  bottomMm: 0,
  box: [0.228, 0.559, 0.5, 0.901],
};
const recess: FluxStructure = {
  kind: 'niche',
  sizeMm: [600, 450, 150],
  toFloor: false,
  box: [0.27, 0.37, 0.43, 0.52],
};

describe('the structure sentences', () => {
  it('say what it is, its measures and its place, in each wording', () => {
    expect(structureSentence(corner, 1, 'ledge')).toBe(
      'Built structure 1: a tiled masonry ledge standing 100 mm out from the wall, L-shaped seen from above: 1000 mm along one wall, then round the inside corner 1200 mm along the next, 1000 mm high from the floor, one piece, at x 23–50%, y 56–90% of image 0. Its front and flat top are the same tiles as the wall behind it, with no separate slab on top. Keep its shape, height, depth and edges exactly as in image 0; it is not a bench, shelf, cabinet or countertop.',
    );
    expect(structureSentence(corner, 1, 'step')).toContain('the wall is built out by 100 mm here');
    expect(structureSentence(corner, 1, 'plinth')).toContain('a low tiled false wall 100 mm thick');
    expect(structureSentence(recess, 2, 'ledge')).toBe(
      'Built structure 2: a rectangular niche set 150 mm back into the wall, 600 × 450 mm, at x 27–43%, y 37–52% of image 0, lined with the wall tiles. It is a recess in a solid wall, not a window or a mirror: no glass, no view outside. Keep it exactly as in image 0.',
    );
    const stepped: FluxStructure = {
      ...corner,
      shape: 'stepped',
      partsMm: [
        [900, 900],
        [900, 600],
      ],
      depthMm: 200,
    };
    expect(structureSentence(stepped, 1, 'ledge')).toContain(
      'stepped: 900 mm high for 900 mm, then 600 mm high for 900 mm, one piece',
    );
    const hung: FluxStructure = {
      ...corner,
      shape: 'floating',
      partsMm: [[1500, 120]],
      depthMm: 150,
      bottomMm: 1000,
    };
    expect(structureSentence(hung, 1, 'ledge')).toContain(
      'a band 120 mm tall and 1500 mm long hanging 1000 mm above the floor',
    );
  });
  it('count the structures, and are shorter when compact', () => {
    const text = structureSentences([corner, recess], 'ledge');
    expect(text).toContain(
      'Image 0 has exactly these 2 built structures; add no other ledge, niche or window.',
    );
    expect(structureSentences([corner], 'ledge')).toContain('exactly this one built structure;');
    expect(structureSentences([], 'ledge')).toBe('');
    const compact = structureSentences([corner, recess], 'ledge', true);
    expect(compact.length).toBeLessThan(text.length - 150);
    expect(compact).toContain('a recess, not a window. Keep it exactly.');
    // Only enums and numbers went in: the same facts, the same text.
    expect(structureSentences([corner, recess], 'ledge')).toBe(text);
  });
});

describe('fitting the app prompt', () => {
  const fixture = (n: number) =>
    ({
      kind: 'toilet',
      forms: ['floor-standing'],
      face: 'floor',
      color: '#f4f4f4',
      finish: 'glossy',
      sizeMm: [400, 750, 680],
      box: [0.1 * n, 0.5, 0.1 * n + 0.08, 0.8],
    }) as FluxScene['fixtures'][number];
  const scene = (fixtures: number): FluxScene => ({
    version: 1,
    view: 'cutaway',
    fixtures: Array.from({ length: fixtures }, (_, i) => fixture(i + 1)),
    surfaces: [
      {
        faces: ['back', 'left', 'right'],
        color: '#e9e9e7',
        tileMm: [600, 300],
        pattern: 'grid',
        groutColor: '#ffffff',
        groutMm: 2,
        finish: 'matte',
      },
      {
        faces: ['floor'],
        color: '#8b8f91',
        tileMm: [600, 600],
        pattern: 'grid',
        groutColor: '#8a8a8a',
        groutMm: 2,
        finish: 'matte',
      },
    ],
  });
  it('puts the sentences right after the cutaway sentence and changes nothing else', () => {
    const prompt = buildFluxPrompt(scene(1));
    const added = structureSentences([corner], 'ledge');
    const text = withSentences(prompt, added);
    expect(text.length).toBeLessThanOrEqual(FLUX_PROMPT_MAX_CHARS);
    expect(text).toBe(prompt.replace(FLUX_CUTAWAY_SENTENCE, `${FLUX_CUTAWAY_SENTENCE} ${added}`));
    expect(text.startsWith(`${FLUX_PROMPT} ${FLUX_CUTAWAY_SENTENCE} Built structure 1:`)).toBe(true);
  });
  it('when too long: fixture detail goes first, then the compact sentences, then the last fixtures', () => {
    const prompt = buildFluxPrompt(scene(3));
    const full = structureSentences([corner, recess], 'ledge'),
      compact = structureSentences([corner, recess], 'ledge', true);
    expect(prompt.length + full.length).toBeGreaterThan(FLUX_PROMPT_MAX_CHARS);
    const text = withSentences(prompt, full, compact);
    expect(text.length).toBeLessThanOrEqual(FLUX_PROMPT_MAX_CHARS);
    // The colours, the count summary and every structure stay.
    expect(text).toContain('Image 0 contains exactly these fixtures: 3 toilets.');
    expect(text).toContain('Built structure 2: a rectangular niche');
    expect(text).toContain('Keep this exact');
    expect(text).not.toContain('(W × H × D)');
    // A prompt that nothing can shorten is refused, never cut in the middle.
    expect(() => withSentences(buildFluxPrompt(scene(0)), 'x'.repeat(2400))).toThrow('over 2400');
  });
});

describe('what a method sends', () => {
  it('is its parts', () => {
    expect(parseMethod('cur')).toEqual({ emph: false, elev: false, ref: false });
    expect(parseMethod('w-step+emph+ref')).toEqual({ wording: 'step', emph: true, elev: false, ref: true });
    expect(parseMethod('w-ledge+elev')).toMatchObject({ wording: 'ledge', elev: true });
    expect(methodLabel('cur')).toBe('지금 방식');
    expect(REFERENCE_SENTENCE.length).toBeLessThan(320);
    expect(methodLabel('w-ledge+emph')).toBe('구조 문장(ledge) + 면 강조');
    for (const bad of ['cur+emph', 'emph+elev', 'w-ledge+w-step', 'w-bench', 'emph+emph', ''])
      expect(() => parseMethod(bad), bad).toThrow();
  });
});

describe('the budget', () => {
  const row = (over: Partial<LedgerRow>): LedgerRow => ({
    at: '2026-11-12T10:00:00.000Z',
    account: 'second',
    model: 'flux',
    neurons: 110,
    status: 200,
    ...over,
  });
  it('holds each account to its day and the trial to 90% of 20,000', () => {
    expect([BUDGET, DAILY]).toEqual([20_000, 9_000]);
    const call = { at: '2026-11-12T12:00:00.000Z', account: 'second' as const, cost: 110 };
    expect(admit([], call)).toEqual({ ok: true });
    expect(admit([row({ neurons: 8_890 })], call)).toEqual({ ok: true });
    expect(admit([row({ neurons: 8_891 })], call)).toMatchObject({ ok: false });
    // Another account, or another UTC day, has its own share.
    expect(admit([row({ neurons: 8_950, account: 'third' })], call)).toEqual({ ok: true });
    expect(admit([row({ neurons: 8_950, at: '2026-11-11T23:59:59.000Z' })], call)).toEqual({ ok: true });
    // The whole trial: 18,000 across accounts and days; a failed call counts, a refused one does not.
    const days = [
      row({ neurons: 8_900, at: '2026-11-10T01:00:00.000Z' }),
      row({ neurons: 8_900, account: 'third' }),
    ];
    expect(admit(days, call)).toEqual({ ok: true });
    expect(
      admit(
        [...days, row({ neurons: 100, status: 500, account: 'third', at: '2026-11-09T01:00:00.000Z' })],
        call,
      ),
    ).toMatchObject({ ok: false });
    expect(
      admit(
        [...days, row({ neurons: 100, status: 'refused', account: 'third', at: '2026-11-09T01:00:00.000Z' })],
        call,
      ),
    ).toEqual({ ok: true });
  });
  it('knows a limit when it sees one', () => {
    expect(isLimit(429)).toBe(true);
    expect(isLimit(500, '3036 daily neuron allocation used')).toBe(true);
    expect(isLimit(500, 'internal error')).toBe(false);
  });
});
