import { describe, expect, it } from 'vitest';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
import { buildCandidatePipeline } from '../src/lib/reconstruction/candidate-pipeline';
import { buildEstimatedCandidatePipeline } from '../src/lib/reconstruction/estimated-layout';
import {
  inspectCandidateToiletLid,
  resolveCandidateToiletLid,
} from '../src/lib/reconstruction/candidate-toilet-lid';
import { resolveSceneCandidates } from '../src/lib/reconstruction/candidate-resolution';
import type { SceneCandidate, SceneUnderstanding } from '../src/lib/reconstruction/pipeline-contract';
import type { ReconstructionCandidate, ReconstructionReview } from '../src/lib/reconstruction/types';

function fixture() {
  const candidate: SceneCandidate = {
    id: 'wc',
    kind: 'toilet',
    bounds: { left: 0.05, top: 0.2, right: 0.45, bottom: 0.68 },
    mounting: 'floor',
    wall: 'unknown',
    basinStyle: 'unknown',
    shape: 'unknown',
    reflection: 'physical',
    evidence: ['Synthetic semantic observation.'],
    uncertainty: [],
    provenance: { kind: 'model' },
  };
  const semantic: ReconstructionCandidate = {
    id: 'semantic-wc',
    kind: 'toilet',
    source: 'deeplab',
    bounds: { ...candidate.bounds },
    foot: { x: 0.25, y: 0.68 },
    color: '#eeeeee',
    pixels: 1900,
    status: 'unplaced',
    evidence: {
      semanticPixels: 700,
      meanMargin: 1.2,
      contextualKind: 'toilet-assembly',
      contextualParts: {
        toiletPixels: 700,
        bowlPixels: 720,
        surroundRatio: 1,
        lidBounds: { left: 0.09, top: 0.2, right: 0.26, bottom: 0.45 },
        bowlBounds: { left: 0.05, top: 0.5, right: 0.45, bottom: 0.68 },
      },
    },
  };
  const understanding: SceneUnderstanding = {
    schemaVersion: 1,
    candidates: [candidate],
    relations: [],
    roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: ['Uncalibrated camera'] },
  };
  const baseline: ReconstructionReview = {
    version: 2,
    analysis: 'partial',
    planes: [],
    candidates: [semantic],
    warnings: [],
  };
  return {
    candidate,
    semantic,
    understanding,
    baseline,
    room: { ...DEFAULT_ROOM },
    image: { width: 500, height: 500 },
  };
}
function observe(f: ReturnType<typeof fixture>) {
  return inspectCandidateToiletLid({
    candidate: f.candidate,
    canonicalCandidate: f.candidate,
    baselineCandidates: f.baseline.candidates,
    resolution: resolveSceneCandidates(f.understanding).resolution,
    relations: f.understanding.relations,
  });
}
function strict(
  f: ReturnType<typeof fixture>,
  policy: 'legacy-placement-coupled' | 'independent-semantic-v1',
  manual = false,
  lids: Record<string, 'open' | 'closed'> = {},
) {
  return buildCandidatePipeline(
    f.understanding,
    f.baseline,
    f.room,
    f.image,
    manual ? { wc: { face: 'floor', u: 0.5, v: 0.5, baseHeightMm: 0 } } : {},
    f.understanding,
    lids,
    undefined,
    undefined,
    {},
    {},
    policy,
  );
}
function trial(f: ReturnType<typeof fixture>, lids: Record<string, 'open' | 'closed'> = {}) {
  const strictResult = strict(f, 'independent-semantic-v1', false, lids);
  return buildEstimatedCandidatePipeline({ ...f, strictResult, toiletLidPolicy: 'independent-semantic-v1' });
}

describe('independent original semantic toilet lid transfer', () => {
  it('records the same lid observation for held and user-positioned strict candidates without changing held placement', () => {
    const f = fixture(),
      frozen = structuredClone(f);
    const held = strict(f, 'independent-semantic-v1'),
      placed = strict(f, 'independent-semantic-v1', true);
    expect(held.plans.wc).toBeNull();
    expect(held.pipeline.placements[0].status).toBe('held');
    expect(held.pipeline.toiletLidObservations?.[0].observed?.value).toBe('open');
    expect(placed.pipeline.toiletLidObservations?.[0].observed).toEqual(
      held.pipeline.toiletLidObservations?.[0].observed,
    );
    expect(placed.plans.wc).toMatchObject({
      toiletLidState: 'open',
      provenance: { toiletLidState: 'inferred' },
    });
    expect(f).toEqual(frozen);
  });
  it.each(['kind', 'position', 'mounting'] as const)(
    'preserves strict open behavior when only %s has user provenance',
    (field) => {
      const f = fixture();
      f.candidate.provenance = { ...f.candidate.provenance, [field]: 'user' };
      const control = strict(f, 'legacy-placement-coupled', true),
        applied = strict(f, 'independent-semantic-v1', true);
      expect(control.plans.wc?.toiletLidState).toBe('open');
      expect(applied.plans.wc).toEqual(control.plans.wc);
    },
  );
  it('protects latest user closed even when the strict plan is null, and propagates it to all visible alternatives', () => {
    const f = fixture(),
      result = trial(f, { wc: 'closed' });
    expect(result.plans.wc).not.toBeNull();
    expect(result.plans.wc).toMatchObject({
      toiletLidState: 'closed',
      provenance: { toiletLidState: 'user' },
    });
    for (const alt of result.pipeline.estimatedLayout.nodes[0].alternatives)
      expect(alt.plan).toMatchObject({ toiletLidState: 'closed', provenance: { toiletLidState: 'user' } });
  });
  it('propagates inferred open to generated alternatives; the strict held diagnosis stays intact', () => {
    const f = fixture(),
      result = trial(f);
    expect(result.pipeline.placements[0].status).toBe('held');
    expect(result.plans.wc?.toiletLidState).toBe('open');
    for (const alt of result.pipeline.estimatedLayout.nodes[0].alternatives)
      expect(alt.plan).toMatchObject({ toiletLidState: 'open', provenance: { toiletLidState: 'inferred' } });
  });
  it('lets latest validated lid map override a different older user plan without inventing a conflict error', () => {
    expect(
      resolveCandidateToiletLid(observe(fixture()), 'open', {
        toiletLidState: 'closed',
        provenance: { toiletLidState: 'user' },
      }),
    ).toEqual({ value: 'open', source: 'user' });
  });
  it('does not prefilter a highest-IoU wrong-kind or invalid semantic candidate to pick a favorable toilet', () => {
    for (const kind of ['basin', 'toilet'] as const) {
      const f = fixture();
      const first = structuredClone(f.semantic);
      first.id = 'first';
      first.kind = kind;
      if (kind === 'toilet') first.requiresReview = true;
      f.baseline.candidates.unshift(first); // identical IoU: original tie order must remain authoritative
      expect(observe(f).semanticCandidateId).toBe('first');
      expect(observe(f).observed).toBeUndefined();
    }
  });
  it.each([
    [
      'requiresReview',
      (s: ReconstructionCandidate) => {
        s.requiresReview = true;
      },
    ],
    [
      'qwen source',
      (s: ReconstructionCandidate) => {
        s.source = 'qwen';
      },
    ],
    [
      'ignored',
      (s: ReconstructionCandidate) => {
        s.status = 'ignored';
      },
    ],
    [
      'reflection',
      (s: ReconstructionCandidate) => {
        s.reflectionOf = 'mirror';
      },
    ],
    [
      'missing parts',
      (s: ReconstructionCandidate) => {
        delete s.evidence.contextualParts;
      },
    ],
    [
      'low margin',
      (s: ReconstructionCandidate) => {
        s.evidence.meanMargin = 0.79;
      },
    ],
  ] as const)('retains original helper protection: %s', (_name, mutate) => {
    const f = fixture();
    mutate(f.semantic);
    f.candidate.evidence = ['lid open'];
    expect(observe(f).observed).toBeUndefined();
  });
  it('preserves the exact IoU .5 boundary without changing helper part coordinates', () => {
    const f = fixture();
    f.candidate.bounds = { ...f.semantic.bounds, right: 0.85 }; // twice semantic width -> .5
    expect(observe(f).observed?.value).toBe('open');
    f.candidate.bounds.right = 0.851;
    expect(observe(f).observed).toBeUndefined();
  });
  it('never emits a reflected fixture by transferring an appearance attribute', () => {
    const f = fixture();
    f.candidate.reflection = 'reflected';
    expect(observe(f).status).toBe('excluded');
    const result = trial(f);
    expect(result.plans.wc).toBeNull();
  });
  it('does not consume stale ID-only diagnostics and keeps serialized snapshots independent', () => {
    const f = fixture(),
      source = observe(f),
      snapshot = JSON.parse(JSON.stringify(source));
    delete f.semantic.evidence.contextualParts;
    expect(observe(f).observed).toBeUndefined();
    expect(source).toEqual(snapshot);
    const candidate = { ...f.candidate, bounds: { ...f.candidate.bounds, left: 0.06 } };
    const mismatch = inspectCandidateToiletLid({
      candidate,
      canonicalCandidate: f.candidate,
      baselineCandidates: f.baseline.candidates,
      resolution: resolveSceneCandidates(f.understanding).resolution,
      relations: [],
    });
    expect(mismatch.status).toBe('excluded');
    expect(snapshot.observed.value).toBe('open');
  });
  it('keeps invalid latest lid IDs/enums rejected by the existing strict input validator', () => {
    const f = fixture();
    expect(() => strict(f, 'independent-semantic-v1', false, { absent: 'open' })).toThrow(/뚜껑/);
    expect(() => strict(f, 'independent-semantic-v1', false, { wc: 'ajar' as 'open' })).toThrow(/뚜껑/);
  });
  it('uses the same adopted policy when strict and estimated inputs omit their policy', () => {
    const f = fixture();
    const omitted = buildCandidatePipeline(f.understanding, f.baseline, f.room, f.image);
    expect(omitted).toEqual(strict(f, 'independent-semantic-v1'));
    const args = { ...f, strictResult: omitted };
    expect(buildEstimatedCandidatePipeline(args)).toEqual(
      buildEstimatedCandidatePipeline({ ...args, toiletLidPolicy: 'independent-semantic-v1' }),
    );
    const legacy = strict(f, 'legacy-placement-coupled');
    expect(legacy.pipeline.toiletLidObservations).toBeUndefined();
    expect(
      buildEstimatedCandidatePipeline({
        ...f,
        strictResult: legacy,
        toiletLidPolicy: 'legacy-placement-coupled',
      }).plans.wc?.toiletLidState,
    ).toBe('closed');
    expect(buildEstimatedCandidatePipeline(args).plans.wc?.toiletLidState).toBe('open');
  });

  it('merges lid provenance without discarding other appearance fields on newly generated alternatives', () => {
    const f = fixture();
    const strictResult = strict(f, 'independent-semantic-v1');
    const result = buildEstimatedCandidatePipeline({
      ...f,
      strictResult,
      toiletLidPolicy: 'independent-semantic-v1',
      appearance: {
        modelOptions: { wc: { provenance: { color: 'user', appearance: 'inferred', shape: 'model' } } },
        duplicates: [],
        decisions: [],
      },
    });
    expect(result.plans.wc?.provenance).toMatchObject({
      color: 'user',
      appearance: 'inferred',
      shape: 'model',
      toiletLidState: 'inferred',
    });
    const alternatives = result.pipeline.estimatedLayout.nodes[0].alternatives;
    expect(alternatives.length).toBeGreaterThan(0);
    for (const option of alternatives)
      expect(option.plan.provenance).toMatchObject({
        color: 'user',
        appearance: 'inferred',
        shape: 'model',
        toiletLidState: 'inferred',
      });
  });
  it.each([0.85, 1, 1.15])(
    'transfers open to newly generated size factor %s and each supported wall direction',
    (size) => {
      for (const wall of ['left', 'back', 'right'] as const) {
        const f = fixture();
        f.candidate.wall = wall;
        f.candidate.provenance = { ...f.candidate.provenance, wall: 'user' };
        const strictResult = strict(f, 'independent-semantic-v1');
        const result = buildEstimatedCandidatePipeline({
          ...f,
          strictResult,
          sizeFactors: [size],
          toiletLidPolicy: 'independent-semantic-v1',
        });
        expect(result.plans.wc).not.toBeNull();
        expect(result.plans.wc?.widthMm).toBeCloseTo(400 * size);
        expect(result.plans.wc?.yawDegrees).toBe(wall === 'left' ? 90 : wall === 'right' ? -90 : 0);
        const alternatives = result.pipeline.estimatedLayout.nodes[0].alternatives;
        expect(alternatives.length).toBeGreaterThan(0);
        for (const alt of alternatives)
          expect(alt.plan).toMatchObject({
            toiletLidState: 'open',
            provenance: { toiletLidState: 'inferred' },
          });
      }
    },
  );
  it('applies latest explicit lid to retained strict proposal while preserving other fields and the old plan', () => {
    const f = fixture();
    const strictResult = strict(f, 'independent-semantic-v1', true, { wc: 'closed' });
    const previous = structuredClone(strictResult.plans.wc);
    strictResult.pipeline.userToiletLidStates = { wc: 'open' };
    const result = buildEstimatedCandidatePipeline({
      ...f,
      strictResult,
      manualIdSet: new Set(['wc']),
      toiletLidPolicy: 'independent-semantic-v1',
    });
    expect(result.plans.wc).toMatchObject({ toiletLidState: 'open', provenance: { toiletLidState: 'user' } });
    for (const key of [
      'face',
      'u',
      'v',
      'baseHeightMm',
      'widthMm',
      'heightMm',
      'depthMm',
      'yawDegrees',
    ] as const)
      expect(result.plans.wc?.[key]).toEqual(previous?.[key]);
    expect(strictResult.plans.wc).toEqual(previous);
  });
  it('uses previous user lid only when the latest map is absent, including estimated alternatives', () => {
    const f = fixture(),
      strictResult = strict(f, 'independent-semantic-v1', true, { wc: 'closed' });
    delete strictResult.pipeline.userToiletLidStates;
    const result = buildEstimatedCandidatePipeline({
      ...f,
      strictResult,
      toiletLidPolicy: 'independent-semantic-v1',
    });
    expect(result.plans.wc).toMatchObject({
      toiletLidState: 'closed',
      provenance: { toiletLidState: 'user' },
    });
    expect(result.pipeline.estimatedLayout.nodes[0].alternatives.length).toBeGreaterThan(0);
    for (const alt of result.pipeline.estimatedLayout.nodes[0].alternatives)
      expect(alt.plan).toMatchObject({ toiletLidState: 'closed', provenance: { toiletLidState: 'user' } });
  });
  it('respects real duplicate resolution without creating a second fixture from the same semantic parts', () => {
    const f = fixture();
    f.understanding.candidates.push({ ...structuredClone(f.candidate), id: 'wc-copy' });
    const strictResult = strict(f, 'independent-semantic-v1');
    const duplicate = strictResult.pipeline.resolution.entries.find(
      (entry) => entry.disposition === 'duplicate',
    );
    expect(duplicate).toBeDefined();
    const result = buildEstimatedCandidatePipeline({
      ...f,
      strictResult,
      toiletLidPolicy: 'independent-semantic-v1',
    });
    expect(result.plans[duplicate!.candidateId]).toBeNull();
    expect(
      result.pipeline.estimatedLayout.nodes.find((node) => node.candidateId === duplicate!.candidateId)
        ?.status,
    ).toBe('excluded');
    expect(Object.values(result.plans).filter(Boolean)).toHaveLength(1);
  });
  it('keeps explicit reflectionOf and candidate validation issues outside automatic appearance transfer', () => {
    const reflected = fixture();
    reflected.understanding.candidates.push({
      ...structuredClone(reflected.candidate),
      id: 'mirror',
      kind: 'mirror',
    });
    reflected.understanding.relations.push({
      frontId: 'wc',
      behindId: 'mirror',
      relation: 'reflectionOf',
      evidence: ['synthetic relation'],
    });
    expect(observe(reflected).status).toBe('excluded');
    const invalid = fixture();
    invalid.candidate.validation = {
      status: 'needs-review',
      issues: [{ code: 'synthetic', message: 'invalid evidence' }],
    };
    expect(observe(invalid).status).toBe('excluded');
  });
  it('rechecks original semantic input instead of trusting a stored open diagnostic with the same ID', () => {
    const f = fixture();
    const strictResult = strict(f, 'independent-semantic-v1');
    const snapshot = JSON.parse(JSON.stringify(strictResult.pipeline.toiletLidObservations));
    strictResult.pipeline.baselineReview.candidates[0].requiresReview = true;
    const result = buildEstimatedCandidatePipeline({
      ...f,
      strictResult,
      toiletLidPolicy: 'independent-semantic-v1',
    });
    expect(result.plans.wc?.toiletLidState).toBe('closed');
    expect(result.pipeline.estimatedLayout.nodes[0].toiletLidObservation?.observed).toBeUndefined();
    expect(strictResult.pipeline.toiletLidObservations).toEqual(snapshot);
    expect(snapshot[0].observed.value).toBe('open');
  });
  it('matches equal coordinate values independently of object key insertion order', () => {
    const f = fixture();
    const { left, top, right, bottom } = f.candidate.bounds;
    const reordered = { ...f.candidate, bounds: { bottom, right, top, left } };
    const result = inspectCandidateToiletLid({
      candidate: reordered,
      canonicalCandidate: f.candidate,
      baselineCandidates: f.baseline.candidates,
      resolution: resolveSceneCandidates(f.understanding).resolution,
      relations: [],
    });
    expect(result.status).toBe('observed');
    expect(result.observed?.value).toBe('open');
  });
});
