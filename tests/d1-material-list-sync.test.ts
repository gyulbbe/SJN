/**
 * Migration 0009's summary stays equal to its payloads and material rows whoever writes them: the
 * backfill of existing rows equals what the triggers build row by row, the counts equal a recount after
 * saves, new versions, (de)activations and raw SQL, and the facet split equals facetValues
 * (src/lib/catalog/facets.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { allD1Migrations, applyD1Migrations } from './helpers/d1-migrations';
import { facetKeys, facetValues, type Facetable } from '../src/lib/catalog/facets';
import { isBuiltInExampleMaterial } from '../src/lib/catalog-visibility';
import { materials } from '../src/lib/d1/materials';
import { normalizeSearch } from '../src/lib/d1/material-list';
import type { Context } from '../src/lib/d1/database';
import type { D1Bindings, D1DatabaseLike } from '../src/lib/d1/types';
import type { MaterialVersion } from '../src/lib/types';

let mf: Miniflare;
afterAll(async () => mf?.dispose());
beforeAll(() => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response(null, { status: 404 }); } };',
      compatibilityDate: '2026-09-07',
      d1Databases: { A: 'sync-a', B: 'sync-b', C: 'sync-c' },
    }),
  );
});
const database = async (name: string) => (await mf.getD1Database(name)) as unknown as D1DatabaseLike;

// Stored payloads as JSON (reconstruction can be any JSON value in old rows).
const PAYLOADS: (Partial<Omit<MaterialVersion, 'reconstruction'>> & { reconstruction?: unknown })[] = [
  {
    category: 'tile',
    usage: 'both',
    color: '화이트 · 그레이 ·  화이트',
    finish: '무광',
    widthMm: 600,
    heightMm: 1200,
  },
  { category: 'tile', usage: 'wall', color: ' 베이지\t·　블루 ', finish: '', widthMm: 297.5, heightMm: 0 },
  { category: 'tile', color: '', finish: '유광·반광', widthMm: 300, heightMm: 300 },
  {
    category: 'basin',
    usage: 'floor',
    color: '화이트',
    finish: '유광',
    widthMm: 600,
    heightMm: 450,
    depthMm: 400,
  },
  { category: 'toilet', color: '·', finish: ' · ', widthMm: 0, heightMm: 0, depthMm: 0 },
  { category: 'tile', usage: 'floor', reconstruction: { version: 1, kind: 'tile' }, color: '차콜' },
  { category: 'tile', usage: 'floor', reconstruction: null, color: '차콜' },
  { category: 'tile', usage: 'floor', reconstruction: false, color: '차콜' },
  {
    category: 'tile',
    usage: 'both',
    version: 1,
    scope: 'shared',
    brand: '공간미리 예시',
    code: 'EXAMPLE-STONE-02',
    name: '웜 샌드',
    description: '코드로 직접 제작한 테스트용 질감입니다. 실제 판매 상품이 아닙니다.',
  },
];
const payload = (id: string, materialId: string, i: number, version = 1) =>
  JSON.stringify({
    id,
    materialId,
    version,
    name: 'Name ' + i,
    brand: 'BRAND',
    code: 'C-' + i,
    scope: 'shared',
    description: '',
    color: '',
    finish: '',
    widthMm: 100,
    heightMm: 100,
    depthMm: 10,
    installation: 'wall',
    textureAssetIds: [],
    views: [],
    defaultGroutWidth: 2,
    defaultGroutColor: '#ffffff',
    defaultPattern: 'grid',
    createdAt: '2026-10-01',
    ...PAYLOADS[i % PAYLOADS.length],
  });
const mid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const vid = (i: number, n: number) => `00000000-0000-4000-8000-${String(n * 1000 + i).padStart(12, '0')}`;
async function seed(db: D1DatabaseLike) {
  const statements = [];
  for (let i = 0; i < 27; i++) {
    const material = mid(i);
    const versions = i % 4 === 0 ? 2 : 1;
    statements.push(
      db
        .prepare(
          'INSERT INTO d1_materials(id,owner_id,scope,current_version_id,active,created_at,updated_at,purpose) VALUES(?,?,?,?,?,?,?,?)',
        )
        .bind(
          material,
          i % 3 ? 'admin-1' : 'member-1',
          i % 5 === 1 ? 'personal' : 'shared',
          vid(i, versions),
          i % 7 === 3 ? 0 : 1,
          '2026-10-01',
          `2026-10-0${1 + (i % 5)}`,
          i % 6 === 5 ? 'project' : 'catalog',
        ),
    );
    for (let n = 1; n <= versions; n++)
      statements.push(
        db
          .prepare(
            "INSERT INTO d1_material_versions(id,material_id,version,payload_json,category,view_count,created_at) VALUES(?,?,?,?,'tile',0,'2026-10-01')",
          )
          .bind(vid(i, n), material, n, payload(vid(i, n), material, i + n - 1, n)),
      );
  }
  await db.batch(statements);
}
const snapshot = async (db: D1DatabaseLike) => ({
  list: (await db.prepare('SELECT * FROM d1_material_list ORDER BY version_id').all()).results,
  facets: (await db.prepare('SELECT * FROM d1_material_list_facets ORDER BY version_id,facet,value').all())
    .results,
  counts: (
    await db
      .prepare(
        'SELECT * FROM d1_material_list_counts WHERE n<>0 ORDER BY active,lane,category,class,facet,value',
      )
      .all()
  ).results,
});
/** What the counts must be: every current shared material and its facet values, counted again. */
const recount = async (db: D1DatabaseLike) =>
  (
    await db
      .prepare(
        `SELECT * FROM (
          SELECT active,lane,category,class,facet,value,COUNT(*) AS n FROM d1_material_list_facets
          WHERE is_current=1 AND scope='shared' GROUP BY active,lane,category,class,facet,value
          UNION ALL SELECT active,lane,category,class,'','',COUNT(*) FROM d1_material_list
          WHERE is_current=1 AND scope='shared' GROUP BY active,lane,category,class)
         ORDER BY active,lane,category,class,facet,value`,
      )
      .all()
  ).results;

describe('material list summary (0009)', () => {
  it('fills existing rows exactly as the triggers build new ones', async () => {
    const before = await database('A'),
      after = await database('B');
    // Existing data, then the migration (backfill) ...
    await applyD1Migrations(before, allD1Migrations.slice(0, -1));
    await seed(before);
    await applyD1Migrations(before, allD1Migrations.slice(-1));
    // ... and the migration first, then the same data through the triggers.
    await applyD1Migrations(after, allD1Migrations);
    await seed(after);
    const backfilled = await snapshot(before),
      triggered = await snapshot(after);
    expect(backfilled.list.length).toBe(34);
    expect(backfilled).toEqual(triggered);
    expect(backfilled.counts).toEqual(await recount(before));
  }, 120_000);

  it('keeps the summary and counts right through saves, new versions, activation and raw SQL', async () => {
    const db = await database('C');
    await applyD1Migrations(db, allD1Migrations);
    await seed(db);
    const env = { DB: db } as unknown as D1Bindings;
    const ctx: Context = { env, actor: { id: 'admin-1', isAdmin: true } };
    for (const [i, active] of [
      [1, false],
      [3, true],
      [1, true],
      [8, false],
    ] as const)
      await materials(ctx, { operation: 'setActive', id: mid(i), active });
    // A new current version (as materials.ts writes it), then a payload repaired in place.
    await db.batch([
      db
        .prepare("UPDATE d1_materials SET current_version_id=?,updated_at='2026-10-09' WHERE id=?")
        .bind(vid(2, 2), mid(2)),
      db
        .prepare(
          "INSERT INTO d1_material_versions(id,material_id,version,payload_json,category,view_count,created_at) VALUES(?,?,2,?,'tile',0,'2026-10-09')",
        )
        .bind(vid(2, 2), mid(2), payload(vid(2, 2), mid(2), 3, 2)),
    ]);
    await db
      .prepare('UPDATE d1_material_versions SET payload_json=? WHERE id=?')
      .bind(payload(vid(4, 1), mid(4), 5), vid(4, 1))
      .run();
    await db.prepare('UPDATE d1_materials SET current_version_id=? WHERE id=?').bind(vid(0, 1), mid(0)).run();
    expect((await snapshot(db)).counts).toEqual(await recount(db));

    // Every row matches its payload and material, and the facet values are facetValues'.
    const rows = (
      await db
        .prepare(
          `SELECT l.*,v.payload_json,m.owner_id AS m_owner,m.scope AS m_scope,m.active AS m_active,m.updated_at AS m_updated,
            m.current_version_id AS m_current,m.purpose AS m_purpose
           FROM d1_material_list l JOIN d1_material_versions v ON v.id=l.version_id JOIN d1_materials m ON m.id=l.material_id`,
        )
        .all<Record<string, string | number>>()
    ).results;
    expect(rows.length).toBe(35);
    for (const row of rows) {
      const version = JSON.parse(String(row.payload_json)) as MaterialVersion;
      expect(row.owner_id).toBe(row.m_owner);
      expect(row.scope).toBe(row.m_scope);
      expect(row.active).toBe(row.m_active);
      expect(row.updated_at).toBe(row.m_updated);
      expect(row.is_current).toBe(Number(row.m_current === row.version_id));
      const material = { scope: row.m_scope as 'shared' | 'personal' };
      const listed = !isBuiltInExampleMaterial({ material, version });
      expect([0, 1, 2, 3, 4, 5].includes(Number(row.class)), row.version_id + ' listed').toBe(listed);
      expect(Number(row.class) & 1).toBe(Number(row.m_purpose === 'catalog'));
      expect(row.search_picker).toBe(`${version.name} ${version.brand} ${version.code}`.toLowerCase());
      const facets = (
        await db
          .prepare('SELECT facet,value FROM d1_material_list_facets WHERE version_id=?')
          .bind(row.version_id)
          .all<{ facet: string; value: string }>()
      ).results;
      for (const key of facetKeys)
        expect(
          facets
            .filter((facet) => facet.facet === key)
            .map((facet) => facet.value)
            .sort(),
          `${row.version_id} ${key}`,
        ).toEqual([...facetValues(version as unknown as Facetable, key)].sort());
    }
  }, 120_000);

  it('compares search text the way the screens did, except non-ASCII capitals and full-width letters', () => {
    // The stored text is SQL lower() (ASCII only); the query side is each screen's own normalisation.
    expect(normalizeSearch('catalog', '  ＴＯＴＯ ')).toBe('toto');
    expect(normalizeSearch('picker', ' Stone')).toBe(' stone');
    expect(normalizeSearch('library', ' Stone ')).toBe('stone');
  });
});
