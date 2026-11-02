/**
 * The catalog-match trial's Chrome harness (node side): a 127.0.0.1 server that serves the trial's
 * files (results, model files, ONNX Runtime Web from node_modules, the page bundle) and saves what the
 * page posts under the results folder, and a headless Chrome on it. Nothing leaves the PC: the page
 * only talks to this server.
 */
import { chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { createServer, type Server } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { CORPUS_INPUTS, MODELS, OUT, ROOT } from '../paths.mjs';

const TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.onnx': 'application/octet-stream',
};
const ORT = resolve('node_modules/onnxruntime-web/dist');
/** Paths a request may read: the results, the public corpus photos, the models (and the app's cached BiRefNet), the runtime. */
const ROOTS = [
  resolve(OUT as string),
  resolve(CORPUS_INPUTS as string),
  resolve(MODELS as string),
  resolve(ROOT as string, 'tmp', 'background-model'),
  ORT,
];
const inside = (path: string) => ROOTS.some((root) => !relative(root, path).startsWith('..'));

export type Harness = {
  page: Page;
  base: string;
  browser: Browser;
  server: Server;
  close: () => Promise<void>;
};

/**
 * Bundles `pageEntry` (exports become `window.CM`), serves it and opens Chrome. `gpu: false` turns
 * WebGPU off (the WASM path); `cpuThrottle` slows the page's CPU (the low-end stand-in).
 */
export async function openHarness(options: {
  pageEntry: string;
  gpu?: boolean;
  cpuThrottle?: number;
}): Promise<Harness> {
  const bundle = await build({
    entryPoints: [options.pageEntry],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    globalName: 'CM',
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_MOGE_MODEL_URL': 'undefined' },
    logLevel: 'warning',
  });
  const script = bundle.outputFiles[0].text;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'POST' && url.pathname === '/out') {
        const target = resolve(OUT as string, url.searchParams.get('path') ?? '');
        if (relative(resolve(OUT as string), target).startsWith('..')) throw new Error('outside results');
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, Buffer.concat(chunks));
        response.end('ok');
        return;
      }
      if (url.pathname === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><meta charset="utf-8"><body></body>');
        return;
      }
      if (url.pathname === '/page.js') {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(script);
        return;
      }
      const path = url.pathname.startsWith('/ort/')
        ? join(ORT, url.pathname.slice(5))
        : resolve(decodeURIComponent(url.searchParams.get('path') ?? ''));
      if (!(url.pathname.startsWith('/ort/') || url.pathname === '/file') || !inside(path))
        throw new Error('not served');
      response.setHeader('Content-Type', TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream');
      response.end(await readFile(path));
    } catch (error) {
      response.statusCode = 404;
      response.end(String(error));
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args:
      options.gpu === false
        ? ['--disable-gpu', '--disable-webgpu']
        : ['--enable-unsafe-webgpu', '--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on('pageerror', (error) => console.error('[page]', error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning')
      console.error('[console]', message.text());
  });
  await page.goto(base + '/');
  if (options.cpuThrottle && options.cpuThrottle > 1) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: options.cpuThrottle });
  }
  await page.addScriptTag({ url: base + '/page.js' });
  return {
    page,
    base,
    browser,
    server,
    close: async () => {
      await browser.close();
      await new Promise((done) => server.close(done));
    },
  };
}

/** The served URL of a file under the results or models. */
export const fileUrl = (base: string, path: string) => `${base}/file?path=${encodeURIComponent(path)}`;
