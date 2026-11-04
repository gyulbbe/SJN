/**
 * D1 rows one material save writes (d1-query-budget; docs/d1-write-cost-results-20261104.md): the real
 * request path (handleD1Request, adminProjectMaterials) on a metered local D1, for an administrator's
 * edit of an existing shared tile with a brand, two colours, a finish, a subcategory and a size (the
 * save that filled the day's write allowance on 2026-11-03), a new shared tile, (de)activation, and an
 * administrator project's new model. An edit's rows must not grow with the material's versions (1, 5
 * and 20 versions before the save). Statement by statement records go to test-results/d1-write-cost.json.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import sharp from 'sharp';
import { allD1Migrations, applyD1Migrations } from './helpers/d1-migrations';
import { meterD1, type D1QueryRecord } from './helpers/d1-meter';
import { handleD1Request } from '../src/lib/d1';
import { adminProjectAssets, adminProjectMaterials, adminProjects } from '../src/lib/admin/projects';
import { normalizeProjectDocument } from '../src/lib/comparison';
import { DEFAULT_ROOM, createRoomSurfaces } from '../src/lib/room-geometry';
import {
  DEFAULT_COLOR,
  EMPTY_MASK,
  type MaterialInput,
  type MaterialVersion,
  type ProjectDocument,
} from '../src/lib/types';
import type { D1Actor, D1Bindings, D1DatabaseLike, D1Resource } from '../src/lib/d1/types';

let mf: Miniflare, env: D1Bindings, png: Uint8Array<ArrayBuffer>;
const now = '2026-11-04T00:00:00.000Z';
const TILES = 200;

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("isolated")}};',
      compatibilityDate: '2026-09-07',
      d1Databases: { DB: 'write-cost-test' },
      r2Buckets: ['ASSET_BUCKET'],
    }),
  );
  env = {
    DB: await mf.getD1Database('DB'),
    ASSET_BUCKET: await mf.getR2Bucket('ASSET_BUCKET'),
  } as unknown as D1Bindings;
  await applyD1Migrations(env.DB, allD1Migrations);
  png = new Uint8Array(
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#cccccc' } })
      .png()
      .toBuffer(),
  );
  await seed(env.DB);
}, 60000);
afterAll(async () => {
  await mf?.dispose();
});

const series = (count: number) =>
  `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${count})`;
/** Other shared tiles with brands, colours and sizes, so the list tables and their indexes are not empty. */
async function seed(db: D1DatabaseLike) {
  const rows = `${series(TILES)}, r(i,mid,vid) AS (SELECT i,printf('10000000-0000-4000-8000-%012d',i),printf('20000000-0000-4000-8000-%012d',i) FROM n)`;
  const payload = `json_object('id',vid,'materialId',mid,'version',1,'name','타일 '||i,'brand',CASE i%3 WHEN 0 THEN 'TOTO' WHEN 1 THEN '대림바스' ELSE '' END,
    'code','C-'||i,'category','tile','scope','shared','description','','color',CASE i%3 WHEN 0 THEN '화이트' WHEN 1 THEN '그레이 · 베이지' ELSE '차콜' END,
    'finish',CASE i%2 WHEN 0 THEN '무광' ELSE '유광' END,'widthMm',CASE i%3 WHEN 0 THEN 600 WHEN 1 THEN 300 ELSE 1200 END,'heightMm',600,'depthMm',10,
    'usage',CASE i%3 WHEN 0 THEN 'wall' WHEN 1 THEN 'floor' ELSE 'both' END,'installation','wall','textureAssetIds',json_array(),'views',json_array(),
    'defaultGroutWidth',2,'defaultGroutColor','#ffffff','defaultPattern','grid','createdAt','2026-10-16T00:00:00.000Z')`;
  for (const statement of [
    `${rows} INSERT INTO d1_materials(id,owner_id,scope,current_version_id,created_at,updated_at,purpose)
      SELECT mid,'seed-admin','shared',vid,printf('2026-09-%08d',i),printf('2026-10-16T%08d',i),'catalog' FROM r`,
    `${rows} INSERT INTO d1_material_versions(id,material_id,version,payload_json,category,view_count,created_at)
      SELECT vid,mid,1,${payload},'tile',0,'2026-10-16' FROM r`,
    `INSERT INTO d1_material_version_options(version_id,option_id,option_kind)
      SELECT v.id,o.id,'brand' FROM d1_material_versions v JOIN d1_catalog_options o
      ON o.kind='brand' AND o.name=json_extract(v.payload_json,'$.brand')`,
    `UPDATE d1_catalog_options SET display_order=0 WHERE kind='brand' AND name='대림바스'`,
  ])
    await db.prepare(statement).run();
}
async function user(admin = false): Promise<D1Actor> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)',
  )
    .bind(id, admin ? '관리자' : '회원', `${id}@example.test`, 1, now, now)
    .run();
  if (admin) await env.DB.prepare('INSERT INTO admin_roles(user_id) VALUES(?)').bind(id).run();
  return { id, isAdmin: admin };
}
const post = (path: string, body: unknown, key?: string) =>
  new Request('https://sjn.test' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Idempotency-Key': key } : {}) },
    body: JSON.stringify(body),
  });
async function upload(
  actor: D1Actor,
  kind: string,
  bindings: D1Bindings,
  projectId?: string,
  sourceAssetId?: string,
) {
  const id = crypto.randomUUID(),
    form = new FormData();
  form.set(
    'metadata',
    JSON.stringify({ id, kind, name: 'a.png', ...(sourceAssetId ? { sourceAssetId } : {}) }),
  );
  form.set('file', new Blob([png], { type: 'image/png' }), 'a.png');
  const request = new Request(
    'https://sjn.test' + (projectId ? '/api/admin/project-assets?projectId=' + projectId : '/api/d1/assets'),
    { method: 'POST', body: form },
  );
  const response = projectId
    ? await adminProjectAssets({ env: bindings, actor }, request)
    : await handleD1Request('assets', request, bindings, actor);
  expect(response.status, await response.clone().text()).toBe(200);
  return id;
}
async function option(kind: string, name: string) {
  const row = await env.DB.prepare('SELECT id FROM d1_catalog_options WHERE kind=? AND name=?')
    .bind(kind, name)
    .first<{ id: string }>();
  return row!.id;
}
async function tileInput(assetId: string, name: string): Promise<MaterialInput> {
  const sub = await env.DB.prepare(
    "SELECT id FROM d1_material_subcategories WHERE category_code='tile' AND active=1 ORDER BY id LIMIT 1",
  ).first<{ id: string }>();
  return {
    name,
    brand: '',
    code: 'W-1',
    category: 'tile',
    scope: 'shared',
    description: '',
    color: '',
    finish: '',
    widthMm: 600,
    heightMm: 300,
    depthMm: 9,
    usage: 'wall',
    installation: 'wall',
    coverAssetId: assetId,
    imageAssetIds: [assetId],
    textureAssetIds: [assetId],
    views: [],
    defaultGroutWidth: 2,
    defaultGroutColor: '#ffffff',
    defaultPattern: 'grid',
    catalog: {
      brandId: await option('brand', 'TOTO'),
      subcategoryId: sub!.id,
      colorIds: [await option('color', '화이트'), await option('color', '그레이')],
      compositionIds: [],
      finishIds: [await option('finish', '무광')],
    },
  };
}

type Cost = {
  status: number;
  queries: number;
  rowsRead: number;
  rowsWritten: number;
  records: D1QueryRecord[];
};
/** One request on a metered D1: its queries and billed rows, statement by statement. */
async function metered(run: (bindings: D1Bindings) => Promise<Response>): Promise<Cost & { body: unknown }> {
  const meter = meterD1(env.DB);
  const response = await run({ DB: meter.db, ASSET_BUCKET: env.ASSET_BUCKET } as D1Bindings);
  const body = await response.clone().json();
  const summary = meter.summary();
  return { status: response.status, ...summary, records: [...meter.records], body };
}
const material = (actor: D1Actor, body: unknown, key: string, resource: D1Resource = 'materials') =>
  metered((bindings) => handleD1Request(resource, post('/api/d1/' + resource, body, key), bindings, actor));

const results: Record<
  string,
  Omit<Cost, 'records'> & { statements: { sql: string; read: number; written: number }[] }
> = {};
function keep(name: string, cost: Cost) {
  results[name] = {
    status: cost.status,
    queries: cost.queries,
    rowsRead: cost.rowsRead,
    rowsWritten: cost.rowsWritten,
    statements: cost.records
      .filter((r) => (r.rowsWritten ?? 0) > 0 || (r.rowsRead ?? 0) > 5)
      .map((r) => ({ sql: r.sql.slice(0, 140), read: r.rowsRead ?? 0, written: r.rowsWritten ?? 0 })),
  };
}
function report(name: string) {
  const r = results[name];
  console.log(`\n${name}: queries ${r.queries}, read ${r.rowsRead}, written ${r.rowsWritten}`);
  for (const s of r.statements)
    console.log(`  w ${String(s.written).padStart(3)} r ${String(s.read).padStart(4)}  ${s.sql}`);
}

describe('rows one material save writes', () => {
  it('an edit of a shared tile, a new one, activation and an administrator project model', async () => {
    const admin = await user(true);
    const asset = await upload(admin, 'texture', env);
    const input = await tileInput(asset, '화이트 대리석 600x300');

    const created = await material(admin, { operation: 'create', input }, 'create-1');
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    keep('새 공용 타일', created);
    let version = created.body as MaterialVersion;
    // Edits until the material has 1, 5 and 20 versions; the next save is measured each time.
    for (let n = 1; n <= 20; n++) {
      const edit = await material(
        admin,
        {
          operation: 'update',
          id: version.materialId,
          expectedVersionId: version.id,
          input: { ...input, name: `화이트 대리석 600x300 (${n})` },
        },
        `edit-${n}`,
      );
      expect(edit.status, JSON.stringify(edit.body)).toBe(200);
      if (n === 1 || n === 5 || n === 20) keep(`수정 저장 (저장 전 버전 ${n}개)`, edit);
      version = edit.body as MaterialVersion;
    }
    const off = await material(
      admin,
      { operation: 'setActive', id: version.materialId, active: false },
      'off-1',
    );
    expect(off.status).toBe(200);
    keep('사용 끄기 (버전 21개)', off);

    // An administrator project: the owner's project, a generated image in its scope, a new model.
    const owner = await user();
    const source = await upload(owner, 'product', env);
    const document: ProjectDocument = normalizeProjectDocument({
      id: crypto.randomUUID(),
      ownerId: 'x',
      name: '공간',
      schemaVersion: 2,
      storageRevision: 0,
      editRevision: 0,
      createdAt: now,
      updatedAt: now,
      viewport: { zoom: 1, pan: { x: 0, y: 0 } },
      history: { past: [], future: [] },
      scene: {
        originalAssetId: source,
        previewAssetId: source,
        imageWidth: 8,
        imageHeight: 8,
        room: { ...DEFAULT_ROOM },
        surfaces: createRoomSurfaces(DEFAULT_ROOM),
        fixtures: [],
        protection: EMPTY_MASK(),
        color: { ...DEFAULT_COLOR },
      },
    });
    const made = await handleD1Request(
      'projects',
      post('/api/d1/projects', { operation: 'create', document }),
      env,
      owner,
    );
    expect(made.status, await made.clone().text()).toBe(200);
    const projectId = ((await made.json()) as ProjectDocument).id;
    expect(
      (
        await adminProjects(
          { env, actor: admin },
          new Request('https://sjn.test/api/admin/projects?id=' + projectId),
        )
      ).status,
    ).toBe(200);
    const generated = await upload(admin, 'product', env, projectId, source);
    const model: MaterialInput = {
      name: '설비',
      brand: '',
      code: '',
      category: 'basin',
      scope: 'personal',
      description: '',
      color: '',
      finish: '',
      widthMm: 600,
      heightMm: 800,
      depthMm: 400,
      usage: 'wall',
      installation: 'wall',
      textureAssetIds: [],
      views: [{ assetId: generated, direction: '정면', anchor: { x: 0.5, y: 1 } }],
      defaultGroutWidth: 2,
      defaultGroutColor: '#ffffff',
      defaultPattern: 'grid',
    };
    const project = await metered((bindings) =>
      adminProjectMaterials(
        { env: bindings, actor: admin },
        post('/api/admin/project-materials', { projectId, operation: 'create', input: model }, 'project-1'),
      ),
    );
    expect(project.status, JSON.stringify(project.body)).toBe(200);
    keep('관리자 프로젝트 새 모형', project);

    for (const name of Object.keys(results)) report(name);
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/d1-write-cost.json', JSON.stringify(results, null, 1));
  }, 120000);
});
