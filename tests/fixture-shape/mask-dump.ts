/**
 * Prints the masks around a fixture's top edge, one character a pixel (no AI call): which pixels the
 * render calls fixture (r), the cut-out claims (c), both (#), and whether the outline mask kept them
 * as fixture (upper case / '#') or made them wall (lower case / '+'). '.' is wall in all.
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-shape/mask-dump.ts --set glare-diffsemi --id g-olive-0-424242-diffsemi --fixture 0 [--rows 14]
 */
import { projectMask, shiftMask, FIXTURE_REGION } from '../../src/lib/ai-export/color';
import { refineCurrentResult } from '../../src/lib/ai-export/current-refine';
import { haze, type HazeSet } from '../fixture-haze/sources';
import { loadInput } from '../fixture-shadows/load';

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const source = haze(arg('set') as HazeSet).find((s) => s.id === arg('id'));
if (!source) throw new Error('--set --id');
const k = Number(arg('fixture', '0'));
const loaded = await loadInput(source);
if (!loaded) throw new Error('framing');
const { input } = loaded;
const app = refineCurrentResult(input);
const { width, height } = input.raw;
const frame = app.review.framing;
const render = shiftMask(projectMask(input.mask, input.layout, { width, height }), frame.dx, frame.dy);
const claimed = new Uint8Array(width * height);
for (const cut of input.cuts.filter((c) => c.fixture === k))
  for (let y = 0; y < cut.height; y++)
    for (let x = 0; x < cut.width; x++)
      if (cut.alpha[y * cut.width + x] >= 128) claimed[(cut.top + y) * width + cut.left + x] = 1;
const mask = app.outline!.mask.data,
  colour = app.outline!.colourMask.data;
const [l, , r] = input.fixtures[k].box!;
let top = height;
for (let i = 0; i < width * height; i++)
  if ((claimed[i] || render.data[i] === FIXTURE_REGION) && i % width >= l * width && i % width <= r * width)
    top = Math.min(top, Math.floor(i / width));
const x0 = Math.floor(l * width) - 4,
  x1 = Math.ceil(r * width) + 4;
console.log('mask: outline mask; colour: colour mask; top row', top, 'columns', x0, '…', x1);
for (const [name, m] of [
  ['mask', mask],
  ['colour', colour],
] as const) {
  console.log(`-- ${name}`);
  for (let y = top - 2; y < top + Number(arg('rows', '14')); y++) {
    let line = '';
    for (let x = x0; x <= x1; x++) {
      const i = y * width + x;
      const rr = render.data[i] === FIXTURE_REGION,
        cc = !!claimed[i],
        kept = m[i] === FIXTURE_REGION;
      line +=
        rr && cc ? (kept ? '#' : '+') : rr ? (kept ? 'R' : 'r') : cc ? (kept ? 'C' : 'c') : kept ? '?' : '.';
    }
    console.log(String(y).padStart(4), line);
  }
}
