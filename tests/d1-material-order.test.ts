/**
 * Material list orders and the administrator's priority (docs/material-order-results-20261027.md):
 * priority first (numbered shared materials, smallest first, then the rest by name), newest registered,
 * name either way; who may set a priority, and what it changes. A local D1 through the storage route,
 * as tests/d1-catalog.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { handleD1Request, checkD1Storage } from '../src/lib/d1';
import { materials } from '../src/lib/d1/materials';
import { publicMaterials, type PublicMaterial } from '../src/lib/catalog/public';
import {
  pageSearchParams,
  parsePageSearchParams,
  type MaterialPage,
  type MaterialPageQuery,
  type MaterialSort,
} from '../src/lib/catalog/paging';
import type { MaterialCard } from '../src/lib/catalog/cards';
import type { D1Bindings, D1Resource } from '../src/lib/d1/types';
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
type Seeded = { id: string; name: string; created: string };
let tiles: Seeded[] = [];
/** A shared tile straight into D1 (the 0009/0010 triggers summarise it). */
async function tile(name: string, created: string, options: { owner?: string; scope?: string } = {}) {
  const id = crypto.randomUUID(),
    version = crypto.randomUUID();
  const scope = options.scope ?? 'shared';
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO d1_materials(id,owner_id,scope,current_version_id,created_at,updated_at,purpose) VALUES(?,?,?,?,?,?,'catalog')`,
    ).bind(id, options.owner ?? admin.id, scope, version, created, created),
    env.DB.prepare(
      `INSERT INTO d1_material_versions(id,material_id,version,payload_json,category,view_count,created_at) VALUES(?,?,1,?,'tile',0,?)`,
    ).bind(
      version,
      id,
      JSON.stringify({
        id: version,
        materialId: id,
        version: 1,
        name,
        brand: '',
        code: '',
        category: 'tile',
        scope,
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
  ]);
  return { id, name, created };
}
/** Every page of the administrator library (or the member drawer) in an order, `limit` at a time. */
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
  return items;
}
const setPriority = (id: string, priority: unknown, actor = admin) =>
  call('materials', { operation: 'setPriority', id, priority }, actor);

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("local test")}};',
      compatibilityDate: '2026-09-07',
      d1Databases: { DB: 'order-test', OLD: 'order-before-0010' },
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
  // Registered d, b, a, c (in that order); names out of order on purpose.
  tiles = [
    await tile('d타일', '2026-10-01T00:00:00.000Z'),
    await tile('b타일', '2026-10-02T00:00:00.000Z'),
    await tile('a타일', '2026-10-03T00:00:00.000Z'),
    await tile('c타일', '2026-10-04T00:00:00.000Z'),
  ];
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
const byName = (name: string) => tiles.find((row) => row.name === name)!;

describe('material list orders', () => {
  it('lists by name with no priority, newest registered first, and by name either way', async () => {
    const order = async (sort?: MaterialSort) =>
      (await names({ ...(sort ? { sort } : {}), limit: 1 })).map((card) => card.name);
    // Pages of one: every next page goes through the cursor.
    expect(await order()).toEqual(['a타일', 'b타일', 'c타일', 'd타일']);
    expect(await order('priority')).toEqual(['a타일', 'b타일', 'c타일', 'd타일']);
    expect(await order('newest')).toEqual(['c타일', 'a타일', 'b타일', 'd타일']);
    expect(await order('name')).toEqual(['a타일', 'b타일', 'c타일', 'd타일']);
    expect(await order('nameDesc')).toEqual(['d타일', 'c타일', 'b타일', 'a타일']);
  });

  it('puts the numbered ones first (1, then 2) and the rest by name, in every list that shows them', async () => {
    // The request's example: of a, b, c and d, d is 1 and c is 2; a and b follow by name.
    expect((await setPriority(byName('d타일').id, 1)).status).toBe(200);
    expect((await setPriority(byName('c타일').id, 2)).status).toBe(200);
    const expected = ['d타일', 'c타일', 'a타일', 'b타일'];
    const library = await names({ limit: 1 });
    expect(library.map((card) => card.name)).toEqual(expected);
    expect(library.map((card) => card.priority)).toEqual([1, 2, null, null]);
    // The member drawer (wall tab) and the public list.
    expect(
      (await names({ category: 'tile', usage: 'wall', limit: 2 }, {}, member)).map((card) => card.name),
    ).toEqual(expected);
    const publicPage = (await (
      await publicMaterials(env, new Request('https://sjn.test/api/catalog/materials?category=tile'))
    ).json()) as MaterialPage<PublicMaterial>;
    expect(publicPage.items.map((item) => item.name)).toEqual(expected);
    // Other orders ignore the priority.
    expect((await names({ sort: 'name' })).map((card) => card.name)).toEqual([
      'a타일',
      'b타일',
      'c타일',
      'd타일',
    ]);
    // The same number twice: by name.
    expect((await setPriority(byName('b타일').id, 1)).status).toBe(200);
    expect((await names({})).map((card) => card.name)).toEqual(['b타일', 'd타일', 'c타일', 'a타일']);
    // Cleared: back among the unnumbered ones.
    expect((await setPriority(byName('b타일').id, null)).status).toBe(200);
    expect((await names({})).map((card) => card.name)).toEqual(expected);
  });

  it('saves a priority without a new version or a new updated_at, and only an administrator, only on shared', async () => {
    const target = byName('a타일');
    const before = await env.DB.prepare(
      'SELECT current_version_id,updated_at,(SELECT COUNT(*) FROM d1_material_versions WHERE material_id=?) AS versions FROM d1_materials WHERE id=?',
    )
      .bind(target.id, target.id)
      .first();
    const saved = await setPriority(target.id, 7);
    expect(await saved.json()).toEqual({ priority: 7 });
    expect(
      await env.DB.prepare(
        'SELECT current_version_id,updated_at,(SELECT COUNT(*) FROM d1_material_versions WHERE material_id=?) AS versions FROM d1_materials WHERE id=?',
      )
        .bind(target.id, target.id)
        .first(),
    ).toEqual(before);
    // A member, a personal material, values out of range or not whole, a missing value.
    expect((await setPriority(target.id, 3, member)).status).toBe(403);
    const personal = await tile('개인 타일', stamp, { scope: 'personal' });
    expect((await setPriority(personal.id, 3)).status).toBe(400);
    for (const value of [0, 10000, 1.5, '1', undefined])
      expect((await setPriority(target.id, value)).status, String(value)).toBe(400);
    expect(
      (await env.DB.prepare('SELECT priority FROM d1_materials WHERE id=?').bind(target.id).first())
        ?.priority,
    ).toBe(7);
    // The database refuses what the API does not send.
    await expect(
      env.DB.prepare('UPDATE d1_materials SET priority=1.5 WHERE id=?').bind(target.id).run(),
    ).rejects.toThrow();
    // An administrator project's scope cannot set one.
    await expect(
      materials(
        {
          env,
          actor: admin,
          adminProject: { id: crypto.randomUUID(), ownerId: member.id, requestId: 'order' },
        },
        { operation: 'setPriority', id: target.id, priority: 1 },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect((await setPriority(target.id, null)).status).toBe(200);
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
      JSON.stringify({
        k: 'x',
        u: '2026-10-01',
        m: tiles[0].id,
        g: 0,
        e: { size: [], color: [], finish: [] },
      }),
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

  it('is not ready on a database without 0010', async () => {
    const old = {
      DB: await mf.getD1Database('OLD'),
      ASSET_BUCKET: env.ASSET_BUCKET,
    } as unknown as D1Bindings;
    await applyD1Migrations(
      old.DB,
      allD1Migrations.slice(0, allD1Migrations.indexOf('0010_material_order.sql')),
    );
    await expect(checkD1Storage(old)).rejects.toThrow();
    await applyD1Migrations(old.DB, ['0010_material_order.sql']);
    await expect(checkD1Storage(old)).resolves.toBeUndefined();
  });
});
