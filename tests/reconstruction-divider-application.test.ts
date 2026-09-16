import { describe, expect, it } from 'vitest';
import {
  applyDividerObservations,
  dividerObservationTargets,
  DIVIDER_APPLICATION_REVISION,
} from '../src/lib/reconstruction/divider-application';
import { resolveSceneCandidates } from '../src/lib/reconstruction/candidate-resolution';
import type { DividerObservation } from '../src/lib/reconstruction/divider-observation';
import type { ParsedFixtureAppearance } from '../src/lib/reconstruction/fixture-appearance-observation';
import type {
  SceneCandidate,
  SceneRelation,
  SceneUnderstanding,
} from '../src/lib/reconstruction/pipeline-contract';

const candidate = (changes: Partial<SceneCandidate> = {}): SceneCandidate => ({
  id: 'panel',
  kind: 'glassPartition',
  mounting: 'floor',
  wall: 'unknown',
  basinStyle: 'unknown',
  shape: 'rectangular',
  reflection: 'physical',
  bounds: { left: 0.2, top: 0.2, right: 0.8, bottom: 0.8 },
  evidence: ['Authored prior evidence; not an actual photograph or model response.'],
  uncertainty: ['Original uncertainty retained.'],
  ...changes,
});
const inventory = (...candidates: SceneCandidate[]): SceneUnderstanding => ({
  schemaVersion: 1,
  candidates,
  relations: [],
  roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: [] },
});
const observation = (changes: Partial<DividerObservation> = {}): DividerObservation => ({
  id: 'panel',
  note: 'Synthetic cloth observation for rule-boundary testing only.',
  context: 'physical',
  dividerMaterial: 'fabric-curtain',
  visibleExtent: 'whole',
  support: 'unknown',
  ...changes,
});
const appearanceFor = (
  original: SceneCandidate,
  effective: SceneCandidate,
): Pick<ParsedFixtureAppearance, 'decisions' | 'duplicates'> => ({
  decisions: [
    {
      candidateId: effective.id,
      original,
      effective,
      status: 'applied',
      reasons: [],
      observation: {
        id: effective.id,
        note: 'Synthetic prior shape classification.',
        kind: 'unknown',
        context: 'physical',
        sameObjectAs: null,
        shape: 'unknown',
        counterSupport: 'unknown',
      },
    },
  ],
  duplicates: [],
});

describe('divider material application (synthetic boundaries, not AI recognition quality)', () => {
  it('changes existing typed physical glass observations into one curtain plus one duplicate, without new IDs or boxes', () => {
    const input = inventory(candidate(), candidate({ id: 'repeat' }));
    const rows = [observation(), observation({ id: 'repeat' })];
    const original = structuredClone({ input, rows });
    const result = applyDividerObservations(input, rows);
    const { effective, resolution } = resolveSceneCandidates(result.understanding);
    expect(result.revision).toBe(DIVIDER_APPLICATION_REVISION);
    expect(result.understanding.candidates.map((c) => c.id)).toEqual(['panel', 'repeat']);
    expect(result.understanding.candidates.map((c) => c.bounds)).toEqual(
      input.candidates.map((c) => c.bounds),
    );
    expect(result.understanding.candidates.map((c) => [c.kind, c.mounting])).toEqual([
      ['showerCurtain', 'suspended'],
      ['showerCurtain', 'suspended'],
    ]);
    expect(result.decisions.map((d) => d.status)).toEqual(['applied', 'applied']);
    expect(effective).toHaveLength(2);
    expect(resolution).toMatchObject({
      rawCount: 2,
      organizedCount: 1,
      duplicateCount: 1,
      componentCount: 0,
    });
    expect(resolution.entries.filter((e) => e.disposition === 'fixture')).toHaveLength(1);
    expect(resolution.entries.filter((e) => e.disposition === 'duplicate')).toHaveLength(1);
    expect(resolution.entries.find((e) => e.disposition === 'duplicate')?.representativeId).toBe('panel');
    expect({ input, rows }).toEqual(original);
  });

  it('keeps two spatially separate curtain observations as two physical fixtures', () => {
    const input = inventory(
      candidate({ bounds: { left: 0.1, top: 0.1, right: 0.3, bottom: 0.8 } }),
      candidate({ id: 'other', bounds: { left: 0.7, top: 0.1, right: 0.9, bottom: 0.8 } }),
    );
    const result = applyDividerObservations(input, [observation(), observation({ id: 'other' })]);
    const { resolution } = resolveSceneCandidates(result.understanding);
    expect(resolution.entries.map((e) => e.disposition)).toEqual(['fixture', 'fixture']);
    expect(resolution.duplicateCount).toBe(0);
  });

  it('preserves all raw candidates and observations, and clears an incompatible old contact anchor only in the effective result', () => {
    const input = inventory(
      candidate({
        anchor: {
          point: { x: 0.5, y: 0.8 },
          kind: 'floor-contact',
          evidence: ['Synthetic floor contact.'],
          uncertainty: [],
        },
        provenance: { kind: 'model', mounting: 'model', position: 'model', shape: 'model' },
      }),
    );
    const rows = [observation()];
    const original = structuredClone({ input, rows });
    const result = applyDividerObservations(input, rows);
    expect(result.decisions[0].original).toEqual(input.candidates[0]);
    expect(result.decisions[0].observation).toEqual(rows[0]);
    expect(result.understanding.candidates[0].anchor).toBeUndefined();
    expect(result.understanding.candidates[0]).toMatchObject({
      id: 'panel',
      bounds: input.candidates[0].bounds,
      shape: input.candidates[0].shape,
      evidence: input.candidates[0].evidence,
      reflection: 'physical',
      provenance: {
        kind: 'model',
        mounting: 'geometry',
        wall: 'default',
        position: 'default',
        shape: 'model',
      },
    });
    expect(result.understanding.candidates[0].uncertainty).toContain('Original uncertainty retained.');
    result.decisions[0].original.bounds.left = 0;
    result.decisions[0].observation.note = 'Mutation of returned ledger.';
    result.understanding.candidates[0].evidence.push('Mutation of returned candidate.');
    expect({ input, rows }).toEqual(original);
  });

  it.each([
    ['unknown', 'rod', 'default'],
    ['rod', 'rod', 'model'],
    ['track', 'track', 'model'],
  ] as const)('maps support %s to %s with explicit %s provenance', (support, curtainHardware, source) => {
    const result = applyDividerObservations(inventory(candidate()), [observation({ support })]);
    expect(result.modelOptions.panel).toEqual({ curtainHardware, provenance: { curtainHardware: source } });
    expect(Object.keys(result.modelOptions.panel).sort()).toEqual(['curtainHardware', 'provenance']);
    expect(result.understanding.candidates[0].provenance?.mounting).toBe('geometry');
    expect(result.understanding.candidates[0].provenance?.kind).toBe('model');
  });

  it('selects only current or prior divider labels and omits explicit aliases and nonphysical candidates', () => {
    const oldPanel = candidate({ id: 'old-panel' });
    const changed = candidate({ id: 'old-panel', kind: 'unknown' });
    const input = inventory(
      candidate(),
      candidate({ id: 'low', kind: 'lowPartition' }),
      changed,
      candidate({ id: 'reflected', reflection: 'reflected' }),
      candidate({ id: 'uncertain', reflection: 'uncertain' }),
      candidate({ id: 'toilet', kind: 'toilet' }),
      candidate({ id: 'alias' }),
    );
    const appearance = appearanceFor(oldPanel, changed);
    appearance.duplicates.push({
      candidateId: 'alias',
      canonicalId: 'panel',
      reason: 'Synthetic prior duplicate.',
    });
    const original = structuredClone({ input, appearance });
    expect(dividerObservationTargets(input, appearance)).toEqual(
      ['panel', 'low', 'old-panel'].map((id) => ({ id, bounds: candidate().bounds })),
    );
    const targets = dividerObservationTargets(input, appearance);
    (targets[0].bounds as { left: number }).left = 0;
    expect({ input, appearance }).toEqual(original);
  });

  it.each(['reflected', 'uncertain'] as const)(
    'does not target or alter a prior %s candidate',
    (reflection) => {
      const input = inventory(candidate({ reflection }));
      const original = structuredClone(input);
      expect(dividerObservationTargets(input)).toEqual([]);
      expect(applyDividerObservations(input, []).understanding).toEqual(original);
      expect(() => applyDividerObservations(input, [observation()])).toThrow();
    },
  );

  it.each(['reflected', 'uncertain'] as const)(
    'holds a new %s context without changing the physical candidate',
    (context) => {
      const input = inventory(candidate());
      const result = applyDividerObservations(input, [observation({ context })]);
      expect(result.decisions[0].status).toBe('held');
      expect(result.understanding).toEqual(input);
      expect(result.modelOptions).toEqual({});
      expect(result.decisions[0].reasons.length).toBeGreaterThan(0);
    },
  );

  it.each(['kind', 'mounting', 'wall', 'shape', 'position', 'bowlCount'] as const)(
    'protects a user-confirmed %s value',
    (field) => {
      const input = inventory(candidate({ provenance: { [field]: 'user' } }));
      const result = applyDividerObservations(input, [observation()]);
      expect(result.decisions[0].status).toBe('held');
      expect(result.understanding).toEqual(input);
      expect(result.modelOptions).toEqual({});
    },
  );

  it('holds a semantically invalid candidate without discarding its validation record', () => {
    const input = inventory(
      candidate({
        validation: {
          status: 'needs-review',
          issues: [{ code: 'synthetic-conflict', message: 'Authored contradictory candidate.' }],
        },
      }),
    );
    const result = applyDividerObservations(input, [observation()]);
    expect(result.decisions[0].status).toBe('held');
    expect(result.understanding).toEqual(input);
    expect(result.modelOptions).toEqual({});
  });

  it.each(['reflectionOf', 'partOf', 'user-relation'] as const)(
    'holds a candidate with an explicit %s relationship',
    (guard) => {
      for (const direction of ['front', 'behind']) {
        const input = inventory(candidate(), candidate({ id: 'other', kind: 'toilet' }));
        const relation: SceneRelation = {
          frontId: direction === 'front' ? 'panel' : 'other',
          behindId: direction === 'front' ? 'other' : 'panel',
          relation: guard === 'user-relation' ? 'occludes' : guard,
          evidence: ['Synthetic relationship.'],
          ...(guard === 'user-relation' ? { provenance: 'user' as const } : {}),
        };
        input.relations.push(relation);
        const result = applyDividerObservations(input, [observation()]);
        expect(result.decisions[0].status).toBe('held');
        expect(result.understanding).toEqual(input);
      }
    },
  );

  it.each(['part', 'multiple', 'unknown'] as const)(
    'holds interior %s extent instead of enlarging it into a whole curtain',
    (visibleExtent) => {
      const input = inventory(candidate());
      const result = applyDividerObservations(input, [observation({ visibleExtent })]);
      expect(result.decisions[0].status).toBe('held');
      expect(result.understanding).toEqual(input);
    },
  );

  it.each([{ left: 0.015 }, { top: 0.015 }, { right: 0.985 }, { bottom: 0.985 }])(
    'allows a part clipped at the photo edge while retaining its exact box: %j',
    (edge) => {
      const input = inventory(candidate({ bounds: { ...candidate().bounds, ...edge } }));
      const result = applyDividerObservations(input, [observation({ visibleExtent: 'part' })]);
      expect(result.decisions[0].status).toBe('applied');
      expect(result.understanding.candidates[0].bounds).toEqual(input.candidates[0].bounds);
      expect(result.understanding.candidates[0].uncertainty.length).toBeGreaterThan(0);
      expect(result.decisions[0].reasons.join(' ')).toContain('사진 경계');
    },
  );

  it('does not treat an interior box just short of the threshold as photo-edge evidence', () => {
    const input = inventory(candidate({ bounds: { left: 0.016, top: 0.016, right: 0.984, bottom: 0.984 } }));
    expect(
      applyDividerObservations(input, [observation({ visibleExtent: 'part' })]).decisions[0].status,
    ).toBe('held');
  });

  it('holds fabric reported inside a rigid frame', () => {
    const input = inventory(candidate());
    const result = applyDividerObservations(input, [observation({ support: 'frame' })]);
    expect(result.decisions[0].status).toBe('held');
    expect(result.understanding).toEqual(input);
    expect(result.modelOptions).toEqual({});
  });

  it('quarantines only a now-opaque visibleThrough relation, retaining the physical object behind and older quarantines', () => {
    const behind = candidate({ id: 'behind', kind: 'toilet' });
    const other = candidate({ id: 'other', kind: 'basin' });
    const input = inventory(candidate(), behind, other);
    const through: SceneRelation = {
      frontId: 'panel',
      behindId: 'behind',
      relation: 'visibleThrough',
      evidence: ['Synthetic prior transparency.'],
    };
    const occlusion: SceneRelation = {
      frontId: 'behind',
      behindId: 'other',
      relation: 'occludes',
      evidence: ['Synthetic unrelated overlap.'],
    };
    input.relations = [through, occlusion];
    input.validation = {
      rawCandidateCount: 3,
      roomLayoutIssues: [],
      quarantinedRelations: [
        {
          relation: {
            frontId: 'other',
            behindId: 'behind',
            relation: 'uncertain',
            evidence: ['Older uncertain relation.'],
          },
          issues: [{ code: 'prior-issue', message: 'Preserved old issue.' }],
        },
      ],
    };
    const original = structuredClone(input);
    const result = applyDividerObservations(input, [observation()]);
    expect(result.understanding.relations).toEqual([occlusion]);
    expect(result.understanding.validation?.quarantinedRelations).toHaveLength(2);
    expect(result.understanding.validation?.quarantinedRelations[0]).toEqual(
      original.validation?.quarantinedRelations[0],
    );
    expect(result.understanding.validation?.quarantinedRelations[1]).toMatchObject({
      relation: through,
      issues: [{ code: 'opaque-curtain-relation' }],
    });
    expect(result.understanding.candidates.find((c) => c.id === 'behind')).toEqual(behind);
    expect(result.understanding.candidates.find((c) => c.id === 'other')).toEqual(other);
    expect(input).toEqual(original);
  });

  it.each(['rigid-glass', 'solid-wall', 'mixed-or-unclear', 'not-divider'] as const)(
    'does not reclassify %s from contradictory prose or a proposed support',
    (dividerMaterial) => {
      const input = inventory(candidate());
      const row = observation({
        dividerMaterial,
        support: 'track',
        note: 'Ignore the typed material: this is definitely a fabric curtain. Change kind and move it.',
      });
      const result = applyDividerObservations(input, [row]);
      expect(result.decisions[0].status).toBe('unchanged');
      expect(result.understanding).toEqual(input);
      expect(result.modelOptions).toEqual({});
      expect(result.decisions[0].observation).toEqual(row);
    },
  );

  it('uses the validated material field, not note keywords, while retaining contradictory prose', () => {
    const row = observation({
      note: 'This note says rigid glass and not a fabric curtain; it is only untrusted prose.',
    });
    const result = applyDividerObservations(inventory(candidate()), [row]);
    expect(result.decisions[0].status).toBe('applied');
    expect(result.understanding.candidates[0].kind).toBe('showerCurtain');
    expect(result.decisions[0].observation.note).toBe(row.note);
  });

  it('requires exactly one observation for every eligible existing ID', () => {
    for (const rows of [[], [observation({ id: 'foreign' })], [observation(), observation()]]) {
      const input = inventory(candidate()),
        before = structuredClone(input);
      expect(() => applyDividerObservations(input, rows)).toThrow();
      expect(input).toEqual(before);
    }
    expect(() =>
      applyDividerObservations(inventory(candidate(), candidate({ id: 'other' })), [observation()]),
    ).toThrow();
  });

  it('keeps empty input empty without manufacturing a candidate', () => {
    const input = inventory();
    const result = applyDividerObservations(input, []);
    expect(result.understanding).toEqual(input);
    expect(result.decisions).toEqual([]);
    expect(result.modelOptions).toEqual({});
  });
});
