/**
 * Step 1 of the fixture-colour trial (no AI call, docs/fixture-colour-20261115.md): each earlier AI
 * result as the app shows it now (P0: backdrop, joints on every tiled face, wall and floor colours)
 * and with W1 on top (w1.ts: the white ceramics' lightness back). Also checks that nothing outside the
 * ceramic fixtures changes.
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-colour/pictures.ts [--holdout]
 * Output: test-results/fixture-colour-20261115/pictures/<id>.{p0,w1}.png and pictures-<set>.json
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { framing, projectCapture } from '../../src/lib/ai-export/color';
import { appView, loadScene, pixels, png } from '../extra-ai/app-view';
import { sources } from '../tile-pattern/sources';
import { OUT } from './paths.mjs';
import { restoreFixtureLightness } from './w1';

const set = process.argv.includes('--holdout') ? 'holdout' : 'dev';
const dir = join(OUT as string, 'pictures');
mkdirSync(dir, { recursive: true });
const rows = [];
for (const source of sources(set)) {
  if (!existsSync(source.result)) continue;
  const scene = await loadScene(source.dir, source.jointsFile);
  const result = await pixels(source.result);
  const view = appView(scene, result);
  if (!view.aligned) {
    rows.push({ id: source.id, aligned: false });
    console.log(`${source.id} not aligned`);
    continue;
  }
  const size = { width: result.width, height: result.height };
  const frame = framing(projectCapture(scene.capture, scene.layout, size), view.checked);
  const started = performance.now();
  const w1 = restoreFixtureLightness({
    capture: scene.capture,
    mask: scene.mask,
    layout: scene.layout,
    fixtures: scene.scene.fixtures,
    result: view.shown,
    frame,
  });
  const ms = performance.now() - started;
  const shown = w1.image ?? view.shown;
  let changed = 0;
  for (let i = 0; i < size.width * size.height; i++)
    if (
      Math.max(
        Math.abs(view.shown.data[i * 4] - shown.data[i * 4]),
        Math.abs(view.shown.data[i * 4 + 1] - shown.data[i * 4 + 1]),
        Math.abs(view.shown.data[i * 4 + 2] - shown.data[i * 4 + 2]),
      ) > 2
    )
      changed++;
  writeFileSync(join(dir, `${source.id}.p0.png`), await png(view.shown));
  writeFileSync(join(dir, `${source.id}.w1.png`), await png(shown));
  const row = {
    id: source.id,
    design: join(source.dir, 'capture.png'),
    aligned: true,
    changedShare: +(changed / (size.width * size.height)).toFixed(4),
    ms: Math.round(ms),
    fixtures: w1.changes.map((c) => ({
      kind: c.kind,
      pixels: c.pixels,
      refL: +c.reference[0].toFixed(1),
      resL: +c.result[0].toFixed(1),
      added: +c.added.toFixed(1),
    })),
  };
  // W2 (the model input with the ceramics lifted; run.ts): the same scene and seed, as the app shows it.
  const w2File = join(OUT as string, 'results', 'cf', 'w2', `${source.scene}-${source.seed}.png`);
  if (source.trial === 'extra' && existsSync(w2File)) {
    const w2Result = await pixels(w2File);
    const w2View = appView(scene, w2Result);
    if (w2View.aligned) {
      const w2Frame = framing(projectCapture(scene.capture, scene.layout, size), w2View.checked);
      const measured = restoreFixtureLightness({
        capture: scene.capture,
        mask: scene.mask,
        layout: scene.layout,
        fixtures: scene.scene.fixtures,
        result: w2View.shown,
        frame: w2Frame,
      });
      writeFileSync(join(dir, `${source.id}.w2.png`), await png(w2View.shown));
      // W2 then W1: the lifted input, and what darkening is left taken back.
      writeFileSync(join(dir, `${source.id}.w2w1.png`), await png(measured.image ?? w2View.shown));
      Object.assign(row, {
        w2: measured.changes.map((c) => ({
          kind: c.kind,
          refL: +c.reference[0].toFixed(1),
          resL: +c.result[0].toFixed(1),
          added: +c.added.toFixed(1),
        })),
      });
    } else Object.assign(row, { w2: 'not aligned' });
  }
  rows.push(row);
  console.log(
    `${source.id.padEnd(20)} ${row.fixtures.map((f) => `${f.kind} ${f.refL}→${f.resL} +${f.added}`).join(', ')}  changed ${(row.changedShare * 100).toFixed(1)}% ${row.ms} ms` +
      ('w2' in row ? `  | W2 ${JSON.stringify((row as { w2: unknown }).w2)}` : ''),
  );
}
writeFileSync(join(OUT as string, `pictures-${set}.json`), JSON.stringify(rows, null, 1));
