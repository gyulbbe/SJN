/**
 * Glare and light streaks per refine level (no AI call, docs/refine-level-20261120.md), on the same
 * results as levels.ts, each against the design picture:
 * - `streaks`: on the walls and floor (the outline mask's faces), the spread (standard deviation) of
 *   log(result luminance ÷ render luminance) blurred over 3% of the width (docs/ai-light-20261115.md);
 * - `peak`: on the ceramics (the outline colour mask, 2 px in), L* p98 − p50, minus the render's.
 *
 * Usage: node tests/run-browser-test.mjs tests/refine-level/glare.ts
 * Output: test-results/refine-level-20261120/glare.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FIXTURE_REGION,
  projectCapture,
  projectMask,
  rgbToLab,
  shiftMask,
} from '../../src/lib/ai-export/color';
import { refineCurrentResult } from '../../src/lib/ai-export/current-refine';
import { fixtureMask } from '../../src/lib/ai-export/fixture-light';
import { blurInside } from '../../src/lib/ai-export/joints';
import { haze, type HazeSet } from '../fixture-haze/sources';
import { loadInput } from '../fixture-shadows/load';
import { LEVELS } from './levels-config';
import { OUT } from './paths.mjs';

const lum = (d: ArrayLike<number>, o: number) => 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2];
const q = (s: number[], p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
const rows: { id: string; level: number; streaks: number; peak: number }[] = [];
const done = new Set<string>();
for (const [set, cut] of [
  ['pp-final', 6],
  ['glare-final', 6],
  ['glare-diffsemi', 9],
] as const)
  for (const source of haze(set as HazeSet)) {
    const id = source.id.slice(0, -cut);
    if (!/^(pp|g|n|r)-/.test(id) || done.has(id)) continue;
    const loaded = await loadInput(source);
    if (!loaded) continue;
    done.add(id);
    const { input } = loaded;
    const { width, height } = input.raw;
    const n = width * height;
    for (const [level, tuning] of LEVELS.entries()) {
      const app = refineCurrentResult({ ...input, tuning });
      if (!app.shown || !app.outline) continue;
      const { dx, dy } = app.review.framing;
      const render = projectCapture(input.capture, input.layout, { width, height });
      const from = (i: number) => {
        const x = (i % width) - dx,
          y = Math.floor(i / width) - dy;
        return x < 0 || y < 0 || x >= width || y >= height ? -1 : y * width + x;
      };
      // Walls and floor: the log light ratio's broad spread.
      const face = new Float32Array(n),
        ratio = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const label = app.outline.mask.data[i];
        const j = from(i);
        if (!label || label === FIXTURE_REGION || j < 0) continue;
        face[i] = 1;
        ratio[i] = Math.log((lum(app.shown.data, i * 4) + 1) / (lum(render.data, j * 4) + 1));
      }
      const blurred = blurInside(ratio, face, width, height, Math.max(3, Math.round(width * 0.03))).mean;
      const values: number[] = [];
      for (let i = 0; i < n; i += 3) if (face[i]) values.push(blurred[i]);
      const mean = values.reduce((s, v) => s + v, 0) / values.length;
      const streaks = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
      // Ceramics: how far the brightest band stands out, against the render's.
      const res = fixtureMask(app.outline.colourMask, input.fixtures).mask;
      const ref = fixtureMask(
        shiftMask(projectMask(input.mask, input.layout, { width, height }), 0, 0),
        input.fixtures,
      ).mask;
      let peak = 0,
        count = 0;
      for (let k = 1; k <= res.regions.length; k++) {
        const a: number[] = [],
          b: number[] = [];
        for (let i = 0; i < n; i++) {
          if (res.data[i] === k)
            a.push(rgbToLab(app.shown.data[i * 4], app.shown.data[i * 4 + 1], app.shown.data[i * 4 + 2])[0]);
          if (ref.data[i] === k)
            b.push(rgbToLab(render.data[i * 4], render.data[i * 4 + 1], render.data[i * 4 + 2])[0]);
        }
        if (a.length < 300 || b.length < 300) continue;
        a.sort((x, y) => x - y);
        b.sort((x, y) => x - y);
        peak += q(a, 0.98) - q(a, 0.5) - (q(b, 0.98) - q(b, 0.5));
        count++;
      }
      rows.push({ id, level, streaks: +streaks.toFixed(4), peak: +(count ? peak / count : 0).toFixed(2) });
    }
    console.log(
      id.padEnd(22),
      rows
        .filter((r) => r.id === id)
        .map((r) => `L${r.level} ${r.streaks.toFixed(3)}/${r.peak.toFixed(1)}`)
        .join('  '),
    );
  }
for (const level of LEVELS.keys()) {
  const mine = rows.filter((r) => r.level === level);
  const avg = (key: 'streaks' | 'peak') => mine.reduce((s, r) => s + r[key], 0) / mine.length;
  console.log(
    `L${level}: streaks ${avg('streaks').toFixed(4)}, ceramic peak over render ${avg('peak').toFixed(2)} L*`,
  );
}
mkdirSync(OUT as string, { recursive: true });
writeFileSync(join(OUT as string, 'glare.json'), JSON.stringify(rows, null, 1));
