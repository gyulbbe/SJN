import { stripLegacyMaterialImages } from '../material-images';
import { normalizeProjectDocument } from '../comparison';
import type {
  AssetRecord,
  ImageAssetRecord,
  ProductMeshAssetRecord,
  MaterialVersion,
  ProjectInput,
} from '../types';
import type { Repositories } from './contracts';
import { StorageConflictError } from './references';
import {
  cacheCloudAsset,
  readCachedCloudAsset,
  invalidateCachedCloudAsset,
} from '../storage/cloud-asset-cache';

export class CloudRequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
async function responseJson<T>(response: Response): Promise<T> {
  const value = await response.json().catch(() => ({ error: '서버 응답을 읽지 못했어요.' }));
  if (!response.ok) {
    if (response.status === 409) throw new StorageConflictError();
    if (response.status === 401 && typeof window !== 'undefined')
      window.dispatchEvent(
        new CustomEvent('sjn-auth-expired', { detail: { accountChanged: value.code === 'ACCOUNT_CHANGED' } }),
      );
    throw new CloudRequestError(response.status, value.error ?? '서버 저장 요청에 실패했어요.');
  }
  return value as T;
}
async function operationKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createCloudRepositories(mode: 'd1' | 'supabase' = 'supabase', userId = ''): Repositories {
  const base = mode === 'd1' ? '/api/d1' : '/api/cloud';
  const namespace = JSON.stringify([typeof location === 'undefined' ? '' : location.origin, mode, userId]);
  const retainedVersions = new Map<string, MaterialVersion>();
  const identityHeaders = userId ? { 'X-SJN-User-Id': userId } : undefined;
  function request(input: string, init: RequestInit = {}) {
    return fetch(input, { ...init, signal: AbortSignal.timeout(30_000) });
  }
  const pendingOperations = new Map<string, string>();
  const lastActiveIntent = new Map<string, string>();
  async function invoke<T>(resource: string, operation: string, values: object = {}): Promise<T> {
    const signature = JSON.stringify([resource, operation, values]);
    if (
      resource === 'materials' &&
      operation === 'setActive' &&
      'id' in values &&
      typeof values.id === 'string'
    ) {
      const previous = lastActiveIntent.get(values.id);
      if (previous && previous !== signature) pendingOperations.delete(previous);
      lastActiveIntent.set(values.id, signature);
    }
    const distinct =
      operation === 'duplicate' ||
      operation === 'remove' ||
      (resource === 'materials' && ['create', 'setActive'].includes(operation));
    const operationId = distinct ? (pendingOperations.get(signature) ?? crypto.randomUUID()) : undefined;
    if (operationId) pendingOperations.set(signature, operationId);
    const body = JSON.stringify({
      operation,
      ...values,
      ...(operationId ? { operationId } : {}),
      ...(operation === 'duplicate' ? { duplicateId: operationId } : {}),
    });
    try {
      const result = await responseJson<T>(
        await request(base + '/' + resource, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            ...identityHeaders,
            'Content-Type': 'application/json',
            'X-Idempotency-Key': await operationKey(namespace + resource + body),
          },
          body,
        }),
      );
      pendingOperations.delete(signature);
      return result;
    } catch (error) {
      if (error instanceof StorageConflictError || (error instanceof CloudRequestError && error.status < 500))
        pendingOperations.delete(signature);
      throw error;
    }
  }
  return {
    mode,
    projects: {
      list: () => invoke('projects', 'list'),
      load: async (id) => normalizeProjectDocument(await invoke<ProjectInput>('projects', 'load', { id })),
      create: (document) => invoke('projects', 'create', { document: normalizeProjectDocument(document) }),
      save: (document, expectedStorageRevision) =>
        invoke('projects', 'save', {
          document: normalizeProjectDocument(document),
          expectedStorageRevision,
        }),
      duplicate: async (id) =>
        normalizeProjectDocument(
          await invoke<ProjectInput>('projects', 'duplicate', {
            id,
          }),
        ),
      remove: (id) => invoke<void>('projects', 'remove', { id }),
    },
    materials: {
      createProjectResource: (input) => invoke<MaterialVersion>('project-materials', 'create', { input: stripLegacyMaterialImages(input) }),
      list: async () => {
        const rows = await invoke<Awaited<ReturnType<Repositories['materials']['list']>>>(
          'materials',
          'list',
        );
        for (const row of rows) retainedVersions.set(row.version.id, row.version);
        return rows;
      },
      getVersion: async (id) => {
        try {
          const version = await invoke<MaterialVersion>('materials', 'getVersion', { id });
          retainedVersions.set(id, version);
          return version;
        } catch (error) {
          if (!(error instanceof CloudRequestError) && retainedVersions.has(id))
            return retainedVersions.get(id)!;
          throw error;
        }
      },
      create: (input) =>
        invoke<MaterialVersion>('materials', 'create', { input: stripLegacyMaterialImages(input) }),
      update: (id, input, expectedVersionId) =>
        invoke('materials', 'update', {
          id,
          input: stripLegacyMaterialImages(input),
          expectedVersionId,
        }),
      setActive: (id, active) => invoke<void>('materials', 'setActive', { id, active }),
    },
    assets: {
      async put(asset) {
        const form = new FormData();
        const { blob, ...metadata } = asset;
        form.set('metadata', JSON.stringify(metadata));
        form.set('file', blob, asset.name);
        await responseJson(
          await request(base + '/assets', {
            method: 'POST',
            credentials: 'same-origin',
            body: form,
            headers: { ...identityHeaders, 'X-Idempotency-Key': asset.id },
          }),
        );
        if (userId) await cacheCloudAsset(namespace, asset);
      },
      async get(id) {
        try {
          const result = await responseJson<{
            asset: Omit<ImageAssetRecord, 'blob'> | Omit<ProductMeshAssetRecord, 'blob'>;
            url: string;
          }>(
            await request(base + '/assets?id=' + encodeURIComponent(id), {
              credentials: 'same-origin',
              cache: 'no-store',
              headers: identityHeaders,
            }),
          );
          const sameOrigin =
            typeof location !== 'undefined' &&
            new URL(result.url, location.origin).origin === location.origin;
          const response = await request(result.url, {
            credentials: 'same-origin',
            headers: sameOrigin ? identityHeaders : undefined,
          });
          if (!response.ok) await responseJson(response);
          const asset = { ...result.asset, blob: await response.blob() } as AssetRecord;
          if (userId) await cacheCloudAsset(namespace, asset);
          return asset;
        } catch (error) {
          const denied = error instanceof CloudRequestError && [400, 401, 403, 404].includes(error.status);
          if (denied) await invalidateCachedCloudAsset(namespace, id);
          if (!denied && userId) {
            const cached = await readCachedCloudAsset(namespace, id);
            if (cached) return cached;
          }
          throw error;
        }
      },
      removeUnused: () => invoke<number>('cleanup', 'run'),
    },
  };
}
