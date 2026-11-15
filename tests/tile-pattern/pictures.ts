/**
 * Step 1 of the tile-pattern trial (no AI call, docs/tile-pattern-trials-20261115.md): each result as
 * the app shows it today (P0: faces under joint score 0.3 restored) and with every tiled face restored
 * (P2), through the app's own functions in the app's order (tests/extra-ai/app-view.ts). Also checks
 * criterion 4 (fixture, glass and backdrop pixels the same in P0 and P2) and criterion 5 (time).
 *
 * Usage: node tests/run-browser-test.mjs tests/tile-pattern/pictures.ts [--holdout]
 * Output: test-results/tile-pattern-20261115/pictures/<id>.{p0,p2}.png and pictures-<set>.json
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_REGION, projectMask } from '../../src/lib/ai-export/color';
import { appView, loadScene, pixels, png } from '../extra-ai/app-view';
import { OUT } from './paths.mjs';
import { sources } from './sources';

const set = process.argv.includes('--holdout') ? 'holdout' : 'dev';
const dir = join(OUT as string, 'pictures');
mkdirSync(dir, { recursive: true });

const rows = [];
for (const source of sources(set)) {
  if (!existsSync(source.result)) continue;
  const scene = await loadScene(source.dir, source.jointsFile);
  const result = await pixels(source.result);
  let started = performance.now();
  // P0 is the rule before 2026-11-15 (the app now restores every face, which is P2).
  const p0 = appView(scene, result, undefined, 0.3);
  const ms0 = performance.now() - started;
  started = performance.now();
  const p2 = appView(scene, result, undefined, Infinity);
  const ms2 = performance.now() - started;
  // Criterion 4: on fixtures and the backdrop (the mask before the model's shift, grown by the
  // shift's reach) P2 changes nothing P0 shows.
  const size = { width: result.width, height: result.height };
  const mask = projectMask(scene.mask, scene.layout, size);
  let changed = 0,
    protectedChanged = 0;
  for (let i = 0; i < size.width * size.height; i++) {
    const d = Math.max(
      Math.abs(p0.shown.data[i * 4] - p2.shown.data[i * 4]),
      Math.abs(p0.shown.data[i * 4 + 1] - p2.shown.data[i * 4 + 1]),
      Math.abs(p0.shown.data[i * 4 + 2] - p2.shown.data[i * 4 + 2]),
    );
    if (d <= 3) continue;
    changed++;
    const label = mask.data[i];
    const x = i % size.width,
      y = Math.floor(i / size.width);
    // Pixels this far inside a fixture or the backdrop cannot be a face moved by the model's shift.
    let deep = label === 0 || label === FIXTURE_REGION;
    for (const [ox, oy] of [
      [-8, 0],
      [8, 0],
      [0, -8],
      [0, 8],
    ]) {
      const xx = Math.max(0, Math.min(size.width - 1, x + ox)),
        yy = Math.max(0, Math.min(size.height - 1, y + oy));
      if (mask.data[yy * size.width + xx] !== label) deep = false;
    }
    if (deep) protectedChanged++;
  }
  writeFileSync(join(dir, `${source.id}.p0.png`), await png(p0.shown));
  writeFileSync(join(dir, `${source.id}.p2.png`), await png(p2.shown));
  const row = {
    id: source.id,
    design: join(source.dir, 'capture.png'),
    aligned: p0.aligned,
    p0: p0.joints,
    p2: p2.joints,
    changedShare: +(changed / (size.width * size.height)).toFixed(4),
    protectedChanged,
    ms: { p0: Math.round(ms0), p2: Math.round(ms2) },
  };
  rows.push(row);
  console.log(
    `${source.id.padEnd(20)} faces p0 ${p0.joints.length} p2 ${p2.joints.length} changed ${(row.changedShare * 100).toFixed(1)}% protected ${protectedChanged} ms ${row.ms.p0}/${row.ms.p2}`,
  );
}
writeFileSync(join(OUT as string, `pictures-${set}.json`), JSON.stringify(rows, null, 1));
