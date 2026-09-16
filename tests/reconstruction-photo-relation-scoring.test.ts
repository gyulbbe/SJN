import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import { buildCandidatePipeline } from '../src/lib/reconstruction/candidate-pipeline';
import { buildEstimatedCandidatePipeline, type LayoutObservationInput } from '../src/lib/reconstruction/estimated-layout';
import {
  inspectEstimatedPhotoRelations,
  PHOTO_RELATION_SCORING_REVISION,
  type EstimatedPhotoRelationConsistency,
} from '../src/lib/reconstruction/estimated-relation-evidence';
import type { SceneCandidate, SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';
import type { ReconstructionReview } from '../src/lib/reconstruction/types';

// Synthetic policy checks. Actual photo/replay evidence is retained separately in test-results.
type Relation = LayoutObservationInput['relations'][number];
const candidate = (id: string, bounds: SceneCandidate['bounds']): SceneCandidate => ({
  id, kind: 'wallShelf', bounds, mounting: 'wall', wall: 'back', basinStyle: 'unknown',
  shape: 'rectangular', reflection: 'physical', evidence: ['Synthetic observation.'], uncertainty: [],
});
const first = candidate('a', { left: .1, top: .1, right: .4, bottom: .6 });
const overlap = candidate('b', { left: .2, top: .3, right: .5, bottom: .8 });
const relation = (type: Relation['type']): Relation => ({ fromId: 'a', toId: 'b', type, note: 'Synthetic relation.' });

describe('photo direction scoring evidence', () => {
  it.each(['leftOf', 'rightOf', 'above', 'below'] as const)('holds overlapping %s without calling it contradicted', type => {
    const raw = [relation(type)];
    const candidates = [first, overlap];
    const before = structuredClone({ raw, candidates });
    const result = inspectEstimatedPhotoRelations(candidates, raw);
    expect(result.scoringRevision).toBe(PHOTO_RELATION_SCORING_REVISION);
    expect(result.checks[0].status).toBe('inconclusive');
    expect(result.rejected).toEqual([]);
    expect(result.held?.[0]).toMatchObject({ index: 0, relation: raw[0] });
    expect(result.scoredRelations).toEqual([]);
    expect(result.accepted).toEqual(raw); // Legacy non-contradicted diagnostic retains the observation.
    expect({ raw, candidates }).toEqual(before);
  });

  it('separates consistent scoring from contradicted and inconclusive observations', () => {
    const far = candidate('b', { left: .7, top: .7, right: .9, bottom: .9 });
    const result = inspectEstimatedPhotoRelations([first, far], [relation('leftOf'), relation('below')]);
    expect(result.scoredRelations).toEqual([relation('leftOf')]);
    expect(result.rejected.map(c => c.relation)).toEqual([relation('below')]);
    expect(result.held).toEqual([]);
  });

  it('holds missing, invalid, reflected and near-touching directional evidence', () => {
    const cases = [
      [first],
      [first, { ...overlap, reflection: 'reflected' as const }],
      [first, { ...overlap, bounds: { ...overlap.bounds, right: 1.1 } }],
      [first, candidate('b', { left: .405, top: .605, right: .7, bottom: .9 })],
    ];
    for (const candidates of cases) {
      const result = inspectEstimatedPhotoRelations(candidates, [relation('rightOf')]);
      expect(result.rejected).toEqual([]);
      expect(result.held).toHaveLength(1);
      expect(result.scoredRelations).toEqual([]);
    }
  });

  it('leaves every non-photo relationship on its existing scoring path', () => {
    const types: Relation['type'][] = ['inFrontOf', 'behind', 'supportedBy', 'attachedTo', 'visibleThrough'];
    const raw = types.map(relation);
    const result = inspectEstimatedPhotoRelations([first, overlap], raw);
    expect(result.checks.every(c => c.status === 'not-photo-relative')).toBe(true);
    expect(result.scoredRelations).toEqual(raw);
    expect(result.accepted).toEqual(raw);
    expect(result.held).toEqual([]);
  });

  it('allows legacy stored diagnostics with no new optional scoring fields', () => {
    const legacy: EstimatedPhotoRelationConsistency = {
      version: 1, coordinateSystem: 'normalized-photo-xy', accepted: [relation('above')],
      checks: [{ index: 0, relation: relation('above'), status: 'inconclusive', reason: 'legacy' }], rejected: [],
    };
    expect(JSON.parse(JSON.stringify(legacy))).toEqual(legacy);
    expect(legacy.scoredRelations).toBeUndefined();
  });

  it('scores held directions as zero while preserving manual positions and raw observations', () => {
    const room = { ...DEFAULT_ROOM }, image = { width: 960, height: 1280 };
    const baseline: ReconstructionReview = { version: 2, analysis: 'partial', candidates: [], planes: [], warnings: [] };
    const understanding: SceneUnderstanding = {
      schemaVersion: 1, candidates: [first, overlap], relations: [],
      roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: [] },
    };
    const strictResult = buildCandidatePipeline(understanding, baseline, room, image, {
      a: { face: 'back', u: .25, v: .2, baseHeightMm: 1800, widthMm: 400, heightMm: 30, depthMm: 150 },
      b: { face: 'back', u: .75, v: .8, baseHeightMm: 500, widthMm: 400, heightMm: 30, depthMm: 150 },
    });
    const layoutObservation = { observations: [], relations: [relation('below')] };
    const args = { room, image, baseline, understanding, strictResult, layoutObservation, manualIdSet: new Set(['a', 'b']) };
    const before = structuredClone(args);
    const checked = buildEstimatedCandidatePipeline(args);
    const raw = buildEstimatedCandidatePipeline({ ...args, photoRelationPolicy: 'raw-experiment' });
    expect(checked.pipeline.estimatedLayout.relations).toEqual(layoutObservation.relations);
    expect(checked.pipeline.estimatedLayout.relationConsistency?.held).toHaveLength(1);
    expect(checked.pipeline.estimatedLayout.hypotheses[0].scoreTerms.relations).toBe(0);
    expect(raw.pipeline.estimatedLayout.hypotheses[0].scoreTerms.relations).toBeGreaterThan(0);
    for (const id of args.manualIdSet) {
      expect(checked.plans[id]).toEqual(before.strictResult.plans[id]);
      expect(raw.plans[id]).toEqual(before.strictResult.plans[id]);
      expect(checked.pipeline.estimatedLayout.nodes.find(n => n.candidateId === id)?.reasons.join(' '))
        .toContain('배치 점수에서 보류');
    }
    expect(args).toEqual(before);
  });
});
