import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCloudRepositories, CloudRequestError } from '../src/lib/repositories/cloud';
import type { MaterialVersion } from '../src/lib/types';
vi.mock('../src/lib/storage/cloud-asset-cache', () => ({
  cacheCloudAsset: vi.fn(),
  readCachedCloudAsset: vi.fn(),
  invalidateCachedCloudAsset: vi.fn(),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('cloud request identity and retries', () => {
  it('attaches expected account and bounded request signal without making it an authentication token', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json([]));
    vi.stubGlobal('fetch', fetcher);
    await createCloudRepositories('d1', 'user-a').projects.list();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('/api/d1/projects');
    expect(init.headers['X-SJN-User-Id']).toBe('user-a');
    expect(init.credentials).toBe('same-origin');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it('uses distinct successful setActive intents for true → false → true', async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    const repository = createCloudRepositories('d1', 'user-a');
    await repository.materials.setActive('material-a', true);
    await repository.materials.setActive('material-a', false);
    await repository.materials.setActive('material-a', true);
    expect(new Set(fetcher.mock.calls.map((call) => call[1].headers['X-Idempotency-Key'])).size).toBe(3);
  });
  it('reuses one uncertain operation until confirmation then allocates a new intent', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('connection lost after commit'))
      .mockImplementation(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    const repository = createCloudRepositories('d1', 'user-a');
    await expect(repository.materials.setActive('material-a', true)).rejects.toThrow('connection lost');
    await repository.materials.setActive('material-a', true);
    await repository.materials.setActive('material-a', true);
    const keys = fetcher.mock.calls.map((call) => call[1].headers['X-Idempotency-Key']);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
    expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
  });
  it('abandons an uncertain toggle once a later opposite intent intervenes', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('lost response'))
      .mockImplementation(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    const repository = createCloudRepositories('d1', 'a');
    await expect(repository.materials.setActive('m', true)).rejects.toThrow();
    await repository.materials.setActive('m', false);
    await repository.materials.setActive('m', true);
    expect(fetcher.mock.calls[0][1].headers['X-Idempotency-Key']).not.toBe(
      fetcher.mock.calls[2][1].headers['X-Idempotency-Key'],
    );
  });
  it('keeps account namespaces separate even for the same operation', async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json([]));
    vi.stubGlobal('fetch', fetcher);
    await createCloudRepositories('d1', 'a').projects.list();
    await createCloudRepositories('d1', 'b').projects.list();
    expect(fetcher.mock.calls[0][1].headers['X-Idempotency-Key']).not.toBe(
      fetcher.mock.calls[1][1].headers['X-Idempotency-Key'],
    );
  });
  it('does not serve retained material metadata after permission denial', async () => {
    const version = { id: 'version' } as MaterialVersion;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(version))
      .mockResolvedValueOnce(Response.json({ error: '권한 없음' }, { status: 403 }));
    vi.stubGlobal('fetch', fetcher);
    const repository = createCloudRepositories('d1', 'a');
    expect(await repository.materials.getVersion('version')).toEqual(version);
    await expect(repository.materials.getVersion('version')).rejects.toBeInstanceOf(CloudRequestError);
  });
});
