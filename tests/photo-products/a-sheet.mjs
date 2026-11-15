// Per scene and seed: the design, the model's empty room, today's app view and the empty-room method
// composed, cropped. Usage: node tests/photo-products/a-sheet.mjs <out.jpg> <x0,y0,x1,y1> <scene-seed> ...
import { join } from 'node:path';
import sharp from 'sharp';
import { OUT, PHOTOS_SCENE } from './paths.mjs';

const [out, boxArg, ...ids] = process.argv.slice(2);
const box = boxArg.split(',').map(Number);
const W = 460,
  GAP = 6;
const comp = [];
let y = 0;
for (const id of ids) {
  const [scene, seed] = id.split('-');
  const files = [
    join(scene === 'photos' ? PHOTOS_SCENE : join(OUT, 'scenes', scene), 'capture.png'),
    join(OUT, 'results', 'a', `${scene}-${seed}.png`),
    join(OUT, 'pictures', `${scene}-cur-${seed}.p0.png`),
    join(OUT, 'pictures-a', `${scene}-a-${seed}.png`),
  ];
  let h = 0;
  for (const [k, file] of files.entries()) {
    const image = sharp(file);
    const { width, height } = await image.metadata();
    const tile = await image
      .extract({
        left: Math.round(box[0] * width),
        top: Math.round(box[1] * height),
        width: Math.round((box[2] - box[0]) * width),
        height: Math.round((box[3] - box[1]) * height),
      })
      .resize({ width: W })
      .png()
      .toBuffer();
    h = Math.max(h, (await sharp(tile).metadata()).height);
    comp.push({ input: tile, left: k * (W + GAP), top: y });
  }
  y += h + GAP;
}
await sharp({ create: { width: 4 * (W + GAP) - GAP, height: y - GAP, channels: 3, background: '#fff' } })
  .composite(comp)
  .jpeg({ quality: 88 })
  .toFile(out);
