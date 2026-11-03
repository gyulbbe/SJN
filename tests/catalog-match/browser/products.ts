/**
 * Product matching features (no AI call): every public product's direction photos on white, and every
 * toilet / basin / bath in the development photos and the fifteen (the annotation's boxes for the
 * development photos, the saved Gemma boxes for the fifteen) cut out two ways — the box as it is, and
 * the box through the app's background-removal model (BiRefNet) onto white — with the same embeddings.
 *
 * Usage: node tests/run-browser-test.mjs tests/catalog-match/browser/products.ts [--models ...]
 *          [--split heldout --out products-heldout]   (round 7: the held-out photos, the annotation's boxes)
 * Output: test-results/catalog-match/features/<out: products>/
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { OUT, ROOT, SNAPSHOT } from '../paths.mjs';
import { modelPath } from '../models.mjs';
import { openHarness } from './harness';
import type * as Page from './page';

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
};
const FILES: Record<string, string> = {
  'dinov2-small:q4f16': 'onnx/model_q4f16.onnx',
  'clip-b32:q4f16': 'onnx/vision_model_q4f16.onnx',
  'siglip2-b16:q4f16': 'onnx/vision_model_q4f16.onnx',
  // The files a deployment would use (the same values on WebGPU and WASM).
  'dinov2-small:q8': 'onnx/model_quantized.onnx',
  'siglip2-b16:q8': 'onnx/vision_model_quantized.onnx',
};
const models = arg('models', 'dinov2-small:q4f16,clip-b32:q4f16,siglip2-b16:q4f16').split(',');
const ep = arg('ep', 'webgpu') as 'webgpu' | 'wasm';
const splits = arg('split', 'fifteen,corpus-dev').split(',');
/** WASM threads for this offline precompute (needs isolation); its timings are not the app's. */
const threads = Number(arg('threads', '1'));
const BIREFNET = join(ROOT as string, 'tmp', 'background-model', 'model_fp16.onnx');
const PRODUCT = new Set(['toilet', 'basin', 'vanity', 'bath']);
type Box = { left: number; top: number; right: number; bottom: number };

const snapshot = JSON.parse(await readFile(join(SNAPSHOT as string, 'catalog.json'), 'utf8')) as {
  placements: { materialId: string; category: string; views: { assetId: string; direction: string }[] }[];
};
const files = new Map(
  (await readdir(join(SNAPSHOT as string, 'images'))).map((f) => [f.replace(/\.[a-z]+$/, ''), f]),
);
const catalogViews = snapshot.placements
  .filter((p) => p.category !== 'tile')
  .flatMap((p) =>
    p.views
      .filter((v) => files.has(v.assetId))
      .map((v) => ({
        id: p.materialId,
        category: p.category,
        direction: v.direction,
        path: join(SNAPSHOT as string, 'images', files.get(v.assetId)!),
      })),
  );
const index = JSON.parse(await readFile(join(OUT as string, 'photos', 'index.json'), 'utf8')) as {
  photos: {
    id: string;
    split: string;
    locked?: boolean;
    path: string;
    candidates: { id?: string; kind: string; box: Box }[];
    truth?: { id: string; kind: string; box: Box }[];
  }[];
};
const queries = index.photos
  .filter((p) => !p.locked && splits.includes(p.split))
  .flatMap((p) =>
    (p.split !== 'fifteen' ? (p.truth ?? []) : p.candidates.map((c, i) => ({ ...c, id: c.id ?? `c${i}` })))
      .filter((x) => PRODUCT.has(x.kind))
      .map((x) => ({
        id: `${p.id}:${x.id}`,
        photo: p.id,
        split: p.split,
        kind: x.kind === 'vanity' ? 'basin' : x.kind,
        box: x.box,
        path: p.path,
      })),
  );
const target = join(OUT as string, 'features', arg('out', 'products'));
await mkdir(target, { recursive: true });
// The GPU stays on for BiRefNet; the embeddings use `ep`.
const harness = await openHarness({
  pageEntry: resolve('tests/catalog-match/browser/page.ts'),
  gpu: true,
  isolated: threads > 1,
});
const log: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  catalogViews: catalogViews.length,
  queries: queries.length,
};
try {
  const { page } = harness;
  log.models = await page.evaluate(
    async (list) => {
      const CM = (window as unknown as { CM: typeof Page }).CM;
      const w = window as unknown as { embedders: Record<string, Page.Embedder> };
      w.embedders = {};
      for (const { name, key, path, ep, threads } of list)
        w.embedders[name] = await CM.openEmbedder({ ...CM.MODEL_SPECS[key], path }, ep, threads);
      return Object.keys(w.embedders);
    },
    models.map((model) => ({
      name: model,
      key: model.split(':')[0],
      path: modelPath(model.split(':')[0], FILES[model]) as string,
      ep,
      threads,
    })),
  );
  const embedAll = async (items: { kind: 'catalog' | 'query'; path: string; box?: Box; save?: string }[]) =>
    page.evaluate(
      async ({ items, birefnet }) => {
        const CM = (window as unknown as { CM: typeof Page }).CM;
        const w = window as unknown as { embedders: Record<string, Page.Embedder> };
        const out: Record<string, number[]>[] = [];
        for (const item of items) {
          const bitmap = await CM.loadBitmap(item.path);
          const variants: Record<string, HTMLCanvasElement> = {};
          if (item.kind === 'catalog') variants.white = CM.onWhite(bitmap);
          else {
            const crop = CM.boxCrop(bitmap, item.box!);
            variants.box = crop;
            variants.cutout = await CM.cutOut(crop, birefnet);
            if (item.save) await CM.save(item.save, await CM.canvasBlob(variants.cutout, 'image/jpeg', 0.9));
          }
          bitmap.close();
          const vectors: Record<string, number[]> = {};
          for (const [variant, canvas] of Object.entries(variants))
            for (const [name, embedder] of Object.entries(w.embedders))
              for (const [output, vector] of Object.entries(await embedder.embed(canvas)))
                vectors[`${name}.${variant}.${output}`] = Array.from(vector);
          out.push(vectors);
        }
        return out;
      },
      { items, birefnet: BIREFNET },
    );
  const write = async (prefix: string, rows: Record<string, number[]>[]) => {
    for (const name of Object.keys(rows[0] ?? {}))
      await writeFile(
        join(target, `${prefix}.${name.replace(':', '-')}.f32`),
        Buffer.from(Float32Array.from(rows.flatMap((r) => r[name])).buffer),
      );
  };
  const started = Date.now();
  await write(
    'catalog',
    await embedAll(catalogViews.map((v) => ({ kind: 'catalog' as const, path: v.path }))),
  );
  log.catalogMs = Date.now() - started;
  const q0 = Date.now();
  await write(
    'query',
    await embedAll(
      queries.map((q) => ({
        kind: 'query' as const,
        path: q.path,
        box: q.box,
        save: `crops/products/${q.id.replace(/[:]/g, '-')}.jpg`,
      })),
    ),
  );
  log.queryMs = Date.now() - q0;
  await writeFile(join(target, 'catalog.json'), JSON.stringify(catalogViews));
  await writeFile(join(target, 'queries.json'), JSON.stringify(queries));
} finally {
  log.endedAt = new Date().toISOString();
  await writeFile(join(target, 'run.json'), JSON.stringify(log, null, 2));
  await harness.close();
}
