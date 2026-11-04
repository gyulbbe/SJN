// Full-size originals for the direction-photo methods trial, through the public catalogue API only (no
// login, no D1 query of ours, no writes): each toilet's and bath's cover photo and direction photos, at
// full size, as the public catalogue lists them now (catalog-current.json, GET /api/catalog/placement).
// The basins left the public catalogue after the 2026-11-02 snapshot (their covers answer 404), so
// their photos are the 14 the user gave (user-photos/basin). At most 4 requests at a time, a file
// already on disk is never fetched again, 3 failures in a row stop the run, every request is appended
// to originals/requests.jsonl.
//
//   node tests/direction-photo-methods/fetch-originals.mjs [--dry]
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { ORIGINALS, SNAPSHOT } from './paths.mjs';

const BASE = 'https://sjn.gyulbbe.workers.dev';
const DRY = process.argv.includes('--dry');
const REQUESTS = join(ORIGINALS, 'requests.jsonl');
const CATEGORIES = new Set(['basin', 'toilet', 'bath']);
mkdirSync(ORIGINALS, { recursive: true });

const current = join(ORIGINALS, '..', 'catalog-current.json');
const catalog = JSON.parse(
  readFileSync(existsSync(current) ? current : join(SNAPSHOT, 'catalog.json'), 'utf8'),
);
const snapshotFiles = new Map(readdirSync(join(SNAPSHOT, 'images')).map((f) => [f.split('.')[0], f]));
const have = new Set(readdirSync(ORIGINALS).map((f) => f.split('.')[0]));

const wanted = [];
for (const p of catalog.placements) {
  if (!CATEGORIES.has(p.category)) continue;
  if (p.coverAssetId) wanted.push({ id: p.coverAssetId, why: 'cover', name: p.name });
  for (const view of p.views ?? []) {
    const file = snapshotFiles.get(view.assetId);
    const meta = (p.images ?? []).find((image) => image.id === view.assetId);
    if (!file || !meta) {
      wanted.push({ id: view.assetId, why: 'view', name: p.name });
      continue;
    }
    const size = await sharp(join(SNAPSHOT, 'images', file)).metadata();
    if ((size.width ?? 0) < meta.width || (size.height ?? 0) < meta.height)
      wanted.push({
        id: view.assetId,
        why: `list copy ${size.width}x${size.height} < ${meta.width}x${meta.height}`,
        name: p.name,
      });
  }
}
const todo = wanted.filter((w) => !have.has(w.id));
console.log(`${wanted.length} wanted, ${todo.length} to fetch`);
if (DRY) {
  for (const w of todo) console.log(w.why.padEnd(28), w.name);
  process.exit(0);
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif' };
let failuresInRow = 0;
async function fetchOne(w) {
  const path = `/api/catalog/images?id=${encodeURIComponent(w.id)}`;
  const started = Date.now();
  let status = 0,
    bytes = 0,
    error;
  try {
    const response = await fetch(BASE + path);
    status = response.status;
    const body = Buffer.from(await response.arrayBuffer());
    bytes = body.length;
    if (!response.ok) throw new Error(`HTTP ${status}`);
    const type = (response.headers.get('content-type') ?? '').split(';')[0];
    writeFileSync(join(ORIGINALS, `${w.id}.${EXT[type] ?? 'bin'}`), body);
    failuresInRow = 0;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    if (++failuresInRow >= 3) {
      appendFileSync(REQUESTS, JSON.stringify({ at: new Date().toISOString(), path, status, error }) + '\n');
      console.error('3 failures in a row: stopping.');
      process.exit(1);
    }
  } finally {
    appendFileSync(
      REQUESTS,
      JSON.stringify({
        at: new Date().toISOString(),
        path,
        why: w.why,
        status,
        bytes,
        ms: Date.now() - started,
        error,
      }) + '\n',
    );
  }
}

let next = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (next < todo.length) {
      const w = todo[next++];
      await fetchOne(w);
      process.stdout.write(`\r${next}/${todo.length}`);
    }
  }),
);
console.log(`\nfetched into ${ORIGINALS}`);
if (!existsSync(REQUESTS)) console.log('no requests made');
