import { beforeEach, describe, it, expect, vi } from 'vitest';
const state = vi.hoisted(() => ({
  actor: vi.fn(),
  materials: vi.fn(),
  image: vi.fn(),
  placement: vi.fn(),
  env: {} as Record<string, unknown>,
}));
vi.mock('../src/lib/auth/d1', () => ({ getD1Actor: state.actor }));
vi.mock('../src/lib/platform/runtime', () => ({
  getRuntimeEnvironment: () => state.env,
}));
vi.mock('../src/lib/catalog/public', () => ({
  publicMaterials: state.materials,
  publicImage: state.image,
  publicPlacement: state.placement,
}));
import { GET as catalog } from '../src/app/api/catalog/materials/route';
import { GET as image } from '../src/app/api/catalog/images/route';
import { GET as placement } from '../src/app/api/catalog/placement/route';
const routes = [() => catalog(), image, placement];
beforeEach(() => {
  vi.resetAllMocks();
  state.env = {
    platform: 'cloudflare',
    DB: { prepare: vi.fn() },
    ASSET_BUCKET: { get: vi.fn() },
  };
  state.materials.mockResolvedValue(Response.json({ materials: [] }));
  state.image.mockResolvedValue(new Response('public image'));
  state.placement.mockResolvedValue(Response.json({ placements: [] }));
});
describe('public catalog routes are independent of account and OAuth readiness', () => {
  it.each(routes)('serves only the public projection without authenticating a guest', async (route) => {
    state.actor.mockRejectedValue(Object.assign(new Error('로그인이 필요해요.'), { status: 401 }));
    const response = await route(new Request('https://sjn.test/api/catalog/placement'));
    expect(response.status).toBe(200);
    expect(state.actor).not.toHaveBeenCalled();
    expect(state.env).not.toHaveProperty('GOOGLE_CLIENT_SECRET');
    expect(state.env).not.toHaveProperty('BETTER_AUTH_SECRET');
  });
  it.each(routes)('does not depend on a stale or suspended account to read public data', async (route) => {
    state.actor.mockRejectedValue(Object.assign(new Error('이용 정지'), { status: 403 }));
    expect(
      (
        await route(
          new Request('https://sjn.test/api/catalog/placement', {
            headers: { 'X-SJN-User-Id': 'old-account', cookie: 'old-session' },
          }),
        )
      ).status,
    ).toBe(200);
    expect(state.actor).not.toHaveBeenCalled();
  });
  it.each(['DB', 'ASSET_BUCKET'])('fails closed when %s is unavailable', async (binding) => {
    delete state.env[binding];
    for (const route of routes) {
      const response = await route(new Request('https://sjn.test/api/catalog/placement'));
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toContain('no-store');
    }
    expect(state.materials).not.toHaveBeenCalled();
    expect(state.image).not.toHaveBeenCalled();
    expect(state.placement).not.toHaveBeenCalled();
  });
  it.each([{ platform: 'node' }, { STORAGE_MODE: 'local' }, { DB: {} }, { ASSET_BUCKET: {} }])(
    'rejects an invalid runtime without querying public data: %j',
    async (change) => {
      Object.assign(state.env, change);
      expect((await catalog()).status).toBe(503);
      expect(state.materials).not.toHaveBeenCalled();
    },
  );
  it('uses only the public data helpers', async () => {
    await catalog();
    const request = new Request('https://sjn.test/api/catalog/placement');
    await placement(request);
    await image(request);
    expect(state.materials).toHaveBeenCalledWith(state.env);
    expect(state.placement).toHaveBeenCalledWith(state.env, request);
    expect(state.image).toHaveBeenCalledWith(state.env, request);
    expect(state.actor).not.toHaveBeenCalled();
  });
});
