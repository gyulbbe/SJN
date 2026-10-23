/**
 * List images (docs/list-thumbnails-results-20261023.md): a card asks for its image with `size=list`
 * and gets that image's small copy only where it may read the image itself; one list image per source;
 * cleanup keeps it while a material uses the source; the administrator backfill sees which are missing;
 * and the reads stay per request (d1-query-budget).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import sharp from 'sharp';
import { handleD1Request } from '../src/lib/d1';
import { cleanup } from '../src/lib/d1/cleanup';
import { publicImage } from '../src/lib/catalog/public';
import { LIST_IMAGE_OF, type ListImagePage } from '../src/lib/d1/list-images';
import type { D1Bindings, D1DatabaseLike, D1Resource } from '../src/lib/d1/types';
import type { MaterialInput, MaterialVersion } from '../src/lib/types';
import { allD1Migrations, applyD1Migrations } from './helpers/d1-migrations';
import { meterD1 } from './helpers/d1-meter';

let mf: Miniflare;
let env: D1Bindings;
let png: Uint8Array<ArrayBuffer>;
let small: Uint8Array<ArrayBuffer>;
let large: Uint8Array<ArrayBuffer>;
const admin = { id: crypto.randomUUID(), isAdmin: true };
const member = { id: crypto.randomUUID(), isAdmin: false };
const other = { id: crypto.randomUUID(), isAdmin: false };
const stamp = '2026-10-23T00:00:00.000Z';

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("local test")}};',
      compatibilityDate: '2026-09-07',
      d1Databases: { DB: 'list-images-test', COST1: 'list-images-cost-1', COST5: 'list-images-cost-5' },
      r2Buckets: ['ASSET_BUCKET'],
    }),
  );
  env = {
    DB: await mf.getD1Database('DB'),
    ASSET_BUCKET: await mf.getR2Bucket('ASSET_BUCKET'),
  } as unknown as D1Bindings;
  await applyD1Migrations(env.DB, allD1Migrations);
  for (const actor of [admin, member, other])
    await env.DB.prepare(
      'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)',
    )
      .bind(actor.id, '격리 테스트 회원', actor.id + '@example.test', 1, stamp, stamp)
      .run();
  await env.DB.prepare('INSERT INTO admin_roles(user_id) VALUES(?)').bind(admin.id).run();
  png = new Uint8Array(
    await sharp({ create: { width: 900, height: 600, channels: 3, background: '#aaccff' } })
      .png()
      .toBuffer(),
  );
  small = new Uint8Array(
    await sharp({ create: { width: 256, height: 171, channels: 3, background: '#aaccff' } })
      .webp()
      .toBuffer(),
  );
  large = new Uint8Array(
    await sharp({ create: { width: 600, height: 400, channels: 3, background: '#aaccff' } })
      .webp()
      .toBuffer(),
  );
}, 60_000);
afterAll(async () => mf?.dispose());

function call(resource: D1Resource, body: unknown, actor = admin, bindings = env) {
  return handleD1Request(
    resource,
    new Request(`https://sjn.test/api/d1/${resource}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    bindings,
    actor,
  );
}
async function upload(
  actor: { id: string; isAdmin: boolean },
  metadata: Record<string, unknown>,
  bytes: Uint8Array<ArrayBuffer>,
  mime: string,
  bindings = env,
) {
  const id = crypto.randomUUID();
  const form = new FormData();
  form.set('metadata', JSON.stringify({ id, name: 'image', ...metadata }));
  form.set('file', new Blob([bytes], { type: mime }), 'image');
  const response = await handleD1Request(
    'assets',
    new Request('https://sjn.test/api/d1/assets', { method: 'POST', body: form }),
    bindings,
    actor,
  );
  return { id, response };
}
const source = async (actor = admin, kind = 'texture', bindings = env) => {
  const made = await upload(actor, { kind }, png, 'image/png', bindings);
  expect(made.response.status, await made.response.clone().text()).toBe(200);
  return made.id;
};
const listImage = (sourceId: string, actor = admin, bytes = small, bindings = env) =>
  upload(
    actor,
    { kind: 'thumbnail', sourceAssetId: sourceId, derivation: 'list' },
    bytes,
    'image/webp',
    bindings,
  );
function tile(assetId: string): MaterialInput {
  return {
    name: '목록 이미지 타일',
    brand: '',
    code: '',
    category: 'tile',
    scope: 'shared',
    description: '',
    color: '',
    finish: '',
    widthMm: 600,
    heightMm: 600,
    depthMm: 10,
    usage: 'both',
    installation: 'floor',
    textureAssetIds: [assetId],
    views: [],
    defaultGroutWidth: 2,
    defaultGroutColor: '#ffffff',
    defaultPattern: 'grid',
  };
}
async function create(input: MaterialInput, bindings = env) {
  const response = await call('materials', { operation: 'create', input }, admin, bindings);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as MaterialVersion;
}
const read = (
  id: string,
  actor: { id: string; isAdmin: boolean },
  query = '&raw=1&size=list',
  bindings = env,
) =>
  handleD1Request('assets', new Request(`https://sjn.test/api/d1/assets?id=${id}${query}`), bindings, actor);
const publicRead = (id: string, query = '&size=list', bindings = env) =>
  publicImage(bindings, new Request(`https://sjn.test/api/catalog/images?id=${id}${query}`)).catch(
    (error: { status?: number }) => new Response(null, { status: error.status ?? 500 }),
  );

describe('list images', () => {
  it('accepts one small list image per source, made from a readable image', async () => {
    const texture = await source();
    expect(
      (
        await upload(
          admin,
          { kind: 'texture', derivation: 'list', sourceAssetId: texture },
          small,
          'image/webp',
        )
      ).response.status,
    ).toBe(400);
    expect(
      (await upload(admin, { kind: 'thumbnail', derivation: 'list' }, small, 'image/webp')).response.status,
    ).toBe(400);
    expect((await listImage(texture, admin, large)).response.status).toBe(400);
    // Another member cannot make one for an image they cannot read.
    expect((await listImage(texture, other)).response.status).toBe(404);
    const first = await listImage(texture);
    expect(first.response.status, await first.response.clone().text()).toBe(200);
    expect((await listImage(texture)).response.status).toBe(409);
    expect(
      await env.DB.prepare(`SELECT COUNT(*) AS n FROM d1_assets WHERE source_asset_id=?`)
        .bind(texture)
        .first('n'),
    ).toBe(1);
  });

  it('sends the list image only to whoever may read its source, and the source when there is none', async () => {
    const texture = await source();
    const version = await create(tile(texture));
    // No list image yet: the image itself.
    let answer = await read(texture, member);
    expect(answer.status).toBe(200);
    expect(answer.headers.get('X-SJN-List-Image')).toBe('0');
    expect(answer.headers.get('Content-Type')).toBe('image/png');
    const made = await listImage(texture);
    answer = await read(texture, member);
    expect(answer.headers.get('X-SJN-List-Image')).toBe('1');
    expect(answer.headers.get('Content-Type')).toBe('image/webp');
    expect(new Uint8Array(await answer.arrayBuffer())).toEqual(small);
    // The list image is never readable by its own id (nothing references it).
    expect((await read(made.id, member, '&raw=1')).status).toBe(404);
    // size=list is only for the bytes.
    expect((await read(texture, member, '&size=list')).status).toBe(400);
    expect((await read(texture, member, '&raw=1&size=full')).status).toBe(400);
    // Public: while the material is public.
    const shown = await publicRead(texture);
    expect(shown.status).toBe(200);
    expect(shown.headers.get('X-SJN-List-Image')).toBe('1');
    expect((await publicRead(texture, '&size=huge')).status).toBe(400);
    expect(
      (await call('materials', { operation: 'setActive', id: version.materialId, active: false })).status,
    ).toBe(200);
    expect((await publicRead(texture)).status).toBe(404);
    // A member's own private image: another member gets nothing, list image or not.
    const own = await source(member, 'preview');
    expect((await listImage(own, member)).response.status).toBe(200);
    expect((await read(own, other)).status).toBe(404);
    expect((await read(own, member)).headers.get('X-SJN-List-Image')).toBe('1');
  });

  it('keeps a list image while a material uses its source; cleans one whose source nothing uses', async () => {
    const used = await source();
    await create(tile(used));
    const usedList = (await listImage(used)).id;
    const unused = await source();
    const unusedList = (await listImage(unused)).id;
    await env.DB.prepare('UPDATE d1_assets SET created_at=? WHERE id IN (?,?,?,?)')
      .bind('2000-01-01T00:00:00.000Z', used, usedList, unused, unusedList)
      .run();
    for (let round = 0; round < 6; round++) await cleanup({ env, actor: admin }, { operation: 'run' });
    const left = async (id: string) =>
      (
        await env.DB.prepare('SELECT deleting FROM d1_assets WHERE id=?')
          .bind(id)
          .first<{ deleting: number }>()
      )?.deleting === 0;
    expect(await left(usedList)).toBe(true);
    expect(await left(used)).toBe(true);
    expect(await left(unusedList)).toBe(false);
  }, 60_000);

  it('lists card images and whether each has a list image, for administrators only', async () => {
    const answer = await call('materials', { operation: 'listImages' });
    expect(answer.status, await answer.clone().text()).toBe(200);
    const page = (await answer.json()) as ListImagePage;
    expect(page.total).toBeGreaterThan(0);
    expect(page.items.some((item) => item.listImage)).toBe(true);
    const next = (await (
      await call('materials', { operation: 'listImages', cursor: page.nextCursor })
    ).json()) as ListImagePage;
    expect(next.total).toBeUndefined();
    const ids = page.items.map((item) => item.imageAssetId);
    const listed = (await (await call('materials', { operation: 'listImages', ids })).json()) as {
      listed: string[];
    };
    expect(listed.listed.sort()).toEqual(
      page.items
        .filter((item) => item.listImage)
        .map((item) => item.imageAssetId)
        .sort(),
    );
    // Only administrators register materials, so only they ask (members cannot even probe ids).
    expect((await call('materials', { operation: 'listImages' }, member)).status).toBe(403);
    expect((await call('materials', { operation: 'listImages', ids }, member)).status).toBe(403);
    expect((await call('materials', { operation: 'listImages', cursor: 'not!a!cursor' })).status).toBe(400);
  });
});

describe('list image cost (d1-query-budget)', () => {
  /** N materials with list images, then the same requests at 5N. */
  async function scale(name: string, count: number) {
    const db = (await mf.getD1Database(name)) as unknown as D1DatabaseLike;
    await applyD1Migrations(db, allD1Migrations);
    const bindings = { DB: db, ASSET_BUCKET: env.ASSET_BUCKET } as unknown as D1Bindings;
    await db
      .prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
      .bind(admin.id, '관리자', admin.id + '@example.test', 1, stamp, stamp)
      .run();
    await db
      .prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
      .bind(member.id, '회원', member.id + '@example.test', 1, stamp, stamp)
      .run();
    await db.prepare('INSERT INTO admin_roles(user_id) VALUES(?)').bind(admin.id).run();
    // The bulk of the catalogue straight in SQL (same shape a save writes), each with a list image.
    const series = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${count})`;
    const id = (p: string) => `printf('${p}0000000-0000-4000-8000-%012d',i)`;
    for (const statement of [
      `${series} INSERT INTO d1_assets(id,owner_id,object_key,metadata_json,content_hash,created_at) SELECT ${id('1')},'${admin.id}','k/'||i,json_object('kind','texture','mime','image/png','width',900,'height',600,'size',1000),'h','${stamp}' FROM n`,
      `${series} INSERT INTO d1_assets(id,owner_id,object_key,source_asset_id,metadata_json,content_hash,created_at) SELECT ${id('2')},'${admin.id}','t/'||i,${id('1')},json_object('kind','thumbnail','derivation','list','mime','image/webp','width',256,'height',171,'size',100),'h','${stamp}' FROM n`,
      `${series} INSERT INTO d1_materials(id,owner_id,scope,current_version_id,created_at,updated_at,purpose) SELECT ${id('3')},'${admin.id}','shared',${id('4')},'${stamp}',printf('2026-10-23T%08d',i),'catalog' FROM n`,
      `${series} INSERT INTO d1_material_versions(id,material_id,version,payload_json,category,view_count,created_at) SELECT ${id('4')},${id('3')},1,json_object('id',${id('4')},'materialId',${id('3')},'version',1,'name','타일 '||i,'brand','','code','','category','tile','scope','shared','description','','color','','finish','','widthMm',600,'heightMm',600,'depthMm',10,'usage','both','installation','floor','textureAssetIds',json_array(${id('1')}),'views',json_array()),'tile',0,'${stamp}' FROM n`,
      `${series} INSERT INTO d1_material_assets(version_id,asset_id) SELECT ${id('4')},${id('1')} FROM n`,
    ])
      await db.prepare(statement).run();
    const texture = await source(admin, 'texture', bindings);
    await create(tile(texture), bindings);
    await listImage(texture, admin, small, bindings);
    // A material the backfill has not reached yet: its image is read whole, then its list image saved.
    const missing = await source(admin, 'texture', bindings);
    await create(tile(missing), bindings);
    const meter = meterD1(db);
    const metered = { ...bindings, DB: meter.db } as D1Bindings;
    const cost = async (run: () => Promise<Response>) => {
      meter.reset();
      expect((await run()).status).toBe(200);
      return meter.summary();
    };
    return {
      member: await cost(() => read(texture, member, '&raw=1&size=list', metered)),
      public: await cost(() => publicRead(texture, '&size=list', metered)),
      backfill: await cost(() => call('materials', { operation: 'listImages' }, admin, metered)),
      check: await cost(() => call('materials', { operation: 'listImages', ids: [missing] }, admin, metered)),
      sourceMeta: await cost(() => read(missing, admin, '', metered)),
      sourceBytes: await cost(() => read(missing, admin, '&raw=1', metered)),
      save: await cost(async () => (await listImage(missing, admin, small, metered)).response),
      plans: [
        ...(
          await db
            .prepare('EXPLAIN QUERY PLAN ' + LIST_IMAGE_OF)
            .bind(texture)
            .all<{ detail: string }>()
        ).results,
      ].map((row) => row.detail),
    };
  }
  it('reads the same rows at five times the catalogue', async () => {
    const n = await scale('COST1', 100);
    const five = await scale('COST5', 500);
    console.log(JSON.stringify({ n, five }));
    for (const path of [
      'member',
      'public',
      'backfill',
      'check',
      'sourceMeta',
      'sourceBytes',
      'save',
    ] as const) {
      expect(five[path].queries, path).toBe(n[path].queries);
      expect(five[path].rowsRead, path).toBeLessThanOrEqual(
        Math.max(n[path].rowsRead * 1.5, n[path].rowsRead + 20),
      );
    }
    expect(n.member.rowsRead).toBeLessThanOrEqual(100);
    expect(n.public.rowsRead).toBeLessThanOrEqual(100);
    expect(n.check.rowsRead).toBeLessThanOrEqual(20);
    expect(n.save.rowsRead).toBeLessThanOrEqual(100);
    expect(n.plans.join(' ')).toContain('USING INDEX d1_assets_source');
    expect(n.plans.join(' ')).not.toMatch(/\bSCAN d1_assets\b/);
  }, 300_000);
});
