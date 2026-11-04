/**
 * Round 2 (no AI call): how much the inpainting result changed the pixels its mask protected (the
 * fixtures), against the render, on the capture's grid. The trial's rule: more than 10 on average
 * (0–255, RGB) means the mask was not kept.
 *
 * Usage: node tests/run-browser-test.mjs tests/export-photoreal/mask-check.ts
 */
import { writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { FIXTURE_REGION } from '../../src/lib/ai-export/color';
import { loadScene, resultBase } from './io';

const scene = await loadScene('white');
const { width, height, data } = scene.mask;
const out: Record<string, unknown> = {};
for (const method of ['sd-inpainting', 'sd-dreamshaper', 'current']) {
  const base = resultBase(method, 'white', 424242);
  const cap = await sharp(`${scene.dir}/capture.png`)
    .resize(width, height, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer();
  // The SD answers cover the whole capture (no padding); FLUX's restored answer is mapped the same way here.
  const res = await sharp(`${base}.png`)
    .resize(width, height, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer();
  let sum = 0,
    n = 0;
  for (let i = 0; i < width * height; i++)
    if (data[i] === FIXTURE_REGION) {
      for (let c = 0; c < 3; c++) sum += Math.abs(cap[i * 3 + c] - res[i * 3 + c]);
      n += 3;
    }
  out[method] = { fixturePixels: n / 3, meanAbs: +(sum / n).toFixed(1) };
}
writeFileSync(`${scene.dir}/../../results/sd-inpainting/mask-check.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out));
