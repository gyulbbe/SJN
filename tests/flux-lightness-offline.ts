/**
 * FLUX wall/floor lightness, offline (no AI call): the colour check and face correction of
 * `color.ts` on saved FLUX results, against the render each was made from, with the face lightness
 * (L*) of render, result and corrected result side by side.
 *
 * Sets (each only if its files exist; all are git-ignored local results):
 * - 어두운 벽: the dark charcoal-tile room of the app flow (`test-results/e2e-flow/ai/B`): the
 *   current method and experiments A, B, C. Only screenshots were kept, so the region mask is
 *   built from the capture's geometry (`test-results/flux-lightness/dark-mask.json`, written by
 *   `tmp`-style scripts; see docs/flux-material-color-results-20261004.md).
 * - 방 안 3D·2D: `test-results/flux-input-in-room` (8 results, renderer masks).
 * - 합성: `test-results/flux-composite` (8 results of the current / empty-room / placeholder methods).
 *
 * Usage: node tests/run-browser-test.mjs tests/flux-lightness-offline.ts [label]
 * Writes test-results/flux-lightness/<label or "run">/summary.json and sheet.png.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import {
  FIXTURE_REGION,
  projectCapture,
  projectMask,
  reviewResultColors,
  rgbToLab,
  shiftMask,
  type ColorReview,
  type Pixels,
  type RegionMask,
} from '../src/lib/ai-export/color';
import { fluxInputLayout, type FluxInputLayout } from '../src/lib/ai-export/contract';

const args = process.argv.slice(2).filter((a) => !a.endsWith('.ts'));
const label = args.find((a) => !a.startsWith('--')) ?? 'run';
const OUT = `test-results/flux-lightness/${label}`;
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
function readMask(path: string): RegionMask {
  const json = JSON.parse(readFileSync(path, 'utf8'));
  const data = json.base64 ? Uint8Array.from(Buffer.from(json.base64, 'base64')) : Uint8Array.from(json.data);
  return { width: json.width, height: json.height, regions: json.regions, data };
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

// ---- 어두운 벽 (숯색 타일, 곰 변기·세면대, 정면) ----
const DARK = 'test-results/e2e-flow/ai/B';
const DARK_MASK = 'test-results/flux-lightness/dark-mask.json';
if (existsSync(DARK_MASK) && existsSync(`${DARK}/실험_A-정면-img0.png`)) {
  const mask = readMask(DARK_MASK);
  const capture = `${DARK}/실험_A-정면-img0.png`;
  const identity: FluxInputLayout = {
    width: 1024,
    height: 683,
    scale: 1,
    x: 0,
    y: 0,
    contentWidth: 1024,
    contentHeight: 683,
  };
  cases.push({
    name: 'dark-current',
    group: '어두운 벽',
    result: `${DARK}/지금_방식-정면-img1.png`,
    capture,
    layout: fluxInputLayout(1024, 683),
    mask,
  });
  for (const [name, file] of [
    ['dark-A', '실험_A-정면-img1.png'],
    ['dark-B', '실험_B-정면-img1.png'],
    ['dark-C', '실험_C-정면-img1.png'],
  ])
    cases.push({ name, group: '어두운 벽', result: `${DARK}/${file}`, capture, layout: identity, mask });
}

// ---- flux-input-in-room ----
const ROOM = 'test-results/flux-input-in-room';
if (existsSync(`${ROOM}/real`))
  for (const file of readdirSync(`${ROOM}/real`).filter((f) => f.endsWith('.jpg'))) {
    const name = file.replace(/\.jpg$/, '');
    const input = name.replace(/-(plain|bare)-\d+$/, '');
    const capture = `${ROOM}/payload/${input}-capture.png`;
    if (!existsSync(capture)) continue;
    const mask = readMask(`${ROOM}/payload/${input}-mask.json`);
    cases.push({
      name,
      group: '방 안 3D·2D',
      result: `${ROOM}/real/${file}`,
      capture,
      layout: fluxInputLayout(mask.width, mask.height),
      mask,
    });
  }

// ---- flux-composite ----
const COMPOSITE = 'test-results/flux-composite';
if (existsSync(`${COMPOSITE}/real`))
  for (const file of readdirSync(`${COMPOSITE}/real`).filter((f) => f.endsWith('.jpg'))) {
    const name = file.replace(/\.jpg$/, '');
    const m = name.match(/^(.*?)-(current|empty-room|placeholders)-\d+$/);
    if (!m) continue;
    const [, scene, method] = m;
    const capture = `${COMPOSITE}/payload/${scene}-${method === 'current' ? 'capture' : 'empty'}.png`;
    if (!existsSync(capture)) continue;
    const mask = readMask(`${COMPOSITE}/payload/${scene}-mask.json`);
    cases.push({
      name,
      group: '합성',
      result: `${COMPOSITE}/real/${file}`,
      capture,
      layout: fluxInputLayout(mask.width, mask.height),
      mask,
    });
  }

const fmt = (lab: number[]) => lab.map((v) => +v.toFixed(1));
const rows: Record<string, unknown>[] = [];
const sheets: { name: string; tiles: Buffer[]; width: number; height: number }[] = [];
for (const item of cases) {
  const capture = await load(item.capture);
  const result = await load(item.result);
  const review: ColorReview = reviewResultColors({
    capture,
    mask: item.mask,
    layout: item.layout,
    result,
  });
  const size = { width: result.width, height: result.height };
  const reference = projectCapture(capture, item.layout, size);
  const faces = review.changes.map((c, i) => {
    const after = review.residual?.find((r) => r.region === c.region);
    const extra = c as unknown as Record<string, unknown>;
    return {
      face: item.mask.regions[c.region - 1].key,
      kind: c.kind,
      refL: +c.reference[0].toFixed(1),
      resL: +c.result[0].toFixed(1),
      dL: +(c.result[0] - c.reference[0]).toFixed(1),
      colorDE: +c.colorDeltaE.toFixed(2),
      shift: c.shift,
      afterL: after ? +after.result[0].toFixed(1) : null,
      afterDL: after ? +(after.result[0] - after.reference[0]).toFixed(1) : null,
      afterColorDE: after ? +after.colorDeltaE.toFixed(2) : null,
      ...(extra.lightnessDelta !== undefined ? { lightnessDelta: extra.lightnessDelta } : {}),
      lab: [fmt(c.reference), fmt(c.result)],
      warn: review.warnings.includes(c),
    };
    void i;
  });
  // Pixels the correction must not touch: fixtures, glass and unchecked areas.
  let untouched = 0;
  if (review.corrected) {
    const resultMask = shiftMask(
      projectMask(item.mask, item.layout, size),
      review.framing.dx,
      review.framing.dy,
    );
    for (let i = 0; i < resultMask.data.length; i++)
      if (resultMask.data[i] === 0 || resultMask.data[i] === FIXTURE_REGION)
        for (let c = 0; c < 3; c++)
          if (review.corrected.data[i * 4 + c] !== result.data[i * 4 + c]) untouched++;
  }
  rows.push({
    name: item.name,
    group: item.group,
    framing: { score: +review.framing.score.toFixed(3), aligned: review.framing.aligned },
    warnings: review.warnings.map((w) => item.mask.regions[w.region - 1].key),
    faces,
    fixtureOrOutsideChanged: untouched,
  });
  const tiles = [await png(reference), await png(result), await png(review.corrected ?? result)];
  sheets.push({ name: item.name, tiles, ...size });
  if (review.corrected) writeFileSync(`${OUT}/${item.name}-corrected.png`, await png(review.corrected));
}
writeFileSync(`${OUT}/summary.json`, JSON.stringify(rows, null, 1));
for (const row of rows) {
  const r = row as {
    name: string;
    framing: { score: number; aligned: boolean };
    warnings: string[];
    faces: Record<string, unknown>[];
    fixtureOrOutsideChanged: number;
  };
  console.log(
    `${r.name.padEnd(36)} framing ${r.framing.score} ${r.framing.aligned ? '' : '(skipped)'} warn=[${r.warnings}] untouchedChanged=${r.fixtureOrOutsideChanged}`,
  );
  for (const f of r.faces)
    console.log(
      `   ${String(f.face).slice(0, 14).padEnd(14)} ${f.kind} L* ${f.refL} → ${f.resL} (${f.dL}) colorDE ${f.colorDE} | after L ${f.afterL} (${f.afterDL}) colorDE ${f.afterColorDE}${f.lightnessDelta !== undefined ? ` lightnessΔ ${f.lightnessDelta}` : ''}${f.warn ? ' WARN' : ''}`,
    );
}

const scale = 0.5;
const cell = { width: Math.round(992 * scale), height: Math.round(672 * scale) };
const heading = 28;
const composites: Parameters<ReturnType<typeof sharp>['composite']>[0] = [];
for (const [r, sheet] of sheets.entries())
  for (const [c, tile] of sheet.tiles.entries()) {
    composites.push({
      input: await sharp(tile).resize(cell.width, cell.height, { fit: 'fill' }).png().toBuffer(),
      left: c * (cell.width + 8),
      top: r * (cell.height + heading) + heading,
    });
    composites.push({
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${cell.width}" height="${heading}"><text x="4" y="20" font-family="sans-serif" font-size="16">${sheet.name} · ${['렌더(입력)', 'FLUX 결과', '면 보정'][c]}</text></svg>`,
      ),
      left: c * (cell.width + 8),
      top: r * (cell.height + heading),
    });
  }
if (sheets.length)
  await sharp({
    create: {
      width: 3 * cell.width + 16,
      height: sheets.length * (cell.height + heading),
      channels: 3,
      background: '#ffffff',
    },
  })
    .composite(composites)
    .png()
    .toFile(`${OUT}/sheet.png`);
void rgbToLab;
console.log(`wrote ${OUT}/summary.json (${rows.length} results)`);

// ---------- 합성 방식: the model's empty room, fixtures put on after the correction ----------
/** Chessboard distance of every pixel to the nearest pixel where `near` is true. */
function chessboard(width: number, height: number, near: (i: number) => boolean) {
  const far = width + height;
  const d = new Uint16Array(width * height);
  for (let i = 0; i < d.length; i++) d[i] = near(i) ? 0 : far;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 1);
      if (y > 0) {
        d[i] = Math.min(d[i], d[i - width] + 1);
        if (x > 0) d[i] = Math.min(d[i], d[i - width - 1] + 1);
        if (x < width - 1) d[i] = Math.min(d[i], d[i - width + 1] + 1);
      }
    }
  for (let y = height - 1; y >= 0; y--)
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (x < width - 1) d[i] = Math.min(d[i], d[i + 1] + 1);
      if (y < height - 1) {
        d[i] = Math.min(d[i], d[i + width] + 1);
        if (x < width - 1) d[i] = Math.min(d[i], d[i + width + 1] + 1);
        if (x > 0) d[i] = Math.min(d[i], d[i + width - 1] + 1);
      }
    }
  return d;
}
/**
 * Mean L* of the room ring around the fixtures (2–6 px past their coverage) minus the mean of the
 * same faces far from them (≥ 24 px): a light halo is a positive step the render does not have.
 */
function ringStep(image: Pixels, coverage: Uint8Array, mask: RegionMask) {
  const { width, height } = image;
  const away = chessboard(width, height, (i) => coverage[i] > 0);
  let ring = 0,
    nr = 0,
    inner = 0,
    ni = 0;
  for (let i = 0; i < width * height; i++) {
    const label = mask.data[i];
    if (!label || label === FIXTURE_REGION || coverage[i] > 0) continue;
    const L = rgbToLab(image.data[i * 4], image.data[i * 4 + 1], image.data[i * 4 + 2])[0];
    if (away[i] >= 2 && away[i] <= 6) {
      ring += L;
      nr++;
    } else if (away[i] >= 24) {
      inner += L;
      ni++;
    }
  }
  return nr > 50 && ni > 50 ? ring / nr - inner / ni : undefined;
}

/** Mean L* of the fully covered fixture pixels (what the room's colour correction does to them). */
function fixtureLightness(image: Pixels, coverage: Uint8Array) {
  let sum = 0,
    n = 0;
  for (let i = 0; i < coverage.length; i++)
    if (coverage[i] === 255) {
      sum += rgbToLab(image.data[i * 4], image.data[i * 4 + 1], image.data[i * 4 + 2])[0];
      n++;
    }
  return n ? +(sum / n).toFixed(1) : undefined;
}

const compositeRows: Record<string, unknown>[] = [];
const compositeTiles: { name: string; tiles: Buffer[] }[] = [];
if (existsSync(`${COMPOSITE}/real`)) {
  const { composeFluxResult, resultOnCapture, placeholderRoom } =
    await import('../src/lib/ai-export/composite');
  type Layers = import('../src/lib/ai-export/composite').RoomLayers;
  const payloads = new Map<
    string,
    { layers: Layers; mask: RegionMask; boxes: [number, number, number, number][] }
  >();
  for (const file of readdirSync(`${COMPOSITE}/real`).filter((f) => f.endsWith('.jpg'))) {
    const name = file.replace(/\.jpg$/, '');
    const m = name.match(/^(.*?)-(empty-room|placeholders)-\d+$/);
    if (!m) continue;
    const [, scene, method] = m;
    if (!payloads.has(scene)) {
      const full = await load(`${COMPOSITE}/payload/${scene}-capture.png`);
      const shadowed = await load(`${COMPOSITE}/payload/${scene}-shadowed.png`);
      const empty = await load(`${COMPOSITE}/payload/${scene}-empty.png`);
      const coverageImage = await load(`${COMPOSITE}/payload/${scene}-coverage.png`);
      const coverage = new Uint8Array(full.width * full.height).map((_, i) => coverageImage.data[i * 4]);
      const layers: Layers = {
        width: full.width,
        height: full.height,
        full: full.data as Uint8ClampedArray,
        shadowed: shadowed.data as Uint8ClampedArray,
        empty: empty.data as Uint8ClampedArray,
        coverage,
      };
      const sceneJson = JSON.parse(readFileSync(`${COMPOSITE}/payload/${scene}-scene.json`, 'utf8'));
      payloads.set(scene, {
        layers,
        mask: readMask(`${COMPOSITE}/payload/${scene}-mask.json`),
        boxes: Object.values(sceneJson.boxes) as [number, number, number, number][],
      });
    }
    const { layers, mask, boxes } = payloads.get(scene)!;
    const size = { width: layers.width, height: layers.height };
    const layout = fluxInputLayout(layers.width, layers.height);
    const input = method === 'placeholders' ? placeholderRoom(layers) : { ...size, data: layers.empty };
    const result = await load(`${COMPOSITE}/real/${file}`);
    const composed = composeFluxResult({ result, input, layers, mask, layout, boxes });
    const render: Pixels = { ...size, data: layers.full };
    const row: Record<string, unknown> = {
      name,
      framing: +composed.review.framing.score.toFixed(3),
      shifted: composed.shifted,
      warnings: composed.review.warnings.map((w) => w.kind),
      faces: composed.review.changes.map((c) => ({
        kind: c.kind,
        refL: +c.reference[0].toFixed(1),
        resL: +c.result[0].toFixed(1),
        afterL: +(composed.review.residual?.find((r) => r.region === c.region)?.result[0] ?? NaN).toFixed(1),
      })),
      fixtureL: {
        render: fixtureLightness(render, layers.coverage),
        raw: fixtureLightness(composed.raw, layers.coverage),
        corrected: composed.corrected ? fixtureLightness(composed.corrected, layers.coverage) : null,
      },
      ringStep: {
        render: ringStep(render, layers.coverage, mask),
        raw: ringStep(composed.raw, layers.coverage, mask),
        corrected: composed.corrected ? ringStep(composed.corrected, layers.coverage, mask) : null,
      },
    };
    for (const key of ['render', 'raw', 'corrected'] as const) {
      const v = (row.ringStep as Record<string, number | undefined | null>)[key];
      if (typeof v === 'number')
        (row.ringStep as Record<string, number | undefined | null>)[key] = +v.toFixed(2);
    }
    compositeRows.push(row);
    console.log(
      `${name.padEnd(40)} L* ${JSON.stringify((row.faces as { refL: number; resL: number; afterL: number }[]).map((f) => `${f.refL}→${f.resL}→${f.afterL}`))} ring ${JSON.stringify(row.ringStep)} fixtureL ${JSON.stringify(row.fixtureL)}`,
    );
    if (composed.corrected)
      writeFileSync(`${OUT}/composite-${name}-corrected.png`, await png(composed.corrected));
    writeFileSync(`${OUT}/composite-${name}-raw.png`, await png(composed.raw));
    compositeTiles.push({
      name,
      tiles: [
        await png(render),
        await png(resultOnCapture(result, layout, size)),
        await png(composed.raw),
        await png(composed.corrected ?? composed.raw),
      ],
    });
  }
}
writeFileSync(`${OUT}/composite-summary.json`, JSON.stringify(compositeRows, null, 1));
if (compositeTiles.length) {
  const w = 480,
    h = 320;
  const parts: Parameters<ReturnType<typeof sharp>['composite']>[0] = [];
  for (const [r, item] of compositeTiles.entries())
    for (const [c, tile] of item.tiles.entries()) {
      parts.push({
        input: await sharp(tile).resize(w, h, { fit: 'fill' }).png().toBuffer(),
        left: c * (w + 6),
        top: r * (h + heading) + heading,
      });
      parts.push({
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${heading}"><text x="4" y="20" font-family="sans-serif" font-size="15">${item.name} · ${['렌더', '모델 빈 방', '합성(보정 전)', '합성(보정)'][c]}</text></svg>`,
        ),
        left: c * (w + 6),
        top: r * (h + heading),
      });
    }
  await sharp({
    create: {
      width: 4 * (w + 6),
      height: compositeTiles.length * (h + heading),
      channels: 3,
      background: '#ffffff',
    },
  })
    .composite(parts)
    .png()
    .toFile(`${OUT}/composite-sheet.png`);
}
