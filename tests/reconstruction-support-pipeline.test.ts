import { describe, expect, it } from 'vitest';
import { PerspectiveCamera } from 'three';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import { buildCandidatePipeline } from '../src/lib/reconstruction/candidate-pipeline';
import {
  projectSourcePoint,
  sourceRoomCornerPoint,
  type SourceCamera,
} from '../src/lib/reconstruction/source-camera';
import type {
  SceneCandidate,
  SceneUnderstanding,
  SourceRoomCorner,
} from '../src/lib/reconstruction/pipeline-contract';
import type { ReconstructionReview } from '../src/lib/reconstruction/types';
import type { Quad } from '../src/lib/types';

const room = { ...DEFAULT_ROOM };
const perspective = new PerspectiveCamera(62, 1.2, 1, 1e7);
perspective.position.set(450, 1450, 4800);
perspective.lookAt(0, 1100, 0);
perspective.updateMatrixWorld(true);
const source: SourceCamera = {
  version: 1,
  image: { width: 1200, height: 1000 },
  verticalFovDegrees: 62,
  positionMm: perspective.position.toArray(),
  quaternion: perspective.quaternion.toArray(),
};
const identity = { candidateInputFingerprint: 'a'.repeat(64), observationInputFingerprint: 'a'.repeat(64) };

function sample(calibrated = true) {
  const foot = projectSourcePoint(source, [0, 0, room.depthMm / 2]).point;
  const top = projectSourcePoint(source, [0, 800, room.depthMm / 2]).point.y;
  const bounds = { left: foot.x - 0.09, right: foot.x + 0.09, top, bottom: top + (foot.y - top) * 0.4 };
  const candidate: SceneCandidate = {
    id: 'bowl',
    kind: 'basin',
    bounds,
    mounting: 'unknown',
    wall: 'unknown',
    basinStyle: 'pedestal',
    shape: 'rectangular',
    reflection: 'physical',
    evidence: ['synthetic bowl-only observation'],
    uncertainty: [],
  };
  const corners: SourceRoomCorner[] = [
    'back-top-left',
    'back-top-right',
    'back-bottom-right',
    'back-bottom-left',
  ];
  const scene: SceneUnderstanding = {
    schemaVersion: 1,
    candidates: [candidate],
    relations: [],
    roomLayout: {
      orthogonal: true,
      backWallQuad: calibrated
        ? (corners.map((c) => projectSourcePoint(source, sourceRoomCornerPoint(room, c)).point) as Quad)
        : null,
      evidence: ['synthetic room observations'],
      uncertainty: [],
    },
  };
  const baseline: ReconstructionReview = {
    version: 2,
    analysis: 'partial',
    warnings: [],
    planes: [],
    candidates: [
      {
        id: 'segmented-basin-with-stem',
        kind: 'basin',
        source: 'deeplab',
        bounds: { ...bounds, bottom: foot.y },
        foot,
        color: '#eeeeee',
        pixels: 1200,
        status: 'unplaced',
        evidence: {
          semanticPixels: 1200,
          meanMargin: 4,
          pedestalSupport: { stemWidthRatio: 0.3, stemHeightRatio: 0.5, coverage: 0.96 },
        },
        installation: {
          mode: 'floor',
          basinVariant: 'pedestal',
          source: 'inferred',
          reason: 'synthetic continuous stem',
        },
      },
    ],
  };
  return { scene, candidate, baseline, foot };
}
function run(data: ReturnType<typeof sample>, withIdentity = true, manual = {}) {
  return buildCandidatePipeline(
    data.scene,
    data.baseline,
    room,
    source.image,
    manual,
    data.scene,
    {},
    undefined,
    withIdentity ? identity : undefined,
  );
}

describe('independent support flows into actual candidate plans', () => {
  it('keeps a matched installation when the camera and every position are held', () => {
    const data = sample(false),
      original = structuredClone(data);
    const result = run(data);
    expect(result.pipeline.camera.status).toBe('held');
    expect(result.plans.bowl).toBeNull();
    expect(result.review.candidates[0].installation).toMatchObject({
      mode: 'floor',
      basinVariant: 'pedestal',
      source: 'inferred',
    });
    expect(result.pipeline.observedInstallationChecks?.[0].installation?.mode).toBe('floor');
    expect(result.pipeline.observedSupportChecks?.[0].contact?.point).toEqual(data.foot);
    expect(result.pipeline.placements[0].reasons.join(' ')).not.toContain('바닥 또는 벽 설치 위치');
    expect(data).toEqual(original);
    expect(result.pipeline.automaticUnderstanding).toEqual(original.scene);
  });

  it('projects the independently observed stem bottom, preserving the bowl box and model anchor absence', () => {
    const data = sample(),
      original = structuredClone(data);
    const result = run(data),
      placement = result.pipeline.placements[0];
    expect(result.plans.bowl).toMatchObject({
      face: 'floor',
      basinVariant: 'pedestal',
      basinShape: 'rectangular',
      baseHeightMm: 0,
    });
    expect(result.plans.bowl!.u).toBeCloseTo(0.5, 5);
    expect(result.plans.bowl!.v).toBeCloseTo(0.5, 5);
    expect(placement.anchor?.point).toEqual(data.foot);
    expect(placement.anchor?.source).toBe('geometry');
    expect(placement.supportEvidence?.baselineCandidateId).toBe('segmented-basin-with-stem');
    expect(placement.supportEvidence?.evidence.interpretation).toBe(
      'support-contour-bottom-not-footprint-centre',
    );
    expect(placement.anchor!.point.y).toBeGreaterThan(data.candidate.bounds.bottom);
    expect(placement.reasons.join(' ')).toContain('실제 접지 중심');
    expect(result.pipeline.understanding.candidates[0].anchor).toBeUndefined();
    expect(data).toEqual(original);
  });

  it('does not substitute the bowl bbox bottom when source identity is missing', () => {
    const result = run(sample(), false);
    expect(result.plans.bowl).toBeNull();
    expect(result.pipeline.observedSupportChecks?.[0].diagnostic.code).toBe('identity-unverified');
    expect(result.pipeline.placements[0].reasons.join(' ')).toContain('세면볼 사진 범위');
    expect(result.pipeline.observedPlacementChecks).toBeUndefined();
  });

  it('uses independent support style for a manual position without relabelling default dimensions or model observations', () => {
    const data = sample(false);
    // Full observed product permits unknown style to match without a bowl-part assumption.
    data.candidate.bounds = { ...data.baseline.candidates[0].bounds };
    data.candidate.basinStyle = 'unknown';
    const result = run(data, true, { bowl: { face: 'floor', u: 0.5, v: 0.5, baseHeightMm: 0 } });
    expect(result.plans.bowl).toMatchObject({
      basinVariant: 'pedestal',
      provenance: { position: 'user', dimensions: 'default' },
    });
    expect(result.pipeline.automaticUnderstanding.candidates[0].basinStyle).toBe('unknown');
    expect(result.pipeline.placements[0].supportEvidence).toBeUndefined();
  });

  it('preserves an explicit floor anchor instead of replacing it with the stem observation', () => {
    const data = sample();
    data.candidate.mounting = 'floor';
    data.candidate.bounds = { ...data.baseline.candidates[0].bounds };
    data.candidate.anchor = {
      kind: 'floor-contact',
      point: data.foot,
      evidence: ['explicit synthetic anchor'],
      uncertainty: [],
    };
    const result = run(data);
    expect(result.pipeline.placements[0].anchor?.source).toBe('model');
    expect(result.pipeline.observedSupportChecks).toBeUndefined();
    expect(result.pipeline.placements[0].supportEvidence).toBeUndefined();
  });

  it('does not turn an observed user mounting conflict into an inferred floor installation', () => {
    const data = sample(false);
    data.candidate.bounds = { ...data.baseline.candidates[0].bounds };
    data.candidate.mounting = 'wall';
    data.candidate.basinStyle = 'wall';
    data.candidate.provenance = { mounting: 'user' };
    const result = run(data);
    expect(result.review.candidates[0].installation?.mode).toBe('wall');
    expect(result.pipeline.observedInstallationChecks?.[0].diagnostic.code).toBe('installation-conflict');
    expect(result.plans.bowl).toBeNull();
  });
});
