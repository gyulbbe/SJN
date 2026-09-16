import { describe, expect, it } from 'vitest';
import { resolveSceneCandidates } from '../src/lib/reconstruction/candidate-resolution';
import {
  parseSceneUnderstanding,
  sceneUnderstandingJsonSchema,
  validateUserUnderstanding,
  SCENE_UNDERSTANDING_PROMPT,
} from '../src/lib/reconstruction/scene-understanding';
const item = (id = 'item1') => ({
  id,
  kind: 'basin',
  bounds: { left: 0.1, top: 0.3, right: 0.4, bottom: 0.6 },
  mounting: 'wall',
  wall: 'left',
  basinStyle: 'wall',
  shape: 'rectangular',
  reflection: 'physical',
  evidence: ['Visible bowl attached to wall.'],
  uncertainty: [],
  anchor: null,
});
const scene = () => ({
  schemaVersion: 1,
  candidates: [item()],
  relations: [] as Record<string, unknown>[],
  roomLayout: {
    backWallQuad: null,
    orthogonal: 'unknown',
    evidence: [],
    uncertainty: ['Room cropped.'],
    lines: [],
    corners: [] as Record<string, unknown>[],
  },
});
const parse = (v: unknown) => parseSceneUnderstanding(JSON.stringify(v));
describe('structured scene output validation (synthetic responses, not recognition evaluation)', () => {
  it('retains unknown and model field provenance without inventing dimensions or candidates', () => {
    const source = scene();
    source.candidates = [];
    expect(parse(source).candidates).toEqual([]);
    const result = parse(scene());
    expect(result.candidates[0].provenance?.kind).toBe('model');
    expect(result.candidates[0]).not.toHaveProperty('widthMm');
    expect(result.candidates[0]).not.toHaveProperty('anchor');
  });
  it('rejects duplicate IDs and invalid/oversized/malformed JSON', () => {
    const source = scene();
    source.candidates.push(item());
    expect(() => parse(source)).toThrow(/중복/);
    expect(() => parseSceneUnderstanding('x'.repeat(150001))).toThrow();
    expect(() => parseSceneUnderstanding('throw new Error()')).toThrow();
  });
  it('rejects nonfinite or out-of-range coordinates without repairing broken numeric data', () => {
    for (const bounds of [
      { left: -1, top: 0, right: 1, bottom: 1 },
      { left: NaN, top: 0, right: 1, bottom: 1 },
    ]) {
      const source = scene();
      source.candidates[0].bounds = bounds;
      expect(() => parse(source)).toThrow();
    }
  });
  it('quarantines inconsistent support and anchors without discarding a healthy unrelated fixture', () => {
    const source = scene();
    source.candidates.push(item('healthy'));
    source.candidates[0].mounting = 'floor';
    expect(parse(source).candidates[0].validation?.issues[0].code).toBe('basin-support');
    expect(parse(source).candidates[1].validation).toBeUndefined();
    source.candidates[0].kind = 'mirror';
    expect(
      parse(source).candidates[0].validation?.issues.some((issue) => issue.code === 'non-basin-support'),
    ).toBe(true);
    source.candidates[0] = {
      ...item(),
      anchor: {
        point: { x: 0.2, y: 0.6 },
        kind: 'floor-contact',
        evidence: ['Visible contact'],
        uncertainty: [],
      },
    } as unknown as ReturnType<typeof item>;
    expect(
      parse(source).candidates[0].validation?.issues.some((issue) => issue.code === 'anchor-mounting'),
    ).toBe(true);
    expect(parse(source).candidates[1].validation).toBeUndefined();
  });
  it('isolates dangling/self references and wrong transparent/reflected relationships', () => {
    const source = scene();
    source.candidates.push({
      ...item('item2'),
      kind: 'toilet',
      basinStyle: 'unknown',
      mounting: 'floor',
      wall: 'unknown',
    });
    for (const relation of [
      { frontId: 'missing', behindId: 'item2', relation: 'occludes' },
      { frontId: 'item1', behindId: 'item1', relation: 'occludes' },
      { frontId: 'item1', behindId: 'item2', relation: 'visibleThrough' },
      { frontId: 'item1', behindId: 'item2', relation: 'reflectionOf' },
    ]) {
      source.relations = [{ ...relation, evidence: [] }];
      const result = parse(source);
      expect(result.candidates).toHaveLength(2);
      expect(result.relations).toEqual([]);
      expect(result.validation?.quarantinedRelations).toHaveLength(1);
    }
  });
  it('keeps overlapping glass and physical objects while naming reflections separately', () => {
    const source = scene();
    source.candidates = [
      { ...item('glass'), kind: 'glassPartition', basinStyle: 'unknown', mounting: 'floor', wall: 'unknown' },
      { ...item('actual') },
      { ...item('copy'), reflection: 'reflected' },
    ];
    source.relations = [
      {
        frontId: 'glass',
        behindId: 'actual',
        relation: 'visibleThrough',
        evidence: ['Glass edge in front.'],
      },
      { frontId: 'copy', behindId: 'actual', relation: 'reflectionOf', evidence: ['Same faucet in mirror.'] },
    ];
    expect(parse(source).candidates).toHaveLength(3);
  });
  it('isolates contradictory relations and retains fixtures when room corners need review', () => {
    const source = scene();
    source.candidates.push(item('item2'));
    source.relations = [
      { frontId: 'item1', behindId: 'item2', relation: 'occludes', evidence: [] },
      { frontId: 'item2', behindId: 'item1', relation: 'occludes', evidence: [] },
    ];
    expect(parse(source).validation?.quarantinedRelations).toHaveLength(2);
    source.relations = [];
    source.roomLayout.corners = Array.from({ length: 2 }, () => ({
      corner: 'back-bottom-left',
      point: { x: 0.2, y: 0.8 },
      evidence: ['Visible corner'],
    }));
    expect(
      parse(source).validation?.roomLayoutIssues.some((issue) => issue.code === 'room-corner-duplicate'),
    ).toBe(true);
    expect(parse(source).candidates).toHaveLength(2);
  });
  it('permits user-confirmed additions beyond the model cap without changing model limits or provenance', () => {
    const source = scene();
    source.candidates = Array.from({ length: 24 }, (_, i) => item('item' + i));
    const automatic = parse(source),
      edited = structuredClone(automatic);
    edited.candidates.push({ ...structuredClone(automatic.candidates[0]), id: 'user-added' });
    const result = validateUserUnderstanding(edited, automatic);
    expect(result.candidates).toHaveLength(25);
    expect(result.candidates[24].provenance?.kind).toBe('user');
    expect(automatic.candidates).toHaveLength(24);
    source.candidates.push(item('item25'));
    expect(() => parse(source)).toThrow();
  });
  it('quarantines fabricated contact points and room observations without evidence', () => {
    const source = scene();
    source.candidates[0] = {
      ...item(),
      anchor: { kind: 'wall-attachment', point: { x: 0.9, y: 0.9 }, evidence: ['Bracket'], uncertainty: [] },
    } as unknown as ReturnType<typeof item>;
    expect(parse(source).candidates[0].validation?.issues[0].code).toBe('anchor-outside');
    source.candidates[0] = item();
    source.roomLayout.corners = [{ corner: 'back-bottom-left', point: { x: 0.2, y: 0.8 }, evidence: [] }];
    expect(parse(source).validation?.roomLayoutIssues[0].code).toBe('room-corner-evidence');
    expect(parse(source).candidates[0].validation).toBeUndefined();
  });
  it('retains a reversed item box for correction and never normalizes its coordinates silently', () => {
    const source = scene();
    source.candidates.push(item('healthy'));
    source.candidates[0].bounds = { left: 0.5, top: 0.1, right: 0.4, bottom: 0.9 };
    const result = parse(source);
    expect(result.candidates[0].bounds).toEqual(source.candidates[0].bounds);
    expect(result.candidates[0].validation?.issues[0].code).toBe('bounds-order');
    expect(result.candidates[1].validation).toBeUndefined();
  });
  it('supports two observed countertop bowls linked to one floor-supported vanity', () => {
    const source = scene();
    source.candidates = [
      { ...item('bowl1'), mounting: 'countertop', basinStyle: 'vanity' },
      { ...item('bowl2'), mounting: 'countertop', basinStyle: 'vanity' },
      { ...item('cabinet'), kind: 'vanity', mounting: 'floor', basinStyle: 'unknown' },
    ];
    source.relations = ['bowl1', 'bowl2'].map((id) => ({
      frontId: id,
      behindId: 'cabinet',
      relation: 'partOf',
      evidence: ['Bowl sits in the shared countertop.'],
    }));
    const result = parse(source);
    expect(result.validation).toBeUndefined();
    expect(result.relations).toHaveLength(2);
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.every((item) => item.bowlCount === undefined)).toBe(true);
  });
  it('separates an observed countertop contact from an invalid floor anchor on the bowl', () => {
    const source = scene();
    source.candidates = [
      {
        ...item('bowl'),
        mounting: 'countertop',
        basinStyle: 'vanity',
        anchor: {
          kind: 'countertop-contact',
          point: { x: 0.2, y: 0.6 },
          evidence: ['Bowl rim meets countertop.'],
          uncertainty: [],
        },
      } as unknown as ReturnType<typeof item>,
      { ...item('cabinet'), kind: 'vanity', mounting: 'wall', basinStyle: 'unknown' },
    ];
    source.relations = [
      { frontId: 'bowl', behindId: 'cabinet', relation: 'partOf', evidence: ['Connected countertop.'] },
    ];
    expect(parse(source).validation).toBeUndefined();
    source.candidates[0] = {
      ...source.candidates[0],
      anchor: {
        kind: 'floor-contact',
        point: { x: 0.2, y: 0.6 },
        evidence: ['Floor via countertop.'],
        uncertainty: [],
      },
    } as unknown as ReturnType<typeof item>;
    const result = parse(source);
    expect(result.candidates[0].validation?.issues[0].code).toBe('anchor-mounting');
    expect(result.candidates[1].validation).toBeUndefined();
    expect(result.relations).toHaveLength(1);
  });
  it('quarantines an unsupported countertop bowl while preserving other observations', () => {
    const source = scene();
    source.candidates = [{ ...item(), mounting: 'countertop', basinStyle: 'vanity' }, item('healthy')];
    expect(parse(source).candidates[0].validation?.issues[0].code).toBe('countertop-support-missing');
    expect(parse(source).candidates[1].validation).toBeUndefined();
  });
  it('does not bind a reflected bowl to a physical cabinet or a bowl to multiple cabinets', () => {
    const source = scene();
    source.candidates = [
      { ...item('bowl'), mounting: 'countertop', basinStyle: 'vanity', reflection: 'reflected' },
      { ...item('cabinet'), kind: 'vanity', mounting: 'floor', basinStyle: 'unknown' },
      { ...item('cabinet2'), kind: 'vanity', mounting: 'floor', basinStyle: 'unknown' },
    ];
    source.relations = ['cabinet', 'cabinet2'].map((id) => ({
      frontId: 'bowl',
      behindId: id,
      relation: 'partOf',
      evidence: ['Same countertop.'],
    }));
    const result = parse(source);
    expect(result.relations).toEqual([]);
    expect(result.validation?.quarantinedRelations).toHaveLength(2);
    expect(result.candidates[0].validation?.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['relation-part-reflection', 'relation-part-parent']),
    );
  });
  it('resolves repeated parent aliases after parsing while preserving original relation IDs', () => {
    const source = scene();
    source.candidates = [
      { ...item('bowl'), mounting: 'countertop', basinStyle: 'vanity' },
      { ...item('cabinet'), kind: 'vanity', mounting: 'floor', basinStyle: 'unknown', shape: 'unknown' },
      {
        ...item('alias'),
        kind: 'vanity',
        mounting: 'floor',
        basinStyle: 'unknown',
        shape: 'unknown',
        anchor: {
          kind: 'floor-contact',
          point: { x: 0.2, y: 0.6 },
          evidence: ['Visible cabinet bottom.'],
          uncertainty: [],
        },
      } as unknown as ReturnType<typeof item>,
    ];
    source.relations = ['cabinet', 'alias'].map((id) => ({
      frontId: 'bowl',
      behindId: id,
      relation: 'partOf',
      evidence: ['Same supporting countertop.'],
    }));
    const parsed = parse(source),
      original = structuredClone(parsed);
    expect(parsed.validation).toBeUndefined();
    const { resolution } = resolveSceneCandidates(parsed);
    expect(resolution).toMatchObject({
      rawCount: 3,
      organizedCount: 1,
      duplicateCount: 1,
      componentCount: 1,
    });
    expect(resolution.assemblies).toEqual([
      expect.objectContaining({ parentId: 'alias', componentIds: ['bowl'], bowlCount: 1 }),
    ]);
    expect(parsed).toEqual(original);
    expect(parsed.relations.map((relation) => relation.behindId)).toEqual(['cabinet', 'alias']);
  });
  it.each(['wall', 'position', 'shape', 'count', 'reflection'])(
    'does not merge genuinely incompatible parent aliases: %s',
    (difference) => {
      const source = scene();
      source.candidates = [
        { ...item('bowl'), mounting: 'countertop', basinStyle: 'vanity' },
        { ...item('cabinet'), kind: 'vanity', mounting: 'floor', basinStyle: 'unknown' },
        { ...item('other'), kind: 'vanity', mounting: 'floor', basinStyle: 'unknown' },
        item('healthy'),
      ];
      if (difference === 'wall') source.candidates[2].wall = 'right';
      if (difference === 'position')
        source.candidates[2].bounds = { left: 0.7, right: 0.95, top: 0.3, bottom: 0.6 };
      if (difference === 'shape') source.candidates[2].shape = 'round';
      if (difference === 'reflection') source.candidates[2].reflection = 'reflected';
      const withCounts = {
        ...source,
        candidates: source.candidates.map((candidate, index) => ({
          ...candidate,
          ...(difference === 'count' && (index === 1 || index === 2) ? { bowlCount: index } : {}),
        })),
      };
      withCounts.relations = ['cabinet', 'other'].map((id) => ({
        frontId: 'bowl',
        behindId: id,
        relation: 'partOf',
        evidence: ['Claimed support.'],
      }));
      const parsed = parse(withCounts);
      expect(
        parsed.candidates[0].validation?.issues.some((issue) => issue.code === 'relation-part-parent'),
      ).toBe(true);
      expect(parsed.candidates[3].validation).toBeUndefined();
      expect(resolveSceneCandidates(parsed).resolution.assemblies).toEqual([]);
    },
  );
  it('keeps independently positioned user supports separate even when their photo placeholders overlap', () => {
    const source = scene();
    source.candidates = [
      { ...item('bowl'), mounting: 'countertop', basinStyle: 'vanity' },
      { ...item('cabinet'), kind: 'vanity', mounting: 'floor', basinStyle: 'unknown' },
      { ...item('alias'), kind: 'vanity', mounting: 'floor', basinStyle: 'unknown' },
    ];
    source.relations = ['cabinet', 'alias'].map((id) => ({
      frontId: 'bowl',
      behindId: id,
      relation: 'partOf',
      evidence: ['Same supporting countertop.'],
    }));
    const automatic = parse(source),
      user = structuredClone(automatic);
    user.candidates[1].provenance!.position = 'user';
    user.candidates[2].provenance!.position = 'user';
    const result = validateUserUnderstanding(user, automatic);
    expect(
      result.candidates[0].validation?.issues.some((issue) => issue.code === 'relation-part-parent'),
    ).toBe(true);
    expect(resolveSceneCandidates(result).resolution.assemblies).toEqual([]);
    expect(automatic.validation).toBeUndefined();
  });
  it('does not connect a remote bowl or a bowl on a different known wall to the cabinet', () => {
    const source = scene();
    source.candidates = [
      { ...item('bowl'), mounting: 'countertop', basinStyle: 'vanity' },
      { ...item('cabinet'), kind: 'vanity', mounting: 'floor', basinStyle: 'unknown' },
      item('healthy'),
    ];
    source.relations = [
      { frontId: 'bowl', behindId: 'cabinet', relation: 'partOf', evidence: ['Claimed connection.'] },
    ];
    source.candidates[0].bounds = { left: 0.75, right: 0.95, top: 0.3, bottom: 0.6 };
    let result = parse(source);
    expect(
      result.validation?.quarantinedRelations[0].issues.some(
        (issue) => issue.code === 'relation-part-distance',
      ),
    ).toBe(true);
    expect(result.candidates[2].validation).toBeUndefined();
    source.candidates[0].bounds = item().bounds;
    source.candidates[0].wall = 'right';
    result = parse(source);
    expect(
      result.validation?.quarantinedRelations[0].issues.some((issue) => issue.code === 'relation-part-wall'),
    ).toBe(true);
    expect(result.candidates[2].validation).toBeUndefined();
  });
  it('records explicit bowl counts without changing an old uncounted assembly', () => {
    const old = scene();
    old.candidates[0] = { ...item(), mounting: 'floor', basinStyle: 'vanity' };
    expect(parse(old).candidates[0].bowlCount).toBeUndefined();
    const counted = { ...old, candidates: [{ ...old.candidates[0], bowlCount: 2 }] };
    expect(parse(counted).candidates[0]).toMatchObject({ bowlCount: 2, provenance: { bowlCount: 'model' } });
    expect(
      parse({ ...counted, candidates: [{ ...counted.candidates[0], mounting: 'wall' }] }).validation,
    ).toBeUndefined();
    expect(() => parse({ ...counted, candidates: [{ ...counted.candidates[0], bowlCount: 3 }] })).toThrow();
  });
  it('preserves identical relation history once without duplicating or holding the healthy relation', () => {
    const source = scene();
    source.candidates.push({ ...item('glass'), kind: 'glassPartition', basinStyle: 'unknown' });
    const relation = {
      frontId: 'glass',
      behindId: 'item1',
      relation: 'visibleThrough',
      evidence: ['Frame visible.'],
    };
    source.relations = [relation, { ...relation }];
    const result = parse(source);
    expect(result.relations).toHaveLength(1);
    expect(result.validation?.quarantinedRelations[0].issues[0].code).toBe('relation-repeat');
    expect(result.candidates.every((item) => !item.validation)).toBe(true);
  });
  it('recomputes semantic validation after user correction without modifying the automatic result', () => {
    const source = scene();
    source.candidates[0].mounting = 'floor';
    const automatic = parse(source),
      edited = structuredClone(automatic);
    edited.candidates[0].mounting = 'wall';
    edited.candidates[0].bowlCount = 2;
    const result = validateUserUnderstanding(edited, automatic);
    expect(result.candidates[0].validation).toBeUndefined();
    expect(result.candidates[0].provenance).toMatchObject({ mounting: 'user', bowlCount: 'user' });
    expect(automatic.candidates[0].validation).toBeDefined();
    expect(automatic.candidates[0].bowlCount).toBeUndefined();
  });
  it('keeps explicit user position confirmation even when bounds and anchor did not change', () => {
    const automatic = parse(scene()),
      edited = structuredClone(automatic);
    edited.candidates[0].provenance!.position = 'user';
    const result = validateUserUnderstanding(edited, automatic);
    expect(result.candidates[0].provenance?.position).toBe('user');
    expect(automatic.candidates[0].provenance?.position).toBe('model');
  });
  it('keeps unresolved semantic problems after unrelated user confirmation', () => {
    const source = scene();
    source.candidates[0].mounting = 'floor';
    const automatic = parse(source),
      edited = structuredClone(automatic);
    edited.candidates[0].wall = 'right';
    expect(validateUserUnderstanding(edited, automatic).candidates[0].validation).toBeDefined();
  });
  it('gives a compact once-only inventory prompt without repeating the runtime JSON grammar', () => {
    expect(SCENE_UNDERSTANDING_PROMPT).not.toContain('"properties"');
    expect(SCENE_UNDERSTANDING_PROMPT).toContain('Never repeat');
    expect(SCENE_UNDERSTANDING_PROMPT).toContain('partOf');
    expect(SCENE_UNDERSTANDING_PROMPT.length).toBeLessThan(3500);
  });
  it('does not pass boolean tuple item schemas unsupported by the tested Ollama runtime', () => {
    const serialized = JSON.stringify(sceneUnderstandingJsonSchema);
    expect(serialized).not.toContain('"items":false');
    expect(serialized).not.toContain('"prefixItems"');
  });
});
