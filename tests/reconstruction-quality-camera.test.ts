import { it, expect } from 'vitest';
import { buildCandidatePipeline } from '../src/lib/reconstruction/candidate-pipeline';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import type { DepthRoomObservation } from '../src/lib/reconstruction/depth-room-geometry';
import type { SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';
import type { ReconstructionReview } from '../src/lib/reconstruction/types';

it('keeps valid independent depth calibration when text room observations are quarantined', () => {
  const hash = 'a'.repeat(64);
  const observation: DepthRoomObservation = {
    version: 1,
    inputFingerprint: hash,
    image: { width: 1200, height: 1000 },
    model: { id: 'synthetic-test', revision: '1' },
    coordinateSystem: 'opencv-camera',
    scale: 'model-estimated-metres',
    intrinsics: { fx: 0.5 / 1.2, fy: 0.5, cx: 0.5, cy: 0.5 },
    floor: {
      id: 'floor',
      normalCamera: [0, -1, 0],
      offset: 1.5,
      medianPointCamera: [0, 1.5, 2],
      inlierCount: 500,
      inlierFraction: 0.8,
      imageAreaFraction: 0.15,
      rmsResidual: 0.002,
    },
    walls: [
      {
        id: 'back',
        normalCamera: [0, 0, -1],
        offset: 3,
        medianPointCamera: [0, 0, 3],
        inlierCount: 500,
        inlierFraction: 0.8,
        imageAreaFraction: 0.15,
        rmsResidual: 0.002,
      },
      {
        id: 'left',
        normalCamera: [1, 0, 0],
        offset: 1.2,
        medianPointCamera: [-1.2, 0, 2],
        inlierCount: 500,
        inlierFraction: 0.8,
        imageAreaFraction: 0.15,
        rmsResidual: 0.002,
      },
    ],
  };
  const understanding: SceneUnderstanding = {
    schemaVersion: 1,
    candidates: [],
    relations: [],
    roomLayout: {
      orthogonal: 'unknown',
      evidence: [],
      uncertainty: [],
      backWallQuad: null,
      lines: [],
      corners: [],
    },
    validation: {
      rawCandidateCount: 0,
      quarantinedRelations: [],
      roomLayoutIssues: [{ code: 'rejected-quad', message: 'Text corners were not visible and removed' }],
    },
  };
  const baseline: ReconstructionReview = {
    version: 2,
    analysis: 'partial',
    candidates: [],
    planes: [],
    warnings: [],
  };
  const before = structuredClone(understanding);
  const result = buildCandidatePipeline(
    understanding,
    baseline,
    DEFAULT_ROOM,
    observation.image,
    {},
    understanding,
    {},
    { observation, inputFingerprint: hash },
  );
  expect(result.pipeline.camera.status).toBe('estimated');
  expect(result.pipeline.camera.method).toBe('depth-room-planes');
  expect(result.pipeline.understanding.validation?.roomLayoutIssues).toEqual(
    before.validation?.roomLayoutIssues,
  );
  expect(understanding).toEqual(before);
  const absent = buildCandidatePipeline(understanding, baseline, DEFAULT_ROOM, observation.image);
  expect(absent.pipeline.camera.status).toBe('held');
});
