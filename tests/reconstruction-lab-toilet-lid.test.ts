import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import { buildCandidatePipeline } from '../src/lib/reconstruction/candidate-pipeline';
import { labToiletLidStates, captureLabCorrection, restoreLabCorrectionDraft } from '../src/lib/reconstruction/lab-correction';
import type { SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';
import type { ReconstructionReview } from '../src/lib/reconstruction/types';

const observed: SceneUnderstanding = {
  schemaVersion: 1,
  roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: ['No calibrated camera'] },
  relations: [],
  candidates: [{ id: 'wc', kind: 'toilet', mounting: 'floor', wall: 'back',
    shape: 'unknown', basinStyle: 'unknown', reflection: 'physical',
    bounds: { left: 0.2, top: 0.3, right: 0.4, bottom: 0.8 },
    evidence: ['Functional observation, not a model evaluation'], uncertainty: [],
    provenance: { kind: 'model', mounting: 'user', position: 'user' },
  }],
};
const baseline: ReconstructionReview = { version: 2, analysis: 'partial', planes: [], candidates: [], warnings: [] };
const manual = { wc: { face: 'floor' as const, u: 0.5, v: 0.5, baseHeightMm: 0 } };
const run = (states: Record<string, 'open' | 'closed'> = {}, placed = true) =>
  buildCandidatePipeline(observed, baseline, DEFAULT_ROOM, { width: 500, height: 500 }, placed ? manual : {}, observed, states);

describe('user toilet lid correction in the reconstruction lab', () => {
  it('changes only appearance and its provenance, preserving the model observation and placement', () => {
    const original = structuredClone(observed);
    const automatic = run();
    const opened = run({ wc: 'open' });
    const closed = run({ wc: 'closed' });
    expect(opened.plans.wc).toMatchObject({ toiletLidState: 'open', provenance: { toiletLidState: 'user', dimensions: 'default' } });
    expect(closed.plans.wc).toMatchObject({ toiletLidState: 'closed', provenance: { toiletLidState: 'user' } });
    for (const key of ['u', 'v', 'face', 'baseHeightMm', 'widthMm', 'heightMm', 'depthMm', 'yawDegrees'] as const)
      expect(opened.plans.wc?.[key]).toEqual(automatic.plans.wc?.[key]);
    expect(opened.pipeline.automaticUnderstanding).toEqual(original);
    expect(opened.pipeline.understanding).toEqual(original);
    expect(observed).toEqual(original);
    expect(run().plans.wc).toEqual(automatic.plans.wc); // Clear override means automatic/default again.
  });

  it('does not force a held fixture into the room or label its position confirmed', () => {
    const result = run({ wc: 'open' }, false);
    expect(result.plans.wc).toBeNull();
    expect(result.pipeline.placements[0].status).toBe('held');
    expect(result.pipeline.userToiletLidStates).toEqual({ wc: 'open' });
  });

  it('rejects missing targets, other product types and invalid states', () => {
    expect(() => run({ missing: 'open' })).toThrow(/뚜껑/);
    expect(() => run({ wc: 'invalid' as 'open' })).toThrow(/뚜껑/);
    const other = structuredClone(observed);
    other.candidates[0].kind = 'wallShelf';
    expect(() => buildCandidatePipeline(other, baseline, DEFAULT_ROOM, { width: 500, height: 500 }, {}, other, { wc: 'open' })).toThrow(/뚜껑/);
  });

  it('excludes stale appearance after kind changes or removal without editing the draft', () => {
    const corrections = { wc: { toiletLidState: 'open' as const } };
    expect(labToiletLidStates(observed, corrections)).toEqual({ wc: 'open' });
    expect(labToiletLidStates(observed, { wc: { ...corrections.wc, falsePositive: true } })).toEqual({});
    const other = structuredClone(observed);
    other.candidates[0].kind = 'basin';
    expect(labToiletLidStates(other, corrections)).toEqual({});
    expect(labToiletLidStates({ ...observed, candidates: [] }, corrections)).toEqual({});
    expect(corrections.wc.toiletLidState).toBe('open');
  });

  it('captures, exports and restores the submitted appearance independently of later edits', () => {
    const corrections = { wc: { toiletLidState: 'open' as 'open' | 'closed' } };
    const input = { understanding: observed, manualPlacements: manual, toiletLidStates: labToiletLidStates(observed, corrections) };
    const snapshot = captureLabCorrection({ capturedAt: '2026-09-13T00:00:00Z', sourceRunId: 'source', sourceModelRunId: 'model',
      sourceEngineMetadata: { id: 'candidate', revision: 'test', modelId: 'test', modelRevision: 'test', settings: {} },
      inputKey: 'photo:room', changedFieldCount: 1, draft: { corrections, additions: [], manual: {} }, input });
    corrections.wc.toiletLidState = 'closed';
    input.toiletLidStates.wc = 'closed';
    const saved = JSON.parse(JSON.stringify(snapshot));
    expect(saved.input.toiletLidStates).toEqual({ wc: 'open' });
    const restored = restoreLabCorrectionDraft(saved, 'source', 'photo:room');
    expect(restored.corrections.wc.toiletLidState).toBe('open');
    restored.corrections.wc.toiletLidState = 'closed';
    expect(saved.draft.corrections.wc.toiletLidState).toBe('open');
  });
});
