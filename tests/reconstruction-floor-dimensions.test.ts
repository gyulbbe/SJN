import { describe, it, expect } from 'vitest';
import { estimateCandidateFixture } from '../src/lib/reconstruction';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import {
  reconstructionDefaults,
  type ReconstructionCandidate,
  type ReconstructionKind,
  type ReconstructionReview,
} from '../src/lib/reconstruction/types';
function candidate(kind: ReconstructionKind): ReconstructionCandidate {
  return {
    id: 'observed',
    kind,
    source: 'deeplab',
    status: 'unplaced',
    bounds: { left: 0.2, top: 0.3, right: 0.5, bottom: 0.65 },
    foot: { x: 0.35, y: 0.65 },
    color: '#eee',
    pixels: 4000,
    evidence: { semanticPixels: 4000, meanMargin: 4 },
    ...(kind === 'basin'
      ? {
          installation: {
            mode: 'floor' as const,
            basinVariant: 'pedestal' as const,
            source: 'inferred' as const,
            reason: 'observed support',
          },
        }
      : {}),
  };
}
function review(): ReconstructionReview {
  return {
    version: 2,
    analysis: 'partial',
    warnings: [],
    candidates: [],
    planes: [
      {
        id: 'source-back',
        face: 'back',
        quad: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
        geometrySource: 'room-boundaries',
        confirmed: true,
        depthStart: 0,
        depthEnd: 1,
        tile: { color: '#aaa', widthMm: 300, heightMm: 300, groutWidth: 2, estimated: true },
      },
    ],
  };
}
describe('baseline floor body size evidence', () => {
  it.each(['toilet', 'bath', 'vanity', 'basin', 'glassPartition'] as const)(
    'keeps %s defaults under a known wall rather than calling projected size a volume measurement',
    (kind) => {
      const c = candidate(kind),
        r = review(),
        original = JSON.stringify({ c, r }),
        d = reconstructionDefaults(kind, c.installation?.basinVariant);
      for (const right of [0.4, 0.9]) {
        const result = estimateCandidateFixture({ ...c, bounds: { ...c.bounds, right } }, r, DEFAULT_ROOM, {
          face: 'floor',
          u: 0.5,
          v: 0.6,
        });
        expect([result.widthMm, result.heightMm, result.depthMm]).toEqual([d.widthMm, d.heightMm, d.depthMm]);
        expect(result.provenance).toMatchObject({
          dimensions: 'default',
          width: 'default',
          height: 'default',
          depth: 'default',
        });
      }
      expect(JSON.stringify({ c, r })).toBe(original);
    },
  );
  it('uses the same category size for clipped and full observed bodies', () => {
    const c = candidate('toilet'),
      r = review(),
      placement = { face: 'floor' as const, u: 0.5, v: 0.6 };
    const full = estimateCandidateFixture(c, r, DEFAULT_ROOM, placement),
      clipped = estimateCandidateFixture(
        { ...c, bounds: { ...c.bounds, bottom: 1 } },
        r,
        DEFAULT_ROOM,
        placement,
      );
    expect([full.widthMm, full.heightMm, full.depthMm]).toEqual([
      clipped.widthMm,
      clipped.heightMm,
      clipped.depthMm,
    ]);
  });
  it('does not replace supported bowl shape observations with a size default', () => {
    const c = candidate('basin');
    c.evidence.basinShape = {
      value: 'rectangular',
      source: 'semantic-contour',
      coverage: 0.95,
      fitError: 0.001,
      curvature: 0.002,
    };
    const result = estimateCandidateFixture(c, review(), DEFAULT_ROOM, { face: 'floor', u: 0.5, v: 0.6 });
    expect(result.basinShape).toBe('rectangular');
    expect(result.provenance?.shape).toBe('inferred');
    expect(result.provenance?.dimensions).toBe('default');
  });
  it('preserves a coplanar window size estimate from a known wall', () => {
    const c = candidate('window'),
      r = review();
    const small = estimateCandidateFixture(c, r, DEFAULT_ROOM, { face: 'back', u: 0.5, v: 0.5 });
    const wide = estimateCandidateFixture({ ...c, bounds: { ...c.bounds, right: 0.9 } }, r, DEFAULT_ROOM, {
      face: 'back',
      u: 0.5,
      v: 0.5,
    });
    expect(small.widthMm).toBe(720);
    expect(wide.widthMm).toBe(1680);
    expect(small.heightMm).toBe(840);
    expect(small.provenance).toMatchObject({
      dimensions: 'inferred',
      width: 'inferred',
      height: 'inferred',
      depth: 'inferred',
    });
  });
  it('does not upgrade a wall appearance crop to measured window dimensions', () => {
    const r = review();
    r.planes[0].geometrySource = 'appearance-region';
    r.planes[0].confirmed = false;
    const result = estimateCandidateFixture(candidate('window'), r, DEFAULT_ROOM, {
      face: 'back',
      u: 0.5,
      v: 0.5,
    });
    expect([result.widthMm, result.heightMm, result.depthMm]).toEqual([1000, 800, 100]);
    expect(result.provenance?.dimensions).toBe('default');
  });
});
