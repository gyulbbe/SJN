/**
 * The photo-product trial's pictures (no AI call, docs/photo-products-20261115.md): each AI result as
 * the app shows it today (backdrop, joints and pattern with a quarter of the model's light, colours,
 * ceramics' lightness: `p0`) and with the products' own photos put back on that (`p`,
 * photo-products.ts). Also each photo product's mean L* in the render and in both pictures.
 *
 * Usage: node tests/run-browser-test.mjs tests/photo-products/pictures.ts [--set step0|dev|holdout]
 *   step0    the added-objects trial's photo scene: its `cur` and `names-end` results (P0 today)
 *   dev      the trial's results (results/<method>/<scene>-<seed>.png) on the photo scene and new scenes
 *   holdout  the same on the held-out scenes
 * Output: test-results/photo-products-20261115/pictures/<id>.<p0|p>.png and pictures-<set>.json
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  framing,
  projectCapture,
  projectMask,
  rgbToLab,
  shiftMask,
  type Pixels,
} from '../../src/lib/ai-export/color';
import { fixtureMask, restoreFixtureLightness } from '../../src/lib/ai-export/fixture-light';
import { pastePhotoProducts } from './paste';
import { FLUX_FIXTURE_KINDS } from '../../src/lib/ai-export/scene-contract';
import { appView, loadScene, pixels, png } from '../extra-ai/app-view';
import { OUT, PHOTOS_RESULTS, PHOTOS_SCENE } from './paths.mjs';

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const set = arg('set', 'step0');
/**
 * The band (`--band`) and empty-room-layer (`--behind`) modes of the haze trial needed trial options in
 * the app's steps, removed after the trial (they are in commit feaa5ab); their pictures stay in
 * test-results (pictures-b2*, pictures-b2n-e).
 */
const tag = '';
const dir = join(OUT as string, `pictures${tag}`);
mkdirSync(dir, { recursive: true });

type Source = { id: string; dir: string; result: string; method: string; scene: string; seed: number };
const sources: Source[] = [];
const seeds = [424242, 777001];
if (set === 'step0')
  for (const method of ['cur', 'names-end'])
    for (const seed of seeds)
      sources.push({
        id: `photos-${method}-${seed}`,
        dir: PHOTOS_SCENE as string,
        result: join(PHOTOS_RESULTS as string, method, `photos-${seed}.png`),
        method,
        scene: 'photos',
        seed,
      });
else {
  const results = join(OUT as string, 'results');
  for (const method of existsSync(results) ? readdirSync(results) : [])
    for (const file of readdirSync(join(results, method)).filter((f) => f.endsWith('.png'))) {
      const [scene, seed] = file.replace('.png', '').split('-');
      const sceneDir = scene === 'photos' ? (PHOTOS_SCENE as string) : join(OUT as string, 'scenes', scene);
      const holdout =
        existsSync(join(sceneDir, 'spec.json')) &&
        /"holdout": true/.test((await import('node:fs')).readFileSync(join(sceneDir, 'spec.json'), 'utf8'));
      if (holdout !== (set === 'holdout')) continue;
      sources.push({
        id: `${scene}-${method}-${seed}`,
        dir: sceneDir,
        result: join(results, method, file),
        method,
        scene,
        seed: +seed,
      });
    }
  // Today's method on the photo scene is the added-objects trial's end sentence (same prompt).
  if (set === 'dev')
    for (const seed of seeds)
      sources.push({
        id: `photos-cur-${seed}`,
        dir: PHOTOS_SCENE as string,
        result: join(PHOTOS_RESULTS as string, 'names-end', `photos-${seed}.png`),
        method: 'cur',
        scene: 'photos',
        seed,
      });
}

/** Mean L* of each photo product (fixture mask ∩ box, moved by the model's shift). */
function productLightness(image: Pixels, labels: Uint8Array, count: number) {
  const sums = Array.from({ length: count }, () => ({ L: 0, n: 0 }));
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (!label) continue;
    sums[label - 1].L += rgbToLab(image.data[i * 4], image.data[i * 4 + 1], image.data[i * 4 + 2])[0];
    sums[label - 1].n++;
  }
  return sums.map((s) => (s.n ? +(s.L / s.n).toFixed(1) : null));
}

const rows = [];
for (const source of sources) {
  if (!existsSync(source.result)) continue;
  const scene = await loadScene(source.dir, 'joints.png');
  const result = await pixels(source.result);
  const size = { width: result.width, height: result.height };
  const reference = projectCapture(scene.capture, scene.layout, size);
  const view = appView(scene, result);
  if (!view.aligned) {
    rows.push({ ...source, aligned: false });
    console.log(source.id, 'not aligned');
    continue;
  }
  const frame = framing(reference, view.checked);
  const p0 =
    restoreFixtureLightness({
      capture: scene.capture,
      mask: scene.mask,
      layout: scene.layout,
      fixtures: scene.scene.fixtures,
      result: view.shown,
      frame,
    }).image ?? view.shown;

  const started = performance.now();
  const pasted = pastePhotoProducts({
    capture: scene.capture,
    mask: scene.mask,
    layout: scene.layout,
    fixtures: scene.scene.fixtures,
    // Every product in these scenes is a photo product.
    photo: scene.scene.fixtures.map(() => true),
    result: p0,
    frame,
  });
  const ms = performance.now() - started;
  const p = pasted.image ?? p0;
  writeFileSync(join(dir, `${source.id}.p0.png`), await png(p0));
  writeFileSync(join(dir, `${source.id}.p.png`), await png(p));
  const { mask: labels, kinds } = fixtureMask(
    projectMask(scene.mask, scene.layout, size),
    scene.scene.fixtures,
    FLUX_FIXTURE_KINDS,
  );
  const moved = shiftMask(labels, frame.dx, frame.dy).data;
  const row = {
    ...source,
    aligned: true,
    design: join(source.dir, 'capture.png'),
    kinds,
    render: productLightness(reference, labels.data, kinds.length),
    p0: productLightness(p0, moved, kinds.length),
    p: productLightness(p, moved, kinds.length),
    pasted: pasted.pasted.map((x) => ({
      kind: x.kind,
      pixels: x.pixels,
      gain: x.gain.map((g) => +g.toFixed(3)),
      ring: x.ringPixels,
    })),
    ms: Math.round(ms),
  };
  rows.push(row);
  console.log(
    `${source.id.padEnd(26)} L* render ${row.render.join('/')} p0 ${row.p0.join('/')} p ${row.p.join('/')} gains ${row.pasted
      .map((x) => x.gain[1])
      .join('/')} ${row.ms} ms`,
  );
}
writeFileSync(join(OUT as string, `pictures-${set}${tag}.json`), JSON.stringify(rows, null, 1));
