/**
 * Frozen copies of the full material lists and the browser filters that paged lists replaced
 * (docs/material-paging-results-20261022.md). Tests run them on the same D1 as the paged code; the app
 * no longer uses them.
 */
import { adminVisibleVersionsSet } from '../../src/lib/d1/database';
import { displayImages, placementsOf, type PublicMaterial } from '../../src/lib/catalog/public';
import { isBuiltInExampleMaterial } from '../../src/lib/catalog-visibility';
import {
  effectiveFacets,
  facetOptions,
  matchesFacets,
  type FacetSelection,
} from '../../src/lib/catalog/facets';
import { readMaterialViews } from '../../src/lib/product-direction';
import type { D1Bindings, D1DatabaseLike } from '../../src/lib/d1/types';
import type { Material, MaterialCategory, MaterialVersion } from '../../src/lib/types';

export type Entry = { material: Material; version: MaterialVersion };
type Row = {
  id: string;
  owner_id: string;
  scope: 'personal' | 'shared';
  current_version_id: string;
  active: number;
  updated_at: string;
  payload_json: string;
};
const VISIBLE =
  "m.scope='shared' AND m.active=1 AND m.purpose='catalog' AND json_type(v.payload_json,'$.reconstruction') IS NULL";

/** `materials({operation:'list'})` for a member: own or shared materials, current versions. */
export async function legacyMemberList(db: D1DatabaseLike, actor: string): Promise<Entry[]> {
  const rows = await db
    .prepare(
      `SELECT m.*,v.payload_json FROM d1_materials m JOIN d1_material_versions v ON v.id=m.current_version_id WHERE m.owner_id=? OR m.scope='shared' ORDER BY m.updated_at DESC`,
    )
    .bind(actor)
    .all<Row>();
  return rows.results.map((row) => ({
    material: {
      id: row.id,
      ownerId: row.owner_id,
      currentVersionId: row.current_version_id,
      active: !!row.active,
      scope: row.scope,
      updatedAt: row.updated_at,
    },
    version: readMaterialViews(JSON.parse(row.payload_json) as MaterialVersion),
  }));
}
/**
 * The administrator project's full list: every readable version, the material's current one first,
 * one per material. The old SQL left the order of two older versions of one material open; this copy
 * settles it on the higher version (what the paged list keeps).
 */
export async function legacyAdminProjectList(
  db: D1DatabaseLike,
  project: { id: string; ownerId: string; requestId: string },
  actor: string,
): Promise<(Entry & { current: boolean })[]> {
  const visible = adminVisibleVersionsSet(project, actor);
  const rows = await db
    .prepare(
      `${visible.cte} SELECT m.*,v.payload_json,v.version AS vn,(v.id=m.current_version_id) AS is_current FROM d1_materials m JOIN d1_material_versions v ON v.material_id=m.id JOIN visible_versions p ON p.id=v.id ORDER BY (v.id=m.current_version_id) DESC,m.updated_at DESC,vn DESC`,
    )
    .bind(...visible.values)
    .all<Row & { is_current: number }>();
  const result: (Entry & { current: boolean })[] = [];
  for (const row of rows.results) {
    if (result.some((entry) => entry.material.id === row.id)) continue;
    const version = readMaterialViews(JSON.parse(row.payload_json) as MaterialVersion);
    result.push({
      material: {
        id: row.id,
        ownerId: row.owner_id,
        currentVersionId: version.id,
        active: !!row.active,
        scope: row.scope,
        updatedAt: row.updated_at,
      },
      version,
      current: !!row.is_current,
    });
  }
  return result;
}
/** `publicMaterials` before paging (without `catalog`, and without `pricing` as cards now). */
export async function legacyPublicMaterials(
  db: D1DatabaseLike,
): Promise<(PublicMaterial & { updatedAt: string })[]> {
  const rows = await db
    .prepare(
      `SELECT m.id,m.updated_at,v.payload_json FROM d1_materials m JOIN d1_material_versions v ON v.id=m.current_version_id WHERE ${VISIBLE} ORDER BY m.updated_at DESC`,
    )
    .all<{ id: string; updated_at: string; payload_json: string }>();
  const versions = rows.results.map((row) => ({
    id: row.id,
    updatedAt: row.updated_at,
    v: readMaterialViews(JSON.parse(row.payload_json) as MaterialVersion),
  }));
  const ids = [...new Set(versions.flatMap(({ v }) => displayImages(v).map((image) => image.id)))];
  const imageRows = await db
    .prepare(
      `SELECT id FROM d1_assets WHERE deleting=0 AND json_extract(metadata_json,'$.kind') IN ('texture','product','preview') AND id IN(SELECT value FROM json_each(?))`,
    )
    .bind(JSON.stringify(ids))
    .all<{ id: string }>();
  const allowed = new Set(imageRows.results.map((row) => row.id));
  return versions.map(({ id, updatedAt, v }) => ({
    id,
    updatedAt,
    name: v.name,
    brand: v.brand,
    category: v.category,
    subcategoryName: v.subcategoryName ?? '',
    color: v.color,
    composition: v.composition ?? '',
    finish: v.finish,
    description: v.description,
    code: v.code,
    widthMm: v.widthMm,
    heightMm: v.heightMm,
    depthMm: v.depthMm,
    images: displayImages(v)
      .filter((ref) => !ref.retired && allowed.has(ref.id))
      .map((ref) => ({ url: '/api/catalog/images?id=' + encodeURIComponent(ref.id), label: ref.label })),
  }));
}
/** The guest drawer's source: every public placement (`GET /api/catalog/placement` before paging). */
export async function legacyPlacements(env: D1Bindings) {
  const rows = await env.DB.prepare(
    `SELECT m.id,m.updated_at,v.id AS version_id,v.version,v.payload_json FROM d1_materials m
     JOIN d1_material_versions v ON v.id=m.current_version_id WHERE ${VISIBLE} ORDER BY m.updated_at DESC`,
  ).all<{ id: string; updated_at: string; version_id: string; version: number; payload_json: string }>();
  const updated = new Map(rows.results.map((row) => [row.id, row.updated_at]));
  return (await placementsOf(env, rows.results)).map((placement) => ({
    placement,
    updatedAt: updated.get(placement.materialId)!,
  }));
}

/** public-catalog.tsx before paging. */
export function legacyPublicFilter<T extends PublicMaterial>(
  rows: T[],
  options: { category: string; query: string; facets: FacetSelection },
) {
  const scoped = rows.filter((row) => !options.category || row.category === options.category);
  const facets = facetOptions(scoped);
  const active = effectiveFacets(options.facets, facets);
  const matching = scoped.filter(
    (row) =>
      matchesFacets(row, active) &&
      [row.name, row.brand, row.code, row.subcategoryName, row.color, row.composition, row.finish]
        .join(' ')
        .normalize('NFKC')
        .toLowerCase()
        .includes(options.query.normalize('NFKC').trim().toLowerCase()),
  );
  return { matching, facets };
}
/** The editor drawer before paging (its list without the bundled samples, then tab, search, facets). */
export function legacyEditorFilter<T extends Entry>(
  list: T[],
  options: { tab: 'wall' | 'floor' | 'fixtures'; search: string; facets: FacetSelection },
) {
  const catalog = list.filter((row) => !isBuiltInExampleMaterial(row));
  const scopedItems = catalog.filter(
    ({ material, version: v }) =>
      material.active &&
      (options.tab === 'fixtures'
        ? v.category !== 'tile'
        : v.category === 'tile' && (v.usage === 'both' || v.usage === options.tab)),
  );
  const facets = facetOptions(scopedItems.map(({ version }) => version));
  const active = effectiveFacets(options.facets, facets);
  const items = scopedItems.filter(
    ({ version: v }) =>
      `${v.name} ${v.brand} ${v.code}`.toLowerCase().includes(options.search.toLowerCase()) &&
      matchesFacets(v, active),
  );
  return { items, facets };
}
/** material-manager.tsx before paging. */
export function legacyManagerFilter(
  list: Entry[],
  options: {
    inactive: boolean;
    scope: 'all' | 'personal' | 'shared';
    category: 'all' | MaterialCategory;
    search: string;
  },
) {
  const rows = list.filter((row) => !isBuiltInExampleMaterial(row));
  const shown = (row: Entry) => (options.inactive ? !row.material.active : row.material.active);
  const matching = rows.filter(
    (row) =>
      shown(row) &&
      (options.scope === 'all' || row.material.scope === options.scope) &&
      (options.category === 'all' || row.version.category === options.category) &&
      [row.version.name, row.version.brand, row.version.code, row.version.color, row.version.finish]
        .join(' ')
        .toLocaleLowerCase('ko-KR')
        .includes(options.search.trim().toLocaleLowerCase('ko-KR')),
  );
  const count = (scope: 'all' | 'personal' | 'shared') =>
    rows.filter((row) => shown(row) && (scope === 'all' || row.material.scope === scope)).length;
  return {
    matching,
    counts: {
      all: count('all'),
      personal: count('personal'),
      shared: count('shared'),
      active: rows.filter((row) => row.material.active).length,
    },
  };
}
/** Newest first, ties by material id (the paged lists' order; the old SQL left ties open). */
export const byRecency =
  <T>(key: (item: T) => { updatedAt: string; id: string }) =>
  (a: T, b: T) => {
    const x = key(a),
      y = key(b);
    return x.updatedAt === y.updatedAt
      ? x.id < y.id
        ? 1
        : x.id > y.id
          ? -1
          : 0
      : x.updatedAt < y.updatedAt
        ? 1
        : -1;
  };
