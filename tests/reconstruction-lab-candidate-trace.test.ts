import { describe, expect, it } from 'vitest';
import { labCandidateTraces, type LabTraceReport } from '../src/lib/reconstruction/lab-candidate-trace';
import type { ReconstructionCandidate } from '../src/lib/reconstruction/types';
import type { SceneCandidate } from '../src/lib/reconstruction/pipeline-contract';

const candidate = (id = 'sink'): ReconstructionCandidate => ({
  id,
  kind: 'basin',
  source: 'deeplab',
  status: 'unplaced',
  bounds: { left: 0.2, top: 0.2, right: 0.4, bottom: 0.6 },
  foot: { x: 0.3, y: 0.6 },
  color: '#ffffff',
  pixels: 100,
  evidence: { semanticPixels: 100, meanMargin: 2 },
  installation: { mode: 'wall', basinVariant: 'wall', reason: '기록된 벽걸이', source: 'inferred' },
});
const observed = (id = 'sink'): SceneCandidate => ({
  id,
  kind: 'basin',
  mounting: 'wall',
  wall: 'unknown',
  basinStyle: 'wall',
  shape: 'round',
  reflection: 'physical',
  bounds: { left: 0.2, top: 0.2, right: 0.4, bottom: 0.6 },
  evidence: ['test observation'],
  uncertainty: [],
});
function report(candidates = [candidate()]): LabTraceReport {
  return {
    rawSegmentationCandidates: structuredClone(candidates),
    rawReview: {
      version: 2,
      analysis: 'complete',
      candidates: structuredClone(candidates),
      planes: [],
      warnings: [],
    },
    review: { version: 2, analysis: 'complete', candidates, planes: [], warnings: [] },
    fixtures: [],
  };
}
function pipelineReport(): LabTraceReport {
  const r = report();
  const understanding = {
    schemaVersion: 1,
    roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: [] },
    candidates: [observed()],
    relations: [],
  };
  r.pipeline = {
    model: { understanding: structuredClone(understanding) },
    automaticUnderstanding: structuredClone(understanding),
    understanding,
    resolution: { entries: [{ candidateId: 'sink', disposition: 'fixture', reasons: [], relatedIds: [] }] },
    placements: [],
    modelChecks: [],
  } as unknown as NonNullable<LabTraceReport['pipeline']>;
  return r;
}
function stage(r: LabTraceReport, id: string) {
  return labCandidateTraces(r)[0].stages.find((entry) => entry.id === id)!;
}
const requested = {
  kind: 'basin' as const,
  face: 'back' as const,
  u: 0.1,
  v: 0.5,
  widthMm: 600,
  heightMm: 320,
  depthMm: 450,
  baseHeightMm: 1200,
  provenance: { dimensions: 'default' as const },
};

describe('candidate diagnostics preserve source records and distinguish stopping stages', () => {
  it('reports seven stages without calling observations accurate fixtures', () => {
    const result = labCandidateTraces(report())[0];
    expect(result.stages.map((entry) => entry.id)).toEqual([
      'observation',
      'resolution',
      'mounting',
      'support',
      'placement',
      'bounds',
      'generation',
    ]);
    expect(result.origin).toBe('original');
    expect(result.outcome).toBe('held');
    expect(result.stages[0].reasons.join()).toContain('실제 설비 여부');
  });
  it('keeps an original-only candidate and does not invent a filtering reason', () => {
    const r = report();
    r.review.candidates = [];
    const trace = labCandidateTraces(r)[0];
    expect(trace.outcome).toBe('trace-gap');
    expect(stage(r, 'resolution').status).toBe('missing-output');
    expect(stage(r, 'resolution').reasons.join()).toContain('원인이 기록되지 않아');
    expect(stage(r, 'mounting').status).toBe('not-run');
  });
  it('keeps explicit user provenance in old observation snapshots distinct from raw model detection', () => {
    const r = report();
    r.rawSegmentationCandidates![0].source = 'user';
    expect(labCandidateTraces(r)[0].origin).toBe('user');
    expect(stage(r, 'observation').status).toBe('not-recorded');
  });
  it('labels the real fallback source in older pipeline reports', () => {
    const r = pipelineReport();
    delete (r.pipeline! as Partial<NonNullable<LabTraceReport['pipeline']>>).model;
    expect(stage(r, 'observation').sources).toEqual(['pipeline.automaticUnderstanding']);
  });
  it('does not classify an explicit empty raw result as a user detection', () => {
    const r = report();
    r.rawSegmentationCandidates = [];
    r.review.candidates[0].source = 'user';
    expect(labCandidateTraces(r)[0].origin).toBe('user');
    expect(stage(r, 'observation').status).toBe('not-recorded');
  });
  it('does not claim model absence means the photograph contains no objects', () => {
    const r = report([]);
    expect(labCandidateTraces(r)).toEqual([]);
  });
  it('reads legacy results without fabricating original observations', () => {
    const r = report();
    delete r.rawReview;
    delete r.rawSegmentationCandidates;
    expect(labCandidateTraces(r)[0].origin).toBe('legacy');
  });
  it.each(['duplicate', 'component', 'reflection'] as const)(
    'records explicit %s resolution and stops independent generation',
    (disposition) => {
      const r = pipelineReport();
      r.pipeline!.resolution.entries[0] = {
        candidateId: 'sink',
        disposition,
        relatedIds: ['parent'],
        representativeId: 'parent',
        reasons: ['stored relation'],
      };
      r.review.candidates[0].status = 'ignored';
      const result = labCandidateTraces(r)[0];
      expect(result.outcome).toBe('excluded');
      expect(stage(r, 'resolution').output).toMatchObject({ representativeId: 'parent' });
      expect(stage(r, 'generation').status).toBe('not-run');
    },
  );
  it('does not treat an overlapping raw box as an explicit component relationship', () => {
    const r = report([candidate(), candidate('nearby')]);
    r.review.candidates = [candidate('nearby')];
    expect(labCandidateTraces(r)[0].outcome).toBe('trace-gap');
  });
  it('uses an explicit baseline bowl reference without geometric ID guessing', () => {
    const r = report([candidate('bowl')]);
    const parent = candidate('cabinet');
    parent.evidence.bowlCount = { value: 2, source: 'separate-basin-components', candidateIds: ['bowl'] };
    r.review.candidates = [parent];
    expect(labCandidateTraces(r)[0].outcome).toBe('excluded');
    expect(stage(r, 'resolution').output).toEqual({ representativeId: 'cabinet', disposition: 'component' });
  });
  it('shows strict requested coordinates and overflow separately from source-camera reprojection', () => {
    const r = report();
    r.review.candidates[0].placementReview = {
      version: 1,
      status: 'held',
      requested,
      reasons: ['left overflow'],
      overflowMm: { left: 60, right: 0, back: 0, front: 0, above: 0, below: 0 },
    };
    expect(stage(r, 'placement').output?.requested).toMatchObject(requested);
    expect(stage(r, 'bounds').status).toBe('held');
    expect(stage(r, 'bounds').reasons.join()).toContain('재투영 오차가 아니');
    expect(stage(r, 'generation').status).toBe('not-run');
  });
  it('keeps mounting known when source-camera position is held', () => {
    const r = pipelineReport();
    r.pipeline!.placements = [
      {
        candidateId: 'sink',
        status: 'held',
        reasons: ['source camera unknown'],
        provenance: { position: 'geometry', dimensions: 'default' },
      },
    ];
    expect(stage(r, 'mounting').status).toBe('recorded');
    expect(stage(r, 'placement').status).toBe('held');
    expect(stage(r, 'placement').reasons).toContain('source camera unknown');
    expect(stage(r, 'bounds').status).toBe('not-run');
  });
  it.each(['inferred', 'user'] as const)(
    'keeps unknown raw mounting distinct from an effective floor installation from %s',
    (source) => {
      const r = pipelineReport();
      r.pipeline!.model.understanding.candidates[0].mounting = 'unknown';
      r.pipeline!.automaticUnderstanding.candidates[0].mounting = 'unknown';
      r.pipeline!.understanding.candidates[0].mounting = 'unknown';
      r.review.candidates[0].installation = {
        mode: 'floor',
        basinVariant: 'pedestal',
        source,
        reason: source === 'user' ? '사용자가 바닥 설치 확인' : '설치 판단 단계의 바닥 설치 근거',
      };
      const before = structuredClone(r);
      const mounting = stage(r, 'mounting');
      expect(mounting.status).toBe('recorded');
      expect(mounting.input).toMatchObject({ mounting: 'unknown' });
      expect(mounting.output).toMatchObject({
        mounting: 'unknown',
        rawMounting: 'unknown',
        effectiveMounting: 'floor',
        mountingSource: source,
      });
      expect(mounting.sources).toContain('pipeline.understanding');
      expect(mounting.sources).toContain('review.candidates.installation');
      expect(mounting.reasons).toContain(r.review.candidates[0].installation.reason);
      expect(labCandidateTraces(r)[0].origin).toBe('original');
      expect(r).toEqual(before);
    },
  );
  it('does not treat a successful bounds check as an actually generated fixture', () => {
    const r = report();
    r.review.candidates[0].placementReview = { version: 1, status: 'accepted', requested, reasons: [] };
    expect(stage(r, 'generation').status).toBe('missing-output');
    expect(labCandidateTraces(r)[0].outcome).toBe('trace-gap');
  });
  it('requires the saved fixture link to exist even with placed status', () => {
    const r = report();
    Object.assign(r.review.candidates[0], { status: 'placed', fixtureId: 'missing' });
    expect(stage(r, 'generation').status).toBe('missing-output');
  });
  it('recognizes actual linked output independently from optional old diagnostic records', () => {
    const r = report();
    Object.assign(r.review.candidates[0], { status: 'placed', fixtureId: 'fixture' });
    r.fixtures = [{ id: 'fixture' }] as LabTraceReport['fixtures'];
    expect(labCandidateTraces(r)[0].outcome).toBe('placed');
    expect(stage(r, 'generation').status).toBe('recorded');
  });
  it('clones diagnostic input and does not mutate any saved observation or proposed coordinates', () => {
    const r = report();
    r.review.candidates[0].placementReview = { version: 1, status: 'held', requested, reasons: ['overflow'] };
    const before = structuredClone(r);
    const result = labCandidateTraces(r);
    const output = result[0].stages.find((entry) => entry.id === 'placement')!.output!.requested as Record<
      string,
      unknown
    >;
    output.u = 0.9;
    expect(r).toEqual(before);
    expect(labCandidateTraces(r)[0].stages[0].output?.bounds).toEqual(candidate().bounds);
  });
});

import {
  parseIdentityObservation,
  skippedIdentityAnalysis,
} from '../src/lib/reconstruction/identity-observation';
function identityTraceReport(knownPedestal: boolean): LabTraceReport {
  const r = pipelineReport();
  const original = r.pipeline!.model.understanding;
  Object.assign(
    original.candidates[0],
    knownPedestal
      ? { kind: 'basin', mounting: 'floor', basinStyle: 'pedestal' }
      : { kind: 'vanity', mounting: 'unknown', basinStyle: 'unknown' },
  );
  const rawText = JSON.stringify({
    observations: [
      {
        id: 'sink',
        note: 'Visible rear wall join and open underside',
        structure: 'wall_basin_open_underside',
        context: 'room_fixture',
      },
    ],
  });
  const parsed = parseIdentityObservation(rawText, original);
  const identity = { ...skippedIdentityAnalysis(original), ...parsed, rawText, skipped: undefined };
  r.pipeline!.quality = { identity } as NonNullable<NonNullable<LabTraceReport['pipeline']>['quality']>;
  r.pipeline!.automaticUnderstanding = structuredClone(parsed.understanding);
  r.pipeline!.understanding = structuredClone(parsed.understanding);
  return r;
}
describe('identity diagnostics preserve corrections without counting them as generated fixtures', () => {
  it('shows original, proposed and final kinds with separate model/rule sources', () => {
    const r = identityTraceReport(false),
      before = structuredClone(r);
    const trace = labCandidateTraces(r)[0],
      identity = stage(r, 'identity');
    expect(stage(r, 'observation').output).toMatchObject({ kind: 'vanity', mounting: 'unknown' });
    expect(identity.sources).toEqual(['pipeline.quality.identity']);
    expect(identity.input).toMatchObject({
      original: { kind: 'vanity', mounting: 'unknown' },
      observation: { structure: 'wall_basin_open_underside' },
    });
    expect(identity.output).toMatchObject({
      proposed: { kind: 'basin', mounting: 'wall' },
      final: { kind: 'basin', mounting: 'wall' },
      status: 'applied',
      source: 'rule-inferred',
      evidenceSource: 'model',
    });
    expect(identity.reasons.join()).toContain('독립적인 정답 검증은 아니');
    expect(trace.outcome).not.toBe('placed');
    expect(stage(r, 'generation').status).not.toBe('recorded');
    expect(r).toEqual(before);
  });
  it('retains the conflicting proposal and unchanged pedestal without claiming success', () => {
    const r = identityTraceReport(true),
      before = structuredClone(r);
    const trace = labCandidateTraces(r)[0],
      identity = stage(r, 'identity');
    expect(identity.input).toMatchObject({
      original: { kind: 'basin', basinStyle: 'pedestal', mounting: 'floor' },
    });
    expect(identity.output).toMatchObject({
      proposed: { basinStyle: 'wall', mounting: 'wall' },
      final: { basinStyle: 'pedestal', mounting: 'floor' },
      status: 'quarantined',
      source: 'rule-inferred',
      evidenceSource: 'model',
    });
    expect(identity.reasons.join()).toContain('충돌해 원값을 유지');
    expect(identity.reasons.join()).not.toContain('규칙으로 보정했어요');
    expect(trace.outcome).not.toBe('placed');
    expect(stage(r, 'generation').status).not.toBe('recorded');
    expect(r).toEqual(before);
  });
});

describe('estimated placement ledger preserves the strict failures',()=>{
 it('shows the selected estimated physical check and original held placement independently',()=>{
  const r=pipelineReport();
  r.pipeline!.placements=[{candidateId:'sink',status:'held',reasons:['strict camera unresolved']}] as NonNullable<LabTraceReport['pipeline']>['placements'];
  r.pipeline!.estimatedLayout={nodes:[{candidateId:'sink',status:'placed-estimate',observed:observed(),reasons:['visible evidence estimate'],
    selected:{plan:requested,physicalCheck:{valid:true,reasons:[],worldBoundsMm:{min:[0,0,0],max:[1,1,1]}},sources:{position:'estimated'}},alternatives:[]}]} as unknown as NonNullable<NonNullable<LabTraceReport['pipeline']>['estimatedLayout']>;
  Object.assign(r.review.candidates[0],{status:'placed',fixtureId:'fixture'});r.fixtures=[{id:'fixture'}] as LabTraceReport['fixtures'];
  const before=structuredClone(r),trace=labCandidateTraces(r)[0];
  expect(stage(r,'placement').reasons.join()).toContain('strict camera unresolved');
  expect(stage(r,'estimatedLayout').output?.status).toBe('placed-estimate');
  expect(stage(r,'estimatedLayout').reasons.join()).toContain('실측 위치나 품질 통과를 뜻하지');
  expect(stage(r,'bounds').sources).toEqual(['pipeline.estimatedLayout.nodes.selected.physicalCheck']);
  expect(stage(r,'bounds').status).toBe('recorded');expect(trace.outcome).toBe('placed');expect(r).toEqual(before);
 });
 it('reports a canonical duplicate exclusion without claiming a missing successful fixture',()=>{
  const r=pipelineReport();
  r.pipeline!.estimatedLayout={nodes:[{candidateId:'sink',status:'excluded',observed:observed(),reasons:['same physical object -> parent'],alternatives:[]}]} as unknown as NonNullable<NonNullable<LabTraceReport['pipeline']>['estimatedLayout']>;
  expect(labCandidateTraces(r)[0].outcome).toBe('excluded');
  expect(stage(r,'estimatedLayout').status).toBe('excluded');
  expect(stage(r,'generation').status).not.toBe('missing-output');
 });
 it('records old kind and new held unknown classification without relabeling the raw detection',()=>{
  const r=pipelineReport();
  r.pipeline!.estimatedLayout={nodes:[],appearance:{decisions:[{candidateId:'sink',status:'held',original:observed(),effective:{...observed(),kind:'unknown'},observation:{kind:'unknown'},reasons:['type not determined']}],modelOptions:{},duplicates:[]}} as unknown as NonNullable<NonNullable<LabTraceReport['pipeline']>['estimatedLayout']>;
  expect(stage(r,'appearance').status).toBe('held');
  expect(stage(r,'appearance').output?.effective).toMatchObject({kind:'unknown'});
  expect(stage(r,'observation').output?.kind).toBe('basin');
 });
});


describe('optional refinement ledger (record fixtures, not model-quality evidence)', () => {
  it('keeps a mirror reflection change separate from the original observation', () => {
    const r = pipelineReport();
    r.pipeline!.quality = { reflectionRecheck: { decisions: [{
      candidateId: 'sink', eligible: true, status: 'applied', reasons: ['visible mirror surface confirmed'],
      originalReflection: 'reflected', effectiveReflection: 'physical', observationRawTextSha256: 'a'.repeat(64),
    }] } } as NonNullable<NonNullable<LabTraceReport['pipeline']>['quality']>;
    const before = structuredClone(r);
    const value = stage(r, 'reflectionRecheck');
    expect(value.status).toBe('recorded');
    expect(value.input?.originalReflection).toBe('reflected');
    expect(value.output?.effectiveReflection).toBe('physical');
    expect(value.output?.observationRawTextSha256).toBe('a'.repeat(64));
    expect(r).toEqual(before);
  });
  it('does not equate a shower-detail observation with a successful placement', () => {
    const r = pipelineReport();
    r.pipeline!.estimatedLayout = { nodes: [], showerDetails: [{ id: 'sink', kind: 'tap-only', style: 'unknown',
      observedPart: 'control', context: 'physical', note: 'Only a tap control is visible.',
      visibleParts: { handheldHead: 'absent', overheadHead: 'absent', verticalRail: 'absent', hose: 'absent' },
    }] } as unknown as NonNullable<NonNullable<LabTraceReport['pipeline']>['estimatedLayout']>;
    const value = stage(r, 'showerDetails');
    expect(value.status).toBe('recorded');
    expect(value.input?.observed).toMatchObject({ kind: 'tap-only', observedPart: 'control' });
    expect(value.output?.selected).toBeUndefined();
    expect(value.output?.placementStatus).toBeUndefined();
    expect(labCandidateTraces(r)[0].outcome).not.toBe('placed');
  });
  it('does not invent stages for a historical report without optional observations', () => {
    const ids = labCandidateTraces(pipelineReport())[0].stages.map((s) => s.id);
    expect(ids).not.toContain('reflectionRecheck');
    expect(ids).not.toContain('showerDetails');
  });
});
