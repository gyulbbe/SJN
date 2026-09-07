/** Actual bundled logits + generic wall refinement QA. Coordinates below are test annotations only. */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';

const directory = 'test-results/wall-protection-qa';
const publicRoot = resolve('public');
await mkdir(directory, { recursive: true });
const worker = await build({
  stdin: {
    resolveDir: resolve('.'),
    loader: 'ts',
    contents: `
import * as tf from '@tensorflow/tfjs-core';
import { loadGraphModel } from '@tensorflow/tfjs-converter';
import { setThreadsCount,setWasmPaths } from '@tensorflow/tfjs-backend-wasm';
import { refineWallMask } from './src/lib/segmentation/wall-refinement';
self.onmessage=async({data})=>{try{
setWasmPaths(self.location.origin+'/models/tfjs-wasm/');setThreadsCount(1);
await tf.setBackend('wasm');await tf.ready();
const graph=await loadGraphModel(self.location.origin+'/models/deeplab-ade20k/model.json');
const bitmap=await createImageBitmap(data.blob);
const scale=Math.min(1,512/Math.max(bitmap.width,bitmap.height));
const width=Math.round(bitmap.width*scale),height=Math.round(bitmap.height*scale);
const canvas=new OffscreenCanvas(width,height),ctx=canvas.getContext('2d');
ctx.drawImage(bitmap,0,0,width,height);bitmap.close();
const rgba=ctx.getImageData(0,0,width,height).data,rgb=new Int32Array(width*height*3);
for(let i=0;i<width*height;i++){rgb[i*3]=rgba[i*4];rgb[i*3+1]=rgba[i*4+1];rgb[i*3+2]=rgba[i*4+2];}
const input=tf.tensor4d(rgb,[1,height,width,3],'int32');
const start=performance.now();
const tensors=graph.execute(input,['SemanticPredictions','logits/semantic/BiasAdd','Slice/size','strided_slice_6']);
const arrays=await Promise.all(tensors.map(t=>t.data()));
const shapes=tensors.map(t=>t.shape);
const refineStart=performance.now();
const refined=refineWallMask({width,height,rgba,labels:Uint8Array.from(arrays[0]),logits:{values:arrays[1],width:shapes[1][2],height:shapes[1][1],channels:shapes[1][3],cropWidth:arrays[2][2],cropHeight:arrays[2][1],paddedWidth:arrays[3][1],paddedHeight:arrays[3][0]}});
self.postMessage({width,height,rgba,arrays,shapes,refined,refineMs:performance.now()-refineStart,elapsedMs:refineStart-start,memory:tf.memory()});
tf.dispose(tensors);input.dispose();graph.dispose();
}catch(e){self.postMessage({error:String(e),stack:e.stack});}};`,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
});
const [productionWorker, entry] = await Promise.all([
  build({
    entryPoints: ['src/lib/segmentation/worker.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
  }),
  build({
    entryPoints: ['src/lib/segmentation/index.ts'],
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
      response.end('<body><canvas id="photo"></canvas></body>');
      return;
    }
    if (path === '/worker.js' || path === '/worker.ts' || path === '/index.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(
        (path === '/worker.js' ? worker : path === '/worker.ts' ? productionWorker : entry).outputFiles[0]
          .text,
      );
      return;
    }
    const file = resolve(publicRoot, `.${path}`);
    if (!file.startsWith(`${publicRoot}\\`)) return void response.writeHead(403).end();
    response.setHeader(
      'Content-Type',
      extname(file) === '.wasm'
        ? 'application/wasm'
        : extname(file) === '.json'
          ? 'application/json'
          : 'application/octet-stream',
    );
    response.end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  const result = await page.evaluate(async () => {
    type DiagnosticReply = {
      width: number;
      height: number;
      rgba: Uint8ClampedArray;
      arrays: (Float32Array | Int32Array)[];
      shapes: number[][];
      refined: ReturnType<typeof import('../src/lib/segmentation/wall-refinement').refineWallMask>;
      refineMs: number;
      elapsedMs: number;
      memory: Record<string, unknown>;
    };
    const blob = await (await fetch('/examples/bathroom.png')).blob();
    const result = await new Promise<DiagnosticReply>((done, reject) => {
      const worker = new Worker('/worker.js', { type: 'module' });
      worker.onmessage = (event) => {
        worker.terminate();
        if (event.data.error) reject(new Error(event.data.error));
        else done(event.data);
      };
      worker.onerror = reject;
      worker.postMessage({ blob });
    });
    const { width, height, rgba, arrays, shapes } = result;
    const [labels, logits, slice, size] = arrays;
    const { segmentRoom } = (await import(
      `${location.origin}/index.js`
    )) as typeof import('../src/lib/segmentation');
    const stages: { message: string; elapsedMs: number }[] = [];
    const start = performance.now();
    const actual = await segmentRoom(blob, (message) =>
      stages.push({ message, elapsedMs: performance.now() - start }),
    );
    const coldMs = performance.now() - start;
    const warmStart = performance.now();
    const warm = await segmentRoom(blob);
    const warmMs = performance.now() - warmStart;
    const production = {
      coldMs,
      warmMs,
      stages,
      floorBytesEqual: actual.floor.every((value, index) => value === (labels[index] === 4 ? 255 : 0)),
      wallBytesEqual: actual.wall.every((value, index) => value === result.refined.wall[index]),
      warmBytesEqual:
        actual.wall.every((value, index) => value === warm.wall[index]) &&
        actual.floor.every((value, index) => value === warm.floor[index]),
    };
    const [, lh, lw, channels] = shapes[1];
    const candidates = (x: number, y: number) => {
      const px = Math.min(lw - 1, ((x * (slice[2] - 1)) / (size[1] - 1)) * (lw - 1));
      const py = Math.min(lh - 1, ((y * (slice[1] - 1)) / (size[0] - 1)) * (lh - 1));
      const x0 = Math.floor(px),
        y0 = Math.floor(py),
        x1 = Math.min(lw - 1, x0 + 1),
        y1 = Math.min(lh - 1, y0 + 1),
        fx = px - x0,
        fy = py - y0;
      const values = Array.from({ length: channels }, (_, c) => ({
        label: c,
        score:
          (1 - fy) *
            ((1 - fx) * logits[(y0 * lw + x0) * channels + c] + fx * logits[(y0 * lw + x1) * channels + c]) +
          fy *
            ((1 - fx) * logits[(y1 * lw + x0) * channels + c] + fx * logits[(y1 * lw + x1) * channels + c]),
      })).sort((a, b) => b.score - a.score);
      const p = Math.floor(y * height) * width + Math.floor(x * width);
      return {
        label: labels[p],
        wallAfter: result.refined.wall[p],
        rgb: [rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2]],
        top: values.slice(0, 5),
      };
    };
    const points = {
      door: [0.05, 0.5],
      doorTop: [0.07, 0.1],
      doorBottom: [0.04, 0.85],
      frame: [0.94, 0.4],
      doorKnob: [0.138, 0.415],
      leftWall: [0.2, 0.5],
      rearWall: [0.5, 0.4],
      rightWall: [0.8, 0.4],
      tap: [0.372, 0.471],
      holder: [0.795, 0.438],
      leftShelf: [0.239, 0.45],
      mirror: [0.37, 0.28],
      toilet: [0.65, 0.65],
      floor: [0.5, 0.9],
    };
    const counts: Record<string, number> = {},
      bounds: Record<string, { left: number; top: number; right: number; bottom: number }> = {};
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      counts[label] = (counts[label] || 0) + 1;
      const x = i % width,
        y = Math.floor(i / width);
      const b = (bounds[label] ??= { left: x, top: y, right: x, bottom: y });
      b.left = Math.min(b.left, x);
      b.right = Math.max(b.right, x);
      b.top = Math.min(b.top, y);
      b.bottom = Math.max(b.bottom, y);
    }
    const canvas = document.getElementById('photo') as HTMLCanvasElement;
    const bitmap = await createImageBitmap(blob);
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const overlay = new OffscreenCanvas(width, height),
      octx = overlay.getContext('2d')!,
      image = octx.createImageData(width, height);
    for (let i = 0; i < labels.length; i++)
      if (labels[i] === 1) {
        image.data[i * 4] = 20;
        image.data[i * 4 + 1] = 210;
        image.data[i * 4 + 2] = 100;
        image.data[i * 4 + 3] = 150;
      }
    octx.putImageData(image, 0, 0);
    ctx.drawImage(overlay, 0, 0, canvas.width, canvas.height);
    const rawOverlay = canvas.toDataURL();
    const second = await createImageBitmap(blob);
    ctx.drawImage(second, 0, 0);
    second.close();
    for (let i = 0; i < labels.length; i++) {
      image.data[i * 4] = result.refined.protectedPixels[i] ? 240 : 20;
      image.data[i * 4 + 1] = result.refined.protectedPixels[i] ? 40 : 210;
      image.data[i * 4 + 2] = 100;
      image.data[i * 4 + 3] = result.refined.protectedPixels[i] || result.refined.wall[i] ? 150 : 0;
    }
    octx.putImageData(image, 0, 0);
    ctx.drawImage(overlay, 0, 0, canvas.width, canvas.height);
    const edgeDiagnostics = Array.from({ length: 25 }, (_, i) => {
      const x = 462 + i;
      const samples = Array.from({ length: height }, (_, y) => {
        const a = (y * width + x - 1) * 4,
          b = (y * width + x + 1) * 4;
        return Math.sqrt(
          ((rgba[a] - rgba[b]) ** 2 + (rgba[a + 1] - rgba[b + 1]) ** 2 + (rgba[a + 2] - rgba[b + 2]) ** 2) /
            3,
        );
      }).sort((a, b) => a - b);
      return {
        x,
        p35: samples[Math.floor(height * 0.35)],
        median: samples[Math.floor(height * 0.5)],
        p70: samples[Math.floor(height * 0.7)],
      };
    });
    return {
      shapes,
      slice: Array.from(slice),
      size: Array.from(size),
      elapsedMs: result.elapsedMs,
      refineMs: result.refineMs,
      stats: result.refined.stats,
      production,
      memory: result.memory,
      counts,
      bounds,
      edgeDiagnostics,
      points: Object.fromEntries(Object.entries(points).map(([key, [x, y]]) => [key, candidates(x, y)])),
      rawOverlay,
      overlay: canvas.toDataURL(),
    };
  });
  const { overlay, rawOverlay, ...summary } = result;
  await writeFile(`${directory}/raw-overlay.png`, Buffer.from(rawOverlay.split(',')[1], 'base64'));
  await writeFile(`${directory}/refined-overlay.png`, Buffer.from(overlay.split(',')[1], 'base64'));
  await writeFile(`${directory}/diagnostics.json`, JSON.stringify(summary, null, 2));
  assert.equal(
    summary.production.floorBytesEqual,
    true,
    'Production floor bytes must equal original model label4',
  );
  assert.equal(summary.production.wallBytesEqual, true, 'Production wall must use the tested refinement');
  assert.equal(summary.production.warmBytesEqual, true, 'Cached model outputs must remain deterministic');
  for (const key of [
    'door',
    'doorTop',
    'doorBottom',
    'frame',
    'doorKnob',
    'tap',
    'holder',
    'leftShelf',
    'mirror',
    'toilet',
  ])
    assert.equal(summary.points[key].wallAfter, 0, `${key} must stay protected`);
  for (const key of ['leftWall', 'rearWall', 'rightWall'])
    assert.equal(summary.points[key].wallAfter, 255, `${key} must keep wall coverage`);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
