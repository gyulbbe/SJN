/**
 * Close-ups of the basins the photo-shape candidates put back (no AI call, docs/photo-shape-20261121.md):
 * per result and basin, the design, today's app and each candidate, from pictures.ts's pictures.
 *
 * Usage: node tests/run-browser-test.mjs tests/photo-shape/sheet.ts [--reg] [--candidates now,s92,s92f] [--out name]
 * Output: test-results/photo-shape-20261121/<name>.png (default sheet.png)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { MATERIAL, SHADOWS, STREAKS } from '../fixture-glare/paths.mjs';
import { haze, type HazeSet } from '../fixture-haze/sources';
import { loadScene } from '../extra-ai/app-view';
import { GLARE, OUT } from './paths.mjs';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const candidates = (arg('--candidates') ?? 'now,s92,s88,s92f').split(',');
const H = Number(arg('--h') ?? 140);
const reg = process.argv.includes('--reg');
const tag = (process.argv.includes('--taps') ? 'pt' : 'ps') + (reg ? 'r' : '');
const rows = JSON.parse(readFileSync(join(OUT as string, `pictures-${tag}.json`), 'utf8')) as {
  id: string;
  candidate: string;
  reshaped: number[];
}[];
const changed = new Map<string, Set<number>>();
for (const r of rows) for (const k of r.reshaped) changed.set(r.id, (changed.get(r.id) ?? new Set()).add(k));
const picture = (id: string, rule: string) =>
  [
    join(GLARE as string, 'pictures'),
    join(MATERIAL as string, 'pictures'),
    join(SHADOWS as string, 'pictures'),
    join(STREAKS as string, 'pictures'),
  ]
    .map((d) => join(d, `${id}.${rule}.png`))
    .find((f) => existsSync(f));
const sources = new Map<string, { dir: string; jointsFile: string }>();
for (const [set, cut] of reg
  ? ([
      ['reg', 0],
      ['new', 0],
    ] as const)
  : ([
      ['pp-final', 6],
      ['glare-final', 6],
      ['glare-diffsemi', 9],
    ] as const))
  for (const s of haze(set as HazeSet))
    if (!sources.has(cut ? s.id.slice(0, -cut) : s.id))
      sources.set(cut ? s.id.slice(0, -cut) : s.id, { dir: s.dir, jointsFile: s.jointsFile });

const lines: { input: Buffer; width: number }[][] = [];
const pick = arg('--ids')?.split(',');
for (const [id, fixtures] of changed) {
  if (pick && !pick.includes(id)) continue;
  const source = sources.get(id)!;
  const scene = await loadScene(source.dir, source.jointsFile);
  for (const k of fixtures) {
    const [l, t, r, b] = scene.scene.fixtures[k].box!;
    const line: { input: Buffer; width: number }[] = [];
    for (const rule of ['ref', ...candidates.map((c) => `${tag}-${c}`)]) {
      const file = picture(id, rule);
      if (!file) continue;
      const m = await sharp(file).metadata();
      const pw = (r - l) * 0.4,
        ph = (b - t) * 0.4;
      const left = Math.max(0, Math.floor((l - pw) * m.width!)),
        top = Math.max(0, Math.floor((t - ph) * m.height!));
      const width = Math.min(m.width! - left, Math.ceil((r - l + 2 * pw) * m.width!)),
        height = Math.min(m.height! - top, Math.ceil((b - t + 2 * ph) * m.height!));
      const input = await sharp(file)
        .extract({ left, top, width, height })
        .resize({ height: H })
        .png()
        .toBuffer();
      line.push({ input, width: (await sharp(input).metadata()).width! });
    }
    lines.push(line);
    console.log(String(lines.length).padStart(2), id, `#${k}`);
  }
}
const W = Math.max(...lines.map((line) => line.reduce((s, t) => s + t.width + 6, 0)));
const composite: { input: Buffer; left: number; top: number }[] = [];
lines.forEach((line, row) => {
  let x = 0;
  for (const t of line) {
    composite.push({ input: t.input, left: x, top: row * (H + 6) });
    x += t.width + 6;
  }
});
await sharp({ create: { width: W, height: lines.length * (H + 6), channels: 3, background: '#fff' } })
  .composite(composite)
  .png()
  .toFile(join(OUT as string, `${arg('--out') ?? 'sheet'}.png`));
