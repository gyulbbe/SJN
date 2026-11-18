/**
 * Values along one row of a result (no AI call): the model's and the O1 picture's lightness, the
 * outline label, the strongest used cut-out alpha. Usage:
 * node tests/run-browser-test.mjs tests/fixture-shadows/probe.ts --set reg --id <id> --y 0.75 --x 0.2,0.27
 */
import { FIXTURE_REGION, type Pixels } from '../../src/lib/ai-export/color';
import { haze, type HazeSet } from '../fixture-haze/sources';
import { setPieceRule } from '../fixture-streaks/outline-method';
import { refineTrial } from '../fixture-streaks/refine-trial';
import { loadInput } from './load';

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
setPieceRule(28, 0.7, 0.3);
const source = haze(arg('set', 'reg') as HazeSet).find((s) => s.id === arg('id'))!;
const { input } = (await loadInput(source))!;
const trial = refineTrial({ ...input, pieces: true });
const shown = trial.shown!;
const { width, height } = shown;
const y = Math.round(Number(arg('y')) * height);
const [a, b] = arg('x')
  .split(',')
  .map((v) => Math.round(Number(v) * width));
const used = new Set(trial.outline!.verdicts.filter((v) => v.used).map((v) => v.fixture));
const lum = (d: Pixels['data'], i: number) =>
  Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
for (let x = a; x <= b; x++) {
  const i = y * width + x;
  let alpha = 0;
  for (const cut of input.cuts)
    if (
      used.has(cut.fixture) &&
      x >= cut.left &&
      x < cut.left + cut.width &&
      y >= cut.top &&
      y < cut.top + cut.height
    )
      alpha = Math.max(alpha, cut.alpha[(y - cut.top) * cut.width + x - cut.left]);
  const label = trial.outline!.mask.data[i];
  console.log(
    x,
    'raw',
    lum(input.raw.data, i),
    'o1',
    lum(shown.data, i),
    label === FIXTURE_REGION ? 'FIX' : `face${label}`,
    'a',
    alpha,
  );
}
