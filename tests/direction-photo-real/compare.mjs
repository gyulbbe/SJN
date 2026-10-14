// Side-by-side sheet of direction-photo runs (run.mjs or variants.ts): one row per run, its answers in
// the same order (direction, then seed), so the same seed lines up down a column; the guides of the
// first run and each run's outline overlap with its guide (IoU, measure.mjs) under each answer.
// Usage: node tests/direction-photo-real/compare.mjs <out.png> <run folder>... (AI_LABELS="a|b" names the rows)
import { existsSync, readdirSync } from 'node:fs';
import sharp from 'sharp';
import { compare } from './measure.mjs';

const [out, ...runs] = process.argv.slice(2);
if (!out || !runs.length) throw new Error('out.png와 실행 폴더를 주세요.');
const labels = process.env.AI_LABELS?.split('|') ?? runs.map((run) => run.split('/').pop());
const ORDER = ['front', 'left', 'right', 'back'];
const NAMES = { front: '정면', left: '왼쪽', right: '오른쪽', back: '뒤' };
const CELL = 220,
  LABEL = 22,
  HEAD = 180,
  GAP = 6;
const text = (value, width, height = LABEL, size = 13) =>
  sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#222"/><text x="6" y="${Math.min(height - 6, 16)}" font-family="Malgun Gothic, sans-serif" font-size="${size}" fill="#fff">${value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')}</text></svg>`,
    ),
  )
    .png()
    .toBuffer();
const fitted = async (file) =>
  sharp(file)
    .resize(CELL - 6, CELL - 6, { fit: 'contain', background: '#ffffff' })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer();
const answersOf = (run) =>
  readdirSync(`${run}/answers`)
    .map((name) => {
      const [, direction, seed] = name.replace(/\.png$/, '').split('-');
      return { name, direction, seed };
    })
    .sort(
      (a, b) => ORDER.indexOf(a.direction) - ORDER.indexOf(b.direction) || Number(a.seed) - Number(b.seed),
    );
const columns = [];
for (const run of runs)
  for (const answer of answersOf(run))
    if (!columns.some((c) => c.direction === answer.direction && c.seed === answer.seed))
      columns.push({ direction: answer.direction, seed: answer.seed });
columns.sort(
  (a, b) => ORDER.indexOf(a.direction) - ORDER.indexOf(b.direction) || Number(a.seed) - Number(b.seed),
);
const layers = [];
const width = HEAD + columns.length * (CELL + GAP);
// The first run's guides over their columns.
layers.push({ input: await text('가이드', HEAD - GAP, CELL + LABEL), left: 0, top: 0 });
for (const [index, column] of columns.entries()) {
  const guide = `${runs[0]}/guide-${NAMES[column.direction]}.png`;
  const left = HEAD + index * (CELL + GAP);
  layers.push({ input: await text(`${NAMES[column.direction]} · seed ${column.seed}`, CELL), left, top: 0 });
  if (existsSync(guide)) layers.push({ input: await fitted(guide), left: left + 3, top: LABEL + 3 });
}
for (const [r, run] of runs.entries()) {
  const top = (r + 1) * (CELL + LABEL + GAP);
  layers.push({ input: await text(labels[r] ?? run, HEAD - GAP, CELL + LABEL, 12), left: 0, top });
  const answers = answersOf(run);
  for (const [index, column] of columns.entries()) {
    const answer = answers.find((a) => a.direction === column.direction && a.seed === column.seed);
    if (!answer) continue;
    const file = `${run}/answers/${answer.name}`;
    const guide = `${run}/guide-${NAMES[column.direction]}.png`;
    const [row] = existsSync(guide) ? await compare(run, guide, [file]) : [];
    const left = HEAD + index * (CELL + GAP);
    layers.push({ input: await fitted(file), left: left + 3, top: top + 3 });
    layers.push({
      input: await text(
        row ? `윤곽 겹침 ${row.iou.toFixed(2)} · 비율 ${row.aspect}/${row.aspectGuide}` : '',
        CELL,
      ),
      left,
      top: top + CELL,
    });
  }
}
await sharp({
  create: { width, height: (runs.length + 1) * (CELL + LABEL + GAP), channels: 3, background: '#bbbbbb' },
})
  .composite(layers)
  .png()
  .toFile(out);
console.log(out);
