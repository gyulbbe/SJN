/**
 * The side-tile trial's catalogue cache (catalog-sync.mjs) asks only for what it lacks: on an empty
 * cache one GET /api/catalog/placement?ids=… and one GET per distinct image; on a whole cache nothing;
 * on a partial or cut cache only the missing records (one ids request) and images; never a list page.
 * A local fake catalogue answers (no network).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { syncCatalog, wantedImages, wholeImage } from './catalog-sync.mjs';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TILE_A = uuid(1),
  TILE_B = uuid(2),
  TOILET = uuid(3),
  OTHER = uuid(4);
// TILE_B shares its texture with TILE_A (fetched once); the toilet has three photos.
const RECORDS = {
  [TILE_A]: { materialId: TILE_A, category: 'tile', textureAssetIds: [uuid(11), uuid(19)], views: [] },
  [TILE_B]: { materialId: TILE_B, category: 'tile', textureAssetIds: [uuid(11)], views: [] },
  [TOILET]: {
    materialId: TOILET,
    category: 'toilet',
    textureAssetIds: [],
    views: [{ assetId: uuid(21) }, { assetId: uuid(22) }, { assetId: uuid(23) }],
  },
  [OTHER]: { materialId: OTHER, category: 'tile', textureAssetIds: [uuid(31)], views: [] },
} as Record<string, unknown>;
const IDS = [TILE_A, TILE_B, TOILET];
let bodies: Record<string, { type: string; body: Buffer }>;

beforeAll(async () => {
  const base = sharp({ create: { width: 4, height: 4, channels: 3, background: '#6a6b51' } });
  const png = await base.clone().png().toBuffer(),
    jpg = await base.clone().jpeg().toBuffer(),
    webp = await base.clone().webp().toBuffer();
  bodies = {
    [uuid(11)]: { type: 'image/png', body: png },
    [uuid(21)]: { type: 'image/jpeg', body: jpg },
    [uuid(22)]: { type: 'image/webp', body: webp },
    [uuid(23)]: { type: 'image/png', body: png },
    [uuid(31)]: { type: 'image/png', body: png },
  };
});

/** A fake public catalogue: the app's `ids` route and list images; anything else is a failure. */
function catalogue(options: { drop?: string[]; failImage?: string } = {}) {
  const paths: string[] = [];
  const fetchImpl = async (input: string | URL) => {
    const url = new URL(String(input));
    paths.push(url.pathname + url.search);
    if (url.pathname === '/api/catalog/placement') {
      const ids = url.searchParams.get('ids');
      if (!ids || [...url.searchParams.keys()].length !== 1) return new Response('list', { status: 500 });
      const placements = ids
        .split(',')
        .filter((id) => RECORDS[id] && !options.drop?.includes(id))
        .map((id) => RECORDS[id])
        .reverse(); // the route keeps no order
      return Response.json({ placements });
    }
    if (url.pathname === '/api/catalog/images' && url.searchParams.get('size') === 'list') {
      const id = url.searchParams.get('id')!;
      if (id === options.failImage || !bodies[id]) return new Response('no', { status: 404 });
      return new Response(new Uint8Array(bodies[id].body), { headers: { 'content-type': bodies[id].type } });
    }
    return new Response('unexpected', { status: 500 });
  };
  return { paths, fetchImpl: fetchImpl as unknown as typeof fetch };
}
const dirs: string[] = [];
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'side-tile-catalog-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const sync = (dir: string, fake: ReturnType<typeof catalogue>, ids = IDS) =>
  syncCatalog({ base: 'http://catalogue.test', dir, ids, fetchImpl: fake.fetchImpl });
const lists = (paths: string[]) => paths.filter((p) => p.startsWith('/api/catalog/placement'));
const images = (paths: string[]) => paths.filter((p) => p.startsWith('/api/catalog/images'));

describe('side-tile catalogue cache (catalog-sync.mjs)', () => {
  it('fills an empty cache with one ids request and one request per distinct image', async () => {
    const dir = fresh();
    const fake = catalogue();
    const { requests, placements } = await sync(dir, fake);
    expect(lists(fake.paths)).toEqual([`/api/catalog/placement?ids=${IDS.join(',')}`]);
    // A tile's first texture only, the shared texture once, the toilet's three photos.
    expect(images(fake.paths).sort()).toEqual(
      [uuid(11), uuid(21), uuid(22), uuid(23)].map((id) => `/api/catalog/images?id=${id}&size=list`).sort(),
    );
    expect(requests).toBe(5);
    expect(fake.paths).toHaveLength(5);
    expect(placements.map((p: { materialId: string }) => p.materialId)).toEqual(IDS);
    expect(readFileSync(join(dir, 'requests.jsonl'), 'utf8').trim().split('\n')).toHaveLength(5);
    expect(readdirSync(join(dir, 'images')).sort()).toEqual(
      [`${uuid(11)}.png`, `${uuid(21)}.jpg`, `${uuid(22)}.webp`, `${uuid(23)}.png`].sort(),
    );
  });

  it('asks nothing again with a whole cache, and leaves catalog.json as it is', async () => {
    const dir = fresh();
    await sync(dir, catalogue());
    const before = readFileSync(join(dir, 'catalog.json'), 'utf8');
    const again = catalogue();
    expect((await sync(dir, again)).requests).toBe(0);
    expect(again.paths).toEqual([]);
    expect(readFileSync(join(dir, 'catalog.json'), 'utf8')).toBe(before);
  });

  it('asks only for the missing record and the missing or cut images, never a list page', async () => {
    const dir = fresh();
    await sync(dir, catalogue());
    const file = join(dir, 'catalog.json');
    const cached = JSON.parse(readFileSync(file, 'utf8'));
    // A record lost, another without its photos (not usable), an image cut and one gone.
    cached.placements = cached.placements
      .filter((p: { materialId: string }) => p.materialId !== TILE_B)
      .map((p: { materialId: string }) => (p.materialId === TOILET ? { ...p, views: [] } : p));
    writeFileSync(file, JSON.stringify(cached));
    const cut = join(dir, 'images', `${uuid(21)}.jpg`);
    writeFileSync(cut, readFileSync(cut).subarray(0, 40));
    rmSync(join(dir, 'images', `${uuid(22)}.webp`));
    const again = catalogue();
    await sync(dir, again);
    expect(lists(again.paths)).toEqual([`/api/catalog/placement?ids=${TILE_B},${TOILET}`]);
    expect(images(again.paths).sort()).toEqual(
      [uuid(21), uuid(22)].map((id) => `/api/catalog/images?id=${id}&size=list`).sort(),
    );
    expect(wholeImage(readFileSync(cut), 'jpg')).toBe(true);
    expect(
      JSON.parse(readFileSync(file, 'utf8')).placements.map((p: { materialId: string }) => p.materialId),
    ).toEqual(IDS);
    // Whole again: nothing more.
    const third = catalogue();
    expect((await sync(dir, third)).requests).toBe(0);
  });

  it('stops when the answer lacks an id: one request, no list scan, the cache not marked done', async () => {
    const dir = fresh();
    const fake = catalogue({ drop: [TOILET] });
    await expect(sync(dir, fake)).rejects.toThrow(TOILET);
    expect(fake.paths).toEqual([`/api/catalog/placement?ids=${IDS.join(',')}`]);
    expect(existsSync(join(dir, 'catalog.json'))).toBe(false);
  });

  it('stops on a failed image and asks for it again next time', async () => {
    const dir = fresh();
    const fake = catalogue({ failImage: uuid(23) });
    await expect(sync(dir, fake)).rejects.toThrow(/404/);
    expect(existsSync(join(dir, 'images', `${uuid(23)}.png`))).toBe(false);
    const again = catalogue();
    await sync(dir, again);
    expect(again.paths).toEqual([`/api/catalog/images?id=${uuid(23)}&size=list`]);
  });

  it('refuses more ids than the route takes, before any request', async () => {
    const fake = catalogue();
    const many = Array.from({ length: 49 }, (_, i) => uuid(100 + i));
    await expect(sync(fresh(), fake, many)).rejects.toThrow(/48/);
    expect(fake.paths).toEqual([]);
  });

  it('reads a tile’s first texture and a product’s photos', () => {
    expect(wantedImages(RECORDS[TILE_A])).toEqual([uuid(11)]);
    expect(wantedImages(RECORDS[TOILET])).toEqual([uuid(21), uuid(22), uuid(23)]);
  });
});
