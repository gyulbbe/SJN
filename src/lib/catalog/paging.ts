import type { MaterialKindRow } from '@/lib/material-kinds';
import { materialKindSchema } from '@/lib/material-kinds';
import { z } from 'zod';
import type { MaterialKind } from '@/lib/types';
import { emptyFacets, facetKeys, type FacetSelection } from './facets';

/** One page of a material list; also the server's largest page (docs/material-paging-results-20261022.md). */
export const PAGE_SIZE = 48;
export const MAX_SEARCH = 100;
/** A cursor carries the last item's name in a name or priority order (up to 200 characters). */
export const MAX_CURSOR = 4096;

/**
 * List orders (docs/material-order-results-20261027.md). `priority` (the default) shows the materials of
 * the brands an administrator gave a 표시 순서 (분류 관리) first, smallest first, each brand's by name,
 * then the rest by name.
 */
export const materialSorts = ['priority', 'newest', 'name', 'nameDesc'] as const;
export type MaterialSort = (typeof materialSorts)[number];
export const DEFAULT_SORT: MaterialSort = 'priority';
export const sortLabels: Record<MaterialSort, string> = {
  priority: '브랜드 우선순위',
  newest: '최신 등록순',
  name: '이름 오름차순',
  nameDesc: '이름 내림차순',
};
/** The editor's narrow panel. */
export const shortSortLabels: Record<MaterialSort, string> = {
  priority: '브랜드순',
  newest: '최신순',
  name: '이름순',
  nameDesc: '이름 역순',
};

const facetValuesSchema = z.array(z.string().min(1).max(120)).max(50);
export const facetSelectionSchema = z
  .object({ size: facetValuesSchema, color: facetValuesSchema, finish: facetValuesSchema })
  .strict();
/**
 * What a list asks for. `category` is a product kind, or 'fixtures' for every non-tile kind (the
 * editor's 위생도기 tab); `usage` narrows tiles to one editor tab (that usage or 'both').
 */
export const materialPageQuerySchema = z
  .object({
    category: z.union([z.literal('fixtures'), materialKindSchema]).optional(),
    usage: z.enum(['wall', 'floor']).optional(),
    q: z.string().max(MAX_SEARCH).optional(),
    facets: facetSelectionSchema.optional(),
    /** The list order; `priority` when left out. */
    sort: z.enum(materialSorts).optional(),
    /** Ask for the facet options of this range (first page only). */
    options: z.boolean().optional(),
    cursor: z.string().max(MAX_CURSOR).optional(),
    limit: z.number().int().min(1).max(PAGE_SIZE).optional(),
  })
  .strict()
  .refine((query) => !query.usage || query.category === 'tile', '용도는 타일에서만 고를 수 있어요.');
export type MaterialPageQuery = z.infer<typeof materialPageQuerySchema>;

/** Administrator library: which owners, and active or deactivated materials. */
export type LibraryScope = 'all' | 'personal' | 'shared';
export type LibraryCounts = { all: number; personal: number; shared: number; active: number };
export type MaterialPage<T> = {
  items: T[];
  nextCursor: string | null;
  /** First page only: every item matching the query, not just this page. */
  total?: number;
  /** First page only, when asked: the facet options of the query's range (search and facets aside). */
  facets?: FacetSelection;
  counts?: LibraryCounts;
  /** First page only, with the facet options or the library's counts: the 위생도기 kinds (migration 0012). */
  kinds?: MaterialKindRow[];
};

export type EditorTab = 'wall' | 'floor' | 'fixtures';
/** A tab's list; the 위생도기 tab narrows to one kind when its chip is picked. */
export const editorTabQuery = (
  tab: EditorTab,
  kind?: MaterialKind,
): Pick<MaterialPageQuery, 'category' | 'usage'> =>
  tab === 'fixtures' ? { category: kind ?? 'fixtures' } : { category: 'tile', usage: tab };

/** The public GET form of a query (empty values left out). */
export function pageSearchParams(query: MaterialPageQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.category) params.set('category', query.category);
  if (query.usage) params.set('usage', query.usage);
  if (query.q) params.set('q', query.q);
  if (query.facets && facetKeys.some((key) => query.facets![key].length))
    params.set('facets', JSON.stringify(query.facets));
  if (query.sort && query.sort !== DEFAULT_SORT) params.set('sort', query.sort);
  if (query.options) params.set('options', '1');
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.limit) params.set('limit', String(query.limit));
  return params;
}
export function parsePageSearchParams(params: URLSearchParams): MaterialPageQuery {
  const known = ['category', 'usage', 'q', 'facets', 'sort', 'options', 'cursor', 'limit'];
  if ([...params.keys()].some((key) => !known.includes(key) || params.getAll(key).length > 1))
    throw new z.ZodError([{ code: 'custom', path: [], message: 'unknown parameter' }]);
  const facets = params.get('facets');
  if (facets && facets.length > 8 * 1024)
    throw new z.ZodError([{ code: 'custom', path: ['facets'], message: 'too long' }]);
  const limit = params.get('limit');
  return materialPageQuerySchema.parse({
    category: params.get('category') || undefined,
    usage: params.get('usage') || undefined,
    q: params.get('q') ?? undefined,
    facets: facets ? JSON.parse(facets) : undefined,
    sort: params.get('sort') || undefined,
    options: params.get('options') === '1' || undefined,
    cursor: params.get('cursor') || undefined,
    limit: limit === null ? undefined : Number(limit),
  });
}
export const selectedFacets = (query: MaterialPageQuery): FacetSelection => query.facets ?? emptyFacets();
