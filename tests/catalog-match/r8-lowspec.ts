/**
 * Round 8 (no AI call): how long the recommended combination's browser part takes per photo, on this
 * PC as it is (WebGPU allowed), on one WASM thread (the app's page is not cross-origin isolated), and
 * on one WASM thread with the CPU slowed 4× (CDP, the stand-in for a PC without a GPU). For each photo:
 * cut out every face (the app's rectifyImage, the clean part), the model-free numbers, DINOv2 q8 on
 * the 900 mm window, the fused ranking against the whole tile catalogue, and each product's box
 * through DINOv2 against every public product photo. The model is read from disk (its 24.4 MB
 * download is not in the times) and the catalogue features are parsed once (also timed).
 *
 * Usage: node tests/run-browser-test.mjs tests/catalog-match/r8-lowspec.ts [--photos pc-01,...]
 * Output: test-results/catalog-match/r8-lowspec/summary.json
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { out, readJson } from './data';
import { modelPath } from './models.mjs';
import { openHarness } from './browser/harness';
import type * as Page from './browser/page';

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
};
const PHOTOS = arg('photos', 'pc-01,pc-02,remote-02,additional-05,additional-09').split(',');
const target = join(out, 'r8-lowspec');
mkdirSync(target, { recursive: true });
type Box = { left: number; top: number; right: number; bottom: number };
type Quad = { x: number; y: number }[];

const faces = readJson<
  {
    id: string;
    photo: string;
    path: string;
    face: string;
    regions: { clean?: { quad: Quad; mm: { widthMm: number; heightMm: number } } };
  }[]
>(join(out, 'features', 'queries-photos-q8', 'faces.json'));
const index = readJson<{ photos: { id: string; path: string; candidates: { kind: string; box: Box }[] }[] }>(
  join(out, 'photos', 'index.json'),
);
const jobs = PHOTOS.map((id) => ({
  id,
  path: index.photos.find((p) => p.id === id)!.path,
  faces: faces
    .filter((f) => f.photo === id && f.regions.clean)
    .map((f) => ({ face: f.face, quad: f.regions.clean!.quad, mm: f.regions.clean!.mm })),
  boxes: index.photos
    .find((p) => p.id === id)!
    .candidates.filter((c) => ['toilet', 'basin', 'vanity', 'bath'].includes(c.kind))
    .map((c) => c.box),
}));
// The catalogue features the browser would download (sizes recorded as they are on disk).
const catalogDir = join(out, 'features', 'catalog');
const classicText = readFileSync(join(catalogDir, 'classic.json'), 'utf8');
const ids = readJson<string[]>(join(catalogDir, 'ids.json'));
const usage = new Map(
  readJson<{ placements: { materialId: string; usage: string }[] }>(
    join(out, 'snapshot', 'catalog.json'),
  ).placements.map((p) => [p.materialId, p.usage]),
);
const tileMatrix = readFileSync(join(out, 'features', 'catalog-q8', 'dinov2-small-q8.repeat.patchmean.f32'));
const productMatrix = readFileSync(
  join(out, 'features', 'products', 'catalog.dinov2-small-q4f16.white.pooled.f32'),
);
const files = {
  classicBytes: Buffer.byteLength(classicText),
  tileMatrixBytes: tileMatrix.length,
  productMatrixBytes: productMatrix.length,
};
const conditions = [
  { name: 'webgpu', gpu: true, ep: 'webgpu' as const, throttle: 1 },
  { name: 'wasm-1thread', gpu: false, ep: 'wasm' as const, throttle: 1 },
  { name: 'wasm-1thread-cpu4x', gpu: false, ep: 'wasm' as const, throttle: 4 },
];
const results: Record<string, unknown> = { photos: PHOTOS, files };
for (const condition of conditions) {
  const harness = await openHarness({
    pageEntry: resolve('tests/catalog-match/browser/page.ts'),
    gpu: condition.gpu,
    cpuThrottle: condition.throttle,
  });
  try {
    const run = await harness.page.evaluate(
      async ({ jobs, classicText, ids, usage, tile, product, modelPath, ep }) => {
        const CM = (window as unknown as { CM: typeof Page }).CM;
        const t0 = performance.now();
        const classic = JSON.parse(classicText) as {
          colour: Page.ColourFeatures;
          texture: Page.TextureFeatures;
        }[];
        const tiles = new Float32Array(Uint8Array.from(atob(tile), (c) => c.charCodeAt(0)).buffer);
        const products = new Float32Array(Uint8Array.from(atob(product), (c) => c.charCodeAt(0)).buffer);
        const parseMs = performance.now() - t0;
        const t1 = performance.now();
        const embedder = await CM.openEmbedder({ ...CM.MODEL_SPECS['dinov2-small'], path: modelPath }, ep, 1);
        const modelMs = performance.now() - t1;
        const dims = 384;
        const cos = (m: Float32Array, i: number, v: Float32Array) => {
          let d = 0;
          for (let k = 0; k < dims; k++) d += m[i * dims + k] * v[k];
          return d;
        };
        const perPhoto = [];
        for (const job of jobs) {
          const times = { crop: 0, numbers: 0, embed: 0, rank: 0, products: 0 };
          const blob = await CM.photoBlob(job.path);
          for (const f of job.faces) {
            let s = performance.now();
            const ratio = f.mm.widthMm / Math.max(1, f.mm.heightMm);
            const crop = await CM.faceCrop(
              blob,
              f.quad as never,
              ratio >= 1 ? 384 : 384 * ratio,
              ratio >= 1 ? 384 / ratio : 384,
            );
            times.crop += performance.now() - s;
            s = performance.now();
            const numbers = CM.classicFeatures(crop);
            times.numbers += performance.now() - s;
            s = performance.now();
            const vector = (await embedder.embed(CM.windowCrop(crop, f.mm, 900))).patchmean;
            times.embed += performance.now() - s;
            s = performance.now();
            // The fused ranking: model-free distance and DINOv2, reciprocal ranks 0.5 / 0.5.
            const pool = ids
              .map((_, i) => i)
              .filter((i) => (f.face === 'floor' ? usage[i] !== 'wall' : usage[i] !== 'floor'));
            const a = [...pool].sort(
              (x, y) =>
                0.5 * CM.colourDistance(numbers.colour, classic[x].colour) +
                0.6 * CM.textureDistance(numbers.texture, classic[x].texture) -
                (0.5 * CM.colourDistance(numbers.colour, classic[y].colour) +
                  0.6 * CM.textureDistance(numbers.texture, classic[y].texture)),
            );
            const b = [...pool].sort((x, y) => cos(tiles, y, vector) - cos(tiles, x, vector));
            const score = new Map<number, number>();
            a.forEach((i, r) => score.set(i, (score.get(i) ?? 0) + 0.5 / (20 + r)));
            b.forEach((i, r) => score.set(i, (score.get(i) ?? 0) + 0.5 / (20 + r)));
            [...score].sort((x, y) => y[1] - x[1]).slice(0, 12);
            times.rank += performance.now() - s;
          }
          const bitmap = await createImageBitmap(blob);
          for (const box of job.boxes) {
            const s = performance.now();
            const v = (await embedder.embed(CM.boxCrop(bitmap, box))).pooled;
            const scores = Array.from({ length: products.length / dims }, (_, i) => cos(products, i, v));
            scores.sort((x, y) => y - x);
            times.products += performance.now() - s;
          }
          bitmap.close();
          const total = Object.values(times).reduce((x, y) => x + y, 0);
          perPhoto.push({
            faces: job.faces.length,
            products: job.boxes.length,
            ...Object.fromEntries(Object.entries(times).map(([k, v]) => [k, Math.round(v)])),
            total: Math.round(total),
          });
        }
        return {
          parseMs: Math.round(parseMs),
          modelMs: Math.round(modelMs),
          ep: embedder.info.ep,
          isolated: crossOriginIsolated,
          perPhoto,
        };
      },
      {
        jobs,
        classicText,
        ids,
        usage: ids.map((id) => usage.get(id) ?? 'both'),
        tile: tileMatrix.toString('base64'),
        product: productMatrix.toString('base64'),
        modelPath: modelPath('dinov2-small', 'onnx/model_quantized.onnx'),
        ep: condition.ep,
      },
    );
    results[condition.name] = run;
    const totals = run.perPhoto.map((p) => p.total);
    console.log(
      condition.name,
      'model',
      run.modelMs,
      'ms, parse',
      run.parseMs,
      'ms, per photo',
      totals.join(' / '),
      'ms',
    );
  } finally {
    await harness.close();
  }
}
writeFileSync(join(target, 'summary.json'), JSON.stringify(results, null, 1));
