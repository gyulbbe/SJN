/**
 * The photo-shape trial's first look (no AI call, docs/photo-shape-20261121.md): shape.ts numbers for
 * each fixture of the photo-product results.
 *
 * Usage: node tests/run-browser-test.mjs tests/photo-shape/probe.ts pp-final pp-cur
 * Output: console, test-results/photo-shape-20261121/probe-<set>.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HazeSet } from '../fixture-haze/sources';
import { OUT } from './paths.mjs';
import { shapeRows } from './shape';

const sets = process.argv.slice(2).filter((a) => !a.startsWith('--') && !/[\\/.]/.test(a));
mkdirSync(OUT as string, { recursive: true });
for (const set of sets) {
  const rows = await shapeRows(set as HazeSet);
  for (const r of rows)
    console.log(
      `${r.id.padEnd(26)} #${r.fixture} ${r.kind.padEnd(6)} iou ${r.iou} out ${r.out} miss ${r.miss} shape ${r.shape} aspect ${r.aspect} edge ${r.edge}`,
    );
  writeFileSync(join(OUT as string, `probe-${set}.json`), JSON.stringify(rows, null, 1));
}
