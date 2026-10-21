// The side-view trials' machine grader: a local vision model (Ollama, 127.0.0.1 only) says whether an
// answer is a true side view, nearly one or turned, so a wide screen can be thinned before the grading
// by eye (docs/direction-photo-explore-results-20261021.md). No FLUX call, nothing sent off the PC.
//
// node tests/direction-photo-real/side-vlm.mjs <out.json> <grades.json | answer.png> ...
// - Each answer once (kept in <out.json> by file: a second run asks only the new ones): the model's
//   grade in side-grade.mjs's words (옆, 살짝 사선, 사선), its raw answer and the time it took.
// - Graded rows given (side-grade.mjs's grades.json): the agreement with the eye, for the three grades
//   and for 옆 against the rest, with the side views missed and the slanted ones passed.
// Env: SIDE_VLM_MODEL (qwen3-vl:4b-instruct-q4_K_M), SIDE_VLM_PAIR=1 (the guide sent beside the
// answer), SIDE_VLM_EDGE (the long edge sent, 480).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const MODEL = process.env.SIDE_VLM_MODEL ?? 'qwen3-vl:4b-instruct-q4_K_M';
const PAIR = process.env.SIDE_VLM_PAIR === '1';
const EDGE = Number(process.env.SIDE_VLM_EDGE ?? 480);
const NAMES = { front: '정면', left: '왼쪽', right: '오른쪽' };
const GRADES = { side: '옆', 'slightly turned': '살짝 사선', angled: '사선' };

const ALONE = `This is a studio product photo of a toilet. How is the toilet seen?
- "side": a pure side profile. The bowl end is at one edge of the picture and the back at the other; you see only the outer side wall of the bowl. The front of the bowl, the inside of the seat ring and the far side are not visible.
- "slightly turned": almost a side profile, but turned a little toward the camera: a thin strip of the bowl's front, of the seat ring's inside or of the far side shows.
- "angled": clearly a three-quarter or front view: the front of the bowl or the seat opening is plainly visible.
Answer with JSON only.`;
const BESIDE = `Image 1 is a grey 3D render of a toilet seen exactly from the side. Image 2 is a product photo made from it. Is image 2 seen from the same pure side angle as image 1?
- "side": the same pure side profile as image 1: only the outer side wall of the bowl shows.
- "slightly turned": almost, but turned a little toward the camera: a thin strip of the bowl's front, of the seat ring's inside or of the far side shows that image 1 does not show.
- "angled": clearly turned: a three-quarter or front view, the front of the bowl or the seat opening plainly visible.
Answer with JSON only.`;
const FORMAT = {
  type: 'object',
  properties: { view: { type: 'string', enum: Object.keys(GRADES) } },
  required: ['view'],
};

/** An image as base64 PNG, its long edge EDGE, on white. */
async function encoded(file) {
  const png = await sharp(file)
    .flatten({ background: '#ffffff' })
    .resize(EDGE, EDGE, { fit: 'inside' })
    .png()
    .toBuffer();
  return png.toString('base64');
}

/** The guide a run sent for a view: the one sent, else the one drawn (side-grade.mjs). */
function guideOf(run, view) {
  for (const file of [`${run}/sent-guide-${view}.png`, `${run}/guide-${NAMES[view]}.png`])
    if (existsSync(file)) return file;
  throw new Error(`${run}: ${view} 가이드 없음`);
}

/** The run folder and view of an answer at <run>/answers/<n>-<view>-<seed>.png. */
function placeOf(file) {
  const [run, name] = file.replace(/\\/g, '/').split('/answers/');
  return { run, view: name.split('-')[1] };
}

async function ask(row) {
  const images = [await encoded(row.file)];
  if (PAIR) {
    const { run, view } = row.run && row.view ? row : placeOf(row.file);
    images.unshift(await encoded(guideOf(run, view)));
  }
  const started = Date.now();
  const response = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: PAIR ? BESIDE : ALONE, images }],
      stream: false,
      format: FORMAT,
      options: { temperature: 0, seed: 0 },
    }),
  });
  if (!response.ok) throw new Error(`Ollama ${response.status}: ${await response.text()}`);
  const raw = (await response.json()).message.content;
  return { vlm: GRADES[JSON.parse(raw).view] ?? null, raw, ms: Date.now() - started };
}

/** Counts of the grade pairs, and how often 옆 against the rest agrees. */
function agreement(rows) {
  const graded = rows.filter((row) => row.grade && row.vlm);
  const confusion = {};
  for (const row of graded) {
    const key = `${row.grade} → ${row.vlm}`;
    confusion[key] = (confusion[key] ?? 0) + 1;
  }
  const same = graded.filter((row) => row.grade === row.vlm).length;
  const sideSame = graded.filter((row) => (row.grade === '옆') === (row.vlm === '옆')).length;
  return {
    count: graded.length,
    three: Number((same / graded.length).toFixed(3)),
    side: Number((sideSame / graded.length).toFixed(3)),
    sideMissed: graded.filter((row) => row.grade === '옆' && row.vlm !== '옆').length,
    slantPassed: graded.filter((row) => row.grade !== '옆' && row.vlm === '옆').length,
    confusion,
  };
}

const [out, ...inputs] = process.argv.slice(2);
if (!out || !inputs.length) {
  console.error('사용: node side-vlm.mjs <out.json> <grades.json | answer.png> ...');
  process.exit(1);
}
const rows = inputs.flatMap((input) =>
  input.endsWith('.json') ? JSON.parse(readFileSync(input, 'utf8')) : [{ file: input }],
);
const done = new Map(
  existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')).rows.map((row) => [row.file, row]) : [],
);
for (const row of rows) {
  const old = done.get(row.file);
  if (old?.vlm && old.model === MODEL && old.pair === PAIR) Object.assign(row, old, { grade: row.grade });
  else {
    Object.assign(row, await ask(row), { model: MODEL, pair: PAIR });
    console.log(`${row.file} ${row.grade ?? '-'} → ${row.vlm} ${row.ms}ms`);
  }
  done.set(row.file, row);
}
const result = { model: MODEL, pair: PAIR, edge: EDGE, agreement: agreement(rows), rows };
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result.agreement, null, 2));
