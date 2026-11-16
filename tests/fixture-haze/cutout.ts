/**
 * Where the model drew each fixture (no AI call, docs/fixture-haze-20261116.md): around every fixture
 * box of a result (the facts' boxes, in the model's picture, grown by PAD each way) the app's own
 * cut-out model (BiRefNet lite, the local copy in tmp/background-model, served from disk as
 * tests/flux-product-refine-measure.ts does) cuts out what stands in front of the wall, and the
 * cut-outs are put together on the result's grid (the largest alpha where crops overlap).
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-haze/cutout.ts [--set dev|holdout|new|new-holdout]
 * Output: test-results/fixture-haze-20261116/cutout/<id>/{crop-<k>.png,cut-<k>.png,alpha.png}, cutout-<set>.json
 */
import { chromium } from '@playwright/test';
import { build, type BuildOptions } from 'esbuild';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path, { join } from 'node:path';
import sharp from 'sharp';
import type { FluxScene } from '../../src/lib/ai-export/scene-contract';
import { haze, type HazeSet } from './sources';
import { MODELS, OUT } from './paths.mjs';

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const set = arg('set', 'dev') as HazeSet;
/** Each crop is the fixture box grown by this share of its size each way (the model's own may be larger). */
const PAD = 0.3;
const runtime = path.resolve('node_modules/onnxruntime-web/dist');

type Crop = {
  key: string;
  file: string;
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
};
const crops: Crop[] = [];
const sizes = new Map<string, { width: number; height: number }>();
for (const source of haze(set)) {
  if (!existsSync(source.result)) continue;
  const dir = join(OUT as string, 'cutout', source.id);
  mkdirSync(dir, { recursive: true });
  const { scene } = JSON.parse(readFileSync(join(source.dir, 'grounding.json'), 'utf8')) as {
    scene: FluxScene;
  };
  const meta = await sharp(source.result).metadata();
  const W = meta.width!,
    H = meta.height!;
  sizes.set(source.id, { width: W, height: H });
  for (const [k, fixture] of scene.fixtures.entries()) {
    if (!fixture.box) continue;
    const [l, t, r, b] = fixture.box;
    const bw = r - l,
      bh = b - t;
    const left = Math.max(0, Math.floor((l - bw * PAD) * W)),
      top = Math.max(0, Math.floor((t - bh * PAD) * H)),
      right = Math.min(W, Math.ceil((r + bw * PAD) * W)),
      bottom = Math.min(H, Math.ceil((b + bh * PAD) * H));
    if (right - left < 8 || bottom - top < 8) continue;
    const file = join(dir, `crop-${k}.png`);
    await sharp(source.result)
      .extract({ left, top, width: right - left, height: bottom - top })
      .png()
      .toFile(file);
    crops.push({
      key: `${source.id}~${k}`,
      file,
      id: source.id,
      left,
      top,
      width: right - left,
      height: bottom - top,
    });
  }
}
console.log(`${set}: ${crops.length} crops of ${sizes.size} results`);

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
const cutFile = (key: string) => {
  const crop = crops.find((c) => c.key === key)!;
  return join(OUT as string, 'cutout', crop.id, `cut-${key.split('~')[1]}.png`);
};
const server = createServer(async (req, res) => {
  try {
    const route = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    if (req.method === 'POST' && route.startsWith('/save/')) {
      const key = route.slice(6);
      if (!crops.some((crop) => crop.key === key)) throw new Error('Unexpected output');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      writeFileSync(cutFile(key), Buffer.concat(chunks));
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
    const crop = route.startsWith('/image/') ? crops.find(({ key }) => key === route.slice(7)) : undefined;
    const name = path.basename(route);
    const file = crop
      ? crop.file
      : [name.endsWith('.onnx') ? (MODELS as string) : runtime]
          .map((dir) => path.join(dir, name))
          .find(existsSync);
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
let timing: Record<string, unknown> = {};
try {
  const context = await browser.newContext();
  // The app fetches the model and runtime from the web; here they come from disk.
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
  timing = await page.evaluate(
    async ({ keys, url }) => {
      const { BackgroundRemovalClient } = (await import(
        url
      )) as typeof import('../../src/lib/background-removal/client');
      const client = new BackgroundRemovalClient();
      const out: Record<string, unknown> = {};
      try {
        for (const key of keys) {
          const blob = await (await fetch(`/image/${encodeURIComponent(key)}`)).blob();
          const result = await client.run(blob, () => {});
          await fetch(`/save/${encodeURIComponent(key)}`, { method: 'POST', body: result.blob });
          out[key] = Math.round(result.processingMs);
        }
      } finally {
        client.dispose();
      }
      return out;
    },
    { keys: crops.map((crop) => crop.key), url: '/bg/client.js' },
  );
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await browser.close();
  server.close();
}

// Put each result's cut-outs together on its grid.
const summary: Record<string, unknown> = {};
for (const [id, size] of sizes) {
  const alpha = new Uint8Array(size.width * size.height);
  for (const crop of crops.filter((c) => c.id === id)) {
    const cut = await sharp(cutFile(crop.key))
      .ensureAlpha()
      .extractChannel(3)
      .resize(crop.width, crop.height, { fit: 'fill' })
      .raw()
      .toBuffer();
    for (let y = 0; y < crop.height; y++)
      for (let x = 0; x < crop.width; x++) {
        const i = (crop.top + y) * size.width + crop.left + x;
        alpha[i] = Math.max(alpha[i], cut[y * crop.width + x]);
      }
  }
  await sharp(Buffer.from(alpha), { raw: { width: size.width, height: size.height, channels: 1 } })
    .png()
    .toFile(join(OUT as string, 'cutout', id, 'alpha.png'));
  summary[id] = crops.filter((c) => c.id === id).map((c) => timing[c.key]);
}
writeFileSync(join(OUT as string, `cutout-${set}.json`), JSON.stringify(summary, null, 1));
console.log('done', JSON.stringify(summary).slice(0, 400));
