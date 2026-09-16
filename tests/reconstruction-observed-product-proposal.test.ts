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
    knownDimensions: { widthMm: 1200, depthMm: 550, heightMm: 850, provenance: 'default' },
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
import {
  proposeObservedProductProposal,
  type ObservedProductProposalContext,
} from '../src/lib/reconstruction/observed-product-proposal';

const context = (): ObservedProductProposalContext => ({
  room: { kind: 'parametric', version: 1, widthMm: 4000, depthMm: 4000, heightMm: 2400 },
  expectedFingerprint: fingerprint,
  baseHeightMm: 0,
  sources: {
    inputFingerprint: fingerprint,
    pointsSha256: 'b'.repeat(64),
    labelsSha256: 'c'.repeat(64),
    cameraSha256: 'd'.repeat(64),
  },
});
const codes = (result: ReturnType<typeof proposeObservedProductProposal>) =>
  result.reasons.map((r) => r.code);

describe('separate observed visible-surface product proxy', () => {
  it.each([0, 31, 117, 244])(
    'keeps strict default mismatch and four physical interpretations at yaw %s',
    (yaw) => {
      const input = box(yaw);
      input.knownDimensions = { widthMm: 500, depthMm: 300, heightMm: 850, provenance: 'default' };
      const before = structuredClone(input);
      const result = proposeObservedProductProposal(input, context());
      expect(result.status, JSON.stringify(result)).toBe('review-required');
      expect(result.fixedCheck).toEqual(proposeObservedProductPose(input, fingerprint));
      expect(result.fixedCheck.reasons.map((r) => r.code)).toContain('fixed-dimensions-inconsistent');
      expect(result.alternatives).toHaveLength(4);
      expect(new Set(result.alternatives.map((a) => a.id)).size).toBe(4);
      for (const a of result.alternatives) {
        expect(a.centerXZMm[0]).toBeCloseTo(center[0], 7);
        expect(a.centerXZMm[1]).toBeCloseTo(center[2], 7);
        expect([a.widthMm, a.depthMm].sort((a, b) => a - b)[0]).toBeCloseTo(550, 7);
        expect([a.widthMm, a.depthMm].sort((a, b) => a - b)[1]).toBeCloseTo(1200, 7);
        expect(a.heightMm).toBe(850);
        expect(a.sources.front).toBe('user-choice-required');
        expect(a.fit.containedBodyFraction).toBe(1);
      }
      expect(Math.abs(result.alternatives[0].yawDegrees - result.alternatives[2].yawDegrees)).toBeCloseTo(
        180,
        7,
      );
      expect(input).toEqual(before);
    },
  );

  it.each(['user', 'catalog'] as const)('never replaces %s dimensions', (provenance) => {
    const input = box();
    input.knownDimensions = { widthMm: 500, depthMm: 300, heightMm: 850, provenance };
    const before = structuredClone(input);
    const result = proposeObservedProductProposal(input, context());
    expect(codes(result)).toContain('locked-dimensions');
    expect(result.alternatives).toEqual([]);
    expect(result.fixedCheck).toEqual(proposeObservedProductPose(input, fingerprint));
    expect(input).toEqual(before);
  });

  it('retains source identity and unseen limits without recording nonexistent user acceptance', () => {
    const input = box();
    const result = proposeObservedProductProposal(input, context());
    expect(result.proposalId).toBe(proposeObservedProductProposal(input, context()).proposalId);
    const changed = context();
    changed.sources.labelsSha256 = 'e'.repeat(64);
    expect(result.proposalId).not.toBe(proposeObservedProductProposal(input, changed).proposalId);
    expect(result.provenance.sources).toEqual(context().sources);
    expect(result.provenance.originalDimensions).toEqual(input.knownDimensions);
    expect(result.provenance.measured).toBe(false);
    expect(result.provenance.automaticallyApplied).toBe(false);
    expect(result.provenance.lockedDimensionsChanged).toBe(false);
    expect(result).not.toHaveProperty('adoptedByUser');
    expect(result).not.toHaveProperty('samples');
    expect(result.dimensionEvidence).toHaveLength(2);
    for (const d of result.dimensionEvidence) {
      expect(d.completeDimension.upperMm).toBeNull();
      expect(d.completeDimension.endpoints).toBe('unverified-may-be-occluded-or-clipped');
      expect(d.completeDimension.minimumSupportedSpanMm).toBe(d.observedTangentSpanMm);
    }
    expect(result.requiredConfirmations).toContain('unseen-extents-use-visible-proxy');
    expect(result.requiredConfirmations).toContain('model-scale-is-unmeasured');
  });

  it('requires same-product review for unassessed semantics rather than claiming automatic reconstruction', () => {
    const input = box();
    input.evidence.contamination = 'unassessed';
    const result = proposeObservedProductProposal(input, context());
    expect(result.status).toBe('review-required');
    expect(codes(result)).toContain('same-product-confirmation-required');
    expect(result.fixedCheck.status).toBe('held');
  });

  it.each(['reflection', 'contamination'])('holds known unsafe %s surfaces', (reason) => {
    const input = box();
    if (reason === 'reflection') input.evidence.reflections = 'unresolved';
    else input.evidence.contamination = 'detected';
    const result = proposeObservedProductProposal(input, context());
    expect(codes(result)).toContain('unsafe-surface-association');
    expect(result.alternatives).toEqual([]);
  });

  it('excludes sink parts and other semantic classes from the cabinet box fit', () => {
    const input = box();
    const expected = proposeObservedProductProposal(input, context());
    input.samples.push(
      ...[48, 7].map((semanticLabel) => ({
        pointWorldMm: [9999, 9999, 9999] as ProductPosePoint,
        normalWorld: [1, 0, 0] as ProductPosePoint,
        semanticLabel,
      })),
    );
    const result = proposeObservedProductProposal(input, context());
    expect(result.alternatives).toEqual(expected.alternatives);
    expect(result.fixedCheck.diagnostics.sinkSamplesExcludedFromBoxFit).toBe(1);
    expect(result.fixedCheck.diagnostics.otherSemanticSamplesExcluded).toBe(1);
  });

  it('holds one observed face instead of inventing hidden depth', () => {
    const input = box();
    input.samples = input.samples.filter((_, i) => i % 2 === 0);
    const result = proposeObservedProductProposal(input, context());
    expect(codes(result)).toContain('insufficient-independent-faces');
    expect(result.alternatives).toEqual([]);
  });

  it('uses each face tangent extent despite a large imbalance of projected surface pixels', () => {
    const input = box();
    const expected = proposeObservedProductProposal(input, context()).alternatives[0];
    const end = input.samples.filter((_, i) => i % 2 === 1);
    input.samples.push(...Array.from({ length: 6 }, () => end).flat());
    const result = proposeObservedProductProposal(input, context());
    expect(result.status, JSON.stringify(result)).toBe('review-required');
    for (const a of result.alternatives) {
      expect(a.centerXZMm[0]).toBeCloseTo(expected.centerXZMm[0], 7);
      expect(a.centerXZMm[1]).toBeCloseTo(expected.centerXZMm[1], 7);
      expect(Math.min(a.widthMm, a.depthMm)).toBeCloseTo(550, 7);
      expect(Math.max(a.widthMm, a.depthMm)).toBeCloseTo(1200, 7);
    }
  });

  it('does not resize or clamp a proxy that crosses the physical room boundary', () => {
    const ctx = context();
    ctx.room.widthMm = 1000;
    const result = proposeObservedProductProposal(box(0), ctx);
    expect(result.status).toBe('held');
    expect(result.alternatives).toEqual([]);
    expect(result.rejectedAlternatives).toHaveLength(4);
    expect(result.rejectedAlternatives.every((a) => a.codes.includes('room-bounds-inconsistent'))).toBe(true);
    expect(Math.max(...result.dimensionEvidence.map((d) => d.proxySpanMm))).toBeCloseTo(1200, 7);
  });

  it('rejects an observed wall intersection without moving the product inward', () => {
    const input = box(0);
    input.walls[0].medianPointWorldMm[2] = center[2];
    input.walls[0].offsetMm = -center[2];
    const result = proposeObservedProductProposal(input, context());
    expect(result.alternatives).toEqual([]);
    expect(result.rejectedAlternatives.every((a) => a.codes.includes('observed-wall-intersection'))).toBe(
      true,
    );
  });

  it('rejects invalid wall evidence rather than silently using its half-space', () => {
    const input = box();
    input.walls.push({ ...input.walls[0], id: 'invalid', normalWorld: [2, 0, 0] });
    const result = proposeObservedProductProposal(input, context());
    expect(codes(result)).toContain('invalid-observed-wall');
    expect(result.alternatives).toEqual([]);
  });

  it('preserves a too-short default height and reports that it cannot fit the observed body', () => {
    const input = box();
    input.knownDimensions!.heightMm = 200;
    const result = proposeObservedProductProposal(input, context());
    expect(result.alternatives).toEqual([]);
    expect(result.rejectedAlternatives).toHaveLength(4);
    expect(
      result.rejectedAlternatives.every((a) => a.codes.includes('default-height-or-support-inconsistent')),
    ).toBe(true);
    expect(input.knownDimensions!.heightMm).toBe(200);
  });

  it('does not manufacture a default height from visible vertical bounds', () => {
    const input = box();
    delete input.knownDimensions!.heightMm;
    const result = proposeObservedProductProposal(input, context());
    expect(codes(result)).toContain('default-height-unavailable');
    expect(result.alternatives).toEqual([]);
  });

  it.each(['input', 'labels', 'camera', 'context'])('holds mismatched or malformed %s provenance', (part) => {
    const input = box();
    const ctx = context();
    if (part === 'input') input.inputFingerprint = 'f'.repeat(64);
    if (part === 'labels') ctx.sources.labelsSha256 = 'not-a-hash';
    if (part === 'camera') ctx.sources.cameraSha256 = '';
    if (part === 'context') ctx.sources.inputFingerprint = 'f'.repeat(64);
    const result = proposeObservedProductProposal(input, ctx);
    expect(result.status).toBe('held');
    expect(result.alternatives).toEqual([]);
  });
});
