/**
 * Where the app's finishing steps took each fixture from (no AI call, docs/fixture-streaks-20261117.md
 * section 12): per result, the cut-out verdicts (overlap with the render's fixture, used or not) and an
 * overlay on the model's picture: the render's fixture outline in red, the cut-out (alpha ≥ 128) in
 * green, and the pixels the outline step turned to wall in blue.
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-streaks/outline-diag.ts [--set reg] [--ids a,b]
 * Output: test-results/fixture-streaks-20261117/outline/<id>.png, outline-<set>.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { restoreBackdrop } from '../../src/lib/ai-export/backdrop';
import {
  FIXTURE_REGION,
  framing,
  projectCapture,
  projectMask,
  shiftMask,
  type RegionMask,
} from '../../src/lib/ai-export/color';
import { refineCurrentResult } from '../../src/lib/ai-export/current-refine';
import type { Cut } from '../../src/lib/ai-export/fixture-outline';
import type { FluxScene } from '../../src/lib/ai-export/scene-contract';
import { loadScene, pixels, png } from '../extra-ai/app-view';
import { OUT as HAZE } from '../fixture-haze/paths.mjs';
import { haze, type HazeSet } from '../fixture-haze/sources';
import { OUT } from './paths.mjs';

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const set = arg('set', 'reg') as HazeSet;
const only = arg('ids') ? new Set(arg('ids').split(',')) : undefined;
const PAD = 0.3;
const dir = join(OUT as string, 'outline');
mkdirSync(dir, { recursive: true });

async function cutsOf(id: string, scene: FluxScene, size: { width: number; height: number }) {
  const cuts: Cut[] = [];
  for (const [k, fixture] of scene.fixtures.entries()) {
    const file = join(HAZE as string, 'cutout', id, `cut-${k}.png`);
    if (!fixture.box || !existsSync(file)) continue;
    const [l, t, r, b] = fixture.box;
    const bw = r - l,
      bh = b - t;
    const left = Math.max(0, Math.floor((l - bw * PAD) * size.width)),
      top = Math.max(0, Math.floor((t - bh * PAD) * size.height)),
      right = Math.min(size.width, Math.ceil((r + bw * PAD) * size.width)),
      bottom = Math.min(size.height, Math.ceil((b + bh * PAD) * size.height));
    const alpha = new Uint8Array(
      await sharp(file)
        .ensureAlpha()
        .extractChannel(3)
        .resize(right - left, bottom - top, { fit: 'fill' })
        .raw()
        .toBuffer(),
    );
    cuts.push({ fixture: k, left, top, width: right - left, height: bottom - top, alpha });
  }
  return cuts;
}

const rows = [];
for (const source of haze(set)) {
  if (only && !only.has(source.id)) continue;
  if (!existsSync(source.result)) continue;
  const scene = await loadScene(source.dir, source.jointsFile);
  const result = await pixels(source.result);
  const size = { width: result.width, height: result.height };
  const reference = projectCapture(scene.capture, scene.layout, size);
  const first = framing(reference, result);
  if (!first.aligned) continue;
  const layers = join(HAZE as string, 'behind', source.layers);
  const behind = await pixels(join(layers, 'behind.png'));
  const regions = JSON.parse(readFileSync(join(layers, 'regions-behind.json'), 'utf8')) as Omit<
    RegionMask,
    'data'
  >;
  const behindMask: RegionMask = {
    ...regions,
    data: new Uint8Array(await sharp(join(layers, 'mask-behind.png')).extractChannel(0).raw().toBuffer()),
  };
  const checked =
    (scene.mask.outside
      ? restoreBackdrop({ result, capture: scene.capture, mask: scene.mask, layout: scene.layout, shift: first })
      : undefined) ?? result;
  const cuts = await cutsOf(source.id, scene.scene, size);
  const refined = refineCurrentResult({
    raw: checked,
    capture: scene.capture,
    mask: scene.mask,
    layout: scene.layout,
    joints: scene.joints,
    fixtures: scene.scene.fixtures,
    behind: { image: behind, mask: behindMask },
    cuts,
  });
  const frame = refined.review.framing;
  const render = shiftMask(projectMask(scene.mask, scene.layout, size), frame.dx, frame.dy);
  const outline = refined.outline?.mask;
  const out = new Uint8ClampedArray(checked.data);
  const { width, height } = size;
  const claimed = new Uint8Array(width * height);
  for (const cut of cuts)
    for (let y = 0; y < cut.height; y++)
      for (let x = 0; x < cut.width; x++)
        if (cut.alpha[y * cut.width + x] >= 128) claimed[(cut.top + y) * width + cut.left + x] = 1;
  const isRender = (i: number) => render.data[i] === FIXTURE_REGION;
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const edge = (f: (j: number) => boolean) =>
        f(i) && (!f(i - 1) || !f(i + 1) || !f(i - width) || !f(i + width));
      const paint = (r: number, g: number, b: number, a: number) => {
        for (const [c, v] of [r, g, b].entries()) out[i * 4 + c] = out[i * 4 + c] * (1 - a) + v * a;
      };
      if (outline && isRender(i) && outline.data[i] !== FIXTURE_REGION) paint(40, 90, 255, 0.45);
      if (edge((j) => claimed[j] === 1)) paint(0, 200, 0, 1);
      if (edge(isRender)) paint(255, 0, 0, 1);
    }
  writeFileSync(join(dir, `${source.id}.png`), await png({ width, height, data: out }));
  const verdicts = refined.outline?.verdicts ?? [];
  rows.push({
    id: source.id,
    outline: !!refined.outline,
    fixtures: scene.scene.fixtures.map((f, k) => ({ k, kind: f.kind, verdict: verdicts.find((v) => v.fixture === k) })),
  });
  console.log(
    source.id.padEnd(24),
    scene.scene.fixtures
      .map((f, k) => {
        const v = verdicts.find((w) => w.fixture === k);
        return `${k}:${f.kind}${v ? ` ${v.iou}${v.used ? '' : '(no)'}` : ' -'}`;
      })
      .join('  '),
  );
}
writeFileSync(join(OUT as string, `outline-${set}.json`), JSON.stringify(rows, null, 1));
