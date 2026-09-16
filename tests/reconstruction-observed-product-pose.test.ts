import { describe, expect, it } from 'vitest';
import {
  proposeObservedProductPose,
  type ObservedProductPoseInput,
  type ProductPosePoint,
} from '../src/lib/reconstruction/observed-product-pose';

const fingerprint = 'a'.repeat(64);
const center: ProductPosePoint = [175, 425, 1350];
const point = (
  width: ProductPosePoint,
  front: ProductPosePoint,
  x: number,
  y: number,
  z: number,
): ProductPosePoint => [center[0] + width[0] * x + front[0] * z, y, center[2] + width[2] * x + front[2] * z];
function box(yaw = 31): ObservedProductPoseInput {
  const radians = (yaw * Math.PI) / 180;
  const width: ProductPosePoint = [Math.cos(radians), 0, -Math.sin(radians)];
  const front: ProductPosePoint = [Math.sin(radians), 0, Math.cos(radians)];
  const samples: ObservedProductPoseInput['samples'] = [];
  for (let i = 0; i <= 30; i++)
    for (let j = 0; j <= 20; j++) {
      samples.push({
        pointWorldMm: point(width, front, -600 + i * 40, 80 + j * 35, 275),
        normalWorld: [...front],
        semanticLabel: 11,
      });
      samples.push({
        pointWorldMm: point(width, front, 600, 80 + j * 35, -275 + (i * 550) / 30),
        normalWorld: [...width],
        semanticLabel: 11,
      });
    }
  const backPoint = point(width, front, 0, 500, -375);
  return {
    version: 1,
    inputFingerprint: fingerprint,
    coordinateSystem: 'model-world-mm',
    candidateId: 'synthetic-box',
    kind: 'vanity',
    samples,
    knownDimensions: { widthMm: 1200, depthMm: 550, heightMm: 850, provenance: 'catalog' },
    walls: [
      {
        id: 'observed-back',
        normalWorld: [...front],
        offsetMm: -(front[0] * backPoint[0] + front[2] * backPoint[2]),
        medianPointWorldMm: backPoint,
        inlierCount: 1000,
        rmsResidualMm: 3,
      },
    ],
    evidence: {
      association: 'same-kind-mask-in-candidate',
      reflections: 'known-regions-excluded',
      contamination: 'none-detected',
    },
  };
}
const codes = (result: ReturnType<typeof proposeObservedProductPose>) =>
  result.reasons.map((reason) => reason.code);

describe('experimental observed cabinet horizontal pose', () => {
  it.each([0, 31, 117, 244])(
    'fits fixed dimensions from two outward surfaces at yaw %s only when front is independently supplied',
    (yaw) => {
      const input = box(yaw);
      input.frontDirectionWorld = { direction: [...input.walls[0].normalWorld], provenance: 'user' };
      const before = structuredClone(input);
      const result = proposeObservedProductPose(input, fingerprint);
      expect(result.status, JSON.stringify(result)).toBe('proposed');
      expect(result.alternatives).toHaveLength(1);
      const pose = result.alternatives[0];
      expect(pose.yawDegrees).toBeCloseTo(yaw, 7);
      expect(pose.centerXZMm[0]).toBeCloseTo(center[0], 7);
      expect(pose.centerXZMm[1]).toBeCloseTo(center[2], 7);
      expect(pose.dimensions).toEqual(input.knownDimensions);
      expect(pose.fit.containedBodyFraction).toBe(1);
      expect(pose.fit.verticalSurfaceResidualP95Mm).toBeLessThan(1e-6);
      expect(pose).not.toHaveProperty('centerWorldMm');
      expect(result.automaticPlacement).toBe(false);
      expect(result.scale).toBe('model-estimated-not-measured');
      expect(input).toEqual(before);
    },
  );

  it('retains 180-degree alternatives without treating the visible or nearest-wall face as the semantic front', () => {
    const result = proposeObservedProductPose(box(), fingerprint);
    expect(result.status).toBe('held');
    expect(codes(result)).toContain('front-back-ambiguous');
    expect(result.alternatives).toHaveLength(2);
    expect(Math.abs(result.alternatives[0].yawDegrees - result.alternatives[1].yawDegrees)).toBeCloseTo(
      180,
      7,
    );
    expect(result.alternatives[0].centerXZMm[0]).toBeCloseTo(result.alternatives[1].centerXZMm[0], 7);
    expect(result.alternatives[0].centerXZMm[1]).toBeCloseTo(result.alternatives[1].centerXZMm[1], 7);
  });

  it('uses a separately confirmed rear-to-wall relation, not wall proximity, to resolve front/back', () => {
    const input = box();
    input.backWallRelation = { wallId: 'observed-back', provenance: 'independent-observation' };
    const result = proposeObservedProductPose(input, fingerprint);
    expect(result.status, JSON.stringify(result)).toBe('proposed');
    expect(result.alternatives[0].yawDegrees).toBeCloseTo(31, 7);
    expect(result.alternatives[0].fit.directionEvidence).toBe('explicit-back-wall');
  });

  it('does not invent dimensions or a center from visible extents', () => {
    const input = box();
    delete input.knownDimensions;
    const result = proposeObservedProductPose(input, fingerprint);
    expect(codes(result)).toContain('unknown-dimensions');
    expect(result.axes).toBeDefined();
    expect(result.observedBounds?.meaning).toBe('visible-body-surfaces-only');
    expect(result.alternatives).toEqual([]);
  });

  it('rejects smaller fixed dimensions without scaling samples or changing user/catalog/default sizes', () => {
    const input = box();
    input.knownDimensions = { widthMm: 500, depthMm: 300, heightMm: 850, provenance: 'default' };
    const before = structuredClone(input.knownDimensions);
    const result = proposeObservedProductPose(input, fingerprint);
    expect(codes(result)).toContain('fixed-dimensions-inconsistent');
    expect(result.alternatives).toEqual([]);
    expect(result.diagnostics.rejectedFits).toHaveLength(4);
    expect(input.knownDimensions).toEqual(before);
  });

  it('checks supplied height against the observed span without manufacturing a vertical center', () => {
    const input = box();
    input.knownDimensions!.heightMm = 200;
    const result = proposeObservedProductPose(input, fingerprint);
    expect(codes(result)).toContain('fixed-dimensions-inconsistent');
    expect(result.alternatives).toEqual([]);
  });

  it('cannot recover hidden horizontal extents from one plane', () => {
    const input = box();
    input.samples = input.samples.filter((_, index) => index % 2 === 0);
    const result = proposeObservedProductPose(input, fingerprint);
    expect(codes(result)).toContain('single-plane-only');
    expect(result.alternatives).toEqual([]);
  });

  it('holds tiny partial product fragments even if their normals have two directions', () => {
    const input = box();
    for (const sample of input.samples) {
      sample.pointWorldMm[0] = center[0] + (sample.pointWorldMm[0] - center[0]) * 0.02;
      sample.pointWorldMm[2] = center[2] + (sample.pointWorldMm[2] - center[2]) * 0.02;
    }
    const result = proposeObservedProductPose(input, fingerprint);
    expect(result.status).toBe('held');
    expect(codes(result)).toContain('non-planar-or-mixed-surfaces');
    expect(result.alternatives).toEqual([]);
  });

  it('keeps same-direction surfaces at two incompatible offsets from masquerading as one cabinet plane', () => {
    const input = box();
    input.samples.push(
      ...input.samples.map((sample) => ({
        ...sample,
        pointWorldMm: sample.pointWorldMm.map((v, axis) => v + (axis === 1 ? 0 : 4000)) as ProductPosePoint,
      })),
    );
    const result = proposeObservedProductPose(input, fingerprint);
    expect(result.status).toBe('held');
    expect(codes(result)).toContain('non-planar-or-mixed-surfaces');
    expect(result.alternatives).toEqual([]);
  });

  it.each(['unassessed', 'detected'] as const)(
    'returns axes and candidates but keeps contamination %s held',
    (contamination) => {
      const input = box();
      input.evidence.contamination = contamination;
      input.frontDirectionWorld = { direction: input.walls[0].normalWorld, provenance: 'user' };
      const result = proposeObservedProductPose(input, fingerprint);
      expect(result.status).toBe('held');
      expect(codes(result)).toContain('contamination-unresolved');
      expect(result.axes).toBeDefined();
      expect(result.alternatives).toHaveLength(1);
    },
  );

  it('keeps unresolved reflection held, even with independent front evidence', () => {
    const input = box();
    input.evidence.reflections = 'unresolved';
    input.frontDirectionWorld = { direction: input.walls[0].normalWorld, provenance: 'user' };
    const result = proposeObservedProductPose(input, fingerprint);
    expect(result.status).toBe('held');
    expect(codes(result)).toContain('reflection-unresolved');
    expect(result.axes).toBeDefined();
  });

  it('keeps sink/other semantic pixels outside the cabinet fit, regardless of their positions', () => {
    const input = box();
    const base = proposeObservedProductPose(input, fingerprint);
    input.samples.push(
      { pointWorldMm: [900000, -1000, 900000], normalWorld: [0, 0, 1], semanticLabel: 48 },
      { pointWorldMm: [800000, 1000, 800000], normalWorld: [1, 0, 0], semanticLabel: 4 },
    );
    const result = proposeObservedProductPose(input, fingerprint);
    expect(result.observedBounds).toEqual(base.observedBounds);
    expect(result.alternatives).toEqual(base.alternatives);
    expect(result.diagnostics.sinkSamplesExcludedFromBoxFit).toBe(1);
    expect(result.diagnostics.otherSemanticSamplesExcluded).toBe(1);
  });

  it('requires an independently observed wall and does not promote a synthetic room border to wall evidence', () => {
    const input = box();
    input.walls = [];
    const result = proposeObservedProductPose(input, fingerprint);
    expect(result.status).toBe('held');
    expect(codes(result)).toContain('observed-wall-missing');
    expect(result.axes).toBeDefined();
  });

  it('reports an intersection without clamping the fixed-size box into the wall', () => {
    const input = box(0);
    input.walls[0].medianPointWorldMm = [0, 500, center[2]];
    input.walls[0].offsetMm = -center[2];
    const result = proposeObservedProductPose(input, fingerprint);
    expect(codes(result)).toContain('wall-intersection');
    expect(result.alternatives).toEqual([]);
    expect(result.diagnostics.rejectedFits.filter((fit) => fit.code === 'wall-intersection')).toHaveLength(2);
  });

  it('holds contradictory explicit orientation observations', () => {
    const input = box();
    input.frontDirectionWorld = {
      direction: input.walls[0].normalWorld.map((v) => -v) as ProductPosePoint,
      provenance: 'user',
    };
    input.backWallRelation = { wallId: 'observed-back', provenance: 'user' };
    const result = proposeObservedProductPose(input, fingerprint);
    expect(codes(result)).toContain('front-evidence-inconsistent');
    expect(result.alternatives).toEqual([]);
  });

  it('checks the input hash before interpreting any surface data', () => {
    const result = proposeObservedProductPose(box(), 'b'.repeat(64));
    expect(codes(result)).toEqual(['fingerprint-mismatch']);
    expect(result.axes).toBeUndefined();
    expect(result.alternatives).toEqual([]);
  });

  it('holds invalid normals rather than normalizing corrupt input into plausible evidence', () => {
    const input = box();
    for (const sample of input.samples) sample.normalWorld = [NaN, 0, 1];
    const result = proposeObservedProductPose(input, fingerprint);
    expect(codes(result)).toContain('invalid-input');
    expect(result.alternatives).toEqual([]);
  });
});
