/**
 * The fixture-shape trial's first look (no AI call, docs/fixture-shape-20261120.md): per result of
 * today's method, each ceramic's cut-out verdict (fixture-outline.ts: used, or the render's outline)
 * and its metal score (fixture-material material-method.ts: chrome-like bands against the render's),
 * with its size on the model's picture.
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-shape/probe.ts glare-final glare-diffsemi … [--only g-black]
 * Output: console, test-results/fixture-shape-20261120/probe-<set>.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { refineCurrentResult } from '../../src/lib/ai-export/current-refine';
import { haze, type HazeSet } from '../fixture-haze/sources';
import { metalScores } from '../fixture-material/material-method';
import { loadInput } from '../fixture-shadows/load';
import { OUT } from './paths.mjs';

const i = process.argv.indexOf('--only');
const only = i > 0 ? process.argv[i + 1].split(',') : undefined;
const sets = process.argv
  .slice(2)
  .filter((a, k, all) => !a.startsWith('--') && all[k - 1] !== '--only' && !/[\/.]/.test(a));
mkdirSync(OUT as string, { recursive: true });
for (const set of sets) {
  const rows: unknown[] = [];
  for (const source of haze(set as HazeSet)) {
    if (only && !only.some((o) => source.id.startsWith(o))) continue;
    const loaded = await loadInput(source);
    if (!loaded) continue;
    const app = refineCurrentResult(loaded.input);
    const verdicts = app.outline?.verdicts ?? [];
    const metal = metalScores(loaded.input, app);
    const { width, height } = loaded.input.layout;
    const fixtures = loaded.input.fixtures
      .map((fixture, index) => ({ fixture, index }))
      .filter(({ fixture }) => fixture.box)
      .map(({ fixture, index }) => {
        const [l, t, r, b] = fixture.box!;
        const verdict = verdicts.find((v) => v.fixture === index);
        const score = metal.find((m) => m.fixture === index);
        return {
          index,
          kind: fixture.kind,
          px: [Math.round((r - l) * width), Math.round((b - t) * height)],
          iou: verdict?.iou,
          used: verdict?.used,
          bands: score?.bands,
          ratio: score?.ratio,
        };
      });
    rows.push({ id: source.id, fixtures });
    console.log(
      source.id.padEnd(34),
      fixtures
        .map(
          (f) =>
            `#${f.index} ${f.kind} ${f.px.join('×')}px ${f.used === undefined ? '-' : f.used ? `used ${f.iou}` : `FALLBACK ${f.iou}`} bands ${f.bands ?? '-'} ×${f.ratio ?? '-'}`,
        )
        .join(' | '),
    );
  }
  writeFileSync(join(OUT as string, `probe-${set}.json`), JSON.stringify(rows, null, 1));
}
