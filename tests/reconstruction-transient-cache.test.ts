import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectDocument } from '../src/lib/types';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';
const mocked = vi.hoisted(() => ({ segment: vi.fn(), archive: vi.fn() }));
vi.mock('../src/lib/repositories', () => ({ getRepositoryUserId: () => 'analysis-member' }));
vi.mock('../src/lib/segmentation', () => ({ segmentRoom: mocked.segment }));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal('indexedDB', new IDBFactory());
  mocked.archive.mockImplementation(async () => Response.json({ stored: true }));
  vi.stubGlobal('fetch', mocked.archive);
  mocked.segment.mockResolvedValue({
    width: 2,
    height: 2,
    floor: new Uint8Array(4),
    wall: new Uint8Array(4),
    objects: [],
  });
});
afterEach(() => vi.unstubAllGlobals());
const photo = () => new Blob(['authored private photo bytes']);
function project(): ProjectDocument {
  return {
    id: 'private-project',
    shared: {
      comparison: {
        before: { fixtures: [] },
        review: { version: 2, analysis: 'manual', planes: [], candidates: [], warnings: [] },
      },
    },
  } as unknown as ProjectDocument;
}
describe('run-scoped photo cache policy', () => {
  it('never changes a reused parent signal policy while preserving cancellation', async () => {
    const { photoAnalysisSignal, analysisCacheAllowed } =
      await import('../src/lib/reconstruction/analysis-cache-policy');
    const parent = new AbortController();
    const transient = photoAnalysisSignal(parent.signal, 'transient')!;
    expect(transient).not.toBe(parent.signal);
    expect(analysisCacheAllowed(transient)).toBe(false);
    expect(analysisCacheAllowed(parent.signal)).toBe(true);
    expect(photoAnalysisSignal(parent.signal, 'persistent')).toBe(parent.signal);
    parent.abort();
    expect(transient.aborted).toBe(true);
  });
  it('does not retain or reuse transient masks while ordinary cached masks remain reusable', async () => {
    const { photoAnalysisSignal } = await import('../src/lib/reconstruction/analysis-cache-policy');
    const { segmentReconstructionCached: segment } =
      await import('../src/lib/reconstruction/segmentation-cache');
    const transient = photoAnalysisSignal(undefined, 'transient')!,
      ordinary = new AbortController().signal;
    await segment(photo(), undefined, transient);
    await segment(photo(), undefined, transient);
    expect(await indexedDB.databases()).toEqual([]);
    expect(mocked.segment).toHaveBeenCalledTimes(2);
    await segment(photo(), undefined, ordinary);
    await segment(photo(), undefined, ordinary);
    expect(mocked.segment).toHaveBeenCalledTimes(3);
    await segment(photo(), undefined, transient);
    await segment(photo(), undefined, ordinary);
    expect(mocked.segment).toHaveBeenCalledTimes(4);
  });
  it('keeps successful and failed transient diagnostics in memory without opening a database', async () => {
    const { photoAnalysisSignal } = await import('../src/lib/reconstruction/analysis-cache-policy');
    const { withProjectAnalysisDiagnostics: analyze } =
      await import('../src/lib/reconstruction/project-diagnostics');
    const transient = photoAnalysisSignal(undefined, 'transient')!;
    const file = new File([photo()], 'private-owner.jpg');
    const capture = vi.fn();
    await expect(
      analyze(file, DEFAULT_ROOM, 'browser-basic', transient, async () => project(), capture),
    ).resolves.toMatchObject({ id: 'private-project' });
    await expect(
      analyze(
        file,
        DEFAULT_ROOM,
        'browser-basic',
        transient,
        async () => {
          throw new Error('authored failure');
        },
        capture,
      ),
    ).rejects.toMatchObject({ diagnostics: { logStorage: { stored: false } } });
    expect(capture.mock.calls.map(([entry]) => entry.status)).toEqual(['complete', 'failed']);
    expect(capture.mock.calls[0][0].projectAnalysis.projectId).toBe('private-project');
    expect(capture.mock.calls[1][0].failure.logStorage.stored).toBe(false);
    expect(await indexedDB.databases()).toEqual([]);
    expect(mocked.archive).not.toHaveBeenCalled();
    await analyze(file, DEFAULT_ROOM, 'browser-basic', undefined, async () => project());
    expect(mocked.archive).toHaveBeenCalledOnce();
    expect(mocked.archive.mock.calls[0][0]).toBe('/api/reconstruction/diagnostics');
    expect(await indexedDB.databases()).toEqual([]);
  });
});
