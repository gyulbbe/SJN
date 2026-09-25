import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_REMOVAL_LOAD,
  backgroundRemovalLoadEvent,
  createModelLoadTracker,
  DEEPLAB_LOAD,
  formatMegabytes,
  formatPercent,
  MOGE_LOAD,
  mogeLoadEvent,
  modelProgressLabel,
  modelProgressValueText,
  PRODUCT3D_LOAD,
  product3dLoadEvent,
  type ModelLoadSpec,
} from '../src/lib/ai-progress';
import { PRODUCT3D_FILES } from '../src/lib/product3d/model';

const spec: ModelLoadSpec = {
  steps: [
    { key: 'runtime', weight: 10 },
    { key: 'download', weight: 80, bytes: 1000 },
    { key: 'initialize', weight: 10 },
  ],
};
function clock(start = 0) {
  let time = start;
  return { now: () => time, advance: (ms: number) => (time += ms) };
}

describe('createModelLoadTracker', () => {
  it('weights steps, uses byte ratios and completes at 100', () => {
    const c = clock();
    const tracker = createModelLoadTracker(spec, c.now);
    expect(tracker.update({ phase: 'runtime' })!.percent).toBe(0);
    c.advance(200);
    const half = tracker.update({ phase: 'download', loaded: 500, total: 1000 })!;
    expect(half.percent).toBeCloseTo(10 + 40);
    expect(half.estimated).toBe(false);
    expect(half.loadedBytes).toBe(500);
    expect(half.totalBytes).toBe(1000);
    c.advance(200);
    expect(tracker.update({ phase: 'initialize' })!.percent).toBeCloseTo(90);
    const done = tracker.update({ phase: 'ready' })!;
    expect(done.percent).toBe(100);
    expect(done.done).toBe(true);
    expect(tracker.update({ phase: 'download', loaded: 1, total: 1000 })).toBeUndefined();
  });

  it('never goes backwards and stays at most 99 before completion', () => {
    const c = clock();
    const tracker = createModelLoadTracker(spec, c.now);
    tracker.update({ phase: 'download', loaded: 900, total: 1000 });
    c.advance(200);
    // An out-of-order earlier step or smaller byte count cannot lower the value.
    expect(
      tracker.update({ phase: 'runtime' })?.percent ?? tracker.snapshot().percent,
    ).toBeGreaterThanOrEqual(82);
    c.advance(200);
    const late = tracker.update({ phase: 'download', loaded: 100, total: 1000 });
    expect((late ?? tracker.snapshot()).percent).toBeGreaterThanOrEqual(82);
    c.advance(200);
    tracker.update({ phase: 'initialize' });
    c.advance(10 * 60_000);
    expect(tracker.tick()?.percent ?? tracker.snapshot().percent).toBeLessThanOrEqual(99);
    expect(tracker.complete().percent).toBe(100);
  });

  it('moves silent steps by elapsed time and marks them as estimates', () => {
    const c = clock();
    const tracker = createModelLoadTracker(spec, c.now);
    const start = tracker.update({ phase: 'runtime' })!;
    expect(start.estimated).toBe(true);
    c.advance(4000);
    const later = tracker.tick()!;
    expect(later.percent).toBeGreaterThan(start.percent!);
    // Creep never fills the whole step by time alone.
    c.advance(60 * 60_000);
    expect(tracker.tick()?.percent ?? tracker.snapshot().percent).toBeLessThan(10);
  });

  it('shows bytes without a percentage when the size is unknown', () => {
    const tracker = createModelLoadTracker({ steps: [{ key: 'download', weight: 1 }] }, clock().now);
    const snapshot = tracker.update({ phase: 'download', loaded: 3 * 1_048_576 })!;
    expect(snapshot.percent).toBeNull();
    expect(snapshot.loadedBytes).toBe(3 * 1_048_576);
    expect(modelProgressValueText('모델', snapshot)).toBe('모델 진행 중, 3.0MB 받음');
  });

  it('fills a cache hit quickly and reports its source', () => {
    const c = clock();
    const tracker = createModelLoadTracker(MOGE_LOAD, c.now);
    tracker.update(mogeLoadEvent({ stage: 'checking', message: '확인' }));
    c.advance(200);
    // Cache hit: no download events, straight to verification.
    const verified = tracker.update(
      mogeLoadEvent({ stage: 'verifying', message: '검증', cacheSource: 'cache' }),
    )!;
    expect(verified.percent).toBeCloseTo(83);
    expect(verified.source).toBe('cache');
  });

  it('continues after a fallback restart instead of returning to zero', () => {
    const c = clock();
    const tracker = createModelLoadTracker(spec, c.now);
    tracker.update({ phase: 'download', loaded: 1000, total: 1000 });
    c.advance(200);
    tracker.update({ phase: 'initialize' });
    c.advance(200);
    const retry = tracker.update({ phase: 'runtime', retry: true, message: 'CPU로 다시 준비' })!;
    expect(retry.retrying).toBe(true);
    expect(retry.percent).toBeGreaterThanOrEqual(90);
    c.advance(200);
    const again = tracker.update({ phase: 'download', loaded: 500, total: 1000 })!;
    // About 90 (plus a little time creep) + (10 + 40)% of the remaining span.
    expect(again.percent).toBeCloseTo(95, 0);
    expect(again.retrying).toBe(true);
  });

  it('throttles redraws to 100 ms or 1 percentage point', () => {
    const c = clock();
    const tracker = createModelLoadTracker(spec, c.now);
    tracker.update({ phase: 'download', loaded: 0, total: 1000 });
    c.advance(10);
    expect(tracker.update({ phase: 'download', loaded: 5, total: 1000 })).toBeUndefined();
    c.advance(10);
    expect(tracker.update({ phase: 'download', loaded: 20, total: 1000 })).toBeDefined();
    c.advance(120);
    expect(tracker.update({ phase: 'download', loaded: 21, total: 1000 })).toBeDefined();
  });

  it('splits multi-part models by file size', () => {
    const c = clock();
    const tracker = createModelLoadTracker(PRODUCT3D_LOAD, c.now);
    tracker.update({ phase: 'runtime' });
    c.advance(200);
    const encoder = PRODUCT3D_FILES.encoder.bytes;
    tracker.update({ phase: 'download', part: 'encoder', loaded: encoder, total: encoder });
    c.advance(200);
    const total = Object.values(PRODUCT3D_FILES).reduce((sum, file) => sum + file.bytes, 0);
    const afterEncoder = tracker.update({ phase: 'initialize', part: 'encoder' })!;
    expect(afterEncoder.percent).toBeCloseTo(1 + 3 + (90 * encoder) / total, 0);
    c.advance(200);
    const backbone = tracker.update({ phase: 'download', part: 'backbone', loaded: 0 })!;
    expect(backbone.totalBytes).toBe(PRODUCT3D_FILES.backbone.bytes);
  });
});

describe('adapters', () => {
  it('maps background removal stages and keeps cache/retry details', () => {
    expect(backgroundRemovalLoadEvent({ stage: 'loading-runtime', message: 'm' }).phase).toBe('runtime');
    expect(
      backgroundRemovalLoadEvent({
        stage: 'download',
        message: 'm',
        loadedBytes: 1,
        totalBytes: 2,
        source: 'cache',
      }),
    ).toMatchObject({ phase: 'download', loaded: 1, total: 2, source: 'cache' });
    expect(backgroundRemovalLoadEvent({ stage: 'download', message: 'm', loadedBytes: 1 }).source).toBe(
      'network',
    );
    expect(backgroundRemovalLoadEvent({ stage: 'initializing', message: 'm', retry: true }).retry).toBe(true);
    expect(backgroundRemovalLoadEvent({ stage: 'processing', message: 'm' }).phase).toBe('ready');
  });

  it('keeps product 3D loading open between inference steps until the last model', () => {
    expect(product3dLoadEvent({ stage: 'encoding', message: 'm' })).toBeUndefined();
    expect(product3dLoadEvent({ stage: 'reconstructing', message: 'm' })).toBeUndefined();
    expect(product3dLoadEvent({ stage: 'initializing', message: 'm', part: 'decoder' })).toMatchObject({
      phase: 'initialize',
      part: 'decoder',
    });
    expect(product3dLoadEvent({ stage: 'geometry', message: 'm', completed: 1, total: 4 })?.phase).toBe(
      'ready',
    );
  });

  it('maps MoGe stages and the DeepLab spec covers the bundled bytes', () => {
    expect(mogeLoadEvent({ stage: 'downloading', message: 'm', loaded: 5, total: 10 })).toMatchObject({
      phase: 'download',
      loaded: 5,
      total: 10,
    });
    expect(mogeLoadEvent({ stage: 'loading-runtime', message: 'm' }).phase).toBe('runtime');
    expect(mogeLoadEvent({ stage: 'inference', message: 'm' }).phase).toBe('ready');
    expect(DEEPLAB_LOAD.steps.find((step) => step.key === 'download')?.bytes).toBeGreaterThan(2_000_000);
    expect(BACKGROUND_REMOVAL_LOAD.steps.reduce((sum, step) => sum + step.weight, 0)).toBe(100);
  });
});

describe('labels', () => {
  it('formats sizes, percentages and sequence labels', () => {
    expect(formatMegabytes(63.2 * 1_048_576)).toBe('63.2');
    expect(formatPercent(45.9)).toBe('45%');
    const snapshot = createModelLoadTracker(spec, clock().now).update({
      phase: 'download',
      loaded: 500,
      total: 1000,
    })!;
    expect(modelProgressLabel({ index: 1, count: 2 }, snapshot)).toBe('AI 모델 준비 1/2 · 50%');
    expect(modelProgressLabel(undefined, snapshot)).toBe('AI 모델 준비 · 50%');
    expect(modelProgressValueText('MoGe 모델', snapshot)).toBe('MoGe 모델 50%, 0.0MB 중 0.0MB');
  });
});
