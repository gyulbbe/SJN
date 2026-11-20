/**
 * How far the model moved each ceramic's lightness (no AI call, docs/refine-level-20261120.md): per
 * result, the median L* of the ceramic where the model drew it (its cut-out outline, before any step)
 * against the render's. A white toilet the model drew black ("이거 변기 너무 이상한데?") is far below.
 *
 * Usage: node tests/run-browser-test.mjs tests/refine-level/recolor-scan.ts pp-final glare-final reg new dev …
 */
import { projectCapture, projectMask, rgbToLab } from '../../src/lib/ai-export/color';
import { refineCurrentResult } from '../../src/lib/ai-export/current-refine';
import { fixtureMask } from '../../src/lib/ai-export/fixture-light';
import { haze, type HazeSet } from '../fixture-haze/sources';
import { loadInput } from '../fixture-shadows/load';

const sets = process.argv.slice(2).filter((a) => !/[\/.]/.test(a) && !a.startsWith('--'));
const median = (v: number[]) => (v.sort((a, b) => a - b), v[v.length >> 1]);
for (const set of sets)
  for (const source of haze(set as HazeSet)) {
    const loaded = await loadInput(source);
    if (!loaded) continue;
    const { input } = loaded;
    const { width, height } = input.raw;
    const app = refineCurrentResult(input);
    if (!app.outline) continue;
    const res = fixtureMask(app.outline.colourMask, input.fixtures);
    const ref = fixtureMask(projectMask(input.mask, input.layout, { width, height }), input.fixtures);
    const render = projectCapture(input.capture, input.layout, { width, height });
    const parts: string[] = [];
    for (let k = 1; k <= res.mask.regions.length; k++) {
      const a: number[] = [],
        b: number[] = [];
      for (let i = 0; i < width * height; i++) {
        if (res.mask.data[i] === k)
          a.push(rgbToLab(input.raw.data[i * 4], input.raw.data[i * 4 + 1], input.raw.data[i * 4 + 2])[0]);
        if (ref.mask.data[i] === k)
          b.push(rgbToLab(render.data[i * 4], render.data[i * 4 + 1], render.data[i * 4 + 2])[0]);
      }
      if (a.length < 200 || b.length < 200) continue;
      const d = median(a) - median(b);
      parts.push(
        `${res.kinds[k - 1]} ${median(b).toFixed(0)}→${median(a).toFixed(0)} (${d > 0 ? '+' : ''}${d.toFixed(0)})`,
      );
    }
    console.log(set.padEnd(14), source.id.padEnd(30), parts.join(' | '));
  }
