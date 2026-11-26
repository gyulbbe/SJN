// Backlog item 9 (a photo product that is not ceramic is sent with its photo's average colour): the
// public catalogue's products that are not tiles (2026-11-21 listing: 10 toilets, 1 shower, 1 bath, in
// test-results/side-tile-ai-20261121/catalog/all-public.json), their records and list images through
// catalog-sync.mjs: one GET /api/catalog/placement?ids=… (no login, no write, never the list pages) and
// one GET per missing list image. What the cache already holds is not asked again.
//   node tests/photo-colour/catalog.mjs [--offline]
// Output: test-results/photo-colour-20261126/catalog/{catalog.json,images/,requests.jsonl}
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../side-tile-ai/paths.mjs';
import { syncCatalog } from '../side-tile-ai/catalog-sync.mjs';
import { TILES } from '../side-tile-ai/needed.mjs';

export const PHOTO_CATALOG = join(ROOT, 'test-results', 'photo-colour-20261126', 'catalog');
const listing = JSON.parse(
  readFileSync(join(ROOT, 'test-results', 'side-tile-ai-20261121', 'catalog', 'all-public.json'), 'utf8'),
);
export const PRODUCT_IDS = listing.filter((x) => x.category !== 'tile').map((x) => x.id ?? x.materialId);

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const offline = process.argv.includes('--offline');
  const { requests, placements } = await syncCatalog({
    base: 'https://sjn.gyulbbe.workers.dev',
    dir: PHOTO_CATALOG,
    // The products, and the side-tile scenes' tiles so the scenes can be drawn from this cache alone.
    ids: [...PRODUCT_IDS, ...Object.values(TILES)],
    fetchImpl: offline
      ? async (url) => {
          throw new Error(`--offline: the cache lacks something (${url})`);
        }
      : fetch,
  });
  console.log(`${placements.length} products, ${requests} requests`);
}
