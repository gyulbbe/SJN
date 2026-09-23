import type { MaterialCategory } from '@/lib/types';

export const facetKeys = ['size', 'color', 'finish'] as const;
export type FacetKey = (typeof facetKeys)[number];
export const facetLabels: Record<FacetKey, string> = { size: '사이즈', color: '색상', finish: '표면' };
export type FacetSelection = Record<FacetKey, string[]>;
export type Facetable = {
  category: MaterialCategory;
  widthMm: number;
  heightMm: number;
  depthMm: number;
  color: string;
  finish: string;
};

export const emptyFacets = (): FacetSelection => ({ size: [], color: [], finish: [] });

/** Tiles are sold by face size; products keep every positive dimension. */
function sizeValue(item: Facetable) {
  const values = (
    item.category === 'tile' ? [item.widthMm, item.heightMm] : [item.widthMm, item.heightMm, item.depthMm]
  ).filter((value) => value > 0);
  return values.length ? values.map((value) => value.toLocaleString('ko-KR')).join(' × ') : '';
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

const sizeNumbers = (size: string) => size.split('×').map((part) => Number(part.replace(/[^\d.]/g, '')));
function compareSize(a: string, b: string) {
  const [left, right] = [sizeNumbers(a), sizeNumbers(b)];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

export function facetOptions(items: Facetable[]): FacetSelection {
  const options = emptyFacets();
  for (const key of facetKeys) {
    const values = [...new Set(items.flatMap((item) => facetValues(item, key)))];
    options[key] = values.sort(key === 'size' ? compareSize : (a, b) => a.localeCompare(b, 'ko-KR'));
  }
  return options;
}

/** Drops selections that the current category/tab no longer offers, so they cannot hide every row. */
export function effectiveFacets(selection: FacetSelection, options: FacetSelection): FacetSelection {
  const effective = emptyFacets();
  for (const key of facetKeys) effective[key] = selection[key].filter((value) => options[key].includes(value));
  return effective;
}

export const hasFacets = (selection: FacetSelection) => facetKeys.some((key) => selection[key].length > 0);

/** OR within a group, AND across groups. */
export function matchesFacets(item: Facetable, selection: FacetSelection) {
  return facetKeys.every(
    (key) =>
      !selection[key].length || facetValues(item, key).some((value) => selection[key].includes(value)),
  );
}
