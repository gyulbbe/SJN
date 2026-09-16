import { describe, expect, it } from 'vitest';
import { Box3, Mesh, Vector3 } from 'three';
import { observeBasinCount, observeBasinShape } from '../src/lib/reconstruction/basin-observations';
import { createTemplateModel, disposeTemplateModel } from '../src/lib/reconstruction/templates';
import { reconstructionDefaults, type ReconstructionCandidate } from '../src/lib/reconstruction/types';
import { fixtureReconstructionSchema, reconstructionReviewSchema } from '../src/lib/supabase/validation';

function basin(id: string, left: number, right: number): ReconstructionCandidate {
  return {
    id,
    kind: 'basin',
    bounds: { left, right, top: 0.25, bottom: 0.4 },
    foot: { x: (left + right) / 2, y: 0.4 },
    color: '#eeeeee',
    pixels: 1000,
    status: 'unplaced',
    evidence: { semanticPixels: 1000, meanMargin: 3 },
  };
}
function silhouette(shape: 'rectangular' | 'round' | 'fragmented', pedestal = false) {
  const width = 240,
    height = 240,
    pixels: number[] = [];
  for (let x = 40; x < 200; x++) {
    const nx = (x - 120) / 80;
    const bottom =
      shape === 'round'
        ? 92 + 45 * Math.sqrt(1 - nx * nx)
        : shape === 'rectangular'
          ? 122 + 0.12 * (x - 120)
          : 100 + Math.sin(x * 0.2) * 22;
    for (let y = 65; y < bottom; y++) pixels.push(y * width + x);
  }
  if (pedestal) for (let x = 102; x < 138; x++) for (let y = 110; y < 225; y++) pixels.push(y * width + x);
  return {
    pixels,
    width,
    height,
    bounds: {
      left: 40 / width,
      right: 200 / width,
      top: 65 / height,
      bottom: (pedestal ? 225 : 140) / height,
    },
  };
}
describe('basin evidence and independent geometry', () => {
  it('recognizes supported straight versus curved bowl contours independently from the mounting label', () => {
    for (const shape of ['rectangular', 'round'] as const) {
      const input = silhouette(shape);
      const observed = observeBasinShape(input.pixels, input.width, input.height, input.bounds, false);
      expect(observed?.value).toBe(shape);
      expect(observed?.source).toBe('semantic-contour');
      expect(observed?.coverage).toBeGreaterThan(0.65);
    }
    const input = silhouette('rectangular', true);
    expect(observeBasinShape(input.pixels, input.width, input.height, input.bounds, true)?.value).toBe(
      'rectangular',
    );
  });
  it('keeps fragmented or frame-clipped silhouettes unknown instead of labelling them from the support default', () => {
    const input = silhouette('fragmented');
    expect(observeBasinShape(input.pixels, input.width, input.height, input.bounds, false)).toBeUndefined();
    expect(
      observeBasinShape(input.pixels, input.width, input.height, { ...input.bounds, left: 0 }, false),
    ).toBeUndefined();
  });
  it('requires two distinct strong basin regions; width, one broad region, overlap and tiny fragments do not prove two bowls', () => {
    const cabinet = { ...basin('cabinet', 0.1, 0.9), kind: 'vanity' as const };
    const pair = [basin('b1', 0.16, 0.42), basin('b2', 0.58, 0.84)];
    expect(observeBasinCount(pair, cabinet)).toEqual({
      value: 2,
      source: 'separate-basin-components',
      candidateIds: ['b1', 'b2'],
    });
    expect(observeBasinCount([basin('wide', 0.1, 0.9)], cabinet)).toBeUndefined();
    expect(observeBasinCount([pair[0], basin('overlap', 0.2, 0.44)], cabinet)).toBeUndefined();
    expect(observeBasinCount([pair[0], basin('fragment', 0.5, 0.52)], cabinet)).toBeUndefined();
    expect(observeBasinCount([pair[0], { ...pair[1], requiresReview: true }], cabinet)).toBeUndefined();
    expect(reconstructionDefaults('vanity').bowlCount).toBe(1);
  });
  it.each(['wall', 'pedestal', 'vanity'] as const)(
    'renders both observed shapes and one/two bowls with %s support at the requested physical size',
    (variant) => {
      const fingerprints: string[] = [];
      for (const shape of ['rectangular', 'round'] as const)
        for (const count of [1, 2] as const) {
          const model = createTemplateModel({
            kind: 'basin',
            version: 2,
            basinVariant: variant,
            basinShape: shape,
            bowlCount: count,
            color: '#eeeeee',
            widthMm: 1000,
            heightMm: variant === 'wall' ? 320 : 800,
            depthMm: 450,
            face: variant === 'wall' ? 'back' : 'floor',
          });
          const bowls = model.children.filter((n) => n.name.endsWith('basin-bowl')) as Mesh[];
          expect(bowls).toHaveLength(count);
          expect(bowls.every((n) => n.userData.basinShape === shape)).toBe(true);
          const size = new Box3().setFromObject(model).getSize(new Vector3());
          expect(size.x).toBeCloseTo(1000, 3);
          expect(size.z).toBeCloseTo(450, 3);
          expect(size.y).toBeCloseTo(variant === 'wall' ? 320 : 800, 3);
          const pedestals = model.children.filter((n) => n.name === 'basin-pedestal');
          expect(pedestals).toHaveLength(variant === 'pedestal' ? count : 0);
          fingerprints.push(JSON.stringify(Array.from(bowls[0].geometry.getAttribute('position').array)));
          disposeTemplateModel(model);
        }
      expect(fingerprints[0]).not.toEqual(fingerprints[2]);
    },
  );
  it('keeps old implicit vanity geometry but respects explicit one bowl regardless of cabinet width', () => {
    for (const count of [undefined, 1, 2] as const) {
      const model = createTemplateModel({
        kind: 'vanity',
        version: 2,
        color: '#eeeeee',
        widthMm: 1200,
        heightMm: 850,
        depthMm: 550,
        bowlCount: count,
      });
      expect(model.children.filter((n) => n.name === 'basin-bowl')).toHaveLength(count ?? 2);
      disposeTemplateModel(model);
    }
  });
  it('omits the floor plinth for a suspended vanity and keeps legacy or floor plinths', () => {
    for (const face of ['back', 'floor', undefined] as const) {
      const model = createTemplateModel({
        kind: 'vanity',
        version: 2,
        color: '#eeeeee',
        widthMm: 1000,
        heightMm: 600,
        depthMm: 450,
        face,
        bowlCount: 1,
      });
      expect(model.children.some((n) => n.name === 'vanity-plinth')).toBe(face !== 'back');
      disposeTemplateModel(model);
    }
  });
  it('round-trips new shape/count provenance and rejects unsupported bowl counts while accepting older absence', () => {
    const meta = {
      version: 2,
      kind: 'vanity',
      color: '#dddddd',
      widthMm: 1200,
      heightMm: 850,
      depthMm: 550,
      basinShape: 'round',
      bowlCount: 2,
      provenance: { shape: 'inferred', bowlCount: 'inferred' },
    };
    expect(fixtureReconstructionSchema.parse(meta)).toEqual(meta);
    expect(fixtureReconstructionSchema.safeParse({ ...meta, bowlCount: 3 }).success).toBe(false);
    const old = { ...meta, bowlCount: undefined };
    expect(fixtureReconstructionSchema.safeParse(old).success).toBe(true);
    const c = basin('basin', 0.2, 0.7),
      input = silhouette('round');
    c.evidence.basinShape = observeBasinShape(input.pixels, input.width, input.height, input.bounds, false);
    c.evidence.bowlCount = { value: 2, source: 'separate-basin-components', candidateIds: ['a', 'b'] };
    const review = { version: 2, analysis: 'partial', warnings: [], planes: [], candidates: [c] };
    expect(reconstructionReviewSchema.parse(review).candidates[0].evidence).toEqual(c.evidence);
  });
});
