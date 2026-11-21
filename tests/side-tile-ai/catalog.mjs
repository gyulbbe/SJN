// The side-tile AI trial's catalogue: only the materials of its scenes (specs.ts), read from the public
// catalogue API (GET only, no login, no D1 write): the placement pages until every id is found, then each
// tile's first texture and each product's direction photos at size=list, as tests/catalog-match/snapshot.mjs
// takes them. A file already on disk is not fetched again. Every request goes to requests.jsonl.
//
//   node tests/side-tile-ai/catalog.mjs
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG } from './paths.mjs';
import { NEEDED } from './needed.mjs';

const BASE = 'https://sjn.gyulbbe.workers.dev';
const IMAGES = join(CATALOG, 'images');
const REQUESTS = join(CATALOG, 'requests.jsonl');
mkdirSync(IMAGES, { recursive: true });

async function get(path) {
  const started = Date.now();
  const response = await fetch(BASE + path);
  const body = Buffer.from(await response.arrayBuffer());
  appendFileSync(
    REQUESTS,
    JSON.stringify({
      at: new Date().toISOString(),
      path,
      status: response.status,
      bytes: body.length,
      ms: Date.now() - started,
    }) + '\n',
  );
  if (!response.ok) throw new Error(`HTTP ${response.status} ${path}`);
  return { response, body };
}

const catalogFile = join(CATALOG, 'catalog.json');
const found = [];
if (!existsSync(catalogFile)) {
  let cursor = null,
    pages = 0;
  do {
    const query = new URLSearchParams({ limit: '48' });
    if (cursor) query.set('cursor', cursor);
    const page = JSON.parse((await get(`/api/catalog/placement?${query}`)).body.toString('utf8'));
    pages++;
    for (const p of page.placements)
      if (NEEDED.some((prefix) => p.materialId.startsWith(prefix))) found.push(p);
    cursor = page.nextCursor;
  } while (cursor && found.length < NEEDED.length);
  const missing = NEEDED.filter((prefix) => !found.some((p) => p.materialId.startsWith(prefix)));
  console.log(
    `placement pages ${pages}, found ${found.length}/${NEEDED.length}`,
    missing.length ? `missing ${missing}` : '',
  );
  writeFileSync(
    catalogFile,
    JSON.stringify({ takenAt: new Date().toISOString(), base: BASE, placements: found, missing }),
  );
}
const { placements } = JSON.parse((await import('node:fs')).readFileSync(catalogFile, 'utf8'));
const have = new Set(readdirSync(IMAGES).map((f) => f.replace(/\.[a-z]+$/, '')));
const wanted = placements.flatMap((p) =>
  p.category === 'tile'
    ? p.textureAssetIds.slice(0, 1)
    : p.views.length
      ? p.views.map((v) => v.assetId)
      : p.coverAssetId
        ? [p.coverAssetId]
        : [],
);
const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
for (const id of [...new Set(wanted)].filter((id) => !have.has(id))) {
  const { response, body } = await get(`/api/catalog/images?id=${encodeURIComponent(id)}&size=list`);
  const type = (response.headers.get('content-type') ?? '').split(';')[0];
  writeFileSync(join(IMAGES, `${id}.${extension[type] ?? 'bin'}`), body);
}
console.log(`images: ${readdirSync(IMAGES).length}`);
