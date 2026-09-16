import type { ReconstructionLabReport } from './lab';
import type { DiagnosticRun } from './lab-diagnostics';

const DATABASE = 'sjn-reconstruction-diagnostics';
export const DIAGNOSTIC_RETENTION = { runs: 20, bytes: 25 * 1024 * 1024 } as const;
export type DiagnosticArchiveEntry = {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  status: DiagnosticRun['status'];
  input: DiagnosticRun['input'];
  engine: string;
  report?: ReconstructionLabReport;
  /** Common project preparation diagnostics; separate from a rendered Lab report. */
  projectAnalysis?: Record<string, unknown>;
  failure?: Record<string, unknown>;
};
type StoredEntry = DiagnosticArchiveEntry & { byteLength: number };
export type DiagnosticStorageStatus = { stored: true } | { stored: false; reason: string };

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('이 환경에서 IndexedDB를 사용할 수 없어요.'));
      return;
    }
    let settled = false;
    const request = indexedDB.open(DATABASE, 1);
    const timer = setTimeout(() => fail(new Error('진단 저장소 연결 시간이 초과됐어요.')), 5000);
    function fail(error: Error | DOMException) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('runs'))
        request.result.createObjectStore('runs', { keyPath: 'runId' });
    };
    request.onerror = () => fail(request.error ?? new Error('진단 저장소를 열지 못했어요.'));
    request.onblocked = () => fail(new Error('다른 탭이 진단 저장소 갱신을 막고 있어요.'));
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

/** Private browser diagnostics only. No project/asset repository and no network upload. */
export async function saveDiagnosticArchive(entry: DiagnosticArchiveEntry): Promise<DiagnosticStorageStatus> {
  let db: IDBDatabase | undefined;
  try {
    const byteLength = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
    if (byteLength > DIAGNOSTIC_RETENTION.bytes)
      throw new Error('단일 진단이 25MB를 넘어 자동 보관하지 못했어요. 현재 전체 보고서를 내려받아 주세요.');
    db = await database();
    const stored: StoredEntry = { ...entry, byteLength };
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction('runs', 'readwrite'),
        store = tx.objectStore('runs');
      store.put(stored);
      const request = store.getAll();
      request.onsuccess = () => {
        const records = (request.result as StoredEntry[]).sort((a, b) =>
          a.startedAt.localeCompare(b.startedAt),
        );
        let bytes = records.reduce((sum, record) => sum + record.byteLength, 0);
        // Keep the newly completed run even if a slower earlier run completed after later runs.
        const removable = records.filter((record) => record.runId !== entry.runId);
        let count = records.length;
        for (const record of removable) {
          if (count <= DIAGNOSTIC_RETENTION.runs && bytes <= DIAGNOSTIC_RETENTION.bytes) break;
          store.delete(record.runId);
          bytes -= record.byteLength;
          count--;
        }
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('진단 저장 트랜잭션이 취소됐어요.'));
      tx.onerror = () => {
        /* onabort is the terminal failure; older records remain intact. */
      };
    });
    return { stored: true };
  } catch (error) {
    return { stored: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }
}

export async function readDiagnosticArchive(): Promise<DiagnosticArchiveEntry[]> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('runs', 'readonly');
      const request = tx.objectStore('runs').getAll();
      tx.oncomplete = () =>
        resolve(
          (request.result as StoredEntry[])
            .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
            .map(({ byteLength: _byteLength, ...record }) => {
              void _byteLength;
              return record;
            }),
        );
      tx.onabort = () => reject(tx.error ?? new Error('저장된 진단을 읽지 못했어요.'));
    });
  } finally {
    db.close();
  }
}
