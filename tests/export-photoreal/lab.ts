/**
 * A Chrome page with the trial's browser models (node side): the app's BiRefNet cut-out client (its
 * cached model from tmp/background-model, served from disk), CLIP and Swin2SR (lab-page.ts). Files
 * reach the page through a local server; nothing is fetched from the network.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { CLIP_VISION, modelPath } from './models.mjs';
import { BACKGROUND_MODEL } from './paths.mjs';

const MODEL_FILES: Record<string, string> = {
  'clip-vision.onnx': CLIP_VISION,
  'clip-text.onnx': modelPath('clip-b32', 'onnx/text_model_quantized.onnx'),
  'clip-tokenizer.json': modelPath('clip-b32', 'tokenizer.json'),
  'swin2sr-x2.onnx': modelPath('swin2sr-x2', 'onnx/model.onnx'),
};
const runtime = resolve('node_modules/onnxruntime-web/dist');

export type Lab = {
  /** P("a photo") of each image. */
  clipReal(files: string[]): Promise<number[]>;
  /** Twice the size (PNG bytes). */
  upscale(file: string): Promise<{ png: Buffer; ms: number }>;
  /** The app's BiRefNet cut-out (PNG with alpha). */
  cutout(png: Buffer): Promise<Buffer>;
  /** One image against each sentence, with the first sentence's tokens (a check of CLIP's pieces). */
  clipSimilarities(
    file: string,
    sentences: string[],
  ): Promise<{ out: Record<string, number>; tokens: number[]; provider: string }>;
  adapter(): Promise<string>;
  close(): Promise<void>;
};

export async function openLab(options: { gpu?: boolean } = {}): Promise<Lab> {
  const bundles = new Map<string, string>();
  const entries: [string, Parameters<typeof build>[0]][] = [
    ['/lab.js', { entryPoints: ['tests/export-photoreal/lab-page.ts'] }],
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
  for (const [route, settings] of entries) {
    const result = await build({
      ...settings,
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'esm',
      logLevel: 'warning',
    });
    bundles.set(route, result.outputFiles[0].text);
  }
  const files = new Map<string, string | Buffer>();
  let next = 0;
  const server = createServer((req, res) => {
    const route = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    const send = (body: Buffer | string, type: string) => {
      res.writeHead(200, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
      res.end(body);
    };
    if (bundles.has(route)) return send(bundles.get(route)!, 'text/javascript');
    if (route === '/') return send('<!doctype html><meta charset="utf-8"><body></body>', 'text/html');
    if (route.startsWith('/file/')) {
      const item = files.get(route.slice(6));
      if (item !== undefined) return send(typeof item === 'string' ? readFileSync(item) : item, 'image/png');
    }
    if (route.startsWith('/models/') && MODEL_FILES[route.slice(8)])
      return send(readFileSync(MODEL_FILES[route.slice(8)]), 'application/octet-stream');
    const name = basename(route);
    const file = [name.endsWith('.onnx') ? (BACKGROUND_MODEL as string) : runtime]
      .map((dir) => join(dir, name))
      .find(existsSync);
    if (!file) {
      res.writeHead(404);
      return res.end();
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
    res.end(readFileSync(file));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser: Browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: options.gpu ? ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu'] : [],
  });
  const context = await browser.newContext();
  for (const pattern of [
    'https://huggingface.co/**',
    'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/**',
  ])
    await context.route(pattern, (route) =>
      route.fulfill({
        status: 307,
        headers: {
          location: `${origin}/${basename(new URL(route.request().url()).pathname)}`,
          'access-control-allow-origin': '*',
        },
      }),
    );
  // onnxruntime-web asks for its wasm under /ort/.
  await context.route(`${origin}/ort/**`, (route) =>
    route.fulfill({
      status: 307,
      headers: { location: `${origin}/${basename(new URL(route.request().url()).pathname)}` },
    }),
  );
  const page: Page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/`);
  // A string, so the bundler of this file leaves the page's own module imports alone.
  await page.evaluate(`(async () => {
    window.lab = await import('/lab.js');
    const { BackgroundRemovalClient } = await import('/bg/client.js');
    window.cutoutClient = new BackgroundRemovalClient();
  })()`);
  const register = (item: string | Buffer) => {
    const key = String(next++);
    files.set(key, item);
    return `/file/${key}`;
  };
  const failIfErrors = () => {
    if (errors.length) throw new Error(errors.splice(0).join('\n'));
  };
  return {
    async clipReal(list) {
      const urls = list.map(register);
      const out = await page.evaluate(
        async (u) => (window as unknown as { lab: typeof import('./lab-page') }).lab.clipReal(u),
        urls,
      );
      failIfErrors();
      return out.map((o) => o.real);
    },
    async upscale(file) {
      const url = register(file);
      const out = await page.evaluate(
        async (u) => (window as unknown as { lab: typeof import('./lab-page') }).lab.upscale(u),
        url,
      );
      failIfErrors();
      return { png: Buffer.from(out.png.split(',')[1], 'base64'), ms: out.ms };
    },
    async cutout(png) {
      const url = register(png);
      const base64 = await page.evaluate(async (u) => {
        const client = (
          window as unknown as {
            cutoutClient: import('../../src/lib/background-removal/client').BackgroundRemovalClient;
          }
        ).cutoutClient;
        const result = await client.run(await (await fetch(u)).blob(), () => {});
        const bytes = new Uint8Array(await result.blob.arrayBuffer());
        let text = '';
        for (let i = 0; i < bytes.length; i += 0x8000)
          text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(text);
      }, url);
      failIfErrors();
      return Buffer.from(base64, 'base64');
    },
    async clipSimilarities(file, sentences) {
      const url = register(file);
      const out = await page.evaluate(
        async ({ u, s }) =>
          (window as unknown as { lab: typeof import('./lab-page') }).lab.clipSimilarities(u, s),
        { u: url, s: sentences },
      );
      failIfErrors();
      return out;
    },
    async adapter() {
      return page.evaluate(async () => {
        const gpu = (
          navigator as unknown as {
            gpu?: { requestAdapter(): Promise<{ info?: Record<string, string> } | null> };
          }
        ).gpu;
        const adapter = await gpu?.requestAdapter();
        return adapter ? JSON.stringify(adapter.info ?? {}) : 'no WebGPU adapter';
      });
    },
    async close() {
      await page
        .evaluate(() => (window as unknown as { cutoutClient?: { dispose(): void } }).cutoutClient?.dispose())
        .catch(() => {});
      await browser.close();
      server.close();
    },
  };
}
