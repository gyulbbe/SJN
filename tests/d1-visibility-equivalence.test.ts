/**
 * The request-scoped visibility queries (docs/d1-query-efficiency-results-20261017.md) decide exactly
 * what the whole-set queries they replaced decided. Frozen copies of the old SQL
 * (tests/helpers/d1-visibility-legacy.ts) run on the same isolated D1 as the current code, over
 * random graphs: owners, shared/personal/project materials with old versions, derived-asset chains
 * with deleted links, project and administrator project references, missing and duplicate ids.
 *
 * Every seed compares the visible sets over all ids at once. The first seeds also go through the
 * real readers, batch assertions and public routes one id or list at a time (each D1 call is slow
 * on a local Worker, so not all seeds do).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { applyD1Migrations, allD1Migrations } from './helpers/d1-migrations';
import { legacyAssets, legacyVersions, LEGACY_PUBLICLY_DISPLAYED } from './helpers/d1-visibility-legacy';
import {
  assetAssertion,
  readableAsset,
  validateReferences,
  versionAssertion,
  visibleAssetsQuery,
  visibleVersionsQuery,
  type Context,
} from '../src/lib/d1/database';
import { materials } from '../src/lib/d1/materials';
import { publicImage, publicPlacement, publiclyDisplayed } from '../src/lib/catalog/public';
import { materialReferences } from '../src/lib/repositories/references';
import type { D1Bindings, D1DatabaseLike, D1Statement } from '../src/lib/d1/types';

// SJN_EQ_SEEDS=60 for the recorded proof; the default keeps the regular run short.
const SEEDS = Array.from({ length: Number(process.env.SJN_EQ_SEEDS ?? 10) }, (_, i) => 20261017 + i);
const CALL_SEEDS = 3;

function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let counter = 0;
const uuid = () => '00000000-0000-4000-8000-' + (++counter).toString(16).padStart(12, '0');
const stamp = '2026-10-01T00:00:00.000Z';
const OWNERS = ['member-1', 'member-2', 'member-3', 'admin-1'];
const ADMINS = ['admin-1', 'admin-2'];
// Weighted towards the public kinds so that published images and placements occur often.
const KINDS = ['original', 'preview', 'product', 'product', 'texture', 'texture', 'product-mesh'];
const DIRECTIONS = ['정면', '왼쪽', '오른쪽', '뒤', '위', '오른쪽 측면'];

interface Graph {
  assets: string[];
  versions: string[];
  materials: string[];
  projects: { id: string; ownerId: string }[];
  missing: string[];
}
let mf: Miniflare;
let db: D1DatabaseLike;
let env: D1Bindings;
const bucket = { get: async () => ({ body: null }) };

/** One INSERT per table (rows as JSON): a local D1 call costs far more than the rows in it. */
const insert = (table: string, columns: string[], rows: unknown[][]) =>
  db
    .prepare(
      `INSERT INTO ${table}(${columns.join(',')}) SELECT ${columns
        .map((_, i) => `json_extract(value,'$[${i}]')`)
        .join(',')} FROM json_each(?)`,
    )
    .bind(JSON.stringify(rows));

async function build(seed: number): Promise<Graph> {
  const random = prng(seed);
  const chance = (p: number) => random() < p;
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)];
  const assets: { id: string; depth: number }[] = [];
  const assetRows: unknown[][] = [];
  for (let i = 0, count = 30 + Math.floor(random() * 50); i < count; i++) {
    const id = uuid();
    const candidates = assets.filter((asset) => asset.depth < 4);
    const source = candidates.length && chance(0.55) ? pick(candidates) : null;
    const kind = pick(KINDS);
    const mime =
      kind === 'product-mesh' ? 'application/x-sjn-product-mesh' : pick(['image/png', 'image/webp']);
    assets.push({ id, depth: source ? source.depth + 1 : 0 });
    assetRows.push([
      id,
      pick(OWNERS),
      'assets/' + id,
      source?.id ?? null,
      JSON.stringify({ id, name: 'a.png', kind, mime, width: 10, height: 12, size: 120 }),
      'hash',
      stamp,
      chance(0.12) ? 1 : 0,
    ]);
  }
  const assetIds = assets.map((asset) => asset.id);
  const someAssets = (max: number) =>
    Array.from({ length: Math.floor(random() * (max + 1)) }, () => pick(assetIds));
  const materialRows: unknown[][] = [],
    versionRows: unknown[][] = [],
    referenceRows: unknown[][] = [];
  const versions: string[] = [],
    materialIds: string[] = [];
  for (let i = 0, count = 6 + Math.floor(random() * 14); i < count; i++) {
    const materialId = uuid();
    const scope = chance(0.6) ? 'shared' : 'personal';
    const category = chance(0.4) ? 'tile' : pick(['basin', 'toilet']);
    const own: string[] = [];
    for (let n = 1, total = 1 + Math.floor(random() * 3); n <= total; n++) {
      const id = uuid();
      own.push(id);
      const views =
        category === 'tile'
          ? []
          : someAssets(3).map((assetId) => ({
              assetId,
              direction: pick(DIRECTIONS),
              anchor: { x: 0.5, y: 1 },
              ...(chance(0.15)
                ? { product3d: { inputAssetId: pick(assetIds), meshAssetId: pick(assetIds), modelId: 'old' } }
                : {}),
            }));
      const payload = {
        id,
        materialId,
        version: n,
        createdAt: stamp,
        name: '시험 자재',
        brand: '',
        code: 'code-' + n,
        category,
        scope,
        description: '',
        color: '',
        finish: '',
        widthMm: 600,
        heightMm: 800,
        depthMm: 400,
        usage: 'wall',
        installation: 'wall',
        textureAssetIds: category === 'tile' ? someAssets(2) : [],
        views,
        ...(chance(0.45)
          ? { coverAssetId: chance(0.3) && views[0] ? views[0].assetId : pick(assetIds) }
          : {}),
        ...(chance(0.3) ? { imageAssetIds: someAssets(2) } : {}),
        ...(chance(0.12) ? { reconstruction: { version: 1, kind: category } } : {}),
        ...(chance(0.05) ? { reconstruction: null } : {}),
        defaultGroutWidth: 2,
        defaultGroutColor: '#ffffff',
        defaultPattern: 'grid',
      };
      versionRows.push([id, materialId, n, JSON.stringify(payload), category, views.length, stamp]);
      // Exactly what a save records: every image the version names (materials.ts).
      for (const assetId of materialReferences(
        payload as unknown as Parameters<typeof materialReferences>[0],
      ))
        referenceRows.push([id, assetId]);
    }
    materialRows.push([
      materialId,
      pick(OWNERS),
      scope,
      pick(own),
      chance(0.8) ? 1 : 0,
      stamp,
      `2026-10-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      chance(0.2) ? 'project' : 'catalog',
    ]);
    versions.push(...own);
    materialIds.push(materialId);
  }
  const projects = [
    { id: uuid(), ownerId: 'member-1' },
    { id: uuid(), ownerId: 'member-2' },
  ];
  const projectAssets: unknown[][] = [],
    adminAssets: unknown[][] = [],
    projectVersions: unknown[][] = [],
    adminVersions: unknown[][] = [];
  for (const project of projects) {
    for (const assetId of assetIds)
      if (chance(0.12)) projectAssets.push([project.id, assetId]);
      else if (chance(0.08)) adminAssets.push([project.id, assetId, pick(ADMINS), stamp]);
    for (const versionId of versions)
      if (chance(0.15)) projectVersions.push([project.id, versionId]);
      else if (chance(0.1)) adminVersions.push([project.id, versionId, pick(ADMINS), stamp]);
  }
  const statements: D1Statement[] = [
    ...[
      'd1_admin_project_assets',
      'd1_admin_project_versions',
      'd1_project_assets',
      'd1_project_versions',
      'd1_material_assets',
      'd1_material_versions',
      'd1_materials',
      'd1_projects',
      'd1_assets',
    ].map((table) => db.prepare(`DELETE FROM ${table}`)),
    insert(
      'd1_assets',
      [
        'id',
        'owner_id',
        'object_key',
        'source_asset_id',
        'metadata_json',
        'content_hash',
        'created_at',
        'deleting',
      ],
      assetRows,
    ),
    insert(
      'd1_materials',
      ['id', 'owner_id', 'scope', 'current_version_id', 'active', 'created_at', 'updated_at', 'purpose'],
      materialRows,
    ),
    insert(
      'd1_material_versions',
      ['id', 'material_id', 'version', 'payload_json', 'category', 'view_count', 'created_at'],
      versionRows,
    ),
    insert('d1_material_assets', ['version_id', 'asset_id'], referenceRows),
    insert(
      'd1_projects',
      [
        'id',
        'owner_id',
        'name',
        'storage_revision',
        'object_key',
        'byte_size',
        'summary_json',
        'created_at',
        'updated_at',
      ],
      projects.map((project) => [
        project.id,
        project.ownerId,
        '시험',
        1,
        'projects/' + project.id,
        1,
        '{}',
        stamp,
        stamp,
      ]),
    ),
    insert('d1_project_assets', ['project_id', 'asset_id'], projectAssets),
    insert('d1_admin_project_assets', ['project_id', 'asset_id', 'actor_id', 'created_at'], adminAssets),
    insert('d1_project_versions', ['project_id', 'version_id'], projectVersions),
    insert(
      'd1_admin_project_versions',
      ['project_id', 'version_id', 'actor_id', 'created_at'],
      adminVersions,
    ),
  ];
  await db.batch(statements);
  return { assets: assetIds, versions, materials: materialIds, projects, missing: [uuid(), uuid()] };
}

function scopes(graph: Graph): Context[] {
  const members = OWNERS.map((id) => ({ env, actor: { id, isAdmin: id.startsWith('admin') } }));
  const admin = graph.projects.flatMap((project) =>
    ADMINS.map((actor) => ({
      env,
      actor: { id: actor, isAdmin: true },
      adminProject: { id: project.id, ownerId: project.ownerId, requestId: 'equivalence' },
    })),
  );
  return [...members, ...admin];
}
const ids = async (query: string, values: unknown[]) =>
  new Set(
    (
      await db
        .prepare(query)
        .bind(...values)
        .all<{ id: string }>()
    ).results.map((row) => row.id),
  );
const passes = (promise: Promise<unknown>) =>
  promise.then(
    () => true,
    () => false,
  );
/** Runs a batch assertion as a commit would: a failed CHECK aborts the batch. */
const asserted = (statement: D1Statement) =>
  passes(db.batch([statement, db.prepare('DELETE FROM d1_checks')]));
const sorted = (values: string[]) => [...values].sort();

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response(null, { status: 404 }); } };',
      compatibilityDate: '2026-09-07',
      d1Databases: { DB: 'sjn-visibility-equivalence' },
    }),
  );
  db = (await mf.getD1Database('DB')) as unknown as D1DatabaseLike;
  env = { DB: db, ASSET_BUCKET: bucket } as unknown as D1Bindings;
  await applyD1Migrations(db, allD1Migrations);
}, 30000);
afterAll(async () => {
  await mf?.dispose();
});

const tally = {
  graphs: 0,
  scopes: 0,
  assetIds: 0,
  versionIds: 0,
  reads: 0,
  lists: 0,
  publicIds: 0,
  routes: 0,
};

describe('request-scoped visibility matches the whole-set queries it replaced', () => {
  it('assets and versions, member and administrator project scopes', async () => {
    for (const [index, seed] of SEEDS.entries()) {
      const graph = await build(seed);
      tally.graphs++;
      const random = prng(seed ^ 0x5eed);
      const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)];
      const requested = [...graph.assets, ...graph.missing, graph.assets[0], graph.assets[1]];
      const versionRequest = [...graph.versions, ...graph.missing, graph.versions[0]];
      await Promise.all(
        scopes(graph).map(async (ctx) => {
          tally.scopes++;
          const label = `seed ${seed} actor ${ctx.actor.id} project ${ctx.adminProject?.id ?? '-'}`;
          // The whole visible set over every id (plus missing and duplicate ones), old and new.
          const old = legacyAssets(ctx),
            now = visibleAssetsQuery(ctx, JSON.stringify(requested));
          const before = await ids(`${old.cte} SELECT id FROM visible_assets`, old.values);
          const after = await ids(`${now.cte} SELECT id FROM visible_assets`, now.values);
          expect(sorted([...after]), label).toEqual(sorted(graph.assets.filter((id) => before.has(id))));
          tally.assetIds += requested.length;
          const oldV = legacyVersions(ctx),
            nowV = visibleVersionsQuery(ctx, JSON.stringify(versionRequest));
          const versionsBefore = await ids(`${oldV.cte} SELECT id FROM visible_versions`, oldV.values);
          const versionsAfter = await ids(`${nowV.cte} SELECT id FROM visible_versions`, nowV.values);
          expect(sorted([...versionsAfter]), label).toEqual(
            sorted(graph.versions.filter((id) => versionsBefore.has(id))),
          );
          tally.versionIds += versionRequest.length;
          if (index >= CALL_SEEDS) return;
          // The real call sites, one asset, version or reference list at a time.
          const reads = [...graph.assets.slice(0, 4), ...Array.from({ length: 4 }, () => pick(requested))];
          const lists = Array.from({ length: 4 }, () =>
            Array.from({ length: Math.floor(random() * 7) }, () => pick(requested)),
          );
          const versionReads = [...graph.versions.slice(0, 3), pick(graph.missing)];
          const versionLists = Array.from({ length: 3 }, () =>
            Array.from({ length: Math.floor(random() * 5) }, () => pick(versionRequest)),
          );
          const materialRows = async (refs: string, cte: { cte: string; values: unknown[] }) =>
            sorted(
              (
                await db
                  .prepare(
                    `${cte.cte} SELECT a.id,a.metadata_json FROM d1_assets a JOIN visible_assets v ON v.id=a.id JOIN json_each(?) r ON r.value=a.id`,
                  )
                  .bind(...cte.values, refs)
                  .all<{ id: string }>()
              ).results.map((row) => row.id),
            );
          await Promise.all([
            ...reads.map(async (id) => {
              const row = await readableAsset(ctx, id).catch(() => null);
              expect(row?.id ?? null, `${label} asset ${id}`).toBe(before.has(id) ? id : null);
              tally.reads++;
            }),
            ...lists.map(async (list) => {
              const refs = JSON.stringify(list);
              const expected = list.every((id) => before.has(id));
              expect(await asserted(assetAssertion(ctx, refs)), `${label} list ${refs}`).toBe(expected);
              expect(await passes(validateReferences(ctx, refs, '[]')), `${label} validate ${refs}`).toBe(
                expected,
              );
              // checkMaterialAssets (materials.ts), duplicates included.
              expect(
                await materialRows(refs, visibleAssetsQuery(ctx, refs)),
                `${label} rows ${refs}`,
              ).toEqual(await materialRows(refs, old));
              tally.lists++;
            }),
            ...versionReads.map(async (id) => {
              const read = await passes(materials(ctx, { operation: 'getVersion', id }));
              expect(read, `${label} version ${id}`).toBe(versionsBefore.has(id));
              tally.reads++;
            }),
            ...versionLists.map(async (list) => {
              const refs = JSON.stringify(list);
              const expected = list.every((id) => versionsBefore.has(id));
              expect(await asserted(versionAssertion(ctx, refs)), `${label} versions ${refs}`).toBe(expected);
              expect(await passes(validateReferences(ctx, '[]', refs)), `${label} validate ${refs}`).toBe(
                expected,
              );
              tally.lists++;
            }),
          ]);
        }),
      );
    }
  }, 900_000);

  it('public images and placements', async () => {
    // The same public code, once with the old condition swapped back into its SQL.
    let swapped = 0;
    const oldDb = {
      prepare(query: string) {
        if (query.includes(publiclyDisplayed)) swapped++;
        return db.prepare(query.split(publiclyDisplayed).join(LEGACY_PUBLICLY_DISPLAYED));
      },
      batch: db.batch.bind(db),
    };
    const oldEnv = { DB: oldDb, ASSET_BUCKET: bucket } as unknown as D1Bindings;
    const image = (target: D1Bindings, id: string) =>
      publicImage(target, new Request('https://sjn.test/api/catalog/images?id=' + id)).then(
        (response) => response.status,
        (error: { status?: number }) => error.status ?? 500,
      );
    const placement = (target: D1Bindings, query = ''): Promise<{ placements?: unknown[]; error?: number }> =>
      publicPlacement(target, new Request('https://sjn.test/api/catalog/placement' + query)).then(
        (response) => response.json() as Promise<{ placements?: unknown[] }>,
        (error: { status?: number }) => ({ error: error.status }),
      );
    const shownSql = (condition: string) =>
      `SELECT a.id FROM d1_assets a WHERE a.deleting=0 AND json_extract(a.metadata_json,'$.kind') IN ('texture','product','preview') AND ${condition}`;
    let shown = 0,
      placed = 0;
    for (const [index, seed] of SEEDS.entries()) {
      const graph = await build(seed);
      const before = await ids(shownSql(LEGACY_PUBLICLY_DISPLAYED), []);
      expect(sorted([...(await ids(shownSql(publiclyDisplayed), []))]), `seed ${seed} shown`).toEqual(
        sorted([...before]),
      );
      shown += before.size;
      tally.publicIds += graph.assets.length;
      const list = await placement(env);
      expect(list, `seed ${seed} placements`).toEqual(await placement(oldEnv));
      placed += list.placements?.length ?? 0;
      tally.routes += 2;
      if (index >= CALL_SEEDS) continue;
      await Promise.all([
        ...[...graph.assets, ...graph.missing].map(async (id) => {
          expect(await image(env, id), `seed ${seed} image ${id}`).toBe(await image(oldEnv, id));
          tally.routes++;
        }),
        ...graph.materials.map(async (materialId) => {
          expect(await placement(env, '?materialId=' + materialId), `seed ${seed} ${materialId}`).toEqual(
            await placement(oldEnv, '?materialId=' + materialId),
          );
          tally.routes++;
        }),
      ]);
    }
    expect(swapped).toBeGreaterThan(0);
    // The graphs exercise both outcomes.
    expect(shown).toBeGreaterThan(0);
    expect(placed).toBeGreaterThan(0);
    console.log('[equivalence]', JSON.stringify({ ...tally, publicShown: shown, placements: placed }));
  }, 900_000);
});
