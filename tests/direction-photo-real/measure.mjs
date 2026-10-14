// How closely each answer of a real run (tests/direction-photo-real/run.mjs) follows its guide: the
// product's outline (everything not plain white, the faint shadow left out) is cut to its box, both
// outlines are scaled to the same box, and their overlap (IoU) and the boxes' aspect ratios are compared.
// The same measure is taken of the 2026-10-13 trial's answers when they are there (bath run only).
// No AI call.
// Usage: [AI_OUT=test-results/direction-photo-bear/baseline] node tests/direction-photo-real/measure.mjs
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const OUT = process.env.AI_OUT ?? 'test-results/direction-photo-real';
const TRIAL = 'test-results/product-representation/real/gen';
const SIZE = 128;
/** The outline as a SIZE × SIZE mask of its own box, its box's aspect, and how much of the frame it fills. */
export async function outline(file) {
  const { data, info } = await sharp(file)
    .flatten({ background: '#ffffff' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const solid = (i) => data[i] < 236;
  let left = width,
    right = -1,
    top = height,
    bottom = -1;
  for (let i = 0; i < width * height; i++)
    if (solid(i)) {
      const x = i % width,
        y = Math.floor(i / width);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  const boxWidth = right - left + 1,
    boxHeight = bottom - top + 1;
  const mask = await sharp(
    Buffer.from(Uint8Array.from({ length: width * height }, (_, i) => (solid(i) ? 255 : 0))),
    { raw: { width, height, channels: 1 } },
  )
    .extract({ left, top, width: boxWidth, height: boxHeight })
    .resize(SIZE, SIZE, { fit: 'fill' })
    .raw()
    .toBuffer();
  return { mask, aspect: boxWidth / boxHeight, fill: Math.max(boxWidth / width, boxHeight / height) };
}
export function iou(a, b) {
  let both = 0,
    either = 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i] > 127,
      q = b[i] > 127;
    if (p && q) both++;
    if (p || q) either++;
  }
  return both / either;
}
/** One row per answer: its outline against its guide's. */
export async function compare(set, guideFile, answerFiles) {
  const guide = await outline(guideFile);
  const rows = [];
  for (const file of answerFiles) {
    const answer = await outline(file);
    rows.push({
      set,
      answer: file.split('/').pop(),
      aspectGuide: Number(guide.aspect.toFixed(2)),
      aspect: Number(answer.aspect.toFixed(2)),
      iou: Number(iou(guide.mask, answer.mask).toFixed(3)),
      fill: Number(answer.fill.toFixed(2)),
    });
  }
  return rows;
}
const NAMES = { front: '정면', left: '왼쪽', right: '오른쪽', back: '뒤' };

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const rows = [];
  const answers = readdirSync(`${OUT}/answers`).sort();
  for (const [direction, guide] of Object.entries(NAMES)) {
    const files = answers.filter((name) => name.includes(`-${direction}-`));
    if (files.length && existsSync(`${OUT}/guide-${guide}.png`))
      rows.push(
        ...(await compare(
          'real',
          `${OUT}/guide-${guide}.png`,
          files.map((name) => `${OUT}/answers/${name}`),
        )),
      );
  }
  if (!process.env.AI_OUT && existsSync(`${TRIAL}/guide3d-front-496x224.png`)) {
    const trial = readdirSync(TRIAL);
    rows.push(
      ...(await compare(
        'trial',
        `${TRIAL}/guide3d-front-496x224.png`,
        trial.filter((name) => /^4b-guide-front-/.test(name)).map((name) => `${TRIAL}/${name}`),
      )),
      ...(await compare(
        'trial',
        `${TRIAL}/guide3d-left-432x496.png`,
        trial.filter((name) => /^4b-guide-left-/.test(name)).map((name) => `${TRIAL}/${name}`),
      )),
    );
  }
  console.table(rows);
  writeFileSync(`${OUT}/measure.json`, JSON.stringify(rows, null, 2));
}
