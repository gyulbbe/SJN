/**
 * The fixture-haze trial's pictures (no AI call, docs/fixture-haze-20261116.md): each result as the
 * app shows it today (`p0`: backdrop, joints and pattern, colours, ceramics' lightness, all on the
 * render's fixture outline) and with F1 (`f1`: the app's same steps on the outline the model drew,
 * src/lib/ai-export/current-refine.ts and fixture-outline.ts, with the cut-outs of cutout.ts and the
 * render's walls behind its fixtures from behind.ts).
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-haze/pictures.ts [--set dev|holdout|new|new-holdout]
 * Output: test-results/fixture-haze-20261116/pictures/<id>.{p0,f1}.png, pictures-<set>.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { restoreBackdrop } from '../../src/lib/ai-export/backdrop';
import { framing, projectCapture, type Pixels, type RegionMask } from '../../src/lib/ai-export/color';
import { restoreFixtureLightness } from '../../src/lib/ai-export/fixture-light';
import type { FluxScene } from '../../src/lib/ai-export/scene-contract';
import { appView, loadScene, pixels, png } from '../extra-ai/app-view';
import { refineCurrentResult } from '../../src/lib/ai-export/current-refine';
import { type Cut } from '../../src/lib/ai-export/fixture-outline';
import { OUT } from './paths.mjs';
import { haze, type HazeSet } from './sources';

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const set = arg('set', 'dev') as HazeSet;
/** As cutout.ts. */
const PAD = 0.3;
const dir = join(OUT as string, 'pictures');
mkdirSync(dir, { recursive: true });

async function cutsOf(id: string, scene: FluxScene, size: { width: number; height: number }) {
  const cuts: Cut[] = [];
  for (const [k, fixture] of scene.fixtures.entries()) {
    const file = join(OUT as string, 'cutout', id, `cut-${k}.png`);
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
  if (!existsSync(source.result)) continue;
  const scene = await loadScene(source.dir, source.jointsFile);
  const result = await pixels(source.result);
  const size = { width: result.width, height: result.height };
  const reference = projectCapture(scene.capture, scene.layout, size);
  const view = appView(scene, result);
  if (!view.aligned) {
    rows.push({ id: source.id, aligned: false });
    console.log(source.id, 'not aligned');
    continue;
  }
  const frame = framing(reference, view.checked);
  const ceramics = (shown: Pixels, resultMask?: RegionMask) =>
    restoreFixtureLightness({
      capture: scene.capture,
      mask: scene.mask,
      layout: scene.layout,
      fixtures: scene.scene.fixtures,
      result: shown,
      frame,
      ...(resultMask ? { resultMask } : {}),
    }).image ?? shown;
  const p0 = ceramics(view.shown);

  // F1: the same steps on the model's own fixture outline.
  const started = performance.now();
  const layers = join(OUT as string, 'behind', source.layers);
  const behind = await pixels(join(layers, 'behind.png'));
  const regions = JSON.parse(readFileSync(join(layers, 'regions-behind.json'), 'utf8')) as Omit<
    RegionMask,
    'data'
  >;
  const behindMask: RegionMask = {
    ...regions,
    data: new Uint8Array(await sharp(join(layers, 'mask-behind.png')).extractChannel(0).raw().toBuffer()),
  };
  const first = framing(reference, result);
  const checked =
    (first.aligned && scene.mask.outside
      ? restoreBackdrop({
          result,
          capture: scene.capture,
          mask: scene.mask,
          layout: scene.layout,
          shift: first,
        })
      : undefined) ?? result;
  // The app's own finishing steps (current-refine.ts) with the model's fixture outline.
  const refined = refineCurrentResult({
    raw: checked,
    capture: scene.capture,
    mask: scene.mask,
    layout: scene.layout,
    joints: scene.joints,
    fixtures: scene.scene.fixtures,
    behind: { image: behind, mask: behindMask },
    cuts: await cutsOf(source.id, scene.scene, size),
  });
  const model = refined.outline ?? { verdicts: [], added: 0, removed: 0 };
  const f1 = refined.shown ?? checked;
  const ms = Math.round(performance.now() - started);
  writeFileSync(join(dir, `${source.id}.p0.png`), await png(p0));
  writeFileSync(join(dir, `${source.id}.f1.png`), await png(f1));
  writeFileSync(join(dir, `${source.id}.raw.png`), await png(checked));
  rows.push({
    id: source.id,
    aligned: true,
    design: join(source.dir, 'capture.png'),
    verdicts: model.verdicts,
    added: model.added,
    removed: model.removed,
    ms,
  });
  console.log(
    `${source.id.padEnd(22)} +${model.added} -${model.removed} ${model.verdicts.map((v) => `${v.fixture}:${v.iou}${v.used ? '' : '(no)'}`).join(' ')} ${ms} ms`,
  );
}
writeFileSync(join(OUT as string, `pictures-${set}.json`), JSON.stringify(rows, null, 1));
