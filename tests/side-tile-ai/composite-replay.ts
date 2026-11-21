/**
 * Replays one saved model answer to the empty-room input (composite-capture.ts) through the app's
 * composite (composite.ts composeFluxResult, as ai-export.tsx calls it for "실험 A · 빈 방 합성"; no
 * AI call): our fixtures back on the model's room, the floor-line check, and the design's joints put
 * back. Works on any answer PNG, local FLUX or a Cloudflare answer the supervisor saved.
 *
 * Usage: node tests/run-browser-test.mjs tests/side-tile-ai/composite-replay.ts --scene <dir> --answer <png> --out <dir>
 *   <dir>: test-results/side-tile-ai-20261121/after/composite/<scene>
 * Output in --out: raw.png (fixtures on the model's room as it came), corrected.png (colour-corrected,
 * joints back; absent when neither applied), summary.json (floor offset, shifted, faces whose joints
 * went back, framing).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import type { Pixels, RegionMask } from '../../src/lib/ai-export/color';
import { composeFluxResult, MAX_FLOOR_OFFSET, type RoomLayers } from '../../src/lib/ai-export/composite';
import type { FluxInputLayout } from '../../src/lib/ai-export/contract';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) throw new Error(`--${name} is needed`);
  return process.argv[i + 1];
};
const dir = arg('scene'),
  answerFile = arg('answer'),
  out = arg('out');
if (!existsSync(answerFile)) throw new Error(`no answer ${answerFile}`);
mkdirSync(out, { recursive: true });

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
const composed = composeFluxResult({
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
const summary = {
  answer: answerFile,
  answerSize: [result.width, result.height],
  floor: composed.floor,
  floorLimit: +((MAX_FLOOR_OFFSET * layers.width) / 1024).toFixed(2),
  shifted: composed.shifted,
  aligned: composed.review.framing.aligned,
  joints: composed.joints?.restored.map((face) => face.key) ?? [],
  corrected: !!composed.corrected,
};
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary));
