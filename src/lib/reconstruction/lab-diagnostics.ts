import type { ReconstructionLabReport } from './lab';
import { labCandidateTraces, candidateStageLabels } from './lab-candidate-trace';
import { labExecution, labExecutionLabel } from './lab-report';

export type DiagnosticPhase =
  | 'input'
  | 'baseline'
  | 'candidate-model'
  | 'identity'
  | 'installation'
  | 'geometry'
  | 'appearance'
  | 'layout'
  | 'placement'
  | 'render';
export type DiagnosticEvent = {
  sequence: number;
  at: string;
  elapsedMs: number;
  phase: DiagnosticPhase;
  event: 'phase-start' | 'phase-end' | 'progress' | 'checkpoint' | 'complete' | 'failed' | 'cancelled';
  message: string;
  durationMs?: number;
};
export type DiagnosticRun = {
  schemaVersion: 1;
  runId: string;
  engine: string;
  startedAt: string;
  endedAt: string;
  status: 'complete' | 'failed' | 'cancelled';
  lastPhase: DiagnosticPhase;
  elapsedMs: number;
  input: { name: string; bytes: number; mime: string };
  events: DiagnosticEvent[];
  checkpoints: Record<string, unknown>;
  omittedEvents: number;
  error?: { name: string; message: string; stack?: string };
};

/** Exclude binary inputs and credentials; all truncation is explicit. */
export function diagnosticValue(value: unknown, depth = 0): unknown {
  if (depth > 16) return '[진단 깊이 제한]';
  if (typeof value === 'string') {
    if (/^data:.*;base64,/i.test(value) || value.startsWith('blob:')) return '[이미지 본문/임시 URL 제외]';
    const text = value
      .replace(/Bearer\s+[^\s\"',;]+/gi, 'Bearer [인증정보 제외]')
      .replace(
        /([?&](?:token|access_token|refresh_token|api_key|password|secret)=)[^&#\s]+/gi,
        '$1[인증정보 제외]',
      );
    return text.length > 32000 ? text.slice(0, 32000) + '\n[긴 값 생략]' : text;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : '[유효하지 않은 숫자]';
  if (value == null || typeof value === 'boolean') return value;
  if (
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    (typeof Blob !== 'undefined' && value instanceof Blob)
  )
    return '[바이너리 제외]';
  if (Array.isArray(value)) {
    const result = value.slice(0, 1000).map((entry) => diagnosticValue(entry, depth + 1));
    if (value.length > 1000) result.push('[' + (value.length - 1000) + '개 생략]');
    return result;
  }
  if (typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/^(authorization|cookie|password|secret|api[-_]?key|access[-_]?token|refresh[-_]?token)$/i.test(
              key,
            ),
        )
        .map(([key, entry]) => [key, diagnosticValue(entry, depth + 1)]),
    );
  return undefined;
}

/** Per invocation, including failures. Capture evidence before temporary resources are disposed. */
export function createDiagnosticRun(
  runId: string,
  engine: string,
  input: DiagnosticRun['input'],
  startedAt: string,
  clock: () => number = () => performance.now(),
) {
  const start = clock();
  let phase: DiagnosticPhase = 'input',
    phaseStart = start,
    sequence = 0,
    omittedEvents = 0;
  const events: DiagnosticEvent[] = [];
  const checkpoints: Record<string, unknown> = {};
  function event(kind: DiagnosticEvent['event'], message: string, durationMs?: number) {
    events.push({
      sequence: ++sequence,
      at: new Date().toISOString(),
      elapsedMs: Math.max(0, clock() - start),
      phase,
      event: kind,
      message: diagnosticValue(message) as string,
      ...(durationMs === undefined ? {} : { durationMs: Math.max(0, durationMs) }),
    });
    if (events.length > 600) {
      events.splice(1, 1);
      omittedEvents++;
    }
  }
  event('phase-start', '입력 확인 시작');
  return {
    phase(next: DiagnosticPhase) {
      if (next === phase) return;
      event('phase-end', phase + ' 단계 종료', clock() - phaseStart);
      phase = next;
      phaseStart = clock();
      event('phase-start', phase + ' 단계 시작');
    },
    progress(message: string) {
      event('progress', message);
    },
    checkpoint(name: string, value: unknown) {
      checkpoints[name] = diagnosticValue(value);
      event('checkpoint', name);
    },
    finish(status: DiagnosticRun['status'], error?: unknown): DiagnosticRun {
      const details =
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack?.slice(0, 6000) }
          : error === undefined
            ? undefined
            : { name: 'UnknownError', message: String(error) };
      event(status, details?.message ?? '실행 종료 · 배치 품질 판정은 별도 요약 참조', clock() - phaseStart);
      const evidence = structuredClone(checkpoints);
      // Completed reports already contain these records, so use explicit paths instead of tripling JSON size.
      if (status === 'complete') {
        for (const [key, reportPath] of Object.entries({
          baselineReview: 'rawReview',
          rawSegmentationCandidates: 'rawSegmentationCandidates',
          modelResponse: 'pipeline.model',
          candidatePipeline: 'pipeline',
        }))
          if (key in evidence) evidence[key] = { reportPath };
      }
      return {
        schemaVersion: 1,
        runId,
        engine,
        startedAt,
        endedAt: new Date().toISOString(),
        status,
        lastPhase: phase,
        elapsedMs: Math.max(0, clock() - start),
        input: { ...input },
        events: structuredClone(events),
        checkpoints: evidence,
        omittedEvents,
        ...(details ? { error: diagnosticValue(details) as DiagnosticRun['error'] } : {}),
      };
    },
  };
}

/** Preserve cancellation/error categories and existing model parsing diagnostics. */
export class ReconstructionDiagnosticError extends Error {
  readonly diagnostics: Record<string, unknown>;
  constructor(error: unknown, run: DiagnosticRun) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = error instanceof Error ? error.name : 'ReconstructionError';
    const previous =
      error && typeof error === 'object' && 'diagnostics' in error
        ? diagnosticValue(error.diagnostics)
        : undefined;
    this.diagnostics = { ...(previous && typeof previous === 'object' ? previous : {}), runLog: run };
  }
}

/** Derived from actual decisions. Missing evidence must never become an invented explanation. */
export function buildDiagnosticSummary(
  report: Pick<
    ReconstructionLabReport,
    'runId' | 'pipeline' | 'review' | 'fixtures' | 'rawReview' | 'rawSegmentationCandidates'
  >,
) {
  const execution = labExecution(report);
  const traces = labCandidateTraces(report);
  const candidates = traces.map((trace) => {
    const firstBlock =
      trace.outcome === 'placed'
        ? undefined
        : (trace.stages.find((stage) => ['held', 'excluded', 'missing-output'].includes(stage.status)) ??
          trace.stages.find((stage) => stage.status === 'not-recorded'));
    const applied = report.review.candidates.find((entry) => entry.id === trace.candidateId);
    return {
      candidateId: trace.candidateId,
      label: trace.label,
      origin: trace.origin,
      outcome: trace.outcome,
      fixtureId: applied?.fixtureId,
      firstBlock: firstBlock
        ? {
            stage: firstBlock.id,
            label: candidateStageLabels[firstBlock.id],
            code: firstBlock.id + '.' + firstBlock.status,
            reasons: firstBlock.reasons,
            evidencePaths: firstBlock.sources,
            input: firstBlock.input,
            output: firstBlock.output,
          }
        : undefined,
      tracePath: 'candidateTraces[' + traces.indexOf(trace) + ']',
    };
  });
  const reasons = new Map<
    string,
    { code: string; stage: string; candidateIds: string[]; reasons: string[] }
  >();
  for (const candidate of candidates) {
    const block = candidate.firstBlock;
    if (!block) continue;
    const item = reasons.get(block.code) ?? {
      code: block.code,
      stage: block.label,
      candidateIds: [],
      reasons: [],
    };
    item.candidateIds.push(candidate.candidateId);
    item.reasons = [...new Set([...item.reasons, ...block.reasons])];
    reasons.set(block.code, item);
  }
  const unlinkedFixtureIds = report.fixtures
    .filter((fixture) => !report.review.candidates.some((candidate) => candidate.fixtureId === fixture.id))
    .map((fixture) => fixture.id);
  return {
    schemaVersion: 1 as const,
    runId: report.runId,
    executionLabel: labExecutionLabel(execution),
    counts: execution.counts,
    originCounts: {
      model: traces.filter((trace) => trace.origin === 'original').length,
      user: traces.filter((trace) => trace.origin === 'user').length,
      legacy: traces.filter((trace) => trace.origin === 'legacy').length,
    },
    outcomeCounts: {
      placed: traces.filter((trace) => trace.outcome === 'placed').length,
      held: traces.filter((trace) => trace.outcome === 'held').length,
      excluded: traces.filter((trace) => trace.outcome === 'excluded').length,
      traceGaps: traces.filter((trace) => trace.outcome === 'trace-gap').length,
    },
    commonBlockers: [...reasons.values()].sort((a, b) => b.candidateIds.length - a.candidateIds.length),
    camera: report.pipeline ? diagnosticValue(report.pipeline.camera) : undefined,
    unlinkedFixtureIds,
    candidates,
    limitations: [
      '실행 종료·이미지 생성은 원사진 재현 품질 통과를 의미하지 않습니다.',
      '모델이 처음부터 관측하지 않은 실제 설비는 원본 사진과 사람이 대조해야 합니다.',
      '코드는 기록된 단계·상태를 분류하며 원인이 미기록이면 추정하지 않습니다.',
      '후보별 전체 입력·출력은 tracePath와 원래 pipeline/review에서 확인하세요.',
    ],
  };
}
