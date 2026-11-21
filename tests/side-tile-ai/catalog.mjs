// The side-tile AI trial's catalogue: only the materials of its scenes (needed.mjs, full ids), through
// catalog-sync.mjs: what the cache in test-results/side-tile-ai-20261121/catalog already holds whole is
// not asked again; the rest is one GET /api/catalog/placement?ids=… of the public catalogue (no login, no
// write, never the list pages) and one GET per missing list image.
//
//   node tests/side-tile-ai/catalog.mjs [--base http://127.0.0.1:3000] [--offline]
// --offline fails on any request (to check that the cache is whole without touching the network).
import { CATALOG } from './paths.mjs';
import { NEEDED } from './needed.mjs';
import { syncCatalog } from './catalog-sync.mjs';

const at = process.argv.indexOf('--base');
const base = at > 0 ? process.argv[at + 1] : 'https://sjn.gyulbbe.workers.dev';
const offline = process.argv.includes('--offline');
const { requests, placements } = await syncCatalog({
  base,
  dir: CATALOG,
  ids: NEEDED,
  fetchImpl: offline
    ? async (url) => {
        throw new Error(`--offline: the cache lacks something (${url})`);
      }
    : fetch,
});
console.log(`${placements.length} materials, ${requests} requests`);
