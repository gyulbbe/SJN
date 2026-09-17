import type { CatalogData } from './contract';

/** Registered catalog values always come from the authenticated D1 API. */
export async function loadCatalog(userId?: string): Promise<CatalogData> {
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

export async function saveCatalog(input: Record<string, unknown>, userId?: string) {
  const response = await fetch('/api/d1/catalog', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(userId ? { 'X-SJN-User-Id': userId } : {}) },
    body: JSON.stringify({ operation: input.id ? 'update' : 'create', input }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '분류를 저장하지 못했어요.');
}
