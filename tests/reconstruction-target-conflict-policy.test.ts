import { beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { CLOUD_GEMMA_MODEL, CLOUD_GEMMA_REVISION } from '../src/lib/reconstruction/cloud-gemma-contract';
import {
  parseFixtureAppearance,
  type FixtureAppearanceObservation,
} from '../src/lib/reconstruction/fixture-appearance-observation';
import type { SceneCandidate, SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';
import {
  applyReflectionRechecks,
  reflectionRecheckCandidates,
  reflectionRecheckSignature,
  type ReflectionRecheckContext,
} from '../src/lib/reconstruction/reflection-recheck';
import {
  canonicalTargetValue,
  createTargetExistenceReceipt,
  targetExistenceCropTransform,
  targetExistenceSha256,
  validateTargetExistenceAnalysis,
  type TargetExistenceObservation,
} from '../src/lib/reconstruction/target-existence-observation';
import { validateInstallationInventory } from '../src/lib/reconstruction/installation-observation';
import { resolveSceneCandidates } from '../src/lib/reconstruction/candidate-resolution';
const image = { width: 240, height: 180 };
let photo: Buffer, full: Buffer, fingerprint: string;
beforeAll(async () => {
  photo = await sharp({ create: { ...image, channels: 3, background: '#bbccdd' } })
    .png()
    .toBuffer();
  full = await sharp(photo).jpeg({ quality: 95 }).toBuffer();
  fingerprint = await targetExistenceSha256(photo);
});
const candidate = (
  id: string,
  kind: SceneCandidate['kind'],
  bounds = { left: 0.2, top: 0.2, right: 0.6, bottom: 0.7 },
): SceneCandidate => ({
  id,
  kind,
  bounds,
  mounting: 'wall',
  wall: 'unknown',
  shape: 'unknown',
  basinStyle: 'unknown',
  reflection: 'physical',
  evidence: ['Authored prior'],
  uncertainty: [],
});
function context(
  items: SceneCandidate[],
  kinds: FixtureAppearanceObservation['kind'][],
  contexts: FixtureAppearanceObservation['context'][] = items.map(() => 'reflected'),
): ReflectionRecheckContext {
  const identity: SceneUnderstanding = {
    schemaVersion: 1,
    candidates: items,
    relations: [],
    roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: [] },
  };
  const installation = structuredClone(identity);
  const appearance = parseFixtureAppearance(
    JSON.stringify({
      schemaVersion: 1,
      observations: items.map((c, i) => ({
        id: c.id,
        kind: kinds[i],
        context: contexts[i],
        note: 'Authored appearance conflict for a visible target.',
        sameObjectAs: null,
        shape: 'unknown',
        counterSupport: 'unknown',
        pedestalShape: 'unknown',
      })),
    }),
    installation,
  );
  return { identity, installation, appearance, protectedCandidateIds: new Set() };
}
const row = (
  id: string,
  kind: TargetExistenceObservation['kind'],
  changes: Partial<TargetExistenceObservation> = {},
): TargetExistenceObservation => ({
  id,
  kind,
  note: 'Authored direct target structural observation.',
  targetExistence: 'directly-visible-object',
  objectScope: 'whole-object',
  sameObjectAs: null,
  partOf: null,
  lowerSupport: 'uncertain',
  showerStyle: 'unknown',
  visibleStructure: {
    cabinetBody: 'uncertain',
    cabinetDoors: 'uncertain',
    basinBowl: 'uncertain',
    pedestalToFloor: 'uncertain',
    toiletBowl: 'uncertain',
    toiletTank: 'uncertain',
    transparentPanel: 'uncertain',
    reflectivePanel: 'uncertain',
  },
  ...changes,
});
const mirrorRow = (id: string, peer: string | null, strong = true) => {
  const r = row(id, 'mirror_cabinet', { sameObjectAs: peer });
  r.visibleStructure.reflectivePanel = 'present';
  if (strong) r.visibleStructure.cabinetBody = 'present';
  return r;
};
async function prepared(c: ReflectionRecheckContext, rows: TargetExistenceObservation[]) {
  const boxes = c.appearance.understanding.candidates.map(({ id, bounds }) => ({ id, bounds }));
  const observations = await Promise.all(
    rows.map(async (o) => {
      const transform = targetExistenceCropTransform(image, boxes.find((b) => b.id === o.id)!.bounds);
      const crop = await sharp(photo).extract(transform).jpeg({ quality: 95 }).toBuffer();
      const receipt = await createTargetExistenceReceipt({
        photoBytes: photo,
        normalizedFullBytes: full,
        cropBytes: crop,
        expectedPhotoFingerprint: fingerprint,
        targetId: o.id,
        boxes,
        cropTransform: transform,
        sourceDecisionSignature: reflectionRecheckSignature(c),
        modelId: CLOUD_GEMMA_MODEL,
        modelRevision: CLOUD_GEMMA_REVISION,
      });
      return validateTargetExistenceAnalysis({ receipt, rawText: JSON.stringify(o) }, receipt);
    }),
  );
  return {
    ...c,
    expected: {
      photoFingerprint: fingerprint,
      image,
      modelId: CLOUD_GEMMA_MODEL,
      modelRevision: CLOUD_GEMMA_REVISION,
      requests: observations.map((o) => o.receipt),
    },
    observations,
  };
}
const pairContext = () =>
  context(
    [
      candidate('panel', 'mirror', { left: 0.3, top: 0.2, right: 0.5, bottom: 0.7 }),
      candidate('cabinet', 'mirrorCabinet', { left: 0.3, top: 0.2, right: 0.7, bottom: 0.7 }),
    ],
    ['window', 'window'],
    ['physical', 'physical'],
  );

describe('typed whole-target conflict corrections and conservative same-object pairs', () => {
  it('restores a transparent panel and the separate shower behind it without merging overlapping boxes', async () => {
    const c = context(
      [candidate('glass', 'glassPartition'), candidate('shower', 'shower')],
      ['shower', 'shower'],
    );
    const glass = row('glass', 'glass_partition', { targetExistence: 'directly-visible-surface' });
    glass.visibleStructure.transparentPanel = 'present';
    const p = await prepared(c, [glass, row('shower', 'shower', { showerStyle: 'overhead-set' })]),
      before = structuredClone(p);
    const result = await applyReflectionRechecks(p);
    expect(result.understanding.candidates.map((x) => [x.id, x.kind, x.reflection])).toEqual([
      ['glass', 'glassPartition', 'physical'],
      ['shower', 'shower', 'physical'],
    ]);
    expect(result.record.decisions.every((x) => x.status === 'applied' && !x.canonicalId)).toBe(true);
    expect(result.understanding.candidates[0].provenance?.kind).toBe('model');
    expect(result.understanding.candidates.map((x) => x.bounds)).toEqual(
      c.appearance.understanding.candidates.map((x) => x.bounds),
    );
    expect(result.understanding.relations).toEqual(c.appearance.understanding.relations);
    expect(p).toEqual(before);
  });
  it.each(['uncertain', 'absent'] as const)(
    'does not restore glass with %s panel evidence',
    async (presence) => {
      const c = context([candidate('glass', 'glassPartition')], ['shower']);
      const o = row('glass', 'glass_partition');
      o.visibleStructure.transparentPanel = presence;
      const result = await applyReflectionRechecks(await prepared(c, [o]));
      expect(result.understanding).toEqual(c.appearance.understanding);
      expect(result.record.decisions[0].reasonCodes).toContain('transparent-panel-unconfirmed');
    },
  );
  it.each([
    { showerStyle: 'unknown' },
    { objectScope: 'component' },
    { objectScope: 'multiple-objects' },
    { targetExistence: 'mixed-targets' },
    { targetExistence: 'only-depicted-in-reflection' },
    { kind: 'toilet' },
  ] as Partial<TargetExistenceObservation>[])(
    'holds an unsupported target without restoring the prior kind: %j',
    async (changes) => {
      const c = context([candidate('shower', 'shower')], ['mirror']);
      const result = await applyReflectionRechecks(
        await prepared(c, [row('shower', 'shower', { showerStyle: 'overhead-set', ...changes })]),
      );
      expect(result.understanding).toEqual(c.appearance.understanding);
      expect(result.record.decisions[0].status).toBe('held');
    },
  );
  it('restores one structurally supported cabinet and marks its mutually confirmed contained alias for review', async () => {
    const c = pairContext(),
      p = await prepared(c, [mirrorRow('panel', 'cabinet', false), mirrorRow('cabinet', 'panel')]),
      before = structuredClone(p);
    const result = await applyReflectionRechecks(p);
    expect(result.record.decisions).toMatchObject([
      {
        candidateId: 'panel',
        status: 'held',
        canonicalId: 'cabinet',
        priorKind: 'mirror',
        originalKind: 'window',
      },
      { candidateId: 'cabinet', status: 'applied', canonicalId: 'cabinet', effectiveKind: 'mirrorCabinet' },
    ]);
    expect(result.understanding.candidates[0]).toEqual({
      ...c.appearance.understanding.candidates[0],
      validation: {
        status: 'needs-review',
        issues: [{ code: 'target-same-object-duplicate', message: expect.stringContaining('cabinet') }],
      },
    });
    expect(result.understanding.candidates[1]).toMatchObject({
      kind: 'mirrorCabinet',
      reflection: 'physical',
      provenance: { kind: 'model' },
    });
    expect(validateInstallationInventory(JSON.parse(JSON.stringify(result.understanding)))).toEqual(
      result.understanding,
    );
    expect(resolveSceneCandidates(result.understanding).resolution.entries.map((x) => x.disposition)).toEqual(
      ['invalid', 'fixture'],
    );
    expect(result.record.observations.map((x) => x.observation.sameObjectAs)).toEqual(['cabinet', 'panel']);
    expect(p).toEqual(before);
  });
  it.each(['one-way', 'partial-overlap', 'part-of', 'uncertain-scope', 'different-family'] as const)(
    'does not treat %s as a proven same-object pair',
    async (variant) => {
      const c = pairContext(),
        a = mirrorRow('panel', 'cabinet', false),
        b = mirrorRow('cabinet', 'panel');
      if (variant === 'one-way') b.sameObjectAs = null;
      if (variant === 'part-of') {
        a.partOf = 'cabinet';
        a.sameObjectAs = null;
      }
      if (variant === 'uncertain-scope') a.objectScope = 'uncertain';
      if (variant === 'different-family') {
        b.kind = 'glass_partition';
        b.visibleStructure.transparentPanel = 'present';
      }
      if (variant === 'partial-overlap') {
        for (const scene of [c.identity, c.installation, c.appearance.understanding])
          scene.candidates[1].bounds = { left: 0.4, top: 0.2, right: 0.7, bottom: 0.7 };
        c.appearance.decisions[1].original = structuredClone(c.installation.candidates[1]);
        c.appearance.decisions[1].effective = structuredClone(c.appearance.understanding.candidates[1]);
      }
      const result = await applyReflectionRechecks(await prepared(c, [a, b]));
      expect(result.record.decisions.every((x) => !x.canonicalId)).toBe(true);
      expect(result.understanding.candidates[0]).toEqual(c.appearance.understanding.candidates[0]);
    },
  );
  it('does not collapse a glass panel and a shower even if both observations wrongly claim mutual sameness', async () => {
    const c = context(
      [candidate('glass', 'glassPartition'), candidate('shower', 'shower')],
      ['shower', 'shower'],
    );
    const a = row('glass', 'glass_partition', { sameObjectAs: 'shower' });
    a.visibleStructure.transparentPanel = 'present';
    const b = row('shower', 'shower', { sameObjectAs: 'glass', showerStyle: 'overhead-set' });
    const result = await applyReflectionRechecks(await prepared(c, [a, b]));
    expect(result.understanding).toEqual(c.appearance.understanding);
    expect(result.record.decisions.every((x) => x.status === 'held' && !x.canonicalId)).toBe(true);
  });
  it.each(['manual', 'provenance', 'component-relation', 'held-appearance', 'validation'] as const)(
    'protects %s before obtaining or applying a target receipt',
    async (mode) => {
      const c = pairContext();
      if (mode === 'manual') c.protectedCandidateIds = new Set(['cabinet']);
      if (mode === 'provenance') c.identity.candidates[1].provenance = { kind: 'user' };
      if (mode === 'component-relation')
        c.identity.relations = [
          { frontId: 'panel', behindId: 'cabinet', relation: 'partOf', evidence: ['Authored component'] },
        ];
      if (mode === 'held-appearance') c.appearance.decisions[1].status = 'held';
      if (mode === 'validation')
        c.identity.candidates[1].validation = {
          status: 'needs-review',
          issues: [{ code: 'existing', message: 'Authored prior validation' }],
        };
      expect(reflectionRecheckCandidates(c)[1].eligible).toBe(false);
      const p = await prepared(c, [mirrorRow('cabinet', 'panel')]);
      await expect(applyReflectionRechecks(p)).rejects.toThrow();
    },
  );
  it('rejects a prior-policy receipt and a changed input snapshot without rewriting archived analysis', async () => {
    const p = await prepared(pairContext(), [mirrorRow('cabinet', null)]);
    const old = JSON.parse(p.expected.requests[0].sourceDecisionSignature);
    old.ruleRevision = 'reflection-direct-mirror-v2';
    p.expected.requests[0].sourceDecisionSignature = canonicalTargetValue(old);
    const before = structuredClone(p);
    await expect(applyReflectionRechecks(p)).rejects.toThrow();
    expect(p).toEqual(before);
  });
});
