/**
 * Fixture protection on the stage-3 real FLUX results (no AI call): the 1024 capture, its real
 * fixture id mask and the model result. Reports framing and per-fixture alignment, colour inside
 * protected fixtures against the render, untouched pixels outside, and how different the pasted
 * fixture is from what the model drew there. Writes the protected images and zoomed crops.
 *
 * Usage: node tests/run-browser-test.mjs tests/flux-stage3-evaluate.ts
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import {
  FEATHER_PX,
  maskBounds,
  projectCapture,
  projectMask,
  protectFixtures,
  type FixtureMask,
  type Pixels,
} from '../src/lib/ai-export/protect';
import type { FluxInputLayout } from '../src/lib/ai-export/contract';
import type { FluxFixtureKind } from '../src/lib/ai-export/scene-contract';
import { deltaE2000, lab, type Rgb } from './helpers/delta-e';

const root = 'test-results/export-realism-stage-3';
const output = `${root}/protected`;
await mkdir(output, { recursive: true });
async function load(path: string): Promise<Pixels> {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
}
const encode = (image: Pixels) =>
  sharp(Buffer.from(image.data), { raw: { width: image.width, height: image.height, channels: 4 } });

const rows = [];
for (const input of ['left-corner-single', 'left-corner-acc8'])
  for (const seed of [424242, 777001]) {
    const name = `${input}-${seed}`;
    const meta = JSON.parse(await readFile(`${root}/payload/${input}-scene.json`, 'utf8')) as {
      layout: FluxInputLayout;
      maskIds: string[];
      kinds: Record<string, FluxFixtureKind>;
    };
    const capture = await load(`${root}/payload/${input}-capture.png`);
    const maskImage = await load(`${root}/payload/${input}-mask.png`);
    const mask: FixtureMask = {
      width: maskImage.width,
      height: maskImage.height,
      ids: meta.maskIds,
      data: Uint8Array.from({ length: maskImage.width * maskImage.height }, (_, i) => maskImage.data[i * 4]),
    };
    const result = await load(`${root}/real/${name}.jpg`);
    const size = { width: result.width, height: result.height };
    const reference = projectCapture(capture, meta.layout, size);
    const projected = projectMask(mask, meta.layout, size);
    const started = performance.now();
    const protectedResult = protectFixtures({ reference, result, mask: projected, kinds: meta.kinds });
    const ms = performance.now() - started;
    await encode(protectedResult.image).png().toFile(`${output}/${name}-protected.png`);
    const fixtures = [];
    for (const f of protectedResult.fixtures) {
      const index = projected.ids.indexOf(f.id) + 1;
      const box = maskBounds(projected, index);
      const entry: Record<string, unknown> = {
        id: f.id,
        kind: f.kind,
        status: f.status,
        score: f.alignment ? +f.alignment.score.toFixed(3) : undefined,
        shift: f.alignment ? [f.alignment.dx, f.alignment.dy] : undefined,
      };
      if (f.status === 'protected' && box && f.alignment) {
        // Interior: pixels whose whole feather neighbourhood is this fixture.
        let n = 0,
          e = 0,
          worst = 0,
          dL = 0;
        const { dx, dy } = f.alignment;
        const r = 2 * FEATHER_PX;
        for (let y = box.top; y < box.bottom; y++)
          for (let x = box.left; x < box.right; x++) {
            let interior = true;
            for (let k = -r; k <= r && interior; k++)
              interior =
                projected.data[Math.max(0, Math.min(size.height - 1, y + k)) * size.width + x] === index &&
                projected.data[y * size.width + Math.max(0, Math.min(size.width - 1, x + k))] === index;
            // The model's shift can push a border pixel of the fixture out of the image.
            if (!interior || x + dx < 0 || y + dy < 0 || x + dx >= size.width || y + dy >= size.height)
              continue;
            const s = (y * size.width + x) * 4,
              o = ((y + dy) * size.width + x + dx) * 4;
            const out: Rgb = [
              protectedResult.image.data[o],
              protectedResult.image.data[o + 1],
              protectedResult.image.data[o + 2],
            ];
            const ref: Rgb = [reference.data[s], reference.data[s + 1], reference.data[s + 2]];
            const model: Rgb = [result.data[o], result.data[o + 1], result.data[o + 2]];
            const d = deltaE2000(out, ref);
            e += d;
            worst = Math.max(worst, d);
            dL += lab(ref)[0] - lab(model)[0];
            n++;
          }
        entry.interiorPixels = n;
        entry.deltaE = n ? { mean: +(e / n).toFixed(3), max: +worst.toFixed(3) } : null;
        // Positive: the pasted render is brighter than what the model drew there.
        entry.lightnessVsModel = n ? +(dL / n).toFixed(1) : null;
        // Zoomed crop: model result | protected.
        const pad = 24;
        const crop = {
          left: Math.max(0, box.left + dx - pad),
          top: Math.max(0, box.top + dy - pad),
          width: Math.min(size.width - Math.max(0, box.left + dx - pad), box.right - box.left + 2 * pad),
          height: Math.min(size.height - Math.max(0, box.top + dy - pad), box.bottom - box.top + 2 * pad),
        };
        const scale = Math.max(1, Math.round(360 / crop.height));
        const a = await sharp(`${root}/real/${name}.jpg`)
          .extract(crop)
          .resize(crop.width * scale, crop.height * scale, { kernel: 'nearest' })
          .png()
          .toBuffer();
        const b = await encode(protectedResult.image)
          .extract(crop)
          .resize(crop.width * scale, crop.height * scale, { kernel: 'nearest' })
          .png()
          .toBuffer();
        await sharp({
          create: {
            width: crop.width * scale * 2 + 8,
            height: crop.height * scale,
            channels: 4,
            background: '#ffffff',
          },
        })
          .composite([
            { input: a, left: 0, top: 0 },
            { input: b, left: crop.width * scale + 8, top: 0 },
          ])
          .png()
          .toFile(`${output}/${name}-${f.kind}-zoom.png`);
      }
      fixtures.push(entry);
    }
    const row = {
      name,
      ms: Math.round(ms),
      framing: { ...protectedResult.framing, score: +protectedResult.framing.score.toFixed(3) },
      fixtures,
    };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
await writeFile(`${output}/summary.json`, JSON.stringify(rows, null, 2));
