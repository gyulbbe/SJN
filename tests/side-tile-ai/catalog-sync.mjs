// The side-tile AI trial's catalogue cache: the public records of the given materials and their list
// images, kept in one folder (catalog.json, images/, requests.jsonl). Nothing is fetched for what the
// cache already holds and is whole:
// - catalog.json must parse and hold a record for every id, with what the scene builder reads (category
//   and its textures or direction photos); ids without one are asked for in ONE request,
//   GET /api/catalog/placement?ids=<only those> (the app's own route, up to a page of ids), never the
//   list pages. An id the answer still lacks stops the run: the cache is not marked done and nothing
//   else is searched.
// - an image must be a whole PNG, JPEG or WebP (ends where its format says); a missing or cut one is
//   fetched once (GET /api/catalog/images?id=…&size=list). A failed image stops the run.
// Every request is appended to requests.jsonl.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** The app's limit for `ids` (src/lib/catalog/paging.ts PAGE_SIZE). */
export const MAX_IDS = 48;
const EXTENSION = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** True when the bytes are a whole PNG, JPEG or WebP for `extension`. */
export function wholeImage(bytes, extension) {
  if (extension === 'png')
    return (
      bytes.length > 20 &&
      bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
      bytes.subarray(bytes.length - 8, bytes.length - 4).toString('latin1') === 'IEND'
    );
  if (extension === 'jpg')
    return (
      bytes.length > 4 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[bytes.length - 2] === 0xff &&
      bytes[bytes.length - 1] === 0xd9
    );
  if (extension === 'webp')
    return (
      bytes.length > 12 &&
      bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
      bytes.subarray(8, 12).toString('latin1') === 'WEBP' &&
      bytes.readUInt32LE(4) + 8 === bytes.length
    );
  return false;
}

/** The asset ids the scene builder reads of a record: a tile's first texture, a product's photos. */
export function wantedImages(placement) {
  if (placement.category === 'tile') return (placement.textureAssetIds ?? []).slice(0, 1);
  const views = (placement.views ?? []).map((view) => view.assetId);
  return views.length ? views : placement.coverAssetId ? [placement.coverAssetId] : [];
}
const usable = (p) =>
  !!p &&
  typeof p.materialId === 'string' &&
  typeof p.category === 'string' &&
  wantedImages(p).length > 0 &&
  wantedImages(p).every((id) => typeof id === 'string' && id.length > 0);

function readCatalog(file) {
  if (!existsSync(file)) return [];
  try {
    const placements = JSON.parse(readFileSync(file, 'utf8')).placements;
    return Array.isArray(placements) ? placements : [];
  } catch {
    return [];
  }
}

/**
 * Brings the cache in `dir` up to date for `ids` from `base`, asking only for what is missing or cut.
 * Returns the number of requests made and the records.
 */
export async function syncCatalog({ base, dir, ids, fetchImpl = fetch }) {
  if (!ids.length || ids.length > MAX_IDS) throw new Error(`1 to ${MAX_IDS} material ids, not ${ids.length}`);
  const images = join(dir, 'images');
  mkdirSync(images, { recursive: true });
  const log = join(dir, 'requests.jsonl');
  let requests = 0;
  async function get(path) {
    const started = Date.now();
    requests++;
    let status = 0,
      bytes = 0,
      error;
    try {
      const response = await fetchImpl(base + path);
      status = response.status;
      const body = Buffer.from(await response.arrayBuffer());
      bytes = body.length;
      if (!response.ok) throw new Error(`HTTP ${status} ${path}`);
      return { response, body };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      appendFileSync(
        log,
        JSON.stringify({
          at: new Date().toISOString(),
          path,
          status,
          bytes,
          ms: Date.now() - started,
          error,
        }) + '\n',
      );
    }
  }

  // ---------- the records ----------
  const file = join(dir, 'catalog.json');
  const cached = readCatalog(file);
  const byId = new Map(cached.filter(usable).map((p) => [p.materialId, p]));
  const missing = [...new Set(ids)].filter((id) => !byId.has(id));
  if (missing.length) {
    const { body } = await get(`/api/catalog/placement?ids=${missing.map(encodeURIComponent).join(',')}`);
    const answer = JSON.parse(body.toString('utf8')).placements ?? [];
    for (const p of answer) if (missing.includes(p.materialId) && usable(p)) byId.set(p.materialId, p);
    const still = missing.filter((id) => !byId.has(id));
    if (still.length) throw new Error(`the catalogue has no usable record for ${still.join(', ')}`);
  }
  const placements = ids.map((id) => byId.get(id));
  if (missing.length || cached.length !== placements.length)
    writeFileSync(file, JSON.stringify({ takenAt: new Date().toISOString(), base, placements }));

  // ---------- the images ----------
  const onDisk = new Map(),
    cut = new Map();
  for (const name of readdirSync(images)) {
    const dot = name.lastIndexOf('.');
    const id = name.slice(0, dot),
      extension = name.slice(dot + 1);
    if (wholeImage(readFileSync(join(images, name)), extension)) onDisk.set(id, name);
    else cut.set(id, [...(cut.get(id) ?? []), name]);
  }
  for (const id of [...new Set(placements.flatMap(wantedImages))]) {
    if (onDisk.has(id)) continue;
    // A cut copy goes only when its whole one is being fetched (the scene reads one file per id).
    for (const name of cut.get(id) ?? []) rmSync(join(images, name));
    const { response, body } = await get(`/api/catalog/images?id=${encodeURIComponent(id)}&size=list`);
    const extension = EXTENSION[(response.headers.get('content-type') ?? '').split(';')[0]];
    if (!extension || !wholeImage(body, extension)) throw new Error(`image ${id}: not a whole png/jpeg/webp`);
    writeFileSync(join(images, `${id}.${extension}`), body);
    onDisk.set(id, `${id}.${extension}`);
  }
  return { requests, placements };
}
