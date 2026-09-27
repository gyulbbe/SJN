/**
 * Offline evaluation of the 2026-09-28 composite comparison (no AI call). For each saved FLUX answer
 * it rebuilds what the app would show with the app's own code (composeFluxResult for the empty-room
 * methods, the colour check for the current method) and measures: framing and floor-line offset,
 * whether fixtures stay the render's pixels, and how each fixture's lightness stands against the
 * room around it (render, composite without and with light matching). Writes side-by-side images to
 * test-results/flux-composite/report/.
 *
 * Usage: node tests/run-browser-test.mjs tests/flux-composite-evaluate.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { rgbToLab, reviewResultColors, type Pixels, type RegionMask } from '../src/lib/ai-export/color';
import { fluxInputLayout } from '../src/lib/ai-export/contract';
import {
  composeFluxResult,
  compositeFixtures,
  fixtureLayer,
  placeholderRoom,
  resultOnCapture,
  RING,
  shadowLayer,
  type RoomLayers,
} from '../src/lib/ai-export/composite';

const ROOT = 'test-results/flux-composite';
mkdirSync(`${ROOT}/report`, { recursive: true });

async function load(path: string): Promise<Pixels & { data: Uint8ClampedArray }> {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
}
const toPng = (image: Pixels) =>
  sharp(Buffer.from(image.data), { raw: { width: image.width, height: image.height, channels: 4 } }).png();

async function payload(label: string) {
  const full = await load(`${ROOT}/payload/${label}-capture.png`);
  const shadowed = await load(`${ROOT}/payload/${label}-shadowed.png`);
  const empty = await load(`${ROOT}/payload/${label}-empty.png`);
  const coverageImage = await load(`${ROOT}/payload/${label}-coverage.png`);
  const coverage = new Uint8Array(full.width * full.height).map((_, i) => coverageImage.data[i * 4]);
  const layers: RoomLayers = {
    width: full.width,
    height: full.height,
    full: full.data,
    shadowed: shadowed.data,
    empty: empty.data,
    coverage,
  };
  const maskJson = JSON.parse(readFileSync(`${ROOT}/payload/${label}-mask.json`, 'utf8'));
  const mask: RegionMask = {
    width: maskJson.width,
    height: maskJson.height,
    regions: maskJson.regions,
    data: Uint8Array.from(Buffer.from(maskJson.base64, 'base64')),
  };
  const scene = JSON.parse(readFileSync(`${ROOT}/payload/${label}-scene.json`, 'utf8'));
  // What the placeholder method sent, at capture size, exactly as the app builds it.
  const placeholders = placeholderRoom(layers);
  return {
    layers,
    mask,
    boxes: scene.boxes as Record<string, [number, number, number, number]>,
    placeholders,
  };
}

/** Mean L* of the fixture (fully covered) and of its room ring, per fixture box. */
function contrast(
  image: Pixels,
  layers: RoomLayers,
  boxes: Record<string, [number, number, number, number]>,
) {
  const { width, height } = layers;
  const out: Record<string, number> = {};
  for (const [id, box] of Object.entries(boxes)) {
    const [l, t, r, b] = [box[0] * width, box[1] * height, box[2] * width, box[3] * height];
    const pad = 0.12 * Math.max(r - l, b - t);
    let fixture = 0,
      nf = 0,
      ring = 0,
      nr = 0;
    for (let y = Math.max(0, Math.floor(t - pad)); y < Math.min(height, b + pad); y++)
      for (let x = Math.max(0, Math.floor(l - pad)); x < Math.min(width, r + pad); x++) {
        const i = y * width + x;
        const L = rgbToLab(image.data[i * 4], image.data[i * 4 + 1], image.data[i * 4 + 2])[0];
        if (layers.coverage[i] === 255 && x >= l && x <= r && y >= t && y <= b) {
          fixture += L;
          nf++;
          continue;
        }
        if (layers.coverage[i] > 0) continue;
        // Ring: within RING[1] px of the box edge (outside the silhouette).
        const dx = Math.max(l - x, 0, x - r),
          dy = Math.max(t - y, 0, y - b);
        if (Math.max(dx, dy) <= RING[1]) {
          ring += L;
          nr++;
        }
      }
    if (nf > 20 && nr > 20) out[id] = +(fixture / nf - ring / nr).toFixed(1);
  }
  return out;
}

const jobs = JSON.parse(readFileSync(`${ROOT}/jobs.json`, 'utf8')).flux as { name: string }[];
// The current method on the terrazzo room was measured on 2026-09-27 (same request, input pixel diff 0).
const earlier = ['424242', '777001'].map((seed) => ({
  name: `terrazzo-center-current-${seed}`,
  file: `test-results/flux-input-in-room/real/eye-center-plain-${seed}.jpg`,
}));
const results = [
  ...earlier,
  ...jobs.map((job) => ({
    name: job.name,
    file: existsSync(`${ROOT}/real/${job.name}.jpg`)
      ? `${ROOT}/real/${job.name}.jpg`
      : `${ROOT}/real/${job.name}.png`,
  })),
];
const rows = [];
const cache = new Map<string, Awaited<ReturnType<typeof payload>>>();
for (const { name, file } of results) {
  const label = name
    .split('-')
    .slice(0, name.startsWith('white-right') || name.startsWith('terrazzo-right') ? 3 : 2)
    .join('-');
  const method = name.slice(label.length + 1).replace(/-\d+$/, '');
  if (!cache.has(label)) cache.set(label, await payload(label));
  const { layers, mask, boxes, placeholders } = cache.get(label)!;
  const size = { width: layers.width, height: layers.height };
  const layout = fluxInputLayout(layers.width, layers.height);
  const result = await load(file);
  const renderContrast = contrast({ ...size, data: layers.full }, layers, boxes);
  let shown: Pixels, row: Record<string, unknown>;
  if (method === 'current') {
    const review = reviewResultColors({ capture: { ...size, data: layers.full }, mask, layout, result });
    shown = resultOnCapture(review.corrected ?? result, layout, size);
    row = {
      framing: +review.framing.score.toFixed(2),
      aligned: review.framing.aligned,
      contrast: contrast(shown, layers, boxes),
    };
  } else {
    const input = method === 'placeholders' ? placeholders : { ...size, data: layers.empty };
    const composed = composeFluxResult({ result, input, layers, mask, layout, boxes: Object.values(boxes) });
    shown = composed.corrected ?? composed.raw;
    // The same composite without light matching: how much the matching changed the fixtures.
    const unlit = compositeFixtures({
      room: resultOnCapture(result, layout, size),
      fixtures: fixtureLayer(layers),
      shadow: shadowLayer(layers),
      feather: true,
    });
    row = {
      framing: +composed.review.framing.score.toFixed(2),
      aligned: composed.review.framing.aligned,
      shift: [composed.review.framing.dx, composed.review.framing.dy],
      floor: composed.floor,
      shifted: composed.shifted,
      contrast: contrast(shown, layers, boxes),
      contrastUnlit: contrast(unlit, layers, boxes),
    };
  }
  rows.push({ name, method, render: renderContrast, ...row });
  // input | model | shown | render, at 512 wide each.
  const w = 512,
    h = Math.round((512 * layers.height) / layers.width);
  const sent =
    method === 'current'
      ? { ...size, data: layers.full }
      : method === 'placeholders'
        ? placeholders
        : { ...size, data: layers.empty };
  const tiles = await Promise.all(
    [sent, resultOnCapture(result, layout, size), shown, { ...size, data: layers.full }].map((image) =>
      toPng(image).resize(w, h).toBuffer(),
    ),
  );
  await sharp({ create: { width: 4 * w + 18, height: h, channels: 3, background: '#ffffff' } })
    .composite(tiles.map((input, i) => ({ input, left: i * (w + 6), top: 0 })))
    .jpeg({ quality: 88 })
    .toFile(`${ROOT}/report/row-${name}.jpg`);
  await toPng(shown).toFile(`${ROOT}/report/shown-${name}.png`);
}
writeFileSync(`${ROOT}/report/evaluation.json`, JSON.stringify(rows, null, 2));
for (const row of rows) console.log(JSON.stringify(row));
