/**
 * Fixture protection on the saved 2026-09-25 FLUX results (no AI call): framing and per-fixture
 * alignment, the protected image, colour kept inside fixtures, pixels untouched outside them. The
 * scene's snapshot was not kept, so fixtures use their scene.json boxes as a stand-in mask.
 * Also writes the two manipulated images used as positive controls for the Gemma check.
 *
 * Usage: node tests/run-browser-test.mjs tests/flux-protect-offline.ts
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { fluxInputLayout } from '../src/lib/ai-export/contract';
import {
  FEATHER_PX,
  projectCapture,
  projectMask,
  protectFixtures,
  type Pixels,
} from '../src/lib/ai-export/protect';
import type { FluxFixtureKind } from '../src/lib/ai-export/scene-contract';
import { deltaE2000, type Rgb } from './helpers/delta-e';

const source = 'test-results/flux-compare-20260925';
const output = 'test-results/export-realism-stage-3/offline';
await mkdir(output, { recursive: true });

async function load(path: string): Promise<Pixels> {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
}
const save = (image: Pixels, path: string) =>
  sharp(Buffer.from(image.data), { raw: { width: image.width, height: image.height, channels: 4 } })
    .png()
    .toFile(path);

const input = await load(`${source}/input.png`);
const scene = JSON.parse(await readFile(`${source}/scene.json`, 'utf8')) as {
  fixtures: { kind: FluxFixtureKind; box: [number, number, number, number] }[];
};
// The saved input is already the model input, so the capture is that image with no padding.
const layout = fluxInputLayout(input.width, input.height);
const ids = scene.fixtures.map((f, i) => `${f.kind}-${i}`);
const kinds = Object.fromEntries(scene.fixtures.map((f, i) => [ids[i], f.kind]));
const boxMask = {
  width: input.width,
  height: input.height,
  ids,
  data: new Uint8Array(input.width * input.height),
};
scene.fixtures.forEach((fixture, i) => {
  const [l, t, r, b] = fixture.box;
  for (let y = Math.floor(t * input.height); y < Math.ceil(b * input.height); y++)
    for (let x = Math.floor(l * input.width); x < Math.ceil(r * input.width); x++)
      boxMask.data[y * input.width + x] = i + 1;
});

type Row = Record<string, unknown>;
const rows: Row[] = [];
async function evaluate(name: string, result: Pixels) {
  const size = { width: result.width, height: result.height };
  const reference = projectCapture(input, layout, size);
  const mask = projectMask(boxMask, layout, size);
  const started = performance.now();
  const protectedResult = protectFixtures({ reference, result, mask, kinds });
  const ms = performance.now() - started;
  // Colour inside protected fixtures (away from the blended edge) against the original render.
  let inside = 0,
    worst = 0,
    sum = 0,
    changedOutside = 0;
  const near = (x: number, y: number) => {
    for (let dy = -2 * FEATHER_PX - 1; dy <= 2 * FEATHER_PX + 1; dy++)
      for (let dx = -2 * FEATHER_PX - 1; dx <= 2 * FEATHER_PX + 1; dx++) {
        const px = x + dx,
          py = y + dy;
        if (px >= 0 && py >= 0 && px < size.width && py < size.height && mask.data[py * size.width + px])
          return true;
      }
    return false;
  };
  const shifts = new Map(
    protectedResult.fixtures
      .filter((f) => f.status === 'protected')
      .map((f) => [ids.indexOf(f.id) + 1, f.alignment!]),
  );
  for (let y = 0; y < size.height; y++)
    for (let x = 0; x < size.width; x++) {
      const o = (y * size.width + x) * 4;
      const out: Rgb = [
        protectedResult.image.data[o],
        protectedResult.image.data[o + 1],
        protectedResult.image.data[o + 2],
      ];
      const shifted = [...shifts].find(([index, a]) => {
        const sx = x - a.dx,
          sy = y - a.dy;
        if (sx < 0 || sy < 0 || sx >= size.width || sy >= size.height) return false;
        // Interior only: every pixel within the feather reach belongs to the fixture.
        for (let k = -2 * FEATHER_PX; k <= 2 * FEATHER_PX; k++)
          if (
            mask.data[Math.min(size.height - 1, Math.max(0, sy + k)) * size.width + sx] !== index ||
            mask.data[sy * size.width + Math.min(size.width - 1, Math.max(0, sx + k))] !== index
          )
            return false;
        return true;
      });
      if (shifted) {
        const [, a] = shifted;
        const s = ((y - a.dy) * size.width + (x - a.dx)) * 4;
        const e = deltaE2000(out, [reference.data[s], reference.data[s + 1], reference.data[s + 2]]);
        inside++;
        sum += e;
        worst = Math.max(worst, e);
      } else if (!near(x, y) && ![...shifts].some(([, a]) => near(x - a.dx, y - a.dy))) {
        if (out.some((v, c) => v !== result.data[o + c])) changedOutside++;
      }
    }
  await save(protectedResult.image, `${output}/${name}-protected.png`);
  const row = {
    name,
    ms: Math.round(ms),
    framing: { ...protectedResult.framing, score: Number(protectedResult.framing.score.toFixed(3)) },
    fixtures: protectedResult.fixtures.map((f) => ({
      id: f.id,
      status: f.status,
      dx: f.alignment?.dx,
      dy: f.alignment?.dy,
      score: f.alignment ? Number(f.alignment.score.toFixed(3)) : undefined,
    })),
    fixtureDeltaE: inside
      ? { mean: Number((sum / inside).toFixed(3)), max: Number(worst.toFixed(3)), pixels: inside }
      : null,
    changedOutside,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
  return protectedResult;
}

for (const variant of ['A', 'B', 'C'])
  for (const seed of ['424242', '777001'])
    await evaluate(`${variant}-${seed}`, await load(`${source}/${variant}-${seed}.jpg`));

// Positive controls for the Gemma check, from the kept B result: the toilet replaced by a grey
// cylinder, and the basin painted over with the wall next to it.
const base = `${source}/B-424242.jpg`;
const meta = await sharp(base).metadata();
const W = meta.width!,
  H = meta.height!;
const boxOf = (kind: FluxFixtureKind) => {
  const f = scene.fixtures.find((x) => x.kind === kind)!;
  // Boxes are in the 496 input; the result is its double.
  return {
    left: Math.round(f.box[0] * W),
    top: Math.round(f.box[1] * H),
    width: Math.round((f.box[2] - f.box[0]) * W),
    height: Math.round((f.box[3] - f.box[1]) * H),
  };
};
const toilet = boxOf('toilet');
const cylinder = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#6f7378"/><stop offset=".45" stop-color="#b9bdc2"/><stop offset="1" stop-color="#5d6166"/></linearGradient></defs>
    <rect x="${toilet.left - 4}" y="${toilet.top - 4}" width="${toilet.width + 8}" height="${toilet.height + 6}" fill="${'#d9d6d0'}"/>
    <rect x="${toilet.left + toilet.width * 0.12}" y="${toilet.top + toilet.height * 0.18}" width="${toilet.width * 0.76}" height="${toilet.height * 0.8}" rx="6" fill="url(#g)"/>
    <ellipse cx="${toilet.left + toilet.width / 2}" cy="${toilet.top + toilet.height * 0.18}" rx="${toilet.width * 0.38}" ry="${toilet.height * 0.05}" fill="#8e9297"/>
  </svg>`,
);
await sharp(base)
  .composite([{ input: cylinder }])
  .png()
  .toFile(`${output}/manipulated-toilet-cylinder.png`);
const basin = boxOf('basin');
// The wall just left of the basin, same height, fills the basin box (and a little around it).
const patch = await sharp(base)
  .extract({
    left: Math.max(0, basin.left - basin.width - 12),
    top: basin.top - 8,
    width: basin.width + 12,
    height: basin.height + 16,
  })
  .toBuffer();
await sharp(base)
  .composite([{ input: patch, left: basin.left - 6, top: basin.top - 8 }])
  .png()
  .toFile(`${output}/manipulated-basin-erased.png`);
// A replaced or erased fixture in a kept framing must not pass as aligned.
for (const name of ['manipulated-toilet-cylinder', 'manipulated-basin-erased'])
  await evaluate(name, await load(`${output}/${name}.png`));
await writeFile(`${output}/summary.json`, JSON.stringify(rows, null, 2));

// Side by side: model input (upscaled), result, protected result.
const cells: import('sharp').OverlayOptions[] = [];
const cellW = 496,
  cellH = 336;
const names = rows.map((r) => r.name as string);
const header = 28;
for (let i = 0; i < names.length; i++) {
  const y = i * (cellH + header) + header;
  cells.push({
    input: await sharp(`${source}/input.png`).resize(cellW, cellH).png().toBuffer(),
    left: 0,
    top: y,
  });
  cells.push({
    input: await sharp(
      names[i].startsWith('manipulated') ? `${output}/${names[i]}.png` : `${source}/${names[i]}.jpg`,
    )
      .resize(cellW, cellH)
      .png()
      .toBuffer(),
    left: cellW + 8,
    top: y,
  });
  cells.push({
    input: await sharp(`${output}/${names[i]}-protected.png`).resize(cellW, cellH).png().toBuffer(),
    left: 2 * (cellW + 8),
    top: y,
  });
  const row = rows[i] as {
    fixtures: { id: string; status: string; score?: number }[];
    framing: { score: number };
  };
  const label = `${names[i]} · framing ${row.framing.score} · ${row.fixtures.map((f) => `${f.id.split('-')[0]} ${f.status}${f.score !== undefined ? ' ' + f.score : ''}`).join(' · ')}`;
  cells.push({
    input: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${3 * cellW + 16}" height="${header}"><text x="4" y="19" font-family="sans-serif" font-size="15">${label}</text></svg>`,
    ),
    left: 0,
    top: y - header,
  });
}
await sharp({
  create: {
    width: 3 * cellW + 16,
    height: names.length * (cellH + header),
    channels: 4,
    background: '#ffffff',
  },
})
  .composite(cells)
  .png()
  .toFile(`${output}/sheet.png`);
console.log(`written to ${output}`);
