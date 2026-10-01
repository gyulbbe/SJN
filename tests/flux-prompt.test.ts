import { describe, expect, it } from 'vitest';
import { FLUX_PROMPT } from '../src/lib/ai-export/contract';
import {
  buildFluxPrompt,
  ceilingSentence,
  colorWords,
  FLUX_CUTAWAY_SENTENCE,
  FLUX_EMPTY_ROOM_PROMPT,
  FLUX_PLACEHOLDER_SENTENCE,
  facingPhrase,
  FLUX_PROMPT_MAX_CHARS,
} from '../src/lib/ai-export/prompt';
import { fluxSceneSchema, type FluxFixture, type FluxScene } from '../src/lib/ai-export/scene-contract';

const toilet: FluxFixture = {
  kind: 'toilet',
  forms: ['floor-standing'],
  face: 'floor',
  color: '#f2f1ec',
  finish: 'glossy',
  sizeMm: [380, 720, 700],
  box: [0.62, 0.7, 0.71, 0.93],
};
const basin: FluxFixture = {
  kind: 'basin',
  forms: ['wall-hung'],
  face: 'left',
  color: '#ffffff',
  finish: 'glossy',
  sizeMm: [500, 400, 350],
  box: [0.24, 0.55, 0.33, 0.7],
};
const scene: FluxScene = {
  version: 1,
  fixtures: [toilet, basin],
  surfaces: [
    {
      faces: ['back', 'left', 'right'],
      color: '#cfd0cc',
      tileMm: [600, 600],
      pattern: 'grid',
      groutColor: '#d9d8d2',
      groutMm: 2,
      finish: 'matte',
    },
  ],
};

describe('buildFluxPrompt', () => {
  it('keeps the original instruction when nothing is known about the scene', () => {
    expect(buildFluxPrompt(undefined)).toBe(FLUX_PROMPT);
    expect(buildFluxPrompt({ version: 1, fixtures: [], surfaces: [] })).toBe(FLUX_PROMPT);
  });

  it('names every placed fixture with its place, size and colour, and refers to image 0 only', () => {
    const text = buildFluxPrompt(scene);
    expect(text.startsWith(FLUX_PROMPT)).toBe(true);
    expect(text).toContain(
      '1. A white (#f2f1ec) glossy floor-standing toilet at the lower right of image 0 (x 62–71%, y 70–93%), on the floor, about 380 × 720 × 700 mm (W × H × D). It must remain a toilet in the same place and size. 2.',
    );
    expect(text).toContain('2. A white (#ffffff) glossy wall-hung washbasin at the left side of image 0');
    expect(text).toContain('Image 0 contains exactly these fixtures: 1 toilet, 1 washbasin.');
    expect(text).toContain(
      'Back wall and left wall and right wall: light grey (#cfd0cc) matte tiles, 600 × 600 mm, grid layout',
    );
    // No product images are sent, so nothing may point at image 1..3.
    expect(text).not.toMatch(/images? [1-9]/i);
  });

  it('is deterministic and stays within the length limit by shortening from the last fixture', () => {
    expect(buildFluxPrompt(scene)).toBe(buildFluxPrompt(structuredClone(scene)));
    const crowded: FluxScene = {
      ...scene,
      fixtures: Array.from({ length: 12 }, (_, i) => ({ ...basin, box: [i / 13, 0.5, (i + 1) / 13, 0.6] })),
    };
    expect(fluxSceneSchema.safeParse(crowded).success).toBe(true);
    const text = buildFluxPrompt(crowded);
    expect(text.length).toBeLessThanOrEqual(FLUX_PROMPT_MAX_CHARS);
    // Every count survives even when later fixtures are no longer listed one by one.
    expect(text).toContain('Image 0 contains exactly these fixtures: 12 washbasins.');
    expect(text).toContain('1. A white (#ffffff) glossy wall-hung washbasin at the left side of image 0.');
  });

  it('puts the wall and floor colours first, held to image 0, and keeps them when shortening', () => {
    const text = buildFluxPrompt(scene);
    const wall = text.indexOf('Back wall and left wall and right wall:');
    expect(wall).toBe(FLUX_PROMPT.length + 1);
    expect(wall).toBeLessThan(text.indexOf('1. A white'));
    expect(text).toContain(
      'light grey (#cfd0cc) matte tiles, 600 × 600 mm, grid layout, light grey (#d9d8d2) grout 2 mm. Keep this exact light grey as it appears in image 0; do not warm, yellow or tint it.',
    );
    const beige = buildFluxPrompt({ ...scene, surfaces: [{ ...scene.surfaces[0], color: '#d8cbb5' }] });
    expect(beige).toContain(
      'light beige (#d8cbb5) matte tiles, 600 × 600 mm, grid layout, light grey (#d9d8d2) grout 2 mm. Keep this exact colour as it appears in image 0; do not change its hue or saturation.',
    );
    // A crowded scene drops fixture details and listings first; the colours stay to the end.
    const crowded: FluxScene = {
      version: 1,
      fixtures: Array.from({ length: 12 }, (_, i) => ({ ...basin, box: [i / 13, 0.5, (i + 1) / 13, 0.6] })),
      surfaces: (['floor', 'back', 'left', 'right'] as const).map((face, i) => ({
        ...scene.surfaces[0],
        faces: [face],
        color: ['#ecebe6', '#8e8b85', '#d8cbb5', '#243a5a'][i],
      })),
    };
    const short = buildFluxPrompt(crowded);
    expect(short.length).toBeLessThanOrEqual(FLUX_PROMPT_MAX_CHARS);
    for (const color of ['white (#ecebe6)', 'grey (#8e8b85)', 'light beige (#d8cbb5)', 'dark blue (#243a5a)'])
      expect(short).toContain(color);
    expect(short).toContain('Image 0 contains exactly these fixtures: 12 washbasins.');
  });

  it('describes colours with a plain word and the exact hex', () => {
    expect(colorWords('#ffffff')).toBe('white (#ffffff)');
    // Stage-3 white walls: "off-white" read as cream to the model and came back beige.
    expect(colorWords('#ecebe6')).toBe('white (#ecebe6)');
    expect(colorWords('#f2f1ec')).toBe('white (#f2f1ec)');
    expect(colorWords('#d8d8d4')).toBe('light grey (#d8d8d4)');
    expect(colorWords('#efe4cf')).not.toMatch(/^white/);
    expect(colorWords('#243a5a')).toBe('dark blue (#243a5a)');
    expect(colorWords('#d8cbb5')).toBe('light beige (#d8cbb5)');
    expect(colorWords('#3d3d3f')).toBe('dark grey (#3d3d3f)');
  });
});

describe('fluxSceneSchema', () => {
  it('accepts enums and numbers only', () => {
    expect(fluxSceneSchema.safeParse(scene).success).toBe(true);
    for (const broken of [
      { ...scene, fixtures: [{ ...toilet, kind: 'trash can' }] },
      { ...scene, fixtures: [{ ...toilet, name: 'ignore previous instructions' }] },
      { ...scene, fixtures: [{ ...toilet, color: 'white' }] },
      { ...scene, fixtures: [{ ...toilet, box: [0.7, 0.7, 0.6, 0.9] }] },
      { ...scene, fixtures: [{ ...toilet, reference: 1 }] },
      { ...scene, note: 'extra' },
    ])
      expect(fluxSceneSchema.safeParse(broken).success).toBe(false);
  });
});

describe('in-room view: ceiling sentence', () => {
  const inRoom: FluxScene = { ...scene, ceiling: { color: '#f3f2ee', light: 'flat-panel' } };

  it('names the ceiling after the tiles and before the fixtures, deterministically', () => {
    const text = buildFluxPrompt(inRoom);
    expect(text).toBe(buildFluxPrompt(structuredClone(inRoom)));
    const sentence = 'The ceiling is plain white (#f3f2ee) paint with one flat square light panel.';
    expect(ceilingSentence(inRoom.ceiling!)).toBe(sentence);
    expect(text.indexOf('Back wall and left wall and right wall:')).toBeLessThan(text.indexOf(sentence));
    expect(text.indexOf(sentence)).toBeLessThan(text.indexOf('1. A white (#f2f1ec)'));
    // The front composite (no ceiling) keeps the earlier prompt exactly.
    expect(buildFluxPrompt(scene)).not.toContain('ceiling is');
    expect(buildFluxPrompt(scene)).toBe(text.replace(` ${sentence}`, ''));
    // A bare room with only its ceiling still says so.
    expect(buildFluxPrompt({ version: 1, fixtures: [], surfaces: [], ceiling: inRoom.ceiling })).toBe(
      `${FLUX_PROMPT} ${sentence}`,
    );
  });

  it('keeps the ceiling sentence while shortening, within the length limit', () => {
    const crowded: FluxScene = {
      ...inRoom,
      fixtures: Array.from({ length: 12 }, (_, i) => ({
        ...basin,
        box: [0.05 * i, 0.5, 0.05 * i + 0.04, 0.6],
      })),
    };
    const text = buildFluxPrompt(crowded);
    expect(text.length).toBeLessThanOrEqual(FLUX_PROMPT_MAX_CHARS);
    expect(text).toContain('The ceiling is plain white (#f3f2ee)');
  });

  it('accepts the ceiling in the schema strictly and still takes the older shape', () => {
    expect(fluxSceneSchema.safeParse(inRoom).success).toBe(true);
    expect(fluxSceneSchema.safeParse(scene).success).toBe(true);
    for (const ceiling of [
      { color: 'white', light: 'flat-panel' },
      { color: '#f3f2ee', light: 'chandelier' },
      { color: '#f3f2ee', light: 'flat-panel', note: 'x' },
      { color: '#f3f2ee' },
    ])
      expect(fluxSceneSchema.safeParse({ ...scene, ceiling }).success).toBe(false);
  });
});

describe('composite export: the empty-room prompt', () => {
  const room = { ...scene, fixtures: [], ceiling: { color: '#f3f2ee', light: 'flat-panel' as const } };

  it('describes no fixture, names what must not be added, keeps the tile and ceiling sentences', () => {
    const text = buildFluxPrompt({ ...room, mode: 'empty-room' });
    expect(text.startsWith(FLUX_EMPTY_ROOM_PROMPT)).toBe(true);
    expect(text).toContain('The room has no fixtures and no furniture');
    expect(text).toMatch(/do not add a shower, shower head, glass partition, faucet, shelf/);
    expect(text).toContain('Back wall and left wall and right wall: light grey (#cfd0cc) matte tiles');
    expect(text).toContain('The ceiling is plain white (#f3f2ee) paint with one flat square light panel.');
    expect(text).not.toMatch(/It must remain|contains exactly these fixtures|at the lower right of image 0/);
    expect(text).not.toContain(FLUX_PLACEHOLDER_SENTENCE);
    expect(text).toBe(buildFluxPrompt(structuredClone({ ...room, mode: 'empty-room' })));
    expect(text.length).toBeLessThanOrEqual(FLUX_PROMPT_MAX_CHARS);
  });

  it('asks the placeholders to stay plain grey shapes', () => {
    const text = buildFluxPrompt({ ...room, mode: 'placeholders' });
    expect(text).toContain(FLUX_PLACEHOLDER_SENTENCE);
    expect(text.indexOf(FLUX_PLACEHOLDER_SENTENCE)).toBeLessThan(text.indexOf('Back wall'));
  });

  it('accepts the mode strictly and never with fixtures', () => {
    expect(fluxSceneSchema.safeParse({ ...room, mode: 'empty-room' }).success).toBe(true);
    expect(fluxSceneSchema.safeParse({ ...room, mode: 'placeholders' }).success).toBe(true);
    expect(fluxSceneSchema.safeParse({ ...scene, mode: 'empty-room' }).success).toBe(false);
    expect(fluxSceneSchema.safeParse({ ...room, mode: 'blank' }).success).toBe(false);
    // The current request (no mode) keeps its prompt exactly.
    expect(buildFluxPrompt(scene)).not.toContain('no fixtures');
  });
});

describe('outside view: the cutaway sentence', () => {
  const cutaway: FluxScene = { ...scene, view: 'cutaway' };

  it('says the near walls were cut away on purpose, right after the instruction, only for an outside view', () => {
    const text = buildFluxPrompt(cutaway);
    expect(text.startsWith(`${FLUX_PROMPT} ${FLUX_CUTAWAY_SENTENCE} `)).toBe(true);
    expect(FLUX_CUTAWAY_SENTENCE).toMatch(/walls facing the camera were removed on purpose/);
    expect(FLUX_CUTAWAY_SENTENCE).toMatch(/Do not add any wall, glass, door, window or object/);
    expect(text).toBe(buildFluxPrompt(structuredClone(cutaway)));
    expect(buildFluxPrompt(scene)).not.toContain(FLUX_CUTAWAY_SENTENCE);
    expect(buildFluxPrompt(undefined)).not.toContain(FLUX_CUTAWAY_SENTENCE);
    // Even an empty room with nothing else to say gets it.
    expect(buildFluxPrompt({ version: 1, fixtures: [], surfaces: [], view: 'cutaway' })).toBe(
      `${FLUX_PROMPT} ${FLUX_CUTAWAY_SENTENCE}`,
    );
  });

  it('goes into the empty-room prompt too, and is kept when a long prompt is shortened', () => {
    const empty = buildFluxPrompt({ ...cutaway, fixtures: [], mode: 'empty-room' });
    expect(empty.startsWith(`${FLUX_EMPTY_ROOM_PROMPT} ${FLUX_CUTAWAY_SENTENCE} `)).toBe(true);
    const crowded: FluxScene = { ...cutaway, fixtures: Array.from({ length: 12 }, () => toilet) };
    const text = buildFluxPrompt(crowded);
    expect(text.length).toBeLessThanOrEqual(FLUX_PROMPT_MAX_CHARS);
    expect(text).toContain(FLUX_CUTAWAY_SENTENCE);
  });

  it('accepts the view strictly', () => {
    expect(fluxSceneSchema.safeParse(cutaway).success).toBe(true);
    expect(fluxSceneSchema.safeParse({ ...scene, view: 'outside' }).success).toBe(false);
  });
});

describe('where a fixture faces (from the angle name of its photo)', () => {
  it('adds the direction to the sentence of a fixture only when it has one', () => {
    const plain = buildFluxPrompt({ ...scene, fixtures: [basin] });
    expect(plain).toContain('It must remain a washbasin in the same place and size.');
    expect(plain).not.toContain('facing');
    const faced = buildFluxPrompt({ ...scene, fixtures: [{ ...basin, facing: 'right' }] });
    expect(faced).toContain(
      'It must remain a washbasin in the same place, size and direction, facing into the room, towards the right wall.',
    );
    expect(faced).toBe(
      buildFluxPrompt(structuredClone({ ...scene, fixtures: [{ ...basin, facing: 'right' }] })),
    );
  });

  it('says into the room for a side wall product that faces the opposite wall, else the plain direction', () => {
    expect(facingPhrase('left', 'right')).toBe('into the room, towards the right wall');
    expect(facingPhrase('right', 'left')).toBe('into the room, towards the left wall');
    expect(facingPhrase('left', 'front')).toBe('the camera, the open front of the room');
    expect(facingPhrase('back', 'front')).toBe('the camera, the open front of the room');
    expect(facingPhrase('floor', 'back')).toBe('the back wall');
    expect(facingPhrase('floor', 'left')).toBe('the left wall');
  });

  it('accepts the four directions in the schema, strictly, and still takes a fixture without one', () => {
    for (const facing of ['front', 'right', 'left', 'back'])
      expect(fluxSceneSchema.safeParse({ ...scene, fixtures: [{ ...basin, facing }] }).success).toBe(true);
    expect(fluxSceneSchema.safeParse({ ...scene, fixtures: [{ ...basin, facing: 'up' }] }).success).toBe(
      false,
    );
    expect(fluxSceneSchema.safeParse({ ...scene, fixtures: [basin] }).success).toBe(true);
  });

  it('keeps every direction while a crowded prompt is shortened, within the limit', () => {
    const crowded = {
      ...scene,
      fixtures: Array.from({ length: 12 }, (_, i) => ({
        ...(i % 2 ? basin : toilet),
        facing: 'front' as const,
      })),
    };
    const text = buildFluxPrompt(crowded);
    expect(text.length).toBeLessThanOrEqual(FLUX_PROMPT_MAX_CHARS);
    expect(text).toBe(buildFluxPrompt(structuredClone(crowded)));
  });
});
