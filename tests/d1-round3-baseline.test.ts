/**
 * Round 3 of the D1 work (docs/prompts/d1-efficiency-round3.md, stage 0): what one request costs in D1,
 * the route's own sign-in and role check included, before anything changes. Real Miniflare D1/R2 and
 * real Better Auth sessions; every statement goes through meterD1 (tests/helpers/d1-meter.ts). A
 * measurement, not a check: it runs with SJN_D1_COST=1 and writes test-results/d1-round3/cost.json.
 * The catalogue is the e2e seed (130 shared materials, one image each) at N and 5N.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import sharp from 'sharp';
import { allD1Migrations, applyD1Migrations } from './helpers/d1-migrations';
import { meterD1, type D1QueryRecord } from './helpers/d1-meter';
import { seed } from '../e2e/helpers/material-seed';
import type { AuthenticatedApp } from '../e2e/helpers/authenticated-app';
import type { D1DatabaseLike } from '../src/lib/d1/types';
import { normalizeProjectDocument } from '../src/lib/comparison';
import { DEFAULT_ROOM, createRoomSurfaces } from '../src/lib/room-geometry';
import { DEFAULT_COLOR, EMPTY_MASK, type ProjectDocument } from '../src/lib/types';

const runtime = vi.hoisted(() => ({ value: { platform: 'node' } as Record<string, unknown> }));
vi.mock('@/lib/platform/runtime', () => ({
  getRuntimeEnvironment: () => runtime.value,
  continueInBackground: () => {},
}));
import { GET as statusRoute } from '@/app/api/storage/status/route';
import { GET as authGet, POST as authPost } from '@/app/api/auth/[...all]/route';
import { GET as roleRoute } from '@/app/api/d1/role/route';
import { GET as assetsGet, POST as assetsPost } from '@/app/api/d1/assets/route';
import { POST as cleanupRoute } from '@/app/api/d1/cleanup/route';
import { POST as projectsRoute } from '@/app/api/d1/projects/route';
import { GET as catalogImage } from '@/app/api/catalog/images/route';
import { GET as catalogPlacement } from '@/app/api/catalog/placement/route';
import { GET as catalogMaterials } from '@/app/api/catalog/materials/route';
import { GET as adminProjectAsset } from '@/app/api/admin/project-assets/route';

const origin = 'https://round3.test';
const OUT = 'test-results/d1-round3';
let mf: Miniflare;
let db: D1DatabaseLike;
let ready: Record<string, unknown>;
let png: Buffer;
const cookies: Record<'member' | 'admin', string> = { member: '', admin: '' };
const ids: Record<'member' | 'admin', string> = { member: '', admin: '' };
let ip = 1;

const request = (path: string, who?: 'member' | 'admin', init: RequestInit = {}) =>
  new Request(origin + path, {
    ...init,
    headers: {
      origin,
      'cf-connecting-ip': `203.0.113.${ip++ % 250}`,
      ...(who ? { cookie: cookies[who], 'X-SJN-User-Id': ids[who] } : {}),
      ...(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
const post = (path: string, who: 'member' | 'admin', body: unknown) =>
  request(path, who, { method: 'POST', body: JSON.stringify(body) });

type Cost = {
  status: number;
  queries: number;
  rowsRead: number;
  rowsWritten: number;
  records: D1QueryRecord[];
};
/** One request through its real route on a metered D1. */
async function metered(run: () => Promise<Response>): Promise<Cost> {
  const meter = meterD1(db);
  runtime.value = { ...ready, DB: meter.db };
  try {
    const response = await run();
    const body = await response.arrayBuffer();
    if (!response.ok) console.log('not ok', response.status, new TextDecoder().decode(body).slice(0, 300));
    return { status: response.status, ...meter.summary(), records: [...meter.records] };
  } finally {
    runtime.value = ready;
  }
}
const results: Record<string, unknown> = {};
function keep(name: string, cost: Cost) {
  results[name] = {
    status: cost.status,
    queries: cost.queries,
    rowsRead: cost.rowsRead,
    rowsWritten: cost.rowsWritten,
    statements: cost.records.map((r) => ({
      sql: r.sql.slice(0, 160),
      read: r.rowsRead ?? 0,
      written: r.rowsWritten ?? 0,
    })),
  };
  console.log(
    `${name}: status ${cost.status}, queries ${cost.queries}, read ${cost.rowsRead}, written ${cost.rowsWritten}`,
  );
}
async function signUp(who: 'member' | 'admin') {
  const response = await authPost(
    request('/api/auth/sign-up/email', undefined, {
      method: 'POST',
      body: JSON.stringify({ username: `round3${who}`, password: `round3-${who}-password` }),
    }),
  );
  expect(response.status, await response.clone().text()).toBe(200);
  cookies[who] = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const row = await db
    .prepare('SELECT id FROM "user" WHERE username=?')
    .bind(`round3${who}`)
    .first<{ id: string }>();
  ids[who] = row!.id;
}
/** The e2e catalogue (130 shared materials, one image each, owned by the administrator), `times` over. */
async function catalogue(times: number) {
  const fake = {
    actor: { id: ids.admin, isAdmin: true },
    env: { DB: db, ASSET_BUCKET: await mf.getR2Bucket('ASSET_BUCKET') },
  } as unknown as AuthenticatedApp;
  for (let i = 0; i < times; i++) await seed(fake);
}
async function anyCatalogueAsset() {
  const row = await db
    .prepare(
      "SELECT r.asset_id AS id FROM d1_material_assets r JOIN d1_materials m ON m.current_version_id=r.version_id WHERE m.scope='shared' LIMIT 1",
    )
    .first<{ id: string }>();
  return row!.id;
}

describe.skipIf(!process.env.SJN_D1_COST)('D1 3차 0단계: 요청 1회 비용', () => {
  beforeAll(async () => {
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default { fetch() { return new Response("round3") } }',
        compatibilityDate: '2026-09-07',
        d1Databases: { DB: 'round3-cost' },
        r2Buckets: { ASSET_BUCKET: 'round3-assets' },
      }),
    );
    db = (await mf.getD1Database('DB')) as unknown as D1DatabaseLike;
    await applyD1Migrations(db, allD1Migrations);
    ready = {
      platform: 'cloudflare',
      APP_ENV: 'production',
      STORAGE_MODE: 'auto',
      DB: db,
      ASSET_BUCKET: await mf.getR2Bucket('ASSET_BUCKET'),
      BETTER_AUTH_URL: origin,
      BETTER_AUTH_SECRET: 'test-only-secret-round3-4c1f7d2e9b8a4f6c8d3e',
    };
    runtime.value = ready;
    png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#cccccc' } })
      .png()
      .toBuffer();
    await signUp('member');
    await signUp('admin');
    await db.prepare('INSERT INTO admin_roles(user_id) VALUES(?)').bind(ids.admin).run();
    mkdirSync(OUT, { recursive: true });
  }, 300000);
  afterAll(async () => {
    writeFileSync(`${OUT}/cost.json`, JSON.stringify(results, null, 2));
    await mf?.dispose();
  }, 300000);

  it('A·D·E: 역할, 세션, 준비 검사 (N = 130)', async () => {
    await catalogue(1);
    keep('role (member)', await metered(() => roleRoute(request('/api/d1/role', 'member'))));
    keep('role (admin)', await metered(() => roleRoute(request('/api/d1/role', 'admin'))));
    keep('get-session (member)', await metered(() => authGet(request('/api/auth/get-session', 'member'))));
    keep('storage/status', await metered(() => statusRoute()));
  }, 300000);

  it('B·C·I: 자산 메타·raw·목록 이미지, 공개 이미지, 공개 배치 한 쪽 (N, 5N)', async () => {
    // A member's own uploaded image.
    const form = new FormData();
    const own = crypto.randomUUID();
    form.set('metadata', JSON.stringify({ id: own, kind: 'product', name: 'a.png' }));
    form.set('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'a.png');
    const uploaded = await assetsPost(request('/api/d1/assets', 'member', { method: 'POST', body: form }));
    expect(uploaded.status, await uploaded.clone().text()).toBe(200);
    for (const [size, times] of [
      ['N', 0],
      ['5N', 4],
    ] as const) {
      await catalogue(times);
      const shared = await anyCatalogueAsset();
      keep(
        `asset meta, own (${size})`,
        await metered(() => assetsGet(request(`/api/d1/assets?id=${own}`, 'member'))),
      );
      keep(
        `asset raw, own (${size})`,
        await metered(() => assetsGet(request(`/api/d1/assets?id=${own}&raw=1`, 'member'))),
      );
      keep(
        `asset meta, shared catalogue (${size})`,
        await metered(() => assetsGet(request(`/api/d1/assets?id=${shared}`, 'member'))),
      );
      keep(
        `asset list image, shared catalogue (${size})`,
        await metered(() => assetsGet(request(`/api/d1/assets?id=${shared}&raw=1&size=list`, 'member'))),
      );
      keep(
        `catalog image (${size})`,
        await metered(() => catalogImage(request(`/api/catalog/images?id=${shared}`))),
      );
      keep(
        `catalog image list (${size})`,
        await metered(() => catalogImage(request(`/api/catalog/images?id=${shared}&size=list`))),
      );
      keep(
        `catalog materials page (${size})`,
        await metered(() => catalogMaterials(request('/api/catalog/materials'))),
      );
      keep(
        `catalog placement page (${size})`,
        await metered(() => catalogPlacement(request('/api/catalog/placement'))),
      );
      // F: the owner of the catalogue's images (every one referenced) runs the project-delete cleanup.
      keep(
        `cleanup run, admin owning the catalogue (${size})`,
        await metered(() => cleanupRoute(post('/api/d1/cleanup', 'admin', { operation: 'run' }))),
      );
    }
  }, 300000);

  it('B(관리자): 다른 회원 프로젝트의 자산 메타·raw', async () => {
    const source = crypto.randomUUID();
    const form = new FormData();
    form.set('metadata', JSON.stringify({ id: source, kind: 'product', name: 'p.png' }));
    form.set('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'p.png');
    expect(
      (await assetsPost(request('/api/d1/assets', 'member', { method: 'POST', body: form }))).status,
    ).toBe(200);
    const now = new Date().toISOString();
    const document: ProjectDocument = normalizeProjectDocument({
      id: crypto.randomUUID(),
      ownerId: 'x',
      name: '3차 측정',
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
    const made = await projectsRoute(post('/api/d1/projects', 'member', { operation: 'create', document }));
    expect(made.status, await made.clone().text()).toBe(200);
    const projectId = ((await made.json()) as ProjectDocument).id;
    const path = `/api/admin/project-assets?projectId=${projectId}&id=${source}`;
    keep('admin project asset meta', await metered(() => adminProjectAsset(request(path, 'admin'))));
    keep(
      'admin project asset raw',
      await metered(() => adminProjectAsset(request(path + '&raw=1', 'admin'))),
    );
  }, 300000);

  it('F: 정리 후보 검색의 쿼리 계획, 회원의 정리 실행', async () => {
    keep(
      'cleanup run, member',
      await metered(() => cleanupRoute(post('/api/d1/cleanup', 'member', { operation: 'run' }))),
    );
    // The candidate search exactly as src/lib/d1/cleanup.ts writes it.
    const plan = await db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT a.id FROM d1_assets a WHERE a.owner_id=? AND a.deleting=0
    AND a.created_at<? AND NOT EXISTS(SELECT 1 FROM d1_project_assets r WHERE r.asset_id=a.id)
  AND NOT EXISTS(SELECT 1 FROM d1_material_assets r WHERE r.asset_id=a.id)
  AND NOT EXISTS(SELECT 1 FROM d1_assets child WHERE child.source_asset_id=a.id)
  AND NOT (a.source_asset_id IS NOT NULL AND json_extract(a.metadata_json,'$.derivation')='list'
    AND EXISTS(SELECT 1 FROM d1_material_assets r WHERE r.asset_id=a.source_asset_id)) LIMIT 4`,
      )
      .bind(ids.admin, new Date().toISOString())
      .all();
    results['cleanup candidate plan'] = plan.results;
    console.log(JSON.stringify(plan.results));
  }, 300000);

  it('H: 로그인 1회(요청 제한 기록 포함)', async () => {
    keep(
      'sign-in (rate limit in D1)',
      await metered(() =>
        authPost(
          request('/api/auth/sign-in/username', undefined, {
            method: 'POST',
            body: JSON.stringify({ username: 'round3member', password: 'round3-member-password' }),
          }),
        ),
      ),
    );
  }, 300000);
});
