// A snapshot of the public catalog for the catalog-match trial, through the public API only (no login,
// no D1, no writes): every page of GET /api/catalog/placement, then each tile's first texture and each
// product's direction photos from /api/catalog/images?size=list. At most 4 requests at a time, a file
// already on disk is never fetched again, and 3 failures in a row stop the run. Every request is
// appended to requests.jsonl.
//
//   node tests/catalog-match/snapshot.mjs [--sample 20]             production → snapshot/
//   node tests/catalog-match/snapshot.mjs --base http://127.0.0.1:3000 --category basin --out local-basins
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SNAPSHOT } from './paths.mjs';

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
};
const BASE = arg('base', 'https://sjn.gyulbbe.workers.dev');
const CATEGORY = arg('category', '');
const SAMPLE = Number(arg('sample', 0));
const DIR = arg('out', '') ? join(SNAPSHOT, '..', arg('out')) : SNAPSHOT;
const IMAGES = join(DIR, 'images');
const REQUESTS = join(DIR, 'requests.jsonl');
mkdirSync(IMAGES, { recursive: true });

let failuresInRow = 0;
async function get(path) {
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
    failuresInRow = 0;
    return { response, body };
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    if (++failuresInRow >= 3) {
      appendFileSync(REQUESTS, JSON.stringify({ at: new Date().toISOString(), path, status, error }) + '\n');
      console.error('3 failures in a row: stopping.');
      process.exit(1);
    }
    throw e;
  } finally {
    appendFileSync(
      REQUESTS,
      JSON.stringify({ at: new Date().toISOString(), path, status, bytes, ms: Date.now() - started, error }) +
        '\n',
    );
  }
}

// ---------- the placements ----------
const catalogFile = join(DIR, 'catalog.json');
let catalog;
if (existsSync(catalogFile)) {
  catalog = JSON.parse(readFileSync(catalogFile, 'utf8'));
  console.log(`catalog.json already taken ${catalog.takenAt}: ${catalog.placements.length} placements`);
} else {
  const placements = [];
  let cursor = null,
    total;
  do {
    const query = new URLSearchParams({ limit: '48' });
    if (CATEGORY) query.set('category', CATEGORY);
    if (cursor) query.set('cursor', cursor);
    const { body } = await get(`/api/catalog/placement?${query}`);
    const page = JSON.parse(body.toString('utf8'));
    total ??= page.total;
    placements.push(...page.placements);
    cursor = page.nextCursor;
    process.stdout.write(`\rplacements ${placements.length}/${total ?? '?'}`);
  } while (cursor);
  console.log();
  const counts = {};
  for (const placement of placements) counts[placement.category] = (counts[placement.category] ?? 0) + 1;
  catalog = {
    takenAt: new Date().toISOString(),
    base: BASE,
    category: CATEGORY || null,
    total,
    counts,
    placements,
  };
  writeFileSync(catalogFile, JSON.stringify(catalog));
  console.log('counts', counts);
}

// ---------- the images ----------
/** A tile's first texture; a product's direction photos (and its cover when it has no views). */
function wanted(placement) {
  if (placement.category === 'tile') return placement.textureAssetIds.slice(0, 1);
  const views = placement.views.map((view) => view.assetId);
  return views.length ? views : placement.coverAssetId ? [placement.coverAssetId] : [];
}
const have = new Set(readdirSync(IMAGES).map((file) => file.replace(/\.[a-z]+$/, '')));
let queue = catalog.placements.flatMap((placement) => wanted(placement)).filter((id) => !have.has(id));
queue = [...new Set(queue)];
if (SAMPLE) queue = queue.slice(0, SAMPLE);
console.log(`images to fetch: ${queue.length} (already ${have.size})`);
const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const listFlags = join(DIR, 'image-flags.jsonl');
let done = 0;
async function worker() {
  while (queue.length) {
    const id = queue.shift();
    try {
      const { response, body } = await get(`/api/catalog/images?id=${encodeURIComponent(id)}&size=list`);
      const type = (response.headers.get('content-type') ?? '').split(';')[0];
      writeFileSync(join(IMAGES, `${id}.${extension[type] ?? 'bin'}`), body);
      appendFileSync(
        listFlags,
        JSON.stringify({ id, type, bytes: body.length, list: response.headers.get('x-sjn-list-image') }) +
          '\n',
      );
    } catch {
      /* recorded in requests.jsonl */
    }
    if (++done % 50 === 0) process.stdout.write(`\rimages ${done}`);
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);
console.log(`\nimages done: ${done}`);
