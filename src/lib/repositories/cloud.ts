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

async function responseJson<T>(response: Response): Promise<T> {
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 409) throw new StorageConflictError();
    throw new Error(value.error ?? '서버 저장 요청에 실패했어요.');
  }
  return value as T;
}
async function invoke<T>(resource: string, operation: string, values: object = {}): Promise<T> {
  return responseJson<T>(
    await fetch(`/api/cloud/${resource}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ operation, ...values }),
    }),
  );
}
export function createCloudRepositories(): Repositories {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)
    throw new Error('서버 모드 설정이 없어요. Supabase 환경변수를 확인해 주세요.');
  return {
    mode: 'supabase',
    projects: {
      list: () => invoke('projects', 'list'),
      load: async (id) => normalizeProjectDocument(await invoke<ProjectInput>('projects', 'load', { id })),
      create: (document) => invoke('projects', 'create', { document: normalizeProjectDocument(document) }),
      save: (document, expectedStorageRevision) =>
        invoke('projects', 'save', { document: normalizeProjectDocument(document), expectedStorageRevision }),
      duplicate: async (id) =>
        normalizeProjectDocument(await invoke<ProjectInput>('projects', 'duplicate', { id })),
      remove: (id) => invoke<void>('projects', 'remove', { id }),
    },
    materials: {
      list: () => invoke('materials', 'list'),
      getVersion: (id) => invoke('materials', 'getVersion', { id }),
      create: (input) =>
        invoke<MaterialVersion>('materials', 'create', { input: stripLegacyMaterialImages(input) }),
      update: (id, input, expectedVersionId) =>
        invoke('materials', 'update', { id, input: stripLegacyMaterialImages(input), expectedVersionId }),
      setActive: (id, active) => invoke<void>('materials', 'setActive', { id, active }),
    },
    assets: {
      async put(asset) {
        const form = new FormData();
        const { blob, ...metadata } = asset;
        form.set('metadata', JSON.stringify(metadata));
        form.set('file', blob, asset.name);
        await responseJson(
          await fetch('/api/cloud/assets', { method: 'POST', credentials: 'same-origin', body: form }),
        );
      },
      async get(id) {
        const result = await responseJson<{
          asset: Omit<ImageAssetRecord, 'blob'> | Omit<ProductMeshAssetRecord, 'blob'>;
          url: string;
        }>(
          await fetch(`/api/cloud/assets?id=${encodeURIComponent(id)}`, {
            credentials: 'same-origin',
            cache: 'no-store',
          }),
        );
        const response = await fetch(result.url);
        if (!response.ok) throw new Error('이미지를 내려받지 못했어요.');
        return { ...result.asset, blob: await response.blob() } as AssetRecord;
      },
      removeUnused: () => invoke<number>('cleanup', 'run'),
    },
  };
}
