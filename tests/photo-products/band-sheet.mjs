// Per scene and seed: the design, the model's picture, today's app view and the app view with the
// fixture band (pictures-b<N>), cropped. Usage:
//   node tests/photo-products/band-sheet.mjs <out.jpg> <band> <method> <x0,y0,x1,y1> <scene-seed> ...
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { OUT, PHOTOS_RESULTS, PHOTOS_SCENE } from './paths.mjs';

const [out, band, method, boxArg, ...ids] = process.argv.slice(2);
const box = boxArg.split(',').map(Number);
const W = 460,
  GAP = 6;
const comp = [];
let y = 0;
for (const id of ids) {
  const [scene, seed] = id.split('-');
  const design = join(scene === 'photos' ? PHOTOS_SCENE : join(OUT, 'scenes', scene), 'capture.png');
  const raw =
    scene === 'photos' && method === 'cur'
      ? join(PHOTOS_RESULTS, 'names-end', `photos-${seed}.png`)
      : join(OUT, 'results', method, `${scene}-${seed}.png`);
  const files = [
    design,
    raw,
    join(OUT, 'pictures', `${scene}-${method}-${seed}.p0.png`),
    ...band.split(',').map((b) => join(OUT, `pictures-b${b}`, `${scene}-${method}-${seed}.p0.png`)),
  ];
  let h = 0;
  for (const [k, file] of files.entries()) {
    if (!existsSync(file)) throw new Error(`missing ${file}`);
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
await sharp({
  create: {
    width: (3 + band.split(',').length) * (W + GAP) - GAP,
    height: y - GAP,
    channels: 3,
    background: '#fff',
  },
})
  .composite(comp)
  .jpeg({ quality: 88 })
  .toFile(out);
