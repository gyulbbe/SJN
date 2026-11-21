/**
 * The photo-shape trial's pictures (no AI call, docs/photo-shape-20261121.md): today's app against
 * putting back the basins the model redrew as another shape (current-refine.ts `shapeBelow`), on the
 * results of today's prompt (photo products `pp-final`, registered and glossy scenes `glare-final`,
 * `glare-diffsemi`). With the softer room where the wall-glare trial drew one (as the app has it).
 * Pictures go beside the fixture-glare ones as `<id>.ps-<candidate>.png`; only results where a
 * candidate changed something are written (and `ps-now` for them).
 *
 * Only scenes with registered products (`products` in the scene spec), never the standard models
 * (the reviewer's rule: registered images only).
 *
 * With --reg: the earlier registered-product results (fixture-haze `reg`, `new`, 11-16/17 prompts)
 * instead, as `<id>.psr-<candidate>.png` (some of their ids are also today's results).
 *
 * Usage: node tests/run-browser-test.mjs tests/photo-shape/pictures.ts [--reg] [--only pp-]
 * Output: test-results/photo-shape-20261121/pictures[-reg].json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pixels } from '../../src/lib/ai-export/color';
import { refineCurrentResult, type RefineTuning } from '../../src/lib/ai-export/current-refine';
import { pixels, png } from '../extra-ai/app-view';
import { haze, type HazeSet } from '../fixture-haze/sources';
import { loadInput } from '../fixture-shadows/load';
import { GLARE, OUT } from './paths.mjs';

const i = process.argv.indexOf('--only');
const only = i > 0 ? process.argv[i + 1].split(',') : undefined;
const dir = join(GLARE as string, 'pictures');
const reg = process.argv.includes('--reg');
const tag = (process.argv.includes('--taps') ? 'pt' : 'ps') + (reg ? 'r' : '');

// --taps: the tap trim (T2) instead of putting whole basins back (S2), pictures `<id>.pt[r]-<candidate>.png`.
const tapsTrial = process.argv.includes('--taps');
export const CANDIDATES: { name: string; tuning: RefineTuning }[] = tapsTrial
  ? [
      { name: 'now', tuning: { taps: false } },
      { name: 't8', tuning: { taps: { rise: 0.008, thin: 0.2 } } },
      { name: 't6', tuning: { taps: { rise: 0.006, thin: 0.25 } } },
    ]
  : [
      { name: 'now', tuning: { taps: false } },
      { name: 's92', tuning: { shapeBelow: 0.92, taps: false } },
      { name: 's88', tuning: { shapeBelow: 0.88, taps: false } },
      { name: 's92f', tuning: { shapeBelow: 0.92, shapeFallback: true, taps: false } },
    ];

const rows: { id: string; candidate: string; reshaped: number[] }[] = [];
const sameData = (a: Pixels, b: Pixels) =>
  a.data.length === b.data.length && a.data.every((v, k) => v === b.data[k]);
const done = new Set<string>();
for (const [set, cut] of reg
  ? ([
      ['reg', 0],
      ['new', 0],
    ] as const)
  : ([
      ['pp-final', 6],
      ['glare-final', 6],
      ['glare-diffsemi', 9],
    ] as const))
  for (const source of haze(set as HazeSet)) {
    const id = cut ? source.id.slice(0, -cut) : source.id;
    if (!/^(pp|g|n|r|b|t|x)-/.test(id) || done.has(id)) continue;
    if (only && !only.some((o) => id.startsWith(o))) continue;
    const loaded = await loadInput(source);
    if (!loaded) continue;
    // Registered products only (the standard models' scenes have none).
    const spec = JSON.parse(readFileSync(join(source.dir, 'spec.json'), 'utf8')) as { products?: unknown[] };
    if (!spec.products?.length) continue;
    done.add(id);
    const softFile = join(GLARE as string, 'soft-scenes', 'r60', 'behind', source.layers, 'behind.png');
    const soft: Pixels | undefined = existsSync(softFile) ? await pixels(softFile) : undefined;
    const shown: Record<string, Pixels> = {};
    const line: string[] = [];
    for (const candidate of CANDIDATES) {
      const app = refineCurrentResult({
        ...loaded.input,
        tuning: candidate.tuning,
        ...(soft ? { soft } : {}),
      });
      shown[candidate.name] = app.shown ?? loaded.input.raw;
      // S2: the basins put back; T2: the basins whose pieces were trimmed (T1 and T2).
      const reshaped = tapsTrial
        ? (app.trimmed ?? []).map((t) => t.fixture).filter((k) => loaded.input.fixtures[k]?.kind === 'basin')
        : (app.reshaped ?? []);
      rows.push({ id, candidate: candidate.name, reshaped });
      if (candidate.name !== 'now') line.push(`${candidate.name} [${reshaped.join(',')}]`);
    }
    const changed = tapsTrial
      ? Object.entries(shown).some(([name, image]) => name !== 'now' && !sameData(image, shown.now))
      : rows.some((r) => r.id === id && r.reshaped.length);
    if (changed)
      for (const [name, image] of Object.entries(shown))
        writeFileSync(join(dir, `${id}.${tag}-${name}.png`), await png(image));
    console.log(id.padEnd(26), line.join('  '), changed ? '' : '(no change)');
  }
mkdirSync(OUT as string, { recursive: true });
writeFileSync(join(OUT as string, `pictures-${tag}.json`), JSON.stringify(rows, null, 1));
