import type { MaterialCategory } from '@/lib/types';
import type { MaterialKindRow } from '@/lib/material-kinds';
export const optionKinds = ['color', 'brand', 'composition', 'finish'] as const;
export type OptionKind = (typeof optionKinds)[number];
export const optionLabels: Record<OptionKind, string> = {
  color: '색상',
  brand: '브랜드',
  composition: '재질',
  finish: '마감',
};
export type CatalogOption = {
  id: string;
  kind: OptionKind;
  name: string;
  active: boolean;
  /** 표시 순서 (0 first), null when none is given: then by name. A brand's also orders the material lists. */
  sortOrder: number | null;
  colorHex: string | null;
};
export type Subcategory = {
  id: string;
  category: MaterialCategory;
  name: string;
  active: boolean;
  sortOrder: number | null;
};
export type CatalogData = {
  options: CatalogOption[];
  subcategories: Subcategory[];
  /** 위생도기 kinds (migration 0012), hidden ones too (`active`); absent from an older answer. */
  kinds?: MaterialKindRow[];
};
export type CatalogSelection = {
  brandId?: string;
  subcategoryId?: string;
  colorIds: string[];
  compositionIds: string[];
  finishIds: string[];
};
export const emptySelection = (): CatalogSelection => ({ colorIds: [], compositionIds: [], finishIds: [] });
export const normalizeCatalogName = (name: string) =>
  name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ko-KR');
