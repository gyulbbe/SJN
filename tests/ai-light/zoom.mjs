// Crops one region (fractions of the picture) of each keep level side by side, at 2× size.
// Usage: node tests/ai-light/zoom.mjs <pictures dir> <out.jpg> <id> <x0> <y0> <x1> <y1>
import sharp from 'sharp';
const [dir, out, id, ...box] = process.argv.slice(2);
const [x0, y0, x1, y1] = box.map(Number);
const tiles = [];
for (const k of ['k100', 'k50', 'k25']) {
  const image = sharp(`${dir}/${id}.${k}.png`);
  const { width, height } = await image.metadata();
  const left = Math.round(x0 * width),
    top = Math.round(y0 * height);
  const w = Math.round((x1 - x0) * width),
    h = Math.round((y1 - y0) * height);
  tiles.push(
    await image
      .extract({ left, top, width: w, height: h })
      .resize({ width: w * 2 })
      .png()
      .toBuffer(),
  );
}
const { width: W, height: H } = await sharp(tiles[0]).metadata();
await sharp({ create: { width: 3 * W + 8, height: H, channels: 3, background: '#fff' } })
  .composite(tiles.map((t, i) => ({ input: t, left: i * (W + 4), top: 0 })))
  .jpeg({ quality: 88 })
  .toFile(out);
