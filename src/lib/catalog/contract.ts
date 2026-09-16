import type { MaterialCategory } from '@/lib/types';
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
  sortOrder: number;
  colorHex: string | null;
};
export type Subcategory = {
  id: string;
  category: MaterialCategory;
  name: string;
  active: boolean;
  sortOrder: number;
};
export type CatalogData = { options: CatalogOption[]; subcategories: Subcategory[] };
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
