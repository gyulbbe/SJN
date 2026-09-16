import { describe, expect, it } from 'vitest';
import {
  extractReconstructionCandidates,
  mapCandidatePass,
  mergeReconstructionPasses,
  refineCandidateFrames,
} from '../src/lib/reconstruction/candidates';
import {
  hasSupportedReconstructionKind,
  type ReconstructionCandidate,
} from '../src/lib/reconstruction/types';

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
    const cabinet = result.find((c) => c.detectedLabel === 'cabinet')!;
    expect(cabinet.proposedKind).toBeUndefined();
    expect(cabinet.requiresReview).toBe(true);
    expect(cabinet.installation?.mode).toBe('unknown');
    expect(cabinet.trace?.some((entry) => entry.stage === 'candidate' && entry.outcome === 'held')).toBe(
      true,
    );
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
    expect(result).toHaveLength(2);
    expect(result.find((c) => c.kind === 'window')).toMatchObject({
      requiresReview: true,
      reflectionOf: 'mirror-small',
    });
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

it('does not discard a foreground basin solely because its bounds lie inside a mirror box', () => {
  const mirror = candidate('mirror', 'mirror', 0.1, 0.1, 0.9, 0.9, 5);
  const foreground = candidate('basin', 'basin', 0.3, 0.5, 0.7, 0.7, 3);
  foreground.evidence.mirrorCompetition = 0;
  const result = mergeReconstructionPasses([mirror, foreground], []);
  expect(result.find((c) => c.id === 'basin')?.reflectionOf).toBeUndefined();
  expect(result.find((c) => c.id === 'basin')?.requiresReview).not.toBe(true);
  foreground.evidence.mirrorCompetition = 0.7;
  expect(mergeReconstructionPasses([mirror, foreground], []).find((c) => c.id === 'basin')).toMatchObject({
    requiresReview: true,
    reflectionOf: 'mirror',
  });
});

function scoredRaster() {
  const r = raster();
  const values = new Float32Array(r.width * r.height * 151);
  const input = () => {
    for (let p = 0; p < r.labels.length; p++) values[p * 151 + r.labels[p]] = r.labels[p] === 66 ? 1.2 : 3;
    return {
      ...r,
      logits: {
        values,
        width: r.width,
        height: r.height,
        channels: 151,
        cropWidth: r.width,
        cropHeight: r.height,
        paddedWidth: r.width,
        paddedHeight: r.height,
      },
    };
  };
  return { ...r, input };
}
describe('observed support and toilet assemblies', () => {
  it('records only a sustained narrow basin-class stem, keeping the model score unchanged', () => {
    const r = scoredRaster();
    r.rect(25, 15, 65, 31, 48);
    r.rect(38, 30, 52, 78, 48);
    const result = extractReconstructionCandidates(r.input());
    expect(result).toHaveLength(1);
    expect(result[0].evidence.pedestalSupport).toMatchObject({ stemWidthRatio: 0.35, coverage: 1 });
    expect(result[0].evidence.meanMargin).toBe(3);
    expect(result[0].installation).toBeUndefined();
  });
  it('does not call a thin drain pipe, a uniform narrow wall strip or a short bowl a pedestal', () => {
    for (const variant of ['pipe', 'strip', 'bowl']) {
      const r = scoredRaster();
      if (variant === 'pipe') {
        r.rect(25, 15, 65, 31, 48);
        r.rect(44, 30, 47, 78, 48);
      }
      if (variant === 'strip') r.rect(40, 15, 55, 78, 48);
      if (variant === 'bowl') r.rect(25, 30, 65, 48, 48);
      expect(extractReconstructionCandidates(r.input())[0].evidence.pedestalSupport).toBeUndefined();
    }
  });
  it('joins a mirror-labeled lid enclosed by toilet pixels and its touching bowl without inflating confidence', () => {
    const r = scoredRaster();
    r.rect(5, 15, 30, 52, 66);
    r.rect(9, 20, 26, 45, 28);
    r.rect(5, 50, 45, 68, 48);
    const result = extractReconstructionCandidates(r.input());
    expect(result).toHaveLength(1);
    const assembly = result[0];
    expect(assembly.kind).toBe('toilet');
    expect(assembly.evidence.contextualKind).toBe('toilet-assembly');
    expect(assembly.evidence.meanMargin).toBeCloseTo(1.2);
    expect(assembly.evidence.contextualParts?.surroundRatio).toBe(1);
    expect(hasSupportedReconstructionKind(assembly)).toBe(true);
    expect(assembly.bounds).toEqual({ left: 0.05, top: 0.15, right: 0.45, bottom: 0.68 });
    expect(assembly.trace?.at(-1)?.outcome).toBe('merged');
  });
  it('keeps a wall mirror and separate fixtures, including reflected toilet pixels inside the mirror', () => {
    const r = scoredRaster();
    r.rect(10, 5, 80, 44, 28);
    r.rect(45, 15, 60, 36, 66);
    r.rect(15, 60, 45, 78, 48);
    const result = extractReconstructionCandidates(r.input());
    expect(result.find((c) => c.kind === 'mirror')?.evidence.toiletSurround).toBeLessThan(0.5);
    expect(result.some((c) => c.evidence.contextualKind)).toBe(false);
    expect(result.some((c) => c.kind === 'basin')).toBe(true);
  });
  it('does not merge an unrelated wall mirror near a toilet or a disconnected basin below a lid', () => {
    const r = scoredRaster();
    r.rect(5, 15, 30, 52, 66);
    r.rect(9, 20, 26, 45, 28);
    r.rect(5, 60, 45, 78, 48);
    const result = extractReconstructionCandidates(r.input());
    expect(result).toHaveLength(3);
    expect(result.some((c) => c.evidence.contextualKind)).toBe(false);
  });
  it('does not treat a forged contextual tag without measured support as sufficient evidence', () => {
    const c = candidate('weak', 'toilet', 0, 0.3, 0.3, 0.8, 1);
    c.evidence.contextualKind = 'toilet-assembly';
    expect(hasSupportedReconstructionKind(c)).toBe(false);
    c.evidence.contextualParts = { toiletPixels: 1000, bowlPixels: 1000, surroundRatio: 0.1 };
    expect(hasSupportedReconstructionKind(c)).toBe(false);
  });
});

describe('assembly evidence across analysis passes', () => {
  it('does not resurrect the observed lid/bowl after a flip, while preserving an actual wall mirror', () => {
    const r = scoredRaster();
    r.rect(5, 15, 30, 52, 66);
    r.rect(9, 20, 26, 45, 28);
    r.rect(5, 50, 45, 68, 48);
    const assembly = extractReconstructionCandidates(r.input())[0];
    const lid = candidate('flip-lid', 'mirror', 0.09, 0.2, 0.26, 0.45, 3);
    const bowl = candidate('flip-bowl', 'basin', 0.05, 0.5, 0.45, 0.68, 3);
    const realMirror = candidate('wall-mirror', 'mirror', 0.5, 0.05, 0.9, 0.35, 4);
    const result = mergeReconstructionPasses([assembly], [lid, bowl, realMirror]);
    expect(result.map((c) => c.id)).toEqual(expect.arrayContaining([assembly.id, 'wall-mirror']));
    expect(result).toHaveLength(2);
    expect(result[0].requiresReview).not.toBe(true);
    const mapped = mapCandidatePass([assembly], { left: 0.2, top: 0.1, right: 0.8, bottom: 0.9 }, true)[0];
    expect(mapped.evidence.contextualParts?.lidBounds?.left).toBeCloseTo(0.644);
    expect(mapped.evidence.contextualParts?.bowlBounds?.bottom).toBeCloseTo(0.644);
    expect(assembly.evidence.contextualParts?.lidBounds?.left).toBe(0.09);
  });
  it('never upgrades an interrupted lower support to a pedestal', () => {
    const r = scoredRaster();
    r.rect(25, 15, 65, 31, 48);
    r.rect(38, 30, 52, 50, 48);
    r.rect(38, 65, 52, 78, 48);
    expect(extractReconstructionCandidates(r.input()).every((c) => !c.evidence.pedestalSupport)).toBe(true);
  });
});

it('does not let a tiny rejected fragment invalidate a measured assembly but retains whole-object conflicts', () => {
  const r = scoredRaster();
  r.rect(5, 15, 30, 52, 66);
  r.rect(9, 20, 26, 45, 28);
  r.rect(5, 50, 45, 68, 48);
  const assembly = extractReconstructionCandidates(r.input())[0];
  const tiny = candidate('tiny', 'toilet', 0.08, 0.6, 0.12, 0.64, 0.5);
  tiny.requiresReview = true;
  tiny.warning = 'small fragment';
  const merged = mergeReconstructionPasses([assembly], [tiny]);
  expect(merged).toHaveLength(1);
  expect(merged[0].requiresReview).not.toBe(true);
  const whole = candidate('whole', 'toilet', 0.05, 0.15, 0.45, 0.68, 2);
  whole.requiresReview = true;
  whole.warning = 'possible bin';
  expect(mergeReconstructionPasses([assembly], [whole])[0].requiresReview).toBe(true);
});
