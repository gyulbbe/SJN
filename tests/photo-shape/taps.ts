/**
 * What T1 (fixture-shape.ts trimProtrusions) sees above each basin (no AI call,
 * docs/photo-shape-20261121.md): the cut-out's pixels outside the render's basin and above its top,
 * as 4-connected pieces with their size and how far they reach, against T1's limits (`far`, 15% of the
 * basin's width), to see why an invented tap stays.
 *
 * Usage: node tests/run-browser-test.mjs tests/photo-shape/taps.ts <set> --only id,id
 */
import {
  FIXTURE_REGION,
  framing,
  projectCapture,
  projectMask,
  shiftMask,
} from '../../src/lib/ai-export/color';
import { refineCurrentResult } from '../../src/lib/ai-export/current-refine';
import { fixtureMask } from '../../src/lib/ai-export/fixture-light';
import { PROTRUSION_FAR, PROTRUSION_THIN } from '../../src/lib/ai-export/fixture-shape';
import { FLUX_FIXTURE_KINDS } from '../../src/lib/ai-export/scene-contract';
import { haze, type HazeSet } from '../fixture-haze/sources';
import { loadInput } from '../fixture-shadows/load';

const i = process.argv.indexOf('--only');
const only = i > 0 ? process.argv[i + 1].split(',') : undefined;
const set = process.argv
  .slice(2)
  .find((a, k, all) => !a.startsWith('--') && all[k - 1] !== '--only' && !/[\\/.]/.test(a))!;
for (const source of haze(set as HazeSet)) {
  if (only && !only.some((o) => source.id.startsWith(o))) continue;
  const loaded = await loadInput(source);
  if (!loaded?.input.cuts) continue;
  const { input } = loaded;
  const app = refineCurrentResult(input);
  console.log(
    `${source.id}: T1 trimmed ${JSON.stringify(app.trimmed ?? [])}, cut-outs used ${JSON.stringify(app.outline?.verdicts.map((v) => [v.fixture, v.used]))}`,
  );
  const { width, height } = input.raw;
  const n = width * height;
  const frame = framing(projectCapture(input.capture, input.layout, { width, height }), input.raw);
  const renderMask = shiftMask(projectMask(input.mask, input.layout, { width, height }), frame.dx, frame.dy);
  const own = fixtureMask(renderMask, input.fixtures, FLUX_FIXTURE_KINDS).mask.data;
  const chosen = input.fixtures.filter((f) => f.box && FLUX_FIXTURE_KINDS.includes(f.kind));
  const far = Math.max(4, Math.round(width * PROTRUSION_FAR));
  for (const cut of input.cuts) {
    if (input.fixtures[cut.fixture].kind !== 'basin') continue;
    const label = chosen.indexOf(input.fixtures[cut.fixture]) + 1;
    let top = height,
      minX = width,
      maxX = -1;
    const mine = new Uint8Array(n);
    for (let k = 0; k < n; k++)
      if (own[k] === label && renderMask.data[k] === FIXTURE_REGION) {
        mine[k] = 1;
        top = Math.min(top, Math.floor(k / width));
        minX = Math.min(minX, k % width);
        maxX = Math.max(maxX, k % width);
      }
    const fw = maxX - minX + 1;
    // Pieces of the cut-out above the render's top row (any distance).
    const above = new Uint8Array(n);
    for (let y = 0; y < cut.height; y++)
      for (let x = 0; x < cut.width; x++) {
        const k = (cut.top + y) * width + cut.left + x;
        if (cut.alpha[y * cut.width + x] >= 128 && !mine[k] && cut.top + y < top) above[k] = 1;
      }
    const seen = new Uint8Array(n);
    const pieces: string[] = [];
    for (let s = 0; s < n; s++) {
      if (!above[s] || seen[s]) continue;
      const stack = [s];
      seen[s] = 1;
      let x0 = width,
        x1 = -1,
        y0 = height,
        y1 = -1,
        count = 0;
      while (stack.length) {
        const k = stack.pop()!;
        count++;
        x0 = Math.min(x0, k % width);
        x1 = Math.max(x1, k % width);
        y0 = Math.min(y0, Math.floor(k / width));
        y1 = Math.max(y1, Math.floor(k / width));
        for (const j of [k - 1, k + 1, k - width, k + width])
          if (j >= 0 && j < n && above[j] && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
      }
      if (count >= 6) pieces.push(`${x1 - x0 + 1}×${y1 - y0 + 1}px (rises ${top - y0}, ${count}px)`);
    }
    console.log(
      `${source.id} basin #${cut.fixture}: width ${fw}, far ${far}, thin ≤${Math.round(PROTRUSION_THIN * fw)}; above top: ${pieces.join(', ') || 'none'}`,
    );
  }
}
