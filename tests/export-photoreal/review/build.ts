/**
 * The review items of one set (no AI call): each result as the app would show it (`.app.png`) beside
 * the render it was made from, in a fixed shuffled order. Which method made which picture goes to
 * key.json, which the server never serves.
 *
 *   r2   round 2's results (seed 424242 on white, charcoal, photos), the two Stable Diffusion
 *        answers and the no-AI render of the same scenes
 *
 * Usage: node tests/run-browser-test.mjs tests/export-photoreal/review/build.ts --set r2
 * Output: test-results/export-photoreal/review/<set>/items.json, key.json
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { resultBase } from '../io';
import { OUT, SCENES } from '../paths.mjs';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const set = arg('set') ?? 'r2';
type Entry = { method: string; scene: string; seed?: number; left: string; right: string };
const rel = (path: string) => relative(OUT as string, path).replace(/\\/g, '/');
const entries: Entry[] = [];
const result = (method: string, scene: string, seed: number) => {
  const base = resultBase(method, scene, seed);
  if (!existsSync(`${base}.app.png`)) return;
  const left = join(SCENES as string, scene, method === 'inroom' ? 'inroom/capture.png' : 'capture.png');
  entries.push({ method, scene, seed, left: rel(left), right: rel(`${base}.app.png`) });
};
const render = (scene: string) =>
  entries.push({
    method: 'none',
    scene,
    left: rel(join(SCENES as string, scene, 'capture.png')),
    right: rel(join(SCENES as string, scene, 'render32.png')),
  });

if (set === 'r2') {
  for (const scene of ['white', 'charcoal', 'photos']) {
    for (const method of [
      'current',
      'photo',
      'short',
      'tileref',
      'large',
      'inroom',
      'sd-dreamshaper',
      'sd-inpainting',
    ])
      result(method, scene, 424242);
    render(scene);
  }
} else if (set === 'r5') {
  const dev = ['white', 'charcoal', 'pattern', 'partial', 'structure', 'smc', 'photos', 'narrow'];
  for (const scene of dev) {
    for (const seed of [424242, 777001]) result('current', scene, seed);
    for (const method of ['light', 'local', 'upscale', 'empty', 'placeholders', 'refine'])
      result(method, scene, 424242);
    render(scene);
  }
  // The renderer probe: its own small room, the single WebGL frame beside the path-traced one.
  const probe = join(OUT as string, 'render-probe');
  for (const name of ['webgl', 'path'])
    entries.push({
      method: `probe-${name}`,
      scene: 'probe',
      left: rel(join(probe, 'webgl.png')),
      right: rel(join(probe, `${name}.png`)),
    });
} else throw new Error(`unknown set ${set}`);

// A fixed order (seeded), so a re-build gives the same screen.
let seed = 20261104;
const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
for (let i = entries.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [entries[i], entries[j]] = [entries[j], entries[i]];
}
const dir = join(OUT as string, 'review', set);
mkdirSync(dir, { recursive: true });
const ids = entries.map((_, i) => `${set}-${String(i + 1).padStart(3, '0')}`);
writeFileSync(
  join(dir, 'items.json'),
  JSON.stringify(
    { set, items: entries.map((e, i) => ({ id: ids[i], left: e.left, right: e.right })) },
    null,
    1,
  ),
);
writeFileSync(
  join(dir, 'key.json'),
  JSON.stringify(
    Object.fromEntries(entries.map((e, i) => [ids[i], { method: e.method, scene: e.scene, seed: e.seed }])),
    null,
    1,
  ),
);
console.log(`${set}: ${entries.length} items, about ${Math.round((entries.length * 15) / 60)} min`);
