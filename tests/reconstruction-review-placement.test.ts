import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import { reviewPlacementPoint, reviewPlacementPresets } from '../src/lib/reconstruction/review-placement';
import {
  confirmedPlacementProvenance,
  type PlacementReview,
} from '../src/lib/reconstruction/strict-placement';
import { reconstructionModelTransform } from '../src/lib/reconstruction/projection';

const request: PlacementReview['requested'] = {
  kind: 'toilet',
  face: 'floor',
  u: -0.1,
  v: -0.2,
  widthMm: 400,
  heightMm: 750,
  depthMm: 680,
  orientation: 'back',
  provenance: { width: 'default', height: 'default', depth: 'default', position: 'inferred' },
};
describe('explicit review placement alternatives', () => {
  it('offers three labelled defaults without mutating the invalid original or fitting its dimensions', () => {
    const before = structuredClone(request);
    const presets = reviewPlacementPresets(DEFAULT_ROOM, request);
    expect(presets.map((p) => p.wall)).toEqual(['back', 'left', 'right']);
    for (const { proposal, valid } of presets) {
      expect(valid).toBe(true);
      expect(proposal).toMatchObject({
        widthMm: 400,
        heightMm: 750,
        depthMm: 680,
        provenance: request.provenance,
      });
    }
    expect(request).toEqual(before);
  });
  it('uses actual rear-to-wall distance with each render orientation', () => {
    for (const p of reviewPlacementPresets(DEFAULT_ROOM, request)) {
      const { origin } = reconstructionModelTransform(DEFAULT_ROOM, { ...p.proposal, version: 2 });
      const rearDistance =
        p.wall === 'back'
          ? origin.z - 340
          : p.wall === 'left'
            ? origin.x + 1200 - 340
            : 1200 - origin.x - 340;
      expect(rearDistance).toBeCloseTo(50);
    }
  });
  it('shows impossible models as unavailable instead of shrinking or moving them', () => {
    const presets = reviewPlacementPresets(DEFAULT_ROOM, { ...request, widthMm: 9000 });
    expect(presets.every((p) => !p.valid && p.proposal.widthMm === 9000)).toBe(true);
  });
  it('keeps scale and uses scaled rear clearance', () => {
    const p = reviewPlacementPresets(DEFAULT_ROOM, { ...request, scale: 1.5 })[0];
    expect(p.proposal.scale).toBe(1.5);
    expect(p.proposal.v * DEFAULT_ROOM.depthMm).toBeCloseTo(50 + (680 * 1.5) / 2);
  });
  it('does not offer floor defaults for attached or wall fixtures', () => {
    expect(reviewPlacementPresets(DEFAULT_ROOM, { ...request, face: 'back' })).toEqual([]);
    expect(
      reviewPlacementPresets(DEFAULT_ROOM, {
        ...request,
        support: { kind: 'shower-curb', heightMm: 100, provenance: { kind: 'user', height: 'user' } },
      }),
    ).toEqual([]);
  });
  it('records an explicitly changed installation wall without claiming measured dimensions', () => {
    const provenance = confirmedPlacementProvenance({ ...request, face: 'back' }, { face: 'left' });
    expect(provenance).toMatchObject({
      wall: 'user',
      position: 'user',
      width: 'default',
      height: 'default',
      depth: 'default',
    });
  });
  it('links one wall click to the bottom height, retaining invalid geometry for validation', () => {
    expect(reviewPlacementPoint(DEFAULT_ROOM, { ...request, face: 'left' }, { u: 0.8, v: 0.7 })).toEqual({
      u: 0.8,
      v: 0.7,
      baseHeightMm: (1 - 0.7) * 2400,
    });
    expect(reviewPlacementPoint(DEFAULT_ROOM, request, { u: 0, v: 0 })).toEqual({ u: 0, v: 0 });
  });
});
