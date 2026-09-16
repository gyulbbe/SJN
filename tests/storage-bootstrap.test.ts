import { describe, it, expect, vi } from 'vitest';
import { configuredStorage, localStatus, blockedStatus } from '../src/lib/storage/config';
import { discoverStorage } from '../src/lib/storage/bootstrap';
describe('runtime storage selection', () => {
  it.each([undefined, 'local', 'development'])(
    'forces a local environment (%s) to browser storage',
    (APP_ENV) => {
      expect(configuredStorage({ APP_ENV, STORAGE_MODE: 'd1' })).toEqual(localStatus('local_environment'));
    },
  );
  it('defaults production to D1 discovery, not a ready repository', () => {
    expect(configuredStorage({ APP_ENV: 'production' })).toMatchObject({ mode: 'd1', ready: false });
  });
  it('blocks invalid and local selectors in production', () => {
    expect(configuredStorage({ APP_ENV: 'production', STORAGE_MODE: 'local' })).toEqual(
      blockedStatus('invalid_configuration'),
    );
    expect(configuredStorage({ APP_ENV: 'production', STORAGE_MODE: 'wrong' })).toEqual(
      blockedStatus('invalid_configuration'),
    );
  });
  it('supports explicit legacy Supabase only when the new selector is absent', () => {
    expect(configuredStorage({ APP_ENV: 'production', NEXT_PUBLIC_STORAGE_MODE: 'supabase' }).mode).toBe(
      'supabase',
    );
    expect(
      configuredStorage({
        APP_ENV: 'production',
        STORAGE_MODE: 'local',
        NEXT_PUBLIC_STORAGE_MODE: 'supabase',
      }).mode,
    ).toBe('d1');
  });
  it('does not promote unready or malformed responses', async () => {
    for (const data of [
      { mode: 'd1', ready: false },
      { mode: 'oops', ready: true },
      { mode: 'd1', ready: true, reason: '__proto__' },
    ]) {
      const status = await discoverStorage({ fetcher: vi.fn().mockResolvedValue(Response.json(data)) });
      expect(status.mode).toBe('d1');
    }
  });
  it('blocks editing on server/network failure without repeated probes', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('offline'));
    expect(await discoverStorage({ fetcher })).toEqual(blockedStatus('connection_failed'));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('bounded timeout discards a late ready result even when fetch ignores abort', async () => {
    vi.useFakeTimers();
    try {
      let complete!: (value: Response) => void;
      const fetcher = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            complete = resolve;
          }),
      );
      const pending = discoverStorage({ fetcher, timeoutMs: 5000 });
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toEqual(blockedStatus('initialization_timeout'));
      complete(Response.json({ mode: 'd1', ready: true, reason: 'ready', authRequired: true }));
      await vi.runAllTimersAsync();
      expect(await pending).toEqual(blockedStatus('initialization_timeout'));
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
