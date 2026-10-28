/**
 * Paged material lists over the summary of migration 0009 (docs/material-paging-results-20261022.md).
 *
 * Every list reads one index range per part in the list's order (migration 0010: brand priority, newest
 * registered, name either way; docs/material-order-results-20261027.md), and stops at the page: a part
 * is a subquery with its own LIMIT and the parts are merged by a UNION, so the rows read follow the
 * page, not the catalogue. Who sees what is the same as the full lists this replaces; each list's
 * visibility is a set of `class` values (see the migration).
 */
import { readKinds } from '../catalog/server';
import { z } from 'zod';
import {
  emptyFacets,
  facetKeys,
  sortFacetValues,
  type FacetKey,
  type FacetSelection,
} from '../catalog/facets';
import {
  DEFAULT_SORT,
  MAX_CURSOR,
  PAGE_SIZE,
  type MaterialPage,
  type MaterialPageQuery,
  type MaterialSort,
} from '../catalog/paging';
import { invalid } from './http';
import type { D1DatabaseLike } from './types';

/** Which search text a list compares with, as each screen did in the browser. */
export type SearchView = 'catalog' | 'picker' | 'library';
const searchColumn: Record<SearchView, string> = {
  catalog: 'search_catalog',
  picker: 'search_picker',
  library: 'search_library',
};
/**
 * The query side of each screen's old browser filter. The stored text is SQL `lower()` (ASCII only),
 * so text with full-width or non-ASCII capital letters can differ (documented in the results).
 */
export function normalizeSearch(view: SearchView, q = ''): string {
  if (view === 'catalog') return q.normalize('NFKC').trim().toLowerCase();
  if (view === 'library') return q.trim().toLocaleLowerCase('ko-KR');
  return q.toLowerCase();
}

/** `class` values (migration 0009): 1 catalog purpose, 2·4 reconstruction kind, 8 bundled sample. */
export const CLASSES = {
  /** Public `/materials` (shared, active, catalog, no reconstruction key; samples included). */
  public: [1, 9],
  /** The guest drawer: public, without the bundled samples. */
  publicListed: [1],
  /** Member drawer and library: not a sample and no true reconstruction value. */
  listed: [0, 1, 2, 3, 4, 5],
  /** The administrator project's public part as its drawer shows it (reconstruction absent or null). */
  adminListed: [1, 3],
  /** What the administrator project scope may read of the public catalogue (adminVersionVisible). */
  adminPublic: [1, 3, 9, 11],
} as const;

export type Range =
  { kind: 'lanes'; lanes: string[] } | { kind: 'category'; category: string } | { kind: 'all' };
export function rangeOf(query: Pick<MaterialPageQuery, 'category' | 'usage'>): Range {
  if (query.category === 'fixtures') return { kind: 'lanes', lanes: ['fixture'] };
  if (query.category === 'tile' && query.usage) return { kind: 'lanes', lanes: [query.usage, 'both'] };
  if (query.category) return { kind: 'category', category: query.category };
  return { kind: 'all' };
}

type Fragment = { sql: string; values: unknown[] };
const TRUE: Fragment = { sql: '1', values: [] };
const join = (parts: Fragment[], glue = ' AND '): Fragment => ({
  sql: parts.map((part) => part.sql).join(glue),
  values: parts.flatMap((part) => part.values),
});
const classIn = (alias: string, classes: readonly number[]): Fragment => ({
  sql: `${alias}.class IN (${classes.map(Number).join(',')})`,
  values: [],
});
const limitOf = (limit?: number): Fragment =>
  limit === undefined ? { sql: '', values: [] } : { sql: ' LIMIT ?', values: [limit] };

type SortColumn = 'prio' | 'name_key' | 'created_at' | 'material_id';
/**
 * A list order: its key columns (the last one, material_id, settles ties), its direction, and the
 * family of 0010 indexes that read it (`name` backwards for the reverse order). `prio` is the version's
 * brand 표시 순서, 10000 without one (migration 0011).
 */
type Order = { columns: SortColumn[]; desc: boolean; family: 'prio' | 'name' | 'new' };
const ORDERS: Record<MaterialSort, Order> = {
  priority: { columns: ['prio', 'name_key', 'material_id'], desc: false, family: 'prio' },
  newest: { columns: ['created_at', 'material_id'], desc: true, family: 'new' },
  name: { columns: ['name_key', 'material_id'], desc: false, family: 'name' },
  nameDesc: { columns: ['name_key', 'material_id'], desc: true, family: 'name' },
};
const orderBy = (order: Order, alias?: string) =>
  order.columns.map((column) => (alias ? alias + '.' : '') + column + (order.desc ? ' DESC' : '')).join(',');

/** A list's filters after normalisation. */
export type ListFilter = {
  range: Range;
  search: string;
  view: SearchView;
  facets: FacetSelection;
  active: 0 | 1;
  order: Order;
};
type SortValue = string | number;
/** A listed version and its order's key values. */
type Key = { material_id: string; version_id: string } & Partial<Record<SortColumn, SortValue>>;

/**
 * Who a list shows, as parts read through their own index: shared current materials of some classes,
 * one owner's personal ones, or given versions (an administrator project's references).
 */
export type ListPart =
  | { kind: 'shared'; classes: readonly number[] }
  | { kind: 'personal'; owner: string; classes: readonly number[] }
  | { kind: 'ids'; ids: string[]; classes: readonly number[] };
/** Groups are listed one after another (an administrator project's older versions come last). */
export type ListGroup = ListPart[];

// ── Cursors ──────────────────────────────────────────────────────────────────────────────────────
/** `s`: the last item's key values in the list's order. */
type Cursor = { k: string; s: SortValue[]; g: number; d?: FacetKey; e: FacetSelection };
const facetArray = z.array(z.string().max(120)).max(50);
const cursorSchema = z
  .object({
    k: z.string().max(4096),
    s: z
      .array(z.union([z.string().max(1000), z.number().int()]))
      .min(2)
      .max(3),
    g: z.number().int().min(0).max(1),
    d: z.enum(['size', 'color', 'finish']).optional(),
    e: z.object({ size: facetArray, color: facetArray, finish: facetArray }).strict(),
  })
  .strict();
export function encodeCursor(cursor: Cursor): string {
  return btoa(
    Array.from(new TextEncoder().encode(JSON.stringify(cursor)), (c) => String.fromCharCode(c)).join(''),
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
/**
 * A cursor only continues the query it came from: `key` is that query's filters and order (not the page
 * size), and its key values are the order's.
 */
export function decodeCursor(text: string, key: string, order: Order): Cursor {
  if (text.length > MAX_CURSOR || !/^[A-Za-z0-9_-]+$/.test(text)) throw invalid('목록 위치를 확인해 주세요.');
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
      ),
    );
  } catch {
    throw invalid('목록 위치를 확인해 주세요.');
  }
  // A tab opened before the list orders (2026-10-27) continues a newest-updated-first list.
  if (value && typeof value === 'object' && 'u' in value)
    throw invalid('목록 순서가 바뀌었어요. 목록을 처음부터 다시 불러와 주세요.');
  const parsed = cursorSchema.safeParse(value);
  if (!parsed.success) throw invalid('목록 위치를 확인해 주세요.');
  const cursor: Cursor = parsed.data;
  if (cursor.k !== key) throw invalid('조건이 바뀌었어요. 목록을 처음부터 다시 불러와 주세요.');
  if (
    cursor.s.length !== order.columns.length ||
    order.columns.some((column, i) => typeof cursor.s[i] !== (column === 'prio' ? 'number' : 'string'))
  )
    throw invalid('목록 위치를 확인해 주세요.');
  return cursor;
}
async function cursorKey(query: MaterialPageQuery, extra: unknown[]) {
  const text = JSON.stringify([
    query.category ?? '',
    query.usage ?? '',
    query.q ?? '',
    facetKeys.map((key) => [...(query.facets?.[key] ?? [])].sort()),
    query.sort ?? DEFAULT_SORT,
    ...extra,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest).slice(0, 12), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

// ── Conditions ───────────────────────────────────────────────────────────────────────────────────
/** The range condition on rows that are not read through the range's own index. */
function rangeResidual(alias: string, range: Range): Fragment {
  if (range.kind === 'lanes')
    return { sql: `${alias}.lane IN (${range.lanes.map(() => '?').join(',')})`, values: range.lanes };
  if (range.kind === 'category') return { sql: `${alias}.category=?`, values: [range.category] };
  return TRUE;
}
/** Rows after the cursor's item in the list's order (a row value, read through the order's index). */
const keyset = (alias: string, order: Order, after?: Cursor): Fragment =>
  after
    ? {
        sql: `(${order.columns.map((column) => `${alias}.${column}`).join(',')})${order.desc ? '<' : '>'}(${order.columns.map(() => '?').join(',')})`,
        values: after.s,
      }
    : TRUE;
const facetsMatch = (alias: string, facets: FacetSelection, skip?: FacetKey): Fragment =>
  join([
    TRUE,
    ...facetKeys
      .filter((key) => key !== skip && facets[key].length)
      .map((key) => ({
        sql: `EXISTS(SELECT 1 FROM d1_material_list_facets x WHERE x.version_id=${alias}.version_id AND x.facet=? AND x.value IN (SELECT value FROM json_each(?)))`,
        values: [key, JSON.stringify(facets[key])],
      })),
  ]);
const searchMatch = (alias: string, filter: ListFilter): Fragment =>
  filter.search ? { sql: `instr(${alias}.${searchColumn[filter.view]},?)>0`, values: [filter.search] } : TRUE;
const filtered = (filter: ListFilter) =>
  !!filter.search || facetKeys.some((key) => filter.facets[key].length);

// ── Keys ─────────────────────────────────────────────────────────────────────────────────────────
/** The columns a part selects: the order's key and the version (all in the order's index). */
const keyColumns = (order: Order) => [...new Set<string>([...order.columns, 'material_id', 'version_id'])];
const select = (alias: string, from: string, where: Fragment, order: Order, limit?: number): Fragment => {
  const tail = limitOf(limit);
  return {
    sql: `SELECT * FROM (SELECT ${keyColumns(order)
      .map((column) => `${alias}.${column}`)
      .join(',')} FROM ${from} WHERE ${where.sql} ORDER BY ${orderBy(order, alias)}${tail.sql})`,
    values: [...where.values, ...tail.values],
  };
};
/** Shared current materials, one subquery per lane, through the range's index. */
function sharedKeys(
  filter: ListFilter,
  classes: readonly number[],
  after?: Cursor,
  limit?: number,
): Fragment {
  const { range, order } = filter;
  if (range.kind === 'lanes' && filter.active !== 1) throw invalid('지원하지 않는 목록 조건이에요.');
  const rest = join([
    { sql: `l.is_current=1 AND l.scope='shared'`, values: [] },
    classIn('l', classes),
    keyset('l', order, after),
    searchMatch('l', filter),
    facetsMatch('l', filter.facets),
  ]);
  if (range.kind === 'lanes')
    return join(
      range.lanes.map((lane) =>
        select(
          'l',
          `d1_material_list l INDEXED BY d1_list_lane_${order.family}`,
          join([{ sql: 'l.lane=? AND l.active=1', values: [lane] }, rest]),
          order,
          limit,
        ),
      ),
      ' UNION ALL ',
    );
  if (range.kind === 'category')
    return select(
      'l',
      `d1_material_list l INDEXED BY d1_list_category_${order.family}`,
      join([{ sql: 'l.active=? AND l.category=?', values: [filter.active, range.category] }, rest]),
      order,
      limit,
    );
  return select(
    'l',
    `d1_material_list l INDEXED BY d1_list_all_${order.family}`,
    join([{ sql: 'l.active=?', values: [filter.active] }, rest]),
    order,
    limit,
  );
}
/**
 * Shared current materials having a value of facet group `drive`, through the facet index: one
 * subquery per selected value, joined by UNION (a version with two of the values counts once).
 */
function facetKeysOf(
  filter: ListFilter,
  classes: readonly number[],
  drive: FacetKey,
  after?: Cursor,
  limit?: number,
): Fragment {
  const rest = join([
    { sql: `f.is_current=1 AND f.scope='shared'`, values: [] },
    classIn('f', classes),
    rangeResidual('f', filter.range),
    keyset('f', filter.order, after),
    facetsMatch('f', filter.facets, drive),
    filter.search
      ? {
          sql: `EXISTS(SELECT 1 FROM d1_material_list s WHERE s.version_id=f.version_id AND instr(s.${searchColumn[filter.view]},?)>0)`,
          values: [filter.search],
        }
      : TRUE,
  ]);
  return join(
    filter.facets[drive].map((value) =>
      select(
        'f',
        `d1_material_list_facets f INDEXED BY d1_list_facet_${filter.order.family}`,
        join([
          { sql: 'f.active=? AND f.facet=? AND f.value=?', values: [filter.active, drive, value] },
          rest,
        ]),
        filter.order,
        limit,
      ),
    ),
    ' UNION ',
  );
}
/** Conditions every non-shared part checks on its summary rows. */
const rowFilter = (filter: ListFilter, classes: readonly number[], after?: Cursor): Fragment =>
  join([
    { sql: 'l.active=?', values: [filter.active] },
    classIn('l', classes),
    rangeResidual('l', filter.range),
    keyset('l', filter.order, after),
    searchMatch('l', filter),
    facetsMatch('l', filter.facets),
  ]);
function partKeys(
  filter: ListFilter,
  part: ListPart,
  drive: FacetKey | undefined,
  after?: Cursor,
  limit?: number,
) {
  if (part.kind === 'shared')
    return drive
      ? facetKeysOf(filter, part.classes, drive, after, limit)
      : sharedKeys(filter, part.classes, after, limit);
  if (part.kind === 'personal')
    return select(
      'l',
      `d1_material_list l INDEXED BY d1_list_personal_${filter.order.family}`,
      join([
        { sql: `l.owner_id=? AND l.is_current=1 AND l.scope='personal'`, values: [part.owner] },
        rowFilter(filter, part.classes, after),
      ]),
      filter.order,
      limit,
    );
  return select(
    'l',
    'json_each(?) j CROSS JOIN d1_material_list l',
    join([{ sql: 'l.version_id=j.value', values: [] }, rowFilter(filter, part.classes, after)]),
    filter.order,
    limit,
  );
}
/** Keys of a group's matches in the list's order: at most `limit`, or all of them. */
async function groupKeys(
  db: D1DatabaseLike,
  filter: ListFilter,
  group: ListGroup,
  drive: FacetKey | undefined,
  after?: Cursor,
  limit?: number,
): Promise<Key[]> {
  const parts = group.filter((part) => part.kind !== 'ids' || part.ids.length);
  if (!parts.length) return [];
  const pieces = parts.map((part) => {
    const piece = partKeys(filter, part, drive, after, limit);
    // An ids part binds its id list first (json_each in FROM).
    return part.kind === 'ids'
      ? { sql: piece.sql, values: [JSON.stringify(part.ids), ...piece.values] }
      : piece;
  });
  const all = join(pieces, ' UNION ALL ');
  const tail = limitOf(limit);
  const rows = await db
    .prepare(`${all.sql} ORDER BY ${orderBy(filter.order)}${tail.sql}`)
    .bind(...all.values, ...tail.values)
    .all<Key>();
  return rows.results;
}

// ── Options and totals ───────────────────────────────────────────────────────────────────────────
type OptionRow = { facet: FacetKey; value: string; n: number };
async function partOptions(db: D1DatabaseLike, filter: ListFilter, part: ListPart): Promise<OptionRow[]> {
  const range = rangeResidual(part.kind === 'shared' ? 'c' : 'l', filter.range);
  if (part.kind === 'shared') {
    const rows = await db
      .prepare(
        `SELECT c.facet,c.value,SUM(c.n) AS n FROM d1_material_list_counts c WHERE c.active=? AND ${range.sql}
         AND ${classIn('c', part.classes).sql} AND c.facet<>'' AND c.n>0 GROUP BY c.facet,c.value`,
      )
      .bind(filter.active, ...range.values)
      .all<OptionRow>();
    return rows.results;
  }
  if (part.kind === 'ids' && !part.ids.length) return [];
  const from =
    part.kind === 'personal'
      ? `d1_material_list l INDEXED BY d1_list_personal_name`
      : `json_each(?) j CROSS JOIN d1_material_list l`;
  const head: Fragment =
    part.kind === 'personal'
      ? { sql: `l.owner_id=? AND l.is_current=1 AND l.scope='personal'`, values: [part.owner] }
      : { sql: 'l.version_id=j.value', values: [] };
  const rows = await db
    .prepare(
      `SELECT f.facet,f.value,COUNT(*) AS n FROM ${from} CROSS JOIN d1_material_list_facets f
       WHERE ${head.sql} AND l.active=? AND ${classIn('l', part.classes).sql} AND ${range.sql} AND f.version_id=l.version_id
       GROUP BY f.facet,f.value`,
    )
    .bind(
      ...(part.kind === 'ids' ? [JSON.stringify(part.ids)] : []),
      ...head.values,
      filter.active,
      ...range.values,
    )
    .all<OptionRow>();
  return rows.results;
}
async function partTotal(db: D1DatabaseLike, filter: ListFilter, part: ListPart): Promise<number> {
  if (part.kind === 'shared') {
    const range = rangeResidual('c', filter.range);
    const row = await db
      .prepare(
        `SELECT coalesce(SUM(c.n),0) AS n FROM d1_material_list_counts c WHERE c.active=? AND ${range.sql}
         AND ${classIn('c', part.classes).sql} AND c.facet='' AND c.value=''`,
      )
      .bind(filter.active, ...range.values)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }
  if (part.kind === 'ids' && !part.ids.length) return 0;
  const keysOfPart = partKeys(filter, part, undefined);
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM (${keysOfPart.sql})`)
    .bind(...(part.kind === 'ids' ? [JSON.stringify(part.ids)] : []), ...keysOfPart.values)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export type ListedRow = {
  material_id: string;
  version_id: string;
  updated_at: string;
  payload_json: string;
  owner_id: string;
  scope: string;
  active: number;
  version: number;
};
/** The summary and payload of the given versions, in the given order. */
export async function rowsFor(db: D1DatabaseLike, ids: string[]): Promise<ListedRow[]> {
  if (!ids.length) return [];
  const rows = await db
    .prepare(
      `SELECT l.updated_at,l.material_id,l.version_id,l.owner_id,l.scope,l.active,l.version,v.payload_json
       FROM json_each(?) j CROSS JOIN d1_material_list l CROSS JOIN d1_material_versions v
       WHERE l.version_id=j.value AND v.id=j.value`,
    )
    .bind(JSON.stringify(ids))
    .all<ListedRow>();
  const byId = new Map(rows.results.map((row) => [row.version_id, row]));
  return ids.map((id) => byId.get(id)).filter((row): row is ListedRow => !!row);
}

/**
 * One page of a list made of `groups`. On the first page (no cursor) it also counts every match and,
 * when asked (or when facets are selected), lists the facet options of the range. With a search or a
 * facet filter the first page reads every matching key once (that pass is the count); otherwise the
 * count comes from the summary counts and only the page is read.
 */
export async function listPage(
  db: D1DatabaseLike,
  query: MaterialPageQuery,
  view: SearchView,
  groups: ListGroup[],
  options: { active?: boolean; key?: unknown[] } = {},
): Promise<MaterialPage<ListedRow>> {
  const limit = query.limit ?? PAGE_SIZE;
  const order = ORDERS[query.sort ?? DEFAULT_SORT];
  const key = await cursorKey(query, [view, options.active ?? true, ...(options.key ?? [])]);
  const cursor = query.cursor ? decodeCursor(query.cursor, key, order) : undefined;
  const requested = query.facets ?? emptyFacets();
  const filter: ListFilter = {
    range: rangeOf(query),
    search: normalizeSearch(view, query.q),
    view,
    facets: cursor?.e ?? requested,
    active: options.active === false ? 0 : 1,
    order,
  };
  let facets: FacetSelection | undefined;
  let drive = cursor?.d;
  if (!cursor && (query.options || facetKeys.some((name) => requested[name].length))) {
    const rows = (await Promise.all(groups.flat().map((part) => partOptions(db, filter, part)))).flat();
    facets = emptyFacets();
    for (const name of facetKeys)
      facets[name] = sortFacetValues(
        name,
        rows.filter((row) => row.facet === name).map((row) => row.value),
      );
    // A selection the range no longer offers is dropped, as effectiveFacets did in the browser.
    filter.facets = emptyFacets();
    for (const name of facetKeys)
      filter.facets[name] = requested[name].filter((value) => facets![name].includes(value));
    // Drive from the selected group with the fewest shared matches (the facet index serves shared rows).
    const shared = new Map<string, number>();
    for (const row of rows)
      shared.set(
        row.facet + '\u0000' + row.value,
        (shared.get(row.facet + '\u0000' + row.value) ?? 0) + row.n,
      );
    const size = (name: FacetKey) =>
      filter.facets[name].reduce((sum, value) => sum + (shared.get(name + '\u0000' + value) ?? 0), 0);
    drive = facetKeys.filter((name) => filter.facets[name].length).sort((a, b) => size(a) - size(b))[0];
  }
  let total: number | undefined;
  const page: (Key & { g: number })[] = [];
  if (!cursor && filtered(filter)) {
    for (const [g, group] of groups.entries())
      page.push(...(await groupKeys(db, filter, group, drive)).map((row) => ({ ...row, g })));
    total = page.length;
  } else {
    for (let g = cursor?.g ?? 0; g < groups.length && page.length <= limit; g++)
      page.push(
        ...(
          await groupKeys(
            db,
            filter,
            groups[g],
            drive,
            g === cursor?.g ? cursor : undefined,
            limit + 1 - page.length,
          )
        ).map((row) => ({ ...row, g })),
      );
    if (!cursor)
      total = (await Promise.all(groups.flat().map((part) => partTotal(db, filter, part)))).reduce(
        (a, b) => a + b,
        0,
      );
  }
  const shown = page.slice(0, limit);
  const last = shown.at(-1);
  const more = page.length > limit;
  return {
    items: await rowsFor(
      db,
      shown.map((row) => row.version_id),
    ),
    nextCursor:
      more && last
        ? encodeCursor({
            k: key,
            s: order.columns.map((column) => last[column]!),
            g: last.g,
            e: filter.facets,
            ...(drive ? { d: drive } : {}),
          })
        : null,
    ...(total === undefined ? {} : { total }),
    ...(facets && query.options ? { facets } : {}),
    // The kind chips and names ride on the first page a screen asks for anyway (no request of their own).
    ...(!cursor && query.options ? { kinds: await readKinds(db) } : {}),
  };
}

/** The library's tab counts: listed materials of each scope in the shown activity, and the active total. */
export async function libraryCounts(db: D1DatabaseLike, owner: string, active: boolean) {
  const shown = (on: boolean): ListFilter => ({
    range: { kind: 'all' },
    search: '',
    view: 'library',
    facets: emptyFacets(),
    active: on ? 1 : 0,
    order: ORDERS[DEFAULT_SORT],
  });
  const count = (on: boolean) =>
    Promise.all([
      partTotal(db, shown(on), { kind: 'shared', classes: CLASSES.listed }),
      partTotal(db, shown(on), { kind: 'personal', owner, classes: CLASSES.listed }),
    ]);
  const [shared, personal] = await count(active);
  const [activeShared, activePersonal] = active ? [shared, personal] : await count(true);
  return { all: shared + personal, personal, shared, active: activeShared + activePersonal };
}
