import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { applyD1Migrations, allD1Migrations } from './helpers/d1-migrations';
import { build } from 'esbuild';
import sharp from 'sharp';
import { checkD1Storage, handleD1Request, runD1Maintenance } from '../src/lib/d1';
import type { D1Bindings, D1DatabaseLike, D1Statement } from '../src/lib/d1/types';
import { normalizeProjectDocument } from '../src/lib/comparison';
import { DEFAULT_ROOM, createRoomSurfaces } from '../src/lib/room-geometry';
import {
  DEFAULT_COLOR,
  EMPTY_MASK,
  type MaterialInput,
  type ProjectDocument,
  type MaterialVersion,
} from '../src/lib/types';
import { encodeProductMesh, PRODUCT_MESH_MIME } from '../src/lib/product3d/codec';

let worker: Miniflare;
let env: D1Bindings;
let png: Uint8Array<ArrayBuffer>;
const old = '2000-01-01T00:00:00.000Z';
function project(assetId: string): ProjectDocument {
  return normalizeProjectDocument({
    id: crypto.randomUUID(),
    ownerId: 'forged-owner',
    name: 'D1 테스트',
    schemaVersion: 2,
    storageRevision: 0,
    editRevision: 0,
    createdAt: old,
    updatedAt: old,
    viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    history: { past: [], future: [] },
    scene: {
      originalAssetId: assetId,
      previewAssetId: assetId,
      imageWidth: 10,
      imageHeight: 10,
      room: { ...DEFAULT_ROOM },
      surfaces: createRoomSurfaces(DEFAULT_ROOM),
      fixtures: [],
      protection: EMPTY_MASK(),
      color: { ...DEFAULT_COLOR },
    },
  });
}
function material(assetId: string, scope: 'shared' | 'personal' = 'personal'): MaterialInput {
  return {
    name: '테스트 세면대',
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
    coverAssetId: assetId,
    imageAssetIds: [assetId],
    textureAssetIds: [],
    views: [{ assetId, direction: '정면', anchor: { x: 0.5, y: 1 } }],
    defaultGroutWidth: 2,
    defaultGroutColor: '#ffffff',
    defaultPattern: 'grid',
  };
}
async function call(
  resource: string,
  body: unknown,
  user: string,
  key?: string,
  admin = false,
): Promise<Response> {
  return worker.dispatchFetch(`http://sjn.test/api/d1/${resource}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-test-user': user,
      'x-test-admin': admin ? '1' : '0',
      ...(key ? { 'X-Idempotency-Key': key } : {}),
    },
    body: JSON.stringify(body),
  }) as unknown as Promise<Response>;
}
async function upload(
  user: string,
  options: {
    id?: string;
    sourceAssetId?: string;
    kind?: string;
    bytes?: Uint8Array<ArrayBuffer>;
    mime?: string;
  } = {},
) {
  const id = options.id ?? crypto.randomUUID(),
    form = new FormData();
  form.set(
    'metadata',
    JSON.stringify({
      id,
      name: 'test.png',
      kind: options.kind ?? 'original',
      sourceAssetId: options.sourceAssetId,
      ownerId: 'forged-owner',
      mime: 'text/html',
      width: 999,
      height: 999,
    }),
  );
  form.set('file', new Blob([options.bytes ?? png], { type: options.mime ?? 'image/png' }), 'test.png');
  const request = new Request('http://sjn.test/api/d1/assets', {
    method: 'POST',
    headers: { 'x-test-user': user },
    body: form,
  });
  const response = await worker.dispatchFetch(request.url, {
    method: 'POST',
    headers: Object.fromEntries(request.headers),
    body: await request.arrayBuffer(),
  });
  return { id, response };
}
async function assetGet(user: string, id: string, raw = false) {
  return worker.dispatchFetch(`http://sjn.test/api/d1/assets?id=${id}${raw ? '&raw=1' : ''}`, {
    headers: { 'x-test-user': user },
  });
}
beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `import {handleD1Request} from './src/lib/d1/index.ts';
    export default {fetch(request,env) {return handleD1Request(new URL(request.url).pathname.split('/').at(-1),request,env,
      {id:request.headers.get('x-test-user')||'',isAdmin:request.headers.get('x-test-admin')==='1'});}};`,
      resolveDir: process.cwd(),
      sourcefile: 'd1-test-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
  });
  worker = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0].text,
      compatibilityDate: '2026-09-07',
      d1Databases: { DB: 'sjn-storage-test' },
      r2Buckets: ['ASSET_BUCKET'],
    }),
  );
  const db = await worker.getD1Database('DB');
  await applyD1Migrations(db as unknown as D1DatabaseLike, allD1Migrations);
  env = { DB: db, ASSET_BUCKET: await worker.getR2Bucket('ASSET_BUCKET') } as unknown as D1Bindings;
  png = new Uint8Array(
    await sharp({ create: { width: 10, height: 10, channels: 3, background: '#eeccaa' } })
      .png()
      .toBuffer(),
  );
}, 30000);
afterAll(async () => {
  await worker?.dispose();
});

describe('D1/R2 storage in a real local Worker', () => {
  it('checks schema and empty R2 readiness without creating objects', async () => {
    await expect(checkD1Storage(env)).resolves.toBeUndefined();
    expect(await env.ASSET_BUCKET.head('__sjn_readiness__')).toBeNull();
    await env.DB.prepare('ALTER TABLE d1_maintenance RENAME COLUMN next_run_at TO broken_column').run();
    try {
      await expect(checkD1Storage(env)).rejects.toThrow();
    } finally {
      await env.DB.prepare('ALTER TABLE d1_maintenance RENAME COLUMN broken_column TO next_run_at').run();
    }
    const broken = {
      ...env,
      ASSET_BUCKET: {
        ...env.ASSET_BUCKET,
        head: async () => {
          throw new Error('R2 disconnected');
        },
      },
    } as D1Bindings;
    await expect(checkD1Storage(broken)).rejects.toThrow('R2 disconnected');
  });
  it('derives asset metadata, restricts private bytes, and makes identical upload retries idempotent', async () => {
    const user = crypto.randomUUID(),
      other = crypto.randomUUID();
    const { id, response } = await upload(user);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get('X-SJN-Mutation')).toBe('1');
    expect((await upload(user, { id })).response.status).toBe(200);
    const result = (await (await assetGet(user, id)).json()) as {
      asset: { ownerId: string; mime: string; width: number };
      url: string;
    };
    expect(result.asset).toMatchObject({ ownerId: user, mime: 'image/png', width: 10 });
    expect(result.url).toBe(`/api/d1/assets?id=${id}&raw=1`);
    expect((await assetGet(other, id)).status).toBe(404);
    expect((await assetGet(other, id, true)).status).toBe(404);
    expect((await assetGet('', id)).status).toBe(401);
    const raw = await assetGet(user, id, true);
    expect(raw.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(png);
    expect(
      (await upload(user, { bytes: new TextEncoder().encode('<html>bad</html>') })).response.status,
    ).toBe(400);
    expect((await upload(user, { bytes: png.slice(0, -12) })).response.status).toBe(400);
  });
  it('isolates projects and rejects cross-user references before uploading a snapshot', async () => {
    const user = crypto.randomUUID(),
      other = crypto.randomUUID(),
      { id } = await upload(user);
    const document = project(id);
    const created = await call('projects', { operation: 'create', document }, user);
    expect(created.status, await created.clone().text()).toBe(200);
    expect((await created.json()).ownerId).toBe(user);
    expect((await call('projects', { operation: 'load', id: document.id }, other)).status).toBe(404);
    expect(await (await call('projects', { operation: 'list' }, other)).json()).toEqual([]);
    const unauthorized = await call('projects', { operation: 'create', document: project(id) }, other);
    expect(unauthorized.status, await unauthorized.clone().text()).toBe(400);
    expect((await upload(other, { sourceAssetId: id })).response.status).toBe(404);
  });
  it('stores a project over 2MB in R2 while its D1 row stays small', async () => {
    const user = crypto.randomUUID(),
      { id } = await upload(user),
      document = project(id);
    const frame = { scene: structuredClone(document.shared.baseline) };
    frame.scene.protection.strokes = [
      {
        points: Array.from({ length: 4000 }, (_, index) => ({ x: index / 4000, y: 0.25 })),
        radius: 0.1,
        erase: false,
      },
    ];
    document.designs[0].history.past = Array.from({ length: 30 }, () => structuredClone(frame));
    expect(new TextEncoder().encode(JSON.stringify(document)).length).toBeGreaterThan(2 * 1024 * 1024);
    const response = await call('projects', { operation: 'create', document }, user);
    expect(response.status, await response.clone().text()).toBe(200);
    const stored = await env.DB.prepare(
      'SELECT object_key,byte_size,length(summary_json) AS summary_size FROM d1_projects WHERE id=?',
    )
      .bind(document.id)
      .first<{ object_key: string; byte_size: number; summary_size: number }>();
    expect(stored!.byte_size).toBeGreaterThan(2 * 1024 * 1024);
    expect(stored!.summary_size).toBeLessThan(2000);
    expect((await env.ASSET_BUCKET.head(stored!.object_key))?.size).toBe(stored!.byte_size);
    const loaded = await (await call('projects', { operation: 'load', id: document.id }, user)).json();
    expect(loaded.designs[0].history.past).toEqual(document.designs[0].history.past);
  }, 30000);
  it('commits one racing revision, replays its exact result, and preserves the loser as an orphan job', async () => {
    const user = crypto.randomUUID(),
      { id } = await upload(user);
    const original = (await (
      await call('projects', { operation: 'create', document: project(id) }, user)
    ).json()) as ProjectDocument;
    const bodies = ['A', 'B'].map((name) => ({
      operation: 'save',
      document: { ...original, name },
      expectedStorageRevision: 1,
    }));
    const results = await Promise.all(
      bodies.map((body, index) => call('projects', body, user, `race-${index}`)),
    );
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const winner = results.findIndex((result) => result.status === 200),
      saved = await results[winner].json();
    expect(saved.storageRevision).toBe(2);
    expect(await (await call('projects', bodies[winner], user, `race-${winner}`)).json()).toEqual(saved);
    expect(
      (
        await call(
          'projects',
          { ...bodies[winner], document: { ...original, name: 'different' } },
          user,
          `race-${winner}`,
        )
      ).status,
    ).toBe(409);
    const jobs = await env.DB.prepare('SELECT object_key FROM d1_cleanup_jobs WHERE owner_id=?')
      .bind(user)
      .all();
    expect(jobs.results.length).toBeGreaterThanOrEqual(1);
  });
  it('protects shared material writes while allowing authenticated reads and immutable versions', async () => {
    const admin = crypto.randomUUID(),
      user = crypto.randomUUID(),
      { id } = await upload(admin);
    const denied = await call(
      'materials',
      { operation: 'create', input: material(id, 'shared') },
      admin,
      'not-admin',
    );
    expect(denied.status).toBe(403);
    const created = await call(
      'materials',
      { operation: 'create', input: material(id, 'shared') },
      admin,
      'admin-create',
      true,
    );
    expect(created.status, await created.clone().text()).toBe(200);
    const first = (await created.json()) as MaterialVersion;
    expect((await assetGet(user, id)).status).toBe(200);
    expect(
      (
        await call(
          'materials',
          { operation: 'update', id: first.materialId, input: material(id), expectedVersionId: first.id },
          user,
        )
      ).status,
    ).toBe(403);
    const second = (await (
      await call(
        'materials',
        {
          operation: 'update',
          id: first.materialId,
          input: { ...material(id), name: '변경' },
          expectedVersionId: first.id,
        },
        admin,
        'admin-update',
        true,
      )
    ).json()) as MaterialVersion;
    expect(second.version).toBe(2);
    expect(second.scope).toBe('shared');
    for (const active of [true, false, true]) {
      const changed = await call(
        'materials',
        { operation: 'setActive', id: first.materialId, active },
        admin,
        undefined,
        true,
      );
      expect(changed.status).toBe(200);
      expect(changed.headers.get('X-SJN-Mutation')).toBe('1');
    }
    const storedMaterial = await env.DB.prepare('SELECT active FROM d1_materials WHERE id=?')
      .bind(first.materialId)
      .first<{ active: number }>();
    expect(storedMaterial!.active).toBe(1);
    expect(
      (await (await call('materials', { operation: 'getVersion', id: first.id }, user)).json()).name,
    ).toBe(first.name);
    const list = await (await call('materials', { operation: 'list' }, user)).json();
    expect(list.some((row: { version: MaterialVersion }) => row.version.id === second.id)).toBe(true);
  });
  it('validates mesh bytes and the ownership of its source image', async () => {
    const user = crypto.randomUUID(),
      { id } = await upload(user);
    const mesh = encodeProductMesh({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      colors: new Float32Array(9).fill(1),
      indices: new Uint32Array([0, 1, 2]),
    });
    const bytes = new Uint8Array(await mesh.arrayBuffer());
    expect(
      (await upload(user, { bytes, mime: PRODUCT_MESH_MIME, kind: 'product-mesh', sourceAssetId: id }))
        .response.status,
    ).toBe(200);
    const corrupt = bytes.slice();
    new DataView(corrupt.buffer).setUint32(corrupt.length - 4, 999, true);
    expect(
      (
        await upload(user, {
          bytes: corrupt,
          mime: PRODUCT_MESH_MIME,
          kind: 'product-mesh',
          sourceAssetId: id,
        })
      ).response.status,
    ).toBe(400);
    expect(
      (
        await upload(crypto.randomUUID(), {
          bytes,
          mime: PRODUCT_MESH_MIME,
          kind: 'product-mesh',
          sourceAssetId: id,
        })
      ).response.status,
    ).toBe(404);
  });
  it('rolls back a failed snapshot commit and later removes its R2 orphan without touching the source', async () => {
    const user = crypto.randomUUID(),
      { id } = await upload(user),
      document = project(id);
    document.name = 'forced-commit-failure';
    await env.DB.prepare(
      "CREATE TRIGGER fail_d1_test_commit BEFORE INSERT ON d1_projects WHEN NEW.name='forced-commit-failure' BEGIN SELECT RAISE(ABORT,'test commit failure'); END",
    ).run();
    try {
      expect((await call('projects', { operation: 'create', document }, user)).status).toBe(503);
      expect(
        await env.DB.prepare('SELECT id FROM d1_projects WHERE id=?').bind(document.id).first(),
      ).toBeNull();
      const job = await env.DB.prepare('SELECT object_key FROM d1_cleanup_jobs WHERE owner_id=?')
        .bind(user)
        .first<{ object_key: string }>();
      expect(job).not.toBeNull();
      expect(await env.ASSET_BUCKET.head(job!.object_key)).not.toBeNull();
      expect(await (await call('cleanup', { operation: 'run' }, user)).json()).toBe(0);
      await env.DB.prepare('UPDATE d1_cleanup_jobs SET eligible_at=?,next_attempt_at=? WHERE owner_id=?')
        .bind(old, old, user)
        .run();
      await runD1Maintenance(env, { id: user, isAdmin: false });
      expect(await env.ASSET_BUCKET.head(job!.object_key)).toBeNull();
      expect((await assetGet(user, id)).status).toBe(200);
      const lease = await env.DB.prepare('SELECT next_run_at FROM d1_maintenance WHERE owner_id=?')
        .bind(user)
        .first();
      await runD1Maintenance(env, { id: user, isAdmin: false });
      expect(
        await env.DB.prepare('SELECT next_run_at FROM d1_maintenance WHERE owner_id=?').bind(user).first(),
      ).toEqual(lease);
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_d1_test_commit').run();
    }
  });
  it('keeps a normal save plus three orphan deletions within the free D1 request query budget', async () => {
    const user = crypto.randomUUID(),
      { id } = await upload(user);
    const document = (await (
      await call('projects', { operation: 'create', document: project(id) }, user)
    ).json()) as ProjectDocument;
    for (let index = 0; index < 3; index++) {
      const key = `budget-orphan/${user}/${index}`;
      await env.ASSET_BUCKET.put(key, 'orphan');
      await env.DB.prepare(
        'INSERT INTO d1_cleanup_jobs(object_key,owner_id,eligible_at,next_attempt_at) VALUES(?,?,?,?)',
      )
        .bind(key, user, old, old)
        .run();
    }
    let statements = 0;
    const native = new WeakMap<D1Statement, D1Statement>();
    function wrap(statement: D1Statement): D1Statement {
      const counted: D1Statement = {
        bind: (...values) => wrap(statement.bind(...values)),
        first<T = Record<string, unknown>>(column?: string) {
          statements++;
          return statement.first<T>(column);
        },
        all<T = Record<string, unknown>>() {
          statements++;
          return statement.all<T>();
        },
        run<T = Record<string, unknown>>() {
          statements++;
          return statement.run<T>();
        },
      };
      native.set(counted, statement);
      return counted;
    }
    const DB: D1DatabaseLike = {
      prepare: (query) => wrap(env.DB.prepare(query)),
      batch<T = Record<string, unknown>>(values: D1Statement[]) {
        statements += values.length;
        return env.DB.batch<T>(values.map((value) => native.get(value)!));
      },
    };
    const countedEnv = { ...env, DB };
    const response = await handleD1Request(
      'projects',
      new Request('https://sjn.test/api/d1/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operation: 'save',
          document: { ...document, name: 'query budget' },
          expectedStorageRevision: 1,
        }),
      }),
      countedEnv,
      { id: user, isAdmin: false },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    await runD1Maintenance(countedEnv, { id: user, isAdmin: false });
    // Leave ten queries for session, role and rate-limit checks in the outer wrapper.
    expect(statements).toBeLessThanOrEqual(40);
    for (let index = 0; index < 3; index++)
      expect(await env.ASSET_BUCKET.head(`budget-orphan/${user}/${index}`)).toBeNull();
  });
  it('returns the same committed project for simultaneous retries of one create', async () => {
    const user = crypto.randomUUID(),
      { id } = await upload(user),
      body = { operation: 'create', document: project(id) };
    const responses = await Promise.all([
      call('projects', body, user, 'same-request'),
      call('projects', body, user, 'same-request'),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await responses[0].json()).toEqual(await responses[1].json());
    const row = await env.DB.prepare('SELECT count(*) AS count FROM d1_projects WHERE owner_id=?')
      .bind(user)
      .first<{ count: number }>();
    expect(row!.count).toBe(1);
  });
  it('retries cleanup after R2 deletion succeeds but D1 finalization fails', async () => {
    const user = crypto.randomUUID(),
      { id } = await upload(user);
    await env.DB.prepare('UPDATE d1_assets SET created_at=? WHERE id=?').bind(old, id).run();
    await env.DB.prepare(
      `CREATE TRIGGER fail_d1_test_cleanup BEFORE DELETE ON d1_cleanup_jobs WHEN OLD.owner_id='${user}' BEGIN SELECT RAISE(ABORT,'test cleanup failure'); END`,
    ).run();
    try {
      expect(await (await call('cleanup', { operation: 'run' }, user)).json()).toBe(0);
      const job = await env.DB.prepare('SELECT object_key,attempts FROM d1_cleanup_jobs WHERE owner_id=?')
        .bind(user)
        .first<{ object_key: string; attempts: number }>();
      expect(job!.attempts).toBe(1);
      expect(await env.ASSET_BUCKET.head(job!.object_key)).toBeNull();
      expect((await assetGet(user, id)).status).toBe(404);
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_d1_test_cleanup').run();
    }
    await env.DB.prepare('UPDATE d1_cleanup_jobs SET next_attempt_at=? WHERE owner_id=?')
      .bind(old, user)
      .run();
    expect(await (await call('cleanup', { operation: 'run' }, user)).json()).toBe(1);
    expect(await env.DB.prepare('SELECT id FROM d1_assets WHERE id=?').bind(id).first()).toBeNull();
  });
  it('sweeps only aged unreferenced owner assets and retains source chains and active references', async () => {
    const user = crypto.randomUUID(),
      other = crypto.randomUUID();
    const orphan = await upload(user),
      source = await upload(user),
      derived = await upload(user, { sourceAssetId: source.id }),
      foreign = await upload(other);
    const doc = project(derived.id);
    expect((await call('projects', { operation: 'create', document: doc }, user)).status).toBe(200);
    await env.DB.prepare('UPDATE d1_assets SET created_at=?').bind(old).run();
    const result = await call('cleanup', { operation: 'run' }, user);
    expect(result.status, await result.clone().text()).toBe(200);
    expect(await result.json()).toBe(1);
    expect((await assetGet(user, orphan.id)).status).toBe(404);
    expect((await assetGet(user, source.id)).status).toBe(200);
    expect((await assetGet(user, derived.id)).status).toBe(200);
    expect((await assetGet(other, foreign.id)).status).toBe(200);
  });
});
