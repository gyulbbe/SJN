import { describe, expect, it } from 'vitest';
import { parseFixtureAppearance } from '../src/lib/reconstruction/fixture-appearance-observation';
import { resolveClassificationConflicts } from '../src/lib/reconstruction/classification-resolution';
import type { SceneUnderstanding, SceneCandidate } from '../src/lib/reconstruction/pipeline-contract';
import type { ReflectionRecheckEvidence } from '../src/lib/reconstruction/reflection-recheck';
import type { DividerApplication } from '../src/lib/reconstruction/divider-application';
import type { TargetExistenceObservation } from '../src/lib/reconstruction/target-existence-observation';

function setup(priorKind: SceneCandidate['kind'], proposedKind = 'mirror', context = 'physical') {
  const prior: SceneUnderstanding = {
    schemaVersion: 1,
    candidates: [
      {
        id: 'fixture',
        kind: priorKind,
        bounds: { left: 0.2, top: 0.2, right: 0.7, bottom: 0.8 },
        mounting: 'floor',
        wall: 'left',
        basinStyle: 'unknown',
        shape: 'rectangular',
        reflection: 'physical',
        evidence: ['Original observation'],
        uncertainty: [],
        anchor: {
          point: { x: 0.4, y: 0.8 },
          kind: 'floor-contact',
          evidence: ['Original floor contact'],
          uncertainty: [],
        },
      },
    ],
    relations: [],
    roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: [] },
  };
  const appearance = parseFixtureAppearance(
    JSON.stringify({
      schemaVersion: 1,
      observations: [
        {
          id: 'fixture',
          kind: proposedKind,
          context,
          shape: 'oval',
          counterSupport: 'unknown',
          sameObjectAs: null,
          note: 'A candidate with a visible outline.',
        },
      ],
    }),
    prior,
  );
  return {
    appearance,
    effective: structuredClone(appearance.understanding),
    protectedCandidateIds: new Set<string>(),
  };
}
function target(changes: Partial<TargetExistenceObservation> = {}): ReflectionRecheckEvidence {
  const observation: TargetExistenceObservation = {
    id: 'fixture',
    note: 'Independent structural observation.',
    kind: 'mirror',
    targetExistence: 'directly-visible-surface',
    objectScope: 'whole-object',
    showerStyle: 'unknown',
    lowerSupport: 'uncertain',
    partOf: null,
    sameObjectAs: null,
    visibleStructure: {
      cabinetBody: 'uncertain',
      cabinetDoors: 'uncertain',
      basinBowl: 'uncertain',
      pedestalToFloor: 'uncertain',
      toiletBowl: 'uncertain',
      toiletTank: 'uncertain',
      transparentPanel: 'uncertain',
      reflectivePanel: 'present',
    },
    ...changes,
  };
  // Pure-policy fixture only. Production entry validates actual receipt/raw bytes before this layer.
  return {
    decisions: [],
    observations: [{ observation, receipt: { targetId: 'fixture' }, rawTextSha256: 'a'.repeat(64) }],
  } as unknown as ReflectionRecheckEvidence;
}
function material(input: ReturnType<typeof setup>): DividerApplication {
  return {
    revision: 'observed-cropped-or-whole-curtain-v1',
    understanding: input.effective,
    modelOptions: {},
    decisions: [
      {
        candidateId: 'fixture',
        status: 'unchanged',
        original: input.effective.candidates[0],
        effective: input.effective.candidates[0],
        observation: {
          id: 'fixture',
          dividerMaterial: 'rigid-glass',
          context: 'physical',
          visibleExtent: 'whole',
          support: 'frame',
          note: 'A rigid framed panel is visible.',
        },
        reasons: [],
      },
    ],
  };
}
describe('classification conflicts preserve distinct immutable evidence', () => {
  it('restores all category-dependent prior fields and removes rejected options, without claiming confirmation', () => {
    const input = setup('glassPartition');
    const frozen = structuredClone(input);
    expect(input.effective.candidates[0].mounting).toBe('wall');
    expect(input.effective.candidates[0].anchor).toBeUndefined();
    const result = resolveClassificationConflicts(input);
    const restored = result.understanding.candidates[0];
    expect(restored).toMatchObject({
      ...input.appearance.decisions[0].original,
      uncertainty: expect.any(Array),
    });
    expect(result.record.decisions[0]).toMatchObject({
      action: 'retain-prior-hypothesis',
      needsReview: true,
      effectiveKind: 'glassPartition',
    });
    expect(result.appearance.modelOptions).toEqual({});
    expect(input).toEqual(frozen);
  });
  it('accepts an independently confirmed opaque cabinet instead of blindly retaining mirror cabinet', () => {
    const input = setup('mirrorCabinet', 'wall_cabinet');
    const reflection = target({
      kind: 'wall_cabinet',
      visibleStructure: {
        ...target().observations[0].observation.visibleStructure,
        cabinetBody: 'present',
        cabinetDoors: 'present',
        reflectivePanel: 'absent',
      },
    });
    const result = resolveClassificationConflicts({ ...input, reflection });
    expect(result.record.decisions[0].action).toBe('independent-confirmation');
    expect(result.understanding.candidates[0].kind).toBe('wallCabinet');
  });
  it('a whole/direct mirror answer does not override contradictory rigid-glass evidence', () => {
    const input = setup('glassPartition');
    const result = resolveClassificationConflicts({
      ...input,
      reflection: target(),
      divider: material(input),
    });
    expect(result.record.decisions[0].reasonCodes).toContain('independent-referent-conflict');
    expect(result.understanding.candidates[0].kind).toBe('glassPartition');
  });
  it('permits supported cross-family correction when no referent conflict exists', () => {
    expect(
      resolveClassificationConflicts({ ...setup('glassPartition'), reflection: target() }).record.decisions[0]
        .action,
    ).toBe('independent-confirmation');
  });
  it.each(['component', 'multiple-objects', 'uncertain'] as const)(
    'does not treat %s scope as whole-fixture proof',
    (objectScope) => {
      expect(
        resolveClassificationConflicts({ ...setup('shower'), reflection: target({ objectScope }) }).record
          .decisions[0].action,
      ).toBe('retain-prior-hypothesis');
    },
  );
  it('does not accept semantically inconsistent structure even when JSON enums are valid', () => {
    expect(
      resolveClassificationConflicts({
        ...setup('shower'),
        reflection: target({ showerStyle: 'handheld-rail' }),
      }).record.decisions[0].action,
    ).toBe('retain-prior-hypothesis');
  });
  it('retains physical window/shelf priors when a conflicting detail stage lacks independent evidence', () => {
    for (const [kind, proposed, context] of [
      ['window', 'mirror_cabinet', 'physical'],
      ['wallShelf', 'unknown', 'not-fixture'],
    ] as const) {
      const result = resolveClassificationConflicts(setup(kind, proposed, context));
      expect(result.understanding.candidates[0].kind).toBe(kind);
      expect(result.record.decisions[0].needsReview).toBe(true);
    }
  });
  it('preserves explicit independent negative reflection and non-target evidence', () => {
    const result = resolveClassificationConflicts({
      ...setup('mirror', 'mirror', 'reflected'),
      reflection: target({ targetExistence: 'only-depicted-in-reflection' }),
    });
    expect(result.record.decisions[0].action).toBe('independent-negative');
    expect(result.understanding.candidates[0].reflection).toBe('reflected');
  });
  it('does not turn a door frame into a door leaf', () => {
    expect(
      resolveClassificationConflicts(setup('door', 'door_frame_only')).understanding.candidates[0].kind,
    ).toBe('unknown');
  });
  it('does not resurrect duplicate or invalid candidates', () => {
    const input = setup('mirrorCabinet', 'window');
    input.effective.candidates[0].validation = {
      status: 'needs-review',
      issues: [{ code: 'target-same-object-duplicate', message: 'Same as a canonical cabinet' }],
    };
    const result = resolveClassificationConflicts(input);
    expect(result.record.decisions[0].action).toBe('unchanged');
    expect(result.understanding).toEqual(input.effective);
  });
  it('keeps unchanged shower candidates for downstream explicit-negative installedness gates', () => {
    const input = setup('shower', 'shower');
    expect(resolveClassificationConflicts(input).record.decisions[0].action).toBe('unchanged');
  });
  it('protects manual edits and preserves already-applied material refinement', () => {
    const input = setup('glassPartition');
    input.protectedCandidateIds.add('fixture');
    expect(resolveClassificationConflicts(input).record.decisions[0].action).toBe('protected');
    input.protectedCandidateIds.clear();
    const divider = material(input);
    divider.decisions[0].status = 'applied';
    expect(resolveClassificationConflicts({ ...input, divider }).record.decisions[0].reasonCodes).toContain(
      'independent-material-applied',
    );
  });
  it('rejects mismatched IDs/bounds without erasing evidence', () => {
    const input = setup('glassPartition');
    input.effective.candidates[0].bounds.left = 0.1;
    expect(() => resolveClassificationConflicts(input)).toThrow('영역');
  });
});

it('restores category-dependent fields after a validated recheck already restored the original family', () => {
  const input = setup('shower', 'glass_partition');
  const prior = input.appearance.decisions[0].original;
  prior.mounting = 'wall';
  prior.anchor = {
    point: { x: 0.4, y: 0.4 },
    kind: 'wall-attachment',
    evidence: ['Original wall attachment'],
    uncertainty: [],
  };
  input.effective.candidates[0].kind = 'shower';
  const reflection = target();
  reflection.decisions.push({
    candidateId: 'fixture',
    status: 'applied',
  } as ReflectionRecheckEvidence['decisions'][number]);
  const result = resolveClassificationConflicts({ ...input, reflection });
  expect(result.understanding.candidates[0]).toMatchObject({
    kind: 'shower',
    mounting: 'wall',
    anchor: prior.anchor,
  });
  expect(result.record.decisions[0]).toMatchObject({
    action: 'independent-confirmation',
    needsReview: false,
  });
  expect(result.appearance.modelOptions).toEqual({});
});
