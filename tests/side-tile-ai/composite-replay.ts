/**
 * Replays one saved model answer to the empty-room input (composite-capture.ts, terrazzo-capture.ts)
 * through the app's composite (composite.ts composeFluxResult, as ai-export.tsx calls it for "실험 A ·
 * 빈 방 합성"; no AI call): our fixtures back on the model's room, the floor-line check, and the
 * design's joints put back. Works on any answer PNG, local FLUX or a Cloudflare answer the supervisor
 * saved. `--rev <commit>` runs the composite of that commit (revision.ts: every src file that differs
 * from HEAD is loaded as it was there), e.g. 3037c8e for the floor-line check before cb4fafb.
 *
 * Usage: node tests/run-browser-test.mjs tests/side-tile-ai/composite-replay.ts --scene <dir> --answer <png> --out <dir> [--rev <commit>]
 *   <dir>: test-results/side-tile-ai-20261121/after/composite/<scene>
 * Output in --out: raw.png (fixtures on the model's room as it came), corrected.png (colour-corrected,
 * joints back; absent when neither applied), final.png (what the dialog shows: corrected, else raw),
 * floorline.png (the model's room on the capture grid, the render's floor line in red and the line the
 * check read in green), summary.json (floor offset, shifted, faces whose joints went back, framing,
 * how far our fixtures' fully covered pixels moved off the render's).
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import sharp from 'sharp';
import type { Pixels, RegionMask } from '../../src/lib/ai-export/color';
import type { RoomLayers } from '../../src/lib/ai-export/composite';
import type { FluxInputLayout } from '../../src/lib/ai-export/contract';
import { revisionPlugin } from './revision';

const arg = (name: string, need = true) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 && need) throw new Error(`--${name} is needed`);
  return i < 0 ? undefined : process.argv[i + 1];
};
const dir = arg('scene')!,
  answerFile = arg('answer')!,
  out = arg('out')!,
  rev = arg('rev', false) ?? 'HEAD';
if (!existsSync(answerFile)) throw new Error(`no answer ${answerFile}`);
mkdirSync(out, { recursive: true });

// The composite of `rev`, bundled on its own (run-browser-test.mjs bundles this file without plugins).
const { plugin, swapped } = revisionPlugin(rev);
const bundled = resolve('test-results/runners', `composite-${process.pid}-${Date.now()}.mjs`);
await build({
  stdin: {
    contents:
      "export { composeFluxResult, resultOnCapture, MAX_FLOOR_OFFSET } from './src/lib/ai-export/composite';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  outfile: bundled,
  logLevel: 'warning',
  plugins: [plugin],
});
let lib: typeof import('../../src/lib/ai-export/composite');
try {
  lib = await import(pathToFileURL(bundled).href);
} finally {
  unlinkSync(bundled);
}

async function rgba(file: string): Promise<Pixels & { data: Uint8ClampedArray }> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
}
const gray = async (file: string) => new Uint8Array(await sharp(file).extractChannel(0).raw().toBuffer());
const png = (p: Pixels) =>
  sharp(Buffer.from(p.data.buffer, p.data.byteOffset, p.data.length), {
    raw: { width: p.width, height: p.height, channels: 4 },
  })
    .png()
    .toBuffer();

const full = await rgba(join(dir, 'full.png'));
const layers: RoomLayers = {
  width: full.width,
  height: full.height,
  full: full.data,
  shadowed: (await rgba(join(dir, 'shadowed.png'))).data,
  empty: (await rgba(join(dir, 'empty.png'))).data,
  coverage: await gray(join(dir, 'coverage.png')),
};
const regions = JSON.parse(readFileSync(join(dir, 'regions.json'), 'utf8')) as Omit<RegionMask, 'data'>;
const mask: RegionMask = {
  ...regions,
  data: await gray(join(dir, 'mask.png')),
  outside: await gray(join(dir, 'mask-outside.png')),
};
const layout = JSON.parse(readFileSync(join(dir, 'layout.json'), 'utf8')) as FluxInputLayout;
const boxes = JSON.parse(readFileSync(join(dir, 'boxes.json'), 'utf8')) as [number, number, number, number][];
const result = await rgba(answerFile);
// As ai-export.tsx: the colour check's capture is what was sent, the empty room at capture size.
const input: Pixels = { width: layers.width, height: layers.height, data: layers.empty };
const composed = lib.composeFluxResult({
  result,
  input,
  layers,
  mask,
  layout,
  boxes,
  joints: await rgba(join(dir, 'joints.png')),
});
writeFileSync(join(out, 'raw.png'), await png(composed.raw));
if (composed.corrected) writeFileSync(join(out, 'corrected.png'), await png(composed.corrected));
writeFileSync(join(out, 'final.png'), await png(composed.corrected ?? composed.raw));

// The floor line: the render's (red, first floor pixel under a wall, as floorLineOffset reads it) and
// the one the check read (green, red + offset), on the model's room at capture size.
const { width, height } = layers;
const room = lib.resultOnCapture(result, layout, { width, height });
const label = (x: number, y: number) =>
  mask.data[
    Math.min(mask.height - 1, Math.floor(((y + 0.5) * mask.height) / height)) * mask.width +
      Math.min(mask.width - 1, Math.floor(((x + 0.5) * mask.width) / width))
  ];
const kind = (id: number) => regions.regions[id - 1]?.kind;
const lines = Uint8ClampedArray.from(room.data);
const mark = (x: number, y: number, rgb: [number, number, number]) => {
  if (y < 0 || y >= height) return;
  lines.set([...rgb, 255], (y * width + x) * 4);
};
for (let x = 0; x < width; x++)
  for (let y = 1; y < height; y++)
    if (
      kind(label(x, y)) === 'floor' &&
      kind(label(x, y - 1)) === 'wall' &&
      layers.coverage[y * width + x] === 0
    ) {
      mark(x, y, [255, 0, 0]);
      if (composed.floor.offset) mark(x, y + composed.floor.offset, [0, 200, 0]);
      break;
    }
writeFileSync(join(out, 'floorline.png'), await png({ width, height, data: lines }));

// Our fixtures stay at the render's pixels: fully covered pixels 2 px from any edge, raw against full.
let moved = 0,
  max = 0,
  n = 0;
for (let y = 2; y < height - 2; y++)
  for (let x = 2; x < width - 2; x++) {
    let inner = true;
    for (let dy = -2; dy <= 2 && inner; dy++)
      for (let dx = -2; dx <= 2 && inner; dx++)
        if (layers.coverage[(y + dy) * width + x + dx] < 255) inner = false;
    if (!inner) continue;
    const o = (y * width + x) * 4;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(composed.raw.data[o + c] - layers.full[o + c]);
      moved += d;
      max = Math.max(max, d);
    }
    n++;
  }
const summary = {
  answer: answerFile,
  rev,
  swapped,
  answerSize: [result.width, result.height],
  floor: composed.floor,
  floorLimit: +((lib.MAX_FLOOR_OFFSET * layers.width) / 1024).toFixed(2),
  shifted: composed.shifted,
  aligned: composed.review.framing.aligned,
  joints: composed.joints?.restored.map((face) => face.key) ?? [],
  corrected: !!composed.corrected,
  fixturePixels: { pixels: n, mean: n ? +(moved / (3 * n)).toFixed(2) : 0, max },
};
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ ...summary, answer: undefined }));
