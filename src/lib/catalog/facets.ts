import type { MaterialKind } from '@/lib/types';

export const facetKeys = ['size', 'color', 'finish'] as const;
export type FacetKey = (typeof facetKeys)[number];
export const facetLabels: Record<FacetKey, string> = { size: '사이즈', color: '색상', finish: '표면' };
export type FacetSelection = Record<FacetKey, string[]>;
export type Facetable = {
  category: MaterialKind;
  widthMm: number;
  heightMm: number;
  depthMm: number;
  color: string;
  finish: string;
};

export const emptyFacets = (): FacetSelection => ({ size: [], color: [], finish: [] });

/** Tiles are sold by face size (`600X1200`); products keep every positive dimension. */
function sizeValue(item: Facetable) {
  const values = (
    item.category === 'tile' ? [item.widthMm, item.heightMm] : [item.widthMm, item.heightMm, item.depthMm]
  ).filter((value) => value > 0);
  return values.join('X');
}

export function facetValues(item: Facetable, key: FacetKey): string[] {
  if (key === 'size') {
    const size = sizeValue(item);
    return size ? [size] : [];
  }
  // The material form joins multiple catalog options with ' · '.
  return [
    ...new Set(
      item[key]
        .split('·')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

const sizeNumbers = (size: string) => size.split('X').map(Number);
/**
 * Tile sizes listed first, the ones most tiles are sold in (2026-10-23: 600X600, 600X1200, 600X300 and
 * 300X300 are about 72% of the catalogue). A size and its turned twin are kept apart and both come early.
 */
export const PREFERRED_TILE_SIZES = ['600X1200', '1200X600', '600X600', '600X300', '300X600', '300X300'];
/** The preferred tile sizes in their order, then largest first like a showroom size table: width, then height, then depth. */
function compareSize(a: string, b: string) {
  const [first, second] = [PREFERRED_TILE_SIZES.indexOf(a), PREFERRED_TILE_SIZES.indexOf(b)];
  if (first >= 0 || second >= 0) return (first < 0 ? Infinity : first) - (second < 0 ? Infinity : second);
  const [left, right] = [sizeNumbers(a), sizeNumbers(b)];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (right[i] ?? 0) - (left[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

/** The order a facet group lists its values in (also for values the server collected). */
export const sortFacetValues = (key: FacetKey, values: string[]) =>
  [...new Set(values)].sort(key === 'size' ? compareSize : (a, b) => a.localeCompare(b, 'ko-KR'));

export function facetOptions(items: Facetable[]): FacetSelection {
  const options = emptyFacets();
  for (const key of facetKeys)
    options[key] = sortFacetValues(
      key,
      items.flatMap((item) => facetValues(item, key)),
    );
  return options;
}

/** Drops selections that the current category/tab no longer offers, so they cannot hide every row. */
export function effectiveFacets(selection: FacetSelection, options: FacetSelection): FacetSelection {
  const effective = emptyFacets();
  for (const key of facetKeys)
    effective[key] = selection[key].filter((value) => options[key].includes(value));
  return effective;
}

export const hasFacets = (selection: FacetSelection) => facetKeys.some((key) => selection[key].length > 0);

/** OR within a group, AND across groups. */
export function matchesFacets(item: Facetable, selection: FacetSelection) {
  return facetKeys.every(
    (key) => !selection[key].length || facetValues(item, key).some((value) => selection[key].includes(value)),
  );
}
