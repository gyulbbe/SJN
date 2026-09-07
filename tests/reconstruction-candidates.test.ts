import { describe, expect, it } from 'vitest';
import {
  extractReconstructionCandidates,
  mapCandidatePass,
  mergeReconstructionPasses,
  refineCandidateFrames,
} from '../src/lib/reconstruction/candidates';
import type { ReconstructionCandidate } from '../src/lib/reconstruction/types';

function raster(width = 100, height = 100) {
  const labels = new Uint8Array(width * height).fill(1),
    rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < labels.length; i++) rgba.set([140, 170, 175, 255], i * 4);
  const rect = (x0: number, y0: number, x1: number, y1: number, label: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) labels[y * width + x] = label;
  };
  return { width, height, labels, rgba, rect };
}
function candidate(
  id: string,
  kind: ReconstructionCandidate['kind'],
  left: number,
  top: number,
  right: number,
  bottom: number,
  margin = 3,
): ReconstructionCandidate {
  return {
    id,
    kind,
    bounds: { left, top, right, bottom },
    foot: { x: (left + right) / 2, y: bottom },
    color: '#99bbbb',
    pixels: 100,
    evidence: { semanticPixels: 100, meanMargin: margin },
    status: 'unplaced',
  };
}

describe('reconstruction candidate quality', () => {
  it('groups a basin and supporting cabinet, including a mislabeled small toe kick, into one vanity', () => {
    const r = raster();
    r.rect(4, 40, 44, 51, 48);
    r.rect(5, 50, 44, 85, 11);
    r.rect(7, 84, 40, 92, 38);
    const result = extractReconstructionCandidates(r);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('vanity');
    expect(result[0].bounds).toEqual({ left: 0.04, top: 0.4, right: 0.44, bottom: 0.92 });
    expect(result[0].color).toBe('#8caaaf');
    expect(result[0].foot.y).toBe(0.92);
  });
  it('does not call a standalone cabinet a vanity without a supported basin above it', () => {
    const r = raster();
    r.rect(5, 30, 40, 90, 11);
    r.rect(70, 30, 92, 40, 48);
    const result = extractReconstructionCandidates(r);
    expect(result.filter((c) => c.kind === 'vanity')).toEqual([]);
    expect(result.filter((c) => c.kind === 'basin')).toHaveLength(1);
  });
  it('holds a narrow clipped cabinet-like basket for review instead of confidently adding another vanity', () => {
    const r = raster();
    r.rect(93, 48, 100, 56, 48);
    r.rect(93, 55, 100, 87, 11);
    const result = extractReconstructionCandidates(r);
    expect(result[0].kind).toBe('vanity');
    expect(result[0].requiresReview).toBe(true);
  });
  it('retains a cylindrical object as uncertain when a trash-can class competes, while retaining actual toilet evidence', () => {
    const r = raster();
    r.rect(10, 25, 28, 65, 66);
    r.rect(55, 32, 68, 67, 66);
    const values = new Float32Array(100 * 100 * 151);
    for (let y = 0; y < 100; y++)
      for (let x = 0; x < 100; x++) {
        const at = (y * 100 + x) * 151;
        values[at + 66] = 10;
        values[at + 139] = x > 45 ? 6 : -2;
      }
    const result = extractReconstructionCandidates({
      ...r,
      logits: {
        values,
        width: 100,
        height: 100,
        channels: 151,
        cropWidth: 100,
        cropHeight: 100,
        paddedWidth: 100,
        paddedHeight: 100,
      },
    });
    const toilet = result.find((c) => c.bounds.left < 0.3)!,
      bin = result.find((c) => c.bounds.left > 0.5)!;
    expect(toilet.requiresReview).not.toBe(true);
    expect(bin.requiresReview).toBe(true);
    expect(bin.warning).toContain('휴지통');
    expect(bin.evidence.meanMargin).toBe(4);
  });
  it('combines fragmented mirror evidence across mirrored views without turning reflections into extra windows', () => {
    const first = [
      candidate('mirror-small', 'mirror', 0.13, 0.22, 0.17, 0.33, 0.8),
      candidate('reflection', 'window', 0.1, 0.17, 0.14, 0.35, 0.6),
    ];
    const second = mapCandidatePass(
      [candidate('mirror-large', 'mirror', 0.82, 0.13, 0.92, 0.4, 1.7)],
      { left: 0, top: 0, right: 1, bottom: 1 },
      true,
    );
    const result = mergeReconstructionPasses(first, second);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('mirror');
    expect(result[0].bounds.left).toBeCloseTo(0.08);
    expect(result[0].bounds.right).toBeCloseTo(0.18);
    expect(result[0].evidence.meanMargin).toBe(1.7);
  });
  it('never merges two separated toilets or clears a semantic ambiguity because another view agrees', () => {
    const a = candidate('a', 'toilet', 0.2, 0.4, 0.35, 0.8),
      b = candidate('b', 'toilet', 0.6, 0.4, 0.75, 0.8);
    b.requiresReview = true;
    b.warning = '물체 종류 확인';
    const result = mergeReconstructionPasses(
      [a, b],
      [candidate('a2', 'toilet', 0.21, 0.4, 0.36, 0.8), candidate('b2', 'toilet', 0.61, 0.4, 0.76, 0.8, 5)],
    );
    expect(result).toHaveLength(2);
    expect(result.find((c) => c.id === 'b')?.requiresReview).toBe(true);
  });
  it('maps crop coordinates and foot anchors back into the unchanged original photo coordinate system', () => {
    const mapped = mapCandidatePass([candidate('a', 'toilet', 0.25, 0.2, 0.75, 0.9)], {
      left: 0.2,
      top: 0.3,
      right: 0.6,
      bottom: 0.8,
    })[0];
    expect(mapped.bounds.left).toBeCloseTo(0.3);
    expect(mapped.bounds.bottom).toBeCloseTo(0.75);
    expect(mapped.foot.x).toBeCloseTo(0.4);
  });
  it('extends only an already detected mirror to sustained RGB frame edges', () => {
    const r = raster();
    for (let y = 14; y < 79; y++)
      for (const x of [22, 23, 41, 42]) r.rgba.set([20, 30, 30, 255], (y * r.width + x) * 4);
    const result = refineCandidateFrames(
      [candidate('mirror', 'mirror', 0.25, 0.3, 0.4, 0.7, 2)],
      r.rgba,
      100,
      100,
    );
    expect(result[0].bounds.top).toBeLessThan(0.2);
    expect(result[0].bounds.left).toBeLessThan(0.25);
    expect(result[0].bounds.right).toBeGreaterThan(0.4);
    expect(refineCandidateFrames([], r.rgba, 100, 100)).toEqual([]);
  });
});
