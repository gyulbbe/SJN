import { describe, expect, it } from 'vitest';
import {
  assessCameraRanking,
  CAMERA_RANKING_REVISION,
  type CameraRankingInput,
} from '../src/lib/reconstruction/camera-ranking';
import type { FixtureAppearanceDecision } from '../src/lib/reconstruction/fixture-appearance-observation';
import type { SceneCandidate, SceneRelation } from '../src/lib/reconstruction/pipeline-contract';

function candidate(
  id: string,
  x: number,
  y: number,
  kind: SceneCandidate['kind'] = 'toilet',
): SceneCandidate {
  return {
    id,
    kind,
    bounds: { left: x - 0.04, top: y - 0.04, right: x + 0.04, bottom: y + 0.04 },
    mounting: 'floor',
    wall: 'unknown',
    basinStyle: 'unknown',
    shape: 'rectangular',
    reflection: 'physical',
    evidence: ['Authored boundary test, not AI evidence.'],
    uncertainty: [],
  };
}
function decision(item: SceneCandidate, originalKind = item.kind): FixtureAppearanceDecision {
  return {
    candidateId: item.id,
    status: originalKind === item.kind ? 'confirmed' : 'applied',
    original: { ...structuredClone(item), kind: originalKind },
    effective: structuredClone(item),
    observation: {
      id: item.id,
      kind: 'toilet',
      context: 'physical',
      sameObjectAs: null,
      shape: 'unknown',
      counterSupport: 'unknown',
      note: 'Authored typed observations for camera ranking arithmetic.',
    },
    reasons: [],
  };
}
function example(): CameraRankingInput {
  const candidates = [
    candidate('a', 0.2, 0.2),
    candidate('b', 0.8, 0.2),
    candidate('c', 0.2, 0.8),
    candidate('conflict', 0.7, 0.7),
  ];
  return {
    candidates,
    decisions: candidates.map((c) => decision(c, c.id === 'conflict' ? 'wallShelf' : c.kind)),
    relations: [],
    solutions: [
      {
        id: 'legacy-camera',
        fullScore: 10,
        imageContributions: [
          { candidateId: 'a', image: 0.2 },
          { candidateId: 'b', image: 0.2 },
          { candidateId: 'c', image: 0.2 },
          { candidateId: 'conflict', image: 0.4 },
        ],
      },
      {
        id: 'alternative-camera',
        fullScore: 11,
        imageContributions: [
          { candidateId: 'a', image: 0.1 },
          { candidateId: 'b', image: 0.1 },
          { candidateId: 'c', image: 0.1 },
          { candidateId: 'conflict', image: 3 },
        ],
      },
    ],
  };
}
function setImage(input: CameraRankingInput, camera: number, id: string, value: number) {
  input.solutions[camera].imageContributions.find((c) => c.candidateId === id)!.image = value;
}
function relation(a: string, b: string, kind: SceneRelation['relation'] = 'partOf'): SceneRelation {
  return { frontId: a, behindId: b, relation: kind, evidence: ['Authored explicit relation.'] };
}
function addAgreement(input: CameraRankingInput, id: string, x: number, y: number) {
  const c = candidate(id, x, y);
  input.candidates = [...input.candidates, c];
  input.decisions = [...input.decisions, decision(c)];
  for (const s of input.solutions) s.imageContributions.push({ candidateId: id, image: 0.1 });
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
}

describe('camera ranking over authored solved scenes (arithmetic/stability, not recognition quality)', () => {
  it('withholds only known-kind-conflict image terms while retaining original full scores and all data', () => {
    const input = freeze(example()),
      original = structuredClone(input);
    const result = assessCameraRanking(input);
    expect(result.revision).toBe(CAMERA_RANKING_REVISION);
    expect(result.status).toBe('applied');
    expect(result.fullScoreWinner).toBe('legacy-camera');
    expect(result.selectedWinner).toBe('alternative-camera');
    expect(result.conflicts).toEqual([
      {
        candidateId: 'conflict',
        originalKind: 'wallShelf',
        effectiveKind: 'toilet',
      },
    ]);
    expect(result.rows).toEqual([
      { id: 'legacy-camera', fullScore: 10, withheldImage: 0.4, rankingScore: 9.6 },
      { id: 'alternative-camera', fullScore: 11, withheldImage: 3, rankingScore: 8 },
    ]);
    expect(result.agreementGroups.map((g) => g.candidateIds)).toEqual([['a'], ['b'], ['c']]);
    expect(result.leaveOneGroupOut).toHaveLength(3);
    expect(result.leaveOneGroupOut.every((c) => !c.tied && c.winner === 'alternative-camera')).toBe(true);
    expect(input).toEqual(original);
  });

  it.each([
    'unknown-original',
    'unknown-effective',
    'held',
    'duplicate',
    'manual',
    'current-user-kind',
    'effective-user-kind',
  ] as const)('does not treat %s as automatic known-kind conflict evidence', (condition) => {
    const input = example(),
      d = input.decisions[3],
      item = input.candidates[3];
    if (condition === 'unknown-original') d.original.kind = 'unknown';
    if (condition === 'unknown-effective') item.kind = d.effective.kind = 'unknown';
    if (condition === 'held') d.status = 'held';
    if (condition === 'duplicate') d.status = 'duplicate';
    if (condition === 'manual') input.manualIds = new Set([item.id]);
    if (condition === 'current-user-kind') item.provenance = { kind: 'user' };
    if (condition === 'effective-user-kind') d.effective.provenance = { kind: 'user' };
    const result = assessCameraRanking(input);
    expect(result.status).toBe('no-conflicts');
    expect(result.conflicts).toEqual([]);
    expect(result.rows.every((row) => row.withheldImage === 0)).toBe(true);
    expect(result.selectedWinner).toBe('legacy-camera');
  });

  it('does not infer a kind conflict from notes, shape or mounting changes alone', () => {
    const input = example(),
      d = input.decisions[3];
    d.original.kind = d.effective.kind;
    d.original.mounting = 'wall';
    d.original.shape = 'round';
    d.observation.note = 'The prose calls this a different kind; prose is not classification evidence.';
    const result = assessCameraRanking(input);
    expect(result.status).toBe('no-conflicts');
    expect(result.selectedWinner).toBe('legacy-camera');
  });

  it('ignores a stale kind decision after the current candidate kind has changed', () => {
    const input = example();
    input.candidates[3].kind = 'basin';
    const result = assessCameraRanking(input);
    expect(result.conflicts).toEqual([]);
    expect(result.selectedWinner).toBe('legacy-camera');
  });

  it('does not count a candidate absent from one camera solution as a common agreement anchor', () => {
    const input = example();
    input.solutions[1].imageContributions = input.solutions[1].imageContributions.filter(
      (c) => c.candidateId !== 'c',
    );
    const result = assessCameraRanking(input);
    expect(result.status).toBe('insufficient');
    expect(result.agreementGroups.map((g) => g.candidateIds)).toEqual([['a'], ['b']]);
    expect(result.selectedWinner).toBe('legacy-camera');
  });

  it('requires non-collinear image centres rather than merely three objects', () => {
    const input = example();
    input.candidates = input.candidates.map((c, i) =>
      i < 3 ? candidate(c.id, 0.2 + i * 0.2, 0.2 + i * 0.2) : c,
    );
    const result = assessCameraRanking(input);
    expect(result.agreementGroups).toHaveLength(3);
    expect(result.status).toBe('insufficient');
    expect(result.selectedWinner).toBe('legacy-camera');
  });

  it('falls back when one agreement group determines the ranking reversal', () => {
    const input = example();
    setImage(input, 0, 'a', 2);
    setImage(input, 1, 'conflict', 2);
    const result = assessCameraRanking(input);
    expect(result.proposedWinner).toBe('alternative-camera');
    expect(result.status).toBe('unstable');
    expect(result.leaveOneGroupOut.find((c) => c.candidateIds.includes('a'))?.winner).toBe('legacy-camera');
    expect(result.selectedWinner).toBe('legacy-camera');
  });

  it('falls back on adjusted-score ties and preserves the original winner', () => {
    const input = example();
    setImage(input, 1, 'conflict', 1.4);
    const result = assessCameraRanking(input);
    expect(result.status).toBe('unstable');
    expect(result.rows[0].rankingScore).toBeCloseTo(result.rows[1].rankingScore);
    expect(result.selectedWinner).toBe('legacy-camera');
  });

  it('preserves original solution order for full-score ties on a fallback', () => {
    const input = example();
    input.solutions[0].id = 'z-original-first';
    input.solutions[1].id = 'a-second';
    input.solutions[1].fullScore = input.solutions[0].fullScore;
    input.decisions[3].status = 'held';
    const result = assessCameraRanking(input);
    expect(result.status).toBe('no-conflicts');
    expect(result.fullScoreWinner).toBe('z-original-first');
    expect(result.selectedWinner).toBe('z-original-first');
  });

  it('treats an explicit partOf group as one leave-one-out vote, never two correlated anchors', () => {
    const input = example();
    addAgreement(input, 'd', 0.25, 0.25);
    input.relations = [relation('a', 'd')];
    const result = assessCameraRanking(input);
    expect(result.status).toBe('applied');
    expect(result.agreementGroups.map((g) => g.candidateIds)).toEqual([['a', 'd'], ['b'], ['c']]);
    const groupCheck = result.leaveOneGroupOut.find((c) => c.candidateIds.includes('d'))!;
    expect(groupCheck.candidateIds).toEqual(['a', 'd']);
    // Removing both group members leaves scores 9.3 vs 7.8.
    expect(groupCheck.margin).toBeCloseTo(1.5);
    expect(result.leaveOneGroupOut).toHaveLength(3);
  });

  it('excludes an entire mixed partOf group containing a conflicting member', () => {
    const input = example();
    input.relations = [relation('a', 'conflict')];
    const result = assessCameraRanking(input);
    expect(result.agreementGroups.map((g) => g.candidateIds)).toEqual([['b'], ['c']]);
    expect(result.conflicts.map((c) => c.candidateId)).toEqual(['conflict']);
    expect(result.rows[1].withheldImage).toBe(3);
    expect(result.status).toBe('insufficient');
    expect(result.selectedWinner).toBe('legacy-camera');
  });

  it('obeys explicit assembly/alias anchor exclusions without withholding their non-conflict image terms', () => {
    const input = example();
    input.excludedAnchorIds = new Set(['a']);
    const result = assessCameraRanking(input);
    expect(result.agreementGroups.map((g) => g.candidateIds)).toEqual([['b'], ['c']]);
    expect(result.rows.map((r) => r.withheldImage)).toEqual([0.4, 3]);
    expect(result.status).toBe('insufficient');
    expect(result.selectedWinner).toBe('legacy-camera');
  });

  it('does not create correlated groups from occlusion or a prose part description', () => {
    const input = example();
    input.relations = [relation('a', 'b', 'occludes')];
    input.decisions[0].observation.note =
      'A possible part of another fixture, authored unstructured description.';
    const result = assessCameraRanking(input);
    expect(result.agreementGroups.map((g) => g.candidateIds)).toEqual([['a'], ['b'], ['c']]);
    expect(result.status).toBe('applied');
  });

  it.each<[string, (input: CameraRankingInput) => void]>([
    [
      'duplicate candidate ID',
      (x) => {
        x.candidates = [...x.candidates, structuredClone(x.candidates[0])];
      },
    ],
    [
      'duplicate decision ID',
      (x) => {
        x.decisions = [...x.decisions, structuredClone(x.decisions[0])];
      },
    ],
    [
      'unknown decision ID',
      (x) => {
        x.decisions[0].candidateId = 'missing';
      },
    ],
    [
      'mismatched original ID',
      (x) => {
        x.decisions[0].original.id = 'missing';
      },
    ],
    [
      'mismatched effective ID',
      (x) => {
        x.decisions[0].effective.id = 'missing';
      },
    ],
    [
      'duplicate camera ID',
      (x) => {
        x.solutions[1].id = x.solutions[0].id;
      },
    ],
    [
      'unknown contribution ID',
      (x) => {
        x.solutions[0].imageContributions[0].candidateId = 'missing';
      },
    ],
    [
      'duplicate contribution ID',
      (x) => {
        x.solutions[0].imageContributions.push({ ...x.solutions[0].imageContributions[0] });
      },
    ],
    [
      'negative image',
      (x) => {
        setImage(x, 0, 'a', -0.1);
      },
    ],
    [
      'nonfinite image',
      (x) => {
        setImage(x, 0, 'a', Number.NaN);
      },
    ],
    [
      'negative full score',
      (x) => {
        x.solutions[0].fullScore = -1;
      },
    ],
    [
      'nonfinite full score',
      (x) => {
        x.solutions[0].fullScore = Number.POSITIVE_INFINITY;
      },
    ],
    [
      'image sum larger than full score',
      (x) => {
        setImage(x, 0, 'conflict', 10);
      },
    ],
  ])('rejects %s without mutating the supplied evidence or applying a new rank', (_name, corrupt) => {
    const input = example();
    corrupt(input);
    const preserved = structuredClone(input);
    const result = assessCameraRanking(input);
    expect(result.status).toBe('invalid');
    expect(result.selectedWinner).toBe(result.fullScoreWinner);
    expect(input).toEqual(preserved);
  });

  it.each(['nonfinite', 'reversed', 'outside'] as const)(
    'excludes a %s anchor box from geometry support',
    (kind) => {
      const input = example(),
        box = input.candidates[0].bounds;
      if (kind === 'nonfinite') box.left = Number.NaN;
      if (kind === 'reversed') box.right = box.left;
      if (kind === 'outside') box.left = -0.1;
      const result = assessCameraRanking(input);
      expect(result.status).toBe('insufficient');
      expect(result.agreementGroups.flatMap((g) => g.candidateIds)).not.toContain('a');
      expect(result.selectedWinner).toBe('legacy-camera');
    },
  );

  it('has no new camera to apply for an empty or single-camera input', () => {
    const empty = example();
    empty.solutions = [];
    const none = assessCameraRanking(empty);
    expect(none.status).not.toBe('applied');
    expect(none.selectedWinner).toBeUndefined();
    const single = example();
    single.solutions = [single.solutions[0]];
    const one = assessCameraRanking(single);
    expect(one.status).toBe('insufficient');
    expect(one.selectedWinner).toBe('legacy-camera');
  });

  it('is deterministic across candidate, decision, contribution and relation order for unequal full scores', () => {
    const input = example();
    addAgreement(input, 'd', 0.25, 0.25);
    addAgreement(input, 'e', 0.3, 0.3);
    input.relations = [relation('a', 'd'), relation('d', 'e')];
    const expected = assessCameraRanking(input),
      shuffled = structuredClone(input);
    shuffled.candidates = [...shuffled.candidates].reverse();
    shuffled.decisions = [...shuffled.decisions].reverse();
    shuffled.solutions = [...shuffled.solutions].reverse();
    for (const row of shuffled.solutions) row.imageContributions.reverse();
    shuffled.relations.reverse();
    const result = assessCameraRanking(shuffled);
    expect(result.status).toBe(expected.status);
    expect(result.selectedWinner).toBe(expected.selectedWinner);
    expect(result.conflicts).toEqual(expected.conflicts);
    expect(result.agreementGroups).toEqual(expected.agreementGroups);
    expect(result.rows).toEqual(expected.rows);
    expect(result.leaveOneGroupOut.map((c) => ({ ...c, margin: Number(c.margin.toFixed(10)) }))).toEqual(
      expected.leaveOneGroupOut.map((c) => ({ ...c, margin: Number(c.margin.toFixed(10)) })),
    );
  });
});
