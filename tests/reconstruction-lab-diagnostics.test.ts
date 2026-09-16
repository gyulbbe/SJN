import { describe, expect, it } from 'vitest';
import {
  buildDiagnosticSummary,
  createDiagnosticRun,
  diagnosticValue,
  ReconstructionDiagnosticError,
} from '../src/lib/reconstruction/lab-diagnostics';
import type { ReconstructionLabReport } from '../src/lib/reconstruction/lab';
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
  installation: { mode: 'wall', basinVariant: 'wall', reason: '벽걸이 관측', source: 'inferred' },
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
function report(candidates = [candidate()]): ReconstructionLabReport {
  return {
    runId: 'run-1',
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
  } as unknown as ReconstructionLabReport;
}
function pipelineReport(): ReconstructionLabReport {
  const result = report();
  const understanding = {
    schemaVersion: 1,
    roomLayout: { orthogonal: 'unknown', evidence: [], uncertainty: [] },
    candidates: [observed()],
    relations: [],
  };
  result.pipeline = {
    model: { understanding: structuredClone(understanding) },
    automaticUnderstanding: structuredClone(understanding),
    understanding,
    camera: { status: 'held', reasons: ['원사진 카메라 미확정'] },
    resolution: { entries: [{ candidateId: 'sink', disposition: 'fixture', reasons: [], relatedIds: [] }] },
    placements: [],
    modelChecks: [],
  } as unknown as NonNullable<ReconstructionLabReport['pipeline']>;
  return result;
}
const input = { name: 'bathroom.jpg', bytes: 1200, mime: 'image/jpeg' };
const startedAt = '2026-09-14T00:00:00.000Z';

describe('reconstruction diagnostic summaries explain each actual candidate outcome', () => {
  it('requires a linked final fixture for placement success and reports unlinked output separately', () => {
    const r = report();
    Object.assign(r.review.candidates[0], { status: 'placed', fixtureId: 'fixture-sink' });
    r.fixtures = [{ id: 'fixture-sink' }, { id: 'orphan' }] as ReconstructionLabReport['fixtures'];
    const summary = buildDiagnosticSummary(r);
    expect(summary.runId).toBe('run-1');
    expect(summary.outcomeCounts).toEqual({ placed: 1, held: 0, excluded: 0, traceGaps: 0 });
    expect(summary.candidates[0]).toMatchObject({
      candidateId: 'sink',
      outcome: 'placed',
      fixtureId: 'fixture-sink',
    });
    expect(summary.candidates[0].firstBlock).toBeUndefined();
    expect(summary.commonBlockers).toEqual([]);
    expect(summary.unlinkedFixtureIds).toEqual(['orphan']);
  });

  it('retains the recorded placement hold instead of blaming a known mounting method', () => {
    const r = pipelineReport();
    r.pipeline!.placements = [
      {
        candidateId: 'sink',
        status: 'held',
        reasons: ['source camera unknown'],
        provenance: { position: 'geometry', dimensions: 'default' },
      },
    ];
    const summary = buildDiagnosticSummary(r);
    expect(summary.outcomeCounts.held).toBe(1);
    expect(summary.candidates[0].firstBlock).toMatchObject({
      stage: 'placement',
      code: 'placement.held',
      reasons: expect.arrayContaining(['source camera unknown']),
      evidencePaths: ['pipeline.placements'],
    });
    expect(summary.camera).toMatchObject({ status: 'held', reasons: ['원사진 카메라 미확정'] });
    expect(summary.executionLabel).toContain('전체 배치 확인 필요');
  });

  it('identifies an original candidate lost downstream without inventing an exclusion reason', () => {
    const r = report();
    r.review.candidates = [];
    const summary = buildDiagnosticSummary(r);
    expect(summary.outcomeCounts.traceGaps).toBe(1);
    expect(summary.candidates[0].firstBlock).toMatchObject({
      stage: 'resolution',
      code: 'resolution.missing-output',
    });
    expect(summary.candidates[0].firstBlock!.reasons.join()).toContain('원인이 기록되지 않아');
    expect(summary.originCounts.model).toBe(1);
  });

  it('distinguishes explicit mirror reflection exclusion from missing observations and placement failure', () => {
    const r = pipelineReport();
    r.pipeline!.resolution.entries[0] = {
      candidateId: 'sink',
      disposition: 'reflection',
      representativeId: 'mirror',
      relatedIds: ['mirror'],
      reasons: ['recorded mirror relationship'],
    };
    r.review.candidates[0].status = 'ignored';
    const summary = buildDiagnosticSummary(r);
    expect(summary.outcomeCounts).toEqual({ placed: 0, held: 0, excluded: 1, traceGaps: 0 });
    expect(summary.candidates[0].firstBlock).toMatchObject({
      code: 'resolution.excluded',
      output: { disposition: 'reflection', representativeId: 'mirror', relatedIds: ['mirror'] },
      reasons: ['recorded mirror relationship'],
    });
    expect(summary.executionLabel).toContain('관측 후보 전부 배치 대상에서 제외됨');
  });

  it('groups blockers while keeping every candidate ID and the original observations immutable', () => {
    const r = report([candidate('a'), candidate('b')]);
    r.review.candidates = [];
    const before = structuredClone(r);
    const summary = buildDiagnosticSummary(r);
    expect(summary.commonBlockers).toHaveLength(1);
    expect(summary.commonBlockers[0].candidateIds).toEqual(['a', 'b']);
    expect(summary.candidates.map((item) => item.tracePath)).toEqual([
      'candidateTraces[0]',
      'candidateTraces[1]',
    ]);
    const output = summary.candidates[0].firstBlock!.input!;
    output.kind = 'toilet';
    expect(r).toEqual(before);
  });

  it('separates user additions and legacy records from actual raw model observations', () => {
    const r = report([candidate('model'), { ...candidate('user'), source: 'user' }]);
    r.review.candidates.push(candidate('legacy'));
    expect(buildDiagnosticSummary(r).originCounts).toEqual({ model: 1, user: 1, legacy: 1 });
  });

  it('does not label an empty automatic result as successful photo reproduction', () => {
    const summary = buildDiagnosticSummary(report([]));
    expect(summary.executionLabel).toContain('원출력 후보 없음');
    expect(summary.candidates).toEqual([]);
    expect(summary.limitations.join()).toContain('사람이 대조');
  });
});

describe('per-run journals retain failures and stage timing without sharing state', () => {
  it('records completed phase durations and the failed phase duration with a monotonic clock', () => {
    let now = 100;
    const journal = createDiagnosticRun('timed', 'candidate', input, startedAt, () => now);
    now = 110;
    journal.phase('baseline');
    now = 130;
    journal.checkpoint('rawCandidates', [{ id: 'sink', mounting: 'wall' }]);
    now = 140;
    journal.progress('후보 1개');
    now = 150;
    journal.phase('placement');
    now = 170;
    const failure = new Error('지원점 미확정');
    failure.name = 'PlacementError';
    const log = journal.finish('failed', failure);
    expect(log).toMatchObject({
      runId: 'timed',
      engine: 'candidate',
      startedAt,
      status: 'failed',
      lastPhase: 'placement',
      elapsedMs: 70,
      error: { name: 'PlacementError', message: '지원점 미확정' },
    });
    expect(
      log.events
        .filter((event) => event.event === 'phase-end')
        .map((event) => [event.phase, event.durationMs]),
    ).toEqual([
      ['input', 10],
      ['baseline', 40],
    ]);
    expect(log.events.at(-1)).toMatchObject({
      event: 'failed',
      phase: 'placement',
      durationMs: 20,
      elapsedMs: 70,
    });
    expect(log.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(log.checkpoints.rawCandidates).toEqual([{ id: 'sink', mounting: 'wall' }]);
  });

  it('keeps partial checkpoints and structured model validation evidence on failure', () => {
    const journal = createDiagnosticRun('partial', 'candidate', input, startedAt, () => 0);
    journal.phase('candidate-model');
    journal.checkpoint('baselineReview', { candidates: [{ id: 'raw-sink' }] });
    journal.checkpoint('modelResponse', { rawText: '{"candidate":', validationErrors: ['invalid JSON'] });
    const original = Object.assign(new Error('응답 파싱 실패'), {
      name: 'ModelResponseError',
      diagnostics: { validation: ['expected closing brace'], apiKey: 'must-not-export' },
    });
    const wrapped = new ReconstructionDiagnosticError(original, journal.finish('failed', original));
    expect(wrapped.name).toBe('ModelResponseError');
    expect(wrapped.cause).toBe(original);
    expect(wrapped.diagnostics).toMatchObject({
      validation: ['expected closing brace'],
      runLog: {
        status: 'failed',
        lastPhase: 'candidate-model',
        checkpoints: {
          baselineReview: { candidates: [{ id: 'raw-sink' }] },
          modelResponse: { validationErrors: ['invalid JSON'] },
        },
      },
    });
    expect(JSON.stringify(wrapped.diagnostics)).not.toContain('must-not-export');
  });

  it('preserves cancellation identity and the last completed evidence', () => {
    const journal = createDiagnosticRun('cancel', 'baseline', input, startedAt, () => 0);
    journal.checkpoint('inputDimensions', { width: 960, height: 1280 });
    const abort = new Error('사용자 취소');
    abort.name = 'AbortError';
    const wrapped = new ReconstructionDiagnosticError(abort, journal.finish('cancelled', abort));
    expect(wrapped.name).toBe('AbortError');
    expect(wrapped.diagnostics.runLog).toMatchObject({
      status: 'cancelled',
      error: { name: 'AbortError' },
      checkpoints: { inputDimensions: { width: 960, height: 1280 } },
    });
  });

  it('uses explicit final report paths only after success while keeping other evidence', () => {
    const journal = createDiagnosticRun('success', 'candidate', input, startedAt, () => 0);
    for (const key of ['baselineReview', 'rawSegmentationCandidates', 'modelResponse', 'candidatePipeline'])
      journal.checkpoint(key, { payload: key });
    journal.checkpoint('dimensions', { width: 447, height: 447 });
    expect(journal.finish('complete').checkpoints).toEqual({
      baselineReview: { reportPath: 'rawReview' },
      rawSegmentationCandidates: { reportPath: 'rawSegmentationCandidates' },
      modelResponse: { reportPath: 'pipeline.model' },
      candidatePipeline: { reportPath: 'pipeline' },
      dimensions: { width: 447, height: 447 },
    });
  });

  it('isolates retries and snapshots so later mutations cannot rewrite a previous failure', () => {
    const first = createDiagnosticRun('first', 'baseline', input, startedAt, () => 0);
    const evidence = { candidates: [{ id: 'a' }] };
    first.checkpoint('observation', evidence);
    evidence.candidates[0].id = 'mutated';
    const log = first.finish('failed', new Error('first failed'));
    const second = createDiagnosticRun('retry', 'baseline', input, startedAt, () => 0);
    second.checkpoint('observation', { candidates: [{ id: 'b' }] });
    second.progress('second only');
    const retryLog = second.finish('complete');
    expect(log.checkpoints.observation).toEqual({ candidates: [{ id: 'a' }] });
    expect(JSON.stringify(log)).not.toContain('second only');
    expect(retryLog.runId).toBe('retry');
    expect(retryLog.events[0].sequence).toBe(1);
    expect(retryLog.error).toBeUndefined();
  });

  it('bounds verbose progress, reports omissions, and retains the first and terminal events', () => {
    const journal = createDiagnosticRun('verbose', 'baseline', input, startedAt, () => 0);
    for (let index = 0; index < 1000; index++) journal.progress('progress ' + index);
    const log = journal.finish('failed', new Error('terminal failure'));
    expect(log.events).toHaveLength(600);
    expect(log.omittedEvents).toBe(402);
    expect(log.events[0]).toMatchObject({ sequence: 1, event: 'phase-start' });
    expect(log.events.at(-1)).toMatchObject({ sequence: 1002, event: 'failed', message: 'terminal failure' });
    expect(log.events.map((event) => event.sequence)).toEqual(
      [...log.events.map((event) => event.sequence)].sort((a, b) => a - b),
    );
  });
});

describe('diagnostic export excludes images and credentials while retaining useful evidence', () => {
  it('recursively removes credential fields and image or binary payloads without changing safe data', () => {
    const value = {
      Authorization: 'secret-auth',
      cookie: 'secret-cookie',
      nested: {
        api_key: 'secret-api',
        accessToken: 'secret-access',
        refresh_token: 'secret-refresh',
        password: 'secret-password',
        secret: 'secret-value',
        bbox: { left: 0.2 },
        observation: '벽걸이 세면대',
      },
      images: [
        'data:image/png;base64,cGhvdG9ieXRlcw==',
        'blob:http://localhost/private',
        new Uint8Array([7, 8]),
        new ArrayBuffer(2),
        new Blob(['photo']),
      ],
    };
    const output = diagnosticValue(value);
    const serialized = JSON.stringify(output);
    expect(serialized).not.toMatch(/secret-|cGhvdG9ieXRlcw==|blob:http/);
    expect(output).toMatchObject({
      nested: { bbox: { left: 0.2 }, observation: '벽걸이 세면대' },
      images: [
        '[이미지 본문/임시 URL 제외]',
        '[이미지 본문/임시 URL 제외]',
        '[바이너리 제외]',
        '[바이너리 제외]',
        '[바이너리 제외]',
      ],
    });
    expect(value.Authorization).toBe('secret-auth');
  });

  it('redacts tokens embedded in progress and exception text, not only object keys', () => {
    const journal = createDiagnosticRun('redacted', 'candidate', input, startedAt, () => 0);
    journal.progress(
      'download https://example.invalid/model?token=private-token&stage=1 Authorization: Bearer private-bearer',
    );
    const error = new Error(
      'request https://example.invalid/?api_key=private-key&password=private-password failed',
    );
    const log = journal.finish('failed', error);
    const serialized = JSON.stringify(log);
    expect(serialized).not.toMatch(/private-token|private-bearer|private-key|private-password/);
    expect(serialized).toContain('stage=1');
    expect(serialized).toContain('failed');
  });

  it('marks truncation and invalid numbers explicitly instead of silently dropping evidence', () => {
    const output = diagnosticValue({
      long: 'a'.repeat(33000),
      candidates: Array.from({ length: 1002 }, (_, index) => index),
      invalid: NaN,
    }) as { long: string; candidates: unknown[]; invalid: string };
    expect(output.long).toContain('[긴 값 생략]');
    expect(output.candidates).toHaveLength(1001);
    expect(output.candidates.at(-1)).toBe('[2개 생략]');
    expect(output.invalid).toBe('[유효하지 않은 숫자]');
  });
});
