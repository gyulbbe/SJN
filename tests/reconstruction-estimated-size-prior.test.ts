import { describe, expect, it } from 'vitest';
import { estimatedSizeFactors } from '../src/lib/reconstruction/estimated-size-prior';
import { buildEstimatedCandidatePipeline } from '../src/lib/reconstruction/estimated-layout';
import { buildCandidatePipeline } from '../src/lib/reconstruction/candidate-pipeline';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import { reconstructionDefaults, type ReconstructionReview } from '../src/lib/reconstruction/types';
import type { SceneCandidate, SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';

function args(kind: SceneCandidate['kind'] = 'window') {
  const candidate: SceneCandidate = { id: 'synthetic-fixture', kind,
    bounds: { left: 0.41, top: 0.13, right: 0.50, bottom: 0.24 },
    mounting: 'wall', wall: 'unknown', basinStyle: 'wall', shape: 'rectangular',
    reflection: 'physical', evidence: ['Synthetic test, not a photo inference.'], uncertainty: [] };
  const understanding: SceneUnderstanding = { schemaVersion: 1, candidates: [candidate], relations: [],
    roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: [] } };
  const baseline: ReconstructionReview = { version: 2, analysis: 'partial', candidates: [], planes: [], warnings: [] };
  const room = { ...DEFAULT_ROOM }, image = { width: 960, height: 1280 };
  return { understanding, baseline, room, image, strictResult: buildCandidatePipeline(understanding, baseline, room, image) };
}

describe('bounded window size hypotheses', () => {
  it('adds two smaller window hypotheses without broadening every fixture size', () => {
    expect(estimatedSizeFactors('window')).toEqual([1, .85, 1.15, .5, .35]);
    for (const kind of ['basin', 'toilet', 'mirror', 'wallShelf', 'glassPartition'] as const)
      expect(estimatedSizeFactors(kind)).toEqual([1, .85, 1.15]);
    expect(Object.isFrozen(estimatedSizeFactors('window'))).toBe(true);
  });
  it('respects explicit nominal, custom, and empty experiments without mutating them', () => {
    for (const explicit of [[1], [.6, .9], []]) {
      const before = [...explicit];
      expect(estimatedSizeFactors('window', explicit)).toBe(explicit);
      expect(explicit).toEqual(before);
    }
  });
  it('can select a small window while preserving original observations and inferred provenance', () => {
    const input = args(), original = structuredClone(input);
    const result = buildEstimatedCandidatePipeline(input);
    expect(result.plans['synthetic-fixture']!.widthMm).toBeLessThan(reconstructionDefaults('window').widthMm * .85);
    expect(result.plans['synthetic-fixture']!.provenance?.dimensions).toBe('inferred');
    expect(input).toEqual(original);
    expect(result.pipeline.camera).toEqual(input.strictResult.pipeline.camera);
  });
  it('keeps other fixtures exactly equal to their previous three-factor search', () => {
    const input = args('basin');
    expect(buildEstimatedCandidatePipeline(input)).toEqual(
      buildEstimatedCandidatePipeline({ ...input, sizeFactors: [1, .85, 1.15] }));
  });
  it('does not replace a manual window size with the smaller automatic options', () => {
    const input = args();
    const plan = { ...reconstructionDefaults('window'), kind: 'window' as const, version: 2 as const,
      face: 'back' as const, u: .4, v: .4, widthMm: 735, heightMm: 455, depthMm: 100, baseHeightMm: 1250,
      provenance: { dimensions: 'user' as const, width: 'user' as const, height: 'user' as const } };
    input.strictResult.plans['synthetic-fixture'] = plan;
    const result = buildEstimatedCandidatePipeline({ ...input, manualIdSet: new Set(['synthetic-fixture']) });
    expect(result.plans['synthetic-fixture']).toMatchObject({ widthMm: 735, heightMm: 455, baseHeightMm: 1250 });
    expect(input.strictResult.plans['synthetic-fixture']).toEqual(plan);
  });
});
