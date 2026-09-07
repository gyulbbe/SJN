/** Real bundled model + CPU WASM in a Chrome Worker. No inference mocks or remote endpoints. */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const directory = 'test-results/segmentation';
const publicRoot = resolve('public');
const [entry, worker] = await Promise.all([
  build({
    entryPoints: ['src/lib/segmentation/index.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
  }),
  build({
    entryPoints: ['src/lib/segmentation/worker.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
  }),
]);
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url!, 'http://localhost').pathname;
    if (path === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        '<html lang="ko"><head><link rel="icon" href="data:,"></head><body style="margin:0;background:#f5f5f5;font:14px sans-serif"><h1>로컬 공간 분할 · 실제 CPU WASM 추론</h1><canvas id="result"></canvas></body></html>',
      );
      return;
    }
    if (path === '/index.js' || path === '/worker.ts') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end((path === '/index.js' ? entry : worker).outputFiles[0].text);
      return;
    }
    const file = resolve(publicRoot, `.${path}`);
    if (!file.startsWith(`${publicRoot}\\`)) {
      response.writeHead(403).end();
      return;
    }
    response.setHeader(
      'Content-Type',
      extname(file) === '.wasm'
        ? 'application/wasm'
        : extname(file) === '.json'
          ? 'application/json'
          : extname(file) === '.png'
            ? 'image/png'
            : 'application/octet-stream',
    );
    response.end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const port = (server.address() as { port: number }).port;
const origin = `http://127.0.0.1:${port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1550, height: 1120 } });
const page = await context.newPage();
const errors: string[] = [];
const requests: { url: string; method: string }[] = [];
context.on('request', (request) => requests.push({ url: request.url(), method: request.method() }));
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
try {
  await mkdir(directory, { recursive: true });
  await page.goto(origin);
  const result = await page.evaluate(async (base) => {
    const { segmentRoom } = (await import(`${base}/index.js`)) as typeof import('../src/lib/segmentation');
    const blob = await (await fetch('/examples/bathroom.png')).blob();
    const bitmap = await createImageBitmap(blob);
    const stages: { message: string; elapsedMs: number }[] = [];
    const start = performance.now();
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 25);
    const masks = await segmentRoom(blob, (message) =>
      stages.push({ message, elapsedMs: performance.now() - start }),
    );
    const coldMs = performance.now() - start;
    clearInterval(ticker);
    const point = (x: number, y: number) => {
      const position = Math.floor(y * masks.height) * masks.width + Math.floor(x * masks.width);
      return { wall: masks.wall[position], floor: masks.floor[position] };
    };
    const points = {
      rearWall: point(0.5, 0.4),
      leftWall: point(0.2, 0.5),
      rightWall: point(0.8, 0.4),
      floor: point(0.5, 0.9),
      toilet: point(0.65, 0.65),
      basin: point(0.36, 0.52),
      mirror: point(0.37, 0.28),
      window: point(0.86, 0.12),
    };
    const display = document.getElementById('result') as HTMLCanvasElement;
    display.width = bitmap.width;
    display.height = bitmap.height;
    const ctx = display.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const overlay = document.createElement('canvas');
    overlay.width = masks.width;
    overlay.height = masks.height;
    const octx = overlay.getContext('2d')!;
    const pixels = octx.createImageData(masks.width, masks.height);
    for (let i = 0; i < masks.wall.length; i++) {
      pixels.data[i * 4] = masks.wall[i] ? 10 : 20;
      pixels.data[i * 4 + 1] = masks.wall[i] ? 185 : 70;
      pixels.data[i * 4 + 2] = masks.wall[i] ? 100 : 255;
      pixels.data[i * 4 + 3] = masks.wall[i] || masks.floor[i] ? 140 : 0;
    }
    octx.putImageData(pixels, 0, 0);
    ctx.drawImage(overlay, 0, 0, display.width, display.height);
    const warmStages: string[] = [];
    const warmStart = performance.now();
    const warm = await segmentRoom(blob, (message) => warmStages.push(message));
    const warmMs = performance.now() - warmStart;
    const same =
      warm.wall.every((value, index) => value === masks.wall[index]) &&
      warm.floor.every((value, index) => value === masks.floor[index]);
    const portraitCanvas = document.createElement('canvas');
    portraitCanvas.width = 480;
    portraitCanvas.height = 720;
    portraitCanvas.getContext('2d')!.drawImage(bitmap, 384, 0, 768, 1024, 0, 0, 480, 720);
    const portraitBlob = await new Promise<Blob>((done) =>
      portraitCanvas.toBlob((blob) => done(blob!), 'image/png'),
    );
    const portrait = await segmentRoom(portraitBlob);
    bitmap.close();
    return {
      coldMs,
      warmMs,
      dimensions: [masks.width, masks.height],
      source: [display.width, display.height],
      wallPixels: masks.wall.reduce((sum, value) => sum + (value ? 1 : 0), 0),
      floorPixels: masks.floor.reduce((sum, value) => sum + (value ? 1 : 0), 0),
      points,
      stages,
      warmStages,
      same,
      mainThreadIntervalTicks: ticks,
      portrait: [portrait.width, portrait.height],
      mask: overlay.toDataURL('image/png'),
      overlay: display.toDataURL('image/png'),
    };
  }, origin);
  const { mask, overlay, ...summary } = result;
  await writeFile(`${directory}/mask.png`, Buffer.from(mask.split(',')[1], 'base64'));
  await writeFile(`${directory}/overlay.png`, Buffer.from(overlay.split(',')[1], 'base64'));
  await page.screenshot({ path: `${directory}/browser.png`, fullPage: true });
  const modelBytes = await readFile('public/models/deeplab-ade20k/group1-shard1of1');
  const report = {
    browser: await browser.version(),
    compute: 'TensorFlow.js 4.22.0 WASM single-thread CPU in Worker',
    model: 'Google DeepLabV3 MobileNetV2 ADE20K quantized uint8 v1',
    modelBytes: modelBytes.length,
    modelSHA256: createHash('sha256').update(modelBytes).digest('hex'),
    ...summary,
    requests,
    externalRequests: requests.filter((request) => new URL(request.url).origin !== origin),
    errors,
  };
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.equal(result.dimensions[0], 512);
  assert.equal(result.dimensions[1], 341);
  assert.deepEqual(result.portrait, [341, 512]);
  assert.ok(result.wallPixels > result.dimensions[0] * result.dimensions[1] * 0.1);
  assert.ok(result.floorPixels > result.dimensions[0] * result.dimensions[1] * 0.05);
  assert.equal(result.points.rearWall.wall, 255);
  assert.equal(result.points.floor.floor, 255);
  assert.equal(result.points.toilet.wall, 0);
  assert.equal(result.points.toilet.floor, 0);
  assert.equal(result.same, true);
  assert.ok(result.mainThreadIntervalTicks > 2, 'Worker 추론 동안 메인 스레드가 동작해야 함');
  assert.ok(
    !result.warmStages.some((stage) => stage.includes('모델 읽는')),
    '캐시된 모델을 다시 다운로드하지 않음',
  );
  assert.equal(report.externalRequests.length, 0);
  assert.ok(requests.every((request) => request.method === 'GET'));
  assert.equal(errors.length, 0);
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
