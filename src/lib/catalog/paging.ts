import { z } from 'zod';
import { categoryLabels, type MaterialCategory } from '@/lib/types';
import { emptyFacets, facetKeys, type FacetSelection } from './facets';

/** One page of a material list; also the server's largest page (docs/material-paging-results-20261022.md). */
export const PAGE_SIZE = 48;
export const MAX_SEARCH = 100;

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
    category: z
      .enum([...(Object.keys(categoryLabels) as [MaterialCategory, ...MaterialCategory[]]), 'fixtures'])
      .optional(),
    usage: z.enum(['wall', 'floor']).optional(),
    q: z.string().max(MAX_SEARCH).optional(),
    facets: facetSelectionSchema.optional(),
    /** Ask for the facet options of this range (first page only). */
    options: z.boolean().optional(),
    cursor: z.string().max(2048).optional(),
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
};

export type EditorTab = 'wall' | 'floor' | 'fixtures';
export const editorTabQuery = (tab: EditorTab): Pick<MaterialPageQuery, 'category' | 'usage'> =>
  tab === 'fixtures' ? { category: 'fixtures' } : { category: 'tile', usage: tab };

/** The public GET form of a query (empty values left out). */
export function pageSearchParams(query: MaterialPageQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.category) params.set('category', query.category);
  if (query.usage) params.set('usage', query.usage);
  if (query.q) params.set('q', query.q);
  if (query.facets && facetKeys.some((key) => query.facets![key].length))
    params.set('facets', JSON.stringify(query.facets));
  if (query.options) params.set('options', '1');
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.limit) params.set('limit', String(query.limit));
  return params;
}
export function parsePageSearchParams(params: URLSearchParams): MaterialPageQuery {
  const known = ['category', 'usage', 'q', 'facets', 'options', 'cursor', 'limit'];
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
    options: params.get('options') === '1' || undefined,
    cursor: params.get('cursor') || undefined,
    limit: limit === null ? undefined : Number(limit),
  });
}
export const selectedFacets = (query: MaterialPageQuery): FacetSelection => query.facets ?? emptyFacets();
