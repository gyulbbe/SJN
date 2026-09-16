import { catalogSeed } from './seed';
import { normalizeCatalogName, type CatalogData } from './contract';
const key = 'sjn-local-catalog-v1';
export function localCatalog(): CatalogData {
  try {
    const value = localStorage.getItem(key);
    if (value) return JSON.parse(value);
  } catch {}
  return structuredClone(catalogSeed);
}
export async function loadCatalog(local: boolean, userId?: string): Promise<CatalogData> {
  if (local) return localCatalog();
  const response = await fetch('/api/d1/catalog', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(userId ? { 'X-SJN-User-Id': userId } : {}) },
    body: JSON.stringify({ operation: 'list' }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? '분류를 불러오지 못했어요.');
  return value;
}
export async function saveCatalog(local: boolean, input: Record<string, unknown>, userId?: string) {
  if (local) {
    const data = localCatalog();
    const rows = input.kind === 'subcategory' ? data.subcategories : data.options;
    if (
      rows.some(
        (row) =>
          row.id !== input.id &&
          ('kind' in row ? row.kind === input.kind : row.category === input.category) &&
          normalizeCatalogName(row.name) === normalizeCatalogName(String(input.name)),
      )
    )
      throw new Error('같은 이름의 항목이 이미 있어요.');
    const base = {
      id: input.id ?? crypto.randomUUID(),
      name: String(input.name).trim(),
      sortOrder: input.sortOrder,
      active: input.active,
    };
    const next =
      input.kind === 'subcategory'
        ? { ...base, category: input.category }
        : { ...base, kind: input.kind, colorHex: input.kind === 'color' ? (input.colorHex ?? null) : null };
    const index = rows.findIndex((row) => row.id === next.id);
    if (index >= 0) rows[index] = next as never;
    else rows.push(next as never);
    localStorage.setItem(key, JSON.stringify(data));
    return;
  }
  const response = await fetch('/api/d1/catalog', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(userId ? { 'X-SJN-User-Id': userId } : {}) },
    body: JSON.stringify({ operation: input.id ? 'update' : 'create', input }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '분류를 저장하지 못했어요.');
}
