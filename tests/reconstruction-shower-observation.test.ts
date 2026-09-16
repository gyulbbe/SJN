import { describe, expect, it } from 'vitest';
import {
  parseShowerObservation,
  showerObservationDecision,
  showerObservationPrompt,
  showerObservationTargets,
  type ShowerObservation,
} from '../src/lib/reconstruction/shower-observation';
import type { SceneCandidate, SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import { buildCandidatePipeline } from '../src/lib/reconstruction/candidate-pipeline';
import { buildEstimatedCandidatePipeline } from '../src/lib/reconstruction/estimated-layout';
import { showerObservedCorners } from '../src/lib/reconstruction/shower-layout-evidence';
import { showerVariantDefaults } from '../src/lib/reconstruction/fixture-variants';
import type { ReconstructionReview } from '../src/lib/reconstruction/types';
const c = (changes: Partial<SceneCandidate> = {}): SceneCandidate => ({
  id: 's',
  kind: 'shower',
  mounting: 'wall',
  wall: 'unknown',
  reflection: 'physical',
  basinStyle: 'unknown',
  shape: 'unknown',
  bounds: { left: 0.35, top: 0.45, right: 0.4, bottom: 0.55 },
  evidence: ['PRIOR_NOTE_NOT_MODEL_INPUT'],
  uncertainty: [],
  ...changes,
});
const inv = (...candidates: SceneCandidate[]): SceneUnderstanding => ({
  schemaVersion: 1,
  candidates,
  relations: [],
  roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: [] },
});
const row = (changes: Partial<ShowerObservation> = {}): ShowerObservation => ({
  id: 's',
  note: 'Authored structural evidence for boundary tests, not an actual AI result.',
  kind: 'shower',
  context: 'physical',
  style: 'hand-spray',
  observedPart: 'handset',
  visibleParts: { handheldHead: 'present', overheadHead: 'absent', verticalRail: 'absent', hose: 'present' },
  ...changes,
});
const raw = (...observations: ShowerObservation[]) => JSON.stringify({ schemaVersion: 1, observations });
const baseline: ReconstructionReview = {
  version: 2,
  analysis: 'partial',
  planes: [],
  candidates: [],
  warnings: [],
};
function args() {
  const understanding = inv(c());
  const room = { ...DEFAULT_ROOM };
  const image = { width: 960, height: 1280 };
  return {
    understanding,
    room,
    image,
    baseline,
    strictResult: buildCandidatePipeline(understanding, baseline, room, image),
  };
}
describe('typed shower detail evidence', () => {
  it('never sends prior notes, category labels or estimated coordinates as image evidence', () => {
    const prompt = showerObservationPrompt(inv(c()));
    expect(prompt).not.toContain('PRIOR_NOTE_NOT_MODEL_INPUT');
    const values = JSON.parse(
      prompt
        .split('Targets (IDs and regions only; no previous classification or notes): ')[1]
        .split('\nReturn only')[0],
    );
    expect(values).toEqual([{ id: 's', bounds: c().bounds }]);
  });
  it('excludes reflected, user-verified and invalid targets without modifying the inventory', () => {
    const input = inv(
      c(),
      c({ id: 'r', reflection: 'reflected' }),
      c({ id: 'u', provenance: { kind: 'user' } }),
      c({
        id: 'e',
        validation: { status: 'needs-review', issues: [{ code: 'invalid-kind', message: 'test' }] },
      }),
    );
    const original = structuredClone(input);
    expect(showerObservationTargets(input).map((x) => x.id)).toEqual(['s']);
    expect(input).toEqual(original);
  });
  it('rejects missing, duplicate and foreign IDs', () => {
    for (const values of [[], [row(), row()], [row({ id: 'other' })]])
      expect(() => parseShowerObservation(raw(...values), inv(c()))).toThrow();
  });
  it('rejects subtype on a tap and invalid enum or extra commands', () => {
    expect(() => parseShowerObservation(raw(row({ kind: 'tap-only' })), inv(c()))).toThrow();
    expect(() =>
      parseShowerObservation(raw({ ...row(), style: 'invented' } as unknown as ShowerObservation), inv(c())),
    ).toThrow();
    expect(() =>
      parseShowerObservation(
        JSON.stringify({ schemaVersion: 1, observations: [row()], execute: 'noop' }),
        inv(c()),
      ),
    ).toThrow();
  });
  it.each(['reflected', 'uncertain'] as const)('does not instantiate a %s target', (context) =>
    expect(showerObservationDecision(row({ context })).applicable).toBe(false),
  );
  it.each(['control', 'mixed', 'unknown'] as const)(
    'keeps %s scope reviewable without making it a whole kit',
    (observedPart) => expect(showerObservationDecision(row({ observedPart })).applicable).toBe(false),
  );
  it('requires actual handheld evidence and rejects an overhead head for a compact spray', () => {
    expect(showerObservationDecision(row()).applicable).toBe(true);
    expect(
      showerObservationDecision(row({ visibleParts: { ...row().visibleParts, handheldHead: 'uncertain' } }))
        .applicable,
    ).toBe(false);
    expect(
      showerObservationDecision(row({ visibleParts: { ...row().visibleParts, overheadHead: 'present' } }))
        .applicable,
    ).toBe(false);
  });
  it('uses the real handset vertex range without retaining geometry or sharing mutable corners', () => {
    const input = args(),
      plan = {
        ...showerVariantDefaults('hand-spray'),
        kind: 'shower' as const,
        version: 2 as const,
        color: '#888888',
        u: 0.5,
        v: 0.5,
      };
    const corners = showerObservedCorners(input.room, plan, 'handset')!;
    expect(corners).toHaveLength(8);
    expect(Math.max(...corners.map((x) => x.y)) - Math.min(...corners.map((x) => x.y))).toBeLessThan(
      plan.heightMm * 0.75,
    );
    corners[0].x = 999999;
    expect(showerObservedCorners(input.room, plan, 'handset')![0].x).not.toBe(999999);
    expect(showerObservedCorners(input.room, plan, 'whole-kit')).toBeUndefined();
  });
  it('keeps original observations while placing a compact model against the observed handset', () => {
    const input = args(),
      original = structuredClone(input);
    const output = buildEstimatedCandidatePipeline({ ...input, showerDetails: [row()] });
    expect(input).toEqual(original);
    expect(output.plans.s?.showerVariant).toBe('hand-spray');
    expect(output.plans.s?.heightMm).toBeLessThan(600);
    expect(output.plans.s?.provenance?.showerVariant).toBe('model');
    expect(output.pipeline.estimatedLayout.nodes[0].selected?.reasons.join(' ')).toContain('handset');
  });
  it('holds an unresolved new observation and preserves the candidate and reason', () => {
    const output = buildEstimatedCandidatePipeline({
      ...args(),
      showerDetails: [row({ kind: 'tap-only', style: 'unknown', observedPart: 'control' })],
    });
    expect(output.plans.s).toBeNull();
    expect(output.pipeline.estimatedLayout.nodes[0].observed.id).toBe('s');
    expect(output.review.candidates[0].requiresReview).toBe(true);
    expect(output.review.candidates[0].warning).toContain('샤워');
  });
  it('leaves legacy plans identical when no new observation is supplied', () => {
    const input = args();
    expect(buildEstimatedCandidatePipeline(input).plans).toEqual(
      buildEstimatedCandidatePipeline({ ...input, showerDetails: undefined }).plans,
    );
  });
});
