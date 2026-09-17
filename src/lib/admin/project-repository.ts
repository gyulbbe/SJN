import { normalizeProjectDocument } from '../comparison';
import { stripLegacyMaterialImages } from '../material-images';
import type {
  AssetRecord,
  ImageAssetRecord,
  ProductMeshAssetRecord,
  MaterialVersion,
  ProjectInput,
} from '../types';
import type { Repositories } from '../repositories/contracts';
import { CloudRequestError } from '../repositories/cloud';
import { StorageConflictError } from '../repositories/references';
import type { AdminProjectDetail } from './contracts';

async function responseJson<T>(response: Response): Promise<T> {
  const value = await response.json().catch(() => ({ error: '서버 응답을 읽지 못했어요.' }));
  if (!response.ok) {
    if (response.status === 409) throw new StorageConflictError();
    if (response.status === 401 && typeof window !== 'undefined')
      window.dispatchEvent(
        new CustomEvent('sjn-auth-expired', { detail: { accountChanged: value.code === 'ACCOUNT_CHANGED' } }),
      );
    if (response.status === 403 && typeof window !== 'undefined')
      window.dispatchEvent(new Event('sjn-admin-role-changed'));
    throw new CloudRequestError(response.status, value.error ?? '관리자 프로젝트 요청에 실패했어요.');
  }
  return value as T;
}
async function request<T>(url: string, actorUserId: string, init: RequestInit = {}): Promise<T> {
  return responseJson<T>(
    await fetch(url, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
      headers: { ...init.headers, 'X-SJN-User-Id': actorUserId },
    }),
  );
}
export async function loadAdminProject(projectId: string, actorUserId: string): Promise<AdminProjectDetail> {
  const result = await request<AdminProjectDetail>('/api/admin/projects', actorUserId, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation: 'load', id: projectId }),
  });
  return { ...result, document: normalizeProjectDocument(result.document) };
}

/** Per-open-project adapter. Never persists another member's documents/assets or falls back offline. */
export function createAdminProjectRepositories(projectId: string, actorUserId: string): Repositories {
  const reject = async (): Promise<never> => {
    throw new Error('관리자 프로젝트 편집에서는 이 작업을 할 수 없어요.');
  };
  const sameProject = (id: string) => {
    if (id !== projectId) throw new Error('다른 프로젝트의 저장소를 사용할 수 없어요.');
  };
  const pending = new Map<string, string>();
  async function invoke<T>(
    resource: 'projects' | 'project-materials',
    operation: string,
    values: object = {},
  ) {
    const body = { operation, ...(resource === 'projects' ? { id: projectId } : { projectId }), ...values };
    const signature = JSON.stringify([resource, body]);
    const key = pending.get(signature) ?? crypto.randomUUID();
    pending.set(signature, key);
    try {
      const result = await request<T>(`/api/admin/${resource}`, actorUserId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': key },
        body: JSON.stringify(body),
      });
      pending.delete(signature);
      return result;
    } catch (error) {
      if (error instanceof StorageConflictError || (error instanceof CloudRequestError && error.status < 500))
        pending.delete(signature);
      throw error;
    }
  }
  return {
    mode: 'd1',
    projects: {
      list: reject,
      create: reject,
      duplicate: reject,
      remove: reject,
      load: async (id) => {
        sameProject(id);
        return (await loadAdminProject(id, actorUserId)).document;
      },
      save: async (document, expectedStorageRevision) => {
        sameProject(document.id);
        return normalizeProjectDocument(
          await invoke<ProjectInput>('projects', 'save', {
            document: normalizeProjectDocument(document),
            expectedStorageRevision,
          }),
        );
      },
    },
    materials: {
      list: () => invoke('project-materials', 'list'),
      getVersion: (id) => invoke<MaterialVersion>('project-materials', 'getVersion', { id }),
      createProjectResource: (input) =>
        invoke<MaterialVersion>('project-materials', 'create', { input: stripLegacyMaterialImages(input) }),
      create: reject,
      update: reject,
      setActive: reject,
    },
    assets: {
      async put(asset) {
        const { blob, ...metadata } = asset;
        const form = new FormData();
        form.set('metadata', JSON.stringify(metadata));
        form.set('file', blob, asset.name);
        await request(`/api/admin/project-assets?projectId=${encodeURIComponent(projectId)}`, actorUserId, {
          method: 'POST',
          body: form,
        });
      },
      async get(id) {
        const base = `/api/admin/project-assets?projectId=${encodeURIComponent(projectId)}&id=${encodeURIComponent(id)}`;
        const result = await request<{
          asset: Omit<ImageAssetRecord, 'blob'> | Omit<ProductMeshAssetRecord, 'blob'>;
          url: string;
        }>(base, actorUserId);
        if (result.url !== `${base}&raw=1` || result.asset.id !== id)
          throw new Error('프로젝트 자산 응답이 일치하지 않아요.');
        const response = await fetch(result.url, {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: AbortSignal.timeout(30_000),
          headers: { 'X-SJN-User-Id': actorUserId },
        });
        if (!response.ok) await responseJson(response);
        return { ...result.asset, blob: await response.blob() } as AssetRecord;
      },
      // Ordinary owner maintenance handles unreferenced uploads after the grace period.
      removeUnused: async () => 0,
    },
  };
}
