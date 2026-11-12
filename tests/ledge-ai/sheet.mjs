// Contact sheets of the ledge AI trial's results (no AI call): for each scene one picture, the model
// input first and then each method's answer for each seed, labelled. For looking, not for scoring.
//
//   node tests/ledge-ai/sheet.mjs --group local --methods cur,w-ledge --scenes thin-l [--seeds 424242]
//        [--name r2] [--holdout] [--cell 496]
// Output: test-results/ledge-ai-20261111/sheets/<name>-<scene>.png
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { HOLDOUT, OUT, RESULTS, SCENES } from './paths.mjs';

const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const group = arg('group', 'local');
const methods = arg('methods').split(',').filter(Boolean);
const scenes = arg('scenes').split(',').filter(Boolean);
const seeds = arg('seeds', '424242').split(',').map(Number);
const name = arg('name', group);
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
  const cells = [{ title: `${scene} · 입력`, file: join(dir, 'input.png') }];
  for (const method of methods)
    for (const seed of seeds) {
      const file = join(RESULTS, group, method, `${scene}-${seed}.png`);
      if (existsSync(file)) cells.push({ title: `${method} · ${seed}`, file });
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
