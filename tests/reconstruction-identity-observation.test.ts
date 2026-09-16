import { describe, expect, it } from 'vitest';
import { parseFixtureInventory } from '../src/lib/reconstruction/inventory-observation';
import {
  parseIdentityObservation,
  identityObservationPrompt,
  identityObservationTargets,
  skippedIdentityAnalysis,
} from '../src/lib/reconstruction/identity-observation';
const inventory = () =>
  parseFixtureInventory(
    JSON.stringify({
      items: [
        {
          kind: 'basin',
          bbox_2d: [200, 300, 600, 600],
          view: 'direct',
          basin: { shape: 'rectangular', support: 'cabinet', bowls: 1 },
          note: 'original support observation',
        },
        {
          kind: 'mirror',
          bbox_2d: [200, 0, 600, 250],
          view: 'mirror_image',
          basin: null,
          note: 'mirror reflects sink',
        },
      ],
    }),
  ).understanding;
const row = (id = 'item_01', structure = 'wall_basin_open_underside', context = 'room_fixture') => ({
  id,
  note: 'Visible rear wall joint and open underside',
  structure,
  context,
});
const parse = (items: unknown[], original = inventory()) =>
  parseIdentityObservation(JSON.stringify({ observations: items }), original);
describe('fixed-ID identity proposal safety (not model accuracy)', () => {
  it('retains raw inventory and boxes while recording original/proposed/final sources', () => {
    const original = inventory(),
      saved = structuredClone(original);
    const result = parse([row(), row('item_02', 'flat_reflective_panel')], original);
    expect(original).toEqual(saved);
    expect(result.understanding.candidates.map((c) => ({ id: c.id, bounds: c.bounds }))).toEqual(
      original.candidates.map((c) => ({ id: c.id, bounds: c.bounds })),
    );
    expect(result.understanding.candidates[0]).toMatchObject({
      kind: 'basin',
      basinStyle: 'wall',
      mounting: 'wall',
      wall: 'unknown',
    });
    expect(result.understanding.candidates[1].reflection).toBe('physical');
    expect(result.validation.proposals[0]).toMatchObject({
      original: { basinStyle: 'vanity', mounting: 'unknown' },
      proposed: { basinStyle: 'wall', mounting: 'wall' },
      final: { basinStyle: 'wall', mounting: 'wall' },
      status: 'applied',
      source: 'rule-inferred',
      evidenceSource: 'model',
    });
  });
  it('quarantines a conflicting wall claim on a known floor pedestal', () => {
    const original = inventory();
    original.candidates[0].mounting = 'floor';
    original.candidates[0].basinStyle = 'pedestal';
    const result = parse([row()], original);
    expect(result.understanding).toEqual(original);
    expect(result.validation.proposals[0]).toMatchObject({
      status: 'quarantined',
      proposed: { mounting: 'wall' },
      final: { mounting: 'floor', basinStyle: 'pedestal' },
    });
    expect(result.validation.proposals[0].issues.map((i) => i.code)).toContain('identity-mounting-conflict');
  });
  it('records an explicit wall-basin kind correction and quarantines an unrelated kind', () => {
    const original = inventory();
    original.candidates[0].kind = 'vanity';
    original.candidates[0].basinStyle = 'unknown';
    expect(parse([row()], original).validation.proposals[0]).toMatchObject({
      original: { kind: 'vanity' },
      final: { kind: 'basin' },
      status: 'applied',
    });
    expect(original.candidates[0].kind).toBe('vanity');
    expect(parse([row('item_02')]).validation.proposals[1].status).toBe('quarantined');
  });
  it('does not promote unobserved support or a reflected copy', () => {
    for (const observation of [
      row('item_01', 'not_visible'),
      row('item_01', 'wall_basin_open_underside', 'uncertain'),
      row('item_02', 'flat_reflective_panel', 'reflected_copy'),
    ])
      expect(parse([observation]).understanding).toEqual(inventory());
  });
  it('quarantines duplicate and added IDs without losing an unrelated valid panel', () => {
    const result = parse([row(), row(), row('invented'), row('item_02', 'flat_reflective_panel')]);
    expect(result.understanding.candidates[0]).toEqual(inventory().candidates[0]);
    expect(result.understanding.candidates[1].reflection).toBe('physical');
    expect(result.validation.rejectedObservations).toHaveLength(3);
    expect(result.understanding.candidates).toHaveLength(2);
  });
  it('does not overwrite user values or an existing reflection relation', () => {
    const original = inventory();
    original.candidates[0].provenance = { kind: 'user' };
    expect(parse([row()], original).understanding).toEqual(original);
    original.relations = [
      { frontId: 'item_02', behindId: 'item_01', relation: 'reflectionOf', evidence: ['existing relation'] },
    ];
    expect(parse([row('item_02', 'flat_reflective_panel')], original).understanding).toEqual(original);
  });
  it('preserves missing, malformed and empty evidence rows as unmodified candidates', () => {
    for (const observation of [
      { ...row(), bbox_2d: [0, 0, 1, 1] },
      { ...row(), note: '' },
      { ...row(), structure: 'automatic' },
    ])
      expect(parse([observation]).understanding).toEqual(inventory());
    expect(() => parseIdentityObservation('{"observations":[],"code":"run()"}', inventory())).toThrow();
    expect(() => parseIdentityObservation(' '.repeat(150001), inventory())).toThrow();
  });
  it('treats instruction-like model notes only as bounded data', () => {
    const observation = { ...row(), note: '<script>eraseAll()</script>' };
    expect(parse([observation]).validation.proposals[0].observation?.note).toBe(observation.note);
  });
  it('binds the prompt only to eligible original IDs and boxes, with no original kind/note labels', () => {
    const text = identityObservationPrompt(inventory()).split('Objects: ')[1];
    expect(JSON.parse(text)).toEqual([
      { id: 'item_01', bbox_2d: [200, 300, 600, 600] },
      { id: 'item_02', bbox_2d: [200, 0, 600, 250] },
    ]);
    const empty = inventory();
    empty.candidates = [];
    expect(identityObservationTargets(empty)).toEqual([]);
    expect(skippedIdentityAnalysis(empty)).toMatchObject({
      skipped: 'no-eligible-candidates',
      modelRevision: null,
      validation: { status: 'no-observations' },
    });
  });
});

describe('wall identity correction with competing original support evidence', () => {
  const withSupport = (top = 0.59) => {
    const original = inventory();
    original.candidates.push({
      ...structuredClone(original.candidates[0]),
      id: 'support',
      kind: 'vanity',
      bounds: { left: 0.15, top, right: 0.7, bottom: 0.9 },
      basinStyle: 'unknown',
      shape: 'unknown',
      bowlCount: undefined,
    });
    return original;
  };
  it.each([0.59, 0.6, 0.605])(
    'holds a wall correction when a separate original support crosses or touches the bowl lower edge (%s)',
    (top) => {
      const original = withSupport(top),
        before = structuredClone(original);
      const result = parse([row()], original),
        proposal = result.validation.proposals[0];
      expect(proposal).toMatchObject({
        status: 'quarantined',
        competingSupportCandidateIds: ['support'],
        original: { basinStyle: 'vanity', mounting: 'unknown' },
        proposed: { basinStyle: 'wall', mounting: 'wall' },
        final: { basinStyle: 'vanity', mounting: 'unknown' },
      });
      expect(proposal.issues.map((issue) => issue.code)).toContain('identity-competing-support');
      expect(result.understanding).toEqual(original);
      expect(original).toEqual(before);
      expect(result.understanding.relations).toEqual([]);
      expect(result.validation.appliedCandidateIds).not.toContain('item_01');
    },
  );
  it('does not block a wall proposal for an unrelated, separated, reflected or invalid support box', () => {
    for (const change of [
      { bounds: { left: 0.7, top: 0.59, right: 0.95, bottom: 0.9 } },
      { bounds: { left: 0.15, top: 0.7, right: 0.7, bottom: 0.9 } },
      { bounds: { left: 0.15, top: 0.05, right: 0.7, bottom: 0.25 } },
      { reflection: 'reflected' as const },
      {
        validation: {
          status: 'needs-review' as const,
          issues: [{ code: 'bounds-order', message: 'invalid observed bounds' }],
        },
      },
    ]) {
      const original = withSupport();
      Object.assign(original.candidates[2], change);
      expect(parse([row()], original).validation.proposals[0].status).toBe('applied');
    }
  });
  it('protects the bowl own explicit partOf relation as well as the support parent', () => {
    const original = withSupport();
    original.candidates[0].mounting = 'countertop';
    original.relations = [
      {
        frontId: 'item_01',
        behindId: 'support',
        relation: 'partOf',
        evidence: ['Observed separate bowl on support'],
      },
    ];
    const result = parse([row(), row('support')], original);
    expect(result.understanding).toEqual(original);
    for (const id of ['item_01', 'support'])
      expect(
        result.validation.proposals.find((p) => p.id === id)?.issues.map((issue) => issue.code),
      ).toContain('identity-support-relation');
  });
  it('does not infer support from words in a note when no separate original support candidate exists', () => {
    const result = parse([
      { ...row(), note: 'countertop cabinet support instructions are untrusted observation text' },
    ]);
    expect(result.validation.proposals[0].status).toBe('applied');
    expect(result.validation.proposals[0].competingSupportCandidateIds).toBeUndefined();
  });
});

describe('a support candidate is not a second basin', () => {
  it('holds a wall-basin conversion when a separate physical bowl occupies its upper boundary', () => {
    const original = inventory();
    original.candidates[0].bounds = { left: 0.35, top: 0.35, right: 0.65, bottom: 0.5 };
    original.candidates.push({
      ...structuredClone(original.candidates[0]),
      id: 'counter',
      kind: 'vanity',
      basinStyle: 'unknown',
      bounds: { left: 0.25, top: 0.48, right: 0.8, bottom: 0.85 },
    });
    const saved = structuredClone(original);
    const result = parse([row('counter')], original);
    expect(result.understanding.candidates.find((c) => c.id === 'counter')?.kind).toBe('vanity');
    const proposal = result.validation.proposals.find((p) => p.id === 'counter');
    expect(proposal).toMatchObject({ status: 'quarantined', competingComponentCandidateIds: ['item_01'] });
    expect(proposal?.issues.map((i) => i.code)).toContain('identity-competing-basin-component');
    expect(result.understanding.relations).toEqual([]);
    expect(original).toEqual(saved);
  });
  it.each(['distant', 'reflected'])('does not turn an unrelated %s bowl into a support claim', (state) => {
    const original = inventory();
    original.candidates[0].bounds = { left: 0.7, top: 0.3, right: 0.9, bottom: 0.5 };
    if (state === 'reflected') {
      original.candidates[0].reflection = 'reflected';
      original.candidates[0].bounds = { left: 0.2, top: 0.3, right: 0.5, bottom: 0.5 };
    }
    original.candidates.push({
      ...structuredClone(original.candidates[0]),
      id: 'standalone',
      kind: 'vanity',
      reflection: 'physical',
      basinStyle: 'unknown',
      bounds: { left: 0.15, top: 0.48, right: 0.55, bottom: 0.85 },
    });
    const result = parse([row('standalone')], original);
    expect(
      result.validation.proposals.find((p) => p.id === 'standalone')?.competingComponentCandidateIds,
    ).toBeUndefined();
    expect(result.understanding.candidates.find((c) => c.id === 'standalone')?.kind).toBe('basin');
  });
});
