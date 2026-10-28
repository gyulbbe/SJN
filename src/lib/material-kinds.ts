/**
 * 위생도기 kinds (docs/fixture-kinds-results-20261028.md). The built-in kinds are code; an administrator
 * orders and hides them and adds new ones in 분류 관리 (migration 0012, `d1_material_kinds`). A new
 * kind's code ('k-' and ten letters or digits) is stored in a material's `category` and behaves as
 * 기타 everywhere: photo placement only, no subcategory, standard model or AI direction photo, and no
 * word in the AI export prompt. Only its name comes from the kinds list.
 */
import { z } from 'zod';
import { categoryLabels, type CustomKindCode, type MaterialCategory, type MaterialKind } from './types';

export const CUSTOM_KIND = /^k-[a-z0-9]{10}$/;
/** The built-in kinds an administrator manages, in their first order (기타 last). */
export const MANAGED_BUILTINS = [
  'toilet',
  'basin',
  'vanity',
  'bath',
  'shower',
  'faucet',
  'mirror',
  'glassPartition',
  'mirrorCabinet',
  'wallShelf',
  'wallCabinet',
  'lowPartition',
  'other',
] as const satisfies readonly MaterialCategory[];

export const isCustomKind = (code: string): code is CustomKindCode => CUSTOM_KIND.test(code);
export const isBuiltinKind = (code: string): code is MaterialCategory => Object.hasOwn(categoryLabels, code);
/** A managed kind (in the kinds list): a built-in 위생도기 kind or an added one. */
export const isManagedKind = (code: string) =>
  isCustomKind(code) || (MANAGED_BUILTINS as readonly string[]).includes(code);
/** What decides a kind's behaviour: a built-in kind is itself, an added one is 기타. */
export const kindBehavior = (code: MaterialKind): MaterialCategory => (isBuiltinKind(code) ? code : 'other');

/** A stored kind: a built-in code or an added one (writing and reading lists alike). */
export const materialKindSchema = z.union([
  z.enum(Object.keys(categoryLabels) as [MaterialCategory, ...MaterialCategory[]]),
  z.custom<CustomKindCode>((value) => typeof value === 'string' && isCustomKind(value)),
]);

export type MaterialKindRow = {
  code: MaterialKind;
  name: string;
  /** 표시 순서 (0 first), null when none (then by name). 기타 has none and is always last. */
  displayOrder: number | null;
  active: boolean;
  builtin: boolean;
};
/** A kinds list as an answer carries it (the guest drawer checks what it reads). */
export const materialKindRowSchema = z.object({
  code: materialKindSchema,
  name: z.string().min(1).max(100),
  displayOrder: z.number().int().min(0).max(9999).nullable(),
  active: z.boolean(),
  builtin: z.boolean(),
});
/** The kinds list when the table cannot be read (before migration 0012): the built-in ones as they were. */
export const defaultKindRows = (): MaterialKindRow[] =>
  MANAGED_BUILTINS.map((code, index) => ({
    code,
    name: categoryLabels[code],
    displayOrder: code === 'other' ? null : index,
    active: true,
    builtin: true,
  }));
/** 기타 last; then 표시 순서 (none after the numbered ones), then name. */
export function orderKinds(rows: MaterialKindRow[]): MaterialKindRow[] {
  return [...rows].sort(
    (a, b) =>
      Number(a.code === 'other') - Number(b.code === 'other') ||
      Number(a.displayOrder === null) - Number(b.displayOrder === null) ||
      (a.displayOrder ?? 0) - (b.displayOrder ?? 0) ||
      a.name.localeCompare(b.name, 'ko'),
  );
}
/** A kind's name: the kinds list's, then the built-in name, then 기타 (an added kind not known here). */
export function kindLabel(code: MaterialKind, kinds?: readonly MaterialKindRow[]): string {
  return (
    kinds?.find((row) => row.code === code)?.name ??
    (isBuiltinKind(code) ? categoryLabels[code] : categoryLabels.other)
  );
}
/** A new kind's code. */
export function newKindCode(): CustomKindCode {
  const letters = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `k-${Array.from(bytes, (byte) => letters[byte % letters.length]).join('')}`;
}
