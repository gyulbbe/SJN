/**
 * D1 cost of the paged material lists (d1-query-budget): rows read and queries per request at a base
 * size N and at 5N, with the same page size; the query plans (no SCAN of a growing table); the rows a
 * save writes; and the two ways to search (a range scan, and FTS5 for comparison).
 *
 * The regular run uses a small N; the remote shape of 2026-10-17 (930 tiles, 30 products) runs with
 *
 *   SJN_D1_COST=1 npx vitest run tests/d1-material-paging-cost.test.ts
 *
 * Results: test-results/material-paging-cost.json, docs/material-paging-results-20261022.md.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { applyD1Migrations, allD1Migrations } from './helpers/d1-migrations';
import { meterD1, type D1QueryRecord } from './helpers/d1-meter';
import { materials } from '../src/lib/d1/materials';
import { publicImage, publicMaterials, publicPlacement } from '../src/lib/catalog/public';
import { pageSearchParams, type MaterialPage, type MaterialPageQuery } from '../src/lib/catalog/paging';
import type { Context } from '../src/lib/d1/database';
import type { D1Bindings, D1DatabaseLike, D1Statement } from '../src/lib/d1/types';

const FULL = !!process.env.SJN_D1_COST;
const BASE = FULL ? { tiles: 930, products: 30 } : { tiles: 180, products: 20 };
const MEMBER = 'member-1',
  ADMIN = 'admin-1',
  EDITOR = 'admin-2';
const PROJECT = 'd0000000-0000-4000-8000-000000000001';
const series = (count: number) =>
  `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${count})`;
const id = (prefix: string, i: number | string) =>
  typeof i === 'number' ? `${prefix}0000000-0000-4000-8000-${String(i).padStart(12, '0')}` : i;
/** Catalogue rows with fixed value pools: the facet options do not grow with the catalogue. */
function catalogue(
  prefix: { material: string; version: string; asset: string },
  count: number,
  kind: 'tile' | 'basin',
  offset: number,
) {
  const rows = `${series(count)}, r(i,mid,vid,aid) AS (SELECT i+${offset},
    printf('${prefix.material}0000000-0000-4000-8000-%012d',i+${offset}),
    printf('${prefix.version}0000000-0000-4000-8000-%012d',i+${offset}),
    printf('${prefix.asset}0000000-0000-4000-8000-%012d',i+${offset}) FROM n)`;
  const payload = `json_object('id',vid,'materialId',mid,'version',1,'name',CASE i%4 WHEN 0 THEN 'Stone '||i ELSE '포세린 타일 '||i END,
    'brand',CASE i%3 WHEN 0 THEN 'TOTO' WHEN 1 THEN '대림바스' ELSE '' END,'code','C-'||i,'category','${kind}','scope','shared',
    'description','','color',CASE i%5 WHEN 0 THEN '화이트' WHEN 1 THEN '그레이 · 베이지' WHEN 2 THEN '차콜' WHEN 3 THEN '블루' ELSE '아이보리' END,
    'finish',CASE i%3 WHEN 0 THEN '무광' WHEN 1 THEN '유광' ELSE '반광' END,
    'widthMm',CASE i%6 WHEN 0 THEN 600 WHEN 1 THEN 300 WHEN 2 THEN 1200 WHEN 3 THEN 400 WHEN 4 THEN 200 ELSE 800 END,
    'heightMm',CASE i%4 WHEN 0 THEN 600 WHEN 1 THEN 1200 WHEN 2 THEN 300 ELSE 900 END,'depthMm',${kind === 'tile' ? 10 : 400},
    'usage',CASE i%3 WHEN 0 THEN 'wall' WHEN 1 THEN 'floor' ELSE 'both' END,'installation','wall',
    'textureAssetIds',${kind === 'tile' ? 'json_array(aid)' : 'json_array()'},
    'views',${kind === 'tile' ? 'json_array()' : "json_array(json_object('assetId',aid,'direction','정면','anchor',json_object('x',0.5,'y',1)))"},
    'defaultGroutWidth',2,'defaultGroutColor','#ffffff','defaultPattern','grid','createdAt','2026-10-16T00:00:00.000Z')`;
  return [
    `${rows} INSERT INTO d1_assets(id,owner_id,object_key,metadata_json,content_hash,created_at)
      SELECT aid,'${ADMIN}','assets/'||aid,json_object('kind','${kind === 'tile' ? 'texture' : 'product'}','mime','image/png','width',100,'height',100,'size',1000),'hash','2026-10-16' FROM r`,
    `${rows} INSERT INTO d1_materials(id,owner_id,scope,current_version_id,created_at,updated_at,purpose,active)
      SELECT mid,'${ADMIN}','shared',vid,'2026-10-16',printf('2026-10-16T%08d',i),'catalog',CASE WHEN i%17=0 THEN 0 ELSE 1 END FROM r`,
    `${rows} INSERT INTO d1_material_versions(id,material_id,version,payload_json,category,view_count,created_at)
      SELECT vid,mid,1,${payload},'${kind}',${kind === 'tile' ? 0 : 1},'2026-10-16' FROM r`,
    `${rows} INSERT INTO d1_material_assets(version_id,asset_id) SELECT vid,aid FROM r`,
  ];
}
let mf: Miniflare | undefined;
afterAll(async () => mf?.dispose());
async function database(name: string, scale: number, migrations = allD1Migrations): Promise<D1DatabaseLike> {
  mf ??= new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response(null, { status: 404 }); } };',
      compatibilityDate: '2026-09-07',
      d1Databases: { SCALE1: 'paging-cost-1', SCALE5: 'paging-cost-5', BEFORE: 'paging-cost-before' },
    }),
  );
  const db = (await mf.getD1Database(name)) as unknown as D1DatabaseLike;
  await applyD1Migrations(db, migrations);
  if (!scale) return db;
  const tiles = BASE.tiles * scale,
    products = BASE.products * scale;
  const statements = [
    ...catalogue({ material: '1', version: '2', asset: '3' }, tiles, 'tile', 0),
    ...catalogue({ material: '4', version: '5', asset: '6' }, products, 'basin', 0),
    // Other owners' personal materials (the member reads only their own) and the member's own few.
    `${series(20 * scale)} INSERT INTO d1_materials(id,owner_id,scope,current_version_id,created_at,updated_at,purpose)
      SELECT printf('70000000-0000-4000-8000-%012d',i),'member-'||(2+i%3),'personal',printf('80000000-0000-4000-8000-%012d',i),'2026-10-16',printf('2026-10-17T%08d',i),'project' FROM n`,
    `${series(20 * scale)} INSERT INTO d1_material_versions(id,material_id,version,payload_json,category,view_count,created_at)
      SELECT printf('80000000-0000-4000-8000-%012d',i),printf('70000000-0000-4000-8000-%012d',i),1,
        json_object('name','개인 '||i,'brand','','code','P-'||i,'category','basin','scope','personal','color','','finish','','widthMm',500,'heightMm',400,'depthMm',300,'textureAssetIds',json_array(),'views',json_array()),'basin',0,'2026-10-16' FROM n`,
    `${series(5)} INSERT INTO d1_materials(id,owner_id,scope,current_version_id,created_at,updated_at,purpose)
      SELECT printf('90000000-0000-4000-8000-%012d',i),'${MEMBER}','personal',printf('a0000000-0000-4000-8000-%012d',i),'2026-10-16',printf('2026-10-18T%08d',i),'project' FROM n`,
    `${series(5)} INSERT INTO d1_material_versions(id,material_id,version,payload_json,category,view_count,created_at)
      SELECT printf('a0000000-0000-4000-8000-%012d',i),printf('90000000-0000-4000-8000-%012d',i),1,
        json_object('name','내 모형 '||i,'brand','','code','R-'||i,'category','tile','usage','wall','scope','personal','color','화이트','finish','무광','widthMm',300,'heightMm',600,'depthMm',10,'textureAssetIds',json_array(),'views',json_array()),'tile',0,'2026-10-16' FROM n`,
    `INSERT INTO d1_projects(id,owner_id,name,storage_revision,object_key,byte_size,summary_json,created_at,updated_at)
      VALUES('${PROJECT}','${MEMBER}','시험',1,'projects/1',1,'{}','2026-10-16','2026-10-16')`,
    `${series(10)} INSERT INTO d1_project_versions(project_id,version_id) SELECT '${PROJECT}',printf('20000000-0000-4000-8000-%012d',i*7) FROM n`,
    `${series(3)} INSERT INTO d1_project_versions(project_id,version_id) SELECT '${PROJECT}',printf('a0000000-0000-4000-8000-%012d',i) FROM n`,
  ];
  for (const statement of statements) await db.prepare(statement).run();
  return db;
}

type Cost = {
  queries: number;
  rowsRead: number;
  rowsWritten: number;
  items: number;
  records: D1QueryRecord[];
};
/** A plan line reading a whole growing table (by alias or name); json_each, CTE and subquery scans are fine. */
const GROWING = /\bSCAN (l|f|x|s|m|v|a|r|c|cv|cm|d1_\w+)\b/;
/** Runs `call` on a metered D1 and checks every statement's plan with the same bound values. */
async function measure(
  db: D1DatabaseLike,
  call: (env: D1Bindings) => Promise<number>,
  plans: Map<string, string[]>,
): Promise<Cost> {
  const meter = meterD1(db);
  const bound: { sql: string; values: unknown[] }[] = [];
  const watch = (statement: D1Statement, sql: string): D1Statement =>
    new Proxy(statement, {
      get(target, prop) {
        if (prop === 'bind')
          return (...next: unknown[]) => {
            bound.push({ sql, values: next });
            return watch(target.bind(...next), sql);
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  const planned = new Proxy(meter.db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => watch(target.prepare(sql), sql);
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const items = await call({
    DB: planned,
    ASSET_BUCKET: { get: async () => ({ body: 'x' }) },
  } as unknown as D1Bindings);
  for (const { sql, values } of bound) {
    const key = sql.replace(/\s+/g, ' ').slice(0, 400);
    if (plans.has(key)) continue;
    const plan = (
      await db
        .prepare('EXPLAIN QUERY PLAN ' + sql)
        .bind(...values)
        .all<{ detail: string }>()
    ).results.map((row) => row.detail);
    plans.set(key, plan);
  }
  const summary = meter.summary();
  return {
    queries: summary.queries,
    rowsRead: summary.rowsRead,
    rowsWritten: summary.rowsWritten,
    items,
    records: meter.records,
  };
}
const publicPage = (query: MaterialPageQuery) => async (env: D1Bindings) => {
  const response = await publicMaterials(
    env,
    new Request('https://sjn.test/api/catalog/materials?' + pageSearchParams(query)),
  );
  const page = (await response.json()) as MaterialPage<unknown>;
  lastCursor = page.nextCursor;
  return page.items.length;
};
const guestPage = (query: MaterialPageQuery) => async (env: D1Bindings) => {
  const response = await publicPlacement(
    env,
    new Request('https://sjn.test/api/catalog/placement?' + pageSearchParams(query)),
  );
  const page = (await response.json()) as { placements: unknown[]; nextCursor: string | null };
  lastCursor = page.nextCursor;
  return page.placements.length;
};
let lastCursor: string | null = null;
const memberPage =
  (actor: Context['actor'], body: Record<string, unknown>, adminProject?: Context['adminProject']) =>
  async (env: D1Bindings) => {
    const page = (await materials(
      { env, actor, ...(adminProject ? { adminProject } : {}) },
      { operation: 'page', ...body },
    )) as MaterialPage<unknown>;
    lastCursor = page.nextCursor;
    return page.items.length;
  };

/**
 * `page`: a list page (rows follow the page); `filtered`: the first page of a search or facet filter,
 * which reads every matching key once to count them (rows follow the matches; documented);
 * `single`: one request for given ids.
 */
type Path = {
  name: string;
  kind: 'page' | 'filtered' | 'single';
  run: (db: D1DatabaseLike, plans: Map<string, string[]>) => Promise<Cost>;
};
const member = { id: MEMBER, isAdmin: false },
  admin = { id: ADMIN, isAdmin: true },
  editor = { id: EDITOR, isAdmin: true };
const project = { id: PROJECT, ownerId: MEMBER, requestId: 'cost' };
/**
 * A first page, then the page after it (same query and cursor). Pages of 8 so that the small scale
 * has a second page too; the full page (48) is measured by the paths that pass no limit.
 */
const twoPages = (
  name: string,
  make: (query: MaterialPageQuery) => (env: D1Bindings) => Promise<number>,
  base: MaterialPageQuery,
  first: Path['kind'] = 'page',
): Path[] => {
  const query = { ...base, limit: 8 };
  return [
    { name: name + ' · 첫 쪽', kind: first, run: (db, plans) => measure(db, make(query), plans) },
    {
      name: name + ' · 다음 쪽',
      kind: 'page',
      run: async (db, plans) => {
        await measure(db, make(query), new Map());
        if (!lastCursor) throw new Error(name + ': no second page');
        return measure(db, make({ ...query, options: undefined, cursor: lastCursor }), plans);
      },
    },
  ];
};
const PATHS: Path[] = [
  {
    name: '공개 전체 · 첫 쪽 48',
    kind: 'page',
    run: (db, p) => measure(db, publicPage({ options: true }), p),
  },
  {
    name: '회원 바닥 탭 · 첫 쪽 48',
    kind: 'page',
    run: (db, p) =>
      measure(db, memberPage(member, { query: { category: 'tile', usage: 'floor', options: true } }), p),
  },
  {
    name: '게스트 바닥 탭 · 첫 쪽 48',
    kind: 'page',
    run: (db, p) => measure(db, guestPage({ category: 'tile', usage: 'floor', options: true }), p),
  },
  {
    name: '관리자 자재 · 첫 쪽 48',
    kind: 'page',
    run: (db, p) => measure(db, memberPage(admin, { query: {}, view: 'library' }), p),
  },
  ...twoPages('공개 전체', publicPage, { options: true }),
  ...twoPages('공개 타일', publicPage, { category: 'tile' }),
  ...twoPages('공개 세면대', publicPage, { category: 'basin' }),
  ...twoPages(
    '공개 분류 1개(사이즈)',
    publicPage,
    { facets: { size: ['600X600'], color: [], finish: [] } },
    'filtered',
  ),
  {
    name: '공개 분류 2그룹',
    kind: 'filtered',
    run: (db, p) =>
      measure(db, publicPage({ facets: { size: ['600X600', '300X1200'], color: ['차콜'], finish: [] } }), p),
  },
  { name: '공개 검색(드묾)', kind: 'filtered', run: (db, p) => measure(db, publicPage({ q: 'stone 4' }), p) },
  ...twoPages('공개 검색(흔함)', publicPage, { q: '타일' }, 'filtered'),
  ...twoPages('게스트 벽 탭', guestPage, { category: 'tile', usage: 'wall', options: true }),
  ...twoPages('회원 벽 탭', (q) => memberPage(member, { query: q }), {
    category: 'tile',
    usage: 'wall',
    options: true,
  }),
  ...twoPages('회원 위생도기 탭', (q) => memberPage(member, { query: q }), {
    category: 'fixtures',
    options: true,
  }),
  ...twoPages(
    '회원 분류 1개',
    (q) => memberPage(member, { query: q }),
    { category: 'tile', usage: 'floor', facets: { size: [], color: ['화이트'], finish: [] } },
    'filtered',
  ),
  {
    name: '회원 검색',
    kind: 'filtered',
    run: (db, p) =>
      measure(db, memberPage(member, { query: { category: 'tile', usage: 'floor', q: 'stone' } }), p),
  },
  ...twoPages('관리자 자재 전체', (q) => memberPage(admin, { query: q, view: 'library' }), {}),
  ...twoPages(
    '관리자 자재 비활성',
    (q) => memberPage(admin, { query: q, view: 'library', active: false }),
    {},
  ),
  ...twoPages('관리자 프로젝트 벽 탭', (q) => memberPage(editor, { query: q }, project), {
    category: 'tile',
    usage: 'wall',
    options: true,
  }),
  {
    name: '회원 getVersions 20개',
    kind: 'single',
    run: (db, p) =>
      measure(
        db,
        async (env) =>
          (
            (await materials(
              { env, actor: member },
              {
                operation: 'getVersions',
                withCurrent: true,
                ids: Array.from({ length: 20 }, (_, i) => id('2', i * 3 + 1)),
              },
            )) as { versions: unknown[] }
          ).versions.length,
        p,
      ),
  },
  {
    name: '관리자 프로젝트 getVersions 20개',
    kind: 'single',
    run: (db, p) =>
      measure(
        db,
        async (env) =>
          (
            (await materials(
              { env, actor: editor, adminProject: project },
              {
                operation: 'getVersions',
                withCurrent: true,
                ids: Array.from({ length: 20 }, (_, i) => id('2', i * 7 + 7)),
              },
            )) as { versions: unknown[] }
          ).versions.length,
        p,
      ),
  },
  {
    name: '회원 find(재구성 코드)',
    kind: 'single',
    run: (db, p) =>
      measure(
        db,
        async (env) => {
          await materials(
            { env, actor: member },
            { operation: 'find', match: { code: 'R-3', reconstruction: { kind: 'tile' } } },
          );
          return 1;
        },
        p,
      ),
  },
  {
    name: '관리자 프로젝트 find',
    kind: 'single',
    run: (db, p) =>
      measure(
        db,
        async (env) => {
          await materials(
            { env, actor: editor, adminProject: project },
            { operation: 'find', match: { code: 'R-3', reconstruction: { version: 2 } } },
          );
          return 1;
        },
        p,
      ),
  },
  {
    name: '공개 이미지 1장',
    kind: 'single',
    run: (db, p) =>
      measure(
        db,
        async (env) => {
          await publicImage(env, new Request('https://sjn.test/api/catalog/images?id=' + id('3', 7)));
          return 1;
        },
        p,
      ),
  },
];

/**
 * Rows one save writes: a new material (material, then version), its next version, (de)activation.
 * The same statements as materials.ts, run as one batch each.
 */
async function saveWrites(db: D1DatabaseLike, label: string) {
  const results: Record<string, Omit<Cost, 'records'>> = {};
  const meter = meterD1(db);
  const writes = async (name: string, statements: D1Statement[]) => {
    meter.reset();
    await meter.db.batch(statements);
    const summary = meter.summary();
    results[`${label} · ${name}`] = {
      queries: summary.queries,
      rowsRead: summary.rowsRead,
      rowsWritten: summary.rowsWritten,
      items: 0,
    };
  };
  const payload = (vid: string, mid: string) =>
    JSON.stringify({
      id: vid,
      materialId: mid,
      version: 1,
      name: '새 타일',
      brand: 'TOTO',
      code: 'N-1',
      category: 'tile',
      scope: 'shared',
      description: '',
      color: '화이트 · 그레이',
      finish: '무광',
      widthMm: 600,
      heightMm: 600,
      depthMm: 10,
      usage: 'both',
      textureAssetIds: [],
      views: [],
    });
  await writes('새 자재(자재+버전)', [
    meter.db.prepare(
      "INSERT INTO d1_materials(id,owner_id,scope,current_version_id,created_at,updated_at,purpose) VALUES('new-m','admin-1','shared','new-v1','t','2026-10-20','catalog')",
    ),
    meter.db
      .prepare(
        "INSERT INTO d1_material_versions(id,material_id,version,payload_json,category,view_count,created_at) VALUES('new-v1','new-m',1,?,'tile',0,'t')",
      )
      .bind(payload('new-v1', 'new-m')),
  ]);
  await writes('새 버전', [
    meter.db.prepare(
      "UPDATE d1_materials SET current_version_id='new-v2',updated_at='2026-10-21' WHERE id='new-m'",
    ),
    meter.db
      .prepare(
        "INSERT INTO d1_material_versions(id,material_id,version,payload_json,category,view_count,created_at) VALUES('new-v2','new-m',2,?,'tile',0,'t')",
      )
      .bind(payload('new-v2', 'new-m')),
  ]);
  await writes('비활성화', [
    meter.db.prepare("UPDATE d1_materials SET active=0,updated_at='2026-10-22' WHERE id='new-m'"),
  ]);
  return results;
}
async function report(scale: number, name: string) {
  const db = await database(name, scale);
  const plans = new Map<string, string[]>();
  const results: Record<string, Omit<Cost, 'records'> & { records?: D1QueryRecord[] }> = {};
  for (const path of PATHS) {
    const cost = await path.run(db, plans);
    results[path.name] = { ...cost, records: cost.records };
  }
  Object.assign(results, await saveWrites(db, '저장'));
  // Search by FTS5 trigram, for comparison only (not in the migrations).
  let fts: Record<string, number | string> = {};
  try {
    await db.prepare("CREATE VIRTUAL TABLE fts_probe USING fts5(text, tokenize='trigram')").run();
    await db
      .prepare(
        'INSERT INTO fts_probe(rowid,text) SELECT rowid,search_catalog FROM (SELECT ROW_NUMBER() OVER () AS rowid,search_catalog FROM d1_material_list)',
      )
      .run();
    for (const q of ['stone 4', '포세린', '타일'])
      try {
        const result = await db
          .prepare('SELECT rowid FROM fts_probe WHERE text MATCH ?')
          .bind('"' + q + '"')
          .all();
        fts[q] = `${result.results.length}건 · ${result.meta.rows_read}행`;
      } catch (error) {
        fts[q] = String(error).slice(0, 80);
      }
  } catch (error) {
    fts = { unsupported: String(error).slice(0, 120) };
  }
  const counts = await db
    .prepare(
      'SELECT (SELECT COUNT(*) FROM d1_materials) AS materials,(SELECT COUNT(*) FROM d1_material_list) AS list,(SELECT COUNT(*) FROM d1_material_list_facets) AS facets,(SELECT COUNT(*) FROM d1_material_list_counts) AS counts',
    )
    .first();
  return { counts, results, plans: Object.fromEntries(plans), fts };
}

describe('paged material list cost (d1-query-budget)', () => {
  it(`reads rows that follow the page, not the catalogue (N=${BASE.tiles + BASE.products} and 5N)`, async () => {
    // The same saves before 0009 (no summary triggers), for the write comparison.
    const before = (await database('BEFORE', 0, allD1Migrations.slice(0, -1))) as D1DatabaseLike;
    const beforeWrites = await saveWrites(before, '0009 전 저장');
    const x1 = await report(1, 'SCALE1');
    const x5 = await report(5, 'SCALE5');
    await mkdir('test-results', { recursive: true });
    const strip = (r: typeof x1) => ({
      ...r,
      // The per-statement records stay in the console on a failure; the file keeps the totals.
      results: Object.fromEntries(
        Object.entries(r.results).map(([k, v]) => [k, { ...v, records: undefined }]),
      ),
    });
    await writeFile(
      'test-results/material-paging-cost.json',
      JSON.stringify({ base: BASE, beforeWrites, x1: strip(x1), x5: strip(x5) }, null, 2),
    );
    for (const [name, cost] of Object.entries(beforeWrites))
      console.log(`${name.padEnd(28)} read ${cost.rowsRead}  written ${cost.rowsWritten}`);
    console.log(
      `x1 ${JSON.stringify(x1.counts)}\nx5 ${JSON.stringify(x5.counts)}\nFTS5 x1 ${JSON.stringify(x1.fts)} x5 ${JSON.stringify(x5.fts)}`,
    );
    for (const name of Object.keys(x1.results)) {
      const a = x1.results[name],
        b = x5.results[name];
      console.log(
        `${name.padEnd(28)} q ${a.queries}/${b.queries}  read ${String(a.rowsRead).padStart(6)} / ${String(b.rowsRead).padStart(6)}  written ${a.rowsWritten}/${b.rowsWritten}  items ${a.items}/${b.items}`,
      );
    }
    for (const path of PATHS) {
      const a = x1.results[path.name],
        b = x5.results[path.name];
      const detail = (cost: Cost | typeof a) => JSON.stringify(cost.records, null, 1);
      // The number of queries never follows the data.
      expect(b.queries, path.name).toBe(a.queries);
      if (path.kind === 'filtered') {
        // The first page of a search or facet filter reads the matching keys once (it counts them):
        // its range's candidates for a search, the selected values' rows for a facet; never all payloads.
        expect(b.rowsRead, path.name + detail(b)).toBeLessThanOrEqual(
          3 * 5 * (BASE.tiles + BASE.products) + 400,
        );
        continue;
      }
      if (path.kind === 'page')
        expect(a.rowsRead, path.name + detail(a)).toBeLessThanOrEqual(a.items * 8 + 300);
      // Same page, same cost at five times the data.
      if (a.items === b.items)
        expect(b.rowsRead, path.name + detail(b)).toBeLessThanOrEqual(
          Math.max(a.rowsRead * 1.5, a.rowsRead + 20),
        );
      else expect(b.rowsRead, path.name + detail(b)).toBeLessThanOrEqual(b.items * 8 + 300);
    }
    // No growing table is scanned.
    for (const [sql, plan] of Object.entries(x5.plans))
      for (const line of plan) expect(line, sql).not.toMatch(GROWING);
  }, 1_800_000);
});
