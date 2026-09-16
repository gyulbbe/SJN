import { beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { LAB_QWEN_MODEL } from '../src/lib/reconstruction/lab-engine';
import { parseFixtureAppearance } from '../src/lib/reconstruction/fixture-appearance-observation';
import type { SceneCandidate, SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';
import {
  applyReflectionRechecks,
  reflectionRecheckCandidates,
  reflectionRecheckSignature,
  REFLECTION_RECHECK_RULE_REVISION,
  type ReflectionRecheckContext,
} from '../src/lib/reconstruction/reflection-recheck';
import {
  createTargetExistenceReceipt,
  canonicalTargetValue,
  targetExistenceCropTransform,
  targetExistenceSha256,
  validateTargetExistenceAnalysis,
  type TargetExistenceObservation,
} from '../src/lib/reconstruction/target-existence-observation';
const modelRevision = 'a'.repeat(64);
const candidate = (id: string, kind: SceneCandidate['kind']): SceneCandidate => ({
  id,
  kind,
  bounds: { left: 0.2, top: 0.2, right: 0.6, bottom: 0.7 },
  mounting: 'wall',
  wall: 'unknown',
  basinStyle: 'unknown',
  shape: 'rectangular',
  reflection: 'physical',
  evidence: ['original evidence'],
  uncertainty: [],
});
const context = (): ReflectionRecheckContext => {
  const identity: SceneUnderstanding = {
    schemaVersion: 1,
    candidates: [candidate('panel', 'mirror'), candidate('other', 'toilet')],
    relations: [],
    roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: [] },
  };
  const installation = structuredClone(identity);
  const appearance = parseFixtureAppearance(
    JSON.stringify({
      schemaVersion: 1,
      observations: [
        {
          id: 'panel',
          kind: 'mirror',
          context: 'reflected',
          note: 'Visible panel perimeter.',
          sameObjectAs: null,
          shape: 'oval',
          counterSupport: 'unknown',
        },
        {
          id: 'other',
          kind: 'toilet',
          context: 'physical',
          note: 'A visible toilet body.',
          sameObjectAs: null,
          shape: 'unknown',
          counterSupport: 'unknown',
        },
      ],
    }),
    installation,
  );
  return { identity, installation, appearance, protectedCandidateIds: new Set<string>() };
};
const row: TargetExistenceObservation = {
  id: 'panel',
  note: 'Panel border is directly visible.',
  kind: 'mirror',
  targetExistence: 'directly-visible-surface',
  objectScope: 'whole-object',
  showerStyle: 'unknown',
  lowerSupport: 'uncertain',
  sameObjectAs: null,
  partOf: null,
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
};
let photo: Buffer, full: Buffer, crop: Buffer, photoFingerprint: string;
const image = { width: 120, height: 100 };
const rect = targetExistenceCropTransform(image, candidate('panel', 'mirror').bounds);
beforeAll(async () => {
  photo = await sharp({ create: { ...image, channels: 3, background: '#c0d0e0' } })
    .png()
    .toBuffer();
  full = await sharp(photo).jpeg({ quality: 95 }).toBuffer();
  crop = await sharp(photo).extract(rect).jpeg({ quality: 95 }).toBuffer();
  photoFingerprint = await targetExistenceSha256(photo);
});
const expected = () => ({
  photoFingerprint,
  image,
  modelId: LAB_QWEN_MODEL as typeof LAB_QWEN_MODEL,
  modelRevision,
  requests: [],
});
async function prepared(c = context(), changes: Partial<TargetExistenceObservation> = {}) {
  const receipt = await createTargetExistenceReceipt({
    photoBytes: photo,
    normalizedFullBytes: full,
    cropBytes: crop,
    expectedPhotoFingerprint: photoFingerprint,
    targetId: 'panel',
    boxes: c.appearance.understanding.candidates.map(({ id, bounds }) => ({ id, bounds })),
    cropTransform: rect,
    sourceDecisionSignature: reflectionRecheckSignature(c),
    modelId: LAB_QWEN_MODEL as typeof LAB_QWEN_MODEL,
    modelRevision,
  });
  const observation = await validateTargetExistenceAnalysis(
    { receipt, rawText: JSON.stringify({ ...row, ...changes }) },
    receipt,
  );
  return { ...c, expected: { ...expected(), requests: [receipt] }, observations: [observation] };
}
function synchronize(c: ReflectionRecheckContext) {
  for (const d of c.appearance.decisions) {
    d.original = structuredClone(c.installation.candidates.find((x) => x.id === d.candidateId)!);
    d.effective = structuredClone(c.appearance.understanding.candidates.find((x) => x.id === d.candidateId)!);
    d.observation = structuredClone(c.appearance.observations.find((x) => x.id === d.candidateId)!);
  }
}
describe('direct mirror correction (authored boundary tests, not AI accuracy)', () => {
  it('rechecks only a physical mirror turned reflected by appearance', () => {
    expect(reflectionRecheckCandidates(context()).map((e) => [e.candidateId, e.eligible])).toEqual([
      ['panel', true],
      ['other', false],
    ]);
  });
  it('changes exactly reflection while preserving candidates, positions, shapes, relationships and original appearance', async () => {
    const p = await prepared(),
      before = structuredClone(p);
    const result = await applyReflectionRechecks(p);
    const expectedScene = structuredClone(before.appearance.understanding);
    expectedScene.candidates[0].reflection = 'physical';
    expect(result.understanding).toEqual(expectedScene);
    expect(p).toEqual(before);
    expect(result.record.decisions.map((d) => d.status)).toEqual(['applied', 'not-eligible']);
    expect(result.record.observations[0].rawText).toBe(p.observations[0].rawText);
    expect(p.appearance.understanding.candidates[0].reflection).toBe('reflected');
    result.understanding.candidates[0].bounds.left = 0.1;
    result.record.observations[0].observation.note = 'changed return value';
    expect(p).toEqual(before);
  });
  it('holds duplicate claims without copying unrelated aliases, support, shapes or kind', async () => {
    const p = await prepared(context(), {
      sameObjectAs: 'other',
      kind: 'mirror_cabinet',
      lowerSupport: 'separate-component',
    });
    const result = await applyReflectionRechecks(p);
    expect(result.understanding).toEqual(p.appearance.understanding);
    expect(result.record.decisions[0]).toMatchObject({
      status: 'held',
      reasonCodes: ['target-duplicate-or-component'],
    });
    expect(result.record.observations[0].observation.sameObjectAs).toBe('other');
    expect(p.appearance.duplicates).toEqual([]);
    expect(result.understanding.relations).toEqual(p.appearance.understanding.relations);
  });
  it.each([
    { kind: 'toilet' },
    { objectScope: 'component' },
    { objectScope: 'multiple-objects' },
    { targetExistence: 'only-depicted-in-reflection' },
    { targetExistence: 'uncertain' },
  ] as Partial<TargetExistenceObservation>[])(
    'holds a response that does not confirm the whole direct mirror: %j',
    async (changes) => {
      const p = await prepared(context(), changes),
        r = await applyReflectionRechecks(p);
      expect(r.understanding).toEqual(p.appearance.understanding);
      expect(r.record.decisions[0].status).toBe('held');
    },
  );
  it.each(['directly-visible-surface', 'directly-visible-object'] as const)(
    'accepts an explicitly visible whole mirror as %s',
    async (targetExistence) => {
      const p = await prepared(context(), { targetExistence });
      const result = await applyReflectionRechecks(p);
      expect(result.understanding.candidates[0]).toEqual({
        ...p.appearance.understanding.candidates[0],
        reflection: 'physical',
      });
      expect(result.record.ruleRevision).toBe(REFLECTION_RECHECK_RULE_REVISION);
      expect(result.record.decisions[0].status).toBe('applied');
    },
  );
  it.each(['sameObjectAs', 'partOf'] as const)(
    'holds a whole mirror claiming %s another candidate',
    async (relation) => {
      const p = await prepared(context(), {
        [relation]: 'other',
        targetExistence: 'directly-visible-object',
      });
      const result = await applyReflectionRechecks(p);
      expect(result.understanding).toEqual(p.appearance.understanding);
      expect(result.record.decisions[0].status).toBe('held');
      expect(result.record.decisions[0].reasonCodes).toContain('target-duplicate-or-component');
    },
  );
  it.each(['absent', 'uncertain'] as const)(
    'holds a mirror whose reflective panel is %s',
    async (reflectivePanel) => {
      const p = await prepared(context(), { visibleStructure: { ...row.visibleStructure, reflectivePanel } });
      const result = await applyReflectionRechecks(p);
      expect(result.understanding).toEqual(p.appearance.understanding);
      expect(result.record.decisions[0].reasonCodes).toContain('reflective-panel-unconfirmed');
    },
  );
  it.each(['cabinetBody', 'cabinetDoors'] as const)(
    'restores the cabinet subtype only with visible %s',
    async (structure) => {
      const c = context();
      c.identity.candidates[0].kind = 'mirrorCabinet';
      c.installation.candidates[0].kind = 'mirrorCabinet';
      c.appearance.understanding.candidates[0].provenance = {
        kind: 'default',
        shape: 'model',
        wall: 'geometry',
      };
      synchronize(c);
      const p = await prepared(c, {
        kind: 'mirror_cabinet',
        targetExistence: 'directly-visible-object',
        visibleStructure: { ...row.visibleStructure, [structure]: 'present' },
        lowerSupport: 'enclosed-base',
      });
      const preserved = structuredClone(p);
      const result = await applyReflectionRechecks(p);
      const expected = structuredClone(p.appearance.understanding);
      expected.candidates[0].reflection = 'physical';
      expected.candidates[0].kind = 'mirrorCabinet';
      expected.candidates[0].provenance = { ...expected.candidates[0].provenance, kind: 'model' };
      expect(result.understanding).toEqual(expected);
      expect(result.record.decisions[0].reasonCodes).toContain('mirror-cabinet-subtype-restored');
      expect(result.record.observations).toEqual(p.observations);
      expect(p).toEqual(preserved);
      expect(p.appearance.decisions[0].observation.kind).toBe('mirror');
      expect(p.appearance.decisions[0].original.kind).toBe('mirrorCabinet');
    },
  );
  it.each(['absent', 'uncertain'] as const)(
    'holds unsupported mirror cabinet classification when structures are %s',
    async (presence) => {
      const p = await prepared(context(), {
        kind: 'mirror_cabinet',
        visibleStructure: { ...row.visibleStructure, cabinetBody: presence, cabinetDoors: presence },
      });
      const result = await applyReflectionRechecks(p);
      expect(result.understanding).toEqual(p.appearance.understanding);
      expect(result.record.decisions[0].reasonCodes).toContain('mirror-cabinet-structure-unconfirmed');
    },
  );
  it('does not downgrade a previously observed cabinet subtype from a generic direct mirror label', async () => {
    const c = context();
    for (const stage of [c.identity, c.installation, c.appearance.understanding])
      stage.candidates[0].kind = 'mirrorCabinet';
    c.appearance.observations[0].kind = 'mirror_cabinet';
    synchronize(c);
    const p = await prepared(c, { kind: 'mirror', targetExistence: 'directly-visible-object' });
    const result = await applyReflectionRechecks(p);
    expect(result.understanding.candidates[0]).toEqual({
      ...p.appearance.understanding.candidates[0],
      reflection: 'physical',
    });
    expect(result.record.decisions[0].reasonCodes).not.toContain('mirror-cabinet-subtype-restored');
  });
  it('rejects a valid old-rule receipt instead of reusing it with new application semantics', async () => {
    const p = await prepared();
    const oldSignature = canonicalTargetValue({
      ruleRevision: 'reflection-one-field-v1',
      identity: p.identity,
      installation: p.installation,
      appearance: p.appearance,
      protectedCandidateIds: [...p.protectedCandidateIds].sort(),
    });
    expect(reflectionRecheckSignature(p)).not.toBe(oldSignature);
    expect(JSON.parse(reflectionRecheckSignature(p)).ruleRevision).toBe(REFLECTION_RECHECK_RULE_REVISION);
    p.expected.requests[0].sourceDecisionSignature = oldSignature;
    p.observations[0].receipt.sourceDecisionSignature = oldSignature;
    const saved = structuredClone(p);
    await expect(applyReflectionRechecks(p)).rejects.toThrow('일치');
    expect(p).toEqual(saved);
  });
  it('preserves missing responses without inventing an observation', async () => {
    const c = context(),
      r = await applyReflectionRechecks({ ...c, expected: expected(), observations: [] });
    expect(r.understanding).toEqual(c.appearance.understanding);
    expect(r.record.decisions[0].status).toBe('missing');
    expect(r.record.observations).toEqual([]);
  });
  const guards: [string, (c: ReflectionRecheckContext) => void, string][] = [
    [
      'prior reflected',
      (c) => {
        c.identity.candidates[0].reflection = 'reflected';
      },
      'identity-not-physical-mirror',
    ],
    [
      'prior nonmirror',
      (c) => {
        c.identity.candidates[0].kind = 'wallShelf';
      },
      'identity-not-physical-mirror',
    ],
    [
      'installation uncertain',
      (c) => {
        c.installation.candidates[0].reflection = 'uncertain';
      },
      'installation-not-physical-mirror',
    ],
    [
      'appearance already physical',
      (c) => {
        c.appearance.understanding.candidates[0].reflection = 'physical';
      },
      'no-appearance-reflection-conflict',
    ],
    [
      'protected user edit',
      (c) => {
        c.protectedCandidateIds = new Set(['panel']);
      },
      'user-controlled',
    ],
    [
      'user provenance',
      (c) => {
        c.identity.candidates[0].provenance = { kind: 'user' };
      },
      'user-controlled',
    ],
    [
      'existing validation',
      (c) => {
        c.identity.candidates[0].validation = {
          status: 'needs-review',
          issues: [{ code: 'unknown', message: 'Needs review' }],
        };
      },
      'existing-validation',
    ],
    [
      'held appearance',
      (c) => {
        c.appearance.decisions[0].status = 'held';
      },
      'appearance-held',
    ],
    [
      'changed target',
      (c) => {
        c.identity.candidates[0].bounds.left = 0.1;
      },
      'bounds-mismatch',
    ],
    [
      'explicit reflected object',
      (c) => {
        c.identity.relations = [
          { frontId: 'panel', behindId: 'other', relation: 'reflectionOf', evidence: [] },
        ];
      },
      'explicit-reflection-relation',
    ],
    [
      'reflector relation endpoint',
      (c) => {
        c.identity.relations = [
          { frontId: 'other', behindId: 'panel', relation: 'reflectionOf', evidence: [] },
        ];
      },
      'explicit-reflection-relation',
    ],
    [
      'quarantined reflection',
      (c) => {
        c.identity.validation = {
          rawCandidateCount: 2,
          roomLayoutIssues: [],
          quarantinedRelations: [
            {
              relation: { frontId: 'panel', behindId: 'other', relation: 'reflectionOf', evidence: [] },
              issues: [],
            },
          ],
        };
      },
      'explicit-reflection-relation',
    ],
  ];
  it.each(guards)('does not override %s', (_label, edit, code) => {
    const c = context();
    edit(c);
    synchronize(c);
    const decision = reflectionRecheckCandidates(c)[0];
    expect(decision.eligible).toBe(false);
    expect(decision.reasonCodes).toContain(code);
  });
  it('rejects altered parsed stages and missing or repeated IDs', () => {
    for (const edit of [
      (c: ReflectionRecheckContext) => {
        c.identity.candidates.pop();
      },
      (c: ReflectionRecheckContext) => {
        c.appearance.decisions[0].effective = { ...c.appearance.decisions[0].effective, kind: 'toilet' };
      },
      (c: ReflectionRecheckContext) => {
        c.appearance.observations[0] = { ...c.appearance.observations[0], context: 'physical' };
      },
      (c: ReflectionRecheckContext) => {
        c.appearance.decisions.push(c.appearance.decisions[0]);
      },
    ]) {
      const c = context();
      edit(c);
      expect(() => reflectionRecheckCandidates(c)).toThrow();
    }
  });
  it('requires an independent matching photo/model/current-stage receipt', async () => {
    for (const key of ['photoFingerprint', 'modelRevision'] as const) {
      const p = await prepared();
      p.expected[key] = 'b'.repeat(64);
      await expect(applyReflectionRechecks(p)).rejects.toThrow();
    }
    const p = await prepared();
    p.identity.roomLayout.uncertainty.push('changed stage after inference');
    await expect(applyReflectionRechecks(p)).rejects.toThrow('일치');
  });
  it('rejects duplicate, unrequested and now-ineligible responses', async () => {
    const a = await prepared();
    a.observations.push(a.observations[0]);
    await expect(applyReflectionRechecks(a)).rejects.toThrow();
    const b = await prepared();
    b.expected.requests = [];
    await expect(applyReflectionRechecks(b)).rejects.toThrow();
    const c = await prepared();
    c.expected.requests.push(c.expected.requests[0]);
    await expect(applyReflectionRechecks(c)).rejects.toThrow();
    const d = await prepared();
    d.protectedCandidateIds = new Set(['panel']);
    await expect(applyReflectionRechecks(d)).rejects.toThrow();
  });
  it('binds pending validation to a snapshot of input context', async () => {
    const p = await prepared(),
      before = structuredClone(p);
    const pending = applyReflectionRechecks(p);
    p.identity.candidates[0].kind = 'toilet';
    p.appearance.understanding.candidates[0].bounds.left = 0;
    const result = await pending;
    expect(result.understanding.candidates[0].kind).toBe('mirror');
    expect(result.understanding.candidates[0].bounds).toEqual(
      before.appearance.understanding.candidates[0].bounds,
    );
  });
});
