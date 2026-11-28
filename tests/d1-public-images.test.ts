/**
 * The public placement's image check (src/lib/catalog/public.ts publicImageRows,
 * docs/d1-efficiency-round3-results-20261128.md, I): the same images as the old query on every case
 * (old SQL run side by side), a few rows an image however many versions a material has had (meterD1
 * at 1, 5 and 20 versions), and no scan in its plan.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { allD1Migrations, applyD1Migrations } from './helpers/d1-migrations';
import { meterD1 } from './helpers/d1-meter';
import { publicImageRows, publiclyDisplayed } from '../src/lib/catalog/public';
import type { D1Bindings, D1DatabaseLike } from '../src/lib/d1/types';

/** The query placementsOf ran before (2026-11-28 main), word for word. */
const legacySql = `SELECT a.id,a.metadata_json FROM d1_assets a WHERE a.deleting=0
     AND a.id IN(SELECT value FROM json_each(?))
     AND json_extract(a.metadata_json,'$.kind') IN ('texture','product','preview')
     AND json_extract(a.metadata_json,'$.mime') IN ('image/png','image/jpeg','image/webp')
     AND ${publiclyDisplayed}`;

let mf: Miniflare, db: D1DatabaseLike, env: D1Bindings;
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("isolated")}};',
      compatibilityDate: '2026-09-07',
      d1Databases: { DB: 'public-images' },
    }),
  );
  db = (await mf.getD1Database('DB')) as unknown as D1DatabaseLike;
  env = { DB: db } as unknown as D1Bindings;
  await applyD1Migrations(db, allD1Migrations);
}, 60000);
afterAll(async () => {
  await mf?.dispose();
});

const OWNER = 'owner-1';
let n = 0;
const stamp = () => new Date(Date.UTC(2026, 9, 1, 0, 0, n++)).toISOString();
async function asset(options: { kind?: string; mime?: string; deleting?: number } = {}) {
  const id = crypto.randomUUID();
  await db
    .prepare(
      'INSERT INTO d1_assets(id,owner_id,object_key,metadata_json,content_hash,created_at,deleting) VALUES(?,?,?,?,?,?,?)',
    )
    .bind(
      id,
      OWNER,
      `assets/${OWNER}/${id}/1`,
      JSON.stringify({
        id,
        ownerId: OWNER,
        name: 'a.png',
        kind: options.kind ?? 'product',
        mime: options.mime ?? 'image/png',
        width: 8,
        height: 8,
        size: 10,
      }),
      'hash-' + id,
      stamp(),
      options.deleting ?? 0,
    )
    .run();
  return id;
}
type Shape = {
  category?: 'tile' | 'basin';
  texture?: string[];
  views?: { assetId: string; direction: string }[];
  cover?: string;
  images?: string[];
  reconstruction?: boolean;
};
const payload = (id: string, materialId: string, version: number, s: Shape) =>
  JSON.stringify({
    id,
    materialId,
    version,
    name: '자재 ' + materialId.slice(0, 4),
    brand: '',
    code: '',
    category: s.category ?? 'basin',
    scope: 'shared',
    description: '',
    color: '',
    finish: '',
    widthMm: 600,
    heightMm: 600,
    depthMm: 10,
    usage: 'both',
    installation: 'floor',
    textureAssetIds: s.texture ?? [],
    views: (s.views ?? []).map((view) => ({ ...view, anchor: { x: 0.5, y: 1 } })),
    ...(s.cover ? { coverAssetId: s.cover } : {}),
    ...(s.images ? { imageAssetIds: s.images } : {}),
    ...(s.reconstruction ? { reconstruction: { kind: 'mesh' } } : {}),
    defaultGroutWidth: 2,
    defaultGroutColor: '#ffffff',
    defaultPattern: 'grid',
    createdAt: stamp(),
  });
/**
 * A shared material with `versions` versions of the same shape (each version's images referenced in
 * d1_material_assets unless `unreferenced`), the last one current. Returns the material and its
 * version ids, current last.
 */
async function material(
  s: Shape,
  options: {
    versions?: number;
    active?: number;
    scope?: string;
    purpose?: string;
    unreferenced?: string[];
  } = {},
) {
  const materialId = crypto.randomUUID();
  const versionIds = Array.from({ length: options.versions ?? 1 }, () => crypto.randomUUID());
  const current = versionIds.at(-1)!;
  const created = stamp();
  const statements = [
    db
      .prepare(
        'INSERT INTO d1_materials(id,owner_id,scope,current_version_id,created_at,updated_at,purpose,active) VALUES(?,?,?,?,?,?,?,?)',
      )
      .bind(
        materialId,
        OWNER,
        options.scope ?? 'shared',
        current,
        created,
        created,
        options.purpose ?? 'catalog',
        options.active ?? 1,
      ),
  ];
  const refs = [
    ...new Set([
      ...(s.texture ?? []),
      ...(s.views ?? []).map((v) => v.assetId),
      ...(s.cover ? [s.cover] : []),
      ...(s.images ?? []),
    ]),
  ];
  for (const [index, versionId] of versionIds.entries()) {
    statements.push(
      db
        .prepare(
          'INSERT INTO d1_material_versions(id,material_id,version,payload_json,category,view_count,created_at) VALUES(?,?,?,?,?,?,?)',
        )
        .bind(
          versionId,
          materialId,
          index + 1,
          payload(versionId, materialId, index + 1, s),
          s.category ?? 'basin',
          (s.views ?? []).length,
          stamp(),
        ),
    );
    for (const ref of refs)
      if (!options.unreferenced?.includes(ref))
        statements.push(
          db.prepare('INSERT INTO d1_material_assets(version_id,asset_id) VALUES(?,?)').bind(versionId, ref),
        );
  }
  await db.batch(statements);
  return { materialId, versionIds, current };
}

async function legacy(ids: string[]) {
  return (await db.prepare(legacySql).bind(JSON.stringify(ids)).all<{ id: string; metadata_json: string }>())
    .results;
}
const sorted = (rows: { id: string; metadata_json: string }[]) =>
  rows.map((row) => `${row.id}|${row.metadata_json}`).sort();
/** The pairs placementsOf sends: each in-hand version with each id asked for (a version may not show it). */
async function same(ids: string[], versionIds: string[]) {
  const pairs = versionIds.flatMap((version) => ids.map((id): [string, string] => [version, id]));
  const asked = versionIds.length ? ids : [];
  const now = await publicImageRows(env, pairs);
  const before = await legacy(asked);
  expect(sorted(now)).toEqual(sorted(before));
  return now.map((row) => row.id);
}

describe('공개 배치 이미지 확인: 옛 쿼리와 같은 결과', () => {
  it('정해 둔 사례마다 같은 이미지', { timeout: 120000 }, async () => {
    const view = (assetId: string, direction = '정면') => ({ assetId, direction });
    // Public and displayed, with a long history.
    const history = await asset();
    const a = await material({ views: [view(history)] }, { versions: 20 });
    // A tile's texture; a cover only (no views); a product image list only; a retired view.
    const texture = await asset({ kind: 'texture' });
    const t = await material({ category: 'tile', texture: [texture] });
    const cover = await asset();
    const c = await material({ cover });
    const listed = await asset();
    const l = await material({ images: [listed] });
    const retired = await asset();
    const r = await material({ views: [view(retired, '위')] });
    // Not public: inactive, personal, not catalogue, reconstruction, deleted, wrong kind or mime.
    const inactive = await asset();
    const i = await material({ views: [view(inactive)] }, { active: 0 });
    const personal = await asset();
    const p = await material({ views: [view(personal)] }, { scope: 'personal' });
    const fixtureOnly = await asset();
    const f = await material({ views: [view(fixtureOnly)] }, { purpose: 'project' });
    const mesh = await asset();
    const m = await material({ views: [view(mesh)], reconstruction: true });
    const deleting = await asset({ deleting: 1 });
    const d = await material({ views: [view(deleting)] });
    const source = await asset({ kind: 'source' });
    const s = await material({ views: [view(source)] });
    const gif = await asset({ mime: 'image/gif' });
    const g = await material({ views: [view(gif)] });
    // Displayed by an old version only.
    const dropped = await asset();
    const kept = await asset();
    const o = await material({ views: [view(kept)] });
    await db
      .prepare('INSERT INTO d1_material_assets(version_id,asset_id) VALUES(?,?)')
      .bind(o.current, dropped)
      .run();
    // Shared by two materials: this one lacks the reference row, the other one shows it publicly.
    const shared = await asset();
    const x = await material({ views: [view(shared)] }, { unreferenced: [shared] });
    const y = await material({ views: [view(shared)] });
    // Shared by two materials, only the one not in hand is public.
    const elsewhere = await asset();
    const hidden = await material({ views: [view(elsewhere)] }, { active: 0 });
    const shown = await material({ views: [view(elsewhere)] });
    const all = [
      history,
      texture,
      cover,
      listed,
      retired,
      inactive,
      personal,
      fixtureOnly,
      mesh,
      deleting,
      source,
      gif,
      dropped,
      kept,
      shared,
      elsewhere,
    ];
    const inHand = [a, t, c, l, r, i, p, f, m, d, s, g, o, x, hidden].map((row) => row.current);
    const ids = await same(all, inHand);
    expect(new Set(ids)).toEqual(
      new Set([history, texture, cover, listed, retired, kept, shared, elsewhere]),
    );
    // The other public material in hand too; an old version id in hand; nothing in hand.
    await same(all, [...inHand, y.current, shown.current]);
    await same(all, [...a.versionIds, ...inHand]);
    await same(all, []);
    await same([], inHand);
  });

  it('무작위 카탈로그 300가지 조합에서 같은 이미지', async () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)];
    const assets: string[] = [];
    for (let k = 0; k < 40; k++)
      assets.push(
        await asset({
          kind: pick(['product', 'texture', 'preview', 'source']),
          mime: pick(['image/png', 'image/webp', 'image/gif']),
          deleting: random() < 0.1 ? 1 : 0,
        }),
      );
    const materials = [];
    for (let k = 0; k < 30; k++) {
      const tile = random() < 0.4;
      const some = () => assets.filter(() => random() < 0.08);
      const views = tile
        ? []
        : some().map((id) => ({ assetId: id, direction: pick(['정면', '왼쪽', '위']) }));
      materials.push(
        await material(
          {
            category: tile ? 'tile' : 'basin',
            texture: tile ? some() : [],
            views,
            cover: random() < 0.4 ? pick(assets) : undefined,
            images: random() < 0.3 ? some() : undefined,
            reconstruction: random() < 0.1,
          },
          {
            versions: 1 + Math.floor(random() * 4),
            active: random() < 0.85 ? 1 : 0,
            scope: random() < 0.9 ? 'shared' : 'personal',
            purpose: random() < 0.9 ? 'catalog' : 'project',
            unreferenced: random() < 0.15 ? [pick(assets)] : [],
          },
        ),
      );
    }
    for (let round = 0; round < 300; round++) {
      const ids = assets.filter(() => random() < 0.5);
      const inHand = materials
        .filter(() => random() < 0.5)
        .map((row) => (random() < 0.9 ? row.current : pick(row.versionIds)));
      await same(ids, inHand);
    }
  }, 300000);
});

describe('읽은 행은 버전 수와 무관', () => {
  it('48개 자재 한 쪽: 버전 1·5·20개', async () => {
    const results: Record<number, { before: number; after: number; queries: number }> = {};
    for (const versions of [1, 5, 20]) {
      const ids: string[] = [];
      const inHand: string[] = [];
      for (let k = 0; k < 48; k++) {
        const id = await asset();
        ids.push(id);
        inHand.push((await material({ views: [{ assetId: id, direction: '정면' }] }, { versions })).current);
      }
      const old = meterD1(db);
      await old.db.prepare(legacySql).bind(JSON.stringify(ids)).all();
      const now = meterD1(db);
      const rows = await publicImageRows(
        { DB: now.db } as unknown as D1Bindings,
        inHand.map((version, k): [string, string] => [version, ids[k]]),
      );
      expect(rows).toHaveLength(48);
      results[versions] = {
        before: old.summary().rowsRead,
        after: now.summary().rowsRead,
        queries: now.summary().queries,
      };
    }
    console.log('public image check rows (48 images):', JSON.stringify(results));
    // One query; the rows a page reads do not grow with the versions (old: they did).
    for (const versions of [1, 5, 20]) expect(results[versions].queries).toBe(1);
    expect(results[20].after).toBeLessThanOrEqual(results[1].after * 1.5 + 20);
    expect(results[20].after).toBeLessThanOrEqual(48 * 8);
    expect(results[20].before).toBeGreaterThan(results[20].after);
  }, 900000);

  it('쿼리 계획에 커지는 표 전체 읽기(SCAN)가 없다', async () => {
    // The statement publicImageRows actually sends, read back from the meter.
    const meter = meterD1(db);
    await publicImageRows({ DB: meter.db } as unknown as D1Bindings, [['v', 'a']]);
    const plan = await db
      .prepare('EXPLAIN QUERY PLAN ' + meter.records[0].sql)
      .bind('[["v","a"]]')
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail);
    console.log(details.join(' | '));
    expect(details.filter((detail) => /^SCAN (a|r|v|m)\b/.test(detail))).toEqual([]);
    expect(details.some((detail) => /SEARCH r USING .*version_id=\? AND asset_id=\?/.test(detail))).toBe(
      true,
    );
  });
});
