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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  framing,
  projectCapture,
  reviewResultColors,
  projectMask,
  rgbToLab,
  shiftMask,
  type Pixels,
  type RegionMask,
} from '../../src/lib/ai-export/color';
import sharp from 'sharp';
import { fixtureMask, restoreFixtureLightness } from '../../src/lib/ai-export/fixture-light';
import { restoreBackdrop } from '../../src/lib/ai-export/backdrop';
import { restoreResultJoints } from '../../src/lib/ai-export/joints';
import { modelFixtureMask } from '../../src/lib/ai-export/model-fixtures';
import { pastePhotoProducts } from '../../src/lib/ai-export/photo-products';
import { FLUX_FIXTURE_KINDS } from '../../src/lib/ai-export/scene-contract';
import { appView, loadScene, pixels, png } from '../extra-ai/app-view';
import { OUT, PHOTOS_RESULTS, PHOTOS_SCENE } from './paths.mjs';

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const set = arg('set', 'step0');
/** The joint restore's band around fixtures (joints.ts FIXTURE_BAND), in light-blur radii. */
const band = Number(arg('band', '0'));
/** Whether the model's own fixture stays in the band (joints.ts FIXTURE_KEEP). */
const keep = arg('keep', '1') !== '0';
/**
 * Whether the steps follow the model's fixtures (model-fixtures.ts) with the render's walls behind its
 * fixtures (behind.ts): `-e` pictures.
 */
const behind = process.argv.includes('--behind');
const tag = (band ? `-b${band}${keep ? '' : 'n'}` : '') + (behind ? '-e' : '');
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

type View = {
  checked: Pixels;
  shown: Pixels;
  aligned: boolean;
  resultMask?: RegionMask;
  moved?: { added: number; removed: number };
  ms?: number;
};
/** As app-view.ts appView, with the steps following the model's fixtures and the render behind them. */
async function behindView(
  sceneId: string,
  scene: Awaited<ReturnType<typeof loadScene>>,
  result: Pixels,
): Promise<View> {
  const layers = join(OUT as string, 'behind', sceneId);
  const behindCapture = await pixels(join(layers, 'behind.png'));
  const regions = JSON.parse(readFileSync(join(layers, 'regions-behind.json'), 'utf8')) as Omit<
    RegionMask,
    'data'
  >;
  const behindMask: RegionMask = {
    ...regions,
    data: new Uint8Array(await sharp(join(layers, 'mask-behind.png')).extractChannel(0).raw().toBuffer()),
  };
  const { capture, mask, layout } = scene;
  const size = { width: result.width, height: result.height };
  const reference = projectCapture(capture, layout, size);
  const first = framing(reference, result);
  const checked =
    (first.aligned && mask.outside
      ? restoreBackdrop({ result, capture, mask, layout, shift: first })
      : undefined) ?? result;
  if (!first.aligned) return { checked, shown: checked, aligned: false };
  const again = framing(reference, checked);
  if (!again.aligned) return { checked, shown: checked, aligned: false };
  const started = performance.now();
  const model = modelFixtureMask({
    model: checked,
    renderMask: shiftMask(projectMask(mask, layout, size), again.dx, again.dy),
    behindMask: shiftMask(projectMask(behindMask, layout, size), again.dx, again.dy),
  });
  const joints = restoreResultJoints({
    capture,
    joints: scene.joints,
    mask,
    layout,
    result: checked,
    frame: again,
    behind: behindCapture,
    resultMask: model.mask,
    fixtureBand: band,
    fixtureKeep: false,
  });
  const onto = joints.image ?? checked;
  const review = reviewResultColors({
    capture,
    mask,
    layout,
    result: onto,
    alignment: { dx: again.dx, dy: again.dy },
    resultMask: model.mask,
  });
  return {
    checked,
    shown: review.framing.aligned ? (review.corrected ?? onto) : checked,
    aligned: review.framing.aligned,
    resultMask: model.mask,
    moved: { added: model.added, removed: model.removed },
    ms: Math.round(performance.now() - started),
  };
}

const rows = [];
for (const source of sources) {
  if (!existsSync(source.result)) continue;
  const scene = await loadScene(source.dir, 'joints.png');
  const result = await pixels(source.result);
  const size = { width: result.width, height: result.height };
  const reference = projectCapture(scene.capture, scene.layout, size);
  const view: View = behind
    ? await behindView(source.scene, scene, result)
    : appView(scene, result, undefined, undefined, undefined, band, keep);
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
      ...(view.resultMask ? { resultMask: view.resultMask } : {}),
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
    ...(view.moved ? { moved: view.moved, behindMs: view.ms } : {}),
  };
  rows.push(row);
  console.log(
    `${source.id.padEnd(26)} L* render ${row.render.join('/')} p0 ${row.p0.join('/')} p ${row.p.join('/')} gains ${row.pasted
      .map((x) => x.gain[1])
      .join('/')} ${row.ms} ms`,
  );
}
writeFileSync(join(OUT as string, `pictures-${set}${tag}.json`), JSON.stringify(rows, null, 1));
