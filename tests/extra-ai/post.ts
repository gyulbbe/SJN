/**
 * The added-objects trial's results as the app shows them, and O3 (no AI call,
 * docs/extra-ai-trials-20261114.md):
 *   - `<result>.app.png`: the backdrop, joints and colours as the export dialog does (app-view.ts);
 *   - with --erase, O3a `<method>+erase/`: erase.ts on every wall and floor before the joints;
 *   - with --erase-check, O3b `<method>+erasecheck/`: only on the faces where Gemma's check (check.ts)
 *     put an added object (its picture-relative place); a result without one stays as it is.
 * An O3 result keeps the model's picture (`.png`) and its check, so it is the same AI original.
 *
 * Usage: node tests/run-browser-test.mjs tests/extra-ai/post.ts --group cf --methods cur,names
 *          --scenes white,pattern --seeds 424242,777001 [--erase] [--erase-check] [--holdout]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appView, facesAt, loadScene, pixels, png, type AppView } from './app-view';
import type { SavedCheck } from './check';
import { HOLDOUT, RESULTS, SCENES } from './paths.mjs';

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const list = (name: string, fallback = '') => arg(name, fallback).split(',').filter(Boolean);
const group = arg('group', 'cf');
const holdout = process.argv.includes('--holdout');
const erase = process.argv.includes('--erase');
const eraseCheck = process.argv.includes('--erase-check');

const summary = (view: AppView) => ({
  aligned: view.aligned,
  joints: view.joints.length,
  coloured: view.coloured,
  ...(view.erased
    ? {
        objects: view.erased.objects.map((o) => ({
          label: o.label,
          cells: o.cells,
          box: o.box,
          reasons: o.reasons,
        })),
        changed: Object.fromEntries(Object.entries(view.erased.changed).map(([k, v]) => [k, +v.toFixed(4)])),
        skipped: view.erased.skipped,
      }
    : {}),
});
async function variant(base: string, method: string, scene: string, seed: string, view: AppView) {
  const out = join(RESULTS as string, group, method, `${scene}-${seed}`);
  mkdirSync(join(out, '..'), { recursive: true });
  copyFileSync(`${base}.png`, `${out}.png`);
  for (const extra of ['.json', '.check.json'])
    if (existsSync(`${base}${extra}`)) copyFileSync(`${base}${extra}`, `${out}${extra}`);
  writeFileSync(`${out}.app.png`, await png(view.shown));
  writeFileSync(`${out}.post.json`, JSON.stringify(summary(view), null, 1));
  return out;
}

for (const scene of list('scenes')) {
  const dir = join((holdout ? HOLDOUT : SCENES) as string, scene);
  const parts = await loadScene(dir);
  for (const method of list('methods'))
    for (const seed of list('seeds', '424242')) {
      const base = join(RESULTS as string, group, method, `${scene}-${seed}`);
      if (!existsSync(`${base}.png`)) continue;
      const result = await pixels(`${base}.png`);
      const view = appView(parts, result);
      writeFileSync(`${base}.app.png`, await png(view.shown));
      writeFileSync(`${base}.post.json`, JSON.stringify(summary(view), null, 1));
      const line = [method, scene, seed, JSON.stringify(summary(view))];
      if (erase) {
        const erased = appView(parts, result, {});
        await variant(base, `${method}+erase`, scene, seed, erased);
        line.push(`erase ${erased.erased?.objects.length ?? '-'}`);
      }
      if (eraseCheck && existsSync(`${base}.check.json`)) {
        const check = JSON.parse(readFileSync(`${base}.check.json`, 'utf8')) as SavedCheck;
        const places = (check.parsed?.extras ?? []).map((extra) => extra.place);
        const labels = facesAt(parts.mask, places);
        const erased = labels.size ? appView(parts, result, { labels }) : view;
        await variant(base, `${method}+erasecheck`, scene, seed, erased);
        line.push(`erasecheck ${places.join('/') || '-'} ${erased.erased?.objects.length ?? 0}`);
      }
      console.log(line.join(' '));
    }
}
