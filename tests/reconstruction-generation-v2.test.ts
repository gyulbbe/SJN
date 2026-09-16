import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetRecord, MaterialInput, MaterialVersion } from '../src/lib/types';
import type { Repositories } from '../src/lib/repositories';
import { DEFAULT_ROOM } from '../src/lib/room-geometry';

const render = vi.hoisted(() =>
  vi.fn(async () => ({ blob: new Blob(['template'], { type: 'image/png' }), anchor: { x: 0.5, y: 1 } })),
);
vi.mock('../src/lib/reconstruction/templates', async (original) => ({
  ...(await original<typeof import('../src/lib/reconstruction/templates')>()),
  renderReconstructionTemplate: render,
}));
vi.mock('../src/lib/images', async (original) => ({
  ...(await original<typeof import('../src/lib/images')>()),
  makeAsset: async (blob: Blob, name: string) => ({
    id: crypto.randomUUID(),
    ownerId: 'local',
    name,
    kind: 'product',
    mime: blob.type,
    size: blob.size,
    blob,
    width: 100,
    height: 100,
    createdAt: new Date().toISOString(),
  }),
}));
vi.mock('../src/lib/room-fixtures', async (original) => ({
  ...(await original<typeof import('../src/lib/room-fixtures')>()),
  createRoomPlacement: async (material: MaterialVersion, asset: AssetRecord, face: string) => ({
    face,
    u: 0.5,
    v: 0.5,
    scale: 1,
    widthMm: material.widthMm,
    heightMm: material.heightMm,
    imageAspect: asset.kind === 'product-mesh' ? 1 : asset.width / asset.height,
    contentBounds: { left: 0, right: 1, top: 0, bottom: 1 },
  }),
}));
import { createReconstructionFixture, updateReconstructionFixture } from '../src/lib/reconstruction';

function repositories() {
  const versions: MaterialVersion[] = [],
    assets = new Map<string, AssetRecord>();
  const crop: AssetRecord = {
    id: 'original-crop',
    ownerId: 'local',
    name: 'legacy mirror reflection',
    kind: 'product',
    width: 100,
    height: 100,
    mime: 'image/png',
    size: 6,
    createdAt: '2025-01-01',
    blob: new Blob(['legacy']),
  };
  assets.set(crop.id, crop);
  const put = vi.fn(async (asset: AssetRecord) => {
    assets.set(asset.id, asset);
  });
  const repos = {
    assets: {
      get: async (id: string) => {
        if (!assets.has(id)) throw new Error('Missing asset');
        return assets.get(id)!;
      },
      put,
    },
    materials: {
      list: async () => versions.map((version) => ({ version })),
      create: async (input: MaterialInput) => {
        const version = {
          ...input,
          id: crypto.randomUUID(),
          materialId: crypto.randomUUID(),
          version: 1,
          createdAt: new Date().toISOString(),
        };
        versions.push(version);
        return version;
      },
    },
  } as unknown as Repositories;
  return { repos, versions, assets, put };
}
beforeEach(() => render.mockClear());

describe('standard generation and explicit legacy conversion', () => {
  it('new mirrors and windows render neutral geometry even when a caller supplies a legacy crop', async () => {
    for (const kind of ['mirror', 'window'] as const) {
      const r = repositories();
      const fixture = await createReconstructionFixture({
        kind,
        room: DEFAULT_ROOM,
        appearanceAssetId: 'original-crop',
        repositories: r.repos,
      });
      expect(fixture.reconstruction?.version).toBe(2);
      expect(fixture.reconstruction?.appearanceAssetId).toBeUndefined();
      expect(r.versions[0].views[0].assetId).not.toBe('original-crop');
      expect(r.assets.has('original-crop')).toBe(true);
    }
    expect(render).toHaveBeenCalledTimes(2);
  });
  it('keeps legacy appearance during ordinary edits and converts only by explicit request', async () => {
    const r = repositories();
    const old = await createReconstructionFixture({
      kind: 'mirror',
      version: 1,
      room: DEFAULT_ROOM,
      face: 'back',
      v: 0.5,
      appearanceAssetId: 'original-crop',
      repositories: r.repos,
    });
    old.roomPlacement!.scale = 0.7;
    const source = structuredClone(old),
      originalVersion = structuredClone(r.versions[0]);
    const edited = await updateReconstructionFixture(
      old,
      DEFAULT_ROOM,
      { color: '#aabbcc' },
      { repositories: r.repos },
    );
    expect(edited.reconstruction).toMatchObject({ version: 1, appearanceAssetId: 'original-crop' });
    expect(render).not.toHaveBeenCalled();
    const converted = await updateReconstructionFixture(
      old,
      DEFAULT_ROOM,
      {},
      { convertToStandard: true, repositories: r.repos },
    );
    expect(converted.id).toBe(old.id);
    expect(converted.reconstruction).toMatchObject({
      version: 2,
      sourceMaterialVersionId: old.materialVersionId,
      widthMm: old.reconstruction!.widthMm * 0.7,
    });
    expect(converted.reconstruction?.appearanceAssetId).toBeUndefined();
    expect(converted.roomPlacement?.scale).toBe(1);
    expect(converted.reconstruction?.baseHeightMm).toBeCloseTo(1200 - (800 * 0.7) / 2);
    expect(old).toEqual(source);
    expect(r.versions[0]).toEqual(originalVersion);
    expect(r.assets.has('original-crop')).toBe(true);
  });
  it('preserves the current fixture and saved version on asset failure, and allows retry', async () => {
    const r = repositories();
    const old = await createReconstructionFixture({
      kind: 'mirror',
      version: 1,
      room: DEFAULT_ROOM,
      appearanceAssetId: 'original-crop',
      repositories: r.repos,
    });
    const before = structuredClone(old);
    r.put.mockRejectedValueOnce(new Error('QuotaExceededError'));
    await expect(
      updateReconstructionFixture(old, DEFAULT_ROOM, {}, { convertToStandard: true, repositories: r.repos }),
    ).rejects.toThrow('QuotaExceededError');
    expect(old).toEqual(before);
    expect(r.versions).toHaveLength(1);
    const retry = await updateReconstructionFixture(
      old,
      DEFAULT_ROOM,
      {},
      { convertToStandard: true, repositories: r.repos },
    );
    expect(retry.reconstruction?.version).toBe(2);
  });
  it('synchronizes an explicit normalized wall movement with the saved physical installation height', async () => {
    const r = repositories();
    const fixture = await createReconstructionFixture({
      kind: 'basin',
      room: DEFAULT_ROOM,
      repositories: r.repos,
    });
    const moved = await updateReconstructionFixture(
      fixture,
      DEFAULT_ROOM,
      { v: 0.6 },
      { repositories: r.repos },
    );
    expect(moved.reconstruction?.baseHeightMm).toBeCloseTo(DEFAULT_ROOM.heightMm * 0.4);
    expect(moved.roomPlacement?.v).toBeCloseTo(0.6);
    expect(fixture.reconstruction?.baseHeightMm).toBe(650);
  });
});

it('persists an explicit one-bowl default and preserves legacy implicit counts and immutable versions on edit', async () => {
  const r = repositories();
  const created = await createReconstructionFixture({
    kind: 'vanity',
    room: DEFAULT_ROOM,
    repositories: r.repos,
  });
  expect(created.reconstruction).toMatchObject({ bowlCount: 1, provenance: { bowlCount: 'default' } });
  const legacy = structuredClone(created);
  delete legacy.reconstruction!.bowlCount;
  const originalVersion = structuredClone(r.versions[0]);
  const before = structuredClone(legacy);
  const edited = await updateReconstructionFixture(
    legacy,
    DEFAULT_ROOM,
    { color: '#aaaaaa' },
    { repositories: r.repos },
  );
  expect(edited.reconstruction?.bowlCount).toBe(2);
  expect(legacy).toEqual(before);
  expect(r.versions[0]).toEqual(originalVersion);
  const one = await updateReconstructionFixture(
    legacy,
    DEFAULT_ROOM,
    { bowlCount: 1 },
    { repositories: r.repos },
  );
  expect(one.reconstruction?.bowlCount).toBe(1);
});

it.each([1, 2] as const)(
  'keeps version %i pre-lid documents during unrelated edits and replaces only an explicitly changed fixture',
  async (version) => {
    const r = repositories();
    const legacy = await createReconstructionFixture({
      kind: 'toilet',
      version,
      toiletLidState: undefined,
      room: DEFAULT_ROOM,
      repositories: r.repos,
    });
    expect(legacy.reconstruction?.toiletLidState).toBeUndefined();
    expect(legacy.reconstruction?.provenance?.toiletLidState).toBeUndefined();
    const unchanged = structuredClone(legacy),
      immutable = structuredClone(r.versions[0]);
    const moved = await updateReconstructionFixture(
      legacy,
      DEFAULT_ROOM,
      { u: 0.4 },
      { repositories: r.repos },
    );
    expect(moved.reconstruction?.toiletLidState).toBeUndefined();
    expect((render.mock.calls.at(-1) as unknown[] | undefined)?.[0]).toMatchObject({
      toiletLidState: undefined,
    });
    const opened = await updateReconstructionFixture(
      legacy,
      DEFAULT_ROOM,
      { toiletLidState: 'open', provenance: { toiletLidState: 'user' } },
      { repositories: r.repos },
    );
    expect(opened.reconstruction).toMatchObject({
      toiletLidState: 'open',
      provenance: { toiletLidState: 'user' },
    });
    expect(opened.id).toBe(legacy.id);
    expect(opened.materialVersionId).not.toBe(legacy.materialVersionId);
    expect(legacy).toEqual(unchanged);
    expect(r.versions[0]).toEqual(immutable);
  },
);
it('defaults a newly created toilet to closed without claiming that state was observed', async () => {
  const r = repositories();
  const fixture = await createReconstructionFixture({
    kind: 'toilet',
    room: DEFAULT_ROOM,
    repositories: r.repos,
  });
  expect(fixture.reconstruction).toMatchObject({
    toiletLidState: 'closed',
    provenance: { toiletLidState: 'default' },
  });
});

it('preserves explicit raised support through generation and edits without silent resizing', async () => {
  const r = repositories();
  const support = {
    kind: 'bath-rim' as const,
    heightMm: 600,
    provenance: { kind: 'user' as const, height: 'user' as const },
  };
  const fixture = await createReconstructionFixture({
    kind: 'glassPartition',
    room: DEFAULT_ROOM,
    repositories: r.repos,
    support,
    baseHeightMm: 600,
    u: 0.5,
    v: 0.5,
    widthMm: 800,
    heightMm: 1800,
    depthMm: 8,
  });
  expect(fixture.reconstruction).toMatchObject({
    support,
    baseHeightMm: 600,
    widthMm: 800,
    heightMm: 1800,
    depthMm: 8,
  });
  const original = structuredClone(fixture),
    originalVersion = structuredClone(r.versions[0]);
  const next = await updateReconstructionFixture(
    fixture,
    DEFAULT_ROOM,
    { baseHeightMm: 100, support: { ...support, kind: 'shower-curb', heightMm: 100 } },
    { repositories: r.repos },
  );
  expect(next.reconstruction?.support?.heightMm).toBe(100);
  expect(next.reconstruction?.heightMm).toBe(1800);
  expect(fixture).toEqual(original);
  expect(r.versions[0]).toEqual(originalVersion);
  await expect(
    updateReconstructionFixture(next, DEFAULT_ROOM, { baseHeightMm: 200 }, { repositories: r.repos }),
  ).rejects.toThrow('서로 달라');
  await expect(
    updateReconstructionFixture(next, DEFAULT_ROOM, { kind: 'bath' }, { repositories: r.repos }),
  ).rejects.toThrow('유리 파티션');
  const grounded = await updateReconstructionFixture(
    next,
    DEFAULT_ROOM,
    { support: undefined, baseHeightMm: 0 },
    { repositories: r.repos },
  );
  expect(grounded.reconstruction?.support).toBeUndefined();
  const writes = r.put.mock.calls.length;
  await expect(
    createReconstructionFixture({
      kind: 'glassPartition',
      room: DEFAULT_ROOM,
      repositories: r.repos,
      support,
      baseHeightMm: 600,
      u: 0.5,
      v: 0.5,
      heightMm: 1900,
    }),
  ).rejects.toThrow('범위');
  expect(r.put.mock.calls).toHaveLength(writes);
});

it('preserves legacy round support until the user selects a rectangular pedestal, without replacing old assets', async () => {
  const r = repositories();
  const original = await createReconstructionFixture({
    kind: 'basin',
    version: 2,
    basinVariant: 'pedestal',
    basinShape: 'rectangular',
    room: DEFAULT_ROOM,
    repositories: r.repos,
  });
  const source = structuredClone(original),
    oldVersions = structuredClone(r.versions),
    oldAssets = [...r.assets.keys()];
  expect(original.reconstruction?.pedestalShape).toBeUndefined();
  const edited = await updateReconstructionFixture(
    original,
    DEFAULT_ROOM,
    {
      pedestalShape: 'rectangular',
      provenance: { ...original.reconstruction?.provenance, pedestalShape: 'user' },
    },
    { repositories: r.repos },
  );
  expect(edited.id).toBe(original.id);
  expect(edited.reconstruction).toMatchObject({
    pedestalShape: 'rectangular',
    provenance: { pedestalShape: 'user' },
  });
  expect(edited.materialVersionId).not.toBe(original.materialVersionId);
  expect(original).toEqual(source);
  expect(r.versions.slice(0, oldVersions.length)).toEqual(oldVersions);
  for (const id of oldAssets) expect(r.assets.has(id)).toBe(true);
  const moved = await updateReconstructionFixture(
    edited,
    DEFAULT_ROOM,
    { u: 0.55 },
    { repositories: r.repos },
  );
  expect(moved.reconstruction).toMatchObject({
    pedestalShape: 'rectangular',
    provenance: { pedestalShape: 'user' },
  });
  const wall = await updateReconstructionFixture(
    edited,
    DEFAULT_ROOM,
    {
      basinVariant: 'wall',
      face: 'back',
      baseHeightMm: 650,
    },
    { repositories: r.repos },
  );
  expect(wall.reconstruction?.pedestalShape).toBeUndefined();
  await expect(
    createReconstructionFixture({
      kind: 'basin',
      basinVariant: 'pedestal',
      pedestalShape: 'wrong' as 'round',
      room: DEFAULT_ROOM,
      repositories: r.repos,
    }),
  ).rejects.toThrow();
});

describe('strict photo generation and explicit confirmation', () => {
  it('rejects out-of-room photos before generating or saving a replacement', async () => {
    const r = repositories();
    await expect(
      createReconstructionFixture({
        kind: 'toilet',
        room: DEFAULT_ROOM,
        u: 0.001,
        v: 0.5,
        widthMm: 420,
        placementPolicy: 'preserve',
        repositories: r.repos,
      }),
    ).rejects.toMatchObject({ name: 'StrictPlacementError' });
    expect(r.put).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(r.versions).toHaveLength(0);
  });
  it('keeps entered wall dimensions and height through create, edit and projection', async () => {
    const r = repositories();
    const created = await createReconstructionFixture({
      kind: 'basin',
      basinVariant: 'wall',
      room: DEFAULT_ROOM,
      face: 'left',
      u: 0.6,
      widthMm: 610,
      heightMm: 180,
      depthMm: 425,
      baseHeightMm: 735,
      placementPolicy: 'preserve',
      repositories: r.repos,
    });
    expect(created.roomPlacement).toMatchObject({ u: 0.6, v: 1 - 735 / 2400, scale: 1 });
    expect(created.reconstruction).toMatchObject({
      widthMm: 610,
      heightMm: 180,
      depthMm: 425,
      baseHeightMm: 735,
      placementPolicy: 'preserve',
    });
    const next = await updateReconstructionFixture(
      created,
      DEFAULT_ROOM,
      { baseHeightMm: 820 },
      { repositories: r.repos, placementPolicy: 'preserve' },
    );
    expect(next.reconstruction!.baseHeightMm).toBe(820);
    expect(next.roomPlacement!.v).toBe(1 - 820 / 2400);
    expect(created.reconstruction!.baseHeightMm).toBe(735);
    await expect(
      updateReconstructionFixture(
        next,
        DEFAULT_ROOM,
        { widthMm: 4000 },
        { repositories: r.repos, placementPolicy: 'preserve' },
      ),
    ).rejects.toMatchObject({ name: 'StrictPlacementError' });
    expect(next.reconstruction!.widthMm).toBe(610);
  });
  it('does not shift a valid floor proposal during capture or projection', async () => {
    const r = repositories();
    const input = { u: 0.42, v: 0.63, widthMm: 411, heightMm: 806, depthMm: 677 };
    const fixture = await createReconstructionFixture({
      kind: 'toilet',
      room: DEFAULT_ROOM,
      ...input,
      placementPolicy: 'preserve',
      repositories: r.repos,
    });
    expect(fixture.roomPlacement).toMatchObject({ u: input.u, v: input.v, scale: 1 });
    expect(fixture.reconstruction).toMatchObject({ widthMm: 411, heightMm: 806, depthMm: 677 });
  });
  it('keeps direct manual addition fitting as the legacy default', async () => {
    const r = repositories();
    const fixture = await createReconstructionFixture({
      kind: 'toilet',
      room: DEFAULT_ROOM,
      u: 0.001,
      v: 0.001,
      repositories: r.repos,
    });
    expect(fixture.roomPlacement!.u).toBeGreaterThan(0.001);
    expect(fixture.reconstruction!.placementPolicy).toBeUndefined();
  });
});
