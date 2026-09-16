import { describe, expect, it } from 'vitest';
import { resolveSceneCandidates } from '../src/lib/reconstruction/candidate-resolution';
import type { SceneCandidate, SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';

function item(id: string, kind: SceneCandidate['kind'] = 'toilet'): SceneCandidate {
  return {
    id,
    kind,
    bounds: { left: 0.2, top: 0.3, right: 0.6, bottom: 0.8 },
    mounting: 'floor',
    wall: 'back',
    basinStyle: 'unknown',
    shape: 'unknown',
    reflection: 'physical',
    evidence: ['test observation'],
    uncertainty: [],
  };
}
function scene(
  candidates: SceneCandidate[],
  relations: SceneUnderstanding['relations'] = [],
): SceneUnderstanding {
  return {
    schemaVersion: 1,
    candidates,
    relations,
    roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: [] },
  };
}

describe('observation resolution independent of camera placement', () => {
  it('counts repeated observations once and preserves original IDs and evidence', () => {
    const input = scene([item('one'), item('two'), item('three')]);
    const copy = structuredClone(input);
    const result = resolveSceneCandidates(input);
    expect(result.resolution).toMatchObject({ rawCount: 3, organizedCount: 1, duplicateCount: 2 });
    expect(result.effective).toHaveLength(3);
    expect(result.resolution.entries[1]).toMatchObject({ disposition: 'duplicate', representativeId: 'one' });
    result.effective[0].evidence.push('changed derived value');
    expect(input).toEqual(copy);
  });
  it('holds conflicting support descriptions instead of silently selecting the first repeated basin', () => {
    const a = { ...item('a', 'basin'), basinStyle: 'pedestal' as const };
    const b = { ...item('b', 'basin'), mounting: 'wall' as const, basinStyle: 'wall' as const };
    const result = resolveSceneCandidates(scene([a, b]));
    expect(result.resolution.duplicateCount).toBe(0);
    expect(result.resolution.entries.map((e) => e.disposition)).toEqual(['conflict', 'conflict']);
  });
  it('holds a mirror/cabinet kind conflict while allowing genuinely overlapping glass and bath', () => {
    const input = scene([
      item('mirror', 'mirror'),
      item('cabinet', 'mirrorCabinet'),
      item('glass', 'glassPartition'),
      item('bath', 'bath'),
    ]);
    const result = resolveSceneCandidates(input);
    expect(result.resolution.entries.map((e) => e.disposition)).toEqual([
      'conflict',
      'conflict',
      'fixture',
      'fixture',
    ]);
  });
  it('keeps quarantined candidates and uncertain reflections in review without discarding valid observations', () => {
    const invalid = {
      ...item('bad'),
      validation: {
        status: 'needs-review' as const,
        issues: [{ code: 'support', message: 'incompatible support' }],
      },
    };
    const result = resolveSceneCandidates(
      scene([
        item('valid'),
        invalid,
        { ...item('reflected'), reflection: 'reflected' },
        { ...item('uncertain'), reflection: 'uncertain' },
      ]),
    );
    expect(result.resolution.entries.map((e) => e.disposition)).toEqual([
      'fixture',
      'invalid',
      'reflection',
      'conflict',
    ]);
    expect(result.resolution.organizedCount).toBe(3);
  });
  it('represents two distinct countertop bowls as components of one floor-standing vanity', () => {
    const parent = item('cabinet', 'vanity');
    const child = (id: string, left: number): SceneCandidate => ({
      ...item(id, 'basin'),
      bounds: { left, top: 0.3, right: left + 0.13, bottom: 0.43 },
      mounting: 'countertop',
      basinStyle: 'vanity',
      shape: 'round',
    });
    const input = scene(
      [parent, child('left', 0.23), child('right', 0.43)],
      [
        { frontId: 'left', behindId: 'cabinet', relation: 'partOf', evidence: ['same counter'] },
        { frontId: 'right', behindId: 'cabinet', relation: 'partOf', evidence: ['same counter'] },
      ],
    );
    const result = resolveSceneCandidates(input);
    expect(result.resolution).toMatchObject({ rawCount: 3, organizedCount: 1, componentCount: 2 });
    expect(result.effective[0]).toMatchObject({
      bowlCount: 2,
      shape: 'round',
      provenance: { bowlCount: 'geometry', shape: 'geometry' },
    });
    expect(input.candidates[0]).not.toHaveProperty('bowlCount');
    expect(result.resolution.assemblies[0].componentIds).toEqual(['left', 'right']);
  });
  it('does not infer a second bowl from cabinet dimensions or a single unlinked observation', () => {
    const result = resolveSceneCandidates(scene([item('cabinet', 'vanity')]));
    expect(result.effective[0].bowlCount).toBeUndefined();
    expect(result.resolution.assemblies).toEqual([]);
  });
  it('does not place a countertop bowl using its invalid floor contact even if it belongs to a cabinet', () => {
    const child: SceneCandidate = {
      ...item('bowl', 'basin'),
      mounting: 'countertop',
      basinStyle: 'vanity',
      validation: {
        status: 'needs-review',
        issues: [{ code: 'anchor', message: 'countertop is not floor' }],
      },
    };
    const result = resolveSceneCandidates(
      scene(
        [item('cabinet', 'vanity'), child],
        [{ frontId: 'bowl', behindId: 'cabinet', relation: 'partOf', evidence: ['support'] }],
      ),
    );
    expect(result.resolution.entries[1].disposition).toBe('invalid');
    expect(result.resolution.componentCount).toBe(0);
  });
});

it('holds every member of a same-boundary three-kind conflict', () => {
  const result = resolveSceneCandidates(
    scene([item('a', 'mirror'), item('b', 'mirrorCabinet'), item('c', 'window')]),
  );
  expect(result.resolution.entries.map((e) => e.disposition)).toEqual(['conflict', 'conflict', 'conflict']);
});
it('rewires duplicate parent relation references without mutating original observation IDs', () => {
  const parent = item('cabinet', 'vanity');
  const duplicate = { ...parent, id: 'repeat' };
  const child: SceneCandidate = {
    ...item('bowl', 'basin'),
    mounting: 'countertop',
    basinStyle: 'vanity',
    bounds: { left: 0.3, right: 0.4, top: 0.3, bottom: 0.4 },
  };
  const input = scene(
    [parent, duplicate, child],
    [{ frontId: 'bowl', behindId: 'repeat', relation: 'partOf', evidence: ['same counter'] }],
  );
  const result = resolveSceneCandidates(input);
  expect(result.resolution.assemblies[0]).toMatchObject({
    parentId: 'cabinet',
    componentIds: ['bowl'],
    bowlCount: 1,
  });
  expect(result.resolution).toMatchObject({ organizedCount: 1, duplicateCount: 1, componentCount: 1 });
  expect(input.relations[0].behindId).toBe('repeat');
});

it('never compares user placeholder bounds as photo observations of mirror/window conflicts', () => {
  const added = (id: string, kind: SceneCandidate['kind']): SceneCandidate => ({
    ...item(id, kind),
    bounds: { left: 0, top: 0, right: 1, bottom: 1 },
    provenance: { kind: 'user', position: 'user' },
  });
  const result = resolveSceneCandidates(
    scene([added('mirror', 'mirror'), added('window', 'window')]),
    scene([]),
  );
  expect(result.resolution.entries.map((e) => e.disposition)).toEqual(['fixture', 'fixture']);
});
it('keeps the cabinet body shape separate from component bowl shape and field-specific confirmation', () => {
  const parent = { ...item('cabinet', 'vanity'), shape: 'rectangular' as const };
  const child: SceneCandidate = {
    ...item('bowl', 'basin'),
    mounting: 'countertop',
    basinStyle: 'vanity',
    shape: 'round',
    provenance: { kind: 'user' },
    bounds: { left: 0.3, right: 0.4, top: 0.3, bottom: 0.4 },
  };
  const result = resolveSceneCandidates(
    scene(
      [parent, child],
      [{ frontId: 'bowl', behindId: 'cabinet', relation: 'partOf', evidence: ['same counter'] }],
    ),
  );
  expect(result.effective[0]).toMatchObject({
    shape: 'round',
    provenance: { shape: 'geometry', bowlCount: 'geometry' },
  });
  expect(result.resolution.assemblies[0]).toMatchObject({
    parentReportedShape: 'rectangular',
    shape: 'round',
  });
  expect(result.resolution.entries[0].reasons.join(' ')).toContain('부품 관측');
});

describe('repeated uncertain observations', () => {
  const uncertain = (id: string, kind: SceneCandidate['kind'] = 'wallShelf'): SceneCandidate => ({
    ...item(id, kind),
    mounting: 'wall',
    wall: 'unknown',
    reflection: 'uncertain',
    uncertainty: [`${id}: depth not observed`],
  });

  it('organizes repetitions without confirming reflection, depth, or changing original reports', () => {
    const first = uncertain('first');
    const preferred: SceneCandidate = {
      ...uncertain('preferred'),
      anchor: {
        kind: 'wall-attachment',
        point: { x: 0.4, y: 0.6 },
        evidence: ['visible attachment'],
        uncertainty: ['attachment height unknown'],
      },
    };
    const repeat: SceneCandidate = {
      ...uncertain('repeat'),
      anchor: { ...structuredClone(preferred.anchor!), uncertainty: ['attachment depth unknown'] },
    };
    const input = scene([first, preferred, repeat]);
    const original = structuredClone(input);
    const result = resolveSceneCandidates(input);
    expect(result.resolution).toMatchObject({
      rawCount: 3,
      organizedCount: 1,
      duplicateCount: 2,
      componentCount: 0,
    });
    expect(result.resolution.entries.map((entry) => entry.disposition)).toEqual([
      'duplicate',
      'conflict',
      'duplicate',
    ]);
    expect(result.resolution.entries[0].representativeId).toBe('preferred');
    expect(result.resolution.entries[2].representativeId).toBe('preferred');
    expect(result.effective[1]).toMatchObject({ reflection: 'uncertain', wall: 'unknown', shape: 'unknown' });
    expect(result.effective[1].uncertainty).toEqual(
      expect.arrayContaining(input.candidates.flatMap((entry) => entry.uncertainty)),
    );
    expect(result.effective[1].anchor!.uncertainty).toEqual([
      'attachment height unknown',
      'attachment depth unknown',
    ]);
    expect(result.resolution.entries[1].reasons.join(' ')).toContain('확인이 필요');
    expect(result.resolution.assemblies).toEqual([]);
    expect(input).toEqual(original);
  });

  it('does not let an unknown representative bridge contradictory member shapes', () => {
    const first: SceneCandidate = {
      ...uncertain('unknown', 'mirror'),
      anchor: {
        kind: 'wall-attachment',
        point: { x: 0.4, y: 0.6 },
        evidence: ['visible edge'],
        uncertainty: [],
      },
    };
    const result = resolveSceneCandidates(
      scene([
        first,
        { ...uncertain('rectangular', 'mirror'), shape: 'rectangular' },
        { ...uncertain('round', 'mirror'), shape: 'round' },
      ]),
    );
    expect(result.resolution.entries.map((entry) => entry.disposition)).toEqual([
      'conflict',
      'duplicate',
      'conflict',
    ]);
    expect(result.effective[0].shape).toBe('unknown');
    expect(result.effective[2].shape).toBe('round');
  });

  it.each([
    ['mounting', 'wall', 'floor'],
    ['wall', 'back', 'left'],
    ['shape', 'round', 'rectangular'],
    ['basinStyle', 'wall', 'pedestal'],
    ['bowlCount', 1, 2],
  ] as const)('retains conflicting known %s values', (field, av, bv) => {
    const a = { ...uncertain('a', 'basin'), [field]: av };
    const b = { ...uncertain('b', 'basin'), [field]: bv };
    const result = resolveSceneCandidates(scene([a, b]));
    expect(result.resolution.entries.map((entry) => entry.disposition)).toEqual(['conflict', 'conflict']);
    expect(result.resolution.duplicateCount).toBe(0);
  });

  it.each(['occludes', 'visibleThrough', 'uncertain', 'partOf'] as const)(
    'preserves an explicit %s relation between overlapping observations',
    (relation) => {
      const input = scene(
        [uncertain('a'), uncertain('b')],
        [{ frontId: 'a', behindId: 'b', relation, evidence: ['two overlapping observations'] }],
      );
      const result = resolveSceneCandidates(input);
      expect(result.resolution.entries.map((entry) => entry.disposition)).toEqual(['conflict', 'conflict']);
      expect(result.resolution.duplicateCount).toBe(0);
      expect(result.effective.map((entry) => entry.reflection)).toEqual(['uncertain', 'uncertain']);
    },
  );

  it('keeps a physical fixture, its reflection, and an uncertain overlapping observation separate', () => {
    const result = resolveSceneCandidates(
      scene([
        { ...uncertain('physical'), reflection: 'physical' },
        { ...uncertain('reflected'), reflection: 'reflected' },
        uncertain('uncertain'),
      ]),
    );
    expect(result.resolution.entries.map((entry) => entry.disposition)).toEqual([
      'fixture',
      'reflection',
      'conflict',
    ]);
    expect(result.resolution.duplicateCount).toBe(0);
  });

  it('preserves a reflectionOf source even when its own reflection label is uncertain', () => {
    const result = resolveSceneCandidates(
      scene(
        [uncertain('copy'), uncertain('unsure'), { ...uncertain('real'), reflection: 'physical' }],
        [{ frontId: 'copy', behindId: 'real', relation: 'reflectionOf', evidence: ['mirror duplicate'] }],
      ),
    );
    expect(result.resolution.entries.map((entry) => entry.disposition)).toEqual([
      'reflection',
      'conflict',
      'fixture',
    ]);
    expect(result.resolution.duplicateCount).toBe(0);
  });

  it('does not merge overlapping bowls assigned to different supporting cabinets', () => {
    const a = { ...uncertain('a', 'basin'), mounting: 'countertop' as const, basinStyle: 'vanity' as const };
    const b = { ...a, id: 'b' };
    const left = { ...uncertain('left', 'vanity'), reflection: 'physical' as const };
    const right = { ...left, id: 'right', bounds: { left: 0.7, top: 0.3, right: 0.95, bottom: 0.8 } };
    const input = scene(
      [a, b, left, right],
      [
        { frontId: 'a', behindId: 'left', relation: 'partOf', evidence: ['left counter'] },
        { frontId: 'b', behindId: 'right', relation: 'partOf', evidence: ['right counter'] },
      ],
    );
    const result = resolveSceneCandidates(input);
    expect(result.resolution.duplicateCount).toBe(0);
    expect(result.resolution.entries.slice(0, 2).map((entry) => entry.disposition)).toEqual([
      'conflict',
      'conflict',
    ]);
    expect(result.resolution.assemblies).toEqual([]);
  });

  it('merges repeated relation claims but retains their unknown depth and reflected status', () => {
    const a = uncertain('a');
    const b = uncertain('b');
    const result = resolveSceneCandidates(
      scene(
        [a, b, item('glass', 'glassPartition')],
        [
          { frontId: 'a', behindId: 'glass', relation: 'visibleThrough', evidence: ['behind glass'] },
          { frontId: 'b', behindId: 'glass', relation: 'visibleThrough', evidence: ['same glass'] },
        ],
      ),
    );
    expect(result.resolution.entries.map((entry) => entry.disposition)).toEqual([
      'conflict',
      'duplicate',
      'fixture',
    ]);
    expect(result.effective[0].reflection).toBe('uncertain');
    expect(result.effective[0].wall).toBe('unknown');
  });

  it('keeps quarantined relation ambiguity instead of treating it as absent evidence', () => {
    const input = scene([uncertain('a'), uncertain('b')]);
    input.validation = {
      rawCandidateCount: 2,
      roomLayoutIssues: [],
      quarantinedRelations: [
        {
          relation: { frontId: 'a', behindId: 'b', relation: 'uncertain', evidence: [] },
          issues: [{ code: 'evidence', message: 'relation evidence missing' }],
        },
      ],
    };
    const result = resolveSceneCandidates(input);
    expect(result.resolution.duplicateCount).toBe(0);
  });

  it('retains invalid or unknown-kind observations for correction', () => {
    const invalid: SceneCandidate = {
      ...uncertain('bad'),
      validation: { status: 'needs-review', issues: [{ code: 'support', message: 'support conflict' }] },
    };
    const result = resolveSceneCandidates(
      scene([
        uncertain('valid'),
        invalid,
        uncertain('unknown-a', 'unknown'),
        uncertain('unknown-b', 'unknown'),
      ]),
    );
    expect(result.resolution.entries.map((entry) => entry.disposition)).toEqual([
      'conflict',
      'invalid',
      'conflict',
      'conflict',
    ]);
    expect(result.resolution.duplicateCount).toBe(0);
  });

  it('keeps different photo positions and different observed attachment points separate', () => {
    const anchor = (x: number): NonNullable<SceneCandidate['anchor']> => ({
      kind: 'wall-attachment',
      point: { x, y: 0.6 },
      evidence: ['distinct contact'],
      uncertainty: [],
    });
    const result = resolveSceneCandidates(
      scene([
        { ...uncertain('left'), anchor: anchor(0.25) },
        { ...uncertain('right'), anchor: anchor(0.55) },
        { ...uncertain('elsewhere'), bounds: { left: 0.7, top: 0.3, right: 0.95, bottom: 0.8 } },
      ]),
    );
    expect(result.resolution.duplicateCount).toBe(0);
  });

  it('does not group separate user additions by placeholder bounds', () => {
    const added = (id: string): SceneCandidate => ({
      ...uncertain(id),
      bounds: { left: 0, top: 0, right: 1, bottom: 1 },
      provenance: { kind: 'user', position: 'user' },
    });
    const result = resolveSceneCandidates(scene([added('one'), added('two')]), scene([]));
    expect(result.resolution.duplicateCount).toBe(0);
  });
});
