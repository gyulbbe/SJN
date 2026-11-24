// Item 5's look sheet (no AI call): per scene and seed one row of the app picture and the raw answers
// under each sentence, all at the answer's size, for my own look before the blind pairs.
//   node tests/olive-name/sheet.mjs [--only olive-0-424242,...]
// Output: test-results/olive-name-20261124/sheets/<scene-seed>.png
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { OUT, SENTENCES } from './prepare.mjs';

const at = process.argv.indexOf('--only');
const only = at > 0 ? process.argv[at + 1].split(',') : undefined;
const revs = Object.keys(SENTENCES);
mkdirSync(join(OUT, 'sheets'), { recursive: true });
for (const file of readdirSync(join(OUT, 'cur', 'raw')).filter((f) => f.endsWith('.png'))) {
  const id = file.slice(0, -4);
  if (only && !only.includes(id)) continue;
  const scene = id.replace(/-\d+$/, '');
  const { width, height } = await sharp(join(OUT, 'cur', 'raw', file)).metadata();
  const tiles = [
    join(OUT, 'cur', 'scenes', scene, 'capture.png'),
    ...revs.map((r) => join(OUT, r, 'raw', file)),
  ];
  const parts = await Promise.all(
    tiles.map((t) => sharp(t).removeAlpha().resize(width, height, { fit: 'fill' }).png().toBuffer()),
  );
  await sharp({ create: { width: width * parts.length, height, channels: 3, background: '#ffffff' } })
    .composite(parts.map((input, i) => ({ input, left: i * width, top: 0 })))
    .png()
    .toFile(join(OUT, 'sheets', `${id}.png`));
}
console.log('columns: app,', revs.join(', '));
