import { publicLayoutsSchema, type ManagedLayout, type PublicLayouts } from '../fixture-layout-contract';
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
    // A 위생도기 kind is named by its code, the other items by their id.
    body: JSON.stringify({ operation: input.id || input.code ? 'update' : 'create', input }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '분류를 저장하지 못했어요.');
}
/** Deletes a 위생도기 kind an administrator added, while no material has it. */
export async function deleteMaterialKind(code: string, userId?: string) {
  const response = await fetch('/api/d1/catalog', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...(userId ? { 'X-SJN-User-Id': userId } : {}) },
    body: JSON.stringify({ operation: 'delete', input: { code } }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '종류를 지우지 못했어요.');
}

/** The 기본 배치 anyone can place (no account needed). */
export async function loadPublicLayouts(request: typeof fetch = fetch): Promise<PublicLayouts> {
  const response = await request('/api/catalog/layouts', {
    credentials: 'same-origin',
    cache: 'no-store',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error('기본 배치를 불러오지 못했어요. 다시 시도해 주세요.');
  return publicLayoutsSchema.parse(await response.json());
}
async function manageLayouts<T>(operation: string, input: unknown, userId?: string): Promise<T> {
  const response = await fetch('/api/d1/fixture-layouts', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      // One press is one change, however often the request is sent.
      ...(operation === 'list' ? {} : { 'X-Idempotency-Key': crypto.randomUUID() }),
      ...(userId ? { 'X-SJN-User-Id': userId } : {}),
    },
    body: JSON.stringify({ operation, input }),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      response.status === 409
        ? '다른 곳에서 먼저 바뀌었어요. 목록을 다시 열어 확인해 주세요.'
        : (result.error ?? '기본 배치를 저장하지 못했어요.'),
    );
  return result as T;
}
export const loadManagedLayouts = async (userId?: string) =>
  (await manageLayouts<{ layouts: ManagedLayout[] }>('list', undefined, userId)).layouts;
export const createManagedLayout = (
  input: Pick<ManagedLayout, 'name' | 'sortOrder' | 'active' | 'items' | 'room'>,
  userId?: string,
) => manageLayouts('create', input, userId);
export const overwriteManagedLayout = (
  input: Pick<ManagedLayout, 'id' | 'revision' | 'items' | 'room'>,
  userId?: string,
) => manageLayouts('save', input, userId);
export const updateManagedLayout = (
  input: Pick<ManagedLayout, 'id' | 'revision' | 'name' | 'sortOrder' | 'active'>,
  userId?: string,
) => manageLayouts('update', input, userId);
export const removeManagedLayout = (input: Pick<ManagedLayout, 'id' | 'revision'>, userId?: string) =>
  manageLayouts('remove', input, userId);
