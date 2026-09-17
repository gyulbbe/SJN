import { describe, expect, it } from 'vitest';
import {
  encodeBasinPixels,
  inspectBasinShape,
  observeBasinShape,
} from '../src/lib/reconstruction/basin-observations';
import { extractReconstructionCandidates, mapCandidatePass } from '../src/lib/reconstruction/candidates';
import type { BasinComponentCapture } from '../src/lib/reconstruction/basin-observations';
import type { ReconstructionCandidate } from '../src/lib/reconstruction/types';
import { reconstructionReviewSchema } from '../src/lib/storage/validation';

function partialBowl(rim: 'corner' | 'curve' | 'line' | 'none' | 'single', scale = 1) {
  const width = Math.round(240 * scale),
    height = Math.round(240 * scale);
  const rgba = new Uint8ClampedArray(width * height * 4),
    pixels: number[] = [];
  const membership = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const u = x / scale,
        v = y / scale;
      const bottom = Math.max(106 - 0.2 * Math.abs(u - 120), 108 + 14 * Math.sin(u * 0.15));
      if ((u >= 40 && u < 200 && v >= 50 && v < bottom) || (u >= 103 && u < 137 && v >= 100 && v < 218)) {
        pixels.push(y * width + x);
        membership[y * width + x] = 1;
      }
      const boundary =
        rim === 'curve' ? 102 - 0.0025 * (u - 120) ** 2 : rim === 'line' ? 90 : 102 - 0.2 * Math.abs(u - 120);
      const bright =
        rim !== 'none' && u >= 40 && u < 200 && v >= 50 && v < boundary && (rim !== 'single' || u < 120);
      rgba.set([bright ? 225 : 120, bright ? 225 : 120, bright ? 225 : 120, 255], (y * width + x) * 4);
    }
  return {
    width,
    height,
    rgba,
    pixels,
    membership,
    bounds: { left: 1 / 6, top: 50 / 240, right: 5 / 6, bottom: 218 / 240 },
  };
}
const inspect = (input: ReturnType<typeof partialBowl>, pedestal = true, pixels = input.pixels) =>
  inspectBasinShape(pixels, input.width, input.height, input.bounds, pedestal, true, input.rgba);

describe('supported RGB rim observation after incomplete semantic bowl masks', () => {
  it.each([0.75, 1, 1.5])(
    'uses two straight rim edges at image scale %s only after a failed semantic fit',
    (scale) => {
      const input = partialBowl('corner', scale);
      expect(observeBasinShape(input.pixels, input.width, input.height, input.bounds, true)).toBeUndefined();
      const result = inspect(input);
      expect(result.evidence?.source, JSON.stringify(result.diagnostic)).toBe('semantic-rgb-contour');
      expect(result.evidence?.value).toBe('rectangular');
      expect(result.diagnostic.semanticRejection?.length).toBeGreaterThan(0);
      expect(result.diagnostic.rim?.curveError).toBeGreaterThan(result.diagnostic.rim!.pairedError! * 1.3);
      expect(result.evidence).not.toHaveProperty('curvature');
    },
  );
  it.each(['curve', 'line', 'none', 'single'] as const)(
    'does not turn %s edges into a square basin',
    (shape) => {
      const result = inspect(partialBowl(shape));
      expect(result.evidence, JSON.stringify(result.diagnostic)).toBeUndefined();
      expect(result.diagnostic.rim?.rejectedBy.length).toBeGreaterThan(0);
    },
  );
  it('requires an observed pedestal and actual component membership at the brightness edge', () => {
    const input = partialBowl('corner');
    expect(inspect(input, false).evidence).toBeUndefined();
    const gap = input.pixels.filter((p) => {
      const x = p % input.width,
        y = Math.floor(p / input.width),
        edge = 102 - 0.2 * Math.abs(x - 120);
      return Math.abs(y - edge) > 9;
    });
    expect(inspect(input, true, gap).evidence).toBeUndefined();
    expect(inspect({ ...input, rgba: new Uint8ClampedArray(4) }).evidence).toBeUndefined();
    expect(inspect({ ...input, bounds: { ...input.bounds, left: 0 } }).diagnostic.rejectedBy).toContain(
      'frame-clipped',
    );
  });
  it('keeps existing curved semantic evidence and does not allocate profiles for normal observations', () => {
    const input = partialBowl('corner');
    const pixels: number[] = [];
    for (let x = 40; x < 200; x++)
      for (let y = 65; y < 92 + 45 * Math.sqrt(1 - ((x - 120) / 80) ** 2); y++)
        pixels.push(y * input.width + x);
    const result = inspectBasinShape(
      pixels,
      input.width,
      input.height,
      { ...input.bounds, top: 65 / 240, bottom: 140 / 240 },
      false,
      false,
      input.rgba,
    );
    expect(result.evidence?.value).toBe('round');
    expect(result.evidence?.source).toBe('semantic-contour');
    expect(result.diagnostic.profiles).toBeUndefined();
    expect(result.diagnostic.rim).toBeUndefined();
  });
  it('round-trips measured RGB evidence and rejects incomplete or out-of-image coordinates', () => {
    const shape = inspect(partialBowl('corner')).evidence;
    const candidate = {
      id: 'basin',
      kind: 'basin',
      bounds: { left: 0.1, top: 0.2, right: 0.5, bottom: 0.8 },
      foot: { x: 0.3, y: 0.8 },
      color: '#eeeeee',
      pixels: 1000,
      status: 'unplaced',
      evidence: { semanticPixels: 1000, meanMargin: 3, basinShape: shape },
    };
    const review = { version: 2, analysis: 'partial', warnings: [], planes: [], candidates: [candidate] };
    expect(reconstructionReviewSchema.parse(review).candidates[0].evidence.basinShape).toEqual(shape);
    expect(
      reconstructionReviewSchema.safeParse({
        ...review,
        candidates: [
          {
            ...candidate,
            evidence: {
              ...candidate.evidence,
              basinShape: { ...shape, rimIntersection: { x: 1.5, y: 0.5 } },
            },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      reconstructionReviewSchema.safeParse({
        ...review,
        candidates: [
          {
            ...candidate,
            evidence: { ...candidate.evidence, basinShape: { ...shape, edgeSlopes: undefined } },
          },
        ],
      }).success,
    ).toBe(false);
  });
  it('maps measured rim coordinates across crop/flip passes without mutating source evidence', () => {
    const shape = inspect(partialBowl('corner')).evidence!;
    expect(shape.source).toBe('semantic-rgb-contour');
    if (shape.source !== 'semantic-rgb-contour') throw Error('Expected supported corner');
    const candidate: ReconstructionCandidate = {
      id: 'b',
      kind: 'basin',
      bounds: { left: 0.1, top: 0.1, right: 0.9, bottom: 0.9 },
      foot: { x: 0.5, y: 0.9 },
      color: '#eeeeee',
      pixels: 1000,
      status: 'unplaced',
      evidence: { semanticPixels: 1000, meanMargin: 3, basinShape: shape },
    };
    const original = structuredClone(candidate);
    const mapped = mapCandidatePass([candidate], { left: 0.2, right: 0.7, top: 0.1, bottom: 0.9 }, true)[0]
      .evidence.basinShape;
    expect(mapped?.source).toBe('semantic-rgb-contour');
    if (mapped?.source !== 'semantic-rgb-contour') throw Error('Lost measurement');
    expect(mapped.rimIntersection.x).toBeCloseTo(0.2 + (1 - shape.rimIntersection.x) * 0.5);
    expect(mapped.rimIntersection.y).toBeCloseTo(0.1 + shape.rimIntersection.y * 0.8);
    expect(mapped.edgeSlopes).toEqual([-shape.edgeSlopes[1], -shape.edgeSlopes[0]]);
    expect(mapped.observedEdgeCoverage).toEqual([...shape.observedEdgeCoverage].reverse());
    expect(candidate).toEqual(original);
  });
  it('captures original components only on request and leaves production candidates unchanged', () => {
    const input = partialBowl('corner');
    const labels = new Uint8Array(input.width * input.height).fill(1);
    for (const p of input.pixels) labels[p] = 48;
    const captures: BasinComponentCapture[] = [];
    const normal = extractReconstructionCandidates({ ...input, labels });
    const observed = extractReconstructionCandidates({
      ...input,
      labels,
      onBasinCapture: (c) => captures.push(c),
    });
    expect(observed).toEqual(normal);
    expect(normal).not.toHaveProperty('basinDiagnostics');
    expect(captures).toHaveLength(1);
    expect(captures[0].inspection.diagnostic.profiles).toBeDefined();
    expect(captures[0].inspection.evidence?.source).toBe('semantic-rgb-contour');
    const decoded: number[] = [];
    for (let i = 0; i < captures[0].pixelRuns.length; i += 2)
      for (let n = 0; n < captures[0].pixelRuns[i + 1]; n++) decoded.push(captures[0].pixelRuns[i] + n);
    expect(decoded).toEqual([...input.pixels].sort((a, b) => a - b));
    expect(normal[0].evidence).not.toHaveProperty('profiles');
  });
  it('encodes opt-in raw component runs without changing or losing source pixels', () => {
    const pixels = [10, 11, 12, 4, 6, 7],
      original = [...pixels];
    expect(encodeBasinPixels(pixels)).toEqual([4, 1, 6, 2, 10, 3]);
    expect(pixels).toEqual(original);
  });
});
