import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DIAGNOSTIC_RETENTION,
  readDiagnosticArchive,
  saveDiagnosticArchive,
  type DiagnosticArchiveEntry,
} from '../src/lib/reconstruction/lab-diagnostic-storage';
import type { ReconstructionLabReport } from '../src/lib/reconstruction/lab';

function entry(id: string, index = 0): DiagnosticArchiveEntry {
  return {
    schemaVersion: 1,
    runId: id,
    startedAt: new Date(Date.UTC(2026, 8, 14, 0, 0, index)).toISOString(),
    status: 'complete',
    input: { name: `${id}.jpg`, bytes: 1234, mime: 'image/jpeg' },
    engine: 'baseline',
    report: { runId: id, rawSegmentationCandidates: [], fixtures: [] } as unknown as ReconstructionLabReport,
  };
}

beforeEach(() => {
  // Each test gets a private IndexedDB factory; no application project database is opened.
  vi.stubGlobal('indexedDB', new IDBFactory());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('private reconstruction diagnostic archive', () => {
  it('restores successful and failed runs after module reload without retaining caller references', async () => {
    const complete = entry('success');
    const failed: DiagnosticArchiveEntry = {
      ...entry('failure', 1),
      status: 'failed',
      report: undefined,
      failure: {
        error: { name: 'ModelResponseError', message: 'invalid JSON' },
        runLog: { lastPhase: 'candidate-model', checkpoints: { observations: [{ id: 'sink' }] } },
      },
    };
    await expect(saveDiagnosticArchive(complete)).resolves.toEqual({ stored: true });
    await expect(saveDiagnosticArchive(failed)).resolves.toEqual({ stored: true });
    const expected = structuredClone([complete, failed]);
    complete.input.name = 'changed-after-save.jpg';
    failed.failure!.error = { name: 'changed-after-save' };
    vi.resetModules();
    const reloaded = await import('../src/lib/reconstruction/lab-diagnostic-storage');
    expect(await reloaded.readDiagnosticArchive()).toEqual(expected);
    const records = await reloaded.readDiagnosticArchive();
    records[0].input.name = 'changed-after-read.jpg';
    expect((await reloaded.readDiagnosticArchive())[0].input.name).toBe('success.jpg');
    expect(records.every((record) => !('byteLength' in record))).toBe(true);
  });

  it('updates the same run ID without adding another history entry or keeping a stale failure', async () => {
    const first: DiagnosticArchiveEntry = {
      ...entry('same-run'),
      status: 'failed',
      report: undefined,
      failure: { reason: 'render failed' },
    };
    await saveDiagnosticArchive(first);
    const recovered = entry('same-run');
    await expect(saveDiagnosticArchive(recovered)).resolves.toEqual({ stored: true });
    expect(await readDiagnosticArchive()).toEqual([recovered]);
  });

  it('retains exactly 20 recent runs and evicts the oldest completed record', async () => {
    expect(DIAGNOSTIC_RETENTION.runs).toBe(20);
    const entries = Array.from({ length: DIAGNOSTIC_RETENTION.runs + 1 }, (_, index) =>
      entry(`run-${index}`, index),
    );
    for (const item of entries) await expect(saveDiagnosticArchive(item)).resolves.toEqual({ stored: true });
    const archived = await readDiagnosticArchive();
    expect(archived.map((record) => record.runId)).toEqual(entries.slice(1).map((record) => record.runId));
    expect(archived).toHaveLength(20);
  });

  it('keeps a slow newly completed run even when its start time is older than the retained runs', async () => {
    for (let index = 1; index <= DIAGNOSTIC_RETENTION.runs; index++)
      await saveDiagnosticArchive(entry(`recent-${index}`, index));
    const slow = entry('slow-completed-now', 0);
    await expect(saveDiagnosticArchive(slow)).resolves.toEqual({ stored: true });
    const ids = (await readDiagnosticArchive()).map((record) => record.runId);
    expect(ids).toHaveLength(20);
    expect(ids).toContain('slow-completed-now');
    expect(ids).not.toContain('recent-1');
    expect(ids).toContain('recent-20');
  });

  it('enforces the real 25 MB UTF-8 budget rather than character count before hitting 20 runs', async () => {
    expect(DIAGNOSTIC_RETENTION.bytes).toBe(25 * 1024 * 1024);
    // Two Korean strings are smaller than the limit in JS characters but exceed it in UTF-8 bytes.
    const evidence = '한'.repeat(Math.ceil(DIAGNOSTIC_RETENTION.bytes / 6) + 1);
    const older = { ...entry('wide-old'), failure: { evidence } };
    const newer = { ...entry('wide-new', 1), failure: { evidence } };
    expect(JSON.stringify(older).length + JSON.stringify(newer).length).toBeLessThan(
      DIAGNOSTIC_RETENTION.bytes,
    );
    await expect(saveDiagnosticArchive(older)).resolves.toEqual({ stored: true });
    await expect(saveDiagnosticArchive(newer)).resolves.toEqual({ stored: true });
    const archived = await readDiagnosticArchive();
    expect(archived.map((record) => record.runId)).toEqual(['wide-new']);
    expect(archived[0].failure!.evidence).toBe(evidence);
  });

  it('rejects one oversized run with a useful reason and preserves the previous archive', async () => {
    const prior = entry('prior');
    await saveDiagnosticArchive(prior);
    const tooLarge = { ...entry('too-large', 1), failure: { text: 'x'.repeat(DIAGNOSTIC_RETENTION.bytes) } };
    await expect(saveDiagnosticArchive(tooLarge)).resolves.toEqual({
      stored: false,
      reason: expect.stringContaining('25MB'),
    });
    expect(await readDiagnosticArchive()).toEqual([prior]);
  });

  it('reports quota failure without overwriting an already saved run', async () => {
    const prior = entry('same-id');
    await saveDiagnosticArchive(prior);
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('device storage full', 'QuotaExceededError');
    });
    try {
      await expect(
        saveDiagnosticArchive({ ...prior, status: 'failed', failure: { reason: 'new failure' } }),
      ).resolves.toEqual({ stored: false, reason: 'device storage full' });
    } finally {
      put.mockRestore();
    }
    expect(await readDiagnosticArchive()).toEqual([prior]);
  });

  it('rolls back both the new record and retention deletions when the write transaction aborts', async () => {
    const previous = Array.from({ length: DIAGNOSTIC_RETENTION.runs }, (_, index) =>
      entry(`saved-${index}`, index),
    );
    for (const item of previous) await saveDiagnosticArchive(item);
    const originalDelete = IDBObjectStore.prototype.delete;
    const deletion = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (
      this: IDBObjectStore,
      key,
    ) {
      const request = originalDelete.call(this, key);
      this.transaction.abort();
      return request;
    });
    try {
      await expect(saveDiagnosticArchive(entry('abort-new', 100))).resolves.toEqual({
        stored: false,
        reason: expect.stringContaining('취소'),
      });
      expect(deletion).toHaveBeenCalledTimes(1);
    } finally {
      deletion.mockRestore();
    }
    expect(await readDiagnosticArchive()).toEqual(previous);
  });

  it('does not use a network or project repository fallback when IndexedDB is unavailable', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(saveDiagnosticArchive(entry('unavailable'))).resolves.toEqual({
      stored: false,
      reason: expect.stringContaining('IndexedDB'),
    });
    await expect(readDiagnosticArchive()).rejects.toThrow('IndexedDB');
    expect(fetch).not.toHaveBeenCalled();
  });
});
