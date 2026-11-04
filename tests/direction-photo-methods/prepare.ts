/**
 * Round 0–1 preparation of the direction-photo methods trial (no AI): for every product of products.ts,
 * in a real Chrome on the GPU,
 *
 * - the app's guides (renderDirectionGuides, B0) and this trial's copy of the renderer drawing the same
 *   model (the two must be the same pixels: the trial's variants are drawn as the app draws),
 * - B2 (the trial-only shape) and B4 (0° elevation for the side and back views, of B0 and B2),
 * - the reference photos as the screen prepares them (BiRefNet when the photo has a backdrop, then
 *   prepareReferenceImage),
 *
 * then, in Node, B3 (the outline of B0 and B2: white inside, a dark line where the grey meets the white).
 * Everything goes to test-results/direction-photo-methods/prep/<product>/, listed in prep/manifest.json.
 *
 *   node tests/run-browser-test.mjs tests/direction-photo-methods/prepare.ts [--holdout] [ids...]
 */
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import sharp, { type Sharp } from 'sharp';
import { BACKGROUND_MODEL, INPUTS, ORIGINALS, OUT, SNAPSHOT } from './paths.mjs';
import { PRODUCTS, type Product } from './products';
import type { DirectionPhotoView } from '../../src/lib/direction-photo/contract';

const args = process.argv.slice(3);
const HOLDOUT = args.includes('--holdout');
const only = args.filter((a) => !a.startsWith('--'));
const PREP = path.join(OUT, 'prep');
mkdirSync(PREP, { recursive: true });

const KOREAN: Record<DirectionPhotoView, string> = {
  front: '정면',
  left: '왼쪽',
  right: '오른쪽',
  back: '뒤',
};
const VIEWS: DirectionPhotoView[] = ['front', 'left', 'right', 'back'];

// ---------- the catalogue's photos for the toilets (catalog-current.json; files from originals or the snapshot) ----------
type Placement = { name: string; coverAssetId?: string; views: { direction: string; assetId: string }[] };
const catalog = JSON.parse(readFileSync(path.join(OUT, 'catalog-current.json'), 'utf8')) as {
  placements: Placement[];
};
const fileOf = (id: string) => {
  for (const dir of [ORIGINALS, path.join(SNAPSHOT, 'images')]) {
    const found = readdirSync(dir).find((f) => f.startsWith(id + '.'));
    if (found) return path.join(dir, found);
  }
  throw new Error(`no file for asset ${id}`);
};
function placementOf(product: Product) {
  const key = product.name.split(' ').slice(0, 3).join(' ');
  const found = catalog.placements.filter((p) => p.name.startsWith(key));
  if (found.length !== 1) throw new Error(`${product.id}: ${found.length} catalogue matches for "${key}"`);
  return found[0];
}
export function photoFiles(product: Product): string[] {
  return product.photos.map((photo) => {
    if (!photo.startsWith('catalog:')) return path.join(INPUTS, photo);
    const placement = placementOf(product);
    const id =
      photo === 'catalog:cover'
        ? placement.coverAssetId
        : placement.views.find((v) => v.direction === '정면')?.assetId;
    if (!id) throw new Error(`${product.id}: no ${photo}`);
    return fileOf(id);
  });
}
/** The catalogue's side photos (never sent), and whether the right one is the left one mirrored. */
async function answersOf(product: Product) {
  if (product.category !== 'toilet' || !product.photos[0].startsWith('catalog:')) return {};
  const placement = placementOf(product);
  const out: Partial<Record<DirectionPhotoView, { file: string; mirrored?: boolean }>> = {};
  for (const view of VIEWS) {
    const asset = placement.views.find((v) => v.direction === KOREAN[view])?.assetId;
    if (asset) out[view] = { file: fileOf(asset) };
  }
  if (out.left && out.right) {
    const grey = async (file: string, flop: boolean) => {
      let image = sharp(file).flatten({ background: '#fff' }).greyscale().resize(64, 64, { fit: 'fill' });
      if (flop) image = image.flop();
      return image.raw().toBuffer();
    };
    const [l, r] = await Promise.all([grey(out.left.file, true), grey(out.right.file, false)]);
    let diff = 0;
    for (let i = 0; i < l.length; i++) diff += Math.abs(l[i] - r[i]);
    out.right.mirrored = diff / l.length < 6;
  }
  return out;
}

// ---------- the browser page: the app's modules and the trial's renderer ----------
async function inBrowser(
  jobs: { id: string; guideInput: unknown; b2?: string; photos: string[]; cutout: boolean }[],
) {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const rewrite = (file: string, from: string, to: string) => {
    const source = readFileSync(file, 'utf8');
    if (!source.includes(from)) throw new Error(`${file}: ${from} 없음`);
    return source.replace(from, to);
  };
  const local = {
    name: 'local-background-removal',
    setup(plugin: {
      onLoad: (
        options: { filter: RegExp },
        load: (args: { path: string }) => { contents: string; loader: 'ts' },
      ) => void;
    }) {
      plugin.onLoad({ filter: /background-removal[\\/]client\.ts$/ }, ({ path: file }) => ({
        contents: rewrite(
          file,
          "new URL('./worker.ts', import.meta.url)",
          "new URL('./worker.js', import.meta.url)",
        ),
        loader: 'ts',
      }));
      plugin.onLoad({ filter: /background-removal[\\/]model\.ts$/ }, ({ path: file }) => {
        const runtime = rewrite(
          file,
          "'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/'",
          `'${origin}/'`,
        );
        const modelUrl =
          '`https://huggingface.co/${BACKGROUND_MODEL_ID}/resolve/${BACKGROUND_MODEL_REVISION}/onnx/';
        if (!runtime.includes(modelUrl)) throw new Error(`${file}: 모델 주소 없음`);
        return { contents: runtime.replace(modelUrl, '`' + origin + '/'), loader: 'ts' };
      });
    },
  };
  const bundles = new Map<string, string>();
  const entries: [string, Parameters<typeof build>[0]][] = [
    [
      '/bg/app.js',
      {
        stdin: {
          contents: `export { renderDirectionGuides } from './src/lib/direction-photo/guide-render';
            export { prepareReferenceImage } from './src/lib/ai-export/client';
            export { BackgroundRemovalClient } from './src/lib/background-removal/client';
            export { renderVariantGuides } from './tests/direction-photo-methods/guide-variants';`,
          resolveDir: process.cwd(),
          loader: 'ts',
        },
      },
    ],
    ['/bg/worker.js', { entryPoints: ['src/lib/background-removal/worker.ts'] }],
  ];
  for (const [route, options] of entries) {
    const result = await build({
      ...options,
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'esm',
      logLevel: 'warning',
      plugins: [local],
    });
    bundles.set(route, result.outputFiles[0].text);
  }
  const runtime = path.resolve('node_modules/onnxruntime-web/dist');
  server.on('request', (req, res) => {
    const route = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (bundles.has(route)) {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(bundles.get(route));
      return;
    }
    if (route === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
      return;
    }
    const name = path.basename(route);
    const file = path.join(name.endsWith('.onnx') ? BACKGROUND_MODEL : runtime, name);
    if (!existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': file.endsWith('.wasm')
        ? 'application/wasm'
        : /\.m?js$/.test(file)
          ? 'text/javascript'
          : 'application/octet-stream',
      'Content-Length': statSync(file).size,
      'Access-Control-Allow-Origin': '*',
    });
    createReadStream(file).pipe(res);
  });
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: [
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--use-angle=d3d11',
      '--enable-gpu',
      '--enable-unsafe-webgpu',
    ],
  });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await page.goto(`${origin}/`);
    const results = [];
    for (const job of jobs) {
      const made = await page.evaluate(
        async ({ job }) => {
          type Guide = { direction: string; blob: Blob };
          type App = {
            renderDirectionGuides: (
              input: unknown,
              directions: string[],
              elevation?: number,
            ) => Promise<Guide[]>;
            renderVariantGuides: (
              input: unknown,
              variant: unknown,
              directions: string[],
              elevation?: number,
            ) => Promise<Guide[]>;
            prepareReferenceImage: (photo: Blob) => Promise<Blob>;
            BackgroundRemovalClient: new () => {
              run: (blob: Blob, onProgress: () => void) => Promise<{ blob: Blob } & Record<string, unknown>>;
              dispose: () => void;
            };
          };
          const url = '/bg/app.js';
          const app = (await import(url)) as App;
          const encode = async (blob: Blob) => {
            const bytes = new Uint8Array(await blob.arrayBuffer());
            let text = '';
            for (let i = 0; i < bytes.length; i += 0x8000)
              text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            return btoa(text);
          };
          const all = ['정면', '왼쪽', '오른쪽', '뒤'];
          const sides = ['왼쪽', '오른쪽', '뒤'];
          const out: Record<string, Record<string, string>> = { app: {}, b0: {}, b2: {}, b4: {}, b2b4: {} };
          for (const g of await app.renderDirectionGuides(job.guideInput, all))
            out.app[g.direction] = await encode(g.blob);
          for (const g of await app.renderVariantGuides(job.guideInput, { model: 'b0' }, all))
            out.b0[g.direction] = await encode(g.blob);
          for (const g of await app.renderVariantGuides(job.guideInput, { model: 'b0' }, sides, 0))
            out.b4[g.direction] = await encode(g.blob);
          if (job.b2) {
            for (const g of await app.renderVariantGuides(
              job.guideInput,
              { model: 'b2', shape: job.b2 },
              all,
            ))
              out.b2[g.direction] = await encode(g.blob);
            for (const g of await app.renderVariantGuides(
              job.guideInput,
              { model: 'b2', shape: job.b2 },
              sides,
              0,
            ))
              out.b2b4[g.direction] = await encode(g.blob);
          }
          const refs: string[] = [],
            cutouts: string[] = [];
          const client = job.cutout ? new app.BackgroundRemovalClient() : undefined;
          try {
            for (const photo of job.photos) {
              let blob = new Blob([Uint8Array.from(atob(photo), (c) => c.charCodeAt(0))]);
              if (client) {
                const result = await client.run(blob, () => {});
                cutouts.push(await encode(result.blob));
                blob = result.blob;
              }
              refs.push(await encode(await app.prepareReferenceImage(blob)));
            }
          } finally {
            client?.dispose();
          }
          return { out, refs, cutouts };
        },
        { job: { ...job, photos: job.photos.map((f) => readFileSync(f).toString('base64')) } },
      );
      results.push({ id: job.id, ...made });
      console.log('drew', job.id);
    }
    return results;
  } finally {
    await browser.close();
    server.close();
  }
}

/** B3: the guide's outline only, white inside, a dark line about 3 px wide (variants.ts GUIDE_EDIT=outline). */
async function outlineOnly(guide: Buffer): Promise<Buffer> {
  const step = async (input: Buffer, apply: (image: Sharp) => Sharp) => apply(sharp(input)).png().toBuffer();
  const solid = await step(guide, (image) => image.removeAlpha().greyscale().threshold(250).negate());
  const edges = await step(solid, (image) =>
    image.convolve({ width: 3, height: 3, kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] }),
  );
  const thin = await step(edges, (image) => image.threshold(1));
  const lines = await step(await step(thin, (image) => image.blur(1)), (image) => image.threshold(20));
  return sharp(lines).negate().png().toBuffer();
}

const products = PRODUCTS.filter(
  (p) => (HOLDOUT ? true : p.set === 'dev') && (!only.length || only.includes(p.id)),
);
const jobs = products.map((p) => ({
  id: p.id,
  guideInput: {
    category: p.spec.category,
    form: p.spec.form,
    lid: p.spec.lid,
    skirt: p.spec.skirt,
    sizeMm: p.spec.sizeMm,
    installation: p.spec.installation,
  },
  b2: p.b2,
  photos: photoFiles(p),
  cutout: p.cutout,
}));
const drawn = await inBrowser(jobs);
const manifestFile = path.join(PREP, 'manifest.json');
const manifest: Record<string, unknown> = existsSync(manifestFile)
  ? JSON.parse(readFileSync(manifestFile, 'utf8'))
  : {};
for (const result of drawn) {
  const product = products.find((p) => p.id === result.id)!;
  const dir = path.join(PREP, product.id);
  const entry: Record<string, unknown> = {
    photos: photoFiles(product),
    guides: {},
    refs: [] as string[],
    equalToApp: {},
  };
  for (const [variant, byDirection] of Object.entries(result.out))
    for (const [korean, data] of Object.entries(byDirection)) {
      const view = VIEWS.find((v) => KOREAN[v] === korean)!;
      const file = path.join(dir, variant, `${view}.png`);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(data, 'base64'));
      ((entry.guides as Record<string, Record<string, string>>)[variant] ??= {})[view] = file;
    }
  // The copy draws the app's pixels (B0 = app), or the trial's variants are not the app's look.
  for (const view of VIEWS) {
    const a = await sharp(path.join(dir, 'app', `${view}.png`))
      .raw()
      .toBuffer();
    const b = await sharp(path.join(dir, 'b0', `${view}.png`))
      .raw()
      .toBuffer();
    (entry.equalToApp as Record<string, boolean>)[view] = a.equals(b);
  }
  for (const [from, to] of [
    ['b0', 'b3'],
    ['b2', 'b2b3'],
  ] as const)
    for (const [view, file] of Object.entries(
      (entry.guides as Record<string, Record<string, string>>)[from] ?? {},
    )) {
      const target = path.join(dir, to, `${view}.png`);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, await outlineOnly(readFileSync(file)));
      ((entry.guides as Record<string, Record<string, string>>)[to] ??= {})[view] = target;
    }
  for (const [i, data] of result.refs.entries()) {
    const file = path.join(dir, 'refs', `${i + 1}.png`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(data, 'base64'));
    (entry.refs as string[]).push(file);
  }
  for (const [i, data] of result.cutouts.entries())
    writeFileSync(path.join(dir, 'refs', `cutout-${i + 1}.png`), Buffer.from(data, 'base64'));
  entry.answers = await answersOf(product);
  manifest[product.id] = entry;
}
writeFileSync(manifestFile, JSON.stringify(manifest, null, 1));
console.log(`prep: ${drawn.length} products → ${PREP}`);
for (const [id, entry] of Object.entries(manifest))
  console.log(id, 'equal to app:', JSON.stringify((entry as { equalToApp: unknown }).equalToApp));
