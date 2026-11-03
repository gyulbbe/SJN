/**
 * Round 1 (no AI call): the catalog side of tile matching. Every public tile's first photo, margins
 * trimmed, drawn two ways (the photo alone; repeated with its joints over a 900 mm square), gives
 * model-free colour/texture numbers and DINOv2 / CLIP / SigLIP2 embeddings, written as float32
 * matrices in the order of ids.json. Timings, the execution provider and the GPU adapter are recorded.
 *
 * Usage: node tests/run-browser-test.mjs tests/catalog-match/browser/catalog-features.ts
 *          [--ep webgpu|wasm] [--models dinov2-small:q8,clip-b32:q8,siglip2-b16:q8] [--limit N] [--out features/catalog]
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { OUT, SNAPSHOT } from '../paths.mjs';
import { modelPath } from '../models.mjs';
import { openHarness } from './harness';
import type * as Page from './page';

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
};
const ep = arg('ep', 'webgpu') as 'webgpu' | 'wasm';
const limit = Number(arg('limit', '0'));
/** WASM threads for this offline precompute (needs isolation); its timings are not the app's. */
const threads = Number(arg('threads', '1'));
const outDir = arg('out', 'features/catalog');
const FILES: Record<string, string> = {
  'dinov2-small:q8': 'onnx/model_quantized.onnx',
  'dinov2-base:q8': 'onnx/model_quantized.onnx',
  'dinov2-large:q8': 'onnx/model_quantized.onnx',
  'dinov2-small:fp16': 'onnx/model_fp16.onnx',
  'dinov2-small:q4f16': 'onnx/model_q4f16.onnx',
  'clip-b32:q4f16': 'onnx/vision_model_q4f16.onnx',
  'siglip2-b16:q4f16': 'onnx/vision_model_q4f16.onnx',
  'clip-b32:q8': 'onnx/vision_model_quantized.onnx',
  'siglip2-b16:q8': 'onnx/vision_model_quantized.onnx',
};
const models = arg('models', 'dinov2-small:q8,clip-b32:q8,siglip2-b16:q8').split(',');
export const WINDOW_MM = 900;

type Placement = {
  materialId: string;
  name: string;
  code: string;
  category: string;
  widthMm: number;
  heightMm: number;
  usage: string;
  color: string;
  finish: string;
  textureAssetIds: string[];
  defaultGroutWidth: number;
  defaultGroutColor: string;
};
const catalog = JSON.parse(await readFile(join(SNAPSHOT as string, 'catalog.json'), 'utf8')) as {
  takenAt: string;
  placements: Placement[];
};
const files = new Map(
  (await readdir(join(SNAPSHOT as string, 'images'))).map((file) => [file.replace(/\.[a-z]+$/, ''), file]),
);
let tiles = catalog.placements
  .filter((p) => p.category === 'tile' && files.has(p.textureAssetIds[0]))
  .map((p) => ({
    id: p.materialId,
    path: join(SNAPSHOT as string, 'images', files.get(p.textureAssetIds[0])!),
    widthMm: p.widthMm,
    heightMm: p.heightMm,
    groutMm: p.defaultGroutWidth,
    groutColor: p.defaultGroutColor,
  }));
if (limit) tiles = tiles.slice(0, limit);
const target = join(OUT as string, outDir);
await mkdir(target, { recursive: true });
await writeFile(join(target, 'ids.json'), JSON.stringify(tiles.map((t) => t.id)));

const harness = await openHarness({
  pageEntry: resolve('tests/catalog-match/browser/page.ts'),
  gpu: ep === 'webgpu',
  isolated: threads > 1,
});
const log: Record<string, unknown> = {
  takenAt: catalog.takenAt,
  tiles: tiles.length,
  ep,
  threads,
  startedAt: new Date().toISOString(),
};
try {
  const { page } = harness;
  log.adapter = await page.evaluate(() => (window as unknown as { CM: typeof Page }).CM.gpuAdapter());
  // ---------- model-free features ----------
  if (!models.length || arg('classic', '1') === '1') {
    const started = Date.now();
    const classic: unknown[] = [];
    for (let i = 0; i < tiles.length; i += 100) {
      const batch = tiles.slice(i, i + 100);
      classic.push(
        ...(await page.evaluate(async (items) => {
          const CM = (window as unknown as { CM: typeof Page }).CM;
          const out = [];
          for (const item of items) {
            const bitmap = await CM.loadBitmap(item.path);
            const trimmed = CM.trimMargins(bitmap);
            out.push({
              id: item.id,
              size: [bitmap.width, bitmap.height],
              trimmed: [trimmed.width, trimmed.height],
              ...CM.classicFeatures(trimmed),
            });
            bitmap.close();
          }
          return out;
        }, batch)),
      );
      process.stdout.write(`\rclassic ${classic.length}/${tiles.length}`);
    }
    console.log();
    await writeFile(join(target, 'classic.json'), JSON.stringify(classic));
    log.classicMs = Date.now() - started;
  }
  // ---------- embeddings ----------
  const runs: unknown[] = [];
  for (const model of models) {
    const [key, precision] = model.split(':');
    const path = modelPath(key, FILES[model]) as string;
    const info = await page.evaluate(
      async ({ key, path, ep, threads }) => {
        const CM = (window as unknown as { CM: typeof Page }).CM;
        const w = window as unknown as {
          embedder: Page.Embedder;
          rows: Record<string, number[][]>;
          times: number[];
        };
        w.embedder = await CM.openEmbedder({ ...CM.MODEL_SPECS[key], path }, ep, threads);
        w.rows = {};
        w.times = [];
        return w.embedder.info;
      },
      { key, path, ep, threads },
    );
    const started = Date.now();
    for (let i = 0; i < tiles.length; i += 50) {
      await page.evaluate(
        async ({ items, windowMm }) => {
          const CM = (window as unknown as { CM: typeof Page }).CM;
          const w = window as unknown as {
            embedder: Page.Embedder;
            rows: Record<string, number[][]>;
            times: number[];
          };
          for (const item of items) {
            const bitmap = await CM.loadBitmap(item.path);
            const trimmed = CM.trimMargins(bitmap);
            bitmap.close();
            const variants = {
              single: trimmed,
              repeat: CM.repeatTile(trimmed, item, windowMm, 448),
            };
            for (const [variant, canvas] of Object.entries(variants)) {
              const t0 = performance.now();
              const result = await w.embedder.embed(canvas);
              w.times.push(performance.now() - t0);
              for (const [output, vector] of Object.entries(result))
                (w.rows[`${variant}.${output}`] ??= []).push(Array.from(vector));
            }
          }
        },
        { items: tiles.slice(i, i + 50), windowMm: WINDOW_MM },
      );
      process.stdout.write(`\r${model} ${Math.min(tiles.length, i + 50)}/${tiles.length}`);
    }
    console.log();
    const { rows, times } = await page.evaluate(() => {
      const w = window as unknown as { rows: Record<string, number[][]>; times: number[] };
      return { rows: w.rows, times: w.times };
    });
    for (const [name, matrix] of Object.entries(rows)) {
      const flat = Float32Array.from(matrix.flat());
      await writeFile(join(target, `${key}-${precision}.${name}.f32`), Buffer.from(flat.buffer));
    }
    const sorted = [...times].sort((a, b) => a - b);
    runs.push({
      model,
      info,
      dims: Object.fromEntries(Object.entries(rows).map(([name, m]) => [name, m[0]?.length])),
      totalMs: Date.now() - started,
      inferMedianMs: sorted[sorted.length >> 1],
      inferP90Ms: sorted[Math.floor(sorted.length * 0.9)],
    });
    console.log(JSON.stringify(runs.at(-1)));
  }
  log.runs = runs;
} finally {
  log.endedAt = new Date().toISOString();
  await writeFile(join(target, `run-${ep}.json`), JSON.stringify(log, null, 2));
  await harness.close();
}
