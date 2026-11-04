/**
 * Migration 0014 changes what a save writes, not what anyone reads (docs/d1-write-cost-results-20261104.md):
 * the same saves through the real routes on a database at 0013 and one at 0014 (today's code on both,
 * as between a deploy and the remote migration) give byte-identical lists in every order and filter,
 * the same counts, the same administrator project drawer and the same current summary rows; an older
 * version's summary row differs in updated_at only, which nothing reads. The checks that now write a
 * row only when they fail raise the same constraint, first failure first, as the old ones; and code
 * from before this change on a 0014 database is shown where it breaks (the list image backfill) and
 * where it differs (an older version's time), which is why the code deploys first.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import sharp from 'sharp';
import { allD1Migrations, applyD1Migrations } from './helpers/d1-migrations';
import { handleD1Request } from '../src/lib/d1';
import { adminProjectMaterials } from '../src/lib/admin/projects';
import { manageCatalog } from '../src/lib/catalog/server';
import { publicMaterials } from '../src/lib/catalog/public';
import { pageSearchParams, materialSorts, type MaterialPageQuery } from '../src/lib/catalog/paging';
import type { D1Actor, D1Bindings, D1DatabaseLike } from '../src/lib/d1/types';
import type { MaterialInput, MaterialVersion } from '../src/lib/types';

const ADMIN: D1Actor = { id: 'a0000000-0000-4000-8000-000000000001', isAdmin: true };
const OWNER: D1Actor = { id: 'a0000000-0000-4000-8000-000000000002', isAdmin: false };
const PROJECT = 'b0000000-0000-4000-8000-000000000001';
const ASSET = 'c0000000-0000-4000-8000-000000000001';
const KIND = 'k-testkind01';
const before = allD1Migrations.filter((name) => name !== '0014_write_cost.sql');

let mf: Miniflare, png: Uint8Array<ArrayBuffer>;
const envs: Record<'old' | 'new', D1Bindings> = {} as never;
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("isolated")}};',
      compatibilityDate: '2026-09-07',
      d1Databases: { OLD: 'write-cost-eq-0013', NEW: 'write-cost-eq-0014' },
      r2Buckets: ['ASSET_BUCKET'],
    }),
  );
  png = new Uint8Array(
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#bbbbbb' } })
      .png()
      .toBuffer(),
  );
  const bucket = await mf.getR2Bucket('ASSET_BUCKET');
  for (const [name, migrations] of [
    ['old', before],
    ['new', allD1Migrations],
  ] as const) {
    const db = (await mf.getD1Database(name.toUpperCase())) as unknown as D1DatabaseLike;
    await applyD1Migrations(db, migrations);
    await seed(db);
    envs[name] = { DB: db, ASSET_BUCKET: bucket } as unknown as D1Bindings;
  }
}, 120_000);
afterAll(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await mf?.dispose();
});

const series = (count: number) =>
  `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${count})`;
async function seed(db: D1DatabaseLike) {
  const rows = `${series(60)}, r(i,mid,vid) AS (SELECT i,printf('10000000-0000-4000-8000-%012d',i),printf('20000000-0000-4000-8000-%012d',i) FROM n)`;
  const payload = `json_object('id',vid,'materialId',mid,'version',1,'name','타일 '||(i%7),'brand',CASE i%3 WHEN 0 THEN 'TOTO' WHEN 1 THEN '대림바스' ELSE '' END,
    'code','C-'||i,'category',CASE WHEN i%5=0 THEN 'basin' ELSE 'tile' END,'scope','shared','description','',
    'color',CASE i%3 WHEN 0 THEN '화이트' WHEN 1 THEN '그레이 · 베이지' ELSE '' END,'finish',CASE i%2 WHEN 0 THEN '무광' ELSE '유광' END,
    'widthMm',CASE i%3 WHEN 0 THEN 600 WHEN 1 THEN 300 ELSE 1200 END,'heightMm',600,'depthMm',CASE WHEN i%5=0 THEN 400 ELSE 10 END,
    'usage',CASE i%3 WHEN 0 THEN 'wall' WHEN 1 THEN 'floor' ELSE 'both' END,'installation','wall','textureAssetIds',json_array(),'views',json_array(),
    'defaultGroutWidth',2,'defaultGroutColor','#ffffff','defaultPattern','grid','createdAt','2026-10-16T00:00:00.000Z')`;
  for (const statement of [
    `${rows} INSERT INTO d1_materials(id,owner_id,scope,current_version_id,created_at,updated_at,purpose,active)
      SELECT mid,'${ADMIN.id}','shared',vid,printf('2026-09-%02d',1+i%28),printf('2026-10-16T%08d',i),'catalog',CASE WHEN i%11=0 THEN 0 ELSE 1 END FROM r`,
    `${rows} INSERT INTO d1_material_versions(id,material_id,version,payload_json,category,view_count,created_at)
      SELECT vid,mid,1,${payload},CASE WHEN i%5=0 THEN 'basin' ELSE 'tile' END,0,'2026-10-16' FROM r`,
    `INSERT INTO d1_material_version_options(version_id,option_id,option_kind)
      SELECT v.id,o.id,'brand' FROM d1_material_versions v JOIN d1_catalog_options o
      ON o.kind='brand' AND o.name=json_extract(v.payload_json,'$.brand')`,
    `INSERT INTO d1_material_kinds(code,name,normalized_name,display_order,active,builtin) VALUES('${KIND}','시험 종류','시험 종류',NULL,1,0)`,
  ])
    await db.prepare(statement).run();
  for (const actor of [ADMIN, OWNER])
    await db
      .prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
      .bind(actor.id, '회원', `${actor.id}@example.test`, 1, '2026-11-01', '2026-11-01')
      .run();
  await db.prepare('INSERT INTO admin_roles(user_id) VALUES(?)').bind(ADMIN.id).run();
  await db
    .prepare(
      `INSERT INTO d1_projects(id,owner_id,name,storage_revision,object_key,byte_size,summary_json,created_at,updated_at)
       VALUES('${PROJECT}','${OWNER.id}','시험',1,'projects/1',1,'{}','2026-11-01','2026-11-01')`,
    )
    .run();
}

const post = (path: string, body: unknown, key?: string) =>
  new Request('https://sjn.test' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Idempotency-Key': key } : {}) },
    body: JSON.stringify(body),
  });
async function option(db: D1DatabaseLike, kind: string, name: string) {
  return (await db
    .prepare('SELECT id FROM d1_catalog_options WHERE kind=? AND name=?')
    .bind(kind, name)
    .first<{ id: string }>())!.id;
}

/** Every page of a list, in order. */
async function allPages(read: (cursor?: string) => Promise<{ items: unknown[]; nextCursor: string | null }>) {
  const items: unknown[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 20; guard++) {
    const page = await read(cursor);
    items.push(page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return items;
}

/** The same saves and reads, ids and clock fixed, on one database; what every reader returns. */
async function scenario(env: D1Bindings) {
  let ids = 0;
  vi.spyOn(crypto, 'randomUUID').mockImplementation(
    () =>
      `e0000000-0000-4000-8000-${String(++ids).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`,
  );
  let clock = Date.parse('2026-11-04T01:00:00.000Z');
  const tick = () => vi.setSystemTime((clock += 60_000));
  vi.useFakeTimers({ toFake: ['Date'] });
  tick();
  const db = env.DB;
  const call = async (body: Record<string, unknown>, key: string, actor = ADMIN) => {
    tick();
    const response = await handleD1Request('materials', post('/api/d1/materials', body, key), env, actor);
    const value = await response.json();
    expect(response.status, JSON.stringify(value)).toBe(200);
    return value;
  };
  // The image (fixed id), then a shared tile with a brand, colours, a finish, a subcategory and a size.
  const form = new FormData();
  form.set('metadata', JSON.stringify({ id: ASSET, kind: 'texture', name: 'a.png' }));
  form.set('file', new Blob([png], { type: 'image/png' }), 'a.png');
  expect(
    (
      await handleD1Request(
        'assets',
        new Request('https://sjn.test/api/d1/assets', { method: 'POST', body: form }),
        env,
        ADMIN,
      )
    ).status,
  ).toBe(200);
  const sub = (await db
    .prepare(
      "SELECT id FROM d1_material_subcategories WHERE category_code='tile' AND active=1 ORDER BY id LIMIT 1",
    )
    .first<{ id: string }>())!.id;
  const toto = await option(db, 'brand', 'TOTO'),
    daelim = await option(db, 'brand', '대림바스');
  const input = (name: string, catalog: MaterialInput['catalog'], category = 'tile'): MaterialInput => ({
    name,
    brand: '',
    code: 'W-1',
    category: category as MaterialInput['category'],
    scope: 'shared',
    description: '',
    color: '',
    finish: '',
    widthMm: 600,
    heightMm: 300,
    depthMm: 9,
    usage: 'wall',
    installation: 'wall',
    coverAssetId: ASSET,
    imageAssetIds: [ASSET],
    textureAssetIds: [ASSET],
    views: [],
    defaultGroutWidth: 2,
    defaultGroutColor: '#ffffff',
    defaultPattern: 'grid',
    catalog,
  });
  const white = await option(db, 'color', '화이트'),
    grey = await option(db, 'color', '그레이'),
    beige = await option(db, 'color', '베이지'),
    matte = await option(db, 'finish', '무광'),
    gloss = await option(db, 'finish', '유광');
  let tile = (await call(
    {
      operation: 'create',
      input: input('화이트 대리석', {
        brandId: toto,
        subcategoryId: sub,
        colorIds: [white, grey],
        compositionIds: [],
        finishIds: [matte],
      }),
    },
    'create-1',
  )) as MaterialVersion;
  const versions = [tile.id];
  const edit = async (name: string, catalog: MaterialInput['catalog'], key: string) => {
    tile = (await call(
      { operation: 'update', id: tile.materialId, expectedVersionId: tile.id, input: input(name, catalog) },
      key,
    )) as MaterialVersion;
    versions.push(tile.id);
  };
  const same = {
    brandId: toto,
    subcategoryId: sub,
    colorIds: [white, grey],
    compositionIds: [],
    finishIds: [matte],
  };
  for (let n = 1; n <= 3; n++) await edit(`화이트 대리석 ${n}`, same, `edit-${n}`);
  await edit('베이지 유광', { ...same, colorIds: [beige], finishIds: [gloss] }, 'edit-facets');
  await edit(
    '베이지 유광',
    { ...same, brandId: daelim, colorIds: [beige], finishIds: [gloss] },
    'edit-brand',
  );
  await edit('옵션 없음', { colorIds: [], compositionIds: [], finishIds: [] }, 'edit-none');
  await edit('다시 화이트', same, 'edit-back');
  // Another one of an added kind, deactivated and back; the tile off; a scope moved and back (raw SQL).
  const kind = (await call(
    {
      operation: 'create',
      input: input('시험 종류 제품', { colorIds: [white], compositionIds: [], finishIds: [] }, KIND),
    },
    'create-kind',
  )) as MaterialVersion;
  await call({ operation: 'setActive', id: kind.materialId, active: false }, 'off-kind');
  await call({ operation: 'setActive', id: kind.materialId, active: true }, 'on-kind');
  await call({ operation: 'setActive', id: tile.materialId, active: false }, 'off-tile');
  tick();
  await db
    .prepare("UPDATE d1_materials SET scope='personal',updated_at=? WHERE id=?")
    .bind(new Date().toISOString(), '10000000-0000-4000-8000-000000000003')
    .run();
  tick();
  await db
    .prepare("UPDATE d1_materials SET scope='shared',updated_at=? WHERE id=?")
    .bind(new Date().toISOString(), '10000000-0000-4000-8000-000000000003')
    .run();
  // A brand's order in 분류 관리 (its versions' priority), then the tile on again and edited once more.
  tick();
  await manageCatalog(
    { env, actor: ADMIN },
    { operation: 'update', input: { id: toto, kind: 'brand', name: 'TOTO', active: true, sortOrder: 0 } },
  );
  await call({ operation: 'setActive', id: tile.materialId, active: true }, 'on-tile');
  await edit('마지막', same, 'edit-last');
  // The owner's project uses two older versions of the tile and the current one of the other.
  await db
    .prepare(
      `INSERT INTO d1_project_versions(project_id,version_id) SELECT '${PROJECT}',value FROM json_each(?)`,
    )
    .bind(JSON.stringify([versions[1], versions[4], kind.id]))
    .run();

  const out: Record<string, unknown> = {};
  const publicQueries: MaterialPageQuery[] = [
    ...materialSorts.map((sort) => ({ sort })),
    { category: 'tile', usage: 'wall' },
    { facets: { size: [], color: ['화이트'], finish: [] } },
    { category: KIND, options: true },
    { q: '대리석' },
  ];
  for (const query of publicQueries)
    out[`public ${JSON.stringify(query)}`] = await allPages(async (cursor) =>
      (
        await publicMaterials(
          env,
          new Request(
            'https://sjn.test/api/catalog/materials?' +
              pageSearchParams({ ...query, ...(cursor ? { cursor } : {}) }),
          ),
        )
      ).json(),
    );
  for (const [view, scope, active] of [
    ['library', 'all', true],
    ['library', 'all', false],
    ['picker', 'shared', true],
  ] as const)
    for (const sort of materialSorts)
      out[`admin ${view} ${scope} ${active} ${sort}`] = await allPages(
        async (cursor) =>
          (await call(
            { operation: 'page', view, scope, active, query: { sort, ...(cursor ? { cursor } : {}) } },
            `page-${view}-${scope}-${active}-${sort}-${cursor ?? ''}`,
          )) as { items: unknown[]; nextCursor: string | null },
      );
  for (const sort of materialSorts)
    out[`admin project ${sort}`] = await allPages(async (cursor) => {
      tick();
      const response = await adminProjectMaterials(
        { env, actor: ADMIN },
        post('/api/admin/project-materials', {
          projectId: PROJECT,
          operation: 'page',
          view: 'picker',
          scope: 'all',
          active: true,
          query: { sort, ...(cursor ? { cursor } : {}) },
        }),
      );
      expect(response.status).toBe(200);
      return response.json();
    });
  out.versions = await call({ operation: 'getVersions', ids: versions, withCurrent: true }, 'versions');
  out.counts = (
    await db
      .prepare(
        'SELECT * FROM d1_material_list_counts WHERE n<>0 ORDER BY active,lane,category,class,facet,value',
      )
      .all()
  ).results;
  const summary = async (table: string, current: boolean) =>
    (
      await db
        .prepare(
          `SELECT * FROM ${table} WHERE is_current=${current ? 1 : 0} ORDER BY version_id${table.endsWith('facets') ? ',facet,value' : ''}`,
        )
        .all<Record<string, unknown>>()
    ).results.map((row) => {
      if (current) return row;
      const copy = { ...row };
      delete copy.updated_at;
      return copy;
    });
  out.currentRows = await summary('d1_material_list', true);
  out.currentFacets = await summary('d1_material_list_facets', true);
  out.olderRows = await summary('d1_material_list', false);
  out.olderFacets = await summary('d1_material_list_facets', false);
  vi.useRealTimers();
  vi.restoreAllMocks();
  return out;
}

describe('0013 and 0014 give the same lists after the same saves', () => {
  it('lists in every order and filter, counts, the administrator project drawer and summary rows', async () => {
    const old = await scenario(envs.old);
    const next = await scenario(envs.new);
    expect(Object.keys(next)).toEqual(Object.keys(old));
    for (const key of Object.keys(old)) expect(next[key], key).toEqual(old[key]);
    // Not empty on either side: the counts, the tile's eight older versions and every public page.
    expect((old.counts as unknown[]).length).toBeGreaterThan(10);
    expect((old.olderRows as unknown[]).length).toBe(8);
    expect((old.olderFacets as unknown[]).length).toBeGreaterThan(9);
    const pages = old['public {"sort":"priority"}'] as unknown[][];
    expect(pages.flat().length).toBeGreaterThan(48);
    // The drawer lists the project's older versions (and their time is the material's).
    expect(JSON.stringify(old['admin project priority'])).toContain('e0000000');
  }, 300_000);
});

describe('the checks fail as before', () => {
  const oldCheck = (kind: string, expression: string) =>
    `INSERT INTO d1_checks(id,${kind}_ok) SELECT ?,CASE WHEN (${expression}) THEN 1 ELSE 0 END`;
  const newCheck = (kind: string, expression: string) =>
    `INSERT INTO d1_checks(id,${kind}_ok) SELECT ?,0 WHERE NOT coalesce((${expression}),0)`;
  const oldAdmin = (kind: string, expression: string) =>
    `INSERT INTO d1_admin_checks(id,${kind}_ok) SELECT ?,CASE WHEN (${expression}) THEN 1 ELSE 0 END`;
  const newAdmin = (kind: string, expression: string) =>
    `INSERT INTO d1_admin_checks(id,${kind}_ok) SELECT ?,0 WHERE NOT coalesce((${expression}),0)`;
  /** The constraint a batch stops on, or 'ok'; whatever it stops on, nothing is left behind. */
  async function outcome(db: D1DatabaseLike, statements: string[]) {
    try {
      await db.batch([
        ...statements.map((sql, i) => db.prepare(sql).bind(`check-${i}`)),
        db.prepare('DELETE FROM d1_checks'),
        db.prepare('DELETE FROM d1_admin_checks'),
      ]);
      return 'ok';
    } catch (error) {
      return String(error).match(/d1_(conflict|reference|admin_\w+)/)?.[0] ?? String(error);
    } finally {
      expect(await db.prepare('SELECT COUNT(*) AS n FROM d1_checks').first()).toEqual({ n: 0 });
    }
  }
  it('stops on the same constraint, the first failing check first, NULL as a failure', async () => {
    const db = envs.new.DB;
    const cases: [string, string][][] = [
      [['conflict', '1']],
      [['conflict', '0']],
      [['reference', 'NULL']],
      [
        ['reference', '1'],
        ['conflict', '0'],
      ],
      [
        ['reference', '0'],
        ['conflict', '0'],
      ],
      [
        ['conflict', '0'],
        ['reference', '0'],
      ],
      [['reference', "EXISTS(SELECT 1 FROM d1_materials WHERE id='none')"]],
      [
        ['admin:access', '1'],
        ['conflict', '0'],
      ],
      [
        ['admin:access', '0'],
        ['conflict', '0'],
      ],
      [
        ['admin:revision', '0'],
        ['admin:self', '0'],
      ],
    ];
    for (const checks of cases) {
      const build = (old: boolean) =>
        checks.map(([kind, expression]) =>
          kind.startsWith('admin:')
            ? (old ? oldAdmin : newAdmin)(kind.slice(6), expression)
            : (old ? oldCheck : newCheck)(kind, expression),
        );
      expect(await outcome(db, build(false)), JSON.stringify(checks)).toBe(await outcome(db, build(true)));
    }
  });
  it('writes no row for a check that holds', async () => {
    const result = await envs.new.DB.prepare(newCheck('conflict', '1')).bind('x').run();
    expect(result.meta.rows_written).toBe(0);
  });
});

describe('code from before this change on a 0014 database', () => {
  it('the old list image backfill names a dropped index: deploy the code first', async () => {
    await expect(
      envs.new.DB.prepare(
        `SELECT l.material_id FROM d1_material_list l INDEXED BY d1_list_recent WHERE l.active=1 AND l.is_current=1 AND l.scope='shared' LIMIT 1`,
      ).all(),
    ).rejects.toThrow(/no such index/);
  });
  it('the old reads of an older version time differ only there (the drawer card time)', async () => {
    const row = await envs.new.DB.prepare(
      `SELECT l.updated_at AS old_read,
         CASE WHEN l.is_current THEN l.updated_at ELSE (SELECT m.updated_at FROM d1_materials m WHERE m.id=l.material_id) END AS new_read
       FROM d1_material_list l WHERE l.is_current=0 AND l.material_id=(SELECT material_id FROM d1_material_list WHERE version=9 LIMIT 1)
       ORDER BY l.version LIMIT 1`,
    ).first<{ old_read: string; new_read: string }>();
    expect(row && row.old_read < row.new_read).toBe(true);
  });
});
