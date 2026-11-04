/**
 * Round 2's one call of each Stable Diffusion model on Workers AI (white scene, seed 424242): whether
 * it takes the picture (img2img), keeps the framing and, for inpainting, the mask. Their price is not
 * known ("beta, $0 per step" in the list), so each counts as 100 neurons in the ledger and the ledger
 * refuses a second call until the account's analytics confirm the cost (budget.ts UNPRICED).
 *
 * The inpainting mask is white where walls and floor may be repainted, black on the fixtures and the
 * backdrop (the face mask of the capture).
 *
 * Usage: node tests/run-browser-test.mjs tests/export-photoreal/sd.ts [--dry]
 * Output: results/sd-<name>/white-424242.{png,json}
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { FIXTURE_REGION } from '../../src/lib/ai-export/color';
import { jsonCall, StopRun } from './ai';
import { loadScene, resultBase } from './io';
import { SD_NEGATIVE, SD_PROMPT } from './methods';

const SCENE = 'white',
  SEED = 424242;
const MODELS = [
  {
    name: 'sd-xl-base',
    model: '@cf/stabilityai/stable-diffusion-xl-base-1.0',
    size: [1024, 680],
    settings: { strength: 0.45, num_steps: 20, guidance: 7.5 },
  },
  {
    name: 'sd-dreamshaper',
    model: '@cf/lykon/dreamshaper-8-lcm',
    size: [768, 512],
    settings: { strength: 0.45, num_steps: 8, guidance: 1.5 },
  },
  {
    name: 'sd-xl-lightning',
    model: '@cf/bytedance/stable-diffusion-xl-lightning',
    size: [1024, 680],
    settings: { strength: 0.45, num_steps: 8, guidance: 1 },
  },
  {
    name: 'sd-inpainting',
    model: '@cf/runwayml/stable-diffusion-v1-5-inpainting',
    size: [768, 512],
    settings: { strength: 0.75, num_steps: 20, guidance: 7.5 },
    mask: true,
  },
] as const;

const scene = await loadScene(SCENE);
const capture = join(scene.dir, 'capture.png');
for (const m of MODELS) {
  const base = resultBase(m.name, SCENE, SEED);
  if (existsSync(`${base}.png`)) continue;
  const [width, height] = m.size;
  const image = await sharp(capture).resize(width, height, { fit: 'fill' }).removeAlpha().png().toBuffer();
  let mask: Buffer | undefined;
  if ('mask' in m) {
    const { width: w, height: h, data, outside } = scene.mask;
    const paint = Buffer.alloc(w * h);
    for (let i = 0; i < w * h; i++)
      paint[i] = data[i] && data[i] !== FIXTURE_REGION && !outside?.[i] ? 255 : 0;
    mask = await sharp(paint, { raw: { width: w, height: h, channels: 1 } })
      .resize(width, height, { fit: 'fill', kernel: 'nearest' })
      .png()
      .toBuffer();
  }
  const input = {
    prompt: SD_PROMPT,
    negative_prompt: SD_NEGATIVE,
    image_b64: image.toString('base64'),
    ...(mask ? { mask: [...mask] } : {}),
    width,
    height,
    seed: SEED,
    ...m.settings,
  };
  if (process.argv.includes('--dry')) {
    console.log(m.name, width, height, mask ? `mask ${mask.length} bytes` : '');
    continue;
  }
  mkdirSync(join(base, '..'), { recursive: true });
  try {
    const {
      image: out,
      result,
      ms,
    } = await jsonCall(
      {
        round: 'r2',
        method: m.name,
        scene: SCENE,
        seed: SEED,
        model: m.model,
        estimate: 100,
        sizes: { input: [width, height], ...m.settings, mask: !!mask },
      },
      input,
    );
    if (!out) throw new Error(`no image: ${JSON.stringify(result).slice(0, 300)}`);
    await sharp(out).png().toFile(`${base}.png`);
    const meta = await sharp(out).metadata();
    writeFileSync(
      `${base}.json`,
      JSON.stringify(
        {
          round: 'r2',
          method: m.name,
          model: m.model,
          ms,
          size: [meta.width, meta.height],
          settings: m.settings,
          mask: !!mask,
          prompt: SD_PROMPT,
          negative: SD_NEGATIVE,
        },
        null,
        1,
      ),
    );
    console.log('ok', m.name, `${ms} ms`, meta.width, meta.height);
  } catch (error) {
    if (error instanceof StopRun) {
      console.error('STOP', error.message);
      if (error.message.startsWith('daily limit')) process.exit(2);
      continue; // that model is stopped; the others still get their one call
    }
    console.error(m.name, String(error).slice(0, 300));
  }
}
