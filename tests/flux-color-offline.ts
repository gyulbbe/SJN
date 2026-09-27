/**
 * FLUX material colour, offline (no AI call): the colour check (A) and face correction (B) on
 * saved FLUX results, against the render each was made from.
 *
 * - 2026-09-25 (6): 2D default room, stone-look grey walls. Only the model input was kept, so it is
 *   the reference, and the faces are drawn from the default room's geometry (fixture boxes from
 *   the saved scene are left out, grown by 2%).
 * - Stage 3 (4): 3D in-room view, white walls. Region masks come from the renderer
 *   (`tests/flux-stage3-payload.ts` writes them next to the captures).
 * - New results (optional): `test-results/flux-material-color/real/<scene>-<prompt>-<seed>.jpg`
 *   with `payload/<scene>-{capture.png,mask.png,mask.json}`.
 *
 * Usage: node tests/run-browser-test.mjs tests/flux-color-offline.ts
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import {
  compareFaces,
  FIXTURE_REGION,
  projectCapture,
  projectMask,
  reviewResultColors,
  shiftMask,
  type ColorReview,
  type Pixels,
  type RegionMask,
} from '../src/lib/ai-export/color';
import { fluxInputLayout, type FluxInputLayout } from '../src/lib/ai-export/contract';
import { createRoomSurfaces, DEFAULT_ROOM } from '../src/lib/room-geometry';

const OUT = 'test-results/flux-material-color/offline';
mkdirSync(OUT, { recursive: true });

async function load(path: string): Promise<Pixels> {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
}
async function png(image: Pixels) {
  return sharp(Buffer.from(image.data), { raw: { width: image.width, height: image.height, channels: 4 } })
    .png()
    .toBuffer();
}
/** Even-odd fill of polygons (normalised coordinates) into a label image. */
function fill(
  mask: Uint8Array,
  width: number,
  height: number,
  polygon: { x: number; y: number }[],
  label: number,
) {
  for (let y = 0; y < height; y++) {
    const py = (y + 0.5) / height;
    const xs: number[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i],
        b = polygon[(i + 1) % polygon.length];
      if (a.y <= py === b.y <= py) continue;
      xs.push(a.x + ((py - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2)
      for (
        let x = Math.max(0, Math.ceil(xs[k] * width - 0.5));
        x < Math.min(width, xs[k + 1] * width - 0.5);
        x++
      )
        mask[y * width + x] = label;
  }
}

/** 2026-09-25: the model input is the reference (identity layout), faces from the default room. */
const input0925 = await load('test-results/flux-compare-20260925/input.png');
function compare0925(): { capture: string; layout: FluxInputLayout; mask: RegionMask } {
  const input = { width: 496, height: 336 };
  // The capture behind the input was the 2D export at 1024 px (4096×2731 → 1024×683).
  const captureLayout = fluxInputLayout(1024, 683);
  const toInput = (p: { x: number; y: number }) => ({
    x: (captureLayout.x + p.x * captureLayout.contentWidth) / input.width,
    y: (captureLayout.y + p.y * captureLayout.contentHeight) / input.height,
  });
  const data = new Uint8Array(input.width * input.height);
  const surfaces = createRoomSurfaces(DEFAULT_ROOM, 4096 / 2731);
  surfaces.forEach((surface, i) => fill(data, input.width, input.height, surface.quad.map(toInput), i + 1));
  // Fixtures: inside each saved box (grown 1%), the pixels that differ from their face's colour
  // (the white products on stone), grown by one pixel. No renderer silhouette was kept then.
  const scene = JSON.parse(readFileSync('test-results/flux-compare-20260925/scene.json', 'utf8'));
  const { data: rgba } = input0925;
  const faceMean = new Map<number, number[]>();
  for (let i = 0; i < data.length; i++) {
    if (!data[i]) continue;
    const sum = faceMean.get(data[i]) ?? [0, 0, 0, 0];
    for (let c = 0; c < 3; c++) sum[c] += rgba[i * 4 + c];
    sum[3]++;
    faceMean.set(data[i], sum);
  }
  const fixture = new Uint8Array(data.length);
  for (const item of scene.fixtures as { box: [number, number, number, number] }[]) {
    const [l, t, r, b] = item.box.map((v, i) => v + (i < 2 ? -0.01 : 0.01));
    for (
      let y = Math.max(0, Math.floor(t * input.height));
      y < Math.min(input.height, Math.ceil(b * input.height));
      y++
    )
      for (
        let x = Math.max(0, Math.floor(l * input.width));
        x < Math.min(input.width, Math.ceil(r * input.width));
        x++
      ) {
        const i = y * input.width + x;
        const mean = faceMean.get(data[i]);
        if (!mean) continue;
        const diff = Math.hypot(...[0, 1, 2].map((c) => rgba[i * 4 + c] - mean[c] / mean[3]));
        if (diff > 18) fixture[i] = 1;
      }
  }
  for (let y = 0; y < input.height; y++)
    for (let x = 0; x < input.width; x++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const px = x + dx,
            py = y + dy;
          if (px >= 0 && py >= 0 && px < input.width && py < input.height && fixture[py * input.width + px])
            data[y * input.width + x] = FIXTURE_REGION;
        }
  return {
    capture: 'test-results/flux-compare-20260925/input.png',
    layout: { ...input, scale: 1, x: 0, y: 0, contentWidth: input.width, contentHeight: input.height },
    mask: {
      width: input.width,
      height: input.height,
      regions: surfaces.map((s) => ({ key: s.roomFace!, kind: s.kind })),
      data,
    },
  };
}
async function rendererMask(prefix: string): Promise<RegionMask | undefined> {
  if (!existsSync(`${prefix}-regions.json`)) return;
  const regions = JSON.parse(readFileSync(`${prefix}-regions.json`, 'utf8'));
  const { data, info } = await sharp(`${prefix}-regions.png`).raw().toBuffer({ resolveWithObject: true });
  const labels = new Uint8Array(info.width * info.height);
  for (let i = 0; i < labels.length; i++) labels[i] = data[i * info.channels];
  return { width: info.width, height: info.height, regions, data: labels };
}

type Case = {
  name: string;
  group: string;
  result: string;
  capture: string;
  layout: FluxInputLayout;
  mask: RegionMask;
};
const cases: Case[] = [];
const c0925 = compare0925();
for (const variant of ['A', 'B', 'C'])
  for (const seed of ['424242', '777001'])
    cases.push({
      name: `0925-${variant}-${seed}`,
      group: '2026-09-25 석재풍 회색 벽(2D)',
      result: `test-results/flux-compare-20260925/${variant}-${seed}.jpg`,
      ...c0925,
    });
const STAGE3 = 'test-results/export-realism-stage-3';
for (const capture of ['left-corner-single', 'left-corner-acc8']) {
  const mask = await rendererMask('test-results/flux-material-color/payload/white');
  if (!mask) {
    console.log('stage-3 region mask missing: run tests/flux-stage3-payload.ts first');
    break;
  }
  const image = await sharp(`${STAGE3}/payload/${capture}-capture.png`).metadata();
  for (const seed of ['424242', '777001'])
    cases.push({
      name: `stage3-${capture}-${seed}`,
      group: '3단계 흰 벽(3D 방 안)',
      result: `${STAGE3}/real/${capture}-${seed}.jpg`,
      capture: `${STAGE3}/payload/${capture}-capture.png`,
      layout: fluxInputLayout(image.width!, image.height!),
      mask,
    });
}
const REAL = 'test-results/flux-material-color/real';
if (existsSync(REAL))
  for (const file of readdirSync(REAL).filter((f) => f.endsWith('.jpg'))) {
    const scene = file.split('-')[0];
    const prefix = `test-results/flux-material-color/payload/${scene}`;
    const mask = await rendererMask(prefix);
    if (!mask) continue;
    const capture = `${prefix}-capture.png`;
    const image = await sharp(capture).metadata();
    cases.push({
      name: file.replace(/\.jpg$/, ''),
      group: `새 결과 ${scene}`,
      result: `${REAL}/${file}`,
      capture,
      layout: fluxInputLayout(image.width!, image.height!),
      mask,
    });
  }

/**
 * Colour step between a face's ring around fixtures (3–8 px, past the 2 px fade) and its interior
 * (≥ 16 px): a visible halo would raise it after the correction.
 */
function halo(image: Pixels, mask: RegionMask, region: number) {
  const { width, height, data } = mask;
  const near = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[y * width + x] === FIXTURE_REGION)
        for (let dy = -16; dy <= 16; dy++)
          for (let dx = -16; dx <= 16; dx++) {
            const px = x + dx,
              py = y + dy;
            if (px < 0 || py < 0 || px >= width || py >= height) continue;
            const d = Math.max(Math.abs(dx), Math.abs(dy));
            const i = py * width + px;
            near[i] = near[i] ? Math.min(near[i], d) : d;
          }
  const ring: RegionMask = { ...mask, data: new Uint8Array(width * height) };
  const inner: RegionMask = { ...mask, data: new Uint8Array(width * height) };
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== region) continue;
    if (near[i] >= 3 && near[i] <= 8) ring.data[i] = region;
    else if (!near[i]) inner.data[i] = region;
  }
  const mean = (m: RegionMask) => {
    let a = 0,
      b = 0,
      n = 0;
    for (let i = 0; i < m.data.length; i++) {
      if (!m.data[i]) continue;
      const r = image.data[i * 4],
        g = image.data[i * 4 + 1],
        bl = image.data[i * 4 + 2];
      // Chromaticity only (a rough opponent pair), enough to see a tinted rim.
      a += r - g;
      b += (r + g) / 2 - bl;
      n++;
    }
    return n > 50 ? [a / n, b / n] : undefined;
  };
  const r = mean(ring),
    i = mean(inner);
  return r && i ? Math.hypot(r[0] - i[0], r[1] - i[1]) : undefined;
}

const rows: Record<string, unknown>[] = [];
const sheets: { name: string; tiles: Buffer[]; width: number; height: number }[] = [];
for (const item of cases) {
  const capture = await load(item.capture);
  const result = await load(item.result);
  const review: ColorReview = reviewResultColors({ capture, mask: item.mask, layout: item.layout, result });
  const size = { width: result.width, height: result.height };
  const reference = projectCapture(capture, item.layout, size);
  const faces = (changes?: typeof review.changes) =>
    (changes ?? []).map((c) => ({
      face: item.mask.regions[c.region - 1].key,
      dE: +c.deltaE.toFixed(2),
      colorDE: +c.colorDeltaE.toFixed(2),
      shift: c.shift,
      lab: [c.reference, c.result].map((lab) => lab.map((v) => +v.toFixed(1))),
    }));
  let fixtureChanged = 0,
    haloBefore: (number | undefined)[] = [],
    haloAfter: (number | undefined)[] = [];
  if (review.corrected) {
    const resultMask = shiftMask(
      projectMask(item.mask, item.layout, size),
      review.framing.dx,
      review.framing.dy,
    );
    for (let i = 0; i < resultMask.data.length; i++)
      if (resultMask.data[i] === 0 || resultMask.data[i] === FIXTURE_REGION)
        for (let c = 0; c < 3; c++)
          if (review.corrected.data[i * 4 + c] !== result.data[i * 4 + c]) fixtureChanged++;
    haloBefore = review.changes.map((c) => halo(result, resultMask, c.region));
    haloAfter = review.changes.map((c) => halo(review.corrected!, resultMask, c.region));
  }
  // Unaligned results: the faces as drawn, for the record only (not used by the app).
  const unaligned = review.framing.aligned
    ? undefined
    : faces(
        compareFaces(
          reference,
          result,
          projectMask(item.mask, item.layout, size),
          projectMask(item.mask, item.layout, size),
        ),
      );
  rows.push({
    name: item.name,
    group: item.group,
    framing: {
      score: +review.framing.score.toFixed(3),
      dx: review.framing.dx,
      dy: review.framing.dy,
      aligned: review.framing.aligned,
    },
    faces: faces(review.changes),
    warnings: review.warnings.map((w) => item.mask.regions[w.region - 1].key),
    residual: faces(review.residual),
    ...(unaligned ? { unalignedFaces: unaligned } : {}),
    fixtureOrOutsideChanged: fixtureChanged,
    halo: {
      before: haloBefore.map((v) => (v === undefined ? null : +v.toFixed(2))),
      after: haloAfter.map((v) => (v === undefined ? null : +v.toFixed(2))),
    },
  });
  const tiles = [await png(reference), await png(result), await png(review.corrected ?? result)];
  sheets.push({ name: item.name, tiles, ...size });
  if (review.corrected) writeFileSync(`${OUT}/${item.name}-corrected.png`, await png(review.corrected));
}
writeFileSync(`${OUT}/summary.json`, JSON.stringify(rows, null, 1));
for (const row of rows) console.log(JSON.stringify(row));

// One sheet: render | FLUX result | corrected, a row per result, at half size.
const scale = 0.5;
const cell = { width: Math.round(992 * scale), height: Math.round(672 * scale) };
const label = 28;
const composites: Parameters<ReturnType<typeof sharp>['composite']>[0] = [];
for (const [r, sheet] of sheets.entries())
  for (const [c, tile] of sheet.tiles.entries()) {
    composites.push({
      input: await sharp(tile).resize(cell.width, cell.height, { fit: 'fill' }).png().toBuffer(),
      left: c * (cell.width + 8),
      top: r * (cell.height + label) + label,
    });
    composites.push({
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${cell.width}" height="${label}"><text x="4" y="20" font-family="sans-serif" font-size="16">${sheet.name} · ${['렌더(입력)', 'FLUX 결과', '면 색 보정'][c]}</text></svg>`,
      ),
      left: c * (cell.width + 8),
      top: r * (cell.height + label),
    });
  }
await sharp({
  create: {
    width: 3 * cell.width + 16,
    height: sheets.length * (cell.height + label),
    channels: 3,
    background: '#ffffff',
  },
})
  .composite(composites)
  .png()
  .toFile(`${OUT}/sheet.png`);
console.log(`wrote ${OUT}/summary.json and sheet.png (${rows.length} results)`);
