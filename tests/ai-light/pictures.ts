/**
 * The AI-light trial's pictures (no AI call, docs/ai-light-20261115.md): earlier AI results as the app
 * shows them (backdrop, joints and pattern on every tiled face, colours, ceramics' lightness), with the
 * restored faces keeping all (k100, the app now), half (k50) or a quarter (k25) of the model's light
 * shape (joints.ts RESTORE_LIGHT_KEEP). Also the light spread of each: per wall and floor, the spread
 * of log(result light / render light) over the face (both blurred wide), as the streaks, shadows and
 * glare the render does not have.
 *
 * Usage: node tests/run-browser-test.mjs tests/ai-light/pictures.ts [--holdout]
 * Output: test-results/ai-light-20261115/pictures/<id>.k<keep>.png and pictures-<set>.json
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FIXTURE_REGION,
  framing,
  projectCapture,
  projectMask,
  shiftMask,
  type Pixels,
  type RegionMask,
} from '../../src/lib/ai-export/color';
import { restoreFixtureLightness } from '../../src/lib/ai-export/fixture-light';
import { blurInside } from '../../src/lib/ai-export/joints';
import { appView, loadScene, pixels, png } from '../extra-ai/app-view';
import { sources } from '../tile-pattern/sources';
import { OUT } from './paths.mjs';

const set = process.argv.includes('--holdout') ? 'holdout' : 'dev';
const KEEPS = [1, 0.5, 0.25];
const dir = join(OUT as string, 'pictures');
mkdirSync(dir, { recursive: true });

const lum = (image: Pixels) => {
  const out = new Float32Array(image.width * image.height);
  for (let i = 0; i < out.length; i++)
    out[i] = 0.2126 * image.data[i * 4] + 0.7152 * image.data[i * 4 + 1] + 0.0722 * image.data[i * 4 + 2];
  return out;
};
/** Per face: the spread (standard deviation) of log(result / render), both blurred 3% of the width. */
function spread(reference: Pixels, shown: Pixels, mask: RegionMask) {
  const { width, height } = shown;
  const radius = Math.round(width * 0.03);
  const a = lum(reference),
    b = lum(shown);
  return mask.regions.flatMap((region, k) => {
    const label = k + 1;
    if (label === FIXTURE_REGION) return [];
    const weight = new Float32Array(width * height);
    let n = 0;
    for (let i = 0; i < weight.length; i++)
      if (mask.data[i] === label) {
        weight[i] = 1;
        n++;
      }
    if (n < width * height * 0.01) return [];
    const ra = blurInside(a, weight, width, height, radius).mean,
      rb = blurInside(b, weight, width, height, radius).mean;
    let s = 0,
      ss = 0,
      m = 0;
    for (let i = 0; i < weight.length; i += 3) {
      if (!weight[i]) continue;
      const v = Math.log(Math.max(1, rb[i]) / Math.max(1, ra[i]));
      s += v;
      ss += v * v;
      m++;
    }
    return [
      {
        key: region.key,
        kind: region.kind,
        spread: +Math.sqrt(Math.max(0, ss / m - (s / m) ** 2)).toFixed(3),
      },
    ];
  });
}

const rows = [];
for (const source of sources(set)) {
  if (!existsSync(source.result)) continue;
  const scene = await loadScene(source.dir, source.jointsFile);
  const result = await pixels(source.result);
  const size = { width: result.width, height: result.height };
  const reference = projectCapture(scene.capture, scene.layout, size);
  const row: Record<string, unknown> = { id: source.id, design: join(source.dir, 'capture.png') };
  for (const keep of KEEPS) {
    const started = performance.now();
    const view = appView(scene, result, undefined, undefined, keep);
    if (!view.aligned) {
      row.aligned = false;
      break;
    }
    const frame = framing(reference, view.checked);
    const shown =
      restoreFixtureLightness({
        capture: scene.capture,
        mask: scene.mask,
        layout: scene.layout,
        fixtures: scene.scene.fixtures,
        result: view.shown,
        frame,
      }).image ?? view.shown;
    const ms = performance.now() - started;
    writeFileSync(join(dir, `${source.id}.k${Math.round(keep * 100)}.png`), await png(shown));
    const faces = spread(
      reference,
      shown,
      shiftMask(projectMask(scene.mask, scene.layout, size), frame.dx, frame.dy),
    );
    row.aligned = true;
    row[`k${Math.round(keep * 100)}`] = { ms: Math.round(ms), faces };
  }
  rows.push(row);
  const mean = (k: string) => {
    const faces = (row[k] as { faces: { spread: number }[] } | undefined)?.faces ?? [];
    return faces.length ? (faces.reduce((t, f) => t + f.spread, 0) / faces.length).toFixed(3) : '-';
  };
  console.log(`${source.id.padEnd(20)} spread k100 ${mean('k100')} k50 ${mean('k50')} k25 ${mean('k25')}`);
}
writeFileSync(join(OUT as string, `pictures-${set}.json`), JSON.stringify(rows, null, 1));
