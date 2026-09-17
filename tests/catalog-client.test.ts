import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCatalog, saveCatalog } from '../src/lib/catalog/client';

const request = vi.fn<typeof fetch>();
const legacyStorage = {
  getItem: vi.fn(() =>
    JSON.stringify({ options: [{ id: 'browser-only-color', name: '예전 색상' }], subcategories: [] }),
  ),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', request);
  vi.stubGlobal('localStorage', legacyStorage);
});
afterEach(() => vi.unstubAllGlobals());

function expectLegacyDataUntouched() {
  for (const operation of Object.values(legacyStorage)) expect(operation).not.toHaveBeenCalled();
}

describe('catalog client uses authenticated server storage only', () => {
  it('loads registered D1 values without reading or seeding the old browser catalog', async () => {
    const registered = {
      options: [{ id: 'registered-color', name: '그레이', kind: 'color', active: true, sortOrder: 0 }],
      subcategories: [],
    };
    request.mockResolvedValueOnce(Response.json(registered));
    expect(await loadCatalog('current-member')).toEqual(registered);
    expect(request).toHaveBeenCalledWith(
      '/api/d1/catalog',
      expect.objectContaining({
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-SJN-User-Id': 'current-member' },
        body: JSON.stringify({ operation: 'list' }),
      }),
    );
    expectLegacyDataUntouched();
  });

  it('does not fall back to browser values after a server/network failure', async () => {
    request.mockRejectedValueOnce(new Error('network unavailable'));
    await expect(loadCatalog('current-member')).rejects.toThrow('network unavailable');
    expectLegacyDataUntouched();
  });

  it.each([
    ['create', { kind: 'color', name: '그레이', active: true, sortOrder: 0 }],
    ['update', { id: 'registered-color', kind: 'color', name: '회색', active: false, sortOrder: 1 }],
  ])('sends %s to D1 without writing a second local catalog', async (operation, input) => {
    request.mockResolvedValueOnce(Response.json({ ok: true }));
    await saveCatalog(input, 'administrator');
    expect(request).toHaveBeenCalledWith(
      '/api/d1/catalog',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-SJN-User-Id': 'administrator' },
        body: JSON.stringify({ operation, input }),
      }),
    );
    expectLegacyDataUntouched();
  });

  it('preserves the server authorization failure without saving locally', async () => {
    request.mockResolvedValueOnce(Response.json({ error: '관리자만 등록할 수 있어요.' }, { status: 403 }));
    await expect(saveCatalog({ kind: 'color', name: '등록 시도' }, 'ordinary-member')).rejects.toThrow(
      '관리자만 등록할 수 있어요.',
    );
    expectLegacyDataUntouched();
  });

  it('uses the server session when no expected account header is provided', async () => {
    request.mockResolvedValueOnce(Response.json({ options: [], subcategories: [] }));
    await loadCatalog();
    expect(request.mock.calls[0][1]?.headers).toEqual({ 'Content-Type': 'application/json' });
    expectLegacyDataUntouched();
  });
});
