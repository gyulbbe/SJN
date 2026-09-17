import 'fake-indexeddb/auto';
import { IDBObjectStore } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeProjectDocument } from '../src/lib/comparison';
import { DEFAULT_COLOR, EMPTY_MASK } from '../src/lib/types';
import {
  createRecoveryStore,
  inspectRecovery,
  projectContentKey,
  recoveryKey,
  registerStorageTransitionGuard,
  registerAccountChangeCheckpoint,
  checkpointBeforeAccountChange,
  flushBeforeStorageTransition,
  type RecoveryScope,
} from '../src/lib/storage/recovery';

const user = crypto.randomUUID(),
  projectId = crypto.randomUUID();
const scope: RecoveryScope = { origin: 'https://example.test', backend: 'd1', userId: user, projectId };
function project() {
  return normalizeProjectDocument({
    id: projectId,
    ownerId: user,
    name: '복구 테스트',
    schemaVersion: 2,
    storageRevision: 3,
    editRevision: 0,
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    history: { past: [], future: [] },
    scene: {
      originalAssetId: crypto.randomUUID(),
      previewAssetId: crypto.randomUUID(),
      imageWidth: 800,
      imageHeight: 600,
      surfaces: [],
      fixtures: [],
      color: { ...DEFAULT_COLOR },
      protection: EMPTY_MASK(),
    },
  });
}
const stores: ReturnType<typeof createRecoveryStore>[] = [];
function store() {
  const value = createRecoveryStore('recovery-test-' + crypto.randomUUID());
  stores.push(value);
  return value;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map((value) => value.close()));
});

describe('account-scoped cloud project recovery', () => {
  it('isolates backend, account, project and origin, without modifying the local project database', async () => {
    const db = store(),
      document = project();
    await db.write(scope, document, {});
    expect((await db.read(scope))?.document).toEqual(document);
    for (const other of [
      { ...scope, origin: 'https://other.test' },
      { ...scope, userId: crypto.randomUUID() },
      { ...scope, projectId: crypto.randomUUID() },
    ])
      expect(await db.read(other)).toBeUndefined();
    expect(() => recoveryKey({ ...scope, userId: '' })).toThrow('로그인');
    expect(() => recoveryKey({ ...scope, backend: 'supabase' as 'd1' })).toThrow('로그인');
    await expect(db.write({ ...scope, userId: 'other' }, document, {})).rejects.toThrow('현재 계정');
  });
  it('captures deeply independent histories, room backup and asset references before awaiting IndexedDB', async () => {
    const db = store(),
      document = project();
    document.designs[0].history.past.push({ scene: structuredClone(document.designs[0].scene) });
    document.shared.beforeHistory.past.push({ baseline: structuredClone(document.shared.baseline) });
    document.roomHistory.past = {
      shared: structuredClone(document.shared),
      designs: structuredClone(document.designs),
      activeDesignId: document.activeDesignId,
      comparisonDesignIds: [],
      viewport: structuredClone(document.viewport),
    };
    const expected = structuredClone(document);
    const pending = db.write(scope, document, {});
    document.designs[0].history.past[0].scene.color.exposure = 1;
    document.roomHistory.past.shared.baseline.color.contrast = 0.4;
    await pending;
    const restored = (await db.read(scope))!.document;
    expect(restored).toEqual(expected);
    expect(restored.shared.baseline.originalAssetId).toBe(expected.shared.baseline.originalAssetId);
  });
  it('retains the previous committed draft when a new write exceeds quota', async () => {
    const db = store(),
      document = project();
    await db.write(scope, document, {});
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('device storage full', 'QuotaExceededError');
    });
    const next = structuredClone(document);
    next.editRevision++;
    next.name = 'unsaved';
    await expect(db.write(scope, next, {})).rejects.toMatchObject({ name: 'QuotaExceededError' });
    put.mockRestore();
    expect((await db.read(scope))!.document).toEqual(document);
    expect(next.name).toBe('unsaved');
  });
  it('retains the live draft when there is no capacity to archive a conflict', async () => {
    const db = store(),
      document = project();
    await db.write(scope, document, {});
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('archive is full', 'QuotaExceededError');
    });
    await expect(db.archive(scope, 'conflict')).rejects.toMatchObject({ name: 'QuotaExceededError' });
    put.mockRestore();
    expect((await db.read(scope))!.document).toEqual(document);
    expect(await db.archives(scope)).toEqual([]);
  });
  it('does not erase newer edits when the older server save finishes', async () => {
    const db = store(),
      first = project(),
      next = structuredClone(first);
    await db.write(scope, first, {});
    next.editRevision++;
    next.designs[0].scene.color.exposure = 0.6;
    await db.write(scope, next, {});
    const saved = { ...first, storageRevision: 4 };
    await db.acknowledge(scope, first, saved);
    const retained = (await db.read(scope))!;
    expect(retained.baseStorageRevision).toBe(4);
    expect(retained.document.storageRevision).toBe(4);
    expect(retained.document.designs[0].scene.color.exposure).toBe(0.6);
    await db.acknowledge(scope, first, saved);
    expect((await db.read(scope))!.document).toEqual(retained.document);
    await db.acknowledge(scope, retained.document, { ...retained.document, storageRevision: 5 });
    expect(await db.read(scope)).toBeUndefined();
  });
  it('detects changed server revisions and archives both content and base revision without overwriting server', async () => {
    const db = store(),
      server = project(),
      draft = structuredClone(server);
    draft.editRevision++;
    draft.name = '기기 편집';
    const recovery = await db.write(scope, draft, {});
    expect(inspectRecovery(recovery, server)).toBe('recoverable');
    const changedServer = { ...server, name: '다른 탭 편집', storageRevision: 4 };
    expect(inspectRecovery(recovery, changedServer)).toBe('conflict');
    await db.archive(scope, 'conflict');
    expect(await db.read(scope)).toBeUndefined();
    const archived = await db.archives(scope);
    expect(archived).toHaveLength(1);
    expect(archived[0].document).toEqual(draft);
    expect(changedServer.name).toBe('다른 탭 편집');
    expect(await db.archives({ ...scope, userId: 'other' })).toEqual([]);
  });
  it('recognizes a saved document despite bookkeeping and object key order changes, while keeping viewport changes', async () => {
    const db = store(),
      original = project();
    const recovery = await db.write(scope, original, {});
    const saved = { ...original, storageRevision: 4, updatedAt: 'new timestamp' };
    saved.viewport = { pan: { y: 0, x: 0 }, zoom: 1 };
    expect(inspectRecovery(recovery, saved)).toBe('identical');
    saved.viewport.zoom = 2;
    expect(projectContentKey(original)).not.toBe(projectContentKey(saved));
  });
  it('checkpoints an unexpected account change without using cloud flush guards and propagates quota failure', async () => {
    const cloudSaveGuard = vi.fn(async () => true);
    const unregisterGuard = registerStorageTransitionGuard(cloudSaveGuard);
    const retain = vi.fn(async (): Promise<void> => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const clearPrivateMemory = vi.fn(async () => {});
    const unregisterRetain = registerAccountChangeCheckpoint(retain);
    const unregisterClear = registerAccountChangeCheckpoint(clearPrivateMemory);
    try {
      await expect(checkpointBeforeAccountChange()).rejects.toMatchObject({ name: 'QuotaExceededError' });
      expect(clearPrivateMemory).not.toHaveBeenCalled();
      expect(cloudSaveGuard).not.toHaveBeenCalled();
      retain.mockResolvedValue(undefined);
      await Promise.all([checkpointBeforeAccountChange(), checkpointBeforeAccountChange()]);
      expect(retain).toHaveBeenCalledTimes(2);
      expect(clearPrivateMemory).toHaveBeenCalledTimes(1);
      expect(cloudSaveGuard).not.toHaveBeenCalled();
    } finally {
      unregisterGuard();
      unregisterRetain();
      unregisterClear();
    }
  });
  it('blocks a storage/account transition until every registered editor has retained its unsaved work', async () => {
    const first = vi.fn(async () => false),
      next = vi.fn(async () => true);
    const removeFirst = registerStorageTransitionGuard(first),
      removeNext = registerStorageTransitionGuard(next);
    expect(await flushBeforeStorageTransition()).toBe(false);
    expect(next).not.toHaveBeenCalled();
    first.mockResolvedValue(true);
    expect(await flushBeforeStorageTransition()).toBe(true);
    removeFirst();
    removeNext();
    expect(await flushBeforeStorageTransition()).toBe(true);
  });
});
