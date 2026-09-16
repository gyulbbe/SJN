import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { MaterialVersion, ProjectDocument } from '../types';

export type RecoveryScope = {
  origin: string;
  backend: 'd1' | 'supabase';
  userId: string;
  projectId: string;
};
export type ProjectRecovery = {
  key: string;
  schemaVersion: 1;
  scope: RecoveryScope;
  document: ProjectDocument;
  versions: Record<string, MaterialVersion>;
  savedAt: string;
  /** The server revision on which this draft was based, never a forced overwrite token. */
  baseStorageRevision: number;
};
type RecoveryArchive = ProjectRecovery & { archiveId: string; reason: 'conflict' | 'dismissed' };
interface RecoverySchema extends DBSchema {
  drafts: { key: string; value: ProjectRecovery };
  archive: { key: string; value: RecoveryArchive; indexes: { byScope: string } };
}

export function recoveryKey(scope: RecoveryScope) {
  if (!scope.origin || !scope.userId || !scope.projectId || !['d1', 'supabase'].includes(scope.backend))
    throw new Error('복구본에는 로그인한 사용자와 저장소 정보가 필요해요.');
  return JSON.stringify([scope.origin, scope.backend, scope.userId, scope.projectId]);
}

/** Server bookkeeping is excluded; camera/selection and every editable nested field remain included. */
export function projectContentKey(document: ProjectDocument) {
  const copy = { ...document, storageRevision: 0, updatedAt: '' };
  return JSON.stringify(copy, (_key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value))
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    return value;
  });
}

export function inspectRecovery(recovery: ProjectRecovery, server: ProjectDocument) {
  if (recovery.document.id !== server.id || recovery.scope.userId !== server.ownerId)
    throw new Error('다른 사용자 또는 프로젝트의 복구본은 열 수 없어요.');
  if (projectContentKey(recovery.document) === projectContentKey(server)) return 'identical' as const;
  return recovery.baseStorageRevision === server.storageRevision
    ? ('recoverable' as const)
    : ('conflict' as const);
}

/** Separate database: existing local projects/assets are never migrated or cleared. */
export function createRecoveryStore(databaseName = 'gongganmiri-cloud-recovery-v1') {
  let database: Promise<IDBPDatabase<RecoverySchema>> | undefined;
  const db = () =>
    (database ??= openDB<RecoverySchema>(databaseName, 1, {
      upgrade(connection) {
        connection.createObjectStore('drafts', { keyPath: 'key' });
        connection.createObjectStore('archive', { keyPath: 'archiveId' }).createIndex('byScope', 'key');
      },
      blocking() {
        void database?.then((connection) => connection.close());
        database = undefined;
      },
    }));
  return {
    async read(scope: RecoveryScope): Promise<ProjectRecovery | undefined> {
      const key = recoveryKey(scope);
      const record = await (await db()).get('drafts', key);
      if (!record) return;
      if (
        record.schemaVersion !== 1 ||
        record.key !== key ||
        recoveryKey(record.scope) !== key ||
        record.document.id !== scope.projectId ||
        record.document.ownerId !== scope.userId ||
        record.document.schemaVersion !== 3 ||
        !Array.isArray(record.document.designs) ||
        !record.document.shared ||
        !record.document.roomHistory
      )
        throw new Error('복구본의 형식을 확인하지 못했어요. 기존 복구본은 그대로 보관합니다.');
      return record;
    },
    async write(scope: RecoveryScope, document: ProjectDocument, versions: Record<string, MaterialVersion>) {
      if (document.id !== scope.projectId || document.ownerId !== scope.userId)
        throw new Error('현재 계정의 프로젝트만 복구본으로 저장할 수 있어요.');
      // Clone before awaiting IDB; a caller can continue editing immediately.
      const record: ProjectRecovery = structuredClone({
        key: recoveryKey(scope),
        schemaVersion: 1,
        scope,
        document,
        versions,
        baseStorageRevision: document.storageRevision,
        savedAt: new Date().toISOString(),
      });
      const transaction = (await db()).transaction('drafts', 'readwrite');
      void transaction.done.catch(() => {});
      try {
        await transaction.store.put(record);
        await transaction.done;
        return record;
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          /* Already aborted. */
        }
        await transaction.done.catch(() => {});
        throw error;
      }
    },
    /** Do not erase a newer draft when an older cloud save finishes late. */
    async acknowledge(scope: RecoveryScope, sent: ProjectDocument, saved: ProjectDocument) {
      const transaction = (await db()).transaction('drafts', 'readwrite');
      void transaction.done.catch(() => {});
      const key = recoveryKey(scope);
      const current = await transaction.store.get(key);
      if (current && current.baseStorageRevision <= sent.storageRevision) {
        if (projectContentKey(current.document) === projectContentKey(sent))
          await transaction.store.delete(key);
        else {
          current.baseStorageRevision = saved.storageRevision;
          current.document.storageRevision = saved.storageRevision;
          await transaction.store.put(current);
        }
      }
      await transaction.done;
    },
    /** Preserve the old draft before the user resumes the server copy or writes a conflicting draft. */
    async archive(scope: RecoveryScope, reason: RecoveryArchive['reason']) {
      const transaction = (await db()).transaction(['drafts', 'archive'], 'readwrite');
      void transaction.done.catch(() => {});
      const key = recoveryKey(scope);
      const record = await transaction.objectStore('drafts').get(key);
      if (record) {
        await transaction.objectStore('archive').put({ ...record, archiveId: crypto.randomUUID(), reason });
        await transaction.objectStore('drafts').delete(key);
      }
      await transaction.done;
      return record;
    },
    async archives(scope: RecoveryScope) {
      return (await db()).getAllFromIndex('archive', 'byScope', recoveryKey(scope));
    },
    async close() {
      (await database)?.close();
      database = undefined;
    },
  };
}

export const cloudRecovery = createRecoveryStore();

const transitionGuards = new Set<() => Promise<boolean>>();
export function registerStorageTransitionGuard(guard: () => Promise<boolean>) {
  transitionGuards.add(guard);
  return () => {
    transitionGuards.delete(guard);
  };
}
/** AppProvider must await this before changing repository identity or logging out. */
export async function flushBeforeStorageTransition() {
  for (const guard of [...transitionGuards]) if (!(await guard())) return false;
  return true;
}

const accountChangeCheckpoints = new Set<() => Promise<void>>();
export function registerAccountChangeCheckpoint(checkpoint: () => Promise<void>) {
  accountChangeCheckpoints.add(checkpoint);
  return () => {
    accountChangeCheckpoints.delete(checkpoint);
  };
}
/** Security transition: retain the old account locally, never send a save using the new cookie. */
let pendingCheckpoint: Promise<void> | undefined;
export async function checkpointBeforeAccountChange(): Promise<void> {
  if (pendingCheckpoint) return pendingCheckpoint;
  const run = (async () => {
    for (const checkpoint of [...accountChangeCheckpoints]) await checkpoint();
  })();
  pendingCheckpoint = run;
  try {
    await run;
  } finally {
    if (pendingCheckpoint === run) pendingCheckpoint = undefined;
  }
}
