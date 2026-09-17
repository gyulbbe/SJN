import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DIAGNOSTIC_RETENTION,
  readDiagnosticArchive,
  saveDiagnosticArchive,
  type DiagnosticArchiveEntry,
} from '../src/lib/reconstruction/lab-diagnostic-storage';
const identity = vi.hoisted(() => ({ id: 'current-user' }));
vi.mock('../src/lib/repositories', () => ({ getRepositoryUserId: () => identity.id }));
const request = vi.fn<typeof fetch>();
const indexedDB = { open: vi.fn(), deleteDatabase: vi.fn() };
const entry = (): DiagnosticArchiveEntry => ({
  schemaVersion: 1,
  runId: crypto.randomUUID(),
  startedAt: new Date().toISOString(),
  status: 'failed',
  input: { name: '사진.jpg', bytes: 1234, mime: 'image/jpeg' },
  engine: 'cloud-browser-v1',
  failure: { error: 'model failure' },
});
beforeEach(() => {
  vi.clearAllMocks();
  identity.id = 'current-user';
  vi.stubGlobal('fetch', request);
  vi.stubGlobal('indexedDB', indexedDB);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
describe('account diagnostic archive client', () => {
  it('sends success/failure diagnostics only to the authenticated archive API', async () => {
    request.mockResolvedValueOnce(Response.json({ stored: true }));
    const value = entry();
    await expect(saveDiagnosticArchive(value)).resolves.toEqual({ stored: true });
    expect(request).toHaveBeenCalledWith(
      '/api/reconstruction/diagnostics',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-SJN-User-Id': 'current-user' },
        body: JSON.stringify(value),
      }),
    );
    expect(indexedDB.open).not.toHaveBeenCalled();
    expect(indexedDB.deleteDatabase).not.toHaveBeenCalled();
  });
  it('keeps the analysis-start account even when the active account changes before completion', async () => {
    request.mockResolvedValueOnce(Response.json({ error: '계정 변경' }, { status: 401 }));
    identity.id = 'new-user';
    await expect(saveDiagnosticArchive(entry(), 'old-user')).resolves.toEqual({
      stored: false,
      reason: '계정 변경',
    });
    expect(request.mock.calls[0][1]?.headers).toMatchObject({ 'X-SJN-User-Id': 'old-user' });
    expect(indexedDB.open).not.toHaveBeenCalled();
  });
  it('reads the current account archive with no browser fallback', async () => {
    const runs = [entry()];
    request.mockResolvedValueOnce(Response.json({ runs }));
    expect(await readDiagnosticArchive()).toEqual(runs);
    expect(request.mock.calls[0][1]?.headers).toMatchObject({ 'X-SJN-User-Id': 'current-user' });
    expect(indexedDB.open).not.toHaveBeenCalled();
  });
  it('does not upload anything without a captured account', async () => {
    identity.id = '';
    expect(await saveDiagnosticArchive(entry())).toMatchObject({
      stored: false,
      reason: expect.stringContaining('로그인'),
    });
    await expect(readDiagnosticArchive()).rejects.toThrow('로그인');
    expect(request).not.toHaveBeenCalled();
  });
  it('rejects an oversized body before sending and leaves old browser records untouched', async () => {
    const value = { ...entry(), failure: { text: 'x'.repeat(DIAGNOSTIC_RETENTION.bytes) } };
    expect(await saveDiagnosticArchive(value)).toMatchObject({
      stored: false,
      reason: expect.stringContaining('25MB'),
    });
    expect(request).not.toHaveBeenCalled();
    expect(indexedDB.deleteDatabase).not.toHaveBeenCalled();
  });
  it('retains the caller diagnostics when a server save fails and exposes the failure', async () => {
    const value = entry(),
      before = structuredClone(value);
    request.mockRejectedValueOnce(new Error('server offline'));
    expect(await saveDiagnosticArchive(value)).toEqual({ stored: false, reason: 'server offline' });
    expect(value).toEqual(before);
    expect(indexedDB.open).not.toHaveBeenCalled();
  });
});
