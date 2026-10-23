/**
 * D1 rows read per call, the whole-set visibility queries against the request-scoped ones, on data
 * shaped like the remote `sjn` of 2026-10-17 (scale 1) and five times it. A measurement, not a check
 * of behaviour (tests/d1-visibility-equivalence.test.ts does that), so it only runs on request:
 *
 *   SJN_D1_COST=1 npx vitest run tests/d1-read-cost.test.ts
 *
 * Results: test-results/d1-read-cost.json, docs/d1-query-efficiency-results-20261017.md.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { applyD1Migrations, allD1Migrations } from './helpers/d1-migrations';
import { legacyAssets, legacyVersions, LEGACY_PUBLICLY_DISPLAYED } from './helpers/d1-visibility-legacy';
import { visibleAssetsQuery, visibleVersionsQuery, type Context } from '../src/lib/d1/database';
import { materials } from '../src/lib/d1/materials';
import { publicMaterials, publicPlacement, publiclyDisplayed } from '../src/lib/catalog/public';
import type { D1Bindings, D1DatabaseLike, D1Statement } from '../src/lib/d1/types';

const ADMIN = 'admin-1',
  MEMBER = 'member-1',
  EDITOR = 'admin-2';
const id = (prefix: number, i: number) => `${prefix}0000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const ORIGINAL = 1,
  TEXTURE = 2,
  TILE = 3,
  TILE_VERSION = 4,
  PRODUCT_ORIGINAL = 5,
  PRODUCT = 6,
  PRODUCT_MATERIAL = 7,
  PRODUCT_VERSION = 8,
  MEMBER_ORIGINAL = 9;

/** Shape of the remote data on 2026-10-17 (assets 2,037, materials 958, versions 973, references 1,001). */
function shape(scale: number) {
  return {
    tiles: 930 * scale,
    products: 30 * scale,
    memberOriginals: 50 * scale,
    otherAssets: 20 * scale,
    adminMutations: 900 * scale,
    memberMutations: 70 * scale,
  };
}
const series = (count: number) =>
  `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${count})`;
const assetSql = (owner: string, prefix: number, kind: string, sourcePrefix: number | null, count: number) =>
  `${series(count)} INSERT INTO d1_assets(id,owner_id,object_key,source_asset_id,metadata_json,content_hash,created_at)
   SELECT printf('${prefix}0000000-0000-4000-8000-%012d',i),'${owner}','assets/${prefix}/'||i,
     ${sourcePrefix === null ? 'NULL' : `printf('${sourcePrefix}0000000-0000-4000-8000-%012d',i)`},
     json_object('kind','${kind}','mime','image/png','width',100,'height',100,'size',1000),'hash','2026-10-16T00:00:00.000Z' FROM n`;
const payload = (category: 'tile' | 'basin') =>
  `json_object('id',printf('%s',vid),'materialId',printf('%s',mid),'version',1,'name','시험','brand','','code','',
    'category','${category}','scope','shared','description','','color','','finish','','widthMm',300,'heightMm',600,
    'depthMm',10,'usage','wall','installation','wall',
    'textureAssetIds',${category === 'tile' ? 'json_array(aid)' : 'json_array()'},
    'views',${category === 'tile' ? 'json_array()' : "json_array(json_object('assetId',aid,'direction','정면','anchor',json_object('x',0.5,'y',1)))"},
    'defaultGroutWidth',2,'defaultGroutColor','#ffffff','defaultPattern','grid','createdAt','2026-10-16T00:00:00.000Z')`;
function materialSql(
  materialPrefix: number,
  versionPrefix: number,
  assetPrefix: number,
  category: 'tile' | 'basin',
  count: number,
  owner: string,
  scope: string,
  purpose: string,
) {
  const rows = `${series(count)}, r(i,mid,vid,aid) AS (SELECT i,printf('${materialPrefix}0000000-0000-4000-8000-%012d',i),
    printf('${versionPrefix}0000000-0000-4000-8000-%012d',i),printf('${assetPrefix}0000000-0000-4000-8000-%012d',i) FROM n)`;
  return [
    `${rows} INSERT INTO d1_materials(id,owner_id,scope,current_version_id,created_at,updated_at,purpose)
      SELECT mid,'${owner}','${scope}',vid,'2026-10-16T00:00:00.000Z',printf('2026-10-16T%08d',i),'${purpose}' FROM r`,
    `${rows} INSERT INTO d1_material_versions(id,material_id,version,payload_json,category,view_count,created_at)
      SELECT vid,mid,1,${payload(category)},'${category}',${category === 'tile' ? 0 : 1},'2026-10-16T00:00:00.000Z' FROM r`,
    `${rows} INSERT INTO d1_material_assets(version_id,asset_id) SELECT vid,aid FROM r`,
  ];
}

let mf: Miniflare | undefined;
afterAll(async () => {
  await mf?.dispose();
});
async function database(scale: number, name: string): Promise<D1DatabaseLike> {
  mf ??= new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response(null, { status: 404 }); } };',
      compatibilityDate: '2026-09-07',
      d1Databases: { SCALE1: 'sjn-cost-1', SCALE5: 'sjn-cost-5' },
    }),
  );
  const db = (await mf.getD1Database(name)) as unknown as D1DatabaseLike;
  await applyD1Migrations(db, allD1Migrations);
  const size = shape(scale);
  const statements = [
    assetSql(ADMIN, ORIGINAL, 'original', null, size.tiles),
    assetSql(ADMIN, TEXTURE, 'texture', ORIGINAL, size.tiles),
    ...materialSql(TILE, TILE_VERSION, TEXTURE, 'tile', size.tiles, ADMIN, 'shared', 'catalog'),
    assetSql(ADMIN, PRODUCT_ORIGINAL, 'original', null, size.products),
    assetSql(ADMIN, PRODUCT, 'product', PRODUCT_ORIGINAL, size.products),
    ...materialSql(
      PRODUCT_MATERIAL,
      PRODUCT_VERSION,
      PRODUCT,
      'basin',
      size.products,
      ADMIN,
      'shared',
      'catalog',
    ),
    assetSql(MEMBER, MEMBER_ORIGINAL, 'original', null, size.memberOriginals),
    `${series(size.memberOriginals)} INSERT INTO d1_assets(id,owner_id,object_key,source_asset_id,metadata_json,content_hash,created_at)
      SELECT printf('a0000000-0000-4000-8000-%012d',i),'${MEMBER}','assets/a/'||i,printf('90000000-0000-4000-8000-%012d',i),
      json_object('kind','preview','mime','image/png','width',100,'height',100,'size',1000),'hash','2026-10-16T00:00:00.000Z' FROM n`,
    `${series(size.otherAssets)} INSERT INTO d1_assets(id,owner_id,object_key,metadata_json,content_hash,created_at)
      SELECT printf('c0000000-0000-4000-8000-%012d',i),'member-'||(2+i%2),'assets/c/'||i,
      json_object('kind','original','mime','image/png','width',100,'height',100,'size',1000),'hash','2026-10-16T00:00:00.000Z' FROM n`,
    `INSERT INTO d1_projects(id,owner_id,name,storage_revision,object_key,byte_size,summary_json,created_at,updated_at)
      VALUES('d0000000-0000-4000-8000-000000000001','${MEMBER}','시험',1,'projects/1',1,'{}','2026-10-16','2026-10-16')`,
    `${series(30)} INSERT INTO d1_project_assets(project_id,asset_id) SELECT 'd0000000-0000-4000-8000-000000000001',printf('90000000-0000-4000-8000-%012d',i) FROM n`,
    `${series(10)} INSERT INTO d1_project_assets(project_id,asset_id) SELECT 'd0000000-0000-4000-8000-000000000001',printf('20000000-0000-4000-8000-%012d',i) FROM n`,
    `${series(10)} INSERT INTO d1_project_versions(project_id,version_id) SELECT 'd0000000-0000-4000-8000-000000000001',printf('40000000-0000-4000-8000-%012d',i) FROM n`,
    `${series(size.adminMutations)} INSERT INTO d1_mutations(owner_id,request_key,resource,request_hash,response_json,created_at)
      SELECT '${ADMIN}','k'||i,'materials','h','null',printf('2026-10-17T%08d',i) FROM n`,
    `${series(size.memberMutations)} INSERT INTO d1_mutations(owner_id,request_key,resource,request_hash,response_json,created_at)
      SELECT '${MEMBER}','k'||i,'projects','h','null',printf('2026-10-17T%08d',i) FROM n`,
  ];
  for (const statement of statements) await db.prepare(statement).run();
  return db;
}

interface Measure {
  rows: number;
  ms: number;
}
async function read(db: D1DatabaseLike, query: string, values: unknown[]): Promise<Measure> {
  const start = performance.now();
  const result = await db
    .prepare(query)
    .bind(...values)
    .all();
  return { rows: Number(result.meta.rows_read), ms: Math.round(performance.now() - start) };
}
/** A batch assertion is measured as a commit runs it (and must pass, as the data is valid). */
async function asserted(db: D1DatabaseLike, query: string, values: unknown[]): Promise<Measure> {
  const start = performance.now();
  const [result] = await db.batch([
    db
      .prepare(`INSERT INTO d1_checks(id,reference_ok) SELECT ?,CASE WHEN (${query}) THEN 1 ELSE 0 END`)
      .bind(crypto.randomUUID(), ...values),
    db.prepare('DELETE FROM d1_checks'),
  ]);
  return { rows: Number(result.meta.rows_read), ms: Math.round(performance.now() - start) };
}
/** Rows read by every statement a whole route runs (`swap` puts the old public condition back). */
function recording(db: D1DatabaseLike, swap = false) {
  let rows = 0;
  const count = async <T>(statement: D1Statement) => {
    const result = await statement.all<T>();
    rows += Number(result.meta.rows_read);
    return result;
  };
  const wrap = (statement: D1Statement): D1Statement => ({
    bind: (...values) => wrap(statement.bind(...values)),
    all: (() => count(statement)) as D1Statement['all'],
    run: (() => count(statement)) as D1Statement['run'],
    first: (async (column?: string) => {
      const row = (await count<Record<string, unknown>>(statement)).results[0] ?? null;
      return column ? (row?.[column] ?? null) : row;
    }) as D1Statement['first'],
  });
  const recorded: D1DatabaseLike = {
    prepare: (query) =>
      wrap(db.prepare(swap ? query.split(publiclyDisplayed).join(LEGACY_PUBLICLY_DISPLAYED) : query)),
    batch: (statements) => db.batch(statements),
  };
  return { env: { DB: recorded } as unknown as D1Bindings, rows: () => rows };
}
async function route(
  db: D1DatabaseLike,
  run: (env: D1Bindings) => Promise<unknown>,
  swap = false,
): Promise<Measure> {
  const recorder = recording(db, swap);
  const start = performance.now();
  await run(recorder.env);
  return { rows: recorder.rows(), ms: Math.round(performance.now() - start) };
}
const readable = 'SELECT a.* FROM d1_assets a JOIN visible_assets v ON v.id=a.id WHERE a.id=?';
const allVisible = (table: string) =>
  `SELECT NOT EXISTS(SELECT 1 FROM json_each(?) r WHERE NOT EXISTS(SELECT 1 FROM ${table} a WHERE a.id=r.value))`;
const materialRows =
  'SELECT a.id,a.metadata_json FROM d1_assets a JOIN visible_assets v ON v.id=a.id JOIN json_each(?) r ON r.value=a.id';
const versionRow = 'SELECT v.* FROM d1_material_versions v JOIN visible_versions p ON p.id=v.id WHERE v.id=?';
const imageSql = (condition: string) =>
  `SELECT a.object_key,a.metadata_json FROM d1_assets a WHERE a.id=? AND a.deleting=0
   AND json_extract(a.metadata_json,'$.kind') IN ('texture','product','preview') AND ${condition}`;
const placementImagesSql = (condition: string) =>
  `SELECT a.id,a.metadata_json FROM d1_assets a WHERE a.deleting=0
   AND a.id IN(SELECT value FROM json_each(?))
   AND json_extract(a.metadata_json,'$.kind') IN ('texture','product','preview')
   AND json_extract(a.metadata_json,'$.mime') IN ('image/png','image/jpeg','image/webp')
   AND ${condition}`;
const cleanupSql =
  'DELETE FROM d1_mutations WHERE rowid IN (SELECT rowid FROM d1_mutations WHERE owner_id=? AND created_at<? LIMIT 200)';

async function measure(db: D1DatabaseLike, scale: number) {
  const env = { DB: db } as unknown as D1Bindings;
  const member: Context = { env, actor: { id: MEMBER, isAdmin: false } };
  const admin: Context = { env, actor: { id: ADMIN, isAdmin: true } };
  const editor: Context = {
    env,
    actor: { id: EDITOR, isAdmin: true },
    adminProject: { id: 'd0000000-0000-4000-8000-000000000001', ownerId: MEMBER, requestId: 'cost' },
  };
  const size = shape(scale);
  const results: Record<string, { old: Measure; now: Measure }> = {};
  async function compare(
    name: string,
    ctx: Context,
    refs: string[],
    outer: string,
    kind: 'read' | 'assert' = 'read',
    extra: unknown[] = [],
  ) {
    const json = JSON.stringify(refs);
    const old = legacyAssets(ctx),
      now = visibleAssetsQuery(ctx, json);
    const run = kind === 'read' ? read : asserted;
    results[name] = {
      old: await run(db, `${old.cte} ${outer}`, [...old.values, ...extra]),
      now: await run(db, `${now.cte} ${outer}`, [...now.values, ...extra]),
    };
  }
  async function compareVersions(
    name: string,
    ctx: Context,
    refs: string[],
    outer: string,
    kind: 'read' | 'assert',
    extra: unknown[],
  ) {
    const old = legacyVersions(ctx),
      now = visibleVersionsQuery(ctx, JSON.stringify(refs));
    const run = kind === 'read' ? read : asserted;
    results[name] = {
      old: await run(db, `${old.cte} ${outer}`, [...old.values, ...extra]),
      now: await run(db, `${now.cte} ${outer}`, [...now.values, ...extra]),
    };
  }
  const texture = id(TEXTURE, 7),
    original = id(ORIGINAL, 7),
    own = id(MEMBER_ORIGINAL, 3),
    preview = `a0000000-0000-4000-8000-${String(3).padStart(12, '0')}`,
    stranger = `c0000000-0000-4000-8000-${String(1).padStart(12, '0')}`;
  // A. readableAsset: GET /api/d1/assets (metadata and raw), source check.
  await compare('A 자산 읽기 · 관리자 자기 텍스처', admin, [texture], readable, 'read', [texture]);
  await compare('A 자산 읽기 · 회원이 공용 텍스처', member, [texture], readable, 'read', [texture]);
  await compare('A 자산 읽기 · 회원이 공용 텍스처의 원본', member, [original], readable, 'read', [original]);
  await compare('A 자산 읽기 · 회원 자기 미리보기', member, [preview], readable, 'read', [preview]);
  await compare('A 자산 읽기 · 볼 수 없는 자산', member, [stranger], readable, 'read', [stranger]);
  // B. Upload assertion (no source, and with a source).
  await compare('B 업로드 검사 · 원본 없음(관리자)', admin, [], allVisible('visible_assets'), 'assert', [
    '[]',
  ]);
  await compare('B 업로드 검사 · 원본 1개(회원)', member, [own], allVisible('visible_assets'), 'assert', [
    JSON.stringify([own]),
  ]);
  // C. Project save: preflight and commit checks with 50 references; a material save's assets.
  const projectRefs = [
    ...Array.from({ length: 40 }, (_, i) => id(MEMBER_ORIGINAL, i + 1)),
    ...Array.from({ length: 10 }, (_, i) => id(TEXTURE, i + 1)),
  ];
  await compare(
    'C 프로젝트 저장 검사 · 참조 50개',
    member,
    projectRefs,
    allVisible('visible_assets'),
    'assert',
    [JSON.stringify(projectRefs)],
  );
  await compare(
    'C 프로젝트 사전 확인 · 참조 50개',
    member,
    projectRefs,
    `${allVisible('visible_assets')} AS valid`,
    'read',
    [JSON.stringify(projectRefs)],
  );
  await compare('C 자재 저장 자산 확인 · 관리자 타일', admin, [texture], materialRows, 'read', [
    JSON.stringify([texture]),
  ]);
  // Administrator project scope (another member's project).
  const scoped = [...projectRefs.slice(0, 30), ...projectRefs.slice(40, 50)];
  await compare('A 관리자 프로젝트 · 자산 읽기', editor, [own], readable, 'read', [own]);
  await compare(
    'C 관리자 프로젝트 · 저장 검사 40개',
    editor,
    scoped,
    allVisible('visible_assets'),
    'assert',
    [JSON.stringify(scoped)],
  );
  // Versions.
  const version = id(TILE_VERSION, 5);
  const versionRefs = Array.from({ length: 10 }, (_, i) => id(TILE_VERSION, i + 1));
  await compareVersions('V 버전 읽기 · 회원', member, [version], versionRow, 'read', [version]);
  await compareVersions(
    'V 버전 검사 · 회원 10개',
    member,
    versionRefs,
    allVisible('visible_versions'),
    'assert',
    [JSON.stringify(versionRefs)],
  );
  await compareVersions('V 버전 읽기 · 관리자 프로젝트', editor, [version], versionRow, 'read', [version]);
  await compareVersions(
    'V 버전 검사 · 관리자 프로젝트 10개',
    editor,
    versionRefs,
    allVisible('visible_versions'),
    'assert',
    [JSON.stringify(versionRefs)],
  );
  // G·H. Public image and placement images.
  results['G 공개 이미지 1장'] = {
    old: await read(db, imageSql(LEGACY_PUBLICLY_DISPLAYED), [id(TEXTURE, Math.ceil(size.tiles / 2))]),
    now: await read(db, imageSql(publiclyDisplayed), [id(TEXTURE, Math.ceil(size.tiles / 2))]),
  };
  const one = JSON.stringify([id(PRODUCT, 1)]);
  results['H 공개 배치 이미지 · 자재 1개'] = {
    old: await read(db, placementImagesSql(LEGACY_PUBLICLY_DISPLAYED), [one]),
    now: await read(db, placementImagesSql(publiclyDisplayed), [one]),
  };
  const every = JSON.stringify([
    ...Array.from({ length: size.tiles }, (_, i) => id(TEXTURE, i + 1)),
    ...Array.from({ length: size.products }, (_, i) => id(PRODUCT, i + 1)),
  ]);
  // The whole list with the old query takes minutes at five times the data; measure it once only.
  results['H 공개 배치 이미지 · 전체 목록'] = {
    old:
      scale === 1
        ? await read(db, placementImagesSql(LEGACY_PUBLICLY_DISPLAYED), [every])
        : { rows: NaN, ms: NaN },
    now: await read(db, placementImagesSql(publiclyDisplayed), [every]),
  };
  // Whole list routes for reference: the public list and member list are unchanged; the public
  // placement list gains from the image check above.
  const placements = (env: D1Bindings) =>
    publicPlacement(env, new Request('https://sjn.test/api/catalog/placement'));
  results['L 공개 배치 목록 전체(라우트)'] = {
    old: scale === 1 ? await route(db, placements, true) : { rows: NaN, ms: NaN },
    now: await route(db, placements),
  };
  // The public list is paged now (tests/d1-material-paging-cost.test.ts measures it); its first page:
  const publicList = await route(db, (env) =>
    publicMaterials(env, new Request('https://sjn.test/api/catalog/materials')),
  );
  results['L 공개 자재 목록 첫 쪽(라우트)'] = { old: publicList, now: publicList };
  const memberList = await route(db, (env) => materials({ env, actor: member.actor }, { operation: 'list' }));
  results['L 회원 자재 목록(변경 없음)'] = { old: memberList, now: memberList };
  const plan = async (condition: string) =>
    (
      await db
        .prepare('EXPLAIN QUERY PLAN ' + placementImagesSql(condition))
        .bind(one)
        .all<{ detail: string }>()
    ).results.map((row) => row.detail);
  const plans = { old: await plan(LEGACY_PUBLICLY_DISPLAYED), now: await plan(publiclyDisplayed) };
  // E. Retry-record cleanup, without and with 0008's index (nothing is old enough to delete).
  const cutoff = '2026-10-16T00:00:00.000Z';
  await db.prepare('DROP INDEX d1_mutations_owner_age').run();
  const withoutIndex = await read(db, cleanupSql, [ADMIN, cutoff]);
  await db.prepare('CREATE INDEX d1_mutations_owner_age ON d1_mutations(owner_id,created_at)').run();
  results['E 재시도 기록 정리 · 관리자'] = {
    old: withoutIndex,
    now: await read(db, cleanupSql, [ADMIN, cutoff]),
  };
  const counts = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM d1_assets) AS assets,(SELECT COUNT(*) FROM d1_materials) AS materials,
       (SELECT COUNT(*) FROM d1_material_versions) AS versions,(SELECT COUNT(*) FROM d1_material_assets) AS refs,
       (SELECT COUNT(*) FROM d1_mutations) AS mutations`,
    )
    .first();
  return { counts, results, plans };
}

describe.skipIf(!process.env.SJN_D1_COST)('D1 rows read per call (measurement)', () => {
  it('compares the whole-set and request-scoped queries at the remote size and five times it', async () => {
    const report: Record<string, Awaited<ReturnType<typeof measure>>> = {};
    for (const [scale, name] of [
      [1, 'SCALE1'],
      [5, 'SCALE5'],
    ] as const)
      report[`x${scale}`] = await measure(await database(scale, name), scale);
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/d1-read-cost.json', JSON.stringify(report, null, 2));
    for (const [scale, { counts, results }] of Object.entries(report)) {
      console.log(`\n${scale} ${JSON.stringify(counts)}`);
      for (const [name, { old, now }] of Object.entries(results))
        console.log(
          `${name.padEnd(36)} old ${String(old.rows).padStart(8)} (${old.ms}ms)  new ${String(now.rows).padStart(5)} (${now.ms}ms)`,
        );
    }
    console.log(
      '\nH plan old:\n ' +
        report.x1.plans.old.join('\n ') +
        '\nH plan new:\n ' +
        report.x1.plans.now.join('\n '),
    );
    // The request-scoped cost must not follow the data size.
    // A check's cost must not follow the data size; a whole list grows with the list itself.
    for (const [name, { now }] of Object.entries(report.x1.results))
      if (!name.includes('전체') && !name.startsWith('L '))
        expect(report.x5.results[name].now.rows, name).toBeLessThanOrEqual(
          Math.max(now.rows * 1.5, now.rows + 20),
        );
    const perImage = (scale: 'x1' | 'x5', size: number) =>
      report[scale].results['H 공개 배치 이미지 · 전체 목록'].now.rows / size;
    expect(perImage('x5', 5 * (930 + 30))).toBeLessThanOrEqual(perImage('x1', 930 + 30) * 1.2);
  }, 1_800_000);
});
