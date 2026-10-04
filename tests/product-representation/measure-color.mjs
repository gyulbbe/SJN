// Wall and floor colour change of each AI answer, no AI call: the mean CIE L*a*b* (D65) of a wall patch and a
// floor patch that no product covers, in the picture sent to the model (call1-image) and in the model's
// own raw answer (call1-answer, 992x672, shrunk to the input grid). The app measures whole faces with a
// face mask; these are fixed patches picked on the input (grid pictures in the report), so they agree on
// direction and size, not to the digit. Usage: node tests/product-representation/measure-color.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
const A = 'test-results/product-representation/ai';
const lin = (v) => {
  v /= 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
function lab([r, g, b]) {
  const R = lin(r),
    G = lin(g),
    B = lin(b);
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  const Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f(X),
    fy = f(Y),
    fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
const W = 496,
  H = 336;
async function roomBox(file) {
  const { data } = await sharp(file)
    .resize(W, H, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let x0 = W,
    y0 = H,
    x1 = 0,
    y1 = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x + 1);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y + 1);
      }
    }
  return [x0, y0, x1, y1];
}
async function patchLab(file, rects, box) {
  const { data } = await sharp(file)
    .resize(W, H, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sum = [0, 0, 0],
    n = 0;
  const [bx0, by0, bx1, by1] = box;
  for (const [fx0, fy0, fx1, fy1] of rects)
    for (let y = Math.round(by0 + fy0 * (by1 - by0)); y < Math.round(by0 + fy1 * (by1 - by0)); y++)
      for (let x = Math.round(bx0 + fx0 * (bx1 - bx0)); x < Math.round(bx0 + fx1 * (bx1 - bx0)); x++) {
        const i = (y * W + x) * 3;
        const l = lab([data[i], data[i + 1], data[i + 2]]);
        sum = sum.map((v, k) => v + l[k]);
        n++;
      }
  return sum.map((v) => +(v / n).toFixed(1));
}
// Patches as fractions [x0, y0, x1, y1] of the room's bounding box (the non-white part of the input), so that
// every input is read at the same places even though its framing differs a little.
const PATCH = {
  정면: { wall: [[0.25, 0.16, 0.75, 0.4]], floor: [[0.15, 0.955, 0.85, 0.99]] },
  위에서: {
    wall: [
      [0.17, 0.025, 0.83, 0.115],
      [0.89, 0.16, 0.98, 0.84],
    ],
    floor: [[0.16, 0.78, 0.84, 0.86]],
  },
};
const RUNS = [
  { name: 'R1 지금 방식', dir: 'R1-now', view: '정면', tag: '지금_방식-정면' },
  { name: 'R2 지금 방식', dir: 'R2-now-front', view: '정면', tag: '지금_방식-정면' },
  { name: 'R2 실험 C(빈 방 답)', dir: 'R2-C-front-b', view: '정면', tag: '실험_C_제품별_다듬기-정면' },
  { name: 'R1 지금 방식', dir: 'R1-now-top', view: '위에서', tag: '지금_방식-위에서' },
  { name: 'R2 지금 방식', dir: 'R2-now-top', view: '위에서', tag: '지금_방식-위에서' },
  { name: 'R2 실험 C(빈 방 답)', dir: 'R2-C-top', view: '위에서', tag: '실험_C_제품별_다듬기-위에서' },
];
const out = [];
for (const run of RUNS) {
  const calls = JSON.parse(readFileSync(`${A}/${run.dir}/${run.tag}-calls.json`, 'utf8')).calls;
  const room = calls.find((c) => c.url === '/api/export/photoreal');
  const base = `${A}/${run.dir}/${run.tag}-call${room.index}`;
  const answerFile = ['jpg', 'png', 'webp']
    .map((e) => `${base}-answer.${e}`)
    .find((f) => {
      try {
        readFileSync(f);
        return true;
      } catch {
        return false;
      }
    });
  const box = await roomBox(`${base}-image.png`);
  const row = { run: run.name, view: run.view, box };
  for (const face of ['wall', 'floor']) {
    const before = await patchLab(`${base}-image.png`, PATCH[run.view][face], box);
    const after = await patchLab(answerFile, PATCH[run.view][face], box);
    row[face] = {
      input: before,
      answer: after,
      dL: +(after[0] - before[0]).toFixed(1),
      da: +(after[1] - before[1]).toFixed(1),
      db: +(after[2] - before[2]).toFixed(1),
    };
  }
  out.push(row);
  console.log(
    run.view,
    run.name.padEnd(18),
    'wall L*',
    row.wall.input[0],
    '->',
    row.wall.answer[0],
    `(${row.wall.dL >= 0 ? '+' : ''}${row.wall.dL})`,
    '| floor L*',
    row.floor.input[0],
    '->',
    row.floor.answer[0],
    `(${row.floor.dL >= 0 ? '+' : ''}${row.floor.dL})`,
    '| wall da/db',
    row.wall.da,
    row.wall.db,
    'floor da/db',
    row.floor.da,
    row.floor.db,
  );
}
writeFileSync('test-results/product-representation/color-measure.json', JSON.stringify(out, null, 1));
