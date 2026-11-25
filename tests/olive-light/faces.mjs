// Backlog item 4 (the olive wall a little lighter than the design, L* about +9), no AI call: the app's
// finished results of saved answers, today's refine and trial tunings (refine.ts --tuning --suffix), face
// by face against the app picture (capture.png): each wall's and the floor's mean L* and chroma, the
// walls' share above L* 92 (reflections; light grout is about 84), and the bath front's dark patches
// (lower 60% of the bath box, % more than 12 L* below its median).
//   node tests/olive-light/faces.mjs [--sets refined,refined-b4,...]
// Output: test-results/olive-light-20261125/faces.json and a table on stdout
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { ROOT } from '../side-tile-ai/paths.mjs';

// The saved answers: main's prompt on today's inputs (Cloudflare and local) and the big-room scenes.
export const TREES = [
  { name: 'cf', dir: join(ROOT, 'test-results', 'olive-dark-cf-20261125', 'cur'), main: 'refined' },
  { name: 'local', dir: join(ROOT, 'test-results', 'olive-alt-20261125', 'cur'), main: 'refined' },
  { name: 'big', dir: join(ROOT, 'test-results', 'big-fixture-20261124', 'app'), main: 'refined-main' },
];
const at = process.argv.indexOf('--sets');
const sets = at > 0 ? process.argv[at + 1].split(',') : ['main', 'refined-b4', 'refined-b0'];
const OUT = join(ROOT, 'test-results', 'olive-light-20261125');
mkdirSync(OUT, { recursive: true });

const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
const lab = (r, g, b) => {
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047,
    Y = 0.2126 * R + 0.7152 * G + 0.0722 * B,
    Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
};
async function faces(image, dir) {
  const regions = JSON.parse(readFileSync(join(dir, 'regions.json'), 'utf8')).regions;
  const pic = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const mask = await sharp(join(dir, 'mask.png'))
    .extractChannel(0)
    .resize(pic.info.width, pic.info.height, { kernel: 'nearest' })
    .raw()
    .toBuffer();
  const acc = new Map();
  for (let i = 0; i < mask.length; i++) {
    const k = mask[i];
    if (!k || k === 255 || !regions[k - 1]) continue;
    const L = lab(pic.data[i * 3], pic.data[i * 3 + 1], pic.data[i * 3 + 2]);
    const a = acc.get(k) ?? { n: 0, L: 0, A: 0, B: 0, bright: 0 };
    a.n++;
    a.L += L[0];
    a.A += L[1];
    a.B += L[2];
    if (L[0] > 92) a.bright++;
    acc.set(k, a);
  }
  return [...acc]
    .sort((x, y) => x[0] - y[0])
    .map(([k, a]) => ({
      face: `${regions[k - 1].kind}${k}`,
      kind: regions[k - 1].kind,
      L: +(a.L / a.n).toFixed(1),
      C: +Math.hypot(a.A / a.n, a.B / a.n).toFixed(1),
      bright: +((100 * a.bright) / a.n).toFixed(2),
    }));
}
async function bathFront(image, dir) {
  const grounding = JSON.parse(readFileSync(join(dir, 'grounding.json'), 'utf8'));
  const bath = grounding.scene.fixtures.find((x) => x.kind === 'bath');
  if (!bath) return undefined;
  const layout = JSON.parse(readFileSync(join(dir, 'layout.json'), 'utf8')).layout;
  const pic = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = pic.info;
  const px = (nx, ny) => [
    Math.round(((layout.x + nx * layout.contentWidth) / layout.width) * W),
    Math.round(((layout.y + ny * layout.contentHeight) / layout.height) * H),
  ];
  const [l, t, r, b] = bath.box;
  const [x0, y0] = px(l + 0.01, t + 0.4 * (b - t));
  const [x1, y1] = px(r - 0.01, b - 0.01);
  const Ls = [];
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 3;
      Ls.push(lab(pic.data[i], pic.data[i + 1], pic.data[i + 2])[0]);
    }
  const median = [...Ls].sort((p, q) => p - q)[Ls.length >> 1];
  return +((100 * Ls.filter((v) => v < median - 12).length) / Ls.length).toFixed(2);
}
const rows = {};
const main = import.meta.url === pathToFileURL(process.argv[1]).href;
for (const tree of main ? TREES : []) {
  for (const file of readdirSync(join(tree.dir, tree.main)).filter((x) => x.endsWith('.png'))) {
    const id = file.slice(0, -4);
    const scene = id.replace(/-\d+$/, '');
    const dir = join(tree.dir, 'scenes', scene);
    const row = { design: await faces(join(dir, 'capture.png'), dir) };
    for (const set of sets) {
      const folder = set === 'main' ? tree.main : set;
      const image = join(tree.dir, folder, file);
      if (!existsSync(image)) continue;
      row[set] = { faces: await faces(image, dir), front: await bathFront(image, dir) };
    }
    rows[`${tree.name}/${id}`] = row;
    const cells = sets
      .filter((s) => row[s])
      .map((s) => {
        const d = row[s].faces.map((x, i) => `${x.kind[0]}${(x.L - row.design[i].L).toFixed(1)}`).join(' ');
        const b = row[s].faces.filter((x) => x.kind === 'wall').map((x) => x.bright);
        return `${s}: ${d} | b${(b.reduce((p, q) => p + q, 0) / b.length).toFixed(1)}${row[s].front !== undefined ? ` f${row[s].front}` : ''}`;
      });
    console.log(
      `${tree.name}/${id}`.padEnd(30),
      `L ${row.design.map((x) => x.L).join('/')}`.padEnd(22),
      cells.join('  ‖  '),
    );
  }
}
if (main) writeFileSync(join(OUT, 'faces.json'), JSON.stringify(rows, null, 1));
