/**
 * D1 of the direction-photo methods trial: how alike each answer is to the product's photo, by image
 * embeddings in Chrome (the catalog-match harness and models: DINOv2-small fp16 on WebGPU, CLIP ViT-B/32
 * q8 on WASM — q8 on WebGPU gave wrong values, docs/export-photoreal-trials-20261104.md), cosine of the
 * pooled vectors. No AI call, nothing leaves the PC.
 *
 *   node tests/run-browser-test.mjs tests/direction-photo-methods/embed.ts <round>
 * → judge/<round>-embed.json: { "<product>/<method>/<file>": { dino, clip } }
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { openHarness } from '../catalog-match/browser/harness';
import { EMBED_MODELS, OUT } from './paths.mjs';

const round = process.argv[3];
const RUNS = path.join(OUT, 'runs', round);
const outFile = path.join(OUT, 'judge', `${round}-embed.json`);
const done: Record<string, { dino: number; clip: number }> = existsSync(outFile)
  ? JSON.parse(readFileSync(outFile, 'utf8'))
  : {};

// The catalog-match page's preprocessing for these two models (tests/catalog-match/browser/page.ts MODEL_SPECS).
const MODEL_SPECS = {
  'dinov2-small': {
    key: 'dinov2-small',
    mode: 'shortest-crop',
    resize: 256,
    size: 224,
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
  },
  'clip-b32': {
    key: 'clip-b32',
    mode: 'shortest-crop',
    resize: 224,
    size: 224,
    mean: [0.48145466, 0.4578275, 0.40821073],
    std: [0.26862954, 0.26130258, 0.27577711],
  },
};
const models = {
  dino: {
    ...MODEL_SPECS['dinov2-small'],
    path: path.join(EMBED_MODELS, 'dinov2-small', '8b1f705a3a7f', 'onnx', 'model_fp16.onnx'),
    ep: 'webgpu' as const,
  },
  clip: {
    ...MODEL_SPECS['clip-b32'],
    path: path.join(EMBED_MODELS, 'clip-b32', '6b7c523703ae', 'onnx', 'vision_model_quantized.onnx'),
    ep: 'wasm' as const,
  },
};
const dataUrl = async (file: string) =>
  `data:image/png;base64,${(await sharp(file).flatten({ background: '#ffffff' }).resize(448, 448, { fit: 'contain', background: '#ffffff' }).png().toBuffer()).toString('base64')}`;

const pairs: { key: string; photo: string; answer: string }[] = [];
for (const product of existsSync(RUNS) ? readdirSync(RUNS) : []) {
  const photo = path.join(OUT, 'prep', product, 'refs', '1.png');
  for (const method of readdirSync(path.join(RUNS, product)))
    for (const file of readdirSync(path.join(RUNS, product, method)).filter((f) =>
      /^(front|left|right|back)-\d+\.png$/.test(f),
    )) {
      const key = `${product}/${method}/${file}`;
      if (!done[key]) pairs.push({ key, photo, answer: path.join(RUNS, product, method, file) });
    }
}
console.log(`${pairs.length} answers to embed`);
const harness = await openHarness({ pageEntry: 'tests/catalog-match/browser/page.ts' });
try {
  await harness.page.evaluate(async (specs) => {
    const CM = (
      window as unknown as { CM: { openEmbedder: (spec: unknown, ep: string) => Promise<unknown> } }
    ).CM;
    const w = window as unknown as { embedders: Record<string, unknown> };
    w.embedders = {};
    for (const [name, spec] of Object.entries(specs))
      w.embedders[name] = await CM.openEmbedder(spec, (spec as { ep: string }).ep);
  }, models);
  const photoCache = new Map<string, string>();
  for (const pair of pairs) {
    if (!photoCache.has(pair.photo)) photoCache.set(pair.photo, await dataUrl(pair.photo));
    const result = await harness.page.evaluate(
      async ({ photo, answer }) => {
        type E = { embed: (source: ImageBitmap) => Promise<Record<string, Float32Array>> };
        const w = window as unknown as { embedders: Record<string, E> };
        const bitmap = async (url: string) => createImageBitmap(await (await fetch(url)).blob());
        const [a, b] = [await bitmap(photo), await bitmap(answer)];
        const out: Record<string, number> = {};
        for (const [name, embedder] of Object.entries(w.embedders)) {
          const [x, y] = [(await embedder.embed(a)).pooled, (await embedder.embed(b)).pooled];
          let dot = 0;
          for (let i = 0; i < x.length; i++) dot += x[i] * y[i];
          out[name] = dot;
        }
        return out;
      },
      { photo: photoCache.get(pair.photo)!, answer: await dataUrl(pair.answer) },
    );
    done[pair.key] = { dino: Number(result.dino.toFixed(4)), clip: Number(result.clip.toFixed(4)) };
  }
} finally {
  await harness.close();
}
writeFileSync(outFile, JSON.stringify(done, null, 1));
console.log(`→ ${outFile}`);
