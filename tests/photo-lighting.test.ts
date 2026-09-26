import { describe, expect, it } from 'vitest';
import {
  achromaticSamples,
  createPhotoLighting,
  delightObserved,
  photoLightingMultiplier,
  projectPhotoLight,
  samplePhotoLighting,
  chroma,
  delightColor,
  estimatePhotoLighting,
  hexToLinear,
  lightingMultiplier,
  linearToHex,
  luminance,
  MAX_EV,
  MIN_ACHROMATIC,
  relightColor,
  type Rgb,
} from '../src/lib/reconstruction/photo-lighting';

/** A surface of `albedo` seen under `light` (linear), with a little deterministic variation. */
function seen(albedo: Rgb, light: Rgb, count: number, spread = 0.04): Rgb[] {
  return Array.from({ length: count }, (_, i) => {
    const k = 1 + spread * Math.sin(i * 1.7);
    return albedo.map((a, c) => a * light[c] * k) as Rgb;
  });
}
const warm: Rgb = [1.18, 1, 0.72]; // about 3,500 K
const white: Rgb = [0.8, 0.8, 0.8];
const grey: Rgb = [0.25, 0.25, 0.25];
const beige = hexToLinear('#d8c3a5');

describe('photo lighting estimate', () => {
  it('reads a warm, dim light from white sanitaryware and keeps its luminance in the exposure', () => {
    const light = warm.map((v) => v * 0.6) as Rgb;
    const estimate = estimatePhotoLighting({
      surfaces: seen(grey, light, 800),
      ceramics: seen(white, light, 3, 0),
    });
    expect(estimate.method).toBe('ceramic');
    expect(luminance(estimate.gains)).toBeCloseTo(1, 5);
    expect(estimate.gains[0] / estimate.gains[1]).toBeCloseTo(1.18, 2);
    expect(estimate.gains[2] / estimate.gains[1]).toBeCloseTo(0.72, 2);
    expect(estimate.exposureEv).toBeCloseTo(Math.log2(luminance(warm) * 0.6), 2);
  });

  it('keeps a beige room beige when a white fixture shows neutral light', () => {
    const estimate = estimatePhotoLighting({
      surfaces: seen(beige, [1, 1, 1], 900),
      ceramics: seen(white, [1, 1, 1], 2, 0),
    });
    expect(estimate.gains.map((g) => +g.toFixed(3))).toEqual([1, 1, 1]);
    expect(delightColor('#d8c3a5', estimate)).toBe('#d8c3a5');
    // Grey world, by contrast, reads the beige as a warm light and would bleach the tile.
    const grayWorld = estimatePhotoLighting(
      { surfaces: seen(beige, [1, 1, 1], 900), ceramics: [] },
      'gray-world',
    );
    expect(chroma(hexToLinear(delightColor('#d8c3a5', grayWorld)))).toBeLessThan(chroma(beige) * 0.3);
  });

  it('uses bright achromatic surfaces without sanitaryware, and stays neutral when colour alone is ambiguous', () => {
    // A mild cast on white tiles is recovered from the tiles themselves; brightness is left alone.
    const mild: Rgb = [1.05, 1, 0.95];
    const room = estimatePhotoLighting({
      surfaces: [...seen(white, mild, 600), ...seen(grey, mild, 600)],
      ceramics: [],
    });
    expect(room.method).toBe('achromatic');
    expect(room.exposureEv).toBe(0);
    expect(room.gains[0] / room.gains[2]).toBeCloseTo(1.05 / 0.95, 2);
    // A strong warm cast makes white tiles look beige: without white sanitaryware that cannot be
    // told from a beige room, so both stay neutral rather than bleaching a real beige tile.
    expect(estimatePhotoLighting({ surfaces: seen(white, warm, 900), ceramics: [] }).method).toBe('neutral');
    expect(achromaticSamples(seen(beige, [1, 1, 1], 900))).toHaveLength(0);
    expect(estimatePhotoLighting({ surfaces: seen(beige, [1, 1, 1], 900), ceramics: [] })).toMatchObject({
      method: 'neutral',
      exposureEv: 0,
      gains: [1, 1, 1],
    });
  });

  it('stays neutral without evidence and clamps extreme exposure and tint', () => {
    expect(estimatePhotoLighting({ surfaces: [], ceramics: [] })).toMatchObject({
      method: 'neutral',
      gains: [1, 1, 1],
    });
    expect(
      estimatePhotoLighting({ surfaces: seen(white, [1, 1, 1], MIN_ACHROMATIC - 1, 0), ceramics: [] }).method,
    ).toBe('neutral');
    const dark = estimatePhotoLighting({ surfaces: [], ceramics: [[0.01, 0.01, 0.01]] });
    expect(dark.exposureEv).toBe(-MAX_EV);
    const bright = estimatePhotoLighting({ surfaces: [], ceramics: [[1, 1, 1].map((v) => v * 5) as Rgb] });
    expect(bright.exposureEv).toBe(MAX_EV);
    // A green or magenta cast beyond the blackbody range is not taken at face value.
    const green = estimatePhotoLighting({ surfaces: [], ceramics: [[0.3, 0.8, 0.3]] });
    expect(green.gains[0] / green.gains[1]).toBeGreaterThanOrEqual(0.97);
  });
});

describe('taking the light out and putting it back', () => {
  const estimate = { exposureEv: -0.6, gains: [1.12, 0.98, 0.8] as Rgb };
  it('round-trips a photo colour within one 8-bit step', () => {
    for (const hex of ['#b9b2a5', '#7c7d7f', '#9c9486', '#3a3632', '#a89a84']) {
      const back = relightColor(delightColor(hex, estimate), estimate);
      const [a, b] = [hex, back].map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
      a.forEach((v, i) => expect(Math.abs(v - b[i])).toBeLessThanOrEqual(1));
    }
  });
  it('mixes the multiplier with strength and never exceeds a reflectance of 1', () => {
    expect(lightingMultiplier(estimate, 0)).toEqual([1, 1, 1]);
    const half = lightingMultiplier(estimate, 0.5);
    const full = lightingMultiplier(estimate, 1);
    half.forEach((v, i) => expect(v).toBeCloseTo(1 + (full[i] - 1) / 2, 6));
    expect(delightColor('#ffffff', estimate)).toBe('#ffffff');
    // A photo colour brighter than the estimated light allows is clipped to a reflectance of 1.
    expect(delightColor('#e3dccf', estimate).slice(1, 3)).toBe('ff');
    expect(linearToHex(hexToLinear('#8a7f70'))).toBe('#8a7f70');
  });
});

describe('stored photo light', () => {
  const profile = {
    version: 1 as const,
    exposureEv: -0.5,
    gains: [1.1, 0.98, 0.85] as Rgb,
    method: 'ceramic' as const,
    enabled: true,
    strength: 1,
  };
  it('turns into a render multiplier only when switched on with some strength', () => {
    expect(photoLightingMultiplier(undefined)).toBeUndefined();
    expect(photoLightingMultiplier({ ...profile, enabled: false })).toBeUndefined();
    expect(photoLightingMultiplier({ ...profile, strength: 0 })).toBeUndefined();
    const full = photoLightingMultiplier(profile)!;
    full.forEach((v, i) => expect(v).toBeCloseTo(profile.gains[i] * 2 ** -0.5, 6));
    const half = photoLightingMultiplier({ ...profile, strength: 0.5 })!;
    half.forEach((v, i) => expect(v).toBeCloseTo(1 + (full[i] - 1) / 2, 6));
    expect(projectPhotoLight({ shared: { comparison: { photoLighting: profile } } } as never)).toEqual(full);
    expect(projectPhotoLight({ shared: {} } as never)).toBeUndefined();
  });
  it('is created only from real evidence, on at full strength, and delights observed colours only', () => {
    const evidence = { surfaces: 1, achromatic: 0, ceramics: 1 };
    expect(
      createPhotoLighting({ exposureEv: 0, gains: [1, 1, 1], method: 'neutral', evidence }),
    ).toBeUndefined();
    expect(
      createPhotoLighting({ exposureEv: -0.5, gains: profile.gains, method: 'ceramic', evidence }),
    ).toEqual(profile);
    expect(delightObserved('#a0a0a0', undefined)).toBe('#a0a0a0');
    expect(delightObserved('not-a-colour', profile)).toBe('not-a-colour');
    expect(delightObserved('#a0a0a0', profile)).toBe(delightColor('#a0a0a0', profile));
  });
  it('samples faces without fixture boxes and takes the largest white toilet', () => {
    const width = 20,
      height = 10;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const x = i % width;
      const v = x < 10 ? 150 : 90;
      rgba.set([v, v, v, 255], i * 4);
    }
    const quad = (l: number, r: number) =>
      [
        { x: l, y: 0 },
        { x: r, y: 0 },
        { x: r, y: 1 },
        { x: l, y: 1 },
      ] as [
        { x: number; y: number },
        { x: number; y: number },
        { x: number; y: number },
        { x: number; y: number },
      ];
    const samples = samplePhotoLighting(rgba, width, height, {
      planes: [
        { quad: quad(0, 0.5), tile: { color: '#969696' } },
        { quad: quad(0.5, 1), tile: { color: '#5a5a5a' }, bands: [{ tile: { color: '#5b5b5b' } }] },
      ],
      candidates: [
        {
          kind: 'toilet',
          status: 'unplaced',
          color: '#d5d6d8',
          bounds: { left: 0.6, top: 0.2, right: 0.9, bottom: 0.8 },
        },
        {
          kind: 'toilet',
          status: 'unplaced',
          color: '#ffffff',
          bounds: { left: 0.1, top: 0.1, right: 0.12, bottom: 0.12 },
        },
        {
          kind: 'basin',
          status: 'ignored',
          color: '#eeeeee',
          bounds: { left: 0, top: 0, right: 0.4, bottom: 0.9 },
        },
      ],
    });
    // 200 pixels, minus the toilet box (6 × 6) and the tiny one (none at this size).
    expect(samples.surfaces).toHaveLength(200 - 36);
    expect(samples.ceramics.map(linearToHex)).toEqual(['#d5d6d8']);
    expect(samples.faces!.map(linearToHex)).toEqual(['#969696', '#5b5b5b']);
  });
});
