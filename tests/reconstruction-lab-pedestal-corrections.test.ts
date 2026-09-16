import { describe, expect, it } from 'vitest';
import {
  labPedestalShapes,
  captureLabCorrection,
  appliedCorrectionReview,
  type LabFieldCorrection,
  type LabCorrectionSnapshot,
} from '../src/lib/reconstruction/lab-correction';
import type { SceneCandidate, SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';

const candidate = (patch: Partial<SceneCandidate> = {}): SceneCandidate => ({
  id: 'basin',
  kind: 'basin',
  bounds: { left: 0.1, top: 0.2, right: 0.4, bottom: 0.7 },
  mounting: 'floor',
  wall: 'back',
  basinStyle: 'pedestal',
  shape: 'rectangular',
  reflection: 'physical',
  evidence: ['synthetic semantic fields for correction validation'],
  uncertainty: [],
  ...patch,
});
const scene = (patch: Partial<SceneCandidate> = {}): SceneUnderstanding => ({
  schemaVersion: 1,
  candidates: [candidate(patch)],
  relations: [],
  roomLayout: { orthogonal: false, evidence: [], uncertainty: [] },
});
describe('Lab user pedestal correction applicability', () => {
  it.each(['round', 'rectangular'] as const)(
    'accepts explicit %s only for a current pedestal basin without changing the model',
    (pedestalShape) => {
      const observation = scene(),
        before = structuredClone(observation);
      expect(labPedestalShapes(observation, { basin: { pedestalShape } })).toEqual({ basin: pedestalShape });
      expect(observation).toEqual(before);
      expect(observation.candidates[0].shape).toBe('rectangular');
    },
  );
  it.each([
    { kind: 'toilet' as const, basinStyle: 'unknown' as const },
    { basinStyle: 'wall' as const },
    { basinStyle: 'vanity' as const },
    { basinStyle: 'unknown' as const },
  ])(
    'holds a stale pedestal choice after kind/support changes %j until it is explicitly cleared',
    (patch) => {
      const current = scene(patch);
      expect(() => labPedestalShapes(current, { basin: { pedestalShape: 'rectangular' } })).toThrow(
        '기둥 단면',
      );
      expect(labPedestalShapes(current, { basin: {} })).toEqual({});
    },
  );
  it('rejects malformed enums on a live candidate instead of silently making a default cylinder', () => {
    const invalid = { pedestalShape: 'triangular' } as unknown as LabFieldCorrection;
    expect(() => labPedestalShapes(scene(), { basin: invalid })).toThrow('기둥 단면');
  });
  it('excludes a false positive even when its saved shape has become invalid', () => {
    const correction = { pedestalShape: 'triangular', falsePositive: true } as unknown as LabFieldCorrection;
    expect(
      labPedestalShapes(scene({ kind: 'toilet', basinStyle: 'unknown' }), { basin: correction }),
    ).toEqual({});
  });
  it('does not attach a deleted candidate correction to another item or infer section shape from the bowl', () => {
    expect(
      labPedestalShapes(scene({ id: 'different' }), { basin: { pedestalShape: 'rectangular' } }),
    ).toEqual({});
    expect(labPedestalShapes(scene(), {})).toEqual({});
  });
  it('keeps submitted snapshots independent from later correction clearing and returned review edits', () => {
    const input: Omit<LabCorrectionSnapshot, 'version'> = {
      capturedAt: '2026-09-14T00:00:00.000Z',
      sourceRunId: 'source',
      inputKey: 'same-photo',
      sourceModelRunId: 'model',
      sourceEngineMetadata: {
        id: 'candidate',
        modelId: 'synthetic',
        revision: 'test',
        modelRevision: 'test',
        settings: {},
      },
      draft: { corrections: { basin: { pedestalShape: 'rectangular' } }, manual: {}, additions: [] },
      input: { understanding: scene(), manualPlacements: {}, pedestalShapes: { basin: 'rectangular' } },
      changedFieldCount: 1,
    };
    const snapshot = captureLabCorrection(input);
    delete input.draft.corrections.basin.pedestalShape;
    delete input.input.pedestalShapes!.basin;
    expect(snapshot.draft.corrections.basin.pedestalShape).toBe('rectangular');
    expect(snapshot.input.pedestalShapes?.basin).toBe('rectangular');
    const review = appliedCorrectionReview(snapshot);
    delete review.corrections.basin.pedestalShape;
    expect(appliedCorrectionReview(snapshot).corrections.basin.pedestalShape).toBe('rectangular');
    expect(Object.isFrozen(snapshot.input.pedestalShapes)).toBe(true);
  });
});
