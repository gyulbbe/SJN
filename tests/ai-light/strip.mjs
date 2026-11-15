import sharp from 'sharp';
const [dir, out, ...ids] = process.argv.slice(2);
const W = 640;
const rows = [];
for (const id of ids) {
  const tiles = [];
  for (const k of ['k100', 'k50', 'k25'])
    tiles.push(await sharp(`${dir}/${id}.${k}.png`).resize({ width: W }).png().toBuffer());
  const meta = await sharp(tiles[0]).metadata();
  rows.push({ tiles, h: meta.height });
}
const H = rows.reduce((s, r) => s + r.h + 4, 0);
const comp = [];
let y = 0;
for (const r of rows) {
  r.tiles.forEach((t, i) => comp.push({ input: t, left: i * (W + 4), top: y }));
  y += r.h + 4;
}
await sharp({ create: { width: 3 * W + 8, height: H, channels: 3, background: '#fff' } })
  .composite(comp)
  .jpeg({ quality: 85 })
  .toFile(out);
