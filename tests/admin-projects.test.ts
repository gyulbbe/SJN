import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import sharp from 'sharp';
import { allD1Migrations, applyD1Migrations } from './helpers/d1-migrations';
import { adminProjects, adminProjectAssets, adminProjectMaterials } from '../src/lib/admin/projects';
import { handleD1Request } from '../src/lib/d1';
import type { D1Actor, D1Bindings, D1Resource, D1Statement } from '../src/lib/d1/types';
import { normalizeProjectDocument } from '../src/lib/comparison';
import { DEFAULT_ROOM, createRoomSurfaces } from '../src/lib/room-geometry';
import {
  DEFAULT_COLOR,
  EMPTY_MASK,
  type ProjectDocument,
  type MaterialInput,
  type MaterialVersion,
  type FixtureInstance,
} from '../src/lib/types';

let mf: Miniflare, env: D1Bindings, png: Uint8Array<ArrayBuffer>;
const now = '2026-09-17T00:00:00.000Z';
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("isolated")}};',
      compatibilityDate: '2026-09-07',
      d1Databases: { DB: 'admin-projects-test' },
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
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});
async function user(admin = false): Promise<D1Actor> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)',
  )
    .bind(id, admin ? '관리자' : '일반 회원', `${id}@example.test`, 1, now, now)
    .run();
  if (admin) await env.DB.prepare('INSERT INTO admin_roles(user_id) VALUES(?)').bind(id).run();
  return { id, isAdmin: admin };
}
function req(path: string, body?: unknown, key?: string) {
  return new Request(
    'https://sjn.test' + path,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Idempotency-Key': key } : {}) },
          body: JSON.stringify(body),
        },
  );
}
function regular(actor: D1Actor, resource: D1Resource, body: unknown) {
  return handleD1Request(resource, req('/api/d1/' + resource, body), env, actor);
}
function call(actor: D1Actor, body?: unknown, query = '', key?: string, bindings = env) {
  return adminProjects({ env: bindings, actor }, req('/api/admin/projects' + query, body, key));
}
function resource(actor: D1Actor, projectId: string, body: Record<string, unknown>, key?: string) {
  return adminProjectMaterials(
    { env, actor },
    req('/api/admin/project-materials', { projectId, ...body }, key),
  );
}
async function upload(
  actor: D1Actor,
  options: { projectId?: string; sourceAssetId?: string; id?: string } = {},
  bindings = env,
) {
  const id = options.id ?? crypto.randomUUID(),
    form = new FormData();
  form.set(
    'metadata',
    JSON.stringify({
      id,
      kind: 'product',
      name: 'test.png',
      ownerId: 'forged-owner',
      ...(options.sourceAssetId ? { sourceAssetId: options.sourceAssetId } : {}),
    }),
  );
  form.set('file', new Blob([png], { type: 'image/png' }), 'test.png');
  const request = new Request(
    'https://sjn.test' +
      (options.projectId ? '/api/admin/project-assets?projectId=' + options.projectId : '/api/d1/assets'),
    { method: 'POST', body: form },
  );
  const response = options.projectId
    ? await adminProjectAssets({ env: bindings, actor }, request)
    : await handleD1Request('assets', request, env, actor);
  return { id, response };
}
function asset(actor: D1Actor, projectId: string, id: string, raw = false) {
  return adminProjectAssets(
    { env, actor },
    req(`/api/admin/project-assets?projectId=${projectId}&id=${id}${raw ? '&raw=1' : ''}`),
  );
}
function project(id: string): ProjectDocument {
  return normalizeProjectDocument({
    id: crypto.randomUUID(),
    ownerId: 'forged',
    name: '테스트 공간',
    schemaVersion: 2,
    storageRevision: 0,
    editRevision: 0,
    createdAt: now,
    updatedAt: now,
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    history: { past: [], future: [] },
    scene: {
      originalAssetId: id,
      previewAssetId: id,
      imageWidth: 8,
      imageHeight: 8,
      room: { ...DEFAULT_ROOM },
      surfaces: createRoomSurfaces(DEFAULT_ROOM),
      fixtures: [],
      protection: EMPTY_MASK(),
      color: { ...DEFAULT_COLOR },
    },
  });
}
async function setup() {
  const admin = await user(true),
    owner = await user();
  const source = await upload(owner);
  expect(source.response.status).toBe(200);
  const response = await regular(owner, 'projects', { operation: 'create', document: project(source.id) });
  expect(response.status, await response.clone().text()).toBe(200);
  return { admin, owner, source: source.id, document: (await response.json()) as ProjectDocument };
}
function material(assetId: string, scope: 'personal' | 'shared' = 'personal'): MaterialInput {
  return {
    name: '설비',
    brand: '',
    code: '',
    category: 'basin',
    scope,
    description: '',
    color: '',
    finish: '',
    widthMm: 600,
    heightMm: 800,
    depthMm: 400,
    usage: 'wall',
    installation: 'wall',
    textureAssetIds: [],
    views: [{ assetId, direction: '정면', anchor: { x: 0.5, y: 1 } }],
    defaultGroutWidth: 2,
    defaultGroutColor: '#ffffff',
    defaultPattern: 'grid',
  };
}
function fixture(versionId: string): FixtureInstance {
  return {
    id: crypto.randomUUID(),
    name: '세면대',
    materialVersionId: versionId,
    viewIndex: 0,
    position: { x: 0.5, y: 0.5 },
    width: 0.2,
    height: 0.3,
    rotation: 0,
    anchor: { x: 0.5, y: 1 },
    locked: false,
    shadow: { x: 0, y: 0, opacity: 0, blur: 0, scale: 1 },
    occlusion: EMPTY_MASK(),
    color: { ...DEFAULT_COLOR },
  };
}

describe('admin project edit scope on isolated D1/R2', () => {
  it('checks fresh role and preserves ordinary owner-only routes while listing and loading owner details', async () => {
    const { admin, owner, document } = await setup();
    expect((await call({ ...owner, isAdmin: true })).status).toBe(403);
    expect((await call({ id: '', isAdmin: true })).status).toBe(401);
    expect((await regular(admin, 'projects', { operation: 'load', id: document.id })).status).toBe(404);
    const listed = await (await call(admin, undefined, '?ownerId=' + owner.id)).json();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      id: document.id,
      ownerId: owner.id,
      ownerName: '일반 회원',
      storageRevision: 1,
    });
    expect(listed.items[0]).not.toHaveProperty('object_key');
    const loaded = await (await call(admin, { operation: 'load', id: document.id })).json();
    expect(loaded.document).toEqual(document);
    expect(loaded.owner.id).toBe(owner.id);
    for (const operation of ['remove', 'duplicate', 'create', 'transfer'])
      expect((await call(admin, { operation, id: document.id })).status).toBe(400);
    expect((await regular(owner, 'projects', { operation: 'load', id: document.id })).status).toBe(200);
  }, 30000);
  it('restricts assets to the selected project/source chain and creates new resources under the owner', async () => {
    const { admin, owner, source, document } = await setup();
    const unreferenced = await upload(owner),
      foreign = await upload(await user());
    expect((await asset(admin, document.id, source, true)).status).toBe(200);
    expect((await asset(admin, document.id, unreferenced.id)).status).toBe(404);
    expect((await asset(admin, document.id, foreign.id)).status).toBe(404);
    expect(
      (await upload(admin, { projectId: document.id, sourceAssetId: unreferenced.id })).response.status,
    ).toBe(404);
    const generated = await upload(admin, { projectId: document.id, sourceAssetId: source });
    expect(generated.response.status, await generated.response.clone().text()).toBe(200);
    const metadata = await (await asset(admin, document.id, generated.id)).json();
    expect(metadata.asset.ownerId).toBe(owner.id);
    expect(metadata.url).toBe(`/api/admin/project-assets?projectId=${document.id}&id=${generated.id}&raw=1`);
    const row = await env.DB.prepare('SELECT owner_id,object_key FROM d1_assets WHERE id=?')
      .bind(generated.id)
      .first<{ owner_id: string; object_key: string }>();
    expect(row?.owner_id).toBe(owner.id);
    expect(row?.object_key).toContain(`assets/${owner.id}/`);
    const second = (await (
      await regular(owner, 'projects', { operation: 'create', document: project(source) })
    ).json()) as ProjectDocument;
    expect((await asset(admin, second.id, generated.id)).status).toBe(404);
    const created = await resource(
      admin,
      document.id,
      { operation: 'create', input: material(generated.id) },
      'create-resource',
    );
    expect(created.status, await created.clone().text()).toBe(200);
    const version = (await created.json()) as MaterialVersion;
    expect(
      await env.DB.prepare('SELECT owner_id,purpose,scope FROM d1_materials WHERE id=?')
        .bind(version.materialId)
        .first(),
    ).toEqual({ owner_id: owner.id, purpose: 'project', scope: 'personal' });
    expect((await resource(admin, second.id, { operation: 'getVersion', id: version.id })).status).toBe(404);
    expect(
      (
        await resource(admin, document.id, {
          operation: 'update',
          id: version.materialId,
          input: material(generated.id),
        })
      ).status,
    ).toBe(400);
    const next = structuredClone(document);
    next.designs[0].scene.fixtures.push(fixture(version.id));
    const saved = await call(admin, {
      operation: 'save',
      id: document.id,
      document: next,
      expectedStorageRevision: 1,
    });
    expect(saved.status, await saved.clone().text()).toBe(200);
    const anotherAdmin = await user(true);
    expect(
      (await resource(anotherAdmin, document.id, { operation: 'getVersion', id: version.id })).status,
    ).toBe(200);
    expect((await asset(anotherAdmin, document.id, generated.id)).status).toBe(200);
  }, 30000);
  it('keeps owner, immutable snapshots, actor audit, retry identity and concurrent revision conflicts', async () => {
    const { admin, owner, document } = await setup();
    const original = await env.DB.prepare('SELECT object_key FROM d1_projects WHERE id=?')
      .bind(document.id)
      .first<{ object_key: string }>();
    const body = {
      operation: 'save',
      id: document.id,
      document: { ...document, ownerId: admin.id, name: '관리자 수정' },
      expectedStorageRevision: 1,
    };
    const result = await call(admin, body, '', 'retry-save');
    expect(result.status, await result.clone().text()).toBe(200);
    const saved = await result.json();
    expect(saved.ownerId).toBe(owner.id);
    expect(saved.storageRevision).toBe(2);
    expect(await (await call(admin, body, '', 'retry-save')).json()).toEqual(saved);
    expect(JSON.parse(await (await env.ASSET_BUCKET.get(original!.object_key))!.text())).toEqual(document);
    const audit = await env.DB.prepare(
      "SELECT actor_id,target_user_id,project_revision FROM d1_admin_audit WHERE project_id=? AND action='project.save'",
    )
      .bind(document.id)
      .all();
    expect(audit.results).toEqual([{ actor_id: admin.id, target_user_id: owner.id, project_revision: 2 }]);
    expect(
      await env.DB.prepare('SELECT owner_id FROM d1_mutations WHERE request_key=?')
        .bind('retry-save')
        .first(),
    ).toEqual({ owner_id: admin.id });
    const race = await Promise.all([
      regular(owner, 'projects', {
        operation: 'save',
        document: { ...saved, name: 'owner race' },
        expectedStorageRevision: 2,
      }),
      call(
        admin,
        { operation: 'save', document: { ...saved, name: 'admin race' }, expectedStorageRevision: 2 },
        '',
        'race-save',
      ),
    ]);
    expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
    const jobs = await env.DB.prepare('SELECT owner_id FROM d1_cleanup_jobs WHERE object_key=?')
      .bind(original!.object_key)
      .first();
    expect(jobs).toEqual({ owner_id: owner.id });
  }, 30000);
  it('rejects unrelated owner assets and material versions rather than using all owner resources', async () => {
    const { admin, owner, source, document } = await setup();
    const hidden = await upload(owner, { sourceAssetId: source });
    const made = await regular(owner, 'project-materials', {
      operation: 'create',
      input: material(hidden.id),
    });
    expect(made.status, await made.clone().text()).toBe(200);
    const version = (await made.json()) as MaterialVersion;
    expect((await resource(admin, document.id, { operation: 'getVersion', id: version.id })).status).toBe(
      404,
    );
    const next = structuredClone(document);
    next.designs[0].scene.fixtures.push(fixture(version.id));
    expect(
      (await call(admin, { operation: 'save', document: next, expectedStorageRevision: 1 })).status,
    ).toBe(400);
    expect(
      (
        await call(admin, {
          operation: 'save',
          document: { ...document, thumbnailAssetId: hidden.id },
          expectedStorageRevision: 1,
        })
      ).status,
    ).toBe(400);
    const visible = await (await resource(admin, document.id, { operation: 'list' })).json();
    expect(visible.some((row: { version: MaterialVersion }) => row.version.id === version.id)).toBe(false);
    const uploadPublic = await upload(admin);
    const publicResponse = await regular(admin, 'materials', {
      operation: 'create',
      input: material(uploadPublic.id, 'shared'),
    });
    expect(publicResponse.status, await publicResponse.clone().text()).toBe(200);
    const publicVersion = (await publicResponse.json()) as MaterialVersion;
    expect(
      (await resource(admin, document.id, { operation: 'getVersion', id: publicVersion.id })).status,
    ).toBe(200);
    expect((await asset(admin, document.id, uploadPublic.id)).status).toBe(200);
  }, 30000);
  it('aborts a commit after mid-upload role revocation and does not replay after permission loss', async () => {
    const { admin, owner, document } = await setup();
    let intercepted = false;
    const bindings: D1Bindings = {
      ...env,
      ASSET_BUCKET: {
        head: (key) => env.ASSET_BUCKET.head(key),
        get: (key) => env.ASSET_BUCKET.get(key),
        delete: (key) => env.ASSET_BUCKET.delete(key),
        put: async (key, value, options) => {
          const result = await env.ASSET_BUCKET.put(key, value, options);
          intercepted = true;
          await env.DB.prepare('DELETE FROM admin_roles WHERE user_id=?').bind(admin.id).run();
          return result;
        },
      },
    };
    const response = await call(
      admin,
      { operation: 'save', document: { ...document, name: 'must reject' }, expectedStorageRevision: 1 },
      '',
      'revocation',
      bindings,
    );
    expect(intercepted).toBe(true);
    expect(response.status, await response.clone().text()).toBe(403);
    expect(
      await env.DB.prepare('SELECT owner_id,storage_revision,name FROM d1_projects WHERE id=?')
        .bind(document.id)
        .first(),
    ).toEqual({ owner_id: owner.id, storage_revision: 1, name: document.name });
    expect((await call(admin, { operation: 'load', id: document.id })).status).toBe(403);
    expect(
      (
        await env.DB.prepare("SELECT id FROM d1_admin_audit WHERE project_id=? AND action='project.save'")
          .bind(document.id)
          .all()
      ).results,
    ).toEqual([]);
    expect(
      (await env.DB.prepare('SELECT owner_id FROM d1_cleanup_jobs WHERE owner_id=?').bind(owner.id).all())
        .results.length,
    ).toBeGreaterThan(0);
  }, 30000);
  it('denies committed replay, assets and materials after demotion or account suspension', async () => {
    const { admin, source, document } = await setup();
    const body = {
      operation: 'save',
      document: { ...document, name: 'committed before demotion' },
      expectedStorageRevision: 1,
    };
    expect((await call(admin, body, '', 'committed-replay')).status).toBe(200);
    await env.DB.prepare('DELETE FROM admin_roles WHERE user_id=?').bind(admin.id).run();
    expect((await call(admin, body, '', 'committed-replay')).status).toBe(403);
    expect((await asset(admin, document.id, source, true)).status).toBe(403);
    expect((await resource(admin, document.id, { operation: 'list' })).status).toBe(403);
    await env.DB.prepare('INSERT INTO admin_roles(user_id) VALUES(?)').bind(admin.id).run();
    await env.DB.prepare("UPDATE d1_user_management SET status='suspended' WHERE user_id=?")
      .bind(admin.id)
      .run();
    expect((await call(admin, { operation: 'load', id: document.id })).status).toBe(403);
    expect((await call(admin, body, '', 'committed-replay')).status).toBe(403);
    expect((await call(admin)).status).toBe(403);
    expect(
      await env.DB.prepare('SELECT storage_revision FROM d1_projects WHERE id=?').bind(document.id).first(),
    ).toEqual({ storage_revision: 2 });
  }, 30000);
  it('rechecks administrator authority in ordinary catalog and material mutation commits', async () => {
    const admin = await user(true),
      uploaded = await upload(admin);
    const input = material(uploaded.id, 'shared');
    const version = (await (
      await regular(admin, 'materials', { operation: 'create', input })
    ).json()) as MaterialVersion;
    const categoryInput = { kind: 'color', name: '동시 권한 테스트', sortOrder: 90000, active: true };
    const catalog = (await (
      await regular(admin, 'catalog', { operation: 'create', input: categoryInput })
    ).json()) as { id: string };
    const attempts: { resource: D1Resource; body: Record<string, unknown> }[] = [
      { resource: 'materials', body: { operation: 'create', input } },
      {
        resource: 'materials',
        body: {
          operation: 'update',
          id: version.materialId,
          expectedVersionId: version.id,
          input: { ...input, name: '차단할 변경' },
        },
      },
      { resource: 'materials', body: { operation: 'setActive', id: version.materialId, active: false } },
      {
        resource: 'catalog',
        body: { operation: 'create', input: { ...categoryInput, name: '차단할 신규 분류' } },
      },
      {
        resource: 'catalog',
        body: { operation: 'update', input: { ...categoryInput, id: catalog.id, active: false } },
      },
    ];
    for (const { resource, body } of attempts) {
      await env.DB.prepare('INSERT OR IGNORE INTO admin_roles(user_id) VALUES(?)').bind(admin.id).run();
      let intercepted = false;
      const bindings: D1Bindings = {
        ...env,
        DB: {
          prepare: (query) => env.DB.prepare(query),
          batch: async (statements) => {
            intercepted = true;
            await env.DB.prepare('DELETE FROM admin_roles WHERE user_id=?').bind(admin.id).run();
            return env.DB.batch(statements);
          },
        },
      };
      const result = await handleD1Request(
        resource,
        req('/api/d1/' + resource, body, crypto.randomUUID()),
        bindings,
        admin,
      );
      expect(intercepted).toBe(true);
      expect(result.status, await result.clone().text()).toBe(403);
    }
    expect(
      await env.DB.prepare('SELECT current_version_id,active FROM d1_materials WHERE id=?')
        .bind(version.materialId)
        .first(),
    ).toEqual({ current_version_id: version.id, active: 1 });
    expect(
      (
        await env.DB.prepare('SELECT id FROM d1_material_versions WHERE material_id=?')
          .bind(version.materialId)
          .all()
      ).results,
    ).toHaveLength(1);
    expect(
      await env.DB.prepare('SELECT active FROM d1_catalog_options WHERE id=?').bind(catalog.id).first(),
    ).toEqual({ active: 1 });
    expect(
      await env.DB.prepare('SELECT id FROM d1_catalog_options WHERE name=?').bind('차단할 신규 분류').first(),
    ).toBeNull();
    expect((await env.DB.prepare('SELECT id FROM d1_checks').all()).results).toHaveLength(0);
    expect((await env.DB.prepare('SELECT id FROM d1_admin_checks').all()).results).toHaveLength(0);
  }, 30000);
  it('supports stable cursors and literal search terms without exposing snapshot keys', async () => {
    const { admin, owner, document } = await setup();
    const row = await env.DB.prepare('SELECT * FROM d1_projects WHERE id=?')
      .bind(document.id)
      .first<Record<string, unknown>>();
    for (let index = 0; index < 32; index++)
      await env.DB.prepare(
        'INSERT INTO d1_projects(id,owner_id,name,storage_revision,object_key,byte_size,summary_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      )
        .bind(
          crypto.randomUUID(),
          owner.id,
          index === 0 ? 'literal%space' : `page ${index}`,
          1,
          `test-pagination/${crypto.randomUUID()}`,
          1,
          row!.summary_json,
          now,
          now,
        )
        .run();
    const first = await (await call(admin, undefined, '?ownerId=' + owner.id)).json();
    expect(first.items).toHaveLength(25);
    expect(first.nextCursor).toBeTruthy();
    const second = await (
      await call(admin, undefined, '?ownerId=' + owner.id + '&cursor=' + encodeURIComponent(first.nextCursor))
    ).json();
    expect(second.items).toHaveLength(8);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item: { id: string }) => item.id)).size).toBe(33);
    const search = await (await call(admin, undefined, '?ownerId=' + owner.id + '&q=%25')).json();
    expect(search.items).toHaveLength(1);
    expect(search.items[0].name).toBe('literal%space');
    const emailSearch = await call(admin, undefined, '?q=' + encodeURIComponent(owner.id + '@example.test'));
    expect(emailSearch.status, await emailSearch.clone().text()).toBe(200);
    expect((await emailSearch.json()).items).toHaveLength(25);
    const longLiteral = '한'.repeat(200);
    expect((await call(admin, undefined, '?q=' + encodeURIComponent(longLiteral))).status).toBe(200);
    expect((await call(admin, undefined, '?q=' + encodeURIComponent(longLiteral + '글'))).status).toBe(400);
    expect((await (await call(admin, undefined, '?q=_')).json()).items).toEqual([]);
    expect((await call(admin, undefined, '?cursor=invalid')).status).toBe(400);
  }, 30000);
});

it('rejects duplicate asset retries if the administrator is revoked after reading the existing record', async () => {
  const { admin, source, document } = await setup();
  let revoked = false;
  function intercept(statement: D1Statement): D1Statement {
    return new Proxy(statement, {
      get(target, key) {
        if (key === 'bind') return (...values: unknown[]) => intercept(target.bind(...values));
        if (key === 'first')
          return async () => {
            const row = await target.first();
            await env.DB.prepare('DELETE FROM admin_roles WHERE user_id=?').bind(admin.id).run();
            revoked = true;
            return row;
          };
        return Reflect.get(target, key);
      },
    });
  }
  const bindings: D1Bindings = {
    ...env,
    DB: {
      prepare(query) {
        const statement = env.DB.prepare(query);
        return query === 'SELECT * FROM d1_assets WHERE id=?' ? intercept(statement) : statement;
      },
      batch: (statements) => env.DB.batch(statements),
    },
  };
  const result = await upload(admin, { projectId: document.id, id: source }, bindings);
  expect(revoked).toBe(true);
  expect(result.response.status).toBe(403);
  expect(
    (
      await env.DB.prepare('SELECT storage_revision FROM d1_projects WHERE id=?')
        .bind(document.id)
        .first<{ storage_revision: number }>()
    )?.storage_revision,
  ).toBe(1);
});
