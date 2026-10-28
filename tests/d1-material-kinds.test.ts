import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import sharp from 'sharp';
import { handleD1Request, checkD1Storage } from '../src/lib/d1';
import type { D1Bindings, D1DatabaseLike, D1Resource } from '../src/lib/d1/types';
import { publicMaterials, publicPlacement } from '../src/lib/catalog/public';
import { readCatalog, readKinds } from '../src/lib/catalog/server';
import type { MaterialPage } from '../src/lib/catalog/paging';
import type { MaterialKindRow } from '../src/lib/material-kinds';
import type { MaterialInput, MaterialVersion } from '../src/lib/types';
import { allD1Migrations, applyD1Migrations, migrationStatements } from './helpers/d1-migrations';
import { meterD1 } from './helpers/d1-meter';

/**
 * 위생도기 kinds an administrator manages (migration 0012, docs/fixture-kinds-results-20261028.md): the
 * kinds list, 분류 관리 (admin only, names, order, use, delete rules), a material's kind check, the
 * lists' first pages carrying the kinds, the 0012 upgrade and its cost (d1-query-budget).
 */
let mf: Miniflare;
let env: D1Bindings;
let png: Uint8Array<ArrayBuffer>;
const admin = { id: crypto.randomUUID(), isAdmin: true };
const member = { id: crypto.randomUUID(), isAdmin: false };
const stamp = '2026-10-28T00:00:00.000Z';
function call(resource: D1Resource, body: unknown, actor = admin) {
  return handleD1Request(
    resource,
    new Request(`https://sjn.test/api/d1/${resource}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
    actor,
  );
}
const kinds = () => readKinds(env.DB);
const kindNamed = async (name: string) => (await kinds()).find((row) => row.name === name)!;
async function saveKind(input: Record<string, unknown>, actor = admin) {
  return call(
    'catalog',
    {
      operation: input.code ? 'update' : 'create',
      input: { kind: 'materialKind', active: true, sortOrder: null, ...input },
    },
    actor,
  );
}
async function upload() {
  const id = crypto.randomUUID();
  const data = new FormData();
  data.set('metadata', JSON.stringify({ id, name: 'p.png', kind: 'product' }));
  data.set('file', new Blob([png], { type: 'image/png' }), 'p.png');
  const response = await handleD1Request(
    'assets',
    new Request('https://sjn.test/api/d1/assets', { method: 'POST', body: data }),
    env,
    admin,
  );
  expect(response.status).toBe(200);
  return id;
}
async function material(category: string, name = '종류 자재'): Promise<MaterialInput> {
  const assetId = await upload();
  return {
    name,
    brand: '',
    code: '',
    category: category as MaterialInput['category'],
    scope: 'shared',
    description: '',
    color: '',
    finish: '',
    widthMm: 600,
    heightMm: 80,
    depthMm: 120,
    usage: 'both',
    installation: 'wall',
    textureAssetIds: [],
    views: [{ assetId, direction: '정면', anchor: { x: 0.5, y: 0.5 } }],
    defaultGroutWidth: 2,
    defaultGroutColor: '#ffffff',
    defaultPattern: 'grid',
    catalog: { colorIds: [], compositionIds: [], finishIds: [] },
  };
}
const createMaterial = (input: MaterialInput) => call('materials', { operation: 'create', input });

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("local test")}};',
      compatibilityDate: '2026-09-07',
      d1Databases: { DB: 'kinds-test', UPGRADE: 'kinds-upgrade-test' },
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
      .bind(actor.id, '종류 시험 회원', actor.id + '@example.test', 1, stamp, stamp)
      .run();
  await env.DB.prepare('INSERT INTO admin_roles(user_id) VALUES(?)').bind(admin.id).run();
  png = new Uint8Array(
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#aaccff' } })
      .png()
      .toBuffer(),
  );
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

describe('migration 0012', { timeout: 60000 }, () => {
  it('adds the built-in kinds in their order (기타 last) and the readiness check needs the table', async () => {
    await expect(checkD1Storage(env)).resolves.toBeUndefined();
    const rows = await kinds();
    expect(rows.map((row) => row.name)).toEqual([
      '변기',
      '세면대',
      '하부장',
      '욕조',
      '샤워 설비',
      '수전',
      '거울',
      '유리 파티션',
      '거울 수납장',
      '벽 선반',
      '벽 수납장',
      '낮은 칸막이',
      '기타',
    ]);
    expect(rows.every((row) => row.builtin && row.active)).toBe(true);
    for (const code of ['tile', 'door', 'window', 'showerCurtain'])
      expect(rows.some((row) => row.code === code)).toBe(false);
  });

  it('upgrades a 0011 database without touching a material or list row; cost of the migration', async () => {
    const db = (await mf.getD1Database('UPGRADE')) as unknown as D1DatabaseLike;
    await applyD1Migrations(db, allD1Migrations.slice(0, -1));
    // A material straight into the 0011 tables (the triggers fill the list summary).
    const payload = (id: string, materialId: string) =>
      JSON.stringify({
        id,
        materialId,
        version: 1,
        name: '옛 세면대',
        brand: '',
        code: '',
        category: 'basin',
        scope: 'shared',
        usage: 'both',
        installation: 'wall',
        textureAssetIds: [],
        views: [],
      });
    for (let i = 0; i < 3; i++) {
      const materialId = crypto.randomUUID(),
        versionId = crypto.randomUUID();
      await db.batch([
        db
          .prepare(
            "INSERT INTO d1_materials(id,owner_id,scope,current_version_id,created_at,updated_at,purpose) VALUES(?,?,'shared',?,?,?,'catalog')",
          )
          .bind(materialId, admin.id, versionId, stamp, stamp),
        db
          .prepare(
            "INSERT INTO d1_material_versions(id,material_id,version,payload_json,category,view_count,created_at) VALUES(?,?,1,?,'basin',0,?)",
          )
          .bind(versionId, materialId, payload(versionId, materialId), stamp),
      ]);
    }
    const snapshot = async () =>
      JSON.stringify([
        (await db.prepare('SELECT * FROM d1_material_versions ORDER BY id').all()).results,
        (await db.prepare('SELECT * FROM d1_material_list ORDER BY version_id').all()).results,
      ]);
    const before = await snapshot();
    await expect(checkD1Storage({ ...env, DB: db } as D1Bindings)).rejects.toThrow(/incomplete/);
    // Before 0012 the lists use the built-in kinds.
    expect((await readKinds(db)).map((row) => row.code)).toEqual((await kinds()).map((row) => row.code));
    const meter = meterD1(db);
    for (const statement of migrationStatements(
      await readFile('migrations/d1/0012_material_kinds.sql', 'utf8'),
    ))
      await meter.db.prepare(statement).run();
    const cost = meter.summary();
    console.log(
      `0012: queries ${cost.queries}, rows read ${cost.rowsRead}, rows written ${cost.rowsWritten}`,
    );
    expect(cost.rowsWritten).toBeLessThanOrEqual(60);
    expect(await snapshot()).toBe(before);
    await expect(checkD1Storage({ ...env, DB: db } as D1Bindings)).resolves.toBeUndefined();
  });
});

describe('분류 관리: 위생도기 종류', { timeout: 60000 }, () => {
  it('is for administrators only', async () => {
    expect((await saveKind({ name: '회원 종류' }, member)).status).toBe(403);
    expect(
      (await call('catalog', { operation: 'delete', input: { code: 'k-0123456789' } }, member)).status,
    ).toBe(403);
  });

  it('adds a kind; a name another kind (or 타일·문·창·샤워 커튼) has is 409', async () => {
    const response = await saveKind({ name: '수건걸이', sortOrder: 3 });
    expect(response.status, await response.clone().text()).toBe(200);
    const { id } = (await response.json()) as { id: string };
    expect(id).toMatch(/^k-[a-z0-9]{10}$/);
    const row = await kindNamed('수건걸이');
    expect(row).toMatchObject({ code: id, displayOrder: 3, active: true, builtin: false });
    for (const name of ['수건걸이', ' 수건걸이 ', '변기', '문', '창', '타일', '샤워 커튼'])
      expect((await saveKind({ name })).status, name).toBe(409);
  });

  it('changes a built-in kind’s order and use only; 기타 stays last without an order', async () => {
    expect((await saveKind({ code: 'mirror', name: '큰 거울', sortOrder: 1 })).status).toBe(400);
    expect((await saveKind({ code: 'mirror', name: '거울', sortOrder: 0 })).status).toBe(200);
    expect((await saveKind({ code: 'other', name: '기타', sortOrder: 0 })).status).toBe(200);
    const rows = await kinds();
    expect(rows.at(-1)).toMatchObject({ code: 'other', displayOrder: null });
    expect(rows.find((row) => row.code === 'mirror')).toMatchObject({ name: '거울', displayOrder: 0 });
    expect((await saveKind({ code: 'k-zzzzzzzzzz', name: '없는 종류' })).status).toBe(404);
  });

  it('a material takes a kind in use; a hidden kind keeps its materials editable; 문·창 pass as before', async () => {
    const towel = await kindNamed('수건걸이');
    const created = await createMaterial(await material(towel.code, '수건걸이 A'));
    expect(created.status, await created.clone().text()).toBe(200);
    const saved = (await created.json()) as MaterialVersion;
    expect(saved.category).toBe(towel.code);
    // An unknown added code is refused.
    expect((await createMaterial(await material('k-unknown000'))).status).toBe(400);
    expect((await createMaterial(await material('k-Bad'))).status).toBe(400);
    // Hidden: no new material, but the one that has it can still be changed.
    expect((await saveKind({ code: towel.code, name: '수건걸이', active: false })).status).toBe(200);
    expect((await createMaterial(await material(towel.code))).status).toBe(400);
    const update = await call('materials', {
      operation: 'update',
      id: saved.materialId,
      expectedVersionId: saved.id,
      input: { ...(await material(towel.code, '수건걸이 A 수정')) },
    });
    expect(update.status, await update.clone().text()).toBe(200);
    // A hidden built-in kind the same way; the kinds no one picks pass as before.
    expect((await saveKind({ code: 'faucet', name: '수전', active: false })).status).toBe(200);
    expect((await createMaterial(await material('faucet'))).status).toBe(400);
    expect((await saveKind({ code: 'faucet', name: '수전', active: true })).status).toBe(200);
    expect((await createMaterial(await material('window', '옛 창'))).status).toBe(200);
    // An added kind has no subcategories.
    expect(
      (
        await call('catalog', {
          operation: 'create',
          input: {
            kind: 'subcategory',
            category: towel.code,
            name: '수건걸이 분류',
            active: true,
            sortOrder: null,
          },
        })
      ).status,
    ).toBe(400);
    expect((await saveKind({ code: towel.code, name: '수건걸이', active: true })).status).toBe(200);
  });

  it('deletes only an added kind no material has', async () => {
    const towel = await kindNamed('수건걸이');
    expect((await call('catalog', { operation: 'delete', input: { code: towel.code } })).status).toBe(409);
    expect((await call('catalog', { operation: 'delete', input: { code: 'basin' } })).status).toBe(400);
    const { id } = (await (await saveKind({ name: '빈 종류' })).json()) as { id: string };
    expect((await call('catalog', { operation: 'delete', input: { code: id } })).status).toBe(200);
    expect((await kinds()).some((row) => row.code === id)).toBe(false);
  });
});

describe('the lists carry the kinds and filter by an added kind', { timeout: 60000 }, () => {
  it('first pages (member, guest, public, library) carry the kinds; a kind’s page has its materials', async () => {
    const towel = await kindNamed('수건걸이');
    const member = (await (
      await call('materials', { operation: 'page', query: { category: towel.code, options: true } })
    ).json()) as MaterialPage<{ name: string }>;
    expect(member.items.map((item) => item.name)).toEqual(['수건걸이 A 수정']);
    expect(member.kinds?.map((row: MaterialKindRow) => row.code)).toContain(towel.code);
    const guest = (await (
      await publicPlacement(
        env,
        new Request(`https://sjn.test/api/catalog/placement?category=${towel.code}&options=1`),
      )
    ).json()) as { placements: unknown[]; kinds?: MaterialKindRow[] };
    expect(guest.placements).toHaveLength(1);
    expect(guest.kinds?.at(-1)?.code).toBe('other');
    const open = (await (
      await publicMaterials(env, new Request('https://sjn.test/api/catalog/materials?options=1'))
    ).json()) as MaterialPage<unknown>;
    expect(open.kinds).toBeTruthy();
    const library = (await (
      await call('materials', { operation: 'page', view: 'library', query: {} })
    ).json()) as MaterialPage<unknown>;
    expect(library.kinds).toBeTruthy();
    // A next page carries none.
    const next = (await (
      await call('materials', { operation: 'page', query: { category: 'fixtures', options: true, limit: 1 } })
    ).json()) as MaterialPage<unknown>;
    if (next.nextCursor) {
      const second = (await (
        await call('materials', {
          operation: 'page',
          query: { category: 'fixtures', limit: 1, cursor: next.nextCursor },
        })
      ).json()) as MaterialPage<unknown>;
      expect(second.kinds).toBeUndefined();
    }
    expect((await readCatalog(env.DB)).kinds?.length).toBeGreaterThan(0);
  });

  it('reads the kinds with one query of a fixed number of rows (d1-query-budget)', async () => {
    const meter = meterD1(env.DB);
    await readKinds(meter.db);
    const read = meter.summary();
    expect(read.queries).toBe(1);
    expect(read.rowsRead).toBeLessThanOrEqual(20);
    // A kind's save and an empty kind's delete write a handful of rows.
    meter.reset();
    const saveEnv = { ...env, DB: meter.db } as D1Bindings;
    const response = await handleD1Request(
      'catalog',
      new Request('https://sjn.test/api/d1/catalog', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operation: 'create',
          input: { kind: 'materialKind', name: '측정 종류', active: true, sortOrder: null },
        }),
      }),
      saveEnv,
      admin,
    );
    expect(response.status).toBe(200);
    const save = meter.summary();
    console.log(`kind save: queries ${save.queries}, read ${save.rowsRead}, written ${save.rowsWritten}`);
    expect(save.rowsWritten).toBeLessThanOrEqual(10);
    const { id } = (await response.json()) as { id: string };
    meter.reset();
    const removed = await handleD1Request(
      'catalog',
      new Request('https://sjn.test/api/d1/catalog', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'delete', input: { code: id } }),
      }),
      saveEnv,
      admin,
    );
    expect(removed.status).toBe(200);
    const drop = meter.summary();
    console.log(`kind delete: queries ${drop.queries}, read ${drop.rowsRead}, written ${drop.rowsWritten}`);
    expect(drop.rowsWritten).toBeLessThanOrEqual(10);
    // The used-kind check reads 0012's partial index (no scan of the versions).
    const plan = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT 1 FROM d1_material_versions WHERE substr(category,1,2)='k-' AND category=? LIMIT 1",
    )
      .bind(id)
      .all<{ detail: string }>();
    expect(plan.results.map((row) => row.detail).join(' ')).toContain('d1_versions_added_kind');
  });
});
