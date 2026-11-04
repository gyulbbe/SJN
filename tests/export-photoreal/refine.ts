/**
 * Experiment C (제품별 다듬기) as the export dialog runs it (src/components/editor/ai-export.tsx), with
 * the app's own runRefine and composeFluxResult: every standard model's close-up is repainted alone
 * (one FLUX call each, through ai.ts and its ledger), cut out with the app's BiRefNet, kept only when
 * its outline overlaps the 3D one by REFINE_MIN_IOU, and put back on the model's empty room.
 *
 * The empty room is experiment A's answer for the same scene and seed: C sends exactly A's request
 * (the empty room, its prompt and seed), so it is not asked again.
 *
 * Usage: node tests/run-browser-test.mjs tests/export-photoreal/refine.ts --scenes white,charcoal
 *          [--seed 424242] [--round r3] [--dry] [--holdout]
 * Output: results/refine/<scene>-<seed>.app.png, .refine.json, products/<scene>-<seed>-<id>.png
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import type { Pixels } from '../../src/lib/ai-export/color';
import { composeFluxResult } from '../../src/lib/ai-export/composite';
import { fluxInputLayout } from '../../src/lib/ai-export/contract';
import { buildFluxProductPrompt, type FluxProduct } from '../../src/lib/ai-export/product-prompt';
import { ownMask } from '../../src/lib/ai-export/refine';
import { runRefine, type RefineProduct } from '../../src/lib/ai-export/refine-run';
import { fluxCall, StopRun } from './ai';
import { fluxNeurons } from './budget';
import { loadScene, pngBuffer, readPng, resultBase, writePng } from './io';
import { openLab } from './lab';
import { FLUX_4B, pngSize } from './methods';

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const scenes = arg('scenes').split(',').filter(Boolean);
const seed = Number(arg('seed', '424242'));
const round = arg('round', 'r3');
const dry = process.argv.includes('--dry');

const encode = async (pixels: Pixels) =>
  new Blob([new Uint8Array(await pngBuffer(pixels))], { type: 'image/png' });
const decode = async (blob: Blob) => readPng(Buffer.from(await blob.arrayBuffer()));

const lab = dry ? undefined : await openLab({ gpu: true });
try {
  let total = 0;
  for (const scene of scenes) {
    const base = resultBase('refine', scene, seed);
    if (existsSync(`${base}.app.png`)) continue;
    const room = resultBase('empty', scene, seed);
    if (!existsSync(`${room}.restored.png`))
      throw new Error(`${scene}: run experiment A (empty) and post.ts first`);
    const payload = await loadScene(scene);
    const { layers, crops, mask, capture } = payload;
    if (!layers || !crops) throw new Error(`${scene}: no layers or crops`);
    const facts = JSON.parse(readFileSync(join(payload.dir, 'products.json'), 'utf8')) as {
      id: string;
      label: string;
      fact: FluxProduct;
    }[];
    const products: RefineProduct[] = facts.flatMap((f) => {
      const crop = crops.find((c) => c.id === f.id);
      return crop ? [{ id: f.id, label: f.label, crop, fact: f.fact }] : [];
    });
    const frame = { width: layers.width, height: layers.height };
    if (dry) {
      // Each close-up's model input is at most 496 px a side; its answer is twice that.
      for (const p of products) {
        const w =
          Math.round(Math.min(496, (496 * p.crop.width) / Math.max(p.crop.width, p.crop.height)) / 16) * 16;
        const h =
          Math.round(Math.min(496, (496 * p.crop.height) / Math.max(p.crop.width, p.crop.height)) / 16) * 16;
        const n = fluxNeurons([{ width: w, height: h }], { width: w * 2, height: h * 2 });
        total += n;
        console.log(' ', scene, p.id, `${w}×${h}`, Math.round(n));
      }
      continue;
    }
    mkdirSync(join(base, '..', 'products'), { recursive: true });
    const controller = new AbortController();
    let stop: StopRun | undefined;
    const outcomes = await runRefine({
      products,
      frame,
      seed,
      signal: controller.signal,
      deps: {
        encode,
        decode,
        request: async (image, reference, requestSeed, product) => {
          const bytes = Buffer.from(await image.arrayBuffer());
          const size = pngSize(bytes);
          const prompt = buildFluxProductPrompt(product, !!reference);
          const output = { width: size.width * 2, height: size.height * 2 };
          const id = products.find((p) => p.fact === product)?.id ?? 'product';
          try {
            const { image: answer } = await fluxCall(
              {
                round,
                method: 'refine-product',
                scene,
                seed: requestSeed,
                model: FLUX_4B,
                estimate: fluxNeurons([size], output),
                sizes: {
                  product: id,
                  input: [size.width, size.height],
                  output: [output.width, output.height],
                },
              },
              { images: [bytes], prompt, ...output, seed: requestSeed },
            );
            await sharp(answer)
              .png()
              .toFile(join(base, '..', 'products', `${scene}-${seed}-${id}.png`));
            return new Blob([new Uint8Array(await sharp(answer).png().toBuffer())], { type: 'image/png' });
          } catch (error) {
            if (error instanceof StopRun) stop = error;
            throw error;
          }
        },
        cutout: async (image) => {
          const cut = await lab!.cutout(Buffer.from(await image.arrayBuffer()));
          return new Blob([new Uint8Array(cut)], { type: 'image/png' });
        },
      },
    });
    if (stop?.message.startsWith('daily limit') || stop?.message.startsWith('refused:')) {
      console.error('STOP', stop.message);
      process.exit(2);
    }
    const result = await readPng(`${room}.restored.png`);
    const composed = composeFluxResult({
      result,
      input: { width: layers.width, height: layers.height, data: layers.empty },
      layers,
      mask,
      layout: fluxInputLayout(capture.width, capture.height),
      boxes: Object.values(
        (
          JSON.parse(readFileSync(join(payload.dir, 'boxes.json'), 'utf8')) as {
            boxes: Record<string, [number, number, number, number]>;
          }
        ).boxes,
      ),
      refine: {
        layers: outcomes.flatMap((o) => (o.status === 'refined' ? [o.layer] : [])),
        owns: crops.map((crop) => ownMask(crop, frame)),
      },
    });
    await writePng(`${base}.app.png`, composed.corrected ?? composed.raw);
    await writePng(`${base}.restored.png`, composed.raw);
    writeFileSync(
      `${base}.refine.json`,
      JSON.stringify(
        {
          room: 'experiment A (empty) answer, same request',
          shown: composed.corrected ? 'corrected' : 'raw',
          shifted: composed.shifted,
          outcomes: outcomes.map((o) =>
            o.status === 'refined'
              ? { id: o.id, status: o.status, iou: o.iou, plainIou: o.plainIou, ratio: o.ratio }
              : {
                  id: o.id,
                  status: o.status,
                  reason: o.reason,
                  message: o.message,
                  iou: o.iou,
                  detail: o.detail,
                },
          ),
        },
        null,
        1,
      ),
    );
    // The Gemma check of C is A's (the same empty room, asked about added objects only).
    if (existsSync(`${room}.check.json`))
      writeFileSync(`${base}.check.json`, readFileSync(`${room}.check.json`));
    if (existsSync(`${room}.post.json`))
      writeFileSync(`${base}.post.json`, readFileSync(`${room}.post.json`));
    console.log(
      scene,
      outcomes
        .map((o) => `${o.id}:${o.status}${'iou' in o && o.iou ? ` ${o.iou.toFixed(2)}` : ''}`)
        .join(', '),
    );
  }
  if (dry) console.log(`about ${Math.round(total)} neurons`);
} finally {
  await lab?.close();
}
