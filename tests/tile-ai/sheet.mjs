// Contact sheets of the tile AI trial (no AI call): for each scene one picture, first the scene's own
// files (the capture, an input variant, the tile sample) and then each method's answer for each seed,
// labelled. For looking, not for scoring.
//
//   node tests/tile-ai/sheet.mjs --name r1 --scenes scored,subway [--files capture.png,input-grout.png]
//        [--group local --methods cur,grout --seeds 424242] [--suffix .fixed] [--holdout] [--cell 496]
// Output: test-results/tile-ai-20261113/sheets/<name>-<scene>.png
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { HOLDOUT, OUT, RESULTS, SCENES } from './paths.mjs';

const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const list = (name, fallback = '') => arg(name, fallback).split(',').filter(Boolean);
const group = arg('group', 'local');
const methods = list('methods'),
  scenes = list('scenes'),
  files = list('files', 'capture.png'),
  seeds = list('seeds', '424242').map(Number);
const name = arg('name', group);
const suffix = arg('suffix');
const cell = Number(arg('cell', '496'));
const holdout = process.argv.includes('--holdout');
const height = Math.round((cell * 336) / 496),
  label = 26,
  perRow = Number(arg('per-row', '4'));
const text = (value) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="${label}"><rect width="100%" height="100%" fill="#222"/><text x="8" y="18" font-family="Malgun Gothic, sans-serif" font-size="15" fill="#fff">${value.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text></svg>`,
  );
mkdirSync(join(OUT, 'sheets'), { recursive: true });
for (const scene of scenes) {
  const dir = join(holdout ? HOLDOUT : SCENES, scene);
  const cells = files.map((file) => ({ title: `${scene} · ${file}`, file: join(dir, file) }));
  for (const method of methods)
    for (const seed of seeds) {
      const file = join(RESULTS, group, method, `${scene}-${seed}${suffix}.png`);
      if (existsSync(file)) cells.push({ title: `${method}${suffix} · ${seed}`, file });
    }
  const rows = Math.ceil(cells.length / perRow);
  const parts = [];
  for (const [index, item] of cells.entries()) {
    const left = (index % perRow) * cell,
      top = Math.floor(index / perRow) * (height + label);
    parts.push({ input: text(item.title), left, top });
    parts.push({
      input: await sharp(item.file)
        .resize(cell, height, { fit: 'contain', background: '#ffffff' })
        .png()
        .toBuffer(),
      left,
      top: top + label,
    });
  }
  const out = join(OUT, 'sheets', `${name}-${scene}.png`);
  await sharp({
    create: { width: perRow * cell, height: rows * (height + label), channels: 3, background: '#666666' },
  })
    .composite(parts)
    .png()
    .toFile(out);
  console.log(out);
}
