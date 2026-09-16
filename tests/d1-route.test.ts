import { beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  env: {
    platform: 'cloudflare',
    APP_ENV: 'production',
    STORAGE_MODE: 'd1',
    DB: {},
    ASSET_BUCKET: {},
  } as Record<string, unknown>,
  getActor: vi.fn(),
  handle: vi.fn(),
  maintenance: vi.fn(),
  schedule: vi.fn(),
  readiness: vi.fn(),
}));
vi.mock('../src/lib/platform/runtime', () => ({
  getRuntimeEnvironment: () => boundary.env,
  continueInBackground: boundary.schedule,
}));
vi.mock('../src/lib/auth/d1', () => ({ getD1Actor: boundary.getActor }));
vi.mock('../src/lib/d1', () => ({
  handleD1Request: boundary.handle,
  runD1Maintenance: boundary.maintenance,
  checkD1Storage: boundary.readiness,
}));
import { d1Route } from '../src/lib/storage/server';

const actor = { id: 'verified-account-a', isAdmin: false };
function request(options: { user?: string; method?: string; path?: string; origin?: string } = {}) {
  return new Request('https://sjn.test/api/d1/' + (options.path ?? 'projects'), {
    method: options.method ?? 'POST',
    headers: {
      ...(options.user ? { 'X-SJN-User-Id': options.user } : {}),
      ...(options.origin ? { Origin: options.origin } : {}),
      'Content-Type': 'application/json',
    },
    ...((options.method ?? 'POST') === 'POST' ? { body: '{"operation":"list"}' } : {}),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  boundary.env = {
    platform: 'cloudflare',
    APP_ENV: 'production',
    STORAGE_MODE: 'd1',
    DB: {},
    ASSET_BUCKET: {},
  };
  boundary.getActor.mockReset().mockResolvedValue(actor);
  boundary.handle.mockReset().mockImplementation(async () => Response.json([]));
  boundary.maintenance.mockReset().mockResolvedValue(undefined);
  boundary.schedule.mockReset().mockImplementation(() => {});
});

describe('D1 route authentication and maintenance boundaries', () => {
  it('never treats the expected-account header as authentication', async () => {
    boundary.getActor.mockRejectedValue(Object.assign(new Error('로그인이 필요해요.'), { status: 401 }));
    const response = await d1Route('projects', request({ user: actor.id }));
    expect(response.status).toBe(401);
    expect(boundary.handle).not.toHaveBeenCalled();
    expect(boundary.maintenance).not.toHaveBeenCalled();
  });
  it('stops a stale account before handing its request or raw image download to storage', async () => {
    for (const req of [
      request({ user: 'account-b' }),
      request({ user: 'account-b', method: 'GET', path: 'assets?id=private&raw=1' }),
    ]) {
      const response = await d1Route(req.method === 'GET' ? 'assets' : 'projects', req);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: 'ACCOUNT_CHANGED' });
    }
    expect(boundary.handle).not.toHaveBeenCalled();
    expect(boundary.schedule).not.toHaveBeenCalled();
  });
  it('always forwards the verified actor for raw image reads, even without an expected-account header', async () => {
    const req = request({ method: 'GET', path: 'assets?id=private&raw=1' });
    const response = await d1Route('assets', req);
    expect(response.status).toBe(200);
    expect(boundary.getActor).toHaveBeenCalledWith(req, boundary.env);
    expect(boundary.handle).toHaveBeenCalledWith('assets', req, boundary.env, actor);
    expect(boundary.maintenance).not.toHaveBeenCalled();
  });
  it('rejects cross-origin mutations before authentication or backend processing', async () => {
    const response = await d1Route('projects', request({ origin: 'https://other.test' }));
    expect(response.status).toBe(403);
    expect(boundary.getActor).not.toHaveBeenCalled();
    expect(boundary.handle).not.toHaveBeenCalled();
  });
  it('schedules maintenance only after confirmed mutation responses and strips its internal marker', async () => {
    boundary.handle.mockResolvedValue(Response.json({ saved: true }, { headers: { 'X-SJN-Mutation': '1' } }));
    const response = await d1Route('projects', request({ user: actor.id }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ saved: true });
    expect(response.headers.has('X-SJN-Mutation')).toBe(false);
    expect(boundary.maintenance).toHaveBeenCalledExactlyOnceWith(boundary.env, actor);
    expect(boundary.schedule).toHaveBeenCalledOnce();
    expect(boundary.schedule.mock.calls[0][0]).toBeInstanceOf(Promise);
  });
  it('does not run maintenance for POST reads or failed writes', async () => {
    await d1Route('projects', request());
    expect(boundary.schedule).not.toHaveBeenCalled();
    boundary.handle.mockResolvedValue(
      Response.json({ error: '서버 저장 실패' }, { status: 503, headers: { 'X-SJN-Mutation': '1' } }),
    );
    const response = await d1Route('projects', request());
    expect(response.status).toBe(503);
    expect(boundary.schedule).not.toHaveBeenCalled();
    expect(boundary.maintenance).not.toHaveBeenCalled();
  });
  it('keeps active backend failures as failures without invoking initial readiness or local fallback', async () => {
    boundary.handle.mockResolvedValue(
      Response.json({ error: '저장 실패', code: 'STORAGE_UNAVAILABLE' }, { status: 503 }),
    );
    const response = await d1Route('projects', request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: '저장 실패', code: 'STORAGE_UNAVAILABLE' });
    expect(boundary.readiness).not.toHaveBeenCalled();
    expect(boundary.env.STORAGE_MODE).toBe('d1');
  });
  it('preserves a confirmed write if the background scheduler throws synchronously', async () => {
    boundary.handle.mockResolvedValue(Response.json({ saved: true }, { headers: { 'X-SJN-Mutation': '1' } }));
    boundary.schedule.mockImplementation(() => {
      throw new Error('request context closed');
    });
    const response = await d1Route('projects', request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ saved: true });
  });
});
