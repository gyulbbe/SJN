import { buildCandidatePipeline } from '../src/lib/reconstruction/candidate-pipeline';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import type { SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';
import type { ReconstructionReview } from '../src/lib/reconstruction/types';
import { describe, expect, it } from 'vitest';
import { Color, SRGBColorSpace } from 'three';
import {
  observeProductColor,
  resolveProductColor,
  PRODUCT_NEUTRAL_OPTICS,
} from '../src/lib/reconstruction/product-color';
import { reconstructionDefaults, type ReconstructionKind } from '../src/lib/reconstruction/types';
import { fixtureReconstructionSchema, reconstructionReviewSchema } from '../src/lib/storage/validation';

function photograph(body: number[], border = [180, 110, 60], kind: ReconstructionKind = 'toilet') {
  const width = 24,
    height = 24,
    rgba = new Uint8ClampedArray(width * height * 4),
    pixels: number[] = [];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const interior = x >= 3 && x <= 20 && y >= 3 && y <= 20;
      rgba.set([...(interior ? body : border), 255], (y * width + x) * 4);
      if (x >= 2 && x <= 21 && y >= 2 && y <= 21) pixels.push(y * width + x);
    }
  return { kind, width, height, rgba, pixels };
}
describe('product colour observation versus material', () => {
  it('samples only the eroded semantic interior, excluding a brown edge and surrounding wall', () => {
    const evidence = observeProductColor(photograph([210, 215, 215]));
    expect(evidence.color).toBe('#d2d7d7');
    expect(evidence.interiorCount).toBe(324);
    expect(evidence.source).toBe('inferred');
    expect(evidence.method).toBe('semantic-interior');
  });
  it.each([
    [110, 155, 167],
    [120, 120, 120],
    [12, 12, 12],
  ])('retains a real blue, grey, or black body %j', (...body) => {
    const evidence = observeProductColor(photograph(body));
    expect(evidence.color).toBe('#' + body.map((n) => n.toString(16).padStart(2, '0')).join(''));
    expect(evidence.source).toBe('inferred');
  });
  it('does not remove a black body by excluding all dark pixels', () => {
    const input = photograph([9, 9, 9]);
    for (let y = 3; y < 7; y++)
      for (let x = 3; x <= 20; x++) input.rgba.set([245, 245, 245, 255], (y * input.width + x) * 4);
    expect(observeProductColor(input).color).toBe('#090909');
  });
  it('uses a reviewable neutral material for ambiguous warm ceramic without claiming white detection', () => {
    const evidence = observeProductColor(photograph([149, 130, 110]));
    expect(evidence.observedColor).toBe('#95826e');
    expect(evidence.color).toBe(reconstructionDefaults('toilet').color);
    expect(evidence.source).toBe('default');
    expect(evidence.requiresReview).toBe(true);
    expect(evidence.reasons.join(' ')).toContain('베이지');
  });
  it('retains brown cabinetry instead of whitening every warm item', () => {
    const evidence = observeProductColor(photograph([149, 130, 110], undefined, 'vanity'));
    expect(evidence.color).toBe('#95826e');
    expect(evidence.source).toBe('inferred');
  });
  it('falls back without inventing an observed colour if the actual mask has no interior', () => {
    const input = photograph([50, 120, 170]);
    input.pixels = [50, 51, 52];
    const evidence = observeProductColor(input);
    expect(evidence.observedColor).toBeUndefined();
    expect(evidence.source).toBe('default');
    expect(resolveProductColor('toilet', { color: evidence.color, colorEvidence: evidence })).toEqual(
      evidence,
    );
  });
  it('marks a mixed interior rather than presenting it as a certain intrinsic colour', () => {
    const input = photograph([120, 120, 120]);
    for (let y = 3; y <= 20; y++)
      for (let x = 3; x < 12; x++) input.rgba.set([20, 80, 170, 255], (y * input.width + x) * 4);
    expect(observeProductColor(input).requiresReview).toBe(true);
  });
  it.each(PRODUCT_NEUTRAL_OPTICS)('does not paint %s with the reflected or background brown', (kind) => {
    const evidence = resolveProductColor(kind, { color: '#8a7767' });
    expect(evidence.color).toBe(reconstructionDefaults(kind).color);
    expect(evidence.observedColor).toBe('#8a7767');
    expect(evidence.method).toBe('neutral-optics');
    expect(() => resolveProductColor(kind, undefined, { mode: 'custom', color: '#ff0000' })).toThrow();
  });
  it('keeps the old observation immutable and labels its sampling as unverified', () => {
    const original = { color: '#8a7767' },
      copy = structuredClone(original);
    const evidence = resolveProductColor('toilet', original);
    expect(evidence.method).toBe('legacy-observation');
    expect(evidence.source).toBe('default');
    expect(evidence.observedColor).toBe(original.color);
    expect(original).toEqual(copy);
    expect(resolveProductColor('toilet', { color: '#739da8' })).toMatchObject({
      color: '#739da8',
      source: 'inferred',
      requiresReview: true,
    });
  });
  it('accepts a deliberately confirmed beige material and distinguishes neutral confirmation from automatic fallback', () => {
    const original = { color: '#8a7767' };
    expect(resolveProductColor('toilet', original, { mode: 'custom', color: '#AA8877' })).toMatchObject({
      color: '#aa8877',
      source: 'user',
      requiresReview: false,
      observedColor: original.color,
    });
    expect(resolveProductColor('toilet', original, { mode: 'neutral' })).toMatchObject({
      source: 'user',
      method: 'user',
      requiresReview: false,
    });
    expect(resolveProductColor('toilet', original).source).toBe('default');
    expect(() => resolveProductColor('toilet', undefined, { mode: 'custom', color: 'red' })).toThrow();
  });
  it('keeps bytes in sRGB and allows Three to decode once rather than adding another gamma transform', () => {
    const evidence = resolveProductColor('toilet', { color: '#739da8' });
    const materialColor = new Color(evidence.color);
    expect(materialColor.getHexString(SRGBColorSpace)).toBe('739da8');
    expect(materialColor.r).toBeLessThan(115 / 255);
  });
  it('roundtrips evidence and per-field provenance through the server fixture and review validation', () => {
    const colorEvidence = resolveProductColor('toilet', { color: '#8a7767' });
    const reconstruction = {
      version: 2,
      kind: 'toilet',
      color: colorEvidence.color,
      colorEvidence,
      widthMm: 400,
      heightMm: 800,
      depthMm: 700,
      provenance: { color: colorEvidence.source, appearance: colorEvidence.source },
    };
    expect(fixtureReconstructionSchema.parse(reconstruction)).toEqual(reconstruction);
    const review = {
      version: 2,
      analysis: 'partial',
      warnings: [],
      planes: [],
      candidates: [
        {
          id: 'candidate',
          kind: 'toilet',
          bounds: { left: 0.1, right: 0.4, top: 0.2, bottom: 0.8 },
          foot: { x: 0.2, y: 0.8 },
          color: colorEvidence.color,
          colorEvidence,
          pixels: 42,
          evidence: { semanticPixels: 42, meanMargin: 2 },
          status: 'unplaced',
        },
      ],
    };
    expect(reconstructionReviewSchema.parse(review)).toEqual(review);
    expect(
      fixtureReconstructionSchema.safeParse({
        ...reconstruction,
        colorEvidence: { ...colorEvidence, sampleCount: -1 },
      }).success,
    ).toBe(false);
  });
});

describe('product colour in generated candidate plans', () => {
  const bounds = { left: 0.2, right: 0.5, top: 0.3, bottom: 0.8 };
  const understanding: SceneUnderstanding = {
    schemaVersion: 1,
    candidates: [
      {
        id: 'toilet',
        kind: 'toilet',
        bounds,
        mounting: 'floor',
        wall: 'unknown',
        basinStyle: 'unknown',
        shape: 'unknown',
        reflection: 'physical',
        evidence: ['synthetic fixture observation'],
        uncertainty: [],
      },
    ],
    relations: [],
    roomLayout: { orthogonal: false, evidence: [], uncertainty: ['unknown source camera'] },
  };
  const baseline: ReconstructionReview = {
    version: 2,
    analysis: 'partial',
    warnings: [],
    planes: [],
    candidates: [
      {
        id: 'semantic',
        kind: 'toilet',
        bounds,
        foot: { x: 0.35, y: 0.8 },
        color: '#8a7767',
        pixels: 200,
        evidence: { semanticPixels: 200, meanMargin: 4 },
        status: 'unplaced',
      },
    ],
  };
  const manual = { toilet: { face: 'floor' as const, u: 0.5, v: 0.5, baseHeightMm: 0 } };
  it('records neutral fallback rather than falsely attributing copied photo colour to a default observation', () => {
    const before = structuredClone(baseline);
    const result = buildCandidatePipeline(
      understanding,
      baseline,
      DEFAULT_ROOM,
      { width: 800, height: 600 },
      manual,
    );
    expect(result.plans.toilet).toMatchObject({
      color: '#efefea',
      provenance: { color: 'default', appearance: 'default' },
      colorEvidence: { observedColor: '#8a7767', method: 'legacy-observation', requiresReview: true },
    });
    expect(baseline).toEqual(before);
    expect(result.pipeline.automaticUnderstanding).toEqual(understanding);
  });
  it('records user colour independently while leaving model fields, placements and the original observation untouched', () => {
    const result = buildCandidatePipeline(
      understanding,
      baseline,
      DEFAULT_ROOM,
      { width: 800, height: 600 },
      manual,
      understanding,
      {},
      undefined,
      undefined,
      { toilet: { mode: 'custom', color: '#886655' } },
    );
    expect(result.plans.toilet).toMatchObject({
      color: '#886655',
      provenance: { color: 'user', appearance: 'user' },
      colorEvidence: { observedColor: '#8a7767', requiresReview: false },
    });
    expect(result.pipeline.userColors?.toilet).toEqual({ mode: 'custom', color: '#886655' });
    expect(result.pipeline.automaticUnderstanding).toEqual(understanding);
    expect(result.pipeline.baselineReview).toEqual(baseline);
    expect(() =>
      buildCandidatePipeline(
        understanding,
        baseline,
        DEFAULT_ROOM,
        { width: 800, height: 600 },
        manual,
        understanding,
        {},
        undefined,
        undefined,
        { absent: { mode: 'neutral' } },
      ),
    ).toThrow();
  });
});
