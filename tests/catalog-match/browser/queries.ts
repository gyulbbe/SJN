/**
 * Round 1 (no AI call): the photo side of tile matching. Every face of the synthetic rooms and of the
 * development photos is cut out eight ways (region: the whole face as found / the largest part clear
 * of products; rectified with the app's rectifyImage or a plain bounding box; with or without the
 * photo's light taken out by the app's estimate) and given the same model-free numbers and the same
 * embeddings as the catalog (the crop alone, and the crop cut to the 900 mm window).
 *
 * Usage: node tests/run-browser-test.mjs tests/catalog-match/browser/queries.ts --set synth|photos
 *          [--ep webgpu|wasm] [--models dinov2-small:q4f16,clip-b32:q4f16,siglip2-b16:q4f16] [--limit N]
 *          [--variants clean.rect.raw,...]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { OUT } from '../paths.mjs';
import { modelPath } from '../models.mjs';
import { cleanRectangle, subQuad, type Box, type Quad } from '../tile-features';
import { openHarness } from './harness';
import type * as Page from './page';

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
};
const set = arg('set', 'synth');
const ep = arg('ep', 'webgpu') as 'webgpu' | 'wasm';
const limit = Number(arg('limit', '0'));
/** WASM threads for this offline precompute (needs isolation); its timings are not the app's. */
const threads = Number(arg('threads', '1'));
const outDir = arg('out', `features/queries-${set}`);
const FILES: Record<string, string> = {
  'dinov2-small:q8': 'onnx/model_quantized.onnx',
  'dinov2-small:q4f16': 'onnx/model_q4f16.onnx',
  'clip-b32:q8': 'onnx/vision_model_quantized.onnx',
  'clip-b32:q4f16': 'onnx/vision_model_q4f16.onnx',
  'siglip2-b16:q8': 'onnx/vision_model_quantized.onnx',
  'siglip2-b16:q4f16': 'onnx/vision_model_q4f16.onnx',
};
const models = arg('models', 'dinov2-small:q4f16,clip-b32:q4f16,siglip2-b16:q4f16')
  .split(',')
  .filter(Boolean);
const WINDOW_MM = 900;

type Face = 'back' | 'left' | 'right' | 'floor';
export type QueryFace = {
  id: string;
  set: string;
  split: string;
  photo: string;
  path: string;
  face: Face;
  /** The right answer (synthetic only). */
  materialId?: string;
  /** The earlier analysis's own tile estimate for this face (photos only). */
  observed?: unknown;
  regions: Partial<Record<'auto' | 'clean', { quad: Quad; mm: { widthMm: number; heightMm: number } }>>;
  /** For the light estimate: the photo's faces and products. */
  review: {
    planes: { quad: Quad; tile: { color: string } }[];
    candidates: { kind: string; status: string; color: string; bounds: Box }[];
  };
  long: number;
  resolution: number;
};

const faceMm = (room: { widthMm: number; depthMm: number; heightMm: number }, face: Face) =>
  face === 'floor'
    ? { w: room.widthMm, h: room.depthMm }
    : { w: face === 'back' ? room.widthMm : room.depthMm, h: room.heightMm };
const scaled = (room: { widthMm: number; depthMm: number; heightMm: number }, face: Face, uv: number[]) => {
  const { w, h } = faceMm(room, face);
  return { widthMm: w * (uv[2] - uv[0]), heightMm: h * (uv[3] - uv[1]) };
};

const faces: QueryFace[] = [];
if (set === 'synth') {
  const synth = JSON.parse(await readFile(join(OUT as string, 'synth', 'cases.json'), 'utf8'));
  for (const c of synth.cases) {
    const review = {
      planes: c.faces
        .filter((f: { visible?: unknown }) => f.visible)
        .map((f: { visible: { quad: Quad } }) => ({ quad: f.visible.quad, tile: { color: '#808080' } })),
      candidates: c.boxes.map((b: number[], i: number) => ({
        kind: i ? 'basin' : 'toilet',
        status: 'accepted',
        color: '#f2f1ec',
        bounds: { left: b[0], top: b[1], right: b[2], bottom: b[3] },
      })),
    };
    for (const f of c.faces) {
      if (!f.visible) continue;
      faces.push({
        id: `${c.id}:${f.face}`,
        set: 'synth',
        split: c.split,
        photo: c.id,
        path: c.path,
        face: f.face,
        materialId: f.materialId,
        regions: {
          auto: { quad: f.visible.quad, mm: scaled(c.room, f.face, f.visible.uv) },
          ...(f.clean ? { clean: { quad: f.clean.quad, mm: scaled(c.room, f.face, f.clean.uv) } } : {}),
        },
        review,
        long: Math.max(c.width, c.height),
        resolution: c.longEdge,
      });
    }
  }
} else {
  const index = JSON.parse(await readFile(join(OUT as string, 'photos', 'index.json'), 'utf8'));
  for (const p of index.photos) {
    if (p.locked || p.split === 'heldout') continue;
    // Products, mirrors, glass, doors and windows all hide the tile.
    const blockers: Box[] = p.candidates.map((c: { box: Box }) => c.box);
    const review = {
      planes: p.planes.map((plane: { quad: Quad; tile: { color?: string } | null }) => ({
        quad: plane.quad,
        tile: { color: plane.tile?.color ?? '#808080' },
      })),
      candidates: p.candidates.map(
        (c: { kind: string; status: string | null; color: string | null; box: Box }) => ({
          kind: c.kind,
          status: c.status ?? 'accepted',
          color: c.color ?? '#808080',
          bounds: c.box,
        }),
      ),
    };
    for (const plane of p.planes as { face: Face; quad: Quad; tile: unknown }[]) {
      const clean = cleanRectangle(plane.quad, blockers);
      faces.push({
        id: `${p.id}:${plane.face}`,
        set: 'photos',
        split: p.split,
        photo: p.id,
        path: p.path,
        face: plane.face,
        observed: plane.tile,
        regions: {
          auto: { quad: plane.quad, mm: scaled(p.room, plane.face, [0, 0, 1, 1]) },
          ...(clean
            ? {
                clean: {
                  quad: subQuad(plane.quad, clean),
                  mm: scaled(p.room, plane.face, [clean.u0, clean.v0, clean.u1, clean.v1]),
                },
              }
            : {}),
        },
        review,
        long: Math.max(p.width, p.height),
        resolution: Math.max(p.width, p.height),
      });
    }
  }
}
const chosen = limit ? faces.slice(0, limit) : faces;
const target = join(OUT as string, outDir);
await mkdir(target, { recursive: true });

const harness = await openHarness({
  pageEntry: resolve('tests/catalog-match/browser/page.ts'),
  gpu: ep === 'webgpu',
  isolated: threads > 1,
});
const variants: { key: string; region: 'auto' | 'clean'; rectify: boolean; delight: boolean }[] = [];
for (const region of ['auto', 'clean'] as const)
  for (const rectify of [true, false])
    for (const delight of [false, true])
      variants.push({
        key: `${region}.${rectify ? 'rect' : 'box'}.${delight ? 'delit' : 'raw'}`,
        region,
        rectify,
        delight,
      });
const onlyVariants = arg('variants', '').split(',').filter(Boolean);
if (onlyVariants.length)
  variants.splice(0, variants.length, ...variants.filter((v) => onlyVariants.includes(v.key)));
const rows: { query: string; variant: string; mm: { widthMm: number; heightMm: number } }[] = [];
const classic: unknown[] = [];
const vectors: Record<string, number[][]> = {};
const log: Record<string, unknown> = {
  set,
  ep,
  threads,
  models,
  startedAt: new Date().toISOString(),
  faces: chosen.length,
};
try {
  const { page } = harness;
  log.adapter = await page.evaluate(() => (window as unknown as { CM: typeof Page }).CM.gpuAdapter());
  // Open every model once; the page keeps them.
  log.models = await page.evaluate(
    async (list) => {
      const CM = (window as unknown as { CM: typeof Page }).CM;
      const w = window as unknown as { embedders: Record<string, Page.Embedder> };
      w.embedders = {};
      for (const { name, key, path, ep, threads } of list)
        w.embedders[name] = await CM.openEmbedder({ ...CM.MODEL_SPECS[key], path }, ep, threads);
      return Object.fromEntries(Object.entries(w.embedders).map(([name, e]) => [name, e.info]));
    },
    models.map((model) => {
      const [key] = model.split(':');
      return { name: model, key, path: modelPath(key, FILES[model]) as string, ep, threads };
    }),
  );
  const timing: number[] = [];
  for (const face of chosen) {
    const result = await page.evaluate(
      async ({ face, variants, windowMm, saveCrop }) => {
        const CM = (window as unknown as { CM: typeof Page }).CM;
        const w = window as unknown as {
          embedders: Record<string, Page.Embedder>;
          light?: Map<string, unknown>;
        };
        const blob = await CM.photoBlob(face.path);
        w.light ??= new Map();
        if (!w.light.has(face.photo)) {
          // Synthetic rooms have no analysis: their faces' and products' colours are read from the photo.
          const review =
            face.set === 'synth' ? await CM.observeColours(blob, face.review as never) : face.review;
          w.light.set(face.photo, (await CM.photoLight(blob, review as never)) ?? null);
        }
        const light = w.light.get(face.photo) as Parameters<typeof CM.faceCrop>[4] | null;
        const bitmap = await createImageBitmap(blob);
        const out: {
          variant: string;
          mm: { widthMm: number; heightMm: number };
          classic: unknown;
          vectors: Record<string, number[]>;
          ms: number;
        }[] = [];
        for (const variant of variants) {
          const region = face.regions[variant.region];
          if (!region) continue;
          if (variant.delight && !light) continue;
          const started = performance.now();
          const long = 384;
          const ratio = region.mm.widthMm / Math.max(1, region.mm.heightMm);
          const width = ratio >= 1 ? long : Math.max(16, long * ratio),
            height = ratio >= 1 ? Math.max(16, long / ratio) : long;
          let crop: HTMLCanvasElement;
          if (variant.rectify)
            crop = await CM.faceCrop(blob, region.quad, width, height, variant.delight ? light! : undefined);
          else {
            const xs = region.quad.map((p) => p.x * bitmap.width),
              ys = region.quad.map((p) => p.y * bitmap.height);
            const left = Math.max(0, Math.min(...xs)),
              top = Math.max(0, Math.min(...ys));
            const right = Math.min(bitmap.width, Math.max(...xs)),
              bottom = Math.min(bitmap.height, Math.max(...ys));
            const box = CM.canvasOf(right - left, bottom - top);
            box
              .getContext('2d')!
              .drawImage(bitmap, left, top, box.width, box.height, 0, 0, box.width, box.height);
            crop = box;
            if (variant.delight) {
              const blobBox = await CM.canvasBlob(box);
              crop = await CM.faceCrop(
                blobBox,
                [
                  { x: 0, y: 0 },
                  { x: 1, y: 0 },
                  { x: 1, y: 1 },
                  { x: 0, y: 1 },
                ],
                box.width,
                box.height,
                light!,
              );
            }
          }
          if (saveCrop && variant.region === 'clean' && variant.rectify && !variant.delight)
            await CM.save(
              `crops/${face.set}/${face.id.replace(':', '-')}.jpg`,
              await CM.canvasBlob(crop, 'image/jpeg', 0.9),
            );
          const vectors: Record<string, number[]> = {};
          const windowed = CM.windowCrop(crop, region.mm, windowMm);
          for (const [name, embedder] of Object.entries(w.embedders)) {
            for (const [kind, canvas] of [
              ['full', crop],
              ['window', windowed],
            ] as const) {
              const result = await embedder.embed(canvas);
              for (const [output, vector] of Object.entries(result))
                vectors[`${name}.${kind}.${output}`] = Array.from(vector);
            }
          }
          out.push({
            variant: variant.key,
            mm: region.mm,
            classic: CM.classicFeatures(crop),
            vectors,
            ms: performance.now() - started,
          });
        }
        bitmap.close();
        return out;
      },
      { face, variants, windowMm: WINDOW_MM, saveCrop: true },
    );
    for (const r of result) {
      rows.push({ query: face.id, variant: r.variant, mm: r.mm });
      classic.push(r.classic);
      timing.push(r.ms);
      for (const [name, vector] of Object.entries(r.vectors)) (vectors[name] ??= []).push(vector);
    }
    process.stdout.write(`\r${set} ${faces.indexOf(face) + 1}/${chosen.length}`);
  }
  console.log();
  const sorted = [...timing].sort((a, b) => a - b);
  log.cropMedianMs = sorted[sorted.length >> 1];
} finally {
  log.endedAt = new Date().toISOString();
  await writeFile(
    join(target, 'faces.json'),
    JSON.stringify(chosen.map((face) => ({ ...face, review: undefined }))),
  );
  await writeFile(join(target, 'rows.json'), JSON.stringify(rows));
  await writeFile(join(target, 'classic.json'), JSON.stringify(classic));
  for (const [name, matrix] of Object.entries(vectors))
    await writeFile(
      join(target, `${name.replace(':', '-')}.f32`),
      Buffer.from(Float32Array.from(matrix.flat()).buffer),
    );
  await writeFile(join(target, `run-${ep}.json`), JSON.stringify(log, null, 2));
  await harness.close();
}
