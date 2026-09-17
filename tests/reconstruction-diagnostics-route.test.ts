import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ actor: vi.fn(), archive: vi.fn(), env: { DB: {}, ASSET_BUCKET: {} } }));
vi.mock('../src/lib/auth/d1', () => ({ getD1Actor: state.actor }));
vi.mock('../src/lib/storage/server', async (original) => ({
  ...(await original<object>()),
  requireD1Environment: () => state.env,
}));
vi.mock('../src/lib/reconstruction/diagnostic-archive-server', () => ({
  diagnosticArchiveRequest: state.archive,
}));
import { GET, POST } from '../src/app/api/reconstruction/diagnostics/route';
beforeEach(() => {
  vi.resetAllMocks();
  state.archive.mockResolvedValue(Response.json({ runs: [] }));
});
describe('diagnostic API authentication boundary', () => {
  it.each([GET, POST])('rejects anonymous requests before reading any archived data', async (route) => {
    state.actor.mockRejectedValue(Object.assign(new Error('로그인이 필요해요.'), { status: 401 }));
    const response = await route(new Request('https://sjn.test/api/reconstruction/diagnostics'));
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(state.archive).not.toHaveBeenCalled();
  });
  it('rejects a changed expected account before opening D1/R2 diagnostics', async () => {
    state.actor.mockResolvedValue({ id: 'current', isAdmin: false });
    const response = await GET(
      new Request('https://sjn.test/api/reconstruction/diagnostics', {
        headers: { 'X-SJN-User-Id': 'analysis-start' },
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'ACCOUNT_CHANGED' });
    expect(state.archive).not.toHaveBeenCalled();
  });
  it('forwards only the server-authenticated actor and bindings', async () => {
    state.actor.mockResolvedValue({ id: 'current', isAdmin: false });
    const request = new Request('https://sjn.test/api/reconstruction/diagnostics', {
      headers: { 'X-SJN-User-Id': 'current' },
    });
    expect((await GET(request)).status).toBe(200);
    expect(state.archive).toHaveBeenCalledWith(
      { env: state.env, actor: { id: 'current', isAdmin: false } },
      request,
    );
  });
});
