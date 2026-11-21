/**
 * The glossy-tile trial's pictures (no AI call, docs/glossy-tile-20261121.md): today's app against
 * letting the render's detail lighten a restored face more (current-refine.ts `detailMax`, joints.ts
 * DETAIL_RANGE), so light grout on dark tiles stays light, on the results of today's prompt
 * (registered scenes `glare-final`, `glare-diffsemi`, photo products `pp-final`), with the softer room
 * as the app has it. Registered products only. Pictures go beside the fixture-glare ones as
 * `<id>.gt-<candidate>.png`, for results where a candidate changed something.
 *
 * Usage: node tests/run-browser-test.mjs tests/glossy-tile/pictures.ts [--only g-] [--candidates now,d3,d6]
 * Output: test-results/glossy-tile-20261121/pictures.json (per result, the share of face pixels changed)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pixels } from '../../src/lib/ai-export/color';
import { refineCurrentResult, type RefineTuning } from '../../src/lib/ai-export/current-refine';
import { pixels, png } from '../extra-ai/app-view';
import { haze, type HazeSet } from '../fixture-haze/sources';
import { loadInput } from '../fixture-shadows/load';
import { GLARE, OUT } from './paths.mjs';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const only = arg('--only')?.split(',');
const dir = join(GLARE as string, 'pictures');
const ALL: Record<string, RefineTuning> = {
  // Before 2026-11-21 (DETAIL_MAX 6 since): the render's detail lightens at most 1.5 ×.
  now: { detailMax: 1.5 },
  app: {},
  d2: { detailMax: 2 },
  d3: { detailMax: 3 },
  d6: { detailMax: 6 },
  d12: { detailMax: 12 },
  b4: { detailMax: 1.5, lightnessBand: 4 },
  b0: { detailMax: 1.5, lightnessBand: 0 },
  d6b4: { detailMax: 6, lightnessBand: 4 },
  d6b0: { detailMax: 6, lightnessBand: 0 },
};
const names = (arg('--candidates') ?? 'now,d3,d6').split(',');

const rows: { id: string; candidate: string; changed: number }[] = [];
const done = new Set<string>();
// `glare-olive`: the olive wall said as olive (run-olive.ts), pictures `<id>.gt-ol-<candidate>.png`.
for (const [set, cut, prefix] of [
  ['glare-final', 6, ''],
  ['glare-diffsemi', 9, ''],
  ['pp-final', 6, ''],
  ['glare-olive', 6, 'ol-'],
] as const)
  for (const source of haze(set as HazeSet)) {
    const id = source.id.slice(0, -cut);
    if (done.has(prefix + id)) continue;
    if (only && !only.some((o) => id.startsWith(o))) continue;
    const spec = JSON.parse(readFileSync(join(source.dir, 'spec.json'), 'utf8')) as { products?: unknown[] };
    if (!spec.products?.length) continue;
    const loaded = await loadInput(source);
    if (!loaded) continue;
    done.add(prefix + id);
    const softFile = join(GLARE as string, 'soft-scenes', 'r60', 'behind', source.layers, 'behind.png');
    const soft: Pixels | undefined = existsSync(softFile) ? await pixels(softFile) : undefined;
    const shown: Record<string, Pixels> = {};
    for (const name of names) {
      const app = refineCurrentResult({ ...loaded.input, tuning: ALL[name], ...(soft ? { soft } : {}) });
      shown[name] = app.shown ?? loaded.input.raw;
    }
    const line: string[] = [];
    for (const name of names) {
      const a = shown[name].data,
        b = shown.now.data;
      let changed = 0;
      for (let k = 0; k < a.length; k += 4)
        if (Math.max(Math.abs(a[k] - b[k]), Math.abs(a[k + 1] - b[k + 1]), Math.abs(a[k + 2] - b[k + 2])) > 6)
          changed++;
      const share = changed / (a.length / 4);
      rows.push({ id: prefix + id, candidate: name, changed: share });
      if (name !== 'now') line.push(`${name} ${(share * 100).toFixed(1)}%`);
    }
    if (prefix || rows.some((r) => r.id === id && r.changed > 0.001))
      for (const [name, image] of Object.entries(shown))
        writeFileSync(join(dir, `${id}.gt-${prefix}${name}.png`), await png(image));
    if (prefix) writeFileSync(join(dir, `${id}.gt-${prefix}raw.png`), await png(loaded.input.raw));
    console.log((prefix + id).padEnd(26), line.join('  '));
  }
mkdirSync(OUT as string, { recursive: true });
writeFileSync(join(OUT as string, 'pictures.json'), JSON.stringify(rows, null, 1));
