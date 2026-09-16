import { describe, expect, it } from 'vitest';
import { parseLayoutObservation } from '../src/lib/reconstruction/layout-observation';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import { buildCandidatePipeline } from '../src/lib/reconstruction/candidate-pipeline';
import { buildEstimatedCandidatePipeline } from '../src/lib/reconstruction/estimated-layout';
import { parseFixtureAppearance } from '../src/lib/reconstruction/fixture-appearance-observation';
import {
  observedBasinComponent,
  PROMOTED_BASIN_COMPONENT_REASON,
} from '../src/lib/reconstruction/observed-basin-component';
import type { SceneCandidate, SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';
import type { ReconstructionReview } from '../src/lib/reconstruction/types';

const baseline: ReconstructionReview = {
  version: 2,
  analysis: 'partial',
  candidates: [],
  planes: [],
  warnings: [],
};
function setup() {
  const candidate = (
    id: string,
    kind: SceneCandidate['kind'],
    bounds: SceneCandidate['bounds'],
  ): SceneCandidate => ({
    id,
    kind,
    bounds,
    mounting: 'unknown',
    wall: 'unknown',
    basinStyle: kind === 'basin' ? 'vanity' : 'unknown',
    shape: 'round',
    bowlCount: 1,
    reflection: 'physical',
    evidence: ['Synthetic component relationship, not AI accuracy.'],
    uncertainty: [],
  });
  const inventory: SceneUnderstanding = {
    schemaVersion: 1,
    candidates: [
      candidate('whole', 'vanity', { left: 0.2, top: 0.4, right: 0.8, bottom: 0.8 }),
      candidate('vessel', 'basin', { left: 0.3, top: 0.4, right: 0.7, bottom: 0.52 }),
    ],
    relations: [],
    roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: [] },
  };
  const appearance = parseFixtureAppearance(
    JSON.stringify({
      schemaVersion: 1,
      observations: inventory.candidates.map((c) => ({
        id: c.id,
        note: 'Synthetic open counter classification for both whole and component.',
        kind: 'open_counter_basin',
        context: 'physical',
        sameObjectAs: c.id === 'vessel' ? 'whole' : null,
        shape: 'oval',
        counterSupport: 'unknown',
      })),
    }),
    inventory,
  );
  const [parent, child] = appearance.understanding.candidates;
  const args = {
    understanding: appearance.understanding,
    baseline,
    room: { ...DEFAULT_ROOM },
    image: { width: 800, height: 1000 },
    strictResult: buildCandidatePipeline(appearance.understanding, baseline, DEFAULT_ROOM, {
      width: 800,
      height: 1000,
    }),
    appearance,
    layoutObservation: {
      observations: [],
      relations: [
        {
          fromId: child.id,
          toId: parent.id,
          type: 'supportedBy' as const,
          note: 'Explicit synthetic observed support.',
        },
      ],
    },
  };
  const parsed = parseLayoutObservation(JSON.stringify(args.layoutObservation), appearance.understanding);
  args.layoutObservation.relations = parsed.relations as typeof args.layoutObservation.relations;
  return { parent, child, appearance, args };
}

describe('a vessel retains its observed component role after broad appearance classification', () => {
  it('derives a bowl role only for placement while preserving raw classification and boxes', () => {
    const { parent, child, appearance } = setup(),
      before = structuredClone({ parent, child, appearance });
    const resolved = observedBasinComponent(child, parent, appearance);
    expect(resolved?.kind).toBe('basin');
    expect(resolved?.bounds).toEqual(child.bounds);
    expect(child.kind).toBe('vanity');
    expect({ parent, child, appearance }).toEqual(before);
  });
  it('emits one assembly, carries the bowl shape and excludes only the component render', () => {
    const { args } = setup(),
      before = structuredClone(args);
    const result = buildEstimatedCandidatePipeline(args);
    expect(result.plans.whole).not.toBeNull();
    expect(result.plans.vessel).toBeNull();
    expect(result.pipeline.estimatedLayout.assemblies).toHaveLength(1);
    expect(result.pipeline.estimatedLayout.assemblies[0]).toMatchObject({
      parentId: 'whole',
      componentIds: ['vessel'],
      observationBounds: { status: 'combined' },
    });
    expect(result.pipeline.estimatedLayout.assemblies[0].reasons).toContain(PROMOTED_BASIN_COMPONENT_REASON);
    expect(result.pipeline.estimatedLayout.nodes.find((n) => n.candidateId === 'vessel')?.observed.kind).toBe(
      'vanity',
    );
    expect(result.review.candidates.find((n) => n.id === 'vessel')?.status).toBe('ignored');
    expect(args).toEqual(before);
  });
  it('does not infer support from containment or an unaccepted duplicate suggestion alone', () => {
    const { args } = setup();
    args.layoutObservation.relations = [];
    const result = buildEstimatedCandidatePipeline(args);
    expect(result.pipeline.estimatedLayout.assemblies).toEqual([]);
  });
  it.each(['whole', 'vessel'])('preserves manual placement for %s', (id) => {
    const { args } = setup();
    expect(
      buildEstimatedCandidatePipeline({ ...args, manualIdSet: new Set([id]) }).pipeline.estimatedLayout
        .assemblies,
    ).toEqual([]);
  });
  it('does not choose a support when the promoted component has conflicting parents', () => {
    const { args } = setup();
    args.layoutObservation.relations.push({
      fromId: 'vessel',
      toId: 'other',
      type: 'supportedBy',
      note: 'Conflicting observation.',
    });
    expect(buildEstimatedCandidatePipeline(args).pipeline.estimatedLayout.assemblies).toEqual([]);
  });
  it.each([
    'original-kind',
    'original-style',
    'original-parent',
    'changed-child-bounds',
    'changed-parent-bounds',
    'stale-effective',
    'reflected',
    'user',
    'invalid',
    'held',
    'unknown-appearance',
    'unknown-context',
    'disjoint',
  ])('does not reinterpret an unsupported role: %s', (scenario) => {
    const { parent, child, appearance } = setup(),
      d = appearance.decisions[1];
    if (scenario === 'original-kind') d.original.kind = 'vanity';
    if (scenario === 'original-style') d.original.basinStyle = 'wall';
    if (scenario === 'original-parent') appearance.decisions[0].original.kind = 'basin';
    if (scenario === 'changed-child-bounds') child.bounds = { ...child.bounds, left: 0.35 };
    if (scenario === 'changed-parent-bounds') parent.bounds = { ...parent.bounds, left: 0.1 };
    if (scenario === 'stale-effective') d.effective = { ...d.effective, kind: 'basin' };
    if (scenario === 'reflected') child.reflection = 'reflected';
    if (scenario === 'user') child.provenance = { shape: 'user' };
    if (scenario === 'invalid')
      d.original.validation = {
        status: 'needs-review',
        issues: [{ code: 'invalid-test', message: 'Invalid source contract.' }],
      };
    if (scenario === 'held') d.status = 'held';
    if (scenario === 'unknown-appearance') d.observation.kind = 'unknown';
    if (scenario === 'unknown-context') d.observation.context = 'uncertain';
    if (scenario === 'disjoint') {
      child.bounds = { left: 0.81, top: 0.1, right: 0.95, bottom: 0.2 };
      d.original.bounds = { ...child.bounds };
      d.effective.bounds = { ...child.bounds };
    }
    expect(observedBasinComponent(child, parent, appearance)).toBeNull();
  });
  it('does not merge two independently observed vanity units with a guessed support link', () => {
    const { args, appearance } = setup();
    appearance.decisions[1].original.kind = 'vanity';
    expect(buildEstimatedCandidatePipeline(args).pipeline.estimatedLayout.assemblies).toEqual([]);
  });
});

describe('assembly aggregate validation and sparse user overrides', () => {
  it('keeps a user-colored component separate even when its strict placement is null', () => {
    const { args } = setup();
    expect(args.strictResult.plans.vessel).toBeNull();
    args.strictResult.pipeline.userColors = { vessel: { mode: 'custom', color: '#ff0000' } };
    const before = structuredClone(args);
    const result = buildEstimatedCandidatePipeline(args);
    expect(result.pipeline.estimatedLayout.assemblies).toEqual([]);
    expect(result.pipeline.estimatedLayout.nodes.find((n) => n.candidateId === 'vessel')?.status).not.toBe(
      'excluded',
    );
    expect(result.pipeline.userColors?.vessel).toEqual({ mode: 'custom', color: '#ff0000' });
    expect(args).toEqual(before);
  });
  it('does not silently discard three observed bowls into a two-bowl model', () => {
    const { args, child, appearance } = setup();
    child.bounds = { left: 0.25, top: 0.4, right: 0.38, bottom: 0.52 };
    appearance.decisions[1].original.bounds = { ...child.bounds };
    for (const [index, id] of ['vessel-2', 'vessel-3'].entries()) {
      const extra = structuredClone(child);
      extra.id = id;
      extra.bounds.left += (index + 1) * 0.2;
      extra.bounds.right += (index + 1) * 0.2;
      args.understanding.candidates.push(extra);
      const row = structuredClone(appearance.decisions[1]);
      row.candidateId = id;
      row.original.id = id;
      row.original.bounds = { ...extra.bounds };
      row.effective = extra;
      row.observation.id = id;
      appearance.decisions.push(row);
      appearance.observations.push(row.observation);
      args.layoutObservation.relations.push({
        fromId: id,
        toId: 'whole',
        type: 'supportedBy',
        note: 'Third distinct synthetic bowl.',
      });
    }
    args.strictResult = buildCandidatePipeline(args.understanding, baseline, args.room, args.image);
    const result = buildEstimatedCandidatePipeline(args),
      assembly = result.pipeline.estimatedLayout.assemblies[0];
    expect(assembly.componentIds).toHaveLength(3);
    expect(assembly.observationBounds?.status).toBe('held');
    for (const id of assembly.componentIds) {
      expect(result.pipeline.estimatedLayout.nodes.find((n) => n.candidateId === id)?.status).not.toBe(
        'excluded',
      );
      expect(result.review.candidates.find((c) => c.id === id)?.requiresReview).toBe(true);
    }
  });
});
