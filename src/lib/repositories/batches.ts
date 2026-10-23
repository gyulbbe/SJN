import type { ReconstructionMatch, VersionBatch } from './contracts';
import type { AssetRecord, MaterialVersion } from '../types';

/** The server reads at most this many versions per request. */
export const VERSION_BATCH = 100;
/** `getVersions` for any number of ids: one request per 100 (versions of the same material dedupe). */
export async function versionBatches(
  ids: string[],
  read: (chunk: string[]) => Promise<VersionBatch>,
): Promise<VersionBatch> {
  const unique = [...new Set(ids)];
  const result: VersionBatch = { versions: [], current: [] };
  for (let start = 0; start < unique.length; start += VERSION_BATCH) {
    const batch = await read(unique.slice(start, start + VERSION_BATCH));
    result.versions.push(...batch.versions);
    for (const entry of batch.current)
      if (!result.current.some((item) => item.material.id === entry.material.id)) result.current.push(entry);
  }
  return result;
}

/**
 * One request per asset id while it is on its way: everything that shows the same image as a page
 * opens shares it. A finished read is not kept, so every later read asks the server again (the
 * permission check stays per read).
 */
export function sharedAssetReads(read: (id: string) => Promise<AssetRecord>) {
  const pending = new Map<string, Promise<AssetRecord>>();
  return {
    get(id: string): Promise<AssetRecord> {
      let promise = pending.get(id);
      if (!promise) {
        promise = read(id);
        pending.set(id, promise);
        const settled = promise;
        void settled.then(
          () => pending.get(id) === settled && pending.delete(id),
          () => pending.get(id) === settled && pending.delete(id),
        );
      }
      return promise.then((asset) => ({ ...asset }));
    },
    forget: (id: string) => pending.delete(id),
  };
}

/** The test `find` applies: same code and reconstruction (what the full list's `.find` checked). */
export const matchesReconstruction = (version: MaterialVersion, match: ReconstructionMatch) =>
  version.code === match.code &&
  ('version' in match.reconstruction
    ? version.reconstruction?.version === match.reconstruction.version
    : version.reconstruction?.kind === 'tile');
