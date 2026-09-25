import { analysisCacheAllowed } from './analysis-cache-policy';
import { openDB } from 'idb';
import { segmentRoom, type RoomSegmentation } from '../segmentation';
import type { ModelLoadEvent } from '../ai-progress';
import { LAB_BASELINE_OBSERVATION_REVISION, LAB_BASELINE_MODEL_REVISION } from './lab-engine';

const recent = new Map<string, RoomSegmentation>();
/** Completed full-frame masks are versioned independently of Gemma and MoGe stages. */
export async function segmentReconstructionCached(
  photo: Blob,
  onStage: ((message: string) => void) | undefined,
  signal: AbortSignal,
  onModelProgress?: (event: ModelLoadEvent) => void,
) {
  signal.throwIfAborted();
  if (!analysisCacheAllowed(signal)) {
    const result = await segmentRoom(photo, onStage, { quality: 'reconstruction', signal, onModelProgress });
    signal.throwIfAborted();
    return result;
  }
  const photoHash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', await photo.arrayBuffer())),
    (v) => v.toString(16).padStart(2, '0'),
  ).join('');
  const key = `${LAB_BASELINE_MODEL_REVISION}:${LAB_BASELINE_OBSERVATION_REVISION}:${photoHash}`;
  let value: RoomSegmentation | undefined = recent.get(key);
  const database = () =>
    openDB('sjn-reconstruction-segmentation', 1, {
      upgrade(db) {
        db.createObjectStore('masks');
      },
    });
  if (!value)
    try {
      const db = await database();
      try {
        value = await db.get('masks', key);
      } finally {
        db.close();
      }
    } catch {
      /* Storage is optional. */
    }
  signal.throwIfAborted();
  if (
    value &&
    Number.isInteger(value.width) &&
    Number.isInteger(value.height) &&
    value.width > 0 &&
    value.height > 0 &&
    value.width * value.height <= 1024 * 1024 &&
    value.floor instanceof Uint8Array &&
    value.wall instanceof Uint8Array &&
    value.floor.length === value.width * value.height &&
    value.wall.length === value.floor.length &&
    (!value.objects || Array.isArray(value.objects))
  ) {
    onStage?.('완료된 같은 사진의 벽·바닥 분할을 재사용하고 있어요.');
    return structuredClone(value);
  }
  const result = await segmentRoom(photo, onStage, { quality: 'reconstruction', signal, onModelProgress });
  signal.throwIfAborted();
  recent.set(key, structuredClone(result));
  while (recent.size > 16) recent.delete(recent.keys().next().value!);
  try {
    const db = await database();
    try {
      const tx = db.transaction('masks', 'readwrite');
      await tx.store.put(result, key);
      let excess = (await tx.store.count()) - 16;
      for (let cursor = await tx.store.openCursor(); cursor && excess > 0; cursor = await cursor.continue())
        if (cursor.key !== key) {
          await cursor.delete();
          excess--;
        }
      await tx.done;
    } finally {
      db.close();
    }
  } catch {
    onStage?.('분할 결과는 유지했지만 캐시 저장 공간이 부족해요.');
  }
  signal.throwIfAborted();
  return result;
}
