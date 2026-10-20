// The side-view trial's grading aid (docs/toilet-side-view-results-20261021.md): no AI call.
//
// - sheet <out.png> <run folder>[:views] ...: the answers of the runs (left and right unless views are
//   given, e.g. :right), numbered, each with its outline against the guide it was sent: the box's
//   aspect over the guide's (a side view turned toward the camera gets narrower) and the overlap
//   (measure.mjs). The numbers and the files go to <out>.json, the grades are written by eye beside them.
// - table <grades.json> ...: the grades counted per product, view and side (near the photo or far),
//   and how well the aspect ratio alone tells a side view from a slanted one at each cut-off (R8).
//
// A grade is 옆 (a true side view), 살짝 사선 (nearly, a little of the bowl's front, the seat's inside or
// the far side seen) or 사선 (turned like the photo, near the front, or its front the wrong way).
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { compare } from './measure.mjs';

const NAMES = { front: '정면', left: '왼쪽', right: '오른쪽' };
const CELL = Number(process.env.SIDE_CELL ?? 240),
  CAP = 22,
  GAP = 6,
  COLS = Number(process.env.SIDE_COLS ?? 6);

/** The guide a run sent for a view: the one sent, else the one drawn. */
function guideOf(run, view) {
  for (const file of [`${run}/sent-guide-${view}.png`, `${run}/guide-${NAMES[view]}.png`])
    if (existsSync(file)) return file;
  throw new Error(`${run}: ${view} 가이드 없음`);
}

/** Every answer of the runs asked for, with its numbers. */
export async function measureRuns(specs) {
  const rows = [];
  for (const spec of specs) {
    const [run, views = 'left,right'] = spec.split(':');
    for (const view of views.split(',')) {
      const files = readdirSync(`${run}/answers`)
        .filter((name) => name.includes(`-${view}-`))
        .sort();
      if (!files.length) continue;
      for (const row of await compare(
        run,
        guideOf(run, view),
        files.map((name) => `${run}/answers/${name}`),
      ))
        rows.push({
          file: `${run}/answers/${row.answer}`,
          run,
          view,
          seed: row.answer
            .replace(/\.png$/, '')
            .split('-')
            .pop(),
          aspect: row.aspect,
          aspectGuide: row.aspectGuide,
          ratio: Number((row.aspect / row.aspectGuide).toFixed(3)),
          iou: row.iou,
        });
    }
  }
  return rows;
}

const label = (text, width, fill = '#222', size = 12) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${CAP}"><rect width="100%" height="100%" fill="${fill}"/><text x="4" y="15" font-family="Malgun Gothic, sans-serif" font-size="${size}" fill="#fff">${text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</text></svg>`,
  );

async function sheet(out, specs) {
  const rows = await measureRuns(specs);
  const layers = [];
  for (const [index, row] of rows.entries()) {
    const left = (index % COLS) * (CELL + GAP),
      top = Math.floor(index / COLS) * (CELL + 2 * CAP + GAP);
    const short = row.run.split('/').slice(-1)[0];
    layers.push({ input: label(`#${index + 1} ${short}`, CELL, '#333', 11), left, top });
    layers.push({
      input: await sharp(row.file)
        .resize(CELL, CELL, { fit: 'contain', background: '#ffffff' })
        .flatten({ background: '#ffffff' })
        .png()
        .toBuffer(),
      left,
      top: top + CAP,
    });
    layers.push({
      input: label(`${NAMES[row.view]} ${row.seed} · 비 ${row.ratio} · 겹침 ${row.iou.toFixed(2)}`, CELL),
      left,
      top: top + CAP + CELL,
    });
  }
  const height = Math.ceil(rows.length / COLS) * (CELL + 2 * CAP + GAP);
  await sharp({ create: { width: COLS * (CELL + GAP), height, channels: 3, background: '#bbbbbb' } })
    .composite(layers)
    .png()
    .toFile(out);
  writeFileSync(out.replace(/\.png$/, '.json'), JSON.stringify(rows, null, 2));
  console.log(out, rows.length);
}

/** Counts per group, and the aspect cut-offs that tell 옆 from the slanted grades. */
function table(files) {
  const rows = files.flatMap((file) => JSON.parse(readFileSync(file, 'utf8')));
  const graded = rows.filter((row) => row.grade);
  const groups = new Map();
  for (const row of graded) {
    const key = `${row.product ?? '?'} ${NAMES[row.view]}${row.near === undefined ? '' : row.near ? '(가까운 쪽)' : '(먼 쪽)'}`;
    const count = groups.get(key) ?? { 옆: 0, '살짝 사선': 0, 사선: 0 };
    count[row.grade]++;
    groups.set(key, count);
  }
  console.log('| 묶음 | 옆 | 살짝 사선 | 사선 |\n| --- | --- | --- | --- |');
  for (const [key, count] of groups)
    console.log(`| ${key} | ${count['옆']} | ${count['살짝 사선']} | ${count['사선']} |`);
  // R8: "not a side view" when the cue is below the cut. Hit = slanted caught, false alarm = a side
  // view flagged; the aspect ratio and the outline overlap, each alone.
  const of = (grade) => graded.filter((row) => row.grade === grade);
  for (const [cue, name, from, to, step] of [
    ['ratio', '비', 0.8, 1.0, 0.02],
    ['iou', '겹침', 0.6, 0.86, 0.02],
  ]) {
    console.log(
      `\n| 경계(${name} <) | 사선 잡음 | 살짝 사선 잡음 | 옆을 잘못 잡음 |\n| --- | --- | --- | --- |`,
    );
    for (let cut = from; cut <= to + 1e-9; cut += step) {
      const below = (grade) => `${of(grade).filter((r) => r[cue] < cut).length}/${of(grade).length}`;
      console.log(`| ${cut.toFixed(2)} | ${below('사선')} | ${below('살짝 사선')} | ${below('옆')} |`);
    }
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === 'sheet') await sheet(rest[0], rest.slice(1));
  else if (mode === 'table') table(rest);
  else throw new Error('sheet <out.png> <run[:views]>... 또는 table <grades.json>...');
}
