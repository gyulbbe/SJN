/** Actual local model + projected floor grid regression. Outputs only floor-geometry-qa. */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import assert from 'node:assert/strict';

const output = 'test-results/floor-geometry-qa';
const root = resolve('public');
const [entry, worker] = await Promise.all([
  build({
    stdin: {
      contents:
        "export {segmentRoom} from './src/lib/segmentation'; export {detectSurfaces,estimatePlaneQuad,binaryMaskToMask} from './src/lib/render/auto-surfaces'; export {homography,transformPoint} from './src/lib/render/math'; export {maskContains} from './src/lib/render/mask';",
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
        '<html><head><link rel="icon" href="data:,"></head><body style="margin:0"><canvas id="comparison"></canvas></body></html>',
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
  const context = await browser.newContext({ viewport: { width: 1536, height: 600 } });
  const requests: string[] = [],
    errors: string[] = [];
  context.on('request', (request) => requests.push(request.url()));
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  const result = await page.evaluate(async (base) => {
    type API = typeof import('../src/lib/segmentation') &
      typeof import('../src/lib/render/auto-surfaces') &
      typeof import('../src/lib/render/math') &
      typeof import('../src/lib/render/mask');
    const api = (await import(`${base}/index.js`)) as API;
    const bitmap = await createImageBitmap(await (await fetch('/examples/bathroom.png')).blob());
    const source = document.createElement('canvas');
    source.width = bitmap.width;
    source.height = bitmap.height;
    source.getContext('2d')!.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob>((done) => source.toBlob((blob) => done(blob!), 'image/png'));
    const start = performance.now();
    const masks = await api.segmentRoom(blob);
    const inferenceMs = performance.now() - start;
    const detected = api.detectSurfaces({
      width: masks.width,
      height: masks.height,
      wallMask: masks.wall,
      floorMask: masks.floor,
    });
    const floor = detected.surfaces.find((surface) => surface.kind === 'floor')!;
    if (!floor) throw new Error('예시 사진에서 실제 바닥 감지 실패');
    const oldQuad = api.estimatePlaneQuad([floor.mask.polygon, ...(floor.mask.polygons ?? [])]);
    const newQuad = floor.quad;
    const vanishingPoint = (quad: import('../src/lib/types').Quad) => {
      const left = (quad[3].x - quad[0].x) / (quad[3].y - quad[0].y),
        right = (quad[2].x - quad[1].x) / (quad[2].y - quad[1].y);
      const bLeft = quad[0].x - left * quad[0].y,
        bRight = quad[1].x - right * quad[1].y;
      const y = (bRight - bLeft) / (left - right);
      return { x: left * y + bLeft, y };
    };
    const diagonalErrors = (quad: import('../src/lib/types').Quad) => {
      const left: number[] = [],
        right: number[] = [];
      for (let y = 0; y < masks.height; y++) {
        let min = Infinity,
          max = -Infinity;
        for (let x = 0; x < masks.width; x++)
          if (masks.floor[y * masks.width + x]) {
            min = Math.min(min, x);
            max = Math.max(max, x + 1);
          }
        left.push(min);
        right.push(max);
      }
      const medianError = (
        rows: number[],
        a: import('../src/lib/types').Point,
        b: import('../src/lib/types').Point,
      ) => {
        const errors: number[] = [],
          slope = (b.x - a.x) / (b.y - a.y);
        for (let y = 3; y < masks.height - 3; y++)
          if (
            Number.isFinite(rows[y - 3]) &&
            Number.isFinite(rows[y + 3]) &&
            Math.abs(rows[y + 3] - rows[y - 3]) > 3
          ) {
            const predicted = (a.x + slope * ((y + 0.5) / masks.height - a.y)) * masks.width;
            errors.push(Math.abs(predicted - rows[y]));
          }
        errors.sort((a, b) => a - b);
        return errors[Math.floor(errors.length / 2)];
      };
      return { left: medianError(left, quad[0], quad[3]), right: medianError(right, quad[1], quad[2]) };
    };
    let maskDifferences = 0;
    for (let i = 0; i < masks.floor.length; i++) {
      const p = {
        x: ((i % masks.width) + 0.5) / masks.width,
        y: (Math.floor(i / masks.width) + 0.5) / masks.height,
      };
      if (api.maskContains(floor.mask, p) !== Boolean(masks.floor[i])) maskDifferences++;
    }
    const display = document.getElementById('comparison') as HTMLCanvasElement;
    display.width = bitmap.width * 2;
    display.height = bitmap.height + 68;
    display.style.width = '1536px';
    const ctx = display.getContext('2d')!;
    const unit: import('../src/lib/types').Quad = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    const draw = (quad: import('../src/lib/types').Quad, xOffset: number, color: string, label: string) => {
      ctx.save();
      ctx.translate(xOffset, 68);
      ctx.drawImage(bitmap, 0, 0);
      ctx.beginPath();
      for (const polygon of [
        floor.mask.polygon,
        ...(floor.mask.polygons ?? []),
        ...(floor.mask.holes ?? []),
      ]) {
        polygon.forEach((point, index) => {
          const x = point.x * bitmap.width,
            y = point.y * bitmap.height;
          if (!index) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.closePath();
      }
      ctx.clip('evenodd');
      ctx.fillStyle = 'rgba(225,227,221,.58)';
      ctx.fillRect(0, 0, bitmap.width, bitmap.height);
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      const h = api.homography(unit, quad);
      const line = (a: import('../src/lib/types').Point, b: import('../src/lib/types').Point, extend = 1) => {
        const p = api.transformPoint(h, a),
          q = api.transformPoint(h, b);
        ctx.beginPath();
        ctx.moveTo(p.x * bitmap.width, p.y * bitmap.height);
        ctx.lineTo((p.x + (q.x - p.x) * extend) * bitmap.width, (p.y + (q.y - p.y) * extend) * bitmap.height);
        ctx.stroke();
      };
      // Extend in image coordinates; extrapolating texture v through its projective pole
      // would reverse the segment and hide the visible foreground column lines.
      for (let i = -8; i <= 12; i++) line({ x: i * 0.3, y: 0 }, { x: i * 0.3, y: 1 }, 4);
      for (let i = 0; i <= 16; i++) line({ x: -3, y: i * 0.3 }, { x: 4, y: i * 0.3 });
      ctx.restore();
      ctx.fillStyle = '#fff';
      ctx.fillRect(xOffset, 0, bitmap.width, 68);
      ctx.fillStyle = color;
      ctx.font = '28px sans-serif';
      ctx.fillText(label, xOffset + 24, 44);
    };
    draw(oldQuad, 0, '#c94b42', '이전 · 문틀 끝점으로 원근 추정');
    draw(newQuad, bitmap.width, '#126f60', '수정 · 관측된 바닥 경계선으로 원근 추정');
    const image = display.toDataURL('image/png');
    bitmap.close();
    return {
      inferenceMs,
      maskResolution: [masks.width, masks.height],
      oldQuad,
      newQuad,
      oldVanishingPoint: vanishingPoint(oldQuad),
      newVanishingPoint: vanishingPoint(newQuad),
      oldDiagonalBoundaryMedianErrorPixels: diagonalErrors(oldQuad),
      newDiagonalBoundaryMedianErrorPixels: diagonalErrors(newQuad),
      maskDifferences,
      floorPixels: masks.floor.reduce((sum, value) => sum + Number(Boolean(value)), 0),
      image,
      warnings: detected.warnings,
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
        externalRequests: requests.filter((url) => new URL(url).origin !== origin),
        errors,
        limitation:
          'Boundary fit estimates texture perspective. It is not metric calibration or a measured ground-truth grout-line fit; segmentation errors are kept unchanged.',
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(report, null, 2));
  assert.equal(result.maskDifferences, 0);
  assert.ok(result.newDiagonalBoundaryMedianErrorPixels.left < 2.5);
  assert.ok(
    result.newDiagonalBoundaryMedianErrorPixels.left <
      result.oldDiagonalBoundaryMedianErrorPixels.left * 0.35,
  );
  assert.ok(result.newDiagonalBoundaryMedianErrorPixels.right < 2.5);
  assert.equal(errors.length, 0);
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
