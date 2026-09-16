import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import type { SceneCandidate, SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';
import {
  wallAlignmentObservation,
  suggestWallAlignments,
  type WallAlignmentReference,
} from '../src/lib/reconstruction/wall-alignment-suggestions';

const candidate = (
  id: string,
  kind: SceneCandidate['kind'],
  bounds: SceneCandidate['bounds'],
): SceneCandidate => ({
  id,
  kind,
  bounds,
  mounting: 'wall',
  wall: 'back',
  basinStyle: kind === 'basin' ? 'wall' : 'unknown',
  shape: 'unknown',
  reflection: 'physical',
  evidence: ['visible object'],
  uncertainty: [],
});
const scene = (): SceneUnderstanding => ({
  schemaVersion: 1,
  roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: [] },
  relations: [],
  candidates: [
    candidate('mirror', 'mirror', { left: 0.2, top: 0.15, right: 0.5, bottom: 0.4 }),
    candidate('basin', 'basin', { left: 0.21, top: 0.52, right: 0.49, bottom: 0.64 }),
  ],
});
const reference = (): WallAlignmentReference => ({
  id: 'basin',
  label: '세면대 · 사진 2',
  wall: 'back',
  plan: {
    version: 2,
    kind: 'basin',
    face: 'back',
    u: 0.35,
    v: 1 - 650 / 2400,
    baseHeightMm: 650,
    widthMm: 600,
    heightMm: 320,
    depthMm: 450,
    yawDegrees: 0,
  },
});
const input = () => {
  const s = scene();
  return {
    observation: wallAlignmentObservation(s, structuredClone(s), 'mirror', 'same-photo-input'),
    references: [reference()],
    room: { ...DEFAULT_ROOM, heightMm: 2400 },
    target: { kind: 'mirror' as const, widthMm: 600, heightMm: 800, depthMm: 25 },
    gapMm: 150,
  };
};

describe('same-photo wall position reference suggestions', () => {
  it('proposes without editing observation or current pose and records only inferred pending evidence', () => {
    const value = input(),
      before = structuredClone(value),
      result = suggestWallAlignments(value);
    expect(result).toHaveLength(1);
    expect(result[0].evidence).toMatchObject({
      source: 'inferred',
      confirmation: 'pending',
      targetId: 'mirror',
      parentId: 'basin',
    });
    expect(result[0].result).toMatchObject({
      status: 'ready',
      placement: { face: 'back', u: 0.35, baseHeightMm: 1120 },
    });
    expect(value).toEqual(before);
    result[0].evidence.parentBounds.left = 0;
    expect(value).toEqual(before);
  });
  it.each([
    'physical mismatch',
    'reflected',
    'uncertain',
    'semantic error',
    'missing input identity',
    'changed crop',
  ])('%s prevents a recommendation', (reason) => {
    const automatic = scene(),
      current = structuredClone(automatic);
    if (reason === 'physical mismatch') current.candidates[0].kind = 'toilet';
    if (reason === 'reflected') current.candidates[0].reflection = 'reflected';
    if (reason === 'uncertain') current.candidates[0].reflection = 'uncertain';
    if (reason === 'semantic error')
      current.candidates[0].validation = {
        status: 'needs-review',
        issues: [{ code: 'contradiction', message: 'invalid semantic fields' }],
      };
    if (reason === 'changed crop') current.candidates[0].bounds.left += 0.01;
    expect(
      wallAlignmentObservation(
        current,
        automatic,
        'mirror',
        reason === 'missing input identity' ? '' : 'input',
      ),
    ).toBeUndefined();
  });
  it.each(['occludes', 'visibleThrough', 'reflectionOf', 'uncertain'] as const)(
    'does not promote %s into an above relationship',
    (relation) => {
      const current = scene();
      current.relations = [
        { frontId: 'mirror', behindId: 'basin', relation, evidence: ['observed relationship'] },
      ];
      expect(wallAlignmentObservation(current, current, 'mirror', 'input')).toBeUndefined();
    },
  );
  it('does not use quarantined part relationships as reliable support evidence', () => {
    const current = scene();
    current.validation = {
      rawCandidateCount: 2,
      roomLayoutIssues: [],
      quarantinedRelations: [
        {
          relation: { frontId: 'mirror', behindId: 'basin', relation: 'partOf', evidence: [] },
          issues: [{ code: 'invalid', message: 'contradiction' }],
        },
      ],
    };
    expect(wallAlignmentObservation(current, current, 'mirror', 'input')).toBeUndefined();
  });
  it('keeps a correctly resolved vanity assembly and excludes its countertop basin as a second parent', () => {
    const current = scene();
    current.candidates[1] = { ...current.candidates[1], mounting: 'countertop', basinStyle: 'vanity' };
    current.candidates.push({
      ...candidate('vanity', 'vanity', { left: 0.18, top: 0.51, right: 0.52, bottom: 0.85 }),
      mounting: 'floor',
    });
    current.relations = [
      { frontId: 'basin', behindId: 'vanity', relation: 'partOf', evidence: ['bowl on countertop'] },
    ];
    const observation = wallAlignmentObservation(current, current, 'mirror', 'input');
    expect(observation?.parents.map((item) => item.id)).toEqual(['vanity']);
  });
  it('keeps unknown wall unresolved even when the object is at image left', () => {
    const value = input();
    value.observation!.target.wall = 'unknown';
    value.observation!.parents[0].wall = 'unknown';
    value.references[0] = {
      ...reference(),
      wall: undefined,
      plan: { ...reference().plan!, face: 'floor', u: 0.5, v: 0.5, baseHeightMm: 0, yawDegrees: 0 },
    };
    const result = suggestWallAlignments(value);
    expect(result).toHaveLength(1);
    expect(result[0].reference.wall).toBeUndefined();
    expect(result[0].result).toBeUndefined();
  });
  it('does not cross conflicting walls or reinterpret photo x as wall x', () => {
    const value = input();
    value.observation!.target.wall = 'left';
    expect(suggestWallAlignments(value)).toEqual([]);
    value.observation!.target.wall = 'back';
    value.observation!.target.bounds = { left: 0.01, top: 0.15, right: 0.31, bottom: 0.4 };
    value.observation!.parents[0].bounds = { left: 0.02, top: 0.52, right: 0.3, bottom: 0.64 };
    expect(suggestWallAlignments(value)[0].result).toMatchObject({ placement: { face: 'back', u: 0.35 } });
  });
  it.each(['below', 'disjoint', 'invalid bounds', 'no plan'] as const)(
    'does not suggest %s observations',
    (reason) => {
      const value = input();
      if (reason === 'below')
        value.observation!.target.bounds = { left: 0.2, top: 0.7, right: 0.5, bottom: 0.9 };
      if (reason === 'disjoint')
        value.observation!.target.bounds = { left: 0.7, top: 0.15, right: 0.9, bottom: 0.4 };
      if (reason === 'invalid bounds') value.observation!.parents[0].bounds.right = NaN;
      if (reason === 'no plan') value.references[0].plan = undefined;
      expect(suggestWallAlignments(value)).toEqual([]);
    },
  );
  it('offers at most three alternatives without applying or collapsing distinct parents', () => {
    const value = input();
    value.observation!.parents = Array.from({ length: 5 }, (_, i) => ({
      ...value.observation!.parents[0],
      id: `parent-${i}`,
    }));
    value.references = value.observation!.parents.map((parent, i) => ({
      ...reference(),
      id: parent.id,
      label: `사진 ${i + 2}`,
      plan: { ...reference().plan!, u: 0.25 + i * 0.1 },
    }));
    const result = suggestWallAlignments(value);
    expect(result).toHaveLength(3);
    expect(new Set(result.map((item) => item.reference.id)).size).toBe(3);
  });
  it.each(['ceiling', 'oversize', 'negative gap', 'wrong yaw'])(
    'shows %s placement held without shrinking or moving',
    (reason) => {
      const value = input();
      if (reason === 'ceiling') value.gapMm = 1600;
      if (reason === 'oversize') value.target.widthMm = 5000;
      if (reason === 'negative gap') value.gapMm = -1;
      if (reason === 'wrong yaw')
        value.references[0].plan = {
          ...reference().plan!,
          face: 'floor',
          u: 0.5,
          v: 0.5,
          baseHeightMm: 0,
          yawDegrees: 90,
        };
      const before = structuredClone(value),
        result = suggestWallAlignments(value);
      expect(result[0].result?.status).toBe('held');
      expect(value).toEqual(before);
    },
  );
});
