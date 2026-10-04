/**
 * Measures the per-product refinement experiment (docs/flux-product-refine-results-*.md), no AI call:
 * the local BiRefNet (the cached model in tmp/background-model, served from disk) cuts out each FLUX
 * result and each 3D crop; the cut-out's silhouette is compared with the 3D silhouette
 * (the crops recorded by the removed tests/flux-product-crops-browser.ts, see docs/product3d-removal.md) in the model input's pixels:
 *   iou          plain overlap of the two silhouettes
 *   alignedIou   the same after the best shift of ±SHIFT px (what the room composite would do)
 *   area         the result's area as a share of the 3D silhouette's
 * and writes the comparison sheets: [3D crop | (i) | (i) | (ii) | (ii) | photo], one row per product.
 *
 * Usage: node tests/run-browser-test.mjs tests/flux-product-refine-measure.ts
 *   reads  test-results/flux-product-refine/{inputs,real}; writes .../cutouts, .../report
 */
import { chromium } from '@playwright/test';
import { build, type BuildOptions } from 'esbuild';
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
import sharp, { type OverlayOptions } from 'sharp';
import { alignToSilhouette, cutoutAlpha } from '../src/lib/ai-export/refine';

const root = path.resolve('test-results/flux-product-refine');
// Other sets of answers (a variant comparison) are measured with these: where the close-ups are, where
// the answers are, where the cut-outs and the report go, and SINGLE_NAME when every answer in REAL_DIR
// belongs to that one product (its file names need not start with the product's).
const inputs = process.env.INPUTS_DIR ? path.resolve(process.env.INPUTS_DIR) : `${root}/inputs`;
const real = process.env.REAL_DIR ? path.resolve(process.env.REAL_DIR) : `${root}/real`;
const outRoot = process.env.OUT_DIR ? path.resolve(process.env.OUT_DIR) : root;
const single = process.env.SINGLE_NAME;
const names = single ? [single] : ['bear-toilet', 'smart-toilet', 'bathtub'];
const SHIFT = 16;
const models = path.resolve('tmp/background-model');
const runtime = path.resolve('node_modules/onnxruntime-web/dist');
mkdirSync(`${outRoot}/cutouts`, { recursive: true });
mkdirSync(`${outRoot}/report`, { recursive: true });

type Item = { key: string; file: string };
const items: Item[] = [];
for (const name of names)
  if (existsSync(`${inputs}/${name}/crop.png`))
    items.push({ key: `${name}-crop-input`, file: `${inputs}/${name}/crop.png` });
for (const file of existsSync(`${real}`) ? readdirSync(`${real}`) : [])
  if (/\.(jpe?g|png)$/.test(file)) items.push({ key: path.parse(file).name, file: `${real}/${file}` });
if (!items.length) throw new Error('nothing to measure; run tests/flux-product-crops-browser.ts first');

const bundles = new Map<string, string>();
const entries: [string, BuildOptions][] = [
  [
    '/bg/client.js',
    {
      stdin: {
        contents: "export { BackgroundRemovalClient } from './src/lib/background-removal/client';",
        resolveDir: process.cwd(),
      },
    },
  ],
  ['/bg/worker.ts', { entryPoints: ['src/lib/background-removal/worker.ts'] }],
];
for (const [route, options] of entries) {
  const result = await build({
    ...options,
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    logLevel: 'warning',
  });
  bundles.set(route, result.outputFiles[0].text);
}
const server = createServer(async (req, res) => {
  try {
    const route = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'POST' && route.startsWith('/save/')) {
      const key = route.slice(6);
      if (!items.some((item) => item.key === key)) throw new Error('Unexpected output');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      writeFileSync(`${outRoot}/cutouts/${key}.png`, Buffer.concat(chunks));
      res.end('ok');
      return;
    }
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
    const item = route.startsWith('/image/') ? items.find(({ key }) => key === route.slice(7)) : undefined;
    const name = path.basename(route);
    const file = item
      ? item.file
      : [name.endsWith('.onnx') ? models : runtime].map((dir) => path.join(dir, name)).find(existsSync);
    if (!file) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': file.endsWith('.wasm')
        ? 'application/wasm'
        : /\.m?js$/.test(file)
          ? 'text/javascript'
          : /\.jpe?g$/.test(file)
            ? 'image/jpeg'
            : file.endsWith('.png')
              ? 'image/png'
              : 'application/octet-stream',
      'Content-Length': statSync(file).size,
      'Access-Control-Allow-Origin': '*',
    });
    createReadStream(file).pipe(res);
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext();
  for (const pattern of [
    'https://huggingface.co/**',
    'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/**',
  ])
    await context.route(pattern, (route) =>
      route.fulfill({
        status: 307,
        headers: {
          location: `${origin}/${path.basename(new URL(route.request().url()).pathname)}`,
          'access-control-allow-origin': '*',
        },
      }),
    );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/`);
  const results = await page.evaluate(
    async ({ keys, url }) => {
      const { BackgroundRemovalClient } = (await import(
        url
      )) as typeof import('../src/lib/background-removal/client');
      const client = new BackgroundRemovalClient();
      const out: Record<string, unknown> = {};
      try {
        for (const key of keys) {
          try {
            const blob = await (await fetch(`/image/${key}`)).blob();
            const result = await client.run(blob, () => {});
            await fetch(`/save/${key}`, { method: 'POST', body: result.blob });
            out[key] = {
              width: result.width,
              height: result.height,
              processingMs: Math.round(result.processingMs),
            };
          } catch (error) {
            out[key] = { error: error instanceof Error ? error.message : String(error) };
          }
        }
      } finally {
        client.dispose();
      }
      return out;
    },
    { keys: items.map((item) => item.key), url: '/bg/client.js' },
  );
  const failed = Object.entries(results).filter(([, value]) => (value as { error?: string }).error);
  if (failed.length) throw new Error('cut-out failed: ' + JSON.stringify(failed));
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await browser.close();
  server.close();
}

/** 1 where the product is, on the model input's grid (width × height). */
async function maskOf(file: string, width: number, height: number, alpha: boolean) {
  const base = sharp(file).resize(width, height, { fit: 'fill', kernel: 'lanczos3' });
  const raw = await (alpha ? base.ensureAlpha().extractChannel(3) : base.greyscale()).raw().toBuffer();
  return Uint8Array.from(raw, (value) => (value >= 128 ? 1 : 0));
}
function overlap(a: Uint8Array, b: Uint8Array, width: number, height: number, dx: number, dy: number) {
  let both = 0,
    either = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = a[y * width + x];
      const sx = x - dx,
        sy = y - dy;
      const q = sx >= 0 && sy >= 0 && sx < width && sy < height ? b[sy * width + sx] : 0;
      both += p & q;
      either += p | q;
    }
  return either ? both / either : 0;
}
type Row = {
  key: string;
  name: string;
  iou: number;
  alignedIou: number;
  shift: [number, number];
  area: number;
  /** As the app measures it: stood on the 3D product's ground point at its height (alignToSilhouette). */
  appIou?: number;
  ratio?: number;
};
const rows: Row[] = [];
for (const name of names) {
  const metaFile = `${inputs}/${name}/meta.json`;
  if (!existsSync(metaFile)) continue;
  const { layout } = JSON.parse(readFileSync(metaFile, 'utf8')) as {
    layout: { width: number; height: number };
  };
  const { width, height } = layout;
  const silhouette = await maskOf(`${inputs}/${name}/silhouette.png`, width, height, false);
  const area = silhouette.reduce((sum, value) => sum + value, 0);
  for (const item of items.filter((entry) => single || entry.key.startsWith(`${name}-`))) {
    const mask = await maskOf(`${outRoot}/cutouts/${item.key}.png`, width, height, true);
    const iou = overlap(mask, silhouette, width, height, 0, 0);
    let best = { iou, dx: 0, dy: 0 };
    for (let dy = -SHIFT; dy <= SHIFT; dy += 2)
      for (let dx = -SHIFT; dx <= SHIFT; dx += 2) {
        const value = overlap(mask, silhouette, width, height, dx, dy);
        if (value > best.iou) best = { iou: value, dx, dy };
      }
    // The app's own measure on the model input's grid.
    const cut = await sharp(`${outRoot}/cutouts/${item.key}.png`)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const alpha = cutoutAlpha(
      { width: cut.info.width, height: cut.info.height, data: new Uint8ClampedArray(cut.data) },
      { width, height },
    );
    const aligned = alignToSilhouette(
      alpha,
      Uint8Array.from(silhouette, (v) => v * 255),
      width,
      height,
    );
    rows.push({
      key: item.key,
      name,
      ...('failure' in aligned
        ? {}
        : { appIou: Math.round(aligned.iou * 1000) / 1000, ratio: Math.round(aligned.ratio * 100) / 100 }),
      iou: Math.round(iou * 1000) / 1000,
      alignedIou: Math.round(best.iou * 1000) / 1000,
      shift: [best.dx, best.dy],
      area: Math.round((mask.reduce((sum, value) => sum + value, 0) / area) * 1000) / 1000,
    });
  }
}
writeFileSync(`${outRoot}/report/measures.json`, JSON.stringify(rows, null, 1));
for (const row of rows)
  console.log(
    `${row.key.padEnd(34)} IoU ${row.iou.toFixed(3)}  aligned ${row.alignedIou.toFixed(3)} (shift ${row.shift.join(',')})  area ${row.area.toFixed(2)}  app ${row.appIou?.toFixed(3) ?? 'n/a'} (height ratio ${row.ratio ?? 'n/a'})`,
  );
if (process.env.NO_SHEET) process.exit(0);

// The sheets: one row per product, [3D crop | (i) | (i) | (ii) | (ii) | photo], each on its own
// white cell, the IoU written under it.
const cell = 360,
  label = 30;
const sheets: Buffer[] = [];
const columns = [
  {
    title: '3D crop',
    key: (n: string) => `${n}-crop-input`,
    file: (n: string) => `${inputs}/${n}/crop.png`,
  },
  ...[424242, 777001].map((seed) => ({
    title: `(i) crop only · ${seed}`,
    key: (n: string) => `${n}-crop-${seed}`,
    file: (n: string) => findReal(`${n}-crop-${seed}`),
  })),
  ...[424242, 777001].map((seed) => ({
    title: `(ii) crop+photo · ${seed}`,
    key: (n: string) => `${n}-crop-photo-${seed}`,
    file: (n: string) => findReal(`${n}-crop-photo-${seed}`),
  })),
  { title: 'photo', key: () => '', file: (n: string) => `${inputs}/${n}/reference.png` },
];
function findReal(key: string) {
  for (const extension of ['jpg', 'png']) {
    const file = `${real}/${key}.${extension}`;
    if (existsSync(file)) return file;
  }
  return '';
}
for (const name of names) {
  const composites: OverlayOptions[] = [];
  for (const [index, column] of columns.entries()) {
    const file = column.file(name);
    const row = rows.find((entry) => entry.key === column.key(name));
    const text = `${column.title}${row ? `  IoU ${row.iou.toFixed(2)} / ${row.alignedIou.toFixed(2)}` : ''}`;
    composites.push({
      input: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="${label}"><rect width="100%" height="100%" fill="#fff"/><text x="6" y="20" font-size="14" font-family="sans-serif" fill="#222">${text.replace(/&/g, '&amp;')}${file ? '' : ' (no result)'}</text></svg>`,
      ),
      left: index * cell,
      top: 0,
    });
    if (file)
      composites.push({
        input: await sharp(file)
          .resize(cell, cell, { fit: 'contain', background: '#ffffff' })
          .png()
          .toBuffer(),
        left: index * cell,
        top: label,
      });
  }
  const sheet = await sharp({
    create: { width: cell * columns.length, height: cell + label, channels: 3, background: '#ffffff' },
  })
    .composite(composites)
    .png()
    .toBuffer();
  writeFileSync(`${outRoot}/report/sheet-${name}.png`, sheet);
  sheets.push(sheet);
}
await sharp({
  create: {
    width: cell * columns.length,
    height: (cell + label) * sheets.length,
    channels: 3,
    background: '#ffffff',
  },
})
  .composite(sheets.map((input, index) => ({ input, left: 0, top: index * (cell + label) })))
  .png()
  .toFile(`${outRoot}/report/sheet-all.png`);
console.log('sheets:', `${outRoot}/report/sheet-all.png`);
