import { normalizeProjectDocument, projectWriteError } from '../comparison';
import { duplicateProjectDocument } from '../designs';
import { storedProjectV3Schema } from '../supabase/validation';
import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import type {
  AssetRecord,
  Material,
  MaterialInput,
  MaterialVersion,
  ProjectDocument,
  ProjectInput,
} from '../types';
import type { Repositories } from './contracts';
import {
  materialReferences,
  isDisposableReconstructionVersion,
  projectReferences,
  StorageConflictError,
  StorageNotFoundError,
} from './references';
import { materialPricingSchema } from '../quote-validation';

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

export function createLocalRepositories(databaseName = 'gongganmiri-v1'): Repositories {
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
  const write = async <T>(callback: (tx: WriteTransaction) => Promise<T>): Promise<T> => {
    const transaction = (await db()).transaction(STORES, 'readwrite');
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
      throw error;
    }
  };
  async function checkAssets(tx: WriteTransaction, ids: string[]) {
    for (const id of ids)
      if (!(await tx.objectStore('assets').get(id))) throw new StorageNotFoundError('연결된 이미지');
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
  return {
    mode: 'local',
    projects: {
      async list() {
        return (await (await db()).getAll('projects'))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map((stored) => {
            const project = normalizeProjectDocument(stored);
            const active = project.designs.find((design) => design.id === project.activeDesignId);
            return {
              id: project.id,
              name: project.name,
              updatedAt: project.updatedAt,
              thumbnailAssetId: project.thumbnailAssetId,
              previewAssetId: (active?.scene ?? project.shared.baseline).previewAssetId,
              activeDesignId: project.activeDesignId,
              activeDesignRevision: active?.renderRevision ?? active?.revision ?? 0,
              sharedRevision: project.shared.revision,
            };
          });
      },
      async load(id) {
        const value = await (await db()).get('projects', id);
        if (!value) throw new StorageNotFoundError('프로젝트');
        return normalizeProjectDocument(value);
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
        return write(async (tx) => {
          await checkAssets(tx, materialReferences(input));
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
        return write(async (tx) => {
          const material = await tx.objectStore('materials').get(id);
          if (!material) throw new StorageNotFoundError('자재');
          if (material.scope === 'shared')
            throw new Error('공용 예시는 개인 자재로 복제한 뒤 수정해 주세요.');
          if (material.currentVersionId !== expectedVersionId) throw new StorageConflictError();
          const previous = await tx.objectStore('versions').get(expectedVersionId);
          if (!previous) throw new StorageNotFoundError('자재 버전');
          await checkAssets(tx, materialReferences(input));
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
        if (
          asset.blob.size > 25 * 1024 * 1024 ||
          asset.width * asset.height > 40_000_000 ||
          asset.width < 1 ||
          asset.height < 1
        )
          throw new Error('이미지는 25MB, 4천만 화소 이하여야 해요.');
        await write(async (tx) => {
          const existing = await tx.objectStore('assets').get(asset.id);
          if (existing) throw new StorageConflictError();
          if (asset.sourceAssetId) await checkAssets(tx, [asset.sourceAssetId]);
          await tx.objectStore('assets').add({ ...asset, ownerId: LOCAL_OWNER, size: asset.blob.size });
        });
      },
      async get(id) {
        const value = await (await db()).get('assets', id);
        if (!value) throw new StorageNotFoundError('이미지');
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
}
