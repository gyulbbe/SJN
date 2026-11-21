/**
 * The wall-glare trial's pictures and numbers (no AI call, docs/wall-glare-20261121.md): today's
 * refine against the candidates that take less of the render's glossy reflection back onto the walls,
 * on the registered results of today's prompt (glossy-tile scenes `glare-final`/`glare-diffsemi`, and
 * as a check the other registered and photo-product scenes, which have no softer capture: B only).
 * Pictures go beside the fixture-glare ones as `<id>.wg-<candidate>.png`.
 *
 * Numbers per picture, on the walls and floor:
 * - `lump`: p99.5 of how much the broad light (1.2% of the width) stands over the wider light (4×),
 *   in %: a reflection spot;
 * - `joints`: the faces' joint score (joints.ts faceScores) against the widened capture, the mean.
 *
 * Usage: node tests/run-browser-test.mjs tests/wall-glare/pictures.ts [--only g-] [--no-png]
 * Output: test-results/wall-glare-20261121/numbers.json
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FIXTURE_REGION,
  projectCapture,
  projectMask,
  shiftMask,
  type Pixels,
} from '../../src/lib/ai-export/color';
import { refineCurrentResult, type RefineTuning } from '../../src/lib/ai-export/current-refine';
import { blurInside, faceScores, LIGHT_BLUR } from '../../src/lib/ai-export/joints';
import { pixels, png } from '../extra-ai/app-view';
import { haze, type HazeSet } from '../fixture-haze/sources';
import { loadInput } from '../fixture-shadows/load';
import { GLARE, OUT } from './paths.mjs';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const only = arg('--only')?.split(',');
const writePng = !process.argv.includes('--no-png');
const dir = join(GLARE as string, 'pictures');

/**
 * `now` is the app before 2026-11-21 (no light cap, light from the room as drawn); `soft` takes the
 * walls' light from the softer capture (fixture-glare soft-scenes, roughness 0.6, as the app's
 * GLARE_SOFT_ROUGHNESS). Tried and dropped (doc section 4): roughness 0.45, the darker of the two
 * renders, and cutting lumps of the render's detail (B).
 */
export const CANDIDATES: { name: string; tuning: RefineTuning; soft?: boolean }[] = [
  { name: 'now', tuning: { lightCap: Infinity } },
  { name: 'a60', tuning: { lightCap: Infinity }, soft: true },
  { name: 'c02', tuning: {} },
  { name: 'c05', tuning: { lightCap: 0.05 } },
  { name: 'ac02', tuning: {}, soft: true },
  { name: 'ac05', tuning: { lightCap: 0.05 }, soft: true },
];

const lum = (d: ArrayLike<number>, o: number) => 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2];

function numbers(shown: Pixels, faceMask: Uint8Array, joints: number) {
  const { width, height } = shown;
  const n = width * height;
  const face = new Float32Array(n),
    value = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    face[i] = faceMask[i] ? 1 : 0;
    value[i] = lum(shown.data, i * 4);
  }
  const radius = Math.max(2, Math.round(width * LIGHT_BLUR));
  const broad = blurInside(value, face, width, height, radius).mean;
  const wide = blurInside(broad, face, width, height, radius * 4).mean;
  const lumps: number[] = [];
  for (let i = 0; i < n; i += 2) if (face[i] && wide[i] > 8) lumps.push(broad[i] / wide[i] - 1);
  lumps.sort((a, b) => a - b);
  const lump = lumps.length ? lumps[Math.floor(lumps.length * 0.995)] : 0;
  return { lump: +(lump * 100).toFixed(2), joints: +joints.toFixed(3) };
}

const rows: { id: string; candidate: string; lump: number; joints: number }[] = [];
const done = new Set<string>();
for (const [set, cut] of [
  ['glare-final', 6],
  ['glare-diffsemi', 9],
  ['pp-final', 6],
] as const)
  for (const source of haze(set as HazeSet)) {
    const id = source.id.slice(0, -cut);
    if (!/^(pp|g|n|r)-/.test(id) || done.has(id)) continue;
    if (only && !only.some((o) => id.startsWith(o))) continue;
    const loaded = await loadInput(source);
    if (!loaded) continue;
    done.add(id);
    const { input } = loaded;
    const size = { width: input.raw.width, height: input.raw.height };
    const line: string[] = [];
    for (const candidate of CANDIDATES) {
      let soft: Pixels | undefined;
      if (candidate.soft) {
        const file = join(GLARE as string, 'soft-scenes', 'r60', 'behind', source.layers, 'behind.png');
        if (id.startsWith('pp-') || !existsSync(file)) continue;
        soft = await pixels(file);
      }
      const app = refineCurrentResult({ ...input, tuning: candidate.tuning, ...(soft ? { soft } : {}) });
      const shown = app.shown ?? input.raw;
      const { dx, dy } = app.review.framing;
      const projected = projectMask(input.mask, input.layout, size);
      const scores = input.joints
        ? faceScores(projectCapture(input.joints, input.layout, size), shown, projected, dx, dy)
        : [];
      const faces = app.outline?.mask.data ?? shiftMask(projected, dx, dy).data;
      const faceMask = new Uint8Array(faces.length);
      for (let i = 0; i < faces.length; i++) faceMask[i] = faces[i] && faces[i] !== FIXTURE_REGION ? 1 : 0;
      const mean = scores.length ? scores.reduce((s, f) => s + f.score, 0) / scores.length : 0;
      const row = { id, candidate: candidate.name, ...numbers(shown, faceMask, mean) };
      rows.push(row);
      line.push(`${candidate.name} ${row.lump.toFixed(1)}/${row.joints.toFixed(2)}`);
      if (writePng) writeFileSync(join(dir, `${id}.wg-${candidate.name}.png`), await png(shown));
    }
    console.log(id.padEnd(22), line.join('  '));
  }
for (const candidate of CANDIDATES) {
  for (const group of ['g-', 'other']) {
    const mine = rows.filter(
      (r) =>
        r.candidate === candidate.name && (group === 'g-' ? r.id.startsWith('g-') : !r.id.startsWith('g-')),
    );
    if (!mine.length) continue;
    const avg = (key: 'lump' | 'joints') => mine.reduce((s, r) => s + r[key], 0) / mine.length;
    console.log(
      `${candidate.name.padEnd(4)} ${group.padEnd(5)} n=${mine.length}: lump ${avg('lump').toFixed(2)}%, joints ${avg('joints').toFixed(3)}`,
    );
  }
}
mkdirSync(OUT as string, { recursive: true });
writeFileSync(join(OUT as string, 'numbers.json'), JSON.stringify(rows, null, 1));
