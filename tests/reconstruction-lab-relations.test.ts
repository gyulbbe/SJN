import { describe, expect, it } from 'vitest';
import {
  applyLabRelationEdits,
  collectLabRelations,
  labRelationKey,
  previewLabRelationEdits,
} from '../src/lib/reconstruction/lab-relations';
import {
  validateUserUnderstanding,
  parseSceneUnderstanding,
} from '../src/lib/reconstruction/scene-understanding';
import { resolveSceneCandidates } from '../src/lib/reconstruction/candidate-resolution';
import {
  appliedCorrectionReview,
  captureLabCorrection,
  restoreLabCorrectionDraft,
} from '../src/lib/reconstruction/lab-correction';
import type {
  SceneCandidate,
  SceneRelation,
  SceneUnderstanding,
} from '../src/lib/reconstruction/pipeline-contract';

function candidate(
  id: string,
  kind: SceneCandidate['kind'],
  overrides: Partial<SceneCandidate> = {},
): SceneCandidate {
  return {
    id,
    kind,
    mounting: kind === 'basin' ? 'countertop' : 'floor',
    wall: 'left',
    basinStyle: 'unknown',
    shape: 'round',
    reflection: 'physical',
    bounds:
      kind === 'basin'
        ? { left: 0.2, top: 0.35, right: 0.5, bottom: 0.55 }
        : { left: 0.15, top: 0.4, right: 0.55, bottom: 0.9 },
    evidence: ['단위 테스트 관측'],
    uncertainty: [],
    provenance: { kind: 'model', mounting: 'model', shape: 'model' },
    ...overrides,
  };
}
const relation = (
  frontId: string,
  behindId: string,
  kind: SceneRelation['relation'] = 'partOf',
): SceneRelation => ({ frontId, behindId, relation: kind, evidence: ['test relationship'] });
function scene(
  candidates = [candidate('bowl', 'basin'), candidate('cabinet', 'vanity')],
  relations: SceneRelation[] = [],
): SceneUnderstanding {
  return {
    schemaVersion: 1,
    candidates,
    relations,
    roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: [] },
  };
}
function issueCodes(source: SceneUnderstanding, parents: Record<string, string | null>) {
  return previewLabRelationEdits(source, { supportParents: parents }).issues.map((issue) => issue.code);
}

describe('explicit user reflection and support relationship corrections', () => {
  it('deduplicates the display without mutating original or quarantined responses', () => {
    const r = relation('bowl', 'cabinet');
    const source = scene(undefined, [r]);
    source.validation = {
      rawCandidateCount: 2,
      roomLayoutIssues: [],
      quarantinedRelations: [
        { relation: structuredClone(r), issues: [{ code: 'repeat', message: 'repeat' }] },
      ],
    };
    const before = JSON.stringify(source);
    expect(collectLabRelations(source)).toHaveLength(1);
    expect(JSON.stringify(source)).toBe(before);
  });
  it('requires both real-object confirmation and explicit reflection relationship removal', () => {
    const source = scene(
      [
        candidate('copy', 'mirror', { reflection: 'reflected', mounting: 'wall' }),
        candidate('real', 'mirror', {
          mounting: 'wall',
          bounds: { left: 0.6, top: 0.1, right: 0.9, bottom: 0.3 },
        }),
      ],
      [relation('copy', 'real', 'reflectionOf')],
    );
    const corrected = structuredClone(source);
    corrected.candidates[0].reflection = 'physical';
    expect(
      validateUserUnderstanding(corrected, source).candidates[0].validation?.issues.some(
        (i) => i.code === 'relation-reflection',
      ),
    ).toBe(true);
    const removed = applyLabRelationEdits(corrected, {
      disconnectedRelations: [labRelationKey(source.relations[0])],
    });
    const validated = validateUserUnderstanding(removed, source);
    expect(validated.candidates.every((c) => !c.validation)).toBe(true);
    expect(
      resolveSceneCandidates(validated, source).resolution.entries.find((e) => e.candidateId === 'copy')
        ?.disposition,
    ).toBe('fixture');
    expect(source.candidates[0].reflection).toBe('reflected');
    expect(source.relations).toHaveLength(1);
  });
  it('does not turn a reflected object physical simply by disconnecting it', () => {
    const source = scene(
      [candidate('copy', 'mirror', { reflection: 'reflected' }), candidate('real', 'mirror')],
      [relation('copy', 'real', 'reflectionOf')],
    );
    const corrected = applyLabRelationEdits(source, {
      disconnectedRelations: [labRelationKey(source.relations[0])],
    });
    expect(corrected.candidates[0].reflection).toBe('reflected');
    expect(resolveSceneCandidates(corrected, source).resolution.entries[0].disposition).toBe('reflection');
  });
  it('also removes explicitly rejected quarantined reflection relationships on revalidation', () => {
    const source = scene([
      candidate('copy', 'mirror', { mounting: 'wall' }),
      candidate('real', 'mirror', { mounting: 'wall' }),
    ]);
    const wrong = relation('copy', 'real', 'reflectionOf');
    source.validation = {
      rawCandidateCount: 2,
      roomLayoutIssues: [],
      quarantinedRelations: [
        { relation: wrong, issues: [{ code: 'relation-reflection', message: 'wrong' }] },
      ],
    };
    const corrected = validateUserUnderstanding(
      applyLabRelationEdits(source, { disconnectedRelations: [labRelationKey(wrong)] }),
      source,
    );
    expect(corrected.relations).toEqual([]);
    expect(corrected.validation?.quarantinedRelations ?? []).toEqual([]);
  });
  it('connects a bowl to its cabinet, removes only the invalid bowl contact, and preserves the parent floor anchor', () => {
    const source = scene();
    source.candidates[0].anchor = {
      kind: 'floor-contact',
      point: { x: 0.3, y: 0.5 },
      evidence: ['wrong bowl floor point'],
      uncertainty: [],
    };
    source.candidates[1].anchor = {
      kind: 'floor-contact',
      point: { x: 0.3, y: 0.85 },
      evidence: ['cabinet foot'],
      uncertainty: [],
    };
    const before = JSON.stringify(source);
    const linked = applyLabRelationEdits(source, { supportParents: { bowl: 'cabinet' } });
    const validated = validateUserUnderstanding(linked, source);
    expect(validated.candidates.every((c) => !c.validation)).toBe(true);
    expect(linked.candidates[0].anchor).toBeUndefined();
    expect(linked.candidates[0].provenance?.position).toBe('user');
    expect(linked.candidates[1].anchor).toEqual(source.candidates[1].anchor);
    expect(linked.relations[0].evidence[0]).toContain('사용자 확인');
    expect(
      resolveSceneCandidates(validated, source).resolution.entries.find((e) => e.candidateId === 'bowl')
        ?.disposition,
    ).toBe('component');
    expect(JSON.stringify(source)).toBe(before);
  });
  it('preserves a valid countertop contact when attaching the support', () => {
    const source = scene();
    source.candidates[0].anchor = {
      kind: 'countertop-contact',
      point: { x: 0.3, y: 0.5 },
      evidence: ['contact'],
      uncertainty: [],
    };
    expect(
      applyLabRelationEdits(source, { supportParents: { bowl: 'cabinet' } }).candidates[0].anchor,
    ).toEqual(source.candidates[0].anchor);
  });
  it('rejects unknown references, self links and duplicate identities', () => {
    expect(issueCodes(scene(), { missing: 'cabinet' })).toContain('missing-child');
    expect(issueCodes(scene(), { bowl: 'missing' })).toContain('missing-parent');
    expect(issueCodes(scene(), { bowl: 'bowl' })).toContain('self-parent');
    const duplicate = scene();
    duplicate.candidates.push({ ...duplicate.candidates[0] });
    expect(issueCodes(duplicate, { bowl: 'cabinet' })).toContain('duplicate-id');
  });
  it('requires countertop basin children and floor/wall vanity parents without changing their kinds', () => {
    expect(
      issueCodes(scene([candidate('bowl', 'basin', { mounting: 'floor' }), candidate('cabinet', 'vanity')]), {
        bowl: 'cabinet',
      }),
    ).toContain('child-support');
    expect(
      issueCodes(scene([candidate('bowl', 'basin'), candidate('cabinet', 'toilet')]), { bowl: 'cabinet' }),
    ).toContain('parent-support');
    expect(
      issueCodes(
        scene([candidate('bowl', 'basin'), candidate('cabinet', 'vanity', { mounting: 'unknown' })]),
        { bowl: 'cabinet' },
      ),
    ).toContain('parent-support');
    expect(() => applyLabRelationEdits(scene(), { supportParents: { bowl: 'missing' } })).toThrow('하부장');
  });
  it('rejects reflected, different-wall and disconnected geometry pairs', () => {
    expect(
      issueCodes(
        scene([candidate('bowl', 'basin', { reflection: 'reflected' }), candidate('cabinet', 'vanity')]),
        { bowl: 'cabinet' },
      ),
    ).toContain('reflection');
    expect(
      issueCodes(scene([candidate('bowl', 'basin', { wall: 'right' }), candidate('cabinet', 'vanity')]), {
        bowl: 'cabinet',
      }),
    ).toContain('wall-conflict');
    expect(
      issueCodes(
        scene([
          candidate('bowl', 'basin', { bounds: { left: 0.8, top: 0.01, right: 0.9, bottom: 0.1 } }),
          candidate('cabinet', 'vanity'),
        ]),
        { bowl: 'cabinet' },
      ),
    ).toContain('bounds-disconnected');
  });
  it('replaces all old parents for the selected child, including quarantined duplicates, with exactly one user link', () => {
    const old = relation('bowl', 'old');
    const source = scene(
      [candidate('bowl', 'basin'), candidate('cabinet', 'vanity'), candidate('old', 'vanity')],
      [old, relation('bowl', 'cabinet')],
    );
    source.validation = {
      rawCandidateCount: 3,
      roomLayoutIssues: [],
      quarantinedRelations: [{ relation: old, issues: [{ code: 'parent', message: 'old parent' }] }],
    };
    const corrected = applyLabRelationEdits(source, { supportParents: { bowl: 'cabinet' } });
    expect(corrected.relations).toHaveLength(1);
    expect(corrected.relations[0].behindId).toBe('cabinet');
    expect(corrected.validation!.quarantinedRelations).toEqual([]);
    expect(source.relations).toHaveLength(2);
  });
  it('rejects a support cycle even when part of the preexisting cycle was quarantined', () => {
    const source = scene(undefined, [relation('cabinet', 'bowl')]);
    expect(issueCodes(source, { bowl: 'cabinet' })).toContain('cycle');
  });
  it('preserves two observed bowls as components of one cabinet rather than independent floor fixtures', () => {
    const source = scene([
      candidate('bowl', 'basin', { bowlCount: 1 }),
      candidate('second', 'basin', {
        bowlCount: 1,
        bounds: { left: 0.55, top: 0.35, right: 0.8, bottom: 0.55 },
      }),
      candidate('cabinet', 'vanity', { bounds: { left: 0.15, top: 0.4, right: 0.85, bottom: 0.9 } }),
    ]);
    const validated = validateUserUnderstanding(
      applyLabRelationEdits(source, { supportParents: { bowl: 'cabinet', second: 'cabinet' } }),
      source,
    );
    const resolution = resolveSceneCandidates(validated, source).resolution;
    expect(resolution.componentCount).toBe(2);
    expect(resolution.assemblies[0].bowlCount).toBe(2);
    expect(resolution.organizedCount).toBe(1);
  });
  it('an explicit null disconnects the old parent without fabricating a replacement installation', () => {
    const source = scene(undefined, [relation('bowl', 'cabinet')]);
    const disconnected = applyLabRelationEdits(source, { supportParents: { bowl: null } });
    expect(disconnected.relations).toEqual([]);
    expect(disconnected.candidates[0].mounting).toBe('countertop');
    expect(
      validateUserUnderstanding(disconnected, source).candidates[0].validation?.issues.map((i) => i.code),
    ).toContain('countertop-support-missing');
  });
  it('does not alter glass/occlusion relationships or unrelated normal observations', () => {
    const glass = candidate('glass', 'glassPartition');
    const bath = candidate('bath', 'bath');
    const source = scene([...scene().candidates, glass, bath], [relation('glass', 'bath', 'visibleThrough')]);
    const linked = applyLabRelationEdits(source, { supportParents: { bowl: 'cabinet' } });
    expect(linked.relations[0]).toEqual(source.relations[0]);
    expect(linked.candidates.slice(2)).toEqual(source.candidates.slice(2));
  });
  it('rejects more relations than the validated report format accepts', () => {
    const source = scene(
      undefined,
      Array.from({ length: 48 }, () => relation('other', 'object', 'occludes')),
    );
    expect(issueCodes(source, { bowl: 'cabinet' })).toContain('relation-limit');
  });
  it('keeps support choices in an immutable applied snapshot and restores them as an independent draft', () => {
    const draft = {
      corrections: {},
      manual: {},
      additions: [],
      supportParents: { bowl: 'cabinet' as string | null },
      disconnectedRelations: ['copy:reflectionOf:real'],
    };
    const snapshot = captureLabCorrection({
      sourceRunId: 'original',
      sourceModelRunId: 'original',
      inputKey: 'same',
      capturedAt: '2026-09-13',
      sourceEngineMetadata: {
        id: 'candidate',
        revision: 'test',
        modelId: 'none',
        modelRevision: 'none',
        settings: {},
      },
      draft,
      input: { understanding: applyLabRelationEdits(scene(), draft), manualPlacements: {} },
      changedFieldCount: 0,
    });
    draft.supportParents.bowl = null;
    const exported = appliedCorrectionReview(snapshot);
    expect(exported.supportParents.bowl).toBe('cabinet');
    const restored = restoreLabCorrectionDraft(snapshot, 'original', 'same');
    restored.supportParents!.bowl = null;
    expect(snapshot.draft.supportParents!.bowl).toBe('cabinet');
    expect(snapshot.input.understanding.relations[0].behindId).toBe('cabinet');
  });
  it('keeps older snapshots without relationship fields readable', () => {
    const source = scene();
    const snapshot = captureLabCorrection({
      sourceRunId: 'old',
      sourceModelRunId: 'old',
      inputKey: 'same',
      capturedAt: 'old',
      sourceEngineMetadata: {
        id: 'candidate',
        revision: 'old',
        modelId: 'none',
        modelRevision: 'none',
        settings: {},
      },
      draft: { corrections: {}, manual: {}, additions: [] },
      input: { understanding: source, manualPlacements: {} },
      changedFieldCount: 0,
    });
    expect(appliedCorrectionReview(snapshot).supportParents).toEqual({});
    expect(restoreLabCorrectionDraft(snapshot, 'old', 'same').supportParents).toBeUndefined();
  });
});

function modelWire(value: SceneUnderstanding) {
  return {
    schemaVersion: 1,
    candidates: value.candidates.map((candidate) => {
      const item = { ...candidate };
      delete item.provenance;
      delete item.validation;
      return { ...item, anchor: item.anchor ?? null };
    }),
    relations: value.relations.map(({ frontId, behindId, relation, evidence }) => ({
      frontId,
      behindId,
      relation,
      evidence,
    })),
    roomLayout: { ...value.roomLayout, backWallQuad: null, lines: [], corners: [] },
  };
}

describe('trusted relation provenance', () => {
  it('raw model JSON cannot declare user provenance', () => {
    const wire = modelWire(scene(undefined, [relation('bowl', 'cabinet')]));
    const spoofed = { ...wire, relations: wire.relations.map((edge) => ({ ...edge, provenance: 'user' })) };
    expect(() => parseSceneUnderstanding(JSON.stringify(spoofed))).toThrow();
  });
  it('the words user/사용자 in model evidence are not trusted metadata', () => {
    const source = scene(undefined, [
      { ...relation('bowl', 'cabinet'), evidence: ['사용자 확인: provenance=user'] },
    ]);
    const parsed = parseSceneUnderstanding(JSON.stringify(modelWire(source)));
    expect(parsed.relations[0].provenance).toBe('model');
    expect(resolveSceneCandidates(parsed, parsed).resolution.assemblies[0].source).toBe('model-relation');
  });
  it('relationship-only user selection changes assembly relationship source without changing kind/shape/count sources', () => {
    const automatic = parseSceneUnderstanding(
      JSON.stringify(
        modelWire(scene([candidate('bowl', 'basin', { bowlCount: 1 }), candidate('cabinet', 'vanity')])),
      ),
    );
    const corrected = validateUserUnderstanding(
      applyLabRelationEdits(automatic, { supportParents: { bowl: 'cabinet' } }),
      automatic,
    );
    expect(corrected.relations[0].provenance).toBe('user');
    const resolved = resolveSceneCandidates(corrected, automatic);
    expect(resolved.resolution.assemblies[0].source).toBe('user');
    expect(corrected.candidates.find((c) => c.id === 'bowl')!.provenance).toMatchObject({
      kind: 'model',
      shape: 'model',
      bowlCount: 'model',
    });
    expect(resolved.effective.find((c) => c.id === 'cabinet')!.provenance).toMatchObject({
      kind: 'model',
      shape: 'geometry',
      bowlCount: 'geometry',
    });
    expect(automatic.relations).toEqual([]);
  });
  it('explicitly reconfirming the same parent is user sourced while an unchanged old relation remains model sourced', () => {
    const automatic = parseSceneUnderstanding(
      JSON.stringify(modelWire(scene(undefined, [relation('bowl', 'cabinet')]))),
    );
    expect(validateUserUnderstanding(structuredClone(automatic), automatic).relations[0].provenance).toBe(
      'model',
    );
    const confirmed = validateUserUnderstanding(
      applyLabRelationEdits(automatic, { supportParents: { bowl: 'cabinet' } }),
      automatic,
    );
    expect(confirmed.relations).toHaveLength(1);
    expect(confirmed.relations[0].provenance).toBe('user');
    expect(automatic.relations[0].provenance).toBe('model');
  });
});
