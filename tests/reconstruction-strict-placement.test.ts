import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import {
  inspectStrictPlacement,
  confirmedPlacementProvenance,
} from '../src/lib/reconstruction/strict-placement';
import { estimateCandidateFixture } from '../src/lib/reconstruction';
import { frontContactToCentre, projectReconstructionFixture } from '../src/lib/reconstruction/projection';
import { reconstructionReviewSchema } from '../src/lib/storage/validation';
import type { ReconstructionCandidate } from '../src/lib/reconstruction/types';
import { DEFAULT_COLOR, EMPTY_MASK, type FixtureInstance } from '../src/lib/types';

const candidate: ReconstructionCandidate = {
  id: 'candidate',
  kind: 'basin',
  bounds: { left: 0.1, top: 0.2, right: 0.3, bottom: 0.5 },
  foot: { x: 0.2, y: 0.5 },
  color: '#ddddee',
  pixels: 300,
  evidence: { semanticPixels: 300, meanMargin: 1 },
  status: 'unplaced',
  installation: { mode: 'floor', basinVariant: 'pedestal', source: 'inferred', reason: 'observed stem' },
};
const floor = {
  kind: 'toilet' as const,
  version: 2 as const,
  face: 'floor' as const,
  u: 0.5,
  v: 0.5,
  widthMm: 420,
  heightMm: 810,
  depthMm: 690,
  baseHeightMm: 0,
};

describe('photo placement validates unchanged requests', () => {
  it('retains outside-room dimensions, anchor and physical overflow instead of fitting', () => {
    const requested = { ...floor, u: 0.01, widthMm: 3100 };
    const original = structuredClone(requested);
    const result = inspectStrictPlacement(DEFAULT_ROOM, requested);
    expect(result.status).toBe('held');
    expect(result.requested.u).toBe(0.01);
    expect(result.requested.widthMm).toBe(3100);
    expect(result.overflowMm!.left).toBeGreaterThan(1000);
    expect(requested).toEqual(original);
    expect(result).not.toHaveProperty('projectedBounds');
    expect(result).not.toHaveProperty('bboxErrorPx');
  });
  it('accepts nominal roundoff tolerance without moving the anchor', () => {
    const request = { ...floor, u: (210 - 0.5) / DEFAULT_ROOM.widthMm };
    const result = inspectStrictPlacement(DEFAULT_ROOM, request);
    expect(result.status).toBe('accepted');
    expect(result.requested.u).toBe(request.u);
    expect(result.overflowMm!.left).toBeCloseTo(0.5);
  });
  it('keeps explicit wall height and rejects an inconsistent vertical coordinate', () => {
    const result = inspectStrictPlacement(DEFAULT_ROOM, {
      ...floor,
      kind: 'mirror',
      face: 'back',
      baseHeightMm: 1300,
      v: 0.5,
    });
    expect(result.status).toBe('held');
    expect(result.requested.baseHeightMm).toBe(1300);
    expect(result.reasons).toContain('벽의 세로 위치와 설치 높이가 서로 다릅니다.');
  });
  it('keeps the inferred front-contact conversion even when its centre lies outside', () => {
    const review = {
      version: 2 as const,
      analysis: 'partial' as const,
      planes: [],
      candidates: [candidate],
      warnings: [],
    };
    const placement = { face: 'floor' as const, u: 0.02, v: 0.03 };
    const estimate = estimateCandidateFixture(candidate, review, DEFAULT_ROOM, placement);
    const original = frontContactToCentre(DEFAULT_ROOM, placement, estimate.depthMm, 'back');
    expect(estimate.u).toBe(original.u);
    expect(estimate.v).toBe(original.v);
    expect(estimate.v).toBeLessThan(0);
    expect(
      inspectStrictPlacement(DEFAULT_ROOM, {
        ...estimate,
        ...placement,
        u: estimate.u,
        v: estimate.v,
        kind: 'basin',
        version: 2,
      }).status,
    ).toBe('held');
  });
  it('preserves an over-height default until physical validation, not a shorter synthetic product', () => {
    const mirror = {
      ...candidate,
      kind: 'mirror' as const,
      installation: {
        mode: 'wall' as const,
        wall: 'back' as const,
        source: 'inferred' as const,
        reason: 'appearance only',
      },
    };
    const room = { ...DEFAULT_ROOM, heightMm: 1100 };
    const review = {
      version: 2 as const,
      analysis: 'partial' as const,
      planes: [],
      candidates: [mirror],
      warnings: [],
    };
    const estimate = estimateCandidateFixture(mirror, review, room, { face: 'back', u: 0.5, v: 0.3 });
    expect(estimate.baseHeightMm! + estimate.heightMm).toBeGreaterThan(room.heightMm);
    expect(
      inspectStrictPlacement(room, { ...estimate, kind: 'mirror', version: 2, face: 'back' }).status,
    ).toBe('held');
  });
  it('serializes a held request beyond the unit interval without accepting it as a fixture', () => {
    const placementReview = inspectStrictPlacement(DEFAULT_ROOM, { ...floor, u: -0.12, baseHeightMm: -25 });
    const parsed = reconstructionReviewSchema.parse({
      version: 2,
      analysis: 'partial',
      planes: [],
      candidates: [{ ...candidate, placementReview }],
      warnings: [],
    });
    expect(parsed.candidates[0].placementReview).toEqual(placementReview);
  });
  it('reprojection never alters a persisted preserve fixture but keeps manual legacy fitting', () => {
    const make = (preserve: boolean) =>
      ({
        id: 'f',
        name: 'fixture',
        materialVersionId: 'm',
        viewIndex: 0,
        position: { x: 0.5, y: 0.5 },
        width: 0.1,
        height: 0.1,
        rotation: 0,
        anchor: { x: 0.5, y: 1 },
        locked: false,
        shadow: { x: 0, y: 0, opacity: 0, blur: 0, scale: 1 },
        occlusion: EMPTY_MASK(),
        color: { ...DEFAULT_COLOR },
        roomPlacement: {
          face: 'floor',
          u: 0.01,
          v: 0.01,
          widthMm: 420,
          heightMm: 810,
          scale: 1,
          imageAspect: 1,
          contentBounds: { left: 0, top: 0, right: 1, bottom: 1 },
        },
        reconstruction: { ...floor, color: '#ffffff', placementPolicy: preserve ? 'preserve' : undefined },
      }) as FixtureInstance;
    const strict = make(true),
      manual = make(false);
    const before = structuredClone(strict.roomPlacement);
    projectReconstructionFixture(DEFAULT_ROOM, strict, 1.5);
    projectReconstructionFixture(DEFAULT_ROOM, strict, 1.5);
    expect(strict.roomPlacement).toEqual(before);
    projectReconstructionFixture(DEFAULT_ROOM, manual, 1.5);
    expect(manual.roomPlacement!.u).toBeGreaterThan(0.01);
  });
});

describe('held candidate correction provenance and storage limits', () => {
  it('position-only correction does not relabel inferred or default dimensions', () => {
    const review = inspectStrictPlacement(DEFAULT_ROOM, {
      ...floor,
      provenance: {
        position: 'inferred',
        width: 'inferred',
        height: 'default',
        depth: 'default',
        dimensions: 'default',
      },
    });
    const corrected = confirmedPlacementProvenance(review.requested, { u: 0.6, baseHeightMm: 0 });
    expect(corrected).toMatchObject({
      position: 'user',
      width: 'inferred',
      height: 'default',
      depth: 'default',
      dimensions: 'default',
    });
    expect(confirmedPlacementProvenance(review.requested, {})).toEqual({ ...review.requested.provenance });
    expect(confirmedPlacementProvenance(review.requested, { depthMm: 700 })).toMatchObject({
      width: 'inferred',
      height: 'default',
      depth: 'user',
      dimensions: 'user',
    });
  });
  it.each([NaN, Infinity, 1e9])(
    'rejects unsavable review values (%s) while the existing finite proposal stays valid',
    (value) => {
      const original = inspectStrictPlacement(DEFAULT_ROOM, { ...floor, u: 0.001 });
      const review = {
        version: 2,
        analysis: 'partial',
        planes: [],
        candidates: [{ ...candidate, placementReview: original }],
        warnings: [],
      };
      const before = JSON.stringify(review);
      const invalid = inspectStrictPlacement(DEFAULT_ROOM, { ...floor, widthMm: value });
      expect(
        reconstructionReviewSchema.safeParse({
          ...review,
          candidates: [{ ...candidate, placementReview: invalid }],
        }).success,
      ).toBe(false);
      expect(JSON.stringify(review)).toBe(before);
      expect(reconstructionReviewSchema.safeParse(review).success).toBe(true);
    },
  );
});
