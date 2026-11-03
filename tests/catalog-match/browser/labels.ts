/**
 * Round 9 (② 가리는 것 빼기, no AI call): the app's own DeepLab pixel labels for each photo, through
 * `segmentRoom(…, { captureSemanticLabels: true })` as tests/reconstruction-semantic-labels-browser.ts
 * runs it. The page gets only the bundled code, `public/models` and the photo from this PC; every other
 * request is refused. Labels are the first full-photo pass, long edge at most 512, background = 0.
 *
 * Usage: node tests/run-browser-test.mjs tests/catalog-match/browser/labels.ts [--split fifteen,corpus-dev]
 * Output: test-results/catalog-match/labels/{<id>.u8,index.json}
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, relative, resolve } from 'node:path';
import { OUT } from '../paths.mjs';

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
};
const splits = arg('split', 'fifteen,corpus-dev').split(',');
const target = join(OUT as string, 'labels');
mkdirSync(target, { recursive: true });
const indexFile = join(target, 'index.json');
const done: Record<string, { width: number; height: number; ms: number; counts: Record<number, number> }> =
  existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : {};
const photos = (
  JSON.parse(readFileSync(join(OUT as string, 'photos', 'index.json'), 'utf8')) as {
    photos: { id: string; split: string; locked?: boolean; path: string }[];
  }
).photos.filter((p) => !p.locked && splits.includes(p.split) && !done[p.id]);

const entry = await build({
  stdin: { contents: "export {segmentRoom} from './src/lib/segmentation';", resolveDir: process.cwd() },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
});
const worker = await build({
  entryPoints: ['src/lib/segmentation/worker.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
});
const publicRoot = resolve('public', 'models');
const server = createServer((req, res) => {
  try {
    const path = new URL(req.url!, 'http://127.0.0.1').pathname;
    if (path === '/')
      return void res
        .setHeader('Content-Type', 'text/html')
        .end('<html><head><link rel="icon" href="data:,"></head></html>');
    if (path === '/index.js' || path === '/worker.ts')
      return void res
        .setHeader('Content-Type', 'text/javascript')
        .end(path === '/index.js' ? entry.outputFiles[0].text : worker.outputFiles[0].text);
    const photo = photos.find((p) => path === `/input/${p.id}`);
    if (photo) return void res.setHeader('Content-Type', 'image/jpeg').end(readFileSync(photo.path));
    const file = resolve('public', '.' + path);
    if (relative(publicRoot, file).startsWith('..')) throw new Error('not served');
    res.setHeader(
      'Content-Type',
      extname(file) === '.wasm'
        ? 'application/wasm'
        : extname(file) === '.json'
          ? 'application/json'
          : 'application/octet-stream',
    );
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const photo of photos) {
    const page = await browser.newPage();
    const external: string[] = [];
    await page.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(origin) || url.startsWith('blob:') || url.startsWith('data:'))
        return route.continue();
      external.push(url);
      return route.abort();
    });
    try {
      await page.goto(origin);
      const capture = await page.evaluate(
        async ({ origin, id }) => {
          const api = await import(origin + '/index.js');
          const blob = await (await fetch('/input/' + id)).blob();
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 180_000);
          const started = performance.now();
          try {
            const masks = await api.segmentRoom(blob, undefined, {
              signal: controller.signal,
              captureSemanticLabels: true,
            });
            const labels = masks.semanticLabels as Uint8Array;
            let text = '';
            for (let i = 0; i < labels.length; i += 0x8000)
              text += String.fromCharCode(...labels.subarray(i, i + 0x8000));
            return {
              width: masks.width,
              height: masks.height,
              labels: btoa(text),
              ms: performance.now() - started,
            };
          } finally {
            clearTimeout(timer);
            controller.abort();
          }
        },
        { origin, id: photo.id },
      );
      if (external.length) throw new Error(`external requests: ${external.join(', ')}`);
      const bytes = Buffer.from(capture.labels, 'base64');
      if (bytes.length !== capture.width * capture.height) throw new Error('label size');
      writeFileSync(join(target, `${photo.id}.u8`), bytes);
      const counts: Record<number, number> = {};
      for (const b of bytes) counts[b] = (counts[b] ?? 0) + 1;
      done[photo.id] = { width: capture.width, height: capture.height, ms: Math.round(capture.ms), counts };
      writeFileSync(indexFile, JSON.stringify(done, null, 1));
      console.log(photo.id, `${capture.width}×${capture.height}`, `${Math.round(capture.ms / 1000)} s`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
  await new Promise<void>((ok) => server.close(() => ok()));
}
