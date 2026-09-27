import { describe, expect, it } from 'vitest';
import { FLUX_PROMPT } from '../src/lib/ai-export/contract';
import {
  buildFluxPrompt,
  ceilingSentence,
  colorWords,
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
