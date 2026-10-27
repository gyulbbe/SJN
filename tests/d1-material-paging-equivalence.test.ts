/**
 * The paged material lists (migration 0009, src/lib/d1/material-list.ts) show exactly what the full
 * lists and the browser filters they replaced showed: frozen copies of both
 * (tests/helpers/legacy-material-lists.ts) run on the same isolated D1 over random catalogues. The
 * items come in the list's order (migrations 0010–0011: brand priority, newest registered, name either
 * way), which `bySort` states here in JS the way SQLite compares (byte order, ASCII lower(), spaces
 * trim()).
 *
 * Each seed builds owners' shared, personal, project, inactive and sample materials with older
 * versions, '·'-joined colours and surfaces, ties in updated_at, reconstruction values (absent,
 * object, null, false), missing or hidden images, and two administrator projects. It then compares,
 * page by page (small pages, so cursors are used), the editor drawer of every member, the
 * administrator library, the administrator project drawer, the public list and the guest drawer
 * over tabs, categories, searches and facet selections, with totals and facet options; and `find`
 * and `getVersions` against the old list and `getVersion`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { applyD1Migrations, allD1Migrations } from './helpers/d1-migrations';
import {
  legacyAdminProjectList,
  legacyEditorFilter,
  legacyManagerFilter,
  legacyMemberList,
  legacyPlacements,
  legacyPublicFilter,
  legacyPublicMaterials,
  type Entry,
} from './helpers/legacy-material-lists';
import { materials } from '../src/lib/d1/materials';
import { publicMaterials, publicPlacement, type PublicMaterial } from '../src/lib/catalog/public';
import { placementToMaterialVersion, type PublicPlacement } from '../src/lib/catalog/placement-contract';
import { materialCard, type MaterialCard } from '../src/lib/catalog/cards';
import {
  editorTabQuery,
  materialSorts,
  pageSearchParams,
  type MaterialPage,
  type MaterialPageQuery,
  type MaterialSort,
} from '../src/lib/catalog/paging';
import { emptyFacets, facetKeys, type FacetSelection } from '../src/lib/catalog/facets';
import { materialReferences } from '../src/lib/repositories/references';
import { matchesReconstruction } from '../src/lib/repositories/batches';
import type { Context } from '../src/lib/d1/database';
import type { D1Bindings, D1DatabaseLike } from '../src/lib/d1/types';
import type { MaterialCategory, MaterialVersion } from '../src/lib/types';

// SJN_EQ_SEEDS=6 for the recorded proof (every combination); the default run samples one seed.
const FULL = !!process.env.SJN_EQ_SEEDS;
const SEEDS = Array.from({ length: Number(process.env.SJN_EQ_SEEDS ?? 1) }, (_, i) => 20261022 + i);
const PAGE = 7;

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
const OWNERS = ['member-1', 'member-2', 'admin-1'];
const ADMINS = ['admin-1', 'admin-2'];
const TIMES = Array.from({ length: 9 }, (_, i) => `2026-10-0${i + 1}T00:00:00.000Z`);
const NAMES = [
  '라이트 스톤',
  'Stone Grey',
  'WHITE Tile',
  '욕실 타일',
  '세면대 A',
  'Toto 변기',
  '모자이크',
  '  가 타일 ',
  '10 Tile',
  '9 Tile',
];
const BRANDS = ['TOTO', '대림바스', '', 'KOHLER'];
const CODES = ['A-1', 'b-22', 'EXAMPLE-STONE-01', 'X9', ''];
const COLORS = ['화이트', '그레이', '베이지', '블루', '차콜'];
const FINISHES = ['무광', '유광', '반광'];
const SIZES = [600, 300, 1200, 297.5];
const SAMPLE_DESCRIPTION = '코드로 직접 제작한 테스트용 질감입니다. 실제 판매 상품이 아닙니다.';

let mf: Miniflare;
let db: D1DatabaseLike;
let env: D1Bindings;
beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response(null, { status: 404 }); } };',
      compatibilityDate: '2026-09-07',
      d1Databases: { DB: 'sjn-paging-equivalence' },
    }),
  );
  db = (await mf.getD1Database('DB')) as unknown as D1DatabaseLike;
  await applyD1Migrations(db, allD1Migrations);
  env = { DB: db, ASSET_BUCKET: { get: async () => null } } as unknown as D1Bindings;
});
afterAll(async () => mf?.dispose());

const insert = (table: string, columns: string[], rows: unknown[][]) =>
  db
    .prepare(
      `INSERT INTO ${table}(${columns.join(',')}) SELECT ${columns
        .map((_, i) => `json_extract(value,'$[${i}]')`)
        .join(',')} FROM json_each(?)`,
    )
    .bind(JSON.stringify(rows));

type Graph = { versions: string[]; projects: { id: string; ownerId: string }[]; codes: string[] };
/** What the orders read: each version's brand order, each material's registration and current version. */
const orders = {
  prio: new Map<string, number>(),
  created: new Map<string, string>(),
  current: new Map<string, string>(),
};
async function build(seed: number): Promise<Graph> {
  const random = prng(seed);
  // The brands of 0004: some get a 표시 순서 (ties on purpose), the rest none.
  const brandIds = (
    await db.prepare("SELECT id FROM d1_catalog_options WHERE kind='brand' ORDER BY id").all<{ id: string }>()
  ).results.map((row) => row.id);
  const brandOrder = new Map(
    brandIds.map((id) => [id, random() < 0.5 ? [0, 1, 1, 3][Math.floor(random() * 4)] : null]),
  );
  const brandRows: unknown[][] = [];
  orders.prio.clear();
  orders.created.clear();
  orders.current.clear();
  const chance = (p: number) => random() < p;
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
  const joined = (pool: string[]) =>
    Array.from({ length: 1 + Math.floor(random() * 2) }, () => pick(pool)).join(pick([' · ', '·', ' ·  ']));
  const assetRows: unknown[][] = [],
    materialRows: unknown[][] = [],
    versionRows: unknown[][] = [],
    referenceRows: unknown[][] = [];
  const versions: string[] = [];
  const codes = new Set<string>();
  const image = (kind: string) => {
    const id = uuid();
    // Some images are gone or not public: lists hide them, the guest drawer hides their material.
    if (!chance(0.05))
      assetRows.push([
        id,
        'admin-1',
        'assets/' + id,
        JSON.stringify({
          id,
          kind: chance(0.05) ? 'original' : kind,
          mime: 'image/png',
          width: 8,
          height: 8,
          size: 8,
        }),
        'hash',
        TIMES[0],
        chance(0.04) ? 1 : 0,
      ]);
    return id;
  };
  for (let i = 0, count = 30 + Math.floor(random() * 30); i < count; i++) {
    const materialId = uuid();
    const sample = chance(0.06);
    const scope = sample || chance(0.7) ? 'shared' : 'personal';
    const category: MaterialCategory = sample || chance(0.6) ? 'tile' : pick(['basin', 'toilet', 'faucet']);
    const own: string[] = [];
    for (let n = 1, total = sample ? 1 : 1 + Math.floor(random() * 3); n <= total; n++) {
      const id = uuid();
      own.push(id);
      const reconstruction = chance(0.88) ? undefined : pick([{ version: 2, kind: category }, null, false]);
      const name = sample ? '라이트 스톤' : pick(NAMES) + (chance(0.5) ? ' ' + i : '');
      const code = sample ? 'EXAMPLE-STONE-01' : pick(CODES) + (chance(0.3) ? '-' + n : '');
      if (code) codes.add(code);
      const views =
        category === 'tile'
          ? []
          : Array.from({ length: 1 + Math.floor(random() * 2) }, (_, v) => ({
              assetId: image('product'),
              direction: ['정면', '왼쪽'][v],
              anchor: { x: 0.5, y: 1 },
            }));
      const payload = {
        id,
        materialId,
        version: n,
        createdAt: TIMES[0],
        name,
        brand: sample ? '공간미리 예시' : pick(BRANDS),
        code,
        category,
        scope,
        description: sample ? SAMPLE_DESCRIPTION : '',
        color: chance(0.15) ? '' : joined(COLORS),
        finish: chance(0.2) ? '' : joined(FINISHES),
        composition: chance(0.5) ? '포세린' : '',
        ...(chance(0.4) ? { subcategoryName: '포세린 타일' } : {}),
        widthMm: pick(SIZES),
        heightMm: pick(SIZES),
        depthMm: pick([10, 0, 400]),
        // A version without usage (old data) only on a personal material: saving requires it, and the
        // public placement contract rejects it (the old full placement list failed on one too).
        ...(scope === 'personal' && chance(0.2) ? {} : { usage: pick(['wall', 'floor', 'both'] as const) }),
        installation: 'wall',
        textureAssetIds:
          category === 'tile' ? [image('texture'), ...(chance(0.2) ? [image('texture')] : [])] : [],
        views,
        ...(category !== 'tile' && chance(0.2) ? { coverAssetId: image('product') } : {}),
        ...(reconstruction !== undefined ? { reconstruction } : {}),
        defaultGroutWidth: 2,
        defaultGroutColor: '#ffffff',
        defaultPattern: 'grid',
      };
      versionRows.push([id, materialId, n, JSON.stringify(payload), category, views.length, TIMES[0]]);
      // Most versions name a brand (a save links it); its 표시 순서 orders them.
      const brand = chance(0.75) ? pick(brandIds) : undefined;
      if (brand) brandRows.push([id, brand, 'brand']);
      orders.prio.set(id, (brand ? brandOrder.get(brand) : undefined) ?? 10000);
      for (const assetId of materialReferences(
        payload as unknown as Parameters<typeof materialReferences>[0],
      ))
        referenceRows.push([id, assetId]);
    }
    const current = chance(0.85) ? own.at(-1)! : pick(own),
      created = pick(TIMES);
    orders.created.set(materialId, created);
    orders.current.set(materialId, current);
    materialRows.push([
      materialId,
      sample ? 'admin-1' : pick(OWNERS),
      scope,
      current,
      chance(0.85) ? 1 : 0,
      created,
      pick(TIMES),
      scope === 'personal' && chance(0.6) ? 'project' : chance(0.05) ? 'project' : 'catalog',
    ]);
    versions.push(...own);
  }
  const projects = [
    { id: uuid(), ownerId: 'member-1' },
    { id: uuid(), ownerId: 'member-2' },
  ];
  const projectVersions: unknown[][] = [],
    adminVersions: unknown[][] = [];
  for (const project of projects)
    for (const versionId of versions)
      if (chance(0.12)) projectVersions.push([project.id, versionId]);
      else if (chance(0.06)) adminVersions.push([project.id, versionId, pick(ADMINS), TIMES[0]]);
  await db.batch([
    ...[
      'd1_admin_project_versions',
      'd1_project_versions',
      'd1_material_assets',
      'd1_material_list_counts',
      'd1_material_list_facets',
      'd1_material_list',
      'd1_material_version_options',
      'd1_material_versions',
      'd1_materials',
      'd1_projects',
      'd1_assets',
    ].map((table) => db.prepare(`DELETE FROM ${table}`)),
    ...brandIds.map((id) =>
      db
        .prepare('UPDATE d1_catalog_options SET display_order=? WHERE id=?')
        .bind(brandOrder.get(id) ?? null, id),
    ),
    insert(
      'd1_assets',
      ['id', 'owner_id', 'object_key', 'metadata_json', 'content_hash', 'created_at', 'deleting'],
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
    insert('d1_material_version_options', ['version_id', 'option_id', 'option_kind'], brandRows),
    // Only references to images that exist (as every save records them).
    db
      .prepare(
        `INSERT INTO d1_material_assets(version_id,asset_id) SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]')
         FROM json_each(?) WHERE json_extract(value,'$[1]') IN (SELECT id FROM d1_assets)`,
      )
      .bind(JSON.stringify(referenceRows)),
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
      projects.map((p) => [p.id, p.ownerId, '시험', 1, 'projects/' + p.id, 1, '{}', TIMES[0], TIMES[0]]),
    ),
    insert('d1_project_versions', ['project_id', 'version_id'], projectVersions),
    insert(
      'd1_admin_project_versions',
      ['project_id', 'version_id', 'actor_id', 'created_at'],
      adminVersions,
    ),
  ]);
  return { versions, projects, codes: [...codes] };
}

/** Every page of a member list (small pages, so cursors carry the rest). */
async function memberPages(ctx: Context, query: MaterialPageQuery, extra: Record<string, unknown> = {}) {
  const items: MaterialCard[] = [];
  let first: MaterialPage<MaterialCard> | undefined;
  let cursor: string | undefined;
  const page = async () =>
    (await materials(ctx, {
      operation: 'page',
      query: { ...query, limit: PAGE, ...(cursor ? { cursor } : {}) },
      ...extra,
    })) as MaterialPage<MaterialCard>;
  for (let guard = 0; guard < 100; guard++) {
    const next = await page();
    first ??= next;
    items.push(...next.items);
    if (!next.nextCursor) break;
    cursor = next.nextCursor;
  }
  return { items, total: first!.total, facets: first!.facets, counts: first!.counts };
}
async function getPages<T>(
  route: (request: Request) => Promise<Response>,
  path: string,
  query: MaterialPageQuery,
  field: 'items' | 'placements',
) {
  const items: T[] = [];
  let first: (MaterialPage<T> & { placements?: T[] }) | undefined;
  let cursor: string | undefined;
  for (let guard = 0; guard < 100; guard++) {
    const params = pageSearchParams({ ...query, limit: PAGE, ...(cursor ? { cursor } : {}) });
    const response = await route(new Request(`https://sjn.test${path}?${params}`));
    expect(response.status, await response.clone().text()).toBe(200);
    const next = (await response.json()) as MaterialPage<T> & { placements?: T[] };
    first ??= next;
    items.push(...((field === 'items' ? next.items : next.placements) ?? []));
    if (!next.nextCursor) break;
    cursor = next.nextCursor;
  }
  return { items, total: first!.total, facets: first!.facets };
}
/** Facet selections to try: none, a few offered values, and a value the range does not offer. */
function selections(options: FacetSelection, pick: <T>(items: readonly T[]) => T): FacetSelection[] {
  const result = [emptyFacets()];
  for (const key of facetKeys)
    if (options[key].length) result.push({ ...emptyFacets(), [key]: [pick(options[key])] });
  if (options.size.length && options.color.length)
    result.push({
      size: [pick(options.size), '1X1'],
      color: options.color.slice(0, 2),
      finish: [],
    });
  return result;
}
const SEARCHES = ['', ' ', 'stone', 'TILE', '타일', 'b-2', '없는말'];

const bytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
/** SQLite's substr(lower(trim(name)),1,100): ASCII letters only, spaces only. */
const nameKey = (name: string) =>
  [...name.replace(/^ +| +$/g, '').replace(/[A-Z]/g, (c) => c.toLowerCase())].slice(0, 100).join('');
/**
 * The list order (src/lib/d1/material-list.ts ORDERS), the material id settling ties: the version's
 * brand order, its registration time, its name.
 */
const bySort =
  <T>(sort: MaterialSort, key: (item: T) => { id: string; version: string; name: string }) =>
  (x: T, y: T) => {
    const a = key(x),
      b = key(y);
    const id = bytes(a.id, b.id);
    const name = bytes(nameKey(a.name), nameKey(b.name));
    if (sort === 'name') return name || id;
    if (sort === 'nameDesc') return -(name || id);
    if (sort === 'newest') return -(bytes(orders.created.get(a.id)!, orders.created.get(b.id)!) || id);
    return orders.prio.get(a.version)! - orders.prio.get(b.version)! || name || id;
  };
const entryOrder = (sort: MaterialSort) =>
  bySort<Entry>(sort, (entry) => ({
    id: entry.material.id,
    version: entry.version.id,
    name: entry.version.name,
  }));
const cardsOf = (entries: Entry[]) => entries.map((entry) => materialCard(entry.material, entry.version));

describe('paged material lists show what the full lists and browser filters showed', () => {
  it.each(SEEDS)(
    'seed %i',
    async (seed) => {
      const graph = await build(seed);
      const random = prng(seed + 1);
      const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
      /** Every combination for the recorded proof; two of them (the first and one more) otherwise. */
      const some = <T>(items: readonly T[]): T[] =>
        FULL || items.length <= 2 ? [...items] : [items[0], pick(items.slice(1))];
      /** The order of one comparison: every order for the proof, the default or another one otherwise. */
      const sorts = () => some(materialSorts);
      const sortQuery = (sort: MaterialSort) => (sort === 'priority' ? {} : { sort });

      // Member and administrator editor drawers: tab, search, facets.
      for (const actor of OWNERS) {
        const ctx: Context = { env, actor: { id: actor, isAdmin: actor.startsWith('admin') } };
        const list = await legacyMemberList(db, actor);
        for (const tab of ['wall', 'floor', 'fixtures'] as const) {
          const { facets: offered } = legacyEditorFilter(list, { tab, search: '', facets: emptyFacets() });
          for (const [index, facets] of some(selections(offered, pick)).entries())
            for (const search of index === 0 && FULL ? SEARCHES : ['', pick(SEARCHES)])
              for (const sort of sorts()) {
                const old = legacyEditorFilter(list, { tab, search, facets });
                const got = await memberPages(ctx, {
                  ...editorTabQuery(tab),
                  ...(search ? { q: search } : {}),
                  facets,
                  options: true,
                  ...sortQuery(sort),
                });
                const label = JSON.stringify({ actor, tab, search, facets, sort });
                expect(got.items, label).toEqual(cardsOf(old.items.sort(entryOrder(sort))));
                expect(got.total, label).toBe(old.items.length);
                expect(got.facets, label).toEqual(old.facets);
              }
        }
        // The administrator library: scope tabs, deactivated ones, category, search, tab counts.
        for (const scope of some(['all', 'personal', 'shared'] as const))
          for (const inactive of [false, true])
            for (const category of some(['all', 'tile', 'basin'] as const))
              for (const search of FULL ? ['', pick(SEARCHES)] : [pick(SEARCHES)])
                for (const sort of FULL ? materialSorts : [pick(materialSorts)]) {
                  const old = legacyManagerFilter(list, { inactive, scope, category, search });
                  const got = await memberPages(
                    ctx,
                    {
                      ...(category === 'all' ? {} : { category }),
                      ...(search ? { q: search } : {}),
                      ...sortQuery(sort),
                    },
                    { view: 'library', scope, active: !inactive },
                  );
                  const label = JSON.stringify({ actor, scope, inactive, category, search, sort });
                  expect(got.items, label).toEqual(cardsOf(old.matching.sort(entryOrder(sort))));
                  expect(got.total, label).toBe(old.matching.length);
                  expect(got.counts, label).toEqual(old.counts);
                }
        // find: the first list entry with that code and reconstruction.
        for (const code of some(graph.codes))
          for (const reconstruction of [{ version: 2 as const }, { kind: 'tile' as const }]) {
            const match = { code, reconstruction };
            const old = list.find(({ version }) => matchesReconstruction(version, match))?.version ?? null;
            expect(await materials(ctx, { operation: 'find', match }), JSON.stringify(match)).toEqual(old);
          }
        // getVersions: what getVersion reads one by one, and each material as the old list showed it.
        const ids = [...Array.from({ length: 12 }, () => pick(graph.versions)), uuid()];
        const one: MaterialVersion[] = [];
        for (const id of new Set(ids))
          try {
            one.push((await materials(ctx, { operation: 'getVersion', id })) as MaterialVersion);
          } catch {
            // not readable
          }
        const batch = (await materials(ctx, { operation: 'getVersions', ids, withCurrent: true })) as {
          versions: MaterialVersion[];
          current: Entry[];
        };
        expect(batch.versions.map((v) => v.id).sort()).toEqual(one.map((v) => v.id).sort());
        const expected = list.filter((entry) => one.some((v) => v.materialId === entry.material.id));
        expect([...batch.current].sort((a, b) => a.material.id.localeCompare(b.material.id))).toEqual(
          [...expected].sort((a, b) => a.material.id.localeCompare(b.material.id)),
        );
      }

      // Administrator project drawers.
      for (const project of graph.projects)
        for (const admin of some(ADMINS)) {
          const scope = { id: project.id, ownerId: project.ownerId, requestId: 'eq' };
          const ctx: Context = { env, actor: { id: admin, isAdmin: true }, adminProject: scope };
          const list = await legacyAdminProjectList(db, scope, admin);
          // Current versions first, then the older versions the project uses; each in the list's order.
          const order = (sort: MaterialSort) => (a: (typeof list)[number], b: (typeof list)[number]) =>
            Number(b.current) - Number(a.current) || entryOrder(sort)(a, b);
          for (const tab of ['wall', 'floor', 'fixtures'] as const) {
            const { facets: offered } = legacyEditorFilter(list, { tab, search: '', facets: emptyFacets() });
            for (const facets of some(selections(offered, pick)))
              for (const search of ['', pick(SEARCHES)])
                for (const sort of sorts()) {
                  const old = legacyEditorFilter(list, { tab, search, facets });
                  const got = await memberPages(ctx, {
                    ...editorTabQuery(tab),
                    ...(search ? { q: search } : {}),
                    facets,
                    options: true,
                    ...sortQuery(sort),
                  });
                  const label = JSON.stringify({ project: project.id, admin, tab, search, facets, sort });
                  expect(got.items, label).toEqual(cardsOf(old.items.sort(order(sort))));
                  expect(got.total, label).toBe(old.items.length);
                  expect(got.facets, label).toEqual(old.facets);
                }
          }
          for (const code of some(graph.codes)) {
            const match = { code, reconstruction: { version: 2 as const } };
            const old = list.find(({ version }) => matchesReconstruction(version, match))?.version ?? null;
            expect(await materials(ctx, { operation: 'find', match }), code).toEqual(old);
          }
        }

      // The public list: category, search (NFKC), facets; cards as before (without pricing).
      const publicRows = await legacyPublicMaterials(db);
      for (const category of ['', 'tile', 'basin', 'toilet']) {
        const { facets: offered } = legacyPublicFilter(publicRows, {
          category,
          query: '',
          facets: emptyFacets(),
        });
        for (const facets of some(selections(offered, pick)))
          for (const query of ['', pick(SEARCHES), 'ＳＴＯＮＥ'])
            for (const sort of sorts()) {
              const old = legacyPublicFilter(publicRows, { category, query, facets });
              const got = await getPages<PublicMaterial>(
                (request) => publicMaterials(env, request),
                '/api/catalog/materials',
                {
                  ...(category ? { category: category as MaterialCategory } : {}),
                  ...(query ? { q: query } : {}),
                  facets,
                  options: true,
                  ...sortQuery(sort),
                },
                'items',
              );
              const label = JSON.stringify({ category, query, facets, sort });
              expect(got.items, label).toEqual(
                old.matching
                  .sort(
                    bySort(sort, (row) => ({
                      id: row.id,
                      version: orders.current.get(row.id)!,
                      name: row.name,
                    })),
                  )
                  .map((row) => ({ ...row, updatedAt: undefined }))
                  .map((row) => JSON.parse(JSON.stringify(row))),
              );
              expect(got.total, label).toBe(old.matching.length);
              expect(got.facets, label).toEqual(old.facets);
            }
      }

      // The guest drawer: public placements whose images are all public, without the samples.
      const placements = await legacyPlacements(env);
      const guestList = placements.map(({ placement, updatedAt }) => ({
        material: {
          id: placement.materialId,
          ownerId: 'guest-public',
          currentVersionId: placement.versionId,
          active: true,
          scope: 'shared' as const,
          updatedAt,
        },
        version: placementToMaterialVersion(placement),
      }));
      for (const tab of ['wall', 'floor', 'fixtures'] as const) {
        const { facets: offered } = legacyEditorFilter(guestList, { tab, search: '', facets: emptyFacets() });
        for (const facets of some(selections(offered, pick)))
          for (const search of ['', pick(SEARCHES)])
            for (const sort of sorts()) {
              const old = legacyEditorFilter(guestList, { tab, search, facets });
              const got = await getPages<PublicPlacement>(
                (request) => publicPlacement(env, request),
                '/api/catalog/placement',
                {
                  ...editorTabQuery(tab),
                  ...(search ? { q: search } : {}),
                  facets,
                  options: true,
                  ...sortQuery(sort),
                },
                'placements',
              );
              const label = JSON.stringify({ guest: tab, search, facets, sort });
              expect(
                got.items.map((p) => p.versionId),
                label,
              ).toEqual(old.items.sort(entryOrder(sort)).map((entry) => entry.version.id));
              // The options come from the public summary, which does not look at images: a value only a
              // material with a missing image has can show (docs: guest facet options).
              for (const key of facetKeys)
                expect(got.facets![key], label).toEqual(expect.arrayContaining(old.facets[key]));
            }
      }
    },
    600_000,
  );
});

describe('cursors and limits', () => {
  it('continues only the query it came from and rejects a forged or oversized one', async () => {
    await build(7);
    const ctx: Context = { env, actor: { id: 'member-1', isAdmin: false } };
    const first = (await materials(ctx, {
      operation: 'page',
      query: { category: 'tile', usage: 'wall', limit: 2 },
    })) as MaterialPage<MaterialCard>;
    expect(first.nextCursor).toBeTruthy();
    await expect(
      materials(ctx, {
        operation: 'page',
        query: { category: 'tile', usage: 'floor', cursor: first.nextCursor },
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      materials(ctx, {
        operation: 'page',
        query: { category: 'tile', usage: 'wall', q: 'a', cursor: first.nextCursor },
      }),
    ).rejects.toMatchObject({ status: 400 });
    // Another view or library scope is another list.
    await expect(
      materials(ctx, {
        operation: 'page',
        query: { category: 'tile', usage: 'wall', cursor: first.nextCursor },
        view: 'library',
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      materials(ctx, { operation: 'page', query: { category: 'tile', usage: 'wall', cursor: 'not!base64' } }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      materials(ctx, {
        operation: 'page',
        query: { category: 'tile', usage: 'wall', cursor: 'a'.repeat(3000) },
      }),
    ).rejects.toThrow();
    await expect(materials(ctx, { operation: 'page', query: { limit: 49 } })).rejects.toThrow();
    await expect(materials(ctx, { operation: 'page', query: { usage: 'wall' } })).rejects.toThrow();
    // The same query continues, with another page size too.
    const next = (await materials(ctx, {
      operation: 'page',
      query: { category: 'tile', usage: 'wall', limit: 5, cursor: first.nextCursor },
    })) as MaterialPage<MaterialCard>;
    expect(next.items.map((item) => item.materialId)).not.toContain(first.items[0].materialId);
    expect(next.total).toBeUndefined();
    for (const search of ['limit=500', 'owner=x', 'facets=%7B', 'category=nope'])
      await expect(
        publicMaterials(env, new Request('https://sjn.test/api/catalog/materials?' + search)),
      ).rejects.toMatchObject({ status: 400 });
  });
  it('keeps the library and administrator project scopes to themselves', async () => {
    await build(8);
    const ctx: Context = {
      env,
      actor: { id: 'admin-2', isAdmin: true },
      adminProject: { id: uuid(), ownerId: 'member-1', requestId: 'x' },
    };
    await expect(materials(ctx, { operation: 'page', query: {}, view: 'library' })).rejects.toMatchObject({
      status: 403,
    });
    await expect(materials(ctx, { operation: 'page', query: {}, active: false })).rejects.toMatchObject({
      status: 403,
    });
  });
});
