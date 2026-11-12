/**
 * S5 of the ledge AI trial (docs/ledge-ai-trials-20261111.md, no AI call): the ledge's faces are put
 * back from the app's own capture where the mask says a ledge is, lit as the model lit that part of
 * the picture (the ratio of the two pictures blurred wide). The answer of `<method>+restore`.
 *
 * Usage: node tests/run-browser-test.mjs tests/ledge-ai/post.ts --methods cur --scenes thin-l
 *          --seeds 424242,777001 [--holdout]
 * Output: results/cf/<method>+restore/<scene>-<seed>.png
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import type { FluxInputLayout } from '../../src/lib/ai-export/contract';
import { HOLDOUT, RESULTS, SCENES } from './paths.mjs';

/** How wide the light is taken from (result pixels), and how far it may change the capture. */
export const LIGHT_SIGMA = 18;
export const GAIN = [0.6, 1.6] as const;
/** The mask's soft edge, so the put-back faces meet the model's picture without a cut line. */
export const FEATHER_SIGMA = 1.2;

/** The gain a channel of the capture takes to sit in the model's light. */
export const lightGain = (model: number, capture: number) =>
  Math.max(GAIN[0], Math.min(GAIN[1], (model + 1) / (capture + 1)));

/** A capture-sized picture where it lies in the model's answer (twice the padded input). */
async function inResult(file: string, layout: FluxInputLayout, background: string) {
  const width = Math.round(layout.contentWidth * 2),
    height = Math.round(layout.contentHeight * 2);
  const inner = await sharp(file).resize(width, height, { fit: 'fill' }).removeAlpha().png().toBuffer();
  return sharp({
    create: { width: layout.width * 2, height: layout.height * 2, channels: 3, background },
  })
    .composite([{ input: inner, left: Math.round(layout.x * 2), top: Math.round(layout.y * 2) }])
    .removeAlpha()
    .raw()
    .toBuffer();
}

export async function restoreLedges(result: string, sceneDir: string): Promise<Buffer> {
  const { layout } = JSON.parse(readFileSync(join(sceneDir, 'layout.json'), 'utf8')) as {
    layout: FluxInputLayout;
  };
  const width = layout.width * 2,
    height = layout.height * 2;
  const raw = { raw: { width, height, channels: 3 as const } };
  const model = await sharp(result).resize(width, height, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const capture = await inResult(join(sceneDir, 'capture.png'), layout, '#ffffff');
  const mask = await sharp(await inResult(join(sceneDir, 'ledge-mask.png'), layout, '#000000'), raw)
    .blur(FEATHER_SIGMA)
    .raw()
    .toBuffer();
  const wide = (pixels: Buffer) => sharp(pixels, raw).blur(LIGHT_SIGMA).raw().toBuffer();
  const [modelLight, captureLight] = await Promise.all([wide(model), wide(capture)]);
  const out = Buffer.from(model);
  for (let i = 0; i < out.length; i++) {
    const alpha = mask[i - (i % 3)] / 255;
    if (!alpha) continue;
    const lit = Math.min(255, capture[i] * lightGain(modelLight[i], captureLight[i]));
    out[i] = Math.round(model[i] * (1 - alpha) + lit * alpha);
  }
  return sharp(out, raw).png().toBuffer();
}

if (process.argv[2]?.endsWith('post.ts')) {
  const arg = (name: string, fallback = '') => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const holdout = process.argv.includes('--holdout');
  for (const method of arg('methods').split(',').filter(Boolean))
    for (const scene of arg('scenes').split(',').filter(Boolean))
      for (const seed of arg('seeds', '424242').split(',').map(Number)) {
        const dir = join((holdout ? HOLDOUT : SCENES) as string, scene);
        const from = method.split('+').includes('elev') ? join(dir, 'elev') : dir;
        const base = join(RESULTS as string, 'cf', method, `${scene}-${seed}`);
        if (!existsSync(`${base}.png`)) continue;
        const out = join(RESULTS as string, 'cf', `${method}+restore`, `${scene}-${seed}`);
        mkdirSync(join(out, '..'), { recursive: true });
        writeFileSync(`${out}.png`, await restoreLedges(`${base}.png`, from));
        writeFileSync(
          `${out}.json`,
          JSON.stringify({ method: `${method}+restore`, scene, seed, from: method }),
        );
        console.log('restored', method, scene, seed);
      }
}
