import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOGE_ARTIFACT, MOGE_NUM_TOKENS, MOGE_PREPROCESS_VERSION, MOGE_RUNTIME_VERSION } from '../src/lib/reconstruction/moge-browser/artifact';
import { MOGE_POSTPROCESS_VERSION } from '../src/lib/reconstruction/moge-browser/postprocess';
import { MOGE_PLANES_VERSION } from '../src/lib/reconstruction/moge-browser/planes';
import type { MogeBrowserResult } from '../src/lib/reconstruction/moge-browser/protocol';
import { parseFixtureInventory } from '../src/lib/reconstruction/inventory-observation';
const mocks = vi.hoisted(() => ({ run: vi.fn(), dispose: vi.fn() }));
vi.mock('../src/lib/reconstruction/moge-browser/client', () => ({ MogeBrowserClient: class { run = mocks.run; dispose = mocks.dispose; } }));
let bridge: typeof import('../src/lib/reconstruction/geometry-browser-client');
const photo = () => new Blob(['authored photo bytes; not actual model verification'], { type: 'image/png' });
const segmentation = () => ({ width: 8, height: 8, floor: new Uint8Array(64), wall: new Uint8Array(64) });
const understanding = () => parseFixtureInventory('{"items":[]}').understanding;
function result(): MogeBrowserResult {
  return {
    raw: { width: 400, height: 300, points: new Float32Array(0), normal: new Float32Array(0), mask: new Float32Array(0), metricScale: 1 },
    dense: { width: 400, height: 300, intrinsics: { fx: 0.75, fy: 1, cx: 0.5, cy: 0.5 }, diagnostics: { revision: MOGE_POSTPROCESS_VERSION } },
    planes: { floor: null, walls: [], evidence: { revision: MOGE_PLANES_VERSION } },
    backend: 'wasm', requestedMode: 'auto', cacheSource: 'cache',
    metadata: { artifact: MOGE_ARTIFACT, runtimeVersion: MOGE_RUNTIME_VERSION, preprocessVersion: MOGE_PREPROCESS_VERSION,
      sourceWidth: 400, sourceHeight: 300, inputWidth: 400, inputHeight: 300, numTokens: MOGE_NUM_TOKENS,
      precision: 'fp32', wasmThreads: 1, crossOriginIsolated: false, memoryBytes: null },
    timings: { downloadMs: 0, cacheMs: 5, initializationMs: 10, preprocessingMs: 3, inferenceMs: 100, postprocessingMs: 12, planeExtractionMs: 25, totalMs: 155 },
  } as unknown as MogeBrowserResult;
}
const run = (mask = segmentation(), signal = new AbortController().signal) => bridge.analyzeGeometryInBrowser(photo(), mask, understanding(), signal);
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 400, height: 300, close: vi.fn() })));
  mocks.run.mockImplementation(async () => result());
  bridge = await import('../src/lib/reconstruction/geometry-browser-client');
});
afterEach(() => vi.unstubAllGlobals());
describe('browser geometry bridge (authored Worker results, real cache; no inference quality claim)', () => {
  it('preserves actual model provenance and separates dense postprocessing from plane extraction', async () => {
    const analysis = await run();
    expect(analysis.observation.analysisImage).toEqual({ width: 400, height: 300 });
    expect(analysis.measurement).toMatchObject({ postprocessingMs: 12, planeExtractionMs: 25 });
    expect(mocks.dispose).toHaveBeenCalledOnce();
    await run();
    expect(mocks.run).toHaveBeenCalledOnce();
  });
  it.each([
    (value: MogeBrowserResult) => { value.metadata.sourceWidth = 401; },
    (value: MogeBrowserResult) => { value.metadata.inputHeight = 299; },
    (value: MogeBrowserResult) => { value.metadata.artifact = { ...MOGE_ARTIFACT, sha256: 'wrong' } as unknown as typeof MOGE_ARTIFACT; },
    (value: MogeBrowserResult) => { value.planes!.evidence.revision = 'old-plane-algorithm'; },
  ])('rejects wrong Worker model/photo/processing identity and does not cache it', async mutate => {
    const wrong = result(); mutate(wrong); mocks.run.mockResolvedValueOnce(wrong);
    await expect(run()).rejects.toThrow('현재 요청과 달라요');
    await run(); expect(mocks.run).toHaveBeenCalledTimes(2);
  });
  it('reuses a persisted result across module reloads but never a corrupted same-photo result', async () => {
    await run(); vi.resetModules(); bridge = await import('../src/lib/reconstruction/geometry-browser-client');
    expect((await run()).measurement.cacheHit).toBe(true);
    expect(mocks.run).toHaveBeenCalledOnce();
    const db = await openDB('sjn-browser-geometry-stages', 1);
    const key = (await db.getAllKeys('results'))[0]; const record = await db.get('results', key);
    record.analysis.observation.intrinsics.fy = 3;
    await db.put('results', record, key); db.close();
    vi.resetModules(); bridge = await import('../src/lib/reconstruction/geometry-browser-client');
    expect((await run()).measurement.cacheHit).toBe(false);
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });
  it('invalidates geometry when semantic masks change', async () => {
    await run(); const mask = segmentation(); mask.floor[0] = 1; await run(mask);
    expect(mocks.run).toHaveBeenCalledTimes(2);
  });
  it('disposes and refuses to cache a late inference completion after cancellation', async () => {
    const controller = new AbortController();
    mocks.run.mockImplementationOnce(async () => { controller.abort(); return result(); });
    await expect(run(segmentation(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.dispose).toHaveBeenCalledOnce();
    await run(); expect(mocks.run).toHaveBeenCalledTimes(2);
  });
  it('preserves results and in-memory retry when persistent storage is unavailable', async () => {
    vi.stubGlobal('indexedDB', { open() { throw new Error('QuotaExceededError'); } });
    expect((await run()).measurement.cacheWarning).toContain('저장하지 못했어요');
    expect((await run()).measurement.cacheHit).toBe(true);
    expect(mocks.run).toHaveBeenCalledOnce();
  });
});
