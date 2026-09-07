/** Real RGB + browser model comparison of wall plane projection; no photo-specific product logic. */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import assert from 'node:assert/strict';

const output = 'test-results/wall-geometry-qa',
  root = resolve('public');
const [entry, worker] = await Promise.all([
  build({
    stdin: {
      contents:
        "export {segmentRoom} from './src/lib/segmentation';export {analyzeWallGeometry,applyWallGeometry} from './src/lib/render/wall-geometry';export {detectSurfaces} from './src/lib/render/auto-surfaces';export {homography,transformPoint} from './src/lib/render/math';export {maskContains} from './src/lib/render/mask';",
      resolveDir: process.cwd(),
    },
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
        '<html><head><link rel="icon" href="data:,"></head><body style="margin:0"><canvas id="result"></canvas></body></html>',
      );
      return;
    }
    if (path === '/index.js' || path === '/worker.ts') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end((path === '/index.js' ? entry : worker).outputFiles[0].text);
      return;
    }
    const file = resolve(root, `.${path}`);
    if (!file.startsWith(root + sep)) {
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
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1536, height: 600 } }),
    page = await context.newPage();
  const requests: string[] = [],
    errors: string[] = [];
  context.on('request', (request) => requests.push(request.url()));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  const result = await page.evaluate(async (base) => {
    type API = typeof import('../src/lib/segmentation') &
      typeof import('../src/lib/render/wall-geometry') &
      typeof import('../src/lib/render/auto-surfaces') &
      typeof import('../src/lib/render/math') &
      typeof import('../src/lib/render/mask');
    const api = (await import(`${base}/index.js`)) as API;
    const blob = await (await fetch('/examples/bathroom.png')).blob(),
      photo = await createImageBitmap(blob);
    const masks = await api.segmentRoom(blob),
      start = performance.now();
    const geometry = await api.analyzeWallGeometry(blob, masks),
      analysisMs = performance.now() - start;
    const before = api
      .detectSurfaces({
        width: masks.width,
        height: masks.height,
        wallMask: masks.wall,
        floorMask: masks.floor,
      })
      .surfaces.filter((surface) => surface.kind === 'wall');
    const after = api
      .applyWallGeometry(
        api.detectSurfaces({
          width: masks.width,
          height: masks.height,
          wallMask: masks.wall,
          floorMask: masks.floor,
          wallSeams: geometry.wallSeams,
        }).surfaces,
        geometry,
      )
      .filter((surface) => surface.kind === 'wall');
    let maskDifferences = 0;
    for (let i = 0; i < masks.wall.length; i++) {
      const p = {
        x: ((i % masks.width) + 0.5) / masks.width,
        y: (Math.floor(i / masks.width) + 0.5) / masks.height,
      };
      if (
        before.some((surface) => api.maskContains(surface.mask, p)) !==
        after.some((surface) => api.maskContains(surface.mask, p))
      )
        maskDifferences++;
    }
    const canvas = document.getElementById('result') as HTMLCanvasElement;
    canvas.width = photo.width * 2;
    canvas.height = photo.height + 68;
    canvas.style.width = '1536px';
    const ctx = canvas.getContext('2d')!,
      unit: import('../src/lib/types').Quad = [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ];
    const draw = (surfaces: import('../src/lib/types').Surface[], offset: number, label: string) => {
      ctx.save();
      ctx.translate(offset, 68);
      ctx.drawImage(photo, 0, 0);
      for (const surface of surfaces) {
        ctx.save();
        ctx.beginPath();
        for (const polygon of [
          surface.mask.polygon,
          ...(surface.mask.polygons ?? []),
          ...(surface.mask.holes ?? []),
        ]) {
          polygon.forEach((p, i) => {
            if (i) ctx.lineTo(p.x * photo.width, p.y * photo.height);
            else ctx.moveTo(p.x * photo.width, p.y * photo.height);
          });
          ctx.closePath();
        }
        ctx.clip('evenodd');
        ctx.fillStyle = 'rgba(25,40,44,.72)';
        ctx.fillRect(0, 0, photo.width, photo.height);
        const h = api.homography(unit, surface.quad);
        ctx.strokeStyle = '#b8c8c2';
        ctx.lineWidth = 2;
        const line = (a: import('../src/lib/types').Point, b: import('../src/lib/types').Point) => {
          const p = api.transformPoint(h, a),
            q = api.transformPoint(h, b),
            dx = q.x - p.x,
            dy = q.y - p.y;
          ctx.beginPath();
          ctx.moveTo((p.x - dx * 6) * photo.width, (p.y - dy * 6) * photo.height);
          ctx.lineTo((p.x + dx * 7) * photo.width, (p.y + dy * 7) * photo.height);
          ctx.stroke();
        };
        for (let i = -4; i < 14; i++)
          line({ x: (i * 600) / surface.widthMm, y: 0 }, { x: (i * 600) / surface.widthMm, y: 1 });
        for (let i = -4; i < 14; i++) {
          const v = (i * 600 + surface.tile.offsetY) / surface.heightMm;
          line({ x: 0, y: v }, { x: 1, y: v });
        }
        ctx.restore();
      }
      ctx.restore();
      ctx.fillStyle = '#fff';
      ctx.fillRect(offset, 0, photo.width, 68);
      ctx.fillStyle = '#244b45';
      ctx.font = '27px sans-serif';
      ctx.fillText(label, offset + 24, 44);
    };
    draw(before, 0, '이전 · 이어진 벽에 하나의 평면');
    draw(after, photo.width, '수정 · 사진 모서리에 맞춘 세 벽의 원근');
    const image = canvas.toDataURL('image/png');
    photo.close();
    return {
      analysisMs,
      maskResolution: [masks.width, masks.height],
      geometry,
      beforeWalls: before.length,
      afterWalls: after.length,
      after: after.map((surface) => ({
        name: surface.name,
        quad: surface.quad,
        widthMm: surface.widthMm,
        heightMm: surface.heightMm,
        offsetY: surface.tile.offsetY,
      })),
      maskDifferences,
      image,
    };
  }, origin);
  await mkdir(output, { recursive: true });
  const { image, ...report } = result;
  await writeFile(`${output}/comparison.png`, Buffer.from(image.split(',')[1], 'base64'));
  await writeFile(
    `${output}/report.json`,
    JSON.stringify(
      {
        ...report,
        browser: await browser.version(),
        errors,
        externalRequests: requests.filter((url) => new URL(url).origin !== origin),
        note: 'Projection-grid QA. RGB corners and floor anchors infer perspective; dimensions remain uncalibrated. Semantic door/frame errors are not changed by wall geometry.',
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(report, null, 2));
  assert.equal(result.geometry.wallSeams.length, 2);
  assert.equal(result.geometry.planes.length, 3);
  assert.equal(result.afterWalls, 3);
  assert.equal(result.maskDifferences, 0);
  assert.equal(errors.length, 0);
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
