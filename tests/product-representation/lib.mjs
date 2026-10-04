// Shared helpers for the product-representation study (docs/product-representation-results-20261004.md).
// Needs the local dev server (npm run dev, http://127.0.0.1:3000) and a signed-in admin session saved by
// the earlier e2e-flow work at test-results/e2e-flow/state.json (git-excluded); STATE=... overrides it.
import { chromium } from '@playwright/test';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

export const ROOT = 'test-results/product-representation';
export const BASE = 'http://127.0.0.1:3000';
export const STATE = process.env.STATE ?? 'test-results/e2e-flow/state.json';
mkdirSync(`${ROOT}/shots`, { recursive: true });

/** Serve the pinned ONNX models and the onnxruntime runtime from disk (no downloads from the internet). */
async function modelServer() {
  const roots = [
    path.resolve('tmp/multiview-model'),
    path.resolve('tmp/background-model'),
    path.resolve('node_modules/onnxruntime-web/dist'),
  ];
  const server = createServer((req, res) => {
    const name = path.basename(new URL(req.url, 'http://localhost').pathname);
    const file = roots.map((r) => path.join(r, name)).find((f) => existsSync(f));
    if (!file) {
      res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': name.endsWith('.wasm')
        ? 'application/wasm'
        : /\.m?js$/.test(name)
          ? 'text/javascript'
          : 'application/octet-stream',
      'Content-Length': statSync(file).size,
      'Access-Control-Allow-Origin': '*',
    });
    createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

export async function session({ viewport = { width: 1440, height: Number(process.env.VH ?? 1100) } } = {}) {
  const models = await modelServer();
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: [] });
  const context = await browser.newContext({ storageState: STATE, viewport, acceptDownloads: true });
  const redirect = (route) =>
    route.fulfill({
      status: 307,
      headers: {
        location: `${models.origin}/${path.basename(new URL(route.request().url()).pathname)}`,
        'access-control-allow-origin': '*',
      },
    });
  await context.route('https://huggingface.co/**', redirect);
  await context.route('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.29.0/dist/**', redirect);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', String(e).slice(0, 300)));
  return {
    browser,
    context,
    page,
    close: async () => {
      await browser.close();
      models.close();
    },
  };
}

/** The signed-in session's cookie, for plain fetches against the app's own API. */
export function cookieHeader() {
  const state = JSON.parse(readFileSync(STATE, 'utf8'));
  return state.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}
/** POST /api/d1/<resource> the way the editor's cloud repository does. */
export async function d1(resource, body) {
  const res = await fetch(`${BASE}/api/d1/${resource}`, {
    method: 'POST',
    headers: {
      cookie: cookieHeader(),
      'content-type': 'application/json',
      origin: BASE,
      'x-idempotency-key': crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
}
