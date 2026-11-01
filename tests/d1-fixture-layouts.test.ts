import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import sharp from 'sharp';
import { checkD1Storage, handleD1Request } from '../src/lib/d1';
import type { D1Bindings, D1DatabaseLike } from '../src/lib/d1/types';
import { publicLayouts } from '../src/lib/catalog/layouts-server';
import type { LayoutItem, ManagedLayout, PublicLayouts } from '../src/lib/fixture-layout-contract';
import type { MaterialInput, MaterialVersion } from '../src/lib/types';
import { allD1Migrations, applyD1Migrations, migrationStatements } from './helpers/d1-migrations';
import { meterD1 } from './helpers/d1-meter';
import { readFile } from 'node:fs/promises';

/**
 * 기본 배치 on a real local D1 (migration 0013, docs/fixture-layouts-results-20261101.md): administrators
 * only, retries, revisions, only what anyone can read goes in, what the public list shows and leaves
 * out, the upgrade from 0012, and the cost (d1-query-budget).
 */
let mf: Miniflare;
let env: D1Bindings;
let png: Uint8Array<ArrayBuffer>;
const admin = { id: crypto.randomUUID(), isAdmin: true };
const member = { id: crypto.randomUUID(), isAdmin: false };
const stamp = '2026-11-01T00:00:00.000Z';
const room = { widthMm: 2400, depthMm: 2400, heightMm: 2400 };

function call(
  resource: 'fixture-layouts' | 'materials' | 'assets',
  body: unknown,
  actor = admin,
  headers: Record<string, string> = {},
  bindings = env,
) {
  return handleD1Request(
    resource,
    new Request(`https://sjn.test/api/d1/${resource}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    bindings,
    actor,
  );
}
const manage = (operation: string, input?: unknown, actor = admin, headers = {}) =>
  call('fixture-layouts', { operation, input }, actor, headers);
const managed = async () => ((await (await manage('list')).json()) as { layouts: ManagedLayout[] }).layouts;
const publicList = async (bindings = env) => (await (await publicLayouts(bindings)).json()) as PublicLayouts;

async function upload(actor = admin) {
  const id = crypto.randomUUID();
  const data = new FormData();
  data.set('metadata', JSON.stringify({ id, name: 'p.png', kind: 'product' }));
  data.set('file', new Blob([png], { type: 'image/png' }), 'p.png');
  const response = await handleD1Request(
    'assets',
    new Request('https://sjn.test/api/d1/assets', { method: 'POST', body: data }),
    env,
    actor,
  );
  expect(response.status).toBe(200);
  return id;
}
async function product(name: string, over: Partial<MaterialInput> = {}, actor = admin) {
  const assetId = await upload(actor);
  const input: MaterialInput = {
    name,
    brand: '',
    code: '',
    category: 'toilet',
    scope: 'shared',
    description: '',
    color: '',
    finish: '',
    widthMm: 400,
    heightMm: 700,
    depthMm: 600,
    usage: 'both',
    installation: 'floor',
    textureAssetIds: [],
    views: [{ assetId, direction: '정면', anchor: { x: 0.5, y: 0.95 } }],
    defaultGroutWidth: 2,
    defaultGroutColor: '#ffffff',
    defaultPattern: 'grid',
    catalog: { colorIds: [], compositionIds: [], finishIds: [] },
    ...over,
  };
  const response = await call('materials', { operation: 'create', input }, actor);
  expect(response.status).toBe(200);
  return (await response.json()) as MaterialVersion;
}
const item = (materialId: string, over: Partial<LayoutItem> = {}): LayoutItem => ({
  materialId,
  face: 'floor',
  u: 0.3,
  v: 0.5,
  scale: 1,
  rotation: 0,
  direction: '정면',
  color: { exposure: 0, contrast: 1, saturation: 1, warmth: 0 },
  shadow: { x: 0, y: 0.005, opacity: 0.3, blur: 0.015, scale: 0.7 },
  ...over,
});
const created = async (name: string, items: LayoutItem[], sortOrder: number | null = null) => {
  const response = await manage('create', { name, sortOrder, active: true, items, room });
  expect(response.status).toBe(200);
  return ((await response.json()) as { id: string }).id;
};
const clear = () => env.DB.prepare('DELETE FROM d1_fixture_layouts').run();

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("local test")}};',
      compatibilityDate: '2026-09-07',
      d1Databases: { DB: 'layouts-test', UPGRADE: 'layouts-upgrade-test', OLD: 'layouts-old-test' },
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
      .bind(actor.id, '배치 시험 회원', actor.id + '@example.test', 1, stamp, stamp)
      .run();
  await env.DB.prepare('INSERT INTO admin_roles(user_id) VALUES(?)').bind(admin.id).run();
  png = new Uint8Array(
    await sharp({ create: { width: 8, height: 8, channels: 4, background: '#888888ff' } })
      .png()
      .toBuffer(),
  );
}, 60000);
afterAll(async () => {
  await mf?.dispose();
});

describe('migration 0013', { timeout: 120000 }, () => {
  it('빈 DB에 적용되고 준비 검사가 표를 본다', async () => {
    await expect(checkD1Storage(env)).resolves.toBeUndefined();
    const row = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='d1_fixture_layouts'",
    ).first();
    expect(row).toBeTruthy();
  });
  it('0012 DB를 올려도 다른 표의 행은 그대로이고 행을 쓰지 않는다', async () => {
    const db = (await mf.getD1Database('UPGRADE')) as unknown as D1DatabaseLike;
    await applyD1Migrations(
      db,
      allD1Migrations.filter((file) => file !== '0013_fixture_layouts.sql'),
    );
    const bindings = { DB: db, ASSET_BUCKET: env.ASSET_BUCKET } as unknown as D1Bindings;
    await expect(checkD1Storage(bindings)).rejects.toThrow('incomplete');
    // Before 0013 there are simply none.
    expect(await publicList(bindings)).toEqual({ layouts: [], placements: [] });
    const kinds = () => db.prepare('SELECT count(*) AS n FROM d1_material_kinds').first<{ n: number }>();
    const before = await kinds();
    const meter = meterD1(db);
    for (const statement of migrationStatements(
      await readFile('migrations/d1/0013_fixture_layouts.sql', 'utf8'),
    ))
      await meter.db.prepare(statement).run();
    expect(meter.summary().queries).toBe(1);
    console.log('0013', meter.summary());
    expect(await kinds()).toEqual(before);
    expect((await db.prepare('SELECT count(*) AS n FROM d1_fixture_layouts').first<{ n: number }>())?.n).toBe(
      0,
    );
    await expect(checkD1Storage(bindings)).resolves.toBeUndefined();
  });
});

describe('관리', { timeout: 120000 }, () => {
  it('관리자만 한다', async () => {
    await clear();
    const shared = await product('공용 변기');
    for (const operation of ['list', 'create', 'save', 'update', 'remove'])
      expect((await manage(operation, {}, member)).status).toBe(403);
    expect((await manage('list')).status).toBe(200);
    expect(
      (
        await manage(
          'create',
          { name: 'x', sortOrder: null, active: true, items: [item(shared.materialId)], room },
          member,
        )
      ).status,
    ).toBe(403);
    expect(await publicList()).toEqual({ layouts: [], placements: [] });
  });
  it('입력을 검사하고 지원하지 않는 작업을 거절한다', async () => {
    const shared = await product('검사 변기');
    const good = { name: 'x', sortOrder: null, active: true, items: [item(shared.materialId)], room };
    expect((await manage('create', { ...good, name: ' ' })).status).toBe(400);
    expect((await manage('create', { ...good, items: [] })).status).toBe(400);
    expect((await manage('create', { ...good, sortOrder: 10000 })).status).toBe(400);
    expect((await manage('create', { ...good, items: Array(21).fill(item(shared.materialId)) })).status).toBe(
      400,
    );
    expect(
      (await manage('create', { ...good, items: [{ ...item(shared.materialId), locked: true }] })).status,
    ).toBe(400);
    expect((await manage('nope')).status).toBe(400);
  });
  it('같은 재시도 키는 한 번만 쓰고, 다른 내용이면 거절한다', async () => {
    await clear();
    const shared = await product('재시도 변기');
    const input = { name: '재시도', sortOrder: null, active: true, items: [item(shared.materialId)], room };
    const key = { 'X-Idempotency-Key': 'layout-retry-1' };
    const first = await manage('create', input, admin, key);
    const second = await manage('create', input, admin, key);
    expect(first.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect(await managed()).toHaveLength(1);
    expect((await manage('create', { ...input, name: '다른 이름' }, admin, key)).status).toBe(409);
  });
  it('revision이 다르면 어떤 쓰기든 409다', async () => {
    await clear();
    const shared = await product('revision 변기');
    const id = await created('revision', [item(shared.materialId)]);
    const row = (await managed())[0]!;
    expect(row.revision).toBe(1);
    const change = { id, revision: 1, name: '새 이름', sortOrder: 3, active: true };
    expect((await manage('update', change)).status).toBe(200);
    expect((await manage('update', change)).status).toBe(409);
    expect(
      (await manage('save', { id, name: 'x', revision: 1, items: [item(shared.materialId)], room })).status,
    ).toBe(409);
    expect((await manage('remove', { id, revision: 1 })).status).toBe(409);
    const after = (await managed())[0]!;
    expect(after).toMatchObject({ name: '새 이름', sortOrder: 3, revision: 2 });
    expect(
      (
        await manage('save', {
          id,
          name: '고친 이름',
          revision: 2,
          items: [item(shared.materialId, { u: 0.7 })],
          room: { ...room, widthMm: 3000 },
        })
      ).status,
    ).toBe(200);
    expect((await managed())[0]).toMatchObject({ name: '고친 이름', revision: 3, room: { widthMm: 3000 } });
    expect((await managed())[0]!.items[0]!.u).toBe(0.7);
    expect((await manage('remove', { id, revision: 3 })).status).toBe(200);
    expect(await managed()).toEqual([]);
    expect((await manage('remove', { id, revision: 3 })).status).toBe(409);
  });
  it('개인 자재·사진 분석 모형·타일·없는 자재는 등록을 거절한다(만들기와 덮어쓰기)', async () => {
    await clear();
    const shared = await product('공용 세면대');
    // An administrator's own form only makes shared materials: these are made what they would be.
    const personal = await product('개인 변기');
    await env.DB.prepare("UPDATE d1_materials SET scope='personal' WHERE id=?")
      .bind(personal.materialId)
      .run();
    const project = await product('프로젝트 전용 변기');
    await env.DB.prepare("UPDATE d1_materials SET purpose='project' WHERE id=?")
      .bind(project.materialId)
      .run();
    const analysed = await product('분석 변기');
    const analysedVersion = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO d1_material_versions(id,material_id,version,payload_json,category,view_count,created_at) VALUES(?,?,2,?,?,1,?)',
      ).bind(
        analysedVersion,
        analysed.materialId,
        JSON.stringify({
          ...analysed,
          id: analysedVersion,
          version: 2,
          reconstruction: { version: 2, kind: 'toilet' },
        }),
        'toilet',
        stamp,
      ),
      env.DB.prepare('UPDATE d1_materials SET current_version_id=? WHERE id=?').bind(
        analysedVersion,
        analysed.materialId,
      ),
    ]);
    const tileAsset = await upload();
    const tile = await product('타일', {
      category: 'tile',
      views: [],
      textureAssetIds: [tileAsset],
    });
    const bad = [
      personal.materialId,
      project.materialId,
      analysed.materialId,
      tile.materialId,
      crypto.randomUUID(),
    ];
    for (const materialId of bad) {
      const response = await manage('create', {
        name: '거절',
        sortOrder: null,
        active: true,
        items: [item(shared.materialId), item(materialId)],
        room,
      });
      expect(response.status).toBe(400);
    }
    const id = await created('덮어쓰기 시험', [item(shared.materialId)]);
    expect(
      (await manage('save', { id, name: 'x', revision: 1, items: [item(personal.materialId)], room })).status,
    ).toBe(400);
    expect((await managed())[0]!.items[0]!.materialId).toBe(shared.materialId);
  });
  it('30개까지만 만든다', async () => {
    await clear();
    const shared = await product('한도 변기');
    for (let i = 0; i < 30; i++)
      await env.DB.prepare(
        "INSERT INTO d1_fixture_layouts(id,name,items_json,room_json,created_by) VALUES(?,?,?,?,'t')",
      )
        .bind(crypto.randomUUID(), `n${i}`, JSON.stringify([item(shared.materialId)]), JSON.stringify(room))
        .run();
    const response = await manage('create', {
      name: '31번째',
      sortOrder: null,
      active: true,
      items: [item(shared.materialId)],
      room,
    });
    expect(response.status).toBe(400);
    expect(await managed()).toHaveLength(30);
    await clear();
  });
});

describe('공개 목록', { timeout: 120000 }, () => {
  it('순서대로 주고, 숨긴 배치는 빠지며, 번호를 만들 값만 있다', async () => {
    await clear();
    const shared = await product('순서 변기');
    const items = [item(shared.materialId)];
    await created('없음 나', items);
    await created('둘째', items, 5);
    const first = await created('첫째', items, 0);
    await created('없음 가', items);
    const hidden = await created('숨김', items, 1);
    await manage('update', { id: hidden, revision: 1, name: '숨김', sortOrder: 1, active: false });
    const list = await publicList();
    expect(list.layouts.map((layout) => layout.name)).toEqual(['첫째', '둘째', '없음 가', '없음 나']);
    expect(list.layouts[0]!.id).toBe(first);
    expect((await managed()).map((layout) => layout.name)).toContain('숨김');
  });
  it('내린 자재는 그 제품만 빠지고, 모두 빠지면 배치도 빠진다. 현재 버전을 준다', async () => {
    await clear();
    const stays = await product('남는 변기');
    const goes = await product('내릴 세면대');
    const alone = await product('혼자 내릴 욕조');
    await created('둘', [item(stays.materialId), item(goes.materialId, { u: 0.7 })], 0);
    await created('하나', [item(alone.materialId)], 1);
    for (const material of [goes, alone])
      expect(
        (await call('materials', { operation: 'setActive', id: material.materialId, active: false })).status,
      ).toBe(200);
    let list = await publicList();
    expect(list.layouts).toHaveLength(1);
    expect(list.layouts[0]).toMatchObject({ name: '둘', missing: 1 });
    expect(list.layouts[0]!.items.map((entry) => entry.materialId)).toEqual([stays.materialId]);
    expect(list.placements.map((placement) => placement.materialId)).toEqual([stays.materialId]);
    const row = (await managed()).find((layout) => layout.name === '둘')!;
    // What a hidden layout's editor needs comes with the list; the gone product's does not.
    const list2 = (await (await manage('list')).json()) as { placements: { materialId: string }[] };
    expect(list2.placements.map((placement) => placement.materialId)).toEqual([stays.materialId]);
    expect(row).toMatchObject({ products: ['남는 변기'], missing: 1 });
    // A new version of the material is what a press now places: the layout holds the material's id.
    const updated = await call('materials', {
      operation: 'update',
      id: stays.materialId,
      expectedVersionId: stays.id,
      input: { ...stays, name: '고친 변기', catalog: { colorIds: [], compositionIds: [], finishIds: [] } },
    });
    expect(updated.status).toBe(200);
    list = await publicList();
    expect(list.placements[0]).toMatchObject({ name: '고친 변기' });
    expect(list.placements[0]!.versionId).not.toBe(stays.id);
  });
  it('응답에 회원 정보·R2 키·전체 payload·만든 사람이 없다', async () => {
    await clear();
    const shared = await product('금지 변기');
    await created('금지', [item(shared.materialId)]);
    const text = JSON.stringify(await publicList());
    for (const word of [
      admin.id,
      'object_key',
      'assets/',
      'created_by',
      'createdBy',
      'ownerId',
      'owner_id',
      'email',
      'revision',
      'payload_json',
    ])
      expect(text).not.toContain(word);
  });
  it('읽을 수 없는 행 하나가 목록을 막지 않는다', async () => {
    await clear();
    const shared = await product('깨진 행 변기');
    await created('멀쩡', [item(shared.materialId)]);
    await env.DB.prepare(
      "INSERT INTO d1_fixture_layouts(id,name,items_json,room_json,created_by) VALUES(?,'깨짐','{',?,'t')",
    )
      .bind(crypto.randomUUID(), JSON.stringify(room))
      .run();
    expect((await publicList()).layouts.map((layout) => layout.name)).toEqual(['멀쩡']);
  });
});

describe('비용 (d1-query-budget)', { timeout: 300000 }, () => {
  /** Materials and layouts that have nothing to do with the list: the catalogue grows, the read must not. */
  async function grow(count: number) {
    for (let i = 0; i < count; i++) await product(`다른 자재 ${i}`);
  }
  it('자재가 늘어도 공개 목록의 쿼리 수와 읽은 행이 커지지 않는다', async () => {
    await clear();
    const a = await product('비용 변기'),
      b = await product('비용 세면대', { category: 'basin' });
    await created('1', [item(a.materialId), item(b.materialId, { u: 0.7 })], 0);
    await created('2', [item(b.materialId)], 1);
    const measure = async () => {
      const meter = meterD1(env.DB);
      const response = await publicLayouts({ ...env, DB: meter.db } as D1Bindings);
      expect(response.status).toBe(200);
      return meter;
    };
    await grow(6);
    const n = await measure();
    await grow(24);
    const big = await measure();
    console.log(
      'public N',
      n.summary(),
      n.records.map((r) => [r.rowsRead, r.sql.slice(0, 50)]),
    );
    console.log('public 5N', big.summary());
    expect(big.records.length).toBe(n.records.length);
    expect(n.records.length).toBeLessThanOrEqual(3);
    // 2 layouts, 2 materials, 2 images: a list is bounded by what it returns.
    expect(big.summary().rowsRead).toBeLessThanOrEqual(n.summary().rowsRead * 1.5 + 20);
    expect(big.summary().rowsRead).toBeLessThanOrEqual(100);
    expect(big.summary().rowsWritten).toBe(0);
  }, 120000);
  it('제품이 늘면 읽은 행은 제품 수에 비례하고 쿼리 수는 그대로다', async () => {
    await clear();
    const materials = [];
    for (let i = 0; i < 10; i++) materials.push(await product(`비례 ${i}`));
    const measure = async () => {
      const meter = meterD1(env.DB);
      await publicLayouts({ ...env, DB: meter.db } as D1Bindings);
      return meter;
    };
    await created(
      '둘',
      materials.slice(0, 2).map((m) => item(m.materialId)),
    );
    const two = await measure();
    await clear();
    await created(
      '열',
      materials.map((m) => item(m.materialId)),
    );
    const ten = await measure();
    console.log('2 items', two.summary(), '10 items', ten.summary());
    expect(ten.records.length).toBe(two.records.length);
    expect(ten.summary().rowsRead).toBeLessThanOrEqual(10 * 30 + 20);
  }, 120000);
  it('쓰기 작업의 비용이 표 크기와 무관하게 작다', async () => {
    await clear();
    const shared = await product('쓰기 변기');
    const metered = { ...env };
    const run = async (operation: string, input: unknown) => {
      const meter = meterD1(env.DB);
      metered.DB = meter.db;
      const response = await call(
        'fixture-layouts',
        { operation, input },
        admin,
        { 'X-Idempotency-Key': crypto.randomUUID() },
        metered as D1Bindings,
      );
      expect(response.status).toBe(200);
      return { meter, value: (await response.json()) as { id: string } };
    };
    const made = await run('create', {
      name: '쓰기',
      sortOrder: null,
      active: true,
      items: [item(shared.materialId)],
      room,
    });
    const saved = await run('save', {
      id: made.value.id,
      name: '쓰기',
      revision: 1,
      items: [item(shared.materialId, { u: 0.6 })],
      room,
    });
    const changed = await run('update', {
      id: made.value.id,
      revision: 2,
      name: '이름',
      sortOrder: 1,
      active: false,
    });
    const removed = await run('remove', { id: made.value.id, revision: 3 });
    for (const [name, step] of Object.entries({ made, saved, changed, removed })) {
      console.log(name, step.meter.summary());
      // One row of the table; the rest are the retry record, the batch's guards and their indexes.
      expect(step.meter.summary().rowsWritten).toBeLessThanOrEqual(14);
      expect(step.meter.summary().rowsRead).toBeLessThanOrEqual(60);
    }
  }, 60000);
  it('쿼리 계획: 자재 표는 id에서 출발하고, 전체 읽기는 작은 새 표뿐이다', async () => {
    const plan = async (query: string, ...values: unknown[]) =>
      (
        await env.DB.prepare('EXPLAIN QUERY PLAN ' + query)
          .bind(...values)
          .all<{ detail: string }>()
      ).results.map((row) => row.detail);
    const list = await plan(
      'SELECT id,name,display_order AS sortOrder,active,revision,items_json,room_json FROM d1_fixture_layouts WHERE active=1 ORDER BY display_order IS NULL,display_order,name,id',
    );
    expect(list.join(' ')).toContain('SCAN d1_fixture_layouts');
    const current = await plan(
      `SELECT m.id FROM json_each(?) q CROSS JOIN d1_materials m CROSS JOIN d1_material_versions v
       WHERE m.id=q.value AND v.id=m.current_version_id`,
      '[]',
    );
    expect(current.join(' ')).not.toMatch(/SCAN (m|v|d1_materials|d1_material_versions)\b/);
    expect(current.join(' ')).toMatch(/SEARCH m/);
  });
});
