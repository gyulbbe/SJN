/**
 * The fixture-haze trial's pictures (no AI call, docs/fixture-haze-20261116.md): each result as the
 * app shows it today (`p0`: backdrop, joints and pattern, colours, ceramics' lightness, all on the
 * render's fixture outline) and with F1 (`f1`: the same steps on the outline the model drew, cutout.ts
 * and model-mask.ts, with the render's walls behind its fixtures from behind.ts).
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-haze/pictures.ts [--set dev|holdout|new|new-holdout]
 * Output: test-results/fixture-haze-20261116/pictures/<id>.{p0,f1}.png, pictures-<set>.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { restoreBackdrop } from '../../src/lib/ai-export/backdrop';
import {
  framing,
  projectCapture,
  projectMask,
  reviewResultColors,
  shiftMask,
  type Pixels,
  type RegionMask,
} from '../../src/lib/ai-export/color';
import { restoreFixtureLightness } from '../../src/lib/ai-export/fixture-light';
import { restoreResultJoints } from '../../src/lib/ai-export/joints';
import type { FluxScene } from '../../src/lib/ai-export/scene-contract';
import { appView, loadScene, pixels, png } from '../extra-ai/app-view';
import { cutoutMask, type Cut } from './model-mask';
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
  const again = framing(reference, checked);
  const model = cutoutMask({
    model: checked,
    renderMask: shiftMask(projectMask(scene.mask, scene.layout, size), again.dx, again.dy),
    behindMask: shiftMask(projectMask(behindMask, scene.layout, size), again.dx, again.dy),
    fixtures: scene.scene.fixtures,
    cuts: await cutsOf(source.id, scene.scene, size),
  });
  const joints = restoreResultJoints({
    capture: scene.capture,
    joints: scene.joints,
    mask: scene.mask,
    layout: scene.layout,
    result: checked,
    frame: again,
    behind,
    resultMask: model.mask,
  });
  const onto = joints.image ?? checked;
  const review = reviewResultColors({
    capture: scene.capture,
    mask: scene.mask,
    layout: scene.layout,
    result: onto,
    alignment: { dx: again.dx, dy: again.dy },
    resultMask: model.colourMask,
  });
  const f1 = ceramics(review.corrected ?? onto, model.colourMask);
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
