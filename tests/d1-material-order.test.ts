/**
 * Material list orders and brand priority (docs/material-order-results-20261027.md): the default order
 * shows the materials of the brands an administrator gave a 표시 순서 in 분류 관리 first (0 first, each
 * brand's by name), then the rest by name; newest registered and name either way. 표시 순서 is a whole
 * number or empty, and migration 0011 leaves every existing one empty. A local D1 through the storage
 * route, as tests/d1-catalog.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { handleD1Request, checkD1Storage } from '../src/lib/d1';
import { publicMaterials, type PublicMaterial } from '../src/lib/catalog/public';
import { readCatalog } from '../src/lib/catalog/server';
import {
  pageSearchParams,
  parsePageSearchParams,
  type MaterialPage,
  type MaterialPageQuery,
  type MaterialSort,
} from '../src/lib/catalog/paging';
import type { MaterialCard } from '../src/lib/catalog/cards';
import type { D1Bindings, D1DatabaseLike, D1Resource } from '../src/lib/d1/types';
import { allD1Migrations, applyD1Migrations } from './helpers/d1-migrations';

let mf: Miniflare;
let env: D1Bindings;
const admin = { id: crypto.randomUUID(), isAdmin: true };
const member = { id: crypto.randomUUID(), isAdmin: false };
const stamp = '2026-10-27T00:00:00.000Z';
function call(resource: D1Resource, body: unknown, actor = admin) {
  return handleD1Request(
    resource,
    new Request(`https://sjn.test/api/d1/${resource}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify(body),
    }),
    env,
    actor,
  );
}
const until = (name: string) => allD1Migrations.slice(0, allD1Migrations.indexOf(name));
const brands: Record<string, string> = {};
/** A brand through 분류 관리 (no 표시 순서). */
async function brand(name: string) {
  const response = await call('catalog', {
    operation: 'create',
    input: { kind: 'brand', name, active: true, sortOrder: null },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  brands[name] = ((await response.json()) as { id: string }).id;
}
/** A brand's 표시 순서 through 분류 관리. */
const order = (name: string, sortOrder: unknown) =>
  call('catalog', {
    operation: 'update',
    input: { id: brands[name], kind: 'brand', name, active: true, sortOrder },
  });
/** A shared tile straight into D1, linked to its brand as a save links it (after the version). */
async function tile(db: D1DatabaseLike, name: string, created: string, brandName?: string) {
  const id = crypto.randomUUID(),
    version = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        `INSERT INTO d1_materials(id,owner_id,scope,current_version_id,created_at,updated_at,purpose) VALUES(?,?,'shared',?,?,?,'catalog')`,
      )
      .bind(id, admin.id, version, created, created),
    db
      .prepare(
        `INSERT INTO d1_material_versions(id,material_id,version,payload_json,category,view_count,created_at) VALUES(?,?,1,?,'tile',0,?)`,
      )
      .bind(
        version,
        id,
        JSON.stringify({
          id: version,
          materialId: id,
          version: 1,
          name,
          brand: brandName ?? '',
          code: '',
          category: 'tile',
          scope: 'shared',
          description: '',
          color: '',
          finish: '',
          widthMm: 300,
          heightMm: 300,
          depthMm: 10,
          usage: 'both',
          installation: 'wall',
          textureAssetIds: [],
          views: [],
          defaultGroutWidth: 2,
          defaultGroutColor: '#ffffff',
          defaultPattern: 'grid',
          createdAt: created,
        }),
        created,
      ),
    ...(brandName
      ? [
          db
            .prepare(
              `INSERT INTO d1_material_version_options(version_id,option_id,option_kind) VALUES(?,?,'brand')`,
            )
            .bind(version, brands[brandName]),
        ]
      : []),
  ]);
  return { id, version };
}
/** Every page of the administrator library (or a member list) in an order. */
async function names(
  query: MaterialPageQuery,
  body: Record<string, unknown> = { view: 'library' },
  actor = admin,
) {
  const items: MaterialCard[] = [];
  let cursor: string | undefined;
  do {
    const response = await call(
      'materials',
      { operation: 'page', query: { ...query, cursor }, ...body },
      actor,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const page = (await response.json()) as MaterialPage<MaterialCard>;
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items.map((card) => card.name);
}

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("local test")}};',
      compatibilityDate: '2026-09-07',
      d1Databases: { DB: 'order-test', OLD: 'order-before-0011', UPGRADE: 'order-upgrade-0011' },
      r2Buckets: ['ASSET_BUCKET'],
    }),
  );
  env = {
    DB: await mf.getD1Database('DB'),
    ASSET_BUCKET: await mf.getR2Bucket('ASSET_BUCKET'),
  } as unknown as D1Bindings;
  await applyD1Migrations(env.DB, allD1Migrations);
  for (const actor of [admin, member])
    await env.DB.prepare(
      'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)',
    )
      .bind(actor.id, '정렬 시험 회원', actor.id + '@example.test', 1, stamp, stamp)
      .run();
  await env.DB.prepare('INSERT INTO admin_roles(user_id) VALUES(?)').bind(admin.id).run();
  for (const name of ['순서 브랜드 가', '순서 브랜드 나', '순서 브랜드 다']) await brand(name);
  // Registered in this order; names and brands out of order on purpose.
  await tile(env.DB, '라 타일', '2026-10-01T00:00:00.000Z', '순서 브랜드 가');
  await tile(env.DB, '나 타일', '2026-10-02T00:00:00.000Z', '순서 브랜드 나');
  await tile(env.DB, '가 타일', '2026-10-03T00:00:00.000Z', '순서 브랜드 다');
  await tile(env.DB, '다 타일', '2026-10-04T00:00:00.000Z');
  await tile(env.DB, '마 타일', '2026-10-05T00:00:00.000Z', '순서 브랜드 나');
  await tile(env.DB, '바 타일', '2026-10-06T00:00:00.000Z', '순서 브랜드 가');
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

describe('material list orders by brand', () => {
  it('lists by name while no brand has an order, newest registered first, and by name either way', async () => {
    const list = (sort?: MaterialSort) => names({ ...(sort ? { sort } : {}), limit: 1 });
    // Pages of one: every next page goes through the cursor.
    const byName = ['가 타일', '나 타일', '다 타일', '라 타일', '마 타일', '바 타일'];
    expect(await list()).toEqual(byName);
    expect(await list('priority')).toEqual(byName);
    expect(await list('newest')).toEqual(['바 타일', '마 타일', '다 타일', '가 타일', '나 타일', '라 타일']);
    expect(await list('name')).toEqual(byName);
    expect(await list('nameDesc')).toEqual([...byName].reverse());
  });

  it('puts the ordered brands first (0, then 1), each by name, then the rest by name, in every list', async () => {
    // Only two of the three brands get an order; the third and the material without a brand follow.
    expect((await order('순서 브랜드 나', 0)).status).toBe(200);
    expect((await order('순서 브랜드 가', 1)).status).toBe(200);
    const expected = ['나 타일', '마 타일', '라 타일', '바 타일', '가 타일', '다 타일'];
    expect(await names({ limit: 2 })).toEqual(expected);
    // The member drawer (wall tab) and the public list.
    expect(await names({ category: 'tile', usage: 'wall', limit: 4 }, {}, member)).toEqual(expected);
    const publicPage = (await (
      await publicMaterials(env, new Request('https://sjn.test/api/catalog/materials?category=tile'))
    ).json()) as MaterialPage<PublicMaterial>;
    expect(publicPage.items.map((item) => item.name)).toEqual(expected);
    // Other orders ignore the brands.
    expect(await names({ sort: 'name' })).toEqual([
      '가 타일',
      '나 타일',
      '다 타일',
      '라 타일',
      '마 타일',
      '바 타일',
    ]);
    // Two brands with the same number: their materials by name together.
    expect((await order('순서 브랜드 가', 0)).status).toBe(200);
    expect(await names({})).toEqual(['나 타일', '라 타일', '마 타일', '바 타일', '가 타일', '다 타일']);
    // A new material of an ordered brand takes its place at once (the link sets it).
    await tile(env.DB, '사 타일', '2026-10-07T00:00:00.000Z', '순서 브랜드 나');
    expect((await names({})).slice(0, 5)).toEqual(['나 타일', '라 타일', '마 타일', '바 타일', '사 타일']);
    // Cleared: back among the rest.
    expect((await order('순서 브랜드 가', null)).status).toBe(200);
    expect(await names({})).toEqual([
      '나 타일',
      '마 타일',
      '사 타일',
      '가 타일',
      '다 타일',
      '라 타일',
      '바 타일',
    ]);
  });

  it('takes 표시 순서 as a whole number from 0 to 9999 or empty, and lists by it, then by name', async () => {
    for (const value of [-1, 10000, 1.5, '1', undefined])
      expect((await order('순서 브랜드 다', value)).status, String(value)).toBe(400);
    expect((await order('순서 브랜드 다', 9999)).status).toBe(200);
    const subcategory = await call('catalog', {
      operation: 'create',
      input: {
        kind: 'subcategory',
        category: 'basin',
        name: '순서 없는 분류',
        active: true,
        sortOrder: null,
      },
    });
    expect(subcategory.status).toBe(200);
    const catalog = await readCatalog(env.DB, true);
    const listed = catalog.options.filter((option) => option.kind === 'brand');
    // Numbered first (smallest first), then the ones without a number by name.
    expect(listed.slice(0, 2).map((option) => [option.name, option.sortOrder])).toEqual([
      ['순서 브랜드 나', 0],
      ['순서 브랜드 다', 9999],
    ]);
    const rest = listed.slice(2);
    expect(rest.every((option) => option.sortOrder === null)).toBe(true);
    const key = (name: string) => name.normalize('NFKC').trim().toLocaleLowerCase('ko-KR');
    expect(rest.map((option) => key(option.name))).toEqual(
      rest.map((option) => key(option.name)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    expect(catalog.subcategories.find((row) => row.name === '순서 없는 분류')?.sortOrder).toBeNull();
    // The database refuses what the API does not send.
    await expect(
      env.DB.prepare('UPDATE d1_catalog_options SET display_order=1.5 WHERE id=?')
        .bind(brands['순서 브랜드 다'])
        .run(),
    ).rejects.toThrow();
    expect((await order('순서 브랜드 다', null)).status).toBe(200);
  });

  it('leaves every existing 표시 순서 and material priority empty after 0011, and orders by name', async () => {
    const db = (await mf.getD1Database('UPGRADE')) as unknown as D1DatabaseLike;
    await applyD1Migrations(db, until('0011_brand_order.sql'));
    // Before 0011: numbered options (as 분류 관리 saved them) and a material priority (0010).
    const toto = await db
      .prepare("SELECT id FROM d1_catalog_options WHERE kind='brand' AND normalized_name='toto'")
      .first<{ id: string }>();
    brands.TOTO = toto!.id;
    await db.prepare('UPDATE d1_catalog_options SET sort_order=3').run();
    await db.prepare('UPDATE d1_material_subcategories SET sort_order=2').run();
    const first = await tile(db, '나중 타일', stamp, 'TOTO');
    await tile(db, '먼저 타일', stamp);
    await db.prepare('UPDATE d1_materials SET priority=1 WHERE id=?').bind(first.id).run();
    const prio = async () =>
      (
        await db
          .prepare('SELECT prio FROM d1_material_list WHERE version_id=?')
          .bind(first.version)
          .first<{ prio: number }>()
      )?.prio;
    expect(await prio()).toBe(1);
    await applyD1Migrations(db, ['0011_brand_order.sql']);
    expect(
      await db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM d1_catalog_options WHERE display_order IS NOT NULL) AS options,
            (SELECT COUNT(*) FROM d1_material_subcategories WHERE display_order IS NOT NULL) AS subcategories,
            (SELECT COUNT(*) FROM d1_materials WHERE priority IS NOT NULL) AS priorities,
            (SELECT COUNT(*) FROM d1_material_list WHERE prio<>10000) AS list,
            (SELECT COUNT(*) FROM d1_material_list_facets WHERE prio<>10000) AS facets`,
        )
        .first(),
    ).toEqual({ options: 0, subcategories: 0, priorities: 0, list: 0, facets: 0 });
    // A per-material priority (the 0010 code) no longer moves anything; the brand's order does.
    await db.prepare('UPDATE d1_materials SET priority=2 WHERE id=?').bind(first.id).run();
    expect(await prio()).toBe(10000);
    await db.prepare('UPDATE d1_catalog_options SET display_order=4 WHERE id=?').bind(brands.TOTO).run();
    expect(await prio()).toBe(4);
  });

  it('refuses a cursor of another order, and an old tab’s cursor with a message to start again', async () => {
    const response = await call('materials', { operation: 'page', query: { limit: 1 }, view: 'library' });
    const { nextCursor } = (await response.json()) as MaterialPage<MaterialCard>;
    expect(nextCursor).toBeTruthy();
    const next = (sort: MaterialSort) =>
      call('materials', {
        operation: 'page',
        query: { limit: 1, sort, cursor: nextCursor },
        view: 'library',
      });
    expect((await next('priority')).status).toBe(200);
    expect((await next('name')).status).toBe(400);
    // A cursor made before the orders (updated_at and material id).
    const old = btoa(
      JSON.stringify({ k: 'x', u: '2026-10-01', m: 'm', g: 0, e: { size: [], color: [], finish: [] } }),
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const stale = await call('materials', { operation: 'page', query: { cursor: old }, view: 'library' });
    expect(stale.status).toBe(400);
    expect(((await stale.json()) as { error: string }).error).toContain('목록 순서가 바뀌었어요');
  });

  it('reads the order back from the public GET form, leaving the default out', () => {
    expect(pageSearchParams({ sort: 'priority' }).toString()).toBe('');
    expect(pageSearchParams({ sort: 'nameDesc', category: 'tile' }).toString()).toBe(
      'category=tile&sort=nameDesc',
    );
    expect(parsePageSearchParams(new URLSearchParams('sort=newest')).sort).toBe('newest');
    expect(() => parsePageSearchParams(new URLSearchParams('sort=updated'))).toThrow();
  });

  it('is not ready on a database without 0011', async () => {
    const old = {
      DB: await mf.getD1Database('OLD'),
      ASSET_BUCKET: env.ASSET_BUCKET,
    } as unknown as D1Bindings;
    await applyD1Migrations(old.DB, until('0011_brand_order.sql'));
    await expect(checkD1Storage(old)).rejects.toThrow();
    await applyD1Migrations(old.DB, ['0011_brand_order.sql']);
    await expect(checkD1Storage(old)).resolves.toBeUndefined();
  });
});
