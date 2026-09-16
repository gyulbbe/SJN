import { describe, expect, it } from 'vitest';
import {
  appliedCorrectionReview,
  captureLabCorrection,
  labProductColors,
  restoreLabCorrectionDraft,
  type LabFieldCorrection,
} from '../src/lib/reconstruction/lab-correction';
import { buildCandidatePipeline } from '../src/lib/reconstruction/candidate-pipeline';
import type { SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';
import type { ReconstructionReview } from '../src/lib/reconstruction/types';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';

const scene: SceneUnderstanding = {
  schemaVersion: 1,
  roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: ['No calibrated camera'] },
  relations: [],
  candidates: [
    {
      id: 'basin',
      kind: 'basin',
      mounting: 'wall',
      wall: 'back',
      shape: 'round',
      basinStyle: 'wall',
      reflection: 'physical',
      bounds: { left: 0.2, right: 0.5, top: 0.3, bottom: 0.6 },
      evidence: ['Synthetic contract fixture'],
      uncertainty: [],
      provenance: { kind: 'model', wall: 'user' },
    },
  ],
};
const baseline: ReconstructionReview = {
  version: 2,
  analysis: 'partial',
  planes: [],
  candidates: [],
  warnings: [],
};

describe('Lab product colour confirmation and immutable source', () => {
  it('collects explicit colours without modifying observation or pending draft', () => {
    const original = structuredClone(scene);
    const corrections: Record<string, LabFieldCorrection> = {
      basin: { productColor: { mode: 'custom', color: '#71999c' } },
    };
    const values = labProductColors(scene, corrections);
    expect(values).toEqual({ basin: { mode: 'custom', color: '#71999c' } });
    values.basin = { mode: 'neutral' };
    expect(corrections.basin.productColor).toEqual({ mode: 'custom', color: '#71999c' });
    expect(scene).toEqual(original);
    expect(labProductColors(scene, {})).toEqual({});
  });

  it('excludes removed fixtures and validates kind changes and invalid colour', () => {
    const corrections: Record<string, LabFieldCorrection> = {
      basin: { falsePositive: true, productColor: { mode: 'custom', color: '#71999c' } },
    };
    expect(labProductColors(scene, corrections)).toEqual({});
    delete corrections.basin.falsePositive;
    const optical = structuredClone(scene);
    optical.candidates[0].kind = 'mirror';
    expect(() => labProductColors(optical, corrections)).toThrow();
    corrections.basin.productColor = { mode: 'neutral' };
    expect(labProductColors(optical, corrections)).toEqual({ basin: { mode: 'neutral' } });
    corrections.basin.productColor = { mode: 'custom', color: '#fff' };
    expect(() => labProductColors(scene, corrections)).toThrow();
  });

  it('stores the submitted colour separately from subsequent drafts and the model', () => {
    const corrections: Record<string, LabFieldCorrection> = { basin: { productColor: { mode: 'neutral' } } };
    const input = {
      understanding: scene,
      manualPlacements: {},
      productColors: labProductColors(scene, corrections),
    };
    const snapshot = captureLabCorrection({
      capturedAt: '2026-09-14T00:00:00Z',
      sourceRunId: 'observed',
      sourceModelRunId: 'model',
      sourceEngineMetadata: {
        id: 'candidate',
        revision: 'test',
        modelId: 'test',
        modelRevision: 'test',
        settings: {},
      },
      inputKey: 'same-photo-room',
      changedFieldCount: 1,
      draft: { corrections, manual: {}, additions: [] },
      input,
    });
    corrections.basin.productColor = { mode: 'custom', color: '#292929' };
    input.productColors.basin = { mode: 'custom', color: '#71999c' };
    const saved = JSON.parse(JSON.stringify(snapshot));
    expect(saved.input.productColors.basin).toEqual({ mode: 'neutral' });
    expect(saved.input.understanding).toEqual(scene);
    const draft = restoreLabCorrectionDraft(saved, 'observed', 'same-photo-room');
    draft.corrections.basin.productColor = { mode: 'custom', color: '#000000' };
    expect(appliedCorrectionReview(saved).corrections.basin.productColor).toEqual({ mode: 'neutral' });
  });

  it('does not turn colour confirmation into a physical placement or a model observation', () => {
    const result = buildCandidatePipeline(
      scene,
      baseline,
      DEFAULT_ROOM,
      { width: 500, height: 500 },
      {},
      scene,
      {},
      undefined,
      undefined,
      { basin: { mode: 'neutral' } },
    );
    expect(result.plans.basin).toBeNull();
    expect(result.pipeline.userColors).toEqual({ basin: { mode: 'neutral' } });
    expect(result.pipeline.automaticUnderstanding).toEqual(scene);
    expect(result.pipeline.placements[0].status).toBe('held');
  });
});
