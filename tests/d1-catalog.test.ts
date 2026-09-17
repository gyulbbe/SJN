import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import sharp from 'sharp';
import { handleD1Request, checkD1Storage } from '../src/lib/d1';
import type { D1Bindings, D1DatabaseLike, D1Resource, D1Statement } from '../src/lib/d1/types';
import {
  publicImage,
  publicMaterials,
  publicPlacement,
  type PublicMaterial,
} from '../src/lib/catalog/public';
import {
  publicPlacementSchema,
  placementToMaterialVersion,
  type PublicPlacement,
} from '../src/lib/catalog/placement-contract';
import { emptySelection, type CatalogData, type CatalogSelection } from '../src/lib/catalog/contract';
import { readCatalog } from '../src/lib/catalog/server';
import type { MaterialInput, MaterialVersion } from '../src/lib/types';
import { allD1Migrations, applyD1Migrations } from './helpers/d1-migrations';

let mf: Miniflare;
let env: D1Bindings;
let png: Uint8Array<ArrayBuffer>;
const admin = { id: crypto.randomUUID(), isAdmin: true };
const member = { id: crypto.randomUUID(), isAdmin: false };
const other = { id: crypto.randomUUID(), isAdmin: false };
const anonymous = { id: '', isAdmin: false };
const stamp = '2026-09-16T00:00:00.000Z';
const masters = () => readCatalog(env.DB, true);
function request(resource: D1Resource, body: unknown, key?: string) {
  return new Request(`https://sjn.test/api/d1/${resource}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'X-Idempotency-Key': key } : {}) },
    body: JSON.stringify(body),
  });
}
function call(resource: D1Resource, body: unknown, actor = admin, key?: string, bindings = env) {
  return handleD1Request(resource, request(resource, body, key), bindings, actor);
}
function material(assetId: string, catalog?: CatalogSelection): MaterialInput {
  return {
    name: '공용 세면대',
    brand: '',
    code: '',
    category: 'basin',
    scope: 'shared',
    description: '',
    color: '',
    finish: '',
    widthMm: 600,
    heightMm: 800,
    depthMm: 400,
    usage: 'wall',
    installation: 'wall',
    coverAssetId: assetId,
    imageAssetIds: [assetId],
    textureAssetIds: [],
    views: [{ assetId, direction: '정면', anchor: { x: 0.5, y: 1 } }],
    defaultGroutWidth: 2,
    defaultGroutColor: '#ffffff',
    defaultPattern: 'grid',
    ...(catalog ? { catalog } : {}),
  };
}
async function upload(actor = admin, kind = 'product', sourceAssetId?: string, bindings = env) {
  const id = crypto.randomUUID();
  const data = new FormData();
  data.set(
    'metadata',
    JSON.stringify({ id, name: 'sample.png', kind, ...(sourceAssetId ? { sourceAssetId } : {}) }),
  );
  data.set('file', new Blob([png], { type: 'image/png' }), 'sample.png');
  const response = await handleD1Request(
    'assets',
    new Request('https://sjn.test/api/d1/assets', { method: 'POST', body: data }),
    bindings,
    actor,
  );
  return { id, response };
}
async function create(input: MaterialInput, actor = admin, resource: D1Resource = 'materials') {
  const response = await call(resource, { operation: 'create', input }, actor);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as MaterialVersion;
}
async function optionId(kind: string, name: string) {
  return (await masters()).options.find((row) => row.kind === kind && row.name === name)!.id;
}
async function image(id: string) {
  return publicImage(env, new Request(`https://sjn.test/api/catalog/images?id=${id}`));
}
async function listPublic() {
  return (await (await publicMaterials(env)).json()) as { materials: PublicMaterial[]; catalog: CatalogData };
}

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("local test")}};',
      compatibilityDate: '2026-09-07',
      d1Databases: { DB: 'catalog-empty-test', LEGACY: 'catalog-upgrade-test' },
      r2Buckets: ['ASSET_BUCKET'],
    }),
  );
  env = {
    DB: await mf.getD1Database('DB'),
    ASSET_BUCKET: await mf.getR2Bucket('ASSET_BUCKET'),
  } as unknown as D1Bindings;
  await applyD1Migrations(env.DB, allD1Migrations);
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM admin_roles').first()).toEqual({ count: 0 });
  for (const actor of [admin, member, other])
    await env.DB.prepare(
      'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)',
    )
      .bind(actor.id, '격리 테스트 회원', actor.id + '@example.test', 1, stamp, stamp)
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

describe('catalog additive D1 migrations', () => {
  it('applies all migrations to empty D1, enforces foreign keys, and seeds every required group', async () => {
    await expect(checkD1Storage(env)).resolves.toBeUndefined();
    const data = await masters();
    expect(data.options).toHaveLength(33);
    expect(data.subcategories).toHaveLength(21);
    expect(data.options.filter((row) => row.kind === 'color').map((row) => row.name)).toContain('그레이');
    expect(data.options.filter((row) => row.kind === 'brand').map((row) => row.name)).toContain('hansgrohe');
    expect(data.options.filter((row) => row.kind === 'composition')).toHaveLength(10);
    expect(data.options.filter((row) => row.kind === 'finish')).toHaveLength(7);
    expect((await env.DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    expect(await env.DB.prepare('SELECT version FROM d1_catalog_meta WHERE id=1').first()).toEqual({
      version: 1,
    });
    expect(await env.DB.prepare('SELECT user_id FROM admin_roles').all()).toMatchObject({
      results: [{ user_id: admin.id }],
    });
  });

  it('upgrades pre-existing materials without changing historical JSON or publishing private models', async () => {
    const db = (await mf.getD1Database('LEGACY')) as unknown as D1DatabaseLike;
    await applyD1Migrations(db, allD1Migrations.slice(0, 2));
    const first = {
      ...material(crypto.randomUUID()),
      brand: 'TOTO',
      color: '그레이',
      finish: '옛날 특수 마감',
      id: crypto.randomUUID(),
      materialId: crypto.randomUUID(),
      version: 1,
      createdAt: stamp,
    };
    const generated = {
      ...first,
      id: crypto.randomUUID(),
      materialId: crypto.randomUUID(),
      scope: 'personal',
      reconstruction: { version: 2, kind: 'basin' },
    };
    const oldSharedModel = {
      ...generated,
      id: crypto.randomUUID(),
      materialId: crypto.randomUUID(),
      scope: 'shared',
    };
    for (const version of [first, generated, oldSharedModel]) {
      await db
        .prepare(
          'INSERT INTO d1_materials(id,owner_id,scope,current_version_id,created_at,updated_at) VALUES(?,?,?,?,?,?)',
        )
        .bind(version.materialId, member.id, version.scope, version.id, stamp, stamp)
        .run();
      await db
        .prepare(
          "INSERT INTO d1_material_versions(id,material_id,version,payload_json,category,view_count,created_at) VALUES(?,?,1,?,'basin',1,?)",
        )
        .bind(version.id, version.materialId, JSON.stringify(version), stamp)
        .run();
    }
    await applyD1Migrations(db, allD1Migrations.slice(2));
    expect(
      await db
        .prepare('SELECT payload_json FROM d1_material_versions WHERE id=?')
        .bind(first.id)
        .first('payload_json'),
    ).toBe(JSON.stringify(first));
    expect(
      (
        await db
          .prepare(
            'SELECT option_kind FROM d1_material_version_options WHERE version_id=? ORDER BY option_kind',
          )
          .bind(first.id)
          .all()
      ).results,
    ).toEqual([{ option_kind: 'brand' }, { option_kind: 'color' }]);
    expect(
      await db
        .prepare('SELECT purpose,scope FROM d1_materials WHERE id=?')
        .bind(generated.materialId)
        .first(),
    ).toEqual({ purpose: 'project', scope: 'personal' });
    expect(
      await db.prepare("SELECT id FROM d1_catalog_options WHERE name='옛날 특수 마감'").first(),
    ).toBeNull();
    expect(
      await db.prepare('SELECT purpose FROM d1_materials WHERE id=?').bind(oldSharedModel.materialId).first(),
    ).toEqual({ purpose: 'project' });
    const publicLegacy = (await (await publicMaterials({ ...env, DB: db })).json()) as {
      materials: PublicMaterial[];
    };
    expect(publicLegacy.materials.map((row) => row.id)).toEqual([first.materialId]);

    await db
      .prepare(
        "UPDATE d1_catalog_options SET name='관리자 변경 이름',active=0 WHERE kind='brand' AND name='TOTO'",
      )
      .run();
    await applyD1Migrations(db, ['0004_catalog_seed.sql']);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM d1_catalog_options').first()).toEqual({
      count: 33,
    });
    expect(
      await db.prepare("SELECT name,active FROM d1_catalog_options WHERE normalized_name='toto'").first(),
    ).toEqual({ name: '관리자 변경 이름', active: 0 });
    expect(
      await db
        .prepare('SELECT payload_json FROM d1_material_versions WHERE id=?')
        .bind(first.id)
        .first('payload_json'),
    ).toBe(JSON.stringify(first));
  }, 30000);
});

describe('catalog master permissions and controlled IDs', () => {
  it('requires administrator privileges for master reads and writes, and rejects arbitrary operations', async () => {
    const input = { kind: 'color', name: '미등록 색상', active: true, sortOrder: 50, colorHex: '#ff00ff' };
    for (const operation of ['list', 'create', 'update']) {
      expect((await call('catalog', { operation, input }, anonymous)).status).toBe(401);
      expect((await call('catalog', { operation, input }, member)).status).toBe(403);
    }
    expect((await call('catalog', { operation: 'delete', input }, admin)).status).toBe(400);
    expect(
      await env.DB.prepare('SELECT id FROM d1_catalog_options WHERE name=?').bind(input.name).first(),
    ).toBeNull();
  });

  it('creates and edits registered values, rejects normalized duplicate names, and never changes their group', async () => {
    const input = { kind: 'brand', name: 'Test Brand', active: true, sortOrder: 10 };
    const made = await call('catalog', { operation: 'create', input }, admin, 'master-create');
    expect(made.status, await made.clone().text()).toBe(200);
    const { id } = await made.json();
    expect(
      (await call('catalog', { operation: 'create', input: { ...input, name: '  TEST   Brand  ' } })).status,
    ).toBe(409);
    expect(
      (await call('catalog', { operation: 'update', input: { ...input, id, kind: 'color' } })).status,
    ).toBe(400);
    expect(
      (
        await call('catalog', {
          operation: 'update',
          input: { ...input, id, name: '새 브랜드', active: false },
        })
      ).status,
    ).toBe(200);
    expect((await masters()).options.find((row) => row.id === id)).toMatchObject({
      name: '새 브랜드',
      active: false,
    });
    expect((await listPublic()).catalog.options.some((row) => row.id === id)).toBe(false);
    expect(
      (await call('catalog', { operation: 'create', input: { ...input, colorHex: '#ff00ff' } })).status,
    ).toBe(400);
    expect(
      (
        await call('catalog', {
          operation: 'create',
          input: {
            kind: 'subcategory',
            category: 'arbitrary-product',
            name: '임의',
            active: true,
            sortOrder: 0,
          },
        })
      ).status,
    ).toBe(400);
    const sub = await call('catalog', {
      operation: 'create',
      input: { kind: 'subcategory', category: 'basin', name: '테스트 분류', active: true, sortOrder: 90 },
    });
    expect(sub.status).toBe(200);
    const subId = (await sub.json()).id;
    expect(
      (
        await call('catalog', {
          operation: 'update',
          input: {
            id: subId,
            kind: 'subcategory',
            category: 'toilet',
            name: '테스트 분류',
            active: true,
            sortOrder: 90,
          },
        })
      ).status,
    ).toBe(400);
  });

  it('uses server names instead of forged text and creates immutable attribute snapshots', async () => {
    const { id } = await upload();
    const data = await masters();
    const brandId = await optionId('brand', 'TOTO');
    const colorIds = [await optionId('color', '그레이'), await optionId('color', '화이트')];
    const compositionId = await optionId('composition', '도기');
    const finishId = await optionId('finish', '무광');
    const subcategoryId = data.subcategories.find(
      (row) => row.category === 'basin' && row.name === '탑볼',
    )!.id;
    const selection = {
      brandId,
      colorIds,
      compositionIds: [compositionId],
      finishIds: [finishId],
      subcategoryId,
    };
    const first = await create({
      ...material(id, selection),
      brand: 'forged',
      color: 'fake',
      composition: 'fake',
      finish: 'fake',
      subcategoryName: 'fake',
    });
    expect(first).toMatchObject({
      brand: 'TOTO',
      color: '그레이 · 화이트',
      composition: '도기',
      finish: '무광',
      subcategoryName: '탑볼',
      catalog: selection,
      scope: 'shared',
    });
    expect(
      (
        await env.DB.prepare('SELECT option_id FROM d1_material_version_options WHERE version_id=?')
          .bind(first.id)
          .all()
      ).results,
    ).toHaveLength(5);
    const before = await env.DB.prepare('SELECT payload_json FROM d1_material_versions WHERE id=?')
      .bind(first.id)
      .first('payload_json');
    const selected = data.options.find((row) => row.id === brandId)!;
    try {
      expect(
        (
          await call('catalog', {
            operation: 'update',
            input: { ...selected, name: '이름 변경 TOTO', active: false },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await call('materials', {
            operation: 'update',
            id: first.materialId,
            expectedVersionId: first.id,
            input: material(id, selection),
          })
        ).status,
      ).toBe(400);
      expect(
        await env.DB.prepare('SELECT payload_json FROM d1_material_versions WHERE id=?')
          .bind(first.id)
          .first('payload_json'),
      ).toBe(before);
      const read = await (await call('materials', { operation: 'getVersion', id: first.id }, member)).json();
      expect(read.brand).toBe('TOTO');
      expect((await call('catalog', { operation: 'delete', input: { id: brandId } })).status).toBe(400);
    } finally {
      await call('catalog', { operation: 'update', input: selected });
    }
  });

  it('rejects free text, unknown IDs, wrong kinds, duplicates, inactive IDs and wrong parent categories', async () => {
    const { id } = await upload();
    const gray = await optionId('color', '그레이');
    const brand = await optionId('brand', 'TOTO');
    const data = await masters();
    const inactiveId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO d1_catalog_options(id,kind,name,normalized_name,active) VALUES(?,'brand','사용 중단 항목','사용 중단 항목',0)",
    )
      .bind(inactiveId)
      .run();
    const inactive = { id: inactiveId };
    const inactiveSub = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO d1_material_subcategories(id,category_code,name,normalized_name,active) VALUES(?,'basin','사용 중단 분류','사용 중단 분류',0)",
    )
      .bind(inactiveSub)
      .run();
    const badInputs = [
      { ...material(id), brand: '직접 입력 브랜드' },
      material(id, { ...emptySelection(), colorIds: [crypto.randomUUID()] }),
      material(id, { ...emptySelection(), colorIds: [brand] }),
      material(id, { ...emptySelection(), colorIds: [gray, gray] }),
      material(id, { ...emptySelection(), brandId: inactive.id }),
      material(id, { ...emptySelection(), subcategoryId: inactiveSub }),
      material(id, {
        ...emptySelection(),
        subcategoryId: data.subcategories.find((row) => row.category === 'toilet')!.id,
      }),
    ];
    for (const input of badInputs) {
      const response = await call('materials', { operation: 'create', input });
      expect(response.status, await response.clone().text()).toBe(400);
    }
    const empty = await create(material(id));
    expect(empty.catalog).toEqual(emptySelection());
    expect(empty.brand).toBe('');
  });

  it('keeps 61 selected attributes within the free request query budget and preserves long names on update', async () => {
    const { id } = await upload();
    const catalog = { ...emptySelection(), brandId: await optionId('brand', 'TOTO') };
    const statements: D1Statement[] = [];
    for (const [kind, key] of [
      ['color', 'colorIds'],
      ['composition', 'compositionIds'],
      ['finish', 'finishIds'],
    ] as const) {
      for (let index = 0; index < 20; index++) {
        const option = crypto.randomUUID();
        const name = `${kind}-${index}-` + '가'.repeat(100 - `${kind}-${index}-`.length);
        catalog[key].push(option);
        statements.push(
          env.DB.prepare('INSERT INTO d1_catalog_options(id,kind,name,normalized_name) VALUES(?,?,?,?)').bind(
            option,
            kind,
            name,
            name,
          ),
        );
      }
    }
    await env.DB.batch(statements);
    let count = 0;
    const native = new WeakMap<D1Statement, D1Statement>();
    function wrapped(statement: D1Statement): D1Statement {
      const proxy: D1Statement = {
        bind: (...args) => wrapped(statement.bind(...args)),
        first<T = Record<string, unknown>>(column?: string) {
          count++;
          return statement.first<T>(column);
        },
        all<T = Record<string, unknown>>() {
          count++;
          return statement.all<T>();
        },
        run<T = Record<string, unknown>>() {
          count++;
          return statement.run<T>();
        },
      };
      native.set(proxy, statement);
      return proxy;
    }
    const counted = {
      ...env,
      DB: {
        prepare: (sql: string) => wrapped(env.DB.prepare(sql)),
        batch<T = Record<string, unknown>>(rows: D1Statement[]) {
          count += rows.length;
          return env.DB.batch<T>(rows.map((row) => native.get(row)!));
        },
      },
    };
    const response = await call(
      'materials',
      { operation: 'create', input: material(id, catalog) },
      admin,
      undefined,
      counted,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const first = (await response.json()) as MaterialVersion;
    // Reserve ten queries for verified session/role/rate-limit wrapper checks.
    expect(count).toBeLessThanOrEqual(40);
    expect(
      (
        await env.DB.prepare('SELECT option_id FROM d1_material_version_options WHERE version_id=?')
          .bind(first.id)
          .all()
      ).results,
    ).toHaveLength(61);
    expect(first.color.length).toBe(2057);
    const update = await call('materials', {
      operation: 'update',
      id: first.materialId,
      expectedVersionId: first.id,
      input: { ...first, name: '긴 속성 이름 그대로 수정' },
    });
    expect(update.status, await update.clone().text()).toBe(200);
    expect((await update.json()).color).toBe(first.color);
  }, 30000);

  it('rolls back a material if a selected attribute becomes inactive before the committing batch', async () => {
    const { id } = await upload();
    const selected = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO d1_catalog_options(id,kind,name,normalized_name) VALUES(?,'color','동시 변경 테스트','동시 변경 테스트')",
    )
      .bind(selected)
      .run();
    let interleaved = false;
    const racing = {
      ...env,
      DB: {
        prepare: (sql: string) => env.DB.prepare(sql),
        async batch<T = Record<string, unknown>>(statements: D1Statement[]) {
          if (!interleaved) {
            interleaved = true;
            await env.DB.prepare('UPDATE d1_catalog_options SET active=0 WHERE id=?').bind(selected).run();
          }
          return env.DB.batch<T>(statements);
        },
      },
    };
    const response = await call(
      'materials',
      {
        operation: 'create',
        input: {
          ...material(id, { ...emptySelection(), colorIds: [selected] }),
          name: 'must roll back stale selection',
        },
      },
      admin,
      undefined,
      racing,
    );
    expect(response.status, await response.clone().text()).toBe(400);
    expect(interleaved).toBe(true);
    expect(
      await env.DB.prepare('SELECT version_id FROM d1_material_assets WHERE asset_id=?').bind(id).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare('SELECT version_id FROM d1_material_version_options WHERE option_id=?')
        .bind(selected)
        .first(),
    ).toBeNull();
  });

  it('enforces single-brand, option-kind foreign keys and matching subcategory category at the database level', async () => {
    const { id } = await upload();
    const firstBrand = await optionId('brand', 'TOTO');
    const secondBrand = await optionId('brand', 'KOHLER');
    const gray = await optionId('color', '그레이');
    const version = await create(material(id, { ...emptySelection(), brandId: firstBrand }));
    await expect(
      env.DB.prepare(
        'INSERT INTO d1_material_version_options(version_id,option_id,option_kind) VALUES(?,?,?)',
      )
        .bind(version.id, secondBrand, 'brand')
        .run(),
    ).rejects.toThrow(/UNIQUE/);
    await expect(
      env.DB.prepare(
        'INSERT INTO d1_material_version_options(version_id,option_id,option_kind) VALUES(?,?,?)',
      )
        .bind(version.id, gray, 'composition')
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/);
    await expect(
      env.DB.prepare(
        'INSERT INTO d1_material_version_options(version_id,option_id,option_kind) VALUES(?,?,?)',
      )
        .bind(crypto.randomUUID(), gray, 'color')
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/);
    for (const [kind, value] of [
      ['color', '#gggggg'],
      ['brand', '#ffffff'],
    ]) {
      await expect(
        env.DB.prepare(
          'INSERT INTO d1_catalog_options(id,kind,name,normalized_name,color_hex) VALUES(?,?,?,?,?)',
        )
          .bind(crypto.randomUUID(), kind, 'invalid hex', crypto.randomUUID(), value)
          .run(),
      ).rejects.toThrow(/CHECK/);
    }
    const toilet = (await masters()).subcategories.find((row) => row.category === 'toilet')!.id;
    await expect(
      env.DB.prepare('UPDATE d1_material_versions SET subcategory_id=? WHERE id=?')
        .bind(toilet, version.id)
        .run(),
    ).rejects.toThrow(/invalid subcategory/);
  });
});

describe('material role isolation and public media', () => {
  it('denies every ordinary-user material write including replays after losing the administrator role', async () => {
    const { id } = await upload(member);
    const input = material(id);
    expect(
      (await call('materials', { operation: 'create', input: { ...input, scope: 'personal' } }, member))
        .status,
    ).toBe(403);
    const body = { operation: 'create', input };
    await env.DB.prepare('INSERT INTO admin_roles(user_id) VALUES(?)').bind(member.id).run();
    const created = await call('materials', body, { ...member, isAdmin: true }, 'demoted-admin');
    await env.DB.prepare('DELETE FROM admin_roles WHERE user_id=?').bind(member.id).run();
    expect(created.status).toBe(200);
    const version = (await created.json()) as MaterialVersion;
    expect((await call('materials', body, member, 'demoted-admin')).status).toBe(403);
    expect((await call('materials', body, { ...member, isAdmin: true }, 'demoted-admin')).status).toBe(403);
    expect(
      (
        await call(
          'materials',
          { operation: 'update', id: version.materialId, expectedVersionId: version.id, input },
          member,
        )
      ).status,
    ).toBe(403);
    expect(
      (await call('materials', { operation: 'setActive', id: version.materialId, active: false }, member))
        .status,
    ).toBe(403);
    expect((await call('materials', { operation: 'list' }, anonymous)).status).toBe(401);
  });

  it('keeps photo-extracted and reconstruction resources private and available to their owner', async () => {
    const original = await upload(member, 'original');
    const derived = await upload(member, 'product', original.id);
    const input = { ...material(derived.id), scope: 'personal' as const };
    const extracted = await create(input, member, 'project-materials');
    const reconstructed = await create(
      { ...input, reconstruction: { version: 2, kind: 'basin' } },
      member,
      'project-materials',
    );
    const tileAsset = await upload(member, 'texture');
    const tile = await create(
      {
        ...input,
        category: 'tile',
        views: [],
        coverAssetId: undefined,
        imageAssetIds: undefined,
        textureAssetIds: [tileAsset.id],
        color: '#ffffff',
        finish: '기본 모형',
        reconstruction: { version: 1, kind: 'tile' },
      },
      member,
      'project-materials',
    );
    expect(tile.category).toBe('tile');

    for (const version of [extracted, reconstructed]) {
      expect(
        await env.DB.prepare('SELECT purpose,scope FROM d1_materials WHERE id=?')
          .bind(version.materialId)
          .first(),
      ).toEqual({ purpose: 'project', scope: 'personal' });
      expect((await call('materials', { operation: 'getVersion', id: version.id }, member)).status).toBe(200);
      expect((await call('materials', { operation: 'getVersion', id: version.id }, other)).status).toBe(404);
      expect((await listPublic()).materials.some((row) => row.id === version.materialId)).toBe(false);
    }
    const list = (await (await call('materials', { operation: 'list' }, other)).json()) as {
      version: MaterialVersion;
    }[];
    expect(list.some((row) => row.version.id === extracted.id)).toBe(false);
    await expect(image(derived.id)).rejects.toMatchObject({ status: 404 });
    expect((await call('project-materials', { operation: 'update', input }, member)).status).toBe(400);
    expect(
      (await call('project-materials', { operation: 'create', input: { ...input, scope: 'shared' } }, member))
        .status,
    ).toBe(403);
    expect(
      (await call('project-materials', { operation: 'create', input: { ...input, brand: 'TOTO' } }, member))
        .status,
    ).toBe(403);
    expect(
      (
        await call(
          'project-materials',
          { operation: 'create', input: { ...input, catalog: emptySelection() } },
          member,
        )
      ).status,
    ).toBe(403);
    expect((await call('project-materials', { operation: 'create', input }, other)).status).toBe(400);
    expect(
      (
        await call(
          'project-materials',
          { operation: 'create', input: { ...material(original.id), scope: 'personal' } },
          member,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call('materials', {
          operation: 'create',
          input: { ...input, reconstruction: { version: 2, kind: 'basin' } },
        })
      ).status,
    ).toBe(400);
  });

  it('returns only active shared catalog display data and never leaks ownership, project metadata or R2 keys', async () => {
    const original = await upload(admin, 'original');
    const displayed = await upload(admin, 'product', original.id);
    const version = await create(material(displayed.id));
    const response = await publicMaterials(env);
    const body = await response.text();
    const data = JSON.parse(body) as { materials: PublicMaterial[] };
    const entry = data.materials.find((row) => row.id === version.materialId)!;
    expect(entry).toBeTruthy();
    expect(entry.images).toEqual([{ url: `/api/catalog/images?id=${displayed.id}`, label: '정면' }]);
    const objectKey = await env.DB.prepare('SELECT object_key FROM d1_assets WHERE id=?')
      .bind(displayed.id)
      .first<string>('object_key');
    expect(body).not.toContain(objectKey);
    expect(body).not.toContain(admin.id);
    expect(body).not.toContain('ownerId');
    expect(body).not.toContain('sourceAssetId');
    expect(body).not.toContain('object_key');
    expect(body).not.toContain('payload_json');
    const publicFile = await image(displayed.id);
    expect(publicFile.headers.get('content-type')).toBe('image/png');
    expect(publicFile.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await publicFile.arrayBuffer())).toEqual(png);
    await expect(image(original.id)).rejects.toMatchObject({ status: 404 });
    expect(
      (await call('materials', { operation: 'setActive', id: version.materialId, active: false })).status,
    ).toBe(200);
    expect((await listPublic()).materials.some((row) => row.id === version.materialId)).toBe(false);
    await expect(image(displayed.id)).rejects.toMatchObject({ status: 404 });
  });

  it('exposes only the current published image and refuses original bytes even when referenced directly', async () => {
    const oldImage = await upload();
    const nextImage = await upload();
    const oldVersion = await create(material(oldImage.id));
    const updated = await call('materials', {
      operation: 'update',
      id: oldVersion.materialId,
      expectedVersionId: oldVersion.id,
      input: material(nextImage.id),
    });
    expect(updated.status, await updated.clone().text()).toBe(200);
    await expect(image(oldImage.id)).rejects.toMatchObject({ status: 404 });
    expect((await image(nextImage.id)).status).toBe(200);
    const original = await upload(admin, 'original');
    const originalVersion = await create(material(original.id));
    expect(
      (await listPublic()).materials.find((row) => row.id === originalVersion.materialId)?.images,
    ).toEqual([]);
    await expect(image(original.id)).rejects.toMatchObject({ status: 404 });
  });

  it('serves legacy cover-only display images without exposing hidden derivatives or legacy shared reconstruction models', async () => {
    const shown = await upload();
    const hidden = await upload(admin, 'preview');
    const version = await create({ ...material(shown.id), views: [], imageAssetIds: [shown.id] });
    expect((await listPublic()).materials.find((row) => row.id === version.materialId)?.images).toEqual([
      { url: `/api/catalog/images?id=${shown.id}`, label: '제품 이미지' },
    ]);
    expect((await image(shown.id)).status).toBe(200);
    await expect(image(hidden.id)).rejects.toMatchObject({ status: 404 });
    // Simulate a pre-migration shared reconstruction row with a mismatched purpose.
    // Even this legacy input is never made anonymous-public by a missing purpose migration.
    await env.DB.prepare(
      "UPDATE d1_material_versions SET payload_json=json_set(payload_json,'$.reconstruction',json(?)) WHERE id=?",
    )
      .bind(JSON.stringify({ version: 2, kind: 'basin' }), version.id)
      .run();
    expect((await listPublic()).materials.some((row) => row.id === version.materialId)).toBe(false);
    await expect(image(shown.id)).rejects.toMatchObject({ status: 404 });
  });

  it('does not create a material when its R2 asset upload failed', async () => {
    let attemptedWrite = false;
    const broken = {
      ...env,
      ASSET_BUCKET: {
        ...env.ASSET_BUCKET,
        put: async () => {
          attemptedWrite = true;
          throw new Error('R2 test outage');
        },
      },
    } as D1Bindings;
    const failed = await upload(admin, 'product', undefined, broken);
    expect(failed.response.status).toBe(503);
    expect(attemptedWrite).toBe(true);
    expect(await env.DB.prepare('SELECT id FROM d1_assets WHERE id=?').bind(failed.id).first()).toBeNull();
    const save = await call('materials', { operation: 'create', input: material(failed.id) });
    expect(save.status).toBe(400);
    expect(
      await env.DB.prepare('SELECT version_id FROM d1_material_assets WHERE asset_id=?')
        .bind(failed.id)
        .first(),
    ).toBeNull();
  });
});

describe('catalog update rejection preserves committed versions', () => {
  it('rejects malformed IDs in every selection field without changing versions, references, or seeds', async () => {
    const { id, response } = await upload();
    expect(response.status).toBe(200);
    const selection = {
      ...emptySelection(),
      brandId: await optionId('brand', 'TOTO'),
      colorIds: [await optionId('color', '그레이')],
    };
    const saved = await create(material(id, selection));
    const snapshot = async () => ({
      material: await env.DB.prepare('SELECT * FROM d1_materials WHERE id=?').bind(saved.materialId).first(),
      versions: (
        await env.DB.prepare('SELECT * FROM d1_material_versions WHERE material_id=? ORDER BY version')
          .bind(saved.materialId)
          .all()
      ).results,
      assets: (
        await env.DB.prepare('SELECT * FROM d1_material_assets WHERE version_id=? ORDER BY asset_id')
          .bind(saved.id)
          .all()
      ).results,
      options: (
        await env.DB.prepare(
          'SELECT * FROM d1_material_version_options WHERE version_id=? ORDER BY option_id',
        )
          .bind(saved.id)
          .all()
      ).results,
      catalog: await masters(),
    });
    const before = await snapshot();
    const malformed = [
      { ...selection, brandId: 'unregistered-brand' },
      { ...selection, subcategoryId: 'unregistered-subcategory' },
      { ...selection, colorIds: ['그레'] },
      { ...selection, compositionIds: ['직접 입력 재질'] },
      { ...selection, finishIds: ['새 마감'] },
      { ...selection, brandId: [selection.brandId] },
    ];
    for (const catalog of malformed) {
      const attempt = await call('materials', {
        operation: 'update',
        id: saved.materialId,
        expectedVersionId: saved.id,
        input: { ...material(id), catalog },
      });
      expect(attempt.status, await attempt.clone().text()).toBe(400);
    }
    expect(await snapshot()).toEqual(before);
    expect(await (await call('materials', { operation: 'getVersion', id: saved.id }, member)).json()).toEqual(
      saved,
    );
  });
});

describe('anonymous placement projections', () => {
  async function placement(materialId?: string) {
    return publicPlacement(
      env,
      new Request(
        'https://sjn.test/api/catalog/placement' +
          (materialId === undefined ? '' : '?materialId=' + encodeURIComponent(materialId)),
      ),
    );
  }
  async function data(materialId: string) {
    return (await (await placement(materialId)).json()) as PublicPlacement;
  }
  it('projects current placement dimensions, anchors and safe display metadata without nested private data', async () => {
    const original = await upload(admin, 'original');
    const shown = await upload(admin, 'product', original.id);
    const hidden = await upload(admin, 'preview');
    const version = await create(material(shown.id));
    // Historical payloads may contain mesh provenance and stale legacy image references.
    const stored = {
      ...version,
      coverAssetId: hidden.id,
      imageAssetIds: [hidden.id],
      views: [
        {
          ...version.views[0],
          product3d: {
            inputAssetId: original.id,
            meshAssetId: crypto.randomUUID(),
            modelId: 'private-model',
          },
        },
      ],
    };
    await env.DB.prepare('UPDATE d1_material_versions SET payload_json=? WHERE id=?')
      .bind(JSON.stringify(stored), version.id)
      .run();
    const result = await data(version.materialId);
    expect(publicPlacementSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      materialId: version.materialId,
      versionId: version.id,
      version: 1,
      widthMm: 600,
      heightMm: 800,
      depthMm: 400,
      usage: 'wall',
      installation: 'wall',
      views: [{ assetId: shown.id, direction: '정면', anchor: { x: 0.5, y: 1 } }],
      images: [
        {
          id: shown.id,
          url: '/api/catalog/images?id=' + shown.id,
          width: 8,
          height: 8,
          mime: 'image/png',
          kind: 'product',
        },
      ],
    });
    const text = JSON.stringify(result);
    for (const forbidden of [
      'ownerId',
      'sourceAssetId',
      'product3d',
      'inputAssetId',
      'meshAssetId',
      'object_key',
      'payload_json',
      'createdAt',
      original.id,
      hidden.id,
      admin.id,
    ]) {
      expect(text).not.toContain(forbidden);
    }
    const list = (await (await placement()).json()) as { placements: PublicPlacement[] };
    expect(list.placements.find((row) => row.materialId === version.materialId)).toEqual(result);
    const converted = placementToMaterialVersion(result);
    expect(converted.id).toBe(version.id);
    expect(converted.scope).toBe('shared');
    expect(converted.views).toEqual(result.views);
    converted.views[0].anchor.x = 0;
    expect(result.views[0].anchor.x).toBe(0.5);
    expect(converted).not.toHaveProperty('product3d');
  });

  it('includes only registered current prices and packaging without exposing old versions or inventing missing prices', async () => {
    const shown = await upload(admin);
    const pricing = {
      unit: 'box' as const,
      unitPrice: 24000,
      boxCoverageM2: 1.44,
      piecesPerBox: 4,
      wastePercent: 5,
    };
    const original = await create({ ...material(shown.id), pricing });
    const result = await data(original.materialId);
    expect(result.pricing).toEqual(pricing);
    const converted = placementToMaterialVersion(result);
    expect(converted.pricing).toEqual(pricing);
    converted.pricing!.unitPrice = 1;
    expect(result.pricing!.unitPrice).toBe(24000);
    const updated = await call('materials', {
      operation: 'update',
      id: original.materialId,
      expectedVersionId: original.id,
      input: { ...material(shown.id), pricing: { ...pricing, unitPrice: 28000 } },
    });
    expect(updated.status).toBe(200);
    expect((await data(original.materialId)).pricing!.unitPrice).toBe(28000);
    const old = await call('materials', { operation: 'getVersion', id: original.id }, member);
    expect((await old.json()).pricing.unitPrice).toBe(24000);
    const unpriced = await create(material(shown.id));
    const legacy = await data(unpriced.materialId);
    expect(legacy.pricing).toBeUndefined();
    expect(placementToMaterialVersion(legacy).pricing).toBeUndefined();
    expect(
      publicPlacementSchema.safeParse({ ...legacy, pricing: { ...pricing, unitPrice: -1 } }).success,
    ).toBe(false);
    expect(
      publicPlacementSchema.safeParse({ ...legacy, pricing: { ...pricing, piecesPerBox: 0 } }).success,
    ).toBe(false);
    const withUnknown = publicPlacementSchema.parse({
      ...legacy,
      pricing: { ...pricing, ownerId: 'private' },
    });
    expect(withUnknown.pricing).not.toHaveProperty('ownerId');
  });

  it('allows tile textures and legacy display fallbacks while rejecting non-display originals', async () => {
    const texture = await upload(admin, 'texture');
    const tile = await create({
      ...material(texture.id),
      category: 'tile',
      usage: 'both',
      installation: 'floor',
      textureAssetIds: [texture.id],
      views: [],
    });
    const tileData = await data(tile.materialId);
    expect(tileData.textureAssetIds).toEqual([texture.id]);
    expect(tileData.views).toEqual([]);
    expect(tileData).not.toHaveProperty('coverAssetId');
    const legacyImage = await upload(admin, 'preview');
    const legacy = await create({ ...material(legacyImage.id), views: [] });
    const legacyData = await data(legacy.materialId);
    expect(legacyData.coverAssetId).toBe(legacyImage.id);
    expect(legacyData.imageAssetIds).toEqual([legacyImage.id]);
    expect(legacyData.images.map((image) => image.id)).toEqual([legacyImage.id]);
    const original = await upload(admin, 'original');
    const unusable = await create(material(original.id));
    await expect(placement(unusable.materialId)).rejects.toMatchObject({ status: 404 });
    const mixed = await create({
      ...material(legacyImage.id),
      views: [
        { assetId: original.id, direction: '정면', anchor: { x: 0.5, y: 1 } },
        { assetId: legacyImage.id, direction: '옆면', anchor: { x: 0.3, y: 1 } },
      ],
    });
    // Omitting the private first view would silently turn guest viewIndex 0 into another view.
    await expect(placement(mixed.materialId)).rejects.toMatchObject({ status: 404 });
  }, 10000);

  it('never resolves guessed private, past-version, inactive or reconstructed material IDs', async () => {
    const shown = await upload();
    const first = await create(material(shown.id));
    const nextImage = await upload();
    const update = await call('materials', {
      operation: 'update',
      id: first.materialId,
      expectedVersionId: first.id,
      input: material(nextImage.id),
    });
    expect(update.status).toBe(200);
    const next = (await update.json()) as MaterialVersion;
    expect((await data(first.materialId)).versionId).toBe(next.id);
    await expect(placement(first.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      publicPlacement(env, new Request('https://sjn.test/api/catalog/placement?versionId=' + first.id)),
    ).rejects.toMatchObject({ status: 400 });
    await expect(image(shown.id)).rejects.toMatchObject({ status: 404 });
    expect(
      (await call('materials', { operation: 'setActive', id: first.materialId, active: false })).status,
    ).toBe(200);
    await expect(placement(first.materialId)).rejects.toMatchObject({ status: 404 });
    const privateSource = await upload(member, 'original');
    const privateImage = await upload(member, 'product', privateSource.id);
    const privateVersion = await create(
      { ...material(privateImage.id), scope: 'personal' },
      member,
      'project-materials',
    );
    await expect(placement(privateVersion.materialId)).rejects.toMatchObject({ status: 404 });
    const oldModel = await create(material(nextImage.id));
    await env.DB.prepare(
      "UPDATE d1_material_versions SET payload_json=json_set(payload_json,'$.reconstruction',json(?)) WHERE id=?",
    )
      .bind(JSON.stringify({ version: 2, kind: 'basin' }), oldModel.id)
      .run();
    await expect(placement(oldModel.materialId)).rejects.toMatchObject({ status: 404 });
    await expect(placement('not-an-id')).rejects.toMatchObject({ status: 404 });
  }, 15000);

  it('rejects tampered stored DTO URLs, unknown fields and image references', async () => {
    const shown = await upload();
    const version = await create(material(shown.id));
    const dto = await data(version.materialId);
    expect(publicPlacementSchema.safeParse({ ...dto, ownerId: admin.id }).success).toBe(false);
    expect(
      publicPlacementSchema.safeParse({
        ...dto,
        views: [{ ...dto.views[0], product3d: { meshAssetId: crypto.randomUUID() } }],
      }).success,
    ).toBe(false);
    expect(
      publicPlacementSchema.safeParse({
        ...dto,
        images: [{ ...dto.images[0], url: '/api/d1/assets?id=' + shown.id }],
      }).success,
    ).toBe(false);
    expect(
      publicPlacementSchema.safeParse({
        ...dto,
        views: [{ ...dto.views[0], assetId: crypto.randomUUID() }],
      }).success,
    ).toBe(false);
  });
});
