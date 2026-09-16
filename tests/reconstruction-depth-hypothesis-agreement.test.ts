import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import {
  assessDepthRoomHypothesisCoverage,
  inspectDepthHypothesisAnchorAgreement,
  type DepthRoomHypothesisCoverage,
  type DepthHypothesisPlacement,
} from '../src/lib/reconstruction/depth-room-hypothesis-agreement';
import type {
  DepthPlaneObservation,
  DepthRoomObservation,
} from '../src/lib/reconstruction/depth-room-geometry';
import { unprojectSourceToFace } from '../src/lib/reconstruction/source-camera';

const fingerprint = 'a'.repeat(64);
function observation(offset = 2.03): DepthRoomObservation {
  const plane = (
    id: string,
    normalCamera: [number, number, number],
    d: number,
    point: [number, number, number],
  ): DepthPlaneObservation => ({
    id,
    normalCamera,
    offset: d,
    medianPointCamera: point,
    inlierCount: 1000,
    inlierFraction: 0.4,
    imageAreaFraction: 0.1,
    rmsResidual: 0.001,
  });
  return {
    version: 1,
    inputFingerprint: fingerprint,
    image: { width: 1000, height: 1000 },
    model: { id: 'synthetic-boundary-test', revision: '1' },
    coordinateSystem: 'opencv-camera',
    scale: 'model-estimated-metres',
    intrinsics: { fx: 1, fy: 1, cx: 0.5, cy: 0.5 },
    floor: plane('floor', [0, -1, 0], 0.7, [0, 0.7, 2]),
    walls: [
      plane('back-a', [0, 0, -1], 2, [0, 0, 2]),
      plane('back-b', [0, 0, -1], offset, [0, 0, offset]),
      plane('side', [1, 0, 0], 1, [-1, 0, 2]),
    ],
  };
}
function coverage(offset = 2.03) {
  return assessDepthRoomHypothesisCoverage(DEFAULT_ROOM, observation(offset), fingerprint);
}
function proposals(value: DepthRoomHypothesisCoverage): DepthHypothesisPlacement[] {
  const point = { x: 0.5, y: 0.95 };
  return value.hypotheses.map((hypothesis) => {
    const hit = unprojectSourceToFace(DEFAULT_ROOM, hypothesis.result.fit.camera!, point, 'floor')!;
    expect(hit.inFace).toBe(true);
    return {
      wallIds: [...hypothesis.wallIds],
      placement: {
        candidateId: 'fixture',
        status: 'estimated',
        placement: { face: 'floor', u: hit.u, v: hit.v, baseHeightMm: 0 },
        anchor: { point: { ...point }, worldMm: hit.worldMm, source: 'geometry' },
        reasons: [],
        provenance: { position: 'geometry', dimensions: 'default' },
      },
    };
  });
}

describe('candidate replay covers all valid observed walls', () => {
  it('retains separate parallel patches and leaves the common camera held', () => {
    const input = observation();
    const original = structuredClone(input);
    const result = assessDepthRoomHypothesisCoverage(DEFAULT_ROOM, input, fingerprint);
    expect(result.status).toBe('eligible');
    expect(result.strict.fit.status).toBe('held');
    expect(result.requiredWallIds).toEqual(['back-a', 'back-b', 'side']);
    expect(result.hypotheses).toHaveLength(2);
    expect(result.uncoveredWallIds).toEqual([]);
    expect(result.promotedRoomCamera).toBe(false);
    expect(input).toEqual(original);
  });
  it('cannot discard a valid wall simply because no admissible pair explains it', () => {
    const input = observation();
    input.walls.push({
      ...input.walls[0],
      id: 'angled-observation',
      normalCamera: [0.5, 0, -Math.sqrt(0.75)],
      medianPointCamera: [0, 0, 2 / Math.sqrt(0.75)],
    });
    const result = assessDepthRoomHypothesisCoverage(DEFAULT_ROOM, input, fingerprint);
    expect(result.status).toBe('held');
    expect(result.uncoveredWallIds).toEqual(['angled-observation']);
  });
  it('holds incomplete, duplicate, excessive and damaged observations', () => {
    const one = observation();
    one.walls.splice(1, 1);
    expect(assessDepthRoomHypothesisCoverage(DEFAULT_ROOM, one, fingerprint).status).toBe('held');
    const duplicated = observation();
    duplicated.walls[1].id = duplicated.walls[0].id;
    expect(assessDepthRoomHypothesisCoverage(DEFAULT_ROOM, duplicated, fingerprint).status).toBe('held');
    const oversized = observation();
    oversized.walls = Array.from({ length: 17 }, (_, i) => ({ ...oversized.walls[0], id: `wall-${i}` }));
    expect(assessDepthRoomHypothesisCoverage(DEFAULT_ROOM, oversized, fingerprint).status).toBe('held');
    const invalid = observation();
    invalid.walls[0].normalCamera[0] = NaN;
    expect(assessDepthRoomHypothesisCoverage(DEFAULT_ROOM, invalid, fingerprint).status).toBe('held');
    expect(assessDepthRoomHypothesisCoverage(DEFAULT_ROOM, observation(), 'b'.repeat(64)).status).toBe(
      'held',
    );
    const empty = observation();
    empty.walls = [];
    expect(assessDepthRoomHypothesisCoverage(DEFAULT_ROOM, empty, fingerprint).status).toBe('held');
  });
  it('never truncates an excessive set of valid hypotheses to obtain agreement', () => {
    const input = observation();
    input.walls = [
      ...Array.from({ length: 9 }, (_, i) => ({ ...input.walls[0], id: `back-${i}` })),
      input.walls[2],
    ];
    const result = assessDepthRoomHypothesisCoverage(DEFAULT_ROOM, input, fingerprint);
    expect(result.hypotheses).toHaveLength(9);
    expect(result.status).toBe('held');
    expect(result.reasons).toContain('too-many-valid-room-hypotheses');
  });
});

describe('cross-hypothesis anchor sensitivity, not camera accuracy', () => {
  it('accepts the same observation supported across close hypotheses without choosing a room camera', () => {
    const value = coverage();
    const plans = proposals(value);
    const original = structuredClone(plans);
    const result = inspectDepthHypothesisAnchorAgreement(value, plans);
    expect(result.status).toBe('consistent');
    expect(result.transfers).toHaveLength(2);
    expect(result.maxTransferErrorPx).toBeLessThan(result.pixelTolerance!);
    expect(result.establishesRoomCamera).toBe(false);
    expect(value.strict.fit.camera).toBeUndefined();
    expect(plans).toEqual(original);
  });
  it('rejects large disagreement even when both placements project perfectly in their own camera', () => {
    const value = coverage(2.4);
    const result = inspectDepthHypothesisAnchorAgreement(value, proposals(value));
    expect(result.status).toBe('held');
    expect(result.maxTransferErrorPx).toBeGreaterThan(result.pixelTolerance!);
    expect(result.reasons).toContain('anchor-changes-under-valid-room-hypotheses');
  });
  it('requires each full candidate placement, including ties, rather than selecting a successful subset', () => {
    const value = coverage();
    const plans = proposals(value);
    plans[1].placement.status = 'held';
    expect(inspectDepthHypothesisAnchorAgreement(value, plans).status).toBe('held');
    expect(inspectDepthHypothesisAnchorAgreement(value, plans.slice(0, 1)).status).toBe('held');
    expect(inspectDepthHypothesisAnchorAgreement(value, [plans[0], plans[0]]).status).toBe('held');
    const unknown = proposals(value);
    delete unknown[1].placement.anchor;
    expect(inspectDepthHypothesisAnchorAgreement(value, unknown).status).toBe('held');
  });
  it.each(['surface', 'point', 'candidate', 'manual', 'nonfinite'] as const)(
    'holds %s disagreement',
    (field) => {
      const value = coverage();
      const plans = proposals(value);
      if (field === 'surface') plans[1].placement.placement!.face = 'left';
      if (field === 'point') plans[1].placement.anchor!.point.x += 0.001;
      if (field === 'candidate') plans[1].placement.candidateId = 'other';
      if (field === 'manual') plans[1].placement.provenance.position = 'user';
      if (field === 'nonfinite') plans[1].placement.anchor!.worldMm[0] = NaN;
      expect(inspectDepthHypothesisAnchorAgreement(value, plans).status).toBe('held');
    },
  );
  it('holds malformed or mismatched hypothetical cameras', () => {
    const value = coverage();
    const plans = proposals(value);
    value.hypotheses[1].result.fit.camera!.image.width++;
    expect(inspectDepthHypothesisAnchorAgreement(value, plans).status).toBe('held');
    const malformed = coverage();
    const secondPlans = proposals(malformed);
    malformed.hypotheses[1].result.fit.camera!.quaternion = [0, 0, 0, 0];
    expect(inspectDepthHypothesisAnchorAgreement(malformed, secondPlans).status).toBe('held');
  });
});
