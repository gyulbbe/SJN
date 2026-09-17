import { getMaterialImageAssetId, stripLegacyMaterialImages } from '../../src/lib/material-images';
import { decodeProductMesh, PRODUCT_MESH_MIME } from '../../src/lib/product3d/codec';
import { normalizeProjectDocument, projectWriteError } from '../../src/lib/comparison';
import { duplicateProjectDocument } from '../../src/lib/designs';
import {
  assetMetadataSchema,
  identifierSchema,
  materialInputSchema,
  product3dReferenceSchema,
  storedProjectV3Schema,
} from '../../src/lib/storage/validation';
import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import type {
  AssetRecord,
  Material,
  MaterialInput,
  MaterialVersion,
  ProjectDocument,
  ProjectInput,
} from '../../src/lib/types';
import type { ProjectResourceBundle, RepositoryOperations } from '../../src/lib/repositories/contracts';
import {
  materialReferences,
  isDisposableReconstructionVersion,
  projectReferences,
  StorageConflictError,
  StorageNotFoundError,
} from '../../src/lib/repositories/references';
import { materialPricingSchema } from '../../src/lib/quote-validation';
import {
  designPreviewRoomContextKey,
  projectDesignPreviewRoomContext,
} from '../../src/lib/render/design-preview-context';

interface LocalSchema extends DBSchema {
  projects: { key: string; value: ProjectInput };
  materials: { key: string; value: Material };
  versions: { key: string; value: MaterialVersion };
  assets: { key: string; value: AssetRecord };
}
const STORES = ['projects', 'materials', 'versions', 'assets'] as const;
type WriteTransaction = IDBPTransaction<LocalSchema, typeof STORES, 'readwrite'>;
const LOCAL_OWNER = 'local';
const now = () => new Date().toISOString();

async function validateAsset(asset: AssetRecord) {
  if (asset.kind === 'product-mesh') {
    if (asset.mime !== PRODUCT_MESH_MIME || !asset.sourceAssetId)
      throw new Error('입체 데이터 형식과 원본 연결을 확인해 주세요.');
    await decodeProductMesh(asset.blob);
  } else if (
    !asset.blob.size ||
    asset.blob.size > 25 * 1024 * 1024 ||
    !Number.isSafeInteger(asset.width) ||
    !Number.isSafeInteger(asset.height) ||
    asset.width * asset.height > 40_000_000 ||
    asset.width < 1 ||
    asset.height < 1
  )
    throw new Error('이미지는 25MB, 4천만 화소 이하여야 해요.');
}

export type LegacyProjectRepository = RepositoryOperations['projects'] & {
  createWithResources(bundle: ProjectResourceBundle, options?: { signal?: AbortSignal }): Promise<ProjectDocument>;
};
export type LegacyRepositories = RepositoryOperations & { mode: 'local'; projects: LegacyProjectRepository };

/** Test fixture only: preserve historical IndexedDB format coverage without an application adapter. */
export function createLegacyLocalRepositories(databaseName: string): LegacyRepositories {
  let database: Promise<IDBPDatabase<LocalSchema>> | undefined;
  const db = () =>
    (database ??= openDB<LocalSchema>(databaseName, 1, {
      upgrade(database) {
        for (const store of STORES) database.createObjectStore(store, { keyPath: 'id' });
      },
      blocking() {
        void database?.then((connection) => connection.close());
        database = undefined;
      },
    }));
  const write = async <T>(
    callback: (tx: WriteTransaction) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    if (signal?.aborted) throw new DOMException('프로젝트 저장을 취소했어요.', 'AbortError');
    const transaction = (await db()).transaction(STORES, 'readwrite');
    const abort = () => {
      try {
        transaction.abort();
      } catch {
        /* Already committed: preserve the successful save. */
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const value = await callback(transaction);
      await transaction.done;
      if (typeof BroadcastChannel !== 'undefined') {
        const channel = new BroadcastChannel('gongganmiri');
        channel.postMessage({ type: 'saved' });
        channel.close();
      }
      return value;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        /* transaction already aborted */
      }
      await transaction.done.catch(() => {});
      if (signal?.aborted) throw new DOMException('프로젝트 저장을 취소했어요.', 'AbortError');
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  };
  async function checkAssets(tx: WriteTransaction, ids: string[]) {
    for (const id of ids)
      if (!(await tx.objectStore('assets').get(id))) throw new StorageNotFoundError('연결된 이미지');
  }
  async function checkMaterialAssets(tx: WriteTransaction, input: MaterialInput) {
    if (!getMaterialImageAssetId(input)) throw new Error('타일 텍스처 또는 제품 사진을 등록해 주세요.');
    await checkAssets(tx, materialReferences(input));
    const imageIds = [
      input.coverAssetId,
      ...(input.imageAssetIds ?? []),
      ...input.textureAssetIds,
      ...input.views.map((view) => view.assetId),
    ].filter((id): id is string => !!id);
    for (const id of imageIds) {
      const asset = await tx.objectStore('assets').get(id);
      if (asset?.kind === 'product-mesh') throw new Error('제품 사진에는 이미지 자산이 필요해요.');
    }
    for (const view of input.views)
      if (view.product3d) {
        const reference = product3dReferenceSchema.parse(view.product3d);
        const mesh = await tx.objectStore('assets').get(reference.meshAssetId);
        const source = await tx.objectStore('assets').get(reference.inputAssetId);
        if (
          mesh?.kind !== 'product-mesh' ||
          !source ||
          source.kind === 'product-mesh' ||
          mesh.sourceAssetId !== source.id
        )
          throw new Error('입체 데이터와 입체화에 사용한 이미지 연결을 확인해 주세요.');
      }
  }
  async function checkProject(tx: WriteTransaction, document: ProjectDocument, previous?: ProjectInput) {
    storedProjectV3Schema.parse(document);
    const error = projectWriteError(document, previous ? normalizeProjectDocument(previous) : undefined);
    if (error) throw new Error(error);
    const references = projectReferences(document);
    await checkAssets(tx, references.assets);
    for (const id of references.versions)
      if (!(await tx.objectStore('versions').get(id))) throw new StorageNotFoundError('연결된 자재 버전');
  }
  function version(input: MaterialInput, materialId: string, number: number): MaterialVersion {
    if (input.pricing) materialPricingSchema.parse(input.pricing);
    return {
      ...structuredClone(input),
      id: crypto.randomUUID(),
      materialId,
      version: number,
      createdAt: now(),
    };
  }
  const repositories: LegacyRepositories = {
    mode: 'local',
    projects: {
      async list() {
        return Promise.all(
          (await (await db()).getAll('projects'))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .map(async (stored) => {
              const project = normalizeProjectDocument(stored);
              const active = project.designs.find((design) => design.id === project.activeDesignId);
              const contextKey = await designPreviewRoomContextKey(projectDesignPreviewRoomContext(project));
              return {
                id: project.id,
                name: project.name,
                updatedAt: project.updatedAt,
                thumbnailAssetId: project.thumbnailAssetId,
                previewAssetId: (active?.scene ?? project.shared.baseline).previewAssetId,
                activeDesignId: project.activeDesignId,
                activeDesignRevision: active?.renderRevision ?? active?.revision ?? 0,
                sharedRevision: project.shared.revision,
                ...(contextKey ? { designPreviewContextKey: contextKey } : {}),
              };
            }),
        );
      },
      async load(id) {
        const value = await (await db()).get('projects', id);
        if (!value) throw new StorageNotFoundError('프로젝트');
        return normalizeProjectDocument(value);
      },
      async createWithResources(bundle, options = {}) {
        const captured = structuredClone(bundle);
        const value: ProjectDocument = {
          ...structuredClone(normalizeProjectDocument(captured.document)),
          ownerId: LOCAL_OWNER,
          storageRevision: 1,
          updatedAt: now(),
        };
        storedProjectV3Schema.parse(value);
        if (new Blob([JSON.stringify(value)]).size > 20 * 1024 * 1024)
          throw new Error('프로젝트 문서가 너무 커요.');
        const assetIds = new Set<string>();
        const versionIds = new Set<string>();
        const materialGroups = new Map<string, MaterialVersion[]>();
        for (const asset of captured.assets) {
          assetMetadataSchema.parse(asset);
          if (assetIds.has(asset.id)) throw new Error('이미지 묶음에 중복 ID가 있어요.');
          assetIds.add(asset.id);
          await validateAsset(asset);
        }
        for (const version of captured.versions) {
          identifierSchema.parse(version.id);
          identifierSchema.parse(version.materialId);
          materialInputSchema.parse(version);
          if (
            version.scope !== 'personal' ||
            !Number.isSafeInteger(version.version) ||
            version.version < 1 ||
            !Number.isFinite(Date.parse(version.createdAt))
          )
            throw new Error('개인 자재 버전의 형식을 확인해 주세요.');
          if (versionIds.has(version.id)) throw new Error('자재 묶음에 중복 ID가 있어요.');
          versionIds.add(version.id);
          materialGroups.set(version.materialId, [
            ...(materialGroups.get(version.materialId) ?? []),
            version,
          ]);
          if (materialReferences(version).some((id) => !assetIds.has(id)))
            throw new StorageNotFoundError('묶음의 자재 이미지');
        }
        const byAssetId = new Map(captured.assets.map((asset) => [asset.id, asset]));
        for (const asset of captured.assets) {
          const visited = new Set([asset.id]);
          let sourceId = asset.sourceAssetId;
          while (sourceId) {
            if (visited.has(sourceId)) throw new Error('이미지 원본 연결이 순환해요.');
            visited.add(sourceId);
            const source = byAssetId.get(sourceId);
            if (!source) throw new StorageNotFoundError('묶음의 원본 이미지');
            if (source.kind === 'product-mesh') throw new Error('파생 자산의 원본은 이미지여야 해요.');
            sourceId = source.sourceAssetId;
          }
        }
        const references = projectReferences(value);
        if (
          references.assets.some((id) => !assetIds.has(id)) ||
          references.versions.some((id) => !versionIds.has(id))
        )
          throw new StorageNotFoundError('묶음의 프로젝트 자료');
        return write(async (tx) => {
          if (await tx.objectStore('projects').get(value.id)) throw new StorageConflictError();
          for (const asset of captured.assets) {
            if (await tx.objectStore('assets').get(asset.id)) throw new StorageConflictError();
            await tx.objectStore('assets').add({ ...asset, ownerId: LOCAL_OWNER, size: asset.blob.size });
          }
          for (const [materialId, versions] of materialGroups) {
            if (await tx.objectStore('materials').get(materialId)) throw new StorageConflictError();
            const latest = [...versions].sort((a, b) => b.version - a.version)[0];
            if (new Set(versions.map((version) => version.version)).size !== versions.length)
              throw new Error('자재 버전 번호가 중복돼요.');
            for (const version of versions) {
              await checkMaterialAssets(tx, version);
              if (await tx.objectStore('versions').get(version.id)) throw new StorageConflictError();
              await tx.objectStore('versions').add(version);
            }
            await tx.objectStore('materials').add({
              id: materialId,
              ownerId: LOCAL_OWNER,
              currentVersionId: latest.id,
              active: true,
              scope: 'personal',
              updatedAt: now(),
            });
          }
          await checkProject(tx, value);
          await tx.objectStore('projects').add(value);
          return value;
        }, options.signal);
      },
      async create(document) {
        return write(async (tx) => {
          if (await tx.objectStore('projects').get(document.id)) throw new StorageConflictError();
          const value: ProjectDocument = {
            ...structuredClone(normalizeProjectDocument(document)),
            ownerId: LOCAL_OWNER,
            storageRevision: 1,
            updatedAt: now(),
          };
          await checkProject(tx, value);
          await tx.objectStore('projects').add(value);
          return value;
        });
      },
      async save(document, expectedStorageRevision) {
        return write(async (tx) => {
          const existing = await tx.objectStore('projects').get(document.id);
          if (!existing) throw new StorageNotFoundError('프로젝트');
          if (existing.storageRevision !== expectedStorageRevision) throw new StorageConflictError();
          const value = {
            ...structuredClone(normalizeProjectDocument(document)),
            ownerId: LOCAL_OWNER,
            createdAt: existing.createdAt,
            storageRevision: existing.storageRevision + 1,
            updatedAt: now(),
          };
          await checkProject(tx, value, existing);
          await tx.objectStore('projects').put(value);
          return value;
        });
      },
      async duplicate(id) {
        return write(async (tx) => {
          const original = await tx.objectStore('projects').get(id);
          if (!original) throw new StorageNotFoundError('프로젝트');
          const copy = {
            ...duplicateProjectDocument(original),
            ownerId: LOCAL_OWNER,
            storageRevision: 1,
          };
          await checkProject(tx, copy);
          await tx.objectStore('projects').add(copy);
          return copy;
        });
      },
      async remove(id) {
        await write(async (tx) => {
          await tx.objectStore('projects').delete(id);
        });
      },
    },
    materials: {
      async list() {
        const database = await db();
        const tx = database.transaction(['materials', 'versions']);
        const materials = await tx.objectStore('materials').getAll();
        const result: { material: Material; version: MaterialVersion }[] = [];
        for (const material of materials) {
          const version = await tx.objectStore('versions').get(material.currentVersionId);
          if (version) result.push({ material, version });
        }
        await tx.done;
        return result.sort((a, b) => b.material.updatedAt.localeCompare(a.material.updatedAt));
      },
      async getVersion(id) {
        const value = await (await db()).get('versions', id);
        if (!value) throw new StorageNotFoundError('자재 버전');
        return value;
      },
      async create(input) {
        input = stripLegacyMaterialImages(input);
        return write(async (tx) => {
          await checkMaterialAssets(tx, input);
          const id = crypto.randomUUID();
          const value = version(input, id, 1);
          await tx.objectStore('versions').add(value);
          await tx.objectStore('materials').add({
            id,
            ownerId: LOCAL_OWNER,
            currentVersionId: value.id,
            active: true,
            scope: input.scope,
            updatedAt: value.createdAt,
          });
          return value;
        });
      },
      async update(id, input, expectedVersionId) {
        input = stripLegacyMaterialImages(input);
        return write(async (tx) => {
          const material = await tx.objectStore('materials').get(id);
          if (!material) throw new StorageNotFoundError('자재');
          if (material.scope === 'shared')
            throw new Error('공용 예시는 개인 자재로 복제한 뒤 수정해 주세요.');
          if (material.currentVersionId !== expectedVersionId) throw new StorageConflictError();
          const previous = await tx.objectStore('versions').get(expectedVersionId);
          if (!previous) throw new StorageNotFoundError('자재 버전');
          await checkMaterialAssets(tx, input);
          const value = version({ ...input, scope: material.scope }, id, previous.version + 1);
          await tx.objectStore('versions').add(value);
          await tx
            .objectStore('materials')
            .put({ ...material, currentVersionId: value.id, updatedAt: value.createdAt });
          return value;
        });
      },
      async setActive(id, active) {
        await write(async (tx) => {
          const value = await tx.objectStore('materials').get(id);
          if (!value) throw new StorageNotFoundError('자재');
          if (value.scope === 'shared') throw new Error('공용 예시는 비활성화할 수 없어요.');
          await tx.objectStore('materials').put({ ...value, active, updatedAt: now() });
        });
      },
    },
    assets: {
      async put(asset) {
        await validateAsset(asset);
        await write(async (tx) => {
          const existing = await tx.objectStore('assets').get(asset.id);
          if (existing) throw new StorageConflictError();
          if (asset.sourceAssetId) {
            await checkAssets(tx, [asset.sourceAssetId]);
            const source = await tx.objectStore('assets').get(asset.sourceAssetId);
            if (source?.kind === 'product-mesh') throw new Error('파생 자산의 원본은 이미지여야 해요.');
          }
          await tx.objectStore('assets').add({ ...asset, ownerId: LOCAL_OWNER, size: asset.blob.size });
        });
      },
      async get(id) {
        const value = await (await db()).get('assets', id);
        if (!value) throw new StorageNotFoundError('이미지 또는 입체 자료');
        return value;
      },
      async removeUnused() {
        return write(async (tx) => {
          const keep = new Set<string>();
          const liveVersions = new Set<string>();
          const cutoff = Date.now() - 24 * 60 * 60 * 1000;
          for (const project of await tx.objectStore('projects').getAll()) {
            const references = projectReferences(project);
            references.assets.forEach((id) => keep.add(id));
            references.versions.forEach((id) => liveVersions.add(id));
          }
          const versions = await tx.objectStore('versions').getAll();
          const groups = new Map<string, MaterialVersion[]>();
          for (const version of versions)
            groups.set(version.materialId, [...(groups.get(version.materialId) ?? []), version]);
          const removedVersions = new Set<string>();
          for (const material of await tx.objectStore('materials').getAll()) {
            const history = groups.get(material.id) ?? [];
            // Internal generated templates are a bounded cache. An edited/copy material is never swept.
            if (
              material.scope !== 'personal' ||
              material.ownerId !== LOCAL_OWNER ||
              history.length !== 1 ||
              material.currentVersionId !== history[0].id ||
              !isDisposableReconstructionVersion(history[0]) ||
              liveVersions.has(history[0].id) ||
              !(new Date(history[0].createdAt).getTime() < cutoff) ||
              !(new Date(material.updatedAt).getTime() < cutoff)
            )
              continue;
            await tx.objectStore('versions').delete(history[0].id);
            await tx.objectStore('materials').delete(material.id);
            removedVersions.add(history[0].id);
          }
          // Ordinary material versions remain immutable and retained, including inactive products.
          for (const version of versions)
            if (!removedVersions.has(version.id)) for (const id of materialReferences(version)) keep.add(id);
          const assets = await tx.objectStore('assets').getAll();
          const byId = new Map(assets.map((asset) => [asset.id, asset]));
          // A grace period protects staged uploads and edits that have not yet autosaved.
          for (const asset of assets) if (new Date(asset.createdAt).getTime() > cutoff) keep.add(asset.id);
          const visit = (id: string) => {
            const source = byId.get(id)?.sourceAssetId;
            if (source && !keep.has(source)) {
              keep.add(source);
              visit(source);
            }
          };
          for (const id of [...keep]) visit(id);
          let count = 0;
          for (const asset of assets)
            if (!keep.has(asset.id)) {
              await tx.objectStore('assets').delete(asset.id);
              count++;
            }
          return count;
        });
      },
    },
  };
  repositories.materials.createProjectResource = (input) => repositories.materials.create(input);
  return repositories;
}
