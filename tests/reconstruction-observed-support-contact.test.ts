import { describe, expect, it } from 'vitest';
import { inspectObservedSupportContact, type ObservedSupportContactContext } from '../src/lib/reconstruction/observed-support-contact';
import type { SceneCandidate } from '../src/lib/reconstruction/pipeline-contract';
import type { ReconstructionReview } from '../src/lib/reconstruction/types';

function sample() {
  const candidate: SceneCandidate = { id: 'bowl', kind: 'basin', mounting: 'unknown', wall: 'unknown',
    basinStyle: 'pedestal', shape: 'rectangular', reflection: 'physical',
    bounds: { left: .4, top: .35, right: .6, bottom: .51 }, evidence: ['visible basin bowl'], uncertainty: [] };
  const baseline: ReconstructionReview = { version: 2, analysis: 'partial', planes: [], warnings: [], candidates: [{
    id: 'basin-component', kind: 'basin', source: 'deeplab', status: 'unplaced',
    bounds: { left: .4, top: .35, right: .6, bottom: .8 }, foot: { x: .5, y: .8 }, color: '#aaa', pixels: 2000,
    evidence: { semanticPixels: 2000, meanMargin: 3, pedestalSupport: { stemWidthRatio: .3, stemHeightRatio: .5, coverage: .95 } },
    installation: { mode: 'floor', basinVariant: 'pedestal', source: 'inferred', reason: 'same connected narrow lower stem' },
  }] };
  const context: ObservedSupportContactContext = { image: { width: 800, height: 800 },
    candidateInputFingerprint: 'a'.repeat(64), observationInputFingerprint: 'a'.repeat(64), relations: [] };
  return { candidate, baseline, context };
}
const inspect = (s: ReturnType<typeof sample>, claims: SceneCandidate[] = [s.candidate]) =>
  inspectObservedSupportContact(s.candidate, claims, s.baseline, s.context);

describe('independent observed pedestal support contact', () => {
  it('returns the same component bottom without a room, plane, camera, or model anchor', () => {
    const s = sample(), original = structuredClone(s);
    const result = inspect(s);
    expect(result.contact).toMatchObject({ candidateId: 'bowl', baselineCandidateId: 'basin-component',
      baselineBounds: s.baseline.candidates[0].bounds, point: { x: .5, y: .8 },
      pointRole: 'observed-pedestal-bottom', source: 'geometry', inputFingerprint: 'a'.repeat(64),
      evidence: { source: 'deeplab', matchMode: 'pedestal-bowl-part', positionBorrowed: false,
        interpretation: 'support-contour-bottom-not-footprint-centre' } });
    expect(result.diagnostic.status).toBe('accepted');
    expect(result.contact!.point.y).not.toBe(s.candidate.bounds.bottom);
    expect(result.contact!.reasons.join()).toContain('실측 접점이 아니');
    expect(s).toEqual(original);
    result.contact!.point.y = .2;
    expect(s.baseline.candidates[0].foot.y).toBe(.8);
  });
  it('can infer unknown support only when full observation matching and independent stem evidence agree', () => {
    const s = sample();
    s.candidate.bounds = { ...s.baseline.candidates[0].bounds };
    s.candidate.basinStyle = 'unknown';
    expect(inspect(s).contact?.evidence.matchMode).toBe('bounds-overlap');
    delete s.baseline.candidates[0].evidence.pedestalSupport;
    expect(inspect(s).contact).toBeUndefined();
  });
  it.each(['missing', 'mismatch', 'malformed', 'image', 'relations'] as const)('requires verified photo context: %s', (bad) => {
    const s = sample();
    if (bad === 'missing') expect(inspectObservedSupportContact(s.candidate, [s.candidate], s.baseline).contact).toBeUndefined();
    else {
      if (bad === 'mismatch') s.context.observationInputFingerprint = 'b'.repeat(64);
      if (bad === 'malformed') s.context.candidateInputFingerprint = s.context.observationInputFingerprint = 'not-a-hash';
      if (bad === 'image') s.context.image.height = 0;
      if (bad === 'relations') s.context.relations = undefined as unknown as [];
      expect(inspect(s).diagnostic.code).toBe('identity-unverified');
    }
  });
  it('does not overwrite an explicit source or user anchor', () => {
    const s = sample();
    s.candidate.anchor = { kind: 'floor-contact', point: { x: .51, y: .77 }, evidence: ['visible contact'], uncertainty: [] };
    expect(inspect(s).diagnostic.code).toBe('existing-anchor');
    expect(s.candidate.anchor.point).toEqual({ x: .51, y: .77 });
  });
  it.each(['qwen', 'user', undefined] as const)('rejects unsupported baseline source %s', (source) => {
    const s = sample(); s.baseline.candidates[0].source = source;
    expect(inspect(s).contact).toBeUndefined();
    expect(inspect(s).diagnostic.installationCheck?.code).toBe('observation-match-missing');
  });
  it.each(['claim-reflected', 'claim-unknown', 'baseline-reflection', 'review', 'ignored', 'user-installation', 'invalid-claim', 'low-margin'] as const)(
    'retains shared installation rejection: %s', (bad) => {
      const s = sample(), observed = s.baseline.candidates[0];
      if (bad === 'claim-reflected') s.candidate.reflection = 'reflected';
      if (bad === 'claim-unknown') s.candidate.reflection = 'unknown' as unknown as SceneCandidate['reflection'];
      if (bad === 'baseline-reflection') observed.reflectionOf = 'other';
      if (bad === 'review') observed.requiresReview = true;
      if (bad === 'ignored') observed.status = 'ignored';
      if (bad === 'user-installation') observed.installation!.source = 'user';
      if (bad === 'invalid-claim') s.candidate.validation = { status: 'needs-review', issues: [{ code: 'bad', message: 'invalid' }] };
      if (bad === 'low-margin') observed.evidence.meanMargin = .1;
      expect(inspect(s).contact).toBeUndefined();
    });
  it.each(['missing', 'gap', 'wide', 'short', 'nan', 'over-one'] as const)('rejects weak stem even with a full-bounds match: %s', (bad) => {
    const s = sample(); s.candidate.bounds = { ...s.baseline.candidates[0].bounds };
    const e = s.baseline.candidates[0].evidence;
    if (bad === 'missing') delete e.pedestalSupport;
    if (bad === 'gap') e.pedestalSupport!.coverage = .69;
    if (bad === 'wide') e.pedestalSupport!.stemWidthRatio = .61;
    if (bad === 'short') e.pedestalSupport!.stemHeightRatio = .29;
    if (bad === 'nan') e.pedestalSupport!.coverage = NaN;
    if (bad === 'over-one') e.pedestalSupport!.coverage = 2;
    expect(inspect(s).contact).toBeUndefined();
  });
  it('does not share one pedestal among two claims or choose among two components', () => {
    const s = sample();
    expect(inspect(s, [s.candidate, { ...s.candidate, id: 'other-bowl' }]).contact).toBeUndefined();
    s.baseline.candidates.push({ ...structuredClone(s.baseline.candidates[0]), id: 'other-component' });
    expect(inspect(s).contact).toBeUndefined();
  });
  it.each(['baseline-bottom', 'claim-bottom', 'baseline-side', 'foot-side', 'foot-off-bottom', 'foot-outside', 'foot-shifted'] as const)(
    'does not borrow a clipped or inconsistent endpoint: %s', (bad) => {
      const s = sample(), observed = s.baseline.candidates[0];
      if (bad === 'baseline-bottom') observed.bounds.bottom = observed.foot.y = 1;
      if (bad === 'claim-bottom') s.candidate.bounds.bottom = .998;
      if (bad === 'baseline-side') observed.bounds.left = 0;
      if (bad === 'foot-side') observed.foot.x = 0;
      if (bad === 'foot-off-bottom') observed.foot.y = .7;
      if (bad === 'foot-outside') observed.foot.x = .9;
      if (bad === 'foot-shifted') observed.foot.x = .59;
      expect(inspect(s).contact).toBeUndefined();
    });
  it.each(['reflectionOf', 'partOf'] as const)('does not treat relation %s as an independent pedestal', (relation) => {
    const s = sample(); s.context.relations = [{ frontId: 'bowl', behindId: 'parent', relation, evidence: ['observed relation'] }];
    expect(inspect(s).diagnostic.code).toBe('relation-conflict');
  });
  it('holds when another actual product contains the proposed support endpoint', () => {
    const s = sample();
    const other: SceneCandidate = { ...s.candidate, id: 'foreground', kind: 'toilet', bounds: { left: .45, top: .7, right: .55, bottom: .9 } };
    expect(inspect(s, [s.candidate, other]).diagnostic.code).toBe('contact-occluded');
    s.baseline.candidates.push({ ...structuredClone(s.baseline.candidates[0]), id: 'semantic-toilet', kind: 'toilet', bounds: other.bounds });
    expect(inspect(s).diagnostic.code).toBe('contact-occluded');
  });
  it.each(['occludes', 'visibleThrough', 'uncertain'] as const)('holds unresolved support visibility under %s', (relation) => {
    const s = sample();
    s.context.relations = [{ frontId: 'missing-foreground', behindId: 'bowl', relation, evidence: ['observed overlap'] }];
    expect(inspect(s).diagnostic.code).toBe('contact-occluded');
  });
  it('allows a foreground relation whose observed extent does not cover the lower stem', () => {
    const s = sample();
    const glass: SceneCandidate = { ...s.candidate, id: 'glass', kind: 'glassPartition', bounds: { left: .7, top: .1, right: .9, bottom: .9 } };
    s.context.relations = [{ frontId: 'glass', behindId: 'bowl', relation: 'visibleThrough', evidence: ['partial overlap'] }];
    expect(inspect(s, [s.candidate, glass]).contact).toBeDefined();
  });
});