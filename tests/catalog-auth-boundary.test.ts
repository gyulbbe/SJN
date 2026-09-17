import { beforeEach, describe, it, expect, vi } from 'vitest';
const state = vi.hoisted(() => ({
  actor: vi.fn(),
  materials: vi.fn(),
  image: vi.fn(),
  env: { DB: {}, ASSET_BUCKET: {} },
}));
vi.mock('../src/lib/auth/d1', () => ({ getD1Actor: state.actor }));
vi.mock('../src/lib/storage/server', async (original) => ({
  ...(await original<object>()),
  requireD1Environment: () => state.env,
}));
vi.mock('../src/lib/catalog/public', () => ({ publicMaterials: state.materials, publicImage: state.image }));
import { GET as catalog } from '../src/app/api/catalog/materials/route';
import { GET as image } from '../src/app/api/catalog/images/route';
beforeEach(() => {
  vi.resetAllMocks();
  state.materials.mockResolvedValue(Response.json({ materials: [] }));
  state.image.mockResolvedValue(new Response('private image'));
});
describe('catalog routes require a current account before any data access', () => {
  it.each([catalog, image])(
    'denies anonymous data requests without querying the catalog/R2',
    async (route) => {
      state.actor.mockRejectedValue(Object.assign(new Error('로그인이 필요해요.'), { status: 401 }));
      const response = await route(new Request('https://sjn.test/api/catalog/images?id=private'));
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(state.materials).not.toHaveBeenCalled();
      expect(state.image).not.toHaveBeenCalled();
    },
  );
  it.each([catalog, image])('denies suspended sessions before catalog/R2 access', async (route) => {
    state.actor.mockRejectedValue(
      Object.assign(new Error('이용 정지'), { status: 403, code: 'account_suspended' }),
    );
    const response = await route(new Request('https://sjn.test/api/catalog/images?id=private'));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'account_suspended' });
    expect(state.materials).not.toHaveBeenCalled();
    expect(state.image).not.toHaveBeenCalled();
  });
  it('lets a signed-in ordinary member browse registered material projections', async () => {
    state.actor.mockResolvedValue({ id: 'member', isAdmin: false });
    expect((await catalog(new Request('https://sjn.test/api/catalog/materials'))).status).toBe(200);
    expect(state.materials).toHaveBeenCalledWith(state.env);
  });
  it('rejects a request whose expected account changed', async () => {
    state.actor.mockResolvedValue({ id: 'other-member', isAdmin: false });
    const response = await image(
      new Request('https://sjn.test/api/catalog/images?id=x', { headers: { 'X-SJN-User-Id': 'member' } }),
    );
    expect(response.status).toBe(401);
    expect(state.image).not.toHaveBeenCalled();
  });
});
