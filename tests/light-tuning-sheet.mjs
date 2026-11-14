// Side-by-side pictures of light-tuning variants (no AI call): one row a scene, one column a variant,
// each the whole picture and, under it, a close-up of the back wall at twice its pixels.
//
//   node tests/light-tuning-sheet.mjs --view capture --scenes scored,subway --variants base,L1 [--name a]
//        [--labels "지금,후보 A"] [--crop 0.42,0.3,0.58,0.45]
// Output: test-results/light-tuning/sheets/<name>-<view>.png
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { ROOT } from './tile-ai/paths.mjs';

const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const OUT = join(ROOT, 'test-results', 'light-tuning');
const view = arg('view', 'capture');
const scenes = arg('scenes', 'scored').split(',');
const variants = arg('variants', 'base').split(',');
const labels = arg('labels', variants.join(',')).split(',');
const name = arg('name', 'sheet');
const crop = arg('crop', '0.4,0.32,0.6,0.5').split(',').map(Number);
const W = 560,
  label = 30;
const text = (value, width, bg = '#222') =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${label}"><rect width="100%" height="100%" fill="${bg}"/><text x="10" y="21" font-family="Malgun Gothic, sans-serif" font-size="17" fill="#fff">${value.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text></svg>`,
  );
const parts = [];
let top = 0,
  height = 0;
for (const [r, scene] of scenes.entries()) {
  const first = join(OUT, variants[0], `${scene}-${view}.png`);
  const meta = await sharp(first).metadata();
  const H = Math.round((W * meta.height) / meta.width);
  const box = {
    left: Math.round(crop[0] * meta.width),
    top: Math.round(crop[1] * meta.height),
    width: Math.round((crop[2] - crop[0]) * meta.width),
    height: Math.round((crop[3] - crop[1]) * meta.height),
  };
  const C = Math.round((W * box.height) / box.width);
  for (const [c, variant] of variants.entries()) {
    const file = join(OUT, variant, `${scene}-${view}.png`);
    parts.push({ input: text(`${scene} · ${labels[c] ?? variant}`, W), left: c * W, top });
    parts.push({ input: await sharp(file).resize(W, H).png().toBuffer(), left: c * W, top: top + label });
    parts.push({
      input: await sharp(file).extract(box).resize(W, C, { kernel: 'nearest' }).png().toBuffer(),
      left: c * W,
      top: top + label + H,
    });
  }
  top += label + H + C + 6;
  height = top;
  void r;
}
mkdirSync(join(OUT, 'sheets'), { recursive: true });
const out = join(OUT, 'sheets', `${name}-${view}.png`);
await sharp({ create: { width: variants.length * W, height, channels: 3, background: '#666666' } })
  .composite(parts)
  .png()
  .toFile(out);
console.log(out);
