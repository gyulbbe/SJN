/**
 * Real-WebGL before/after of the input photo's colours on the saved TripoSR meshes (no new AI run):
 * for each product, the mixed ("혼합") and original ("원본 색") colours without and with the photo
 * laid over the mesh, seen from 0°, 90°, 180° and 270° around the photographed side, plus the
 * photographed side up close. The photo is decoded the way the editor does (decodeProductPhoto, the
 * real canvas path), and the camera search, the colours and the refinement run in a real Web Worker
 * (src/lib/product3d/surface-worker.ts) through preparePaintedMesh, as in the page.
 *
 * Usage: node tests/run-browser-test.mjs tests/product3d-photo-browser.ts [--gpu]
 *   MESH=cat-toilet-a,02-smart-toilet   only these products
 *   OUT=test-results/xx                 another output folder
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp, { type OverlayOptions } from 'sharp';

const gpu = process.argv.includes('--gpu');
const output = process.env.OUT ?? 'test-results/product3d-photo';
const root = 'test-results/product3d-batch';
const products = [
  {
    name: 'cat-toilet-a',
    mesh: `${root}/bear-a-original-500`,
    photo: 'test-results/diag/cat-toilet/cat-toilet-source-500.png',
  },
  { name: 'bear-b', mesh: `${root}/bear-b-upscaled-1000`, photo: `${root}/bear-b-upscaled-1000/cutout.png` },
  { name: 'bear-c', mesh: `${root}/bear-c-crop-1000`, photo: `${root}/bear-c-crop-1000/cutout.png` },
  ...[
    '01-shelf',
    '02-smart-toilet',
    '03-bathtub-rect',
    '04-bathtub-scene',
    '05-bathtub-top',
    '06-paper-holder',
    '07-stool',
    '08-mirror',
  ].map((name) => ({ name, mesh: `${root}/${name}`, photo: `${root}/${name}/cutout.png` })),
].filter(
  (p) =>
    existsSync(`${p.mesh}/mesh-positions.bin`) &&
    existsSync(p.photo) &&
    (!process.env.MESH || process.env.MESH.split(',').includes(p.name)),
);
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    contents: [
      "export {ProductRenderer} from './src/lib/product3d/renderer';",
      "export {createDefaultPose} from './src/lib/product3d/pose';",
      "export {estimateUprightQuaternion} from './src/lib/product3d/upright';",
      "export {preparePaintedMesh, prepareProductSurface} from './src/lib/product3d/surface';",
      "export {decodeProductPhoto} from './src/lib/product3d/input-cutout';",
    ].join(''),
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'P',
  define: { 'import.meta.url': '"http://localhost/page.js"' },
});
const worker = await build({
  entryPoints: ['src/lib/product3d/surface-worker.ts'],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
});
const azimuths = [0, 90, 180, 270];
const rows = [
  { mode: 'mixed', painted: false },
  { mode: 'mixed', painted: true },
  { mode: 'baked', painted: false },
  { mode: 'baked', painted: true },
];
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: gpu
    ? ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu']
    : ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const tile = 300,
  label = 22;
const caption = (text: string, width = tile) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${label}"><rect width="100%" height="100%" fill="#e6e6e0"/><text x="6" y="16" font-family="sans-serif" font-size="13" fill="#222">${text}</text></svg>`,
  );
const sheets: { name: string; image: Buffer }[] = [];
const metrics: Record<string, unknown>[] = [];
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  // Every Worker the bundle starts is the surface worker (as the page's own build would emit).
  await page.setContent('<body></body>');
  await page.evaluate(`(() => {
    const Real = window.Worker; let url;
    window.__setWorker = (code) => { url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })); };
    window.Worker = function (_u, options) { return new Real(url, options && options.type === 'module' ? {} : options); };
  })();`);
  await page.evaluate(
    (code) => (window as unknown as { __setWorker: (c: string) => void }).__setWorker(code),
    worker.outputFiles[0].text,
  );
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  for (const product of products) {
    const dir = `${product.mesh}/`;
    const b64 = (file: string) => readFileSync(file).toString('base64');
    const result = await page.evaluate(
      async (data) => {
        const decode = (s: string) => {
          const bin = atob(s);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return bytes.buffer;
        };
        const positions = new Float32Array(decode(data.p)),
          colors = new Float32Array(decode(data.c)),
          indices = new Uint32Array(decode(data.i));
        const mesh = { positions, colors, indices };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const P = (window as unknown as { P: Record<string, any> }).P;
        const photo = new Blob([decode(data.photo)], { type: 'image/png' });
        const started = performance.now();
        const outcome = await P.preparePaintedMesh(mesh, () => P.decodeProductPhoto(photo));
        const paintMs = Math.round(performance.now() - started);
        const toBase64 = (blob: Blob) =>
          new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1]);
            reader.readAsDataURL(blob);
          });
        const up = P.estimateUprightQuaternion(positions);
        const base = P.createDefaultPose().cameraQuaternion;
        const turn = (degrees: number) => {
          const [x, y, z, w] = base;
          const h = (degrees * Math.PI) / 360;
          const [qx, qy, qz, qw] = [0, 0, Math.sin(h), Math.cos(h)];
          return [
            qw * x + qx * w + qy * z - qz * y,
            qw * y - qx * z + qy * w + qz * x,
            qw * z + qx * y - qy * x + qz * w,
            qw * w - qx * x - qy * y - qz * z,
          ];
        };
        const shots: Record<string, string> = {};
        const setup: Record<string, number> = {};
        for (const row of data.rows) {
          const key = `${row.mode}-${row.painted ? 'photo' : 'plain'}`;
          if (row.painted && outcome.status !== 'ok') continue;
          const shown = row.painted ? outcome.mesh : mesh;
          const prepared = performance.now();
          await P.prepareProductSurface(row.mode, shown);
          const canvas = document.createElement('canvas');
          document.body.append(canvas);
          const renderer = new P.ProductRenderer(canvas, shown);
          renderer.resize(512, 512, 1);
          renderer.setShading(row.mode);
          setup[key] = Math.round(performance.now() - prepared);
          for (const azimuth of data.azimuths) {
            renderer.setPose({
              ...P.createDefaultPose(),
              objectQuaternion: up,
              cameraQuaternion: turn(azimuth),
            });
            shots[`${key}-${azimuth}`] = await toBase64((await renderer.capture()).blob);
          }
          renderer.dispose();
          canvas.remove();
        }
        const summary =
          outcome.status === 'ok'
            ? {
                status: 'ok',
                iou: outcome.iou,
                camera: outcome.camera,
                vertices: outcome.mesh.positions.length / 3,
              }
            : { status: 'failed', reason: outcome.reason, iou: outcome.iou, message: outcome.message };
        return { shots, setup, paintMs, summary };
      },
      {
        p: b64(`${dir}mesh-positions.bin`),
        c: b64(`${dir}mesh-colors.bin`),
        i: b64(`${dir}mesh-indices.bin`),
        photo: b64(product.photo),
        rows,
        azimuths,
      },
    );
    const composites: OverlayOptions[] = [];
    for (const [rowIndex, row] of rows.entries())
      for (const [column, azimuth] of azimuths.entries()) {
        const key = `${row.mode}-${row.painted ? 'photo' : 'plain'}-${azimuth}`;
        const left = column * tile,
          top = rowIndex * (tile + label);
        const shot = result.shots[key];
        composites.push({
          input: shot
            ? await sharp(Buffer.from(shot, 'base64'))
                .flatten({ background: '#f4f4f0' })
                .resize(tile, tile)
                .toBuffer()
            : await sharp({ create: { width: tile, height: tile, channels: 3, background: '#d8d8d2' } })
                .png()
                .toBuffer(),
          left,
          top: top + label,
        });
        composites.push({
          input: caption(
            `${product.name} · ${row.mode} · ${row.painted ? 'photo colours' : 'as before'} · ${azimuth}°`,
          ),
          left,
          top,
        });
      }
    const image = await sharp({
      create: {
        width: tile * azimuths.length,
        height: (tile + label) * rows.length,
        channels: 3,
        background: '#f4f4f0',
      },
    })
      .composite(composites)
      .png()
      .toBuffer();
    await sharp(image).toFile(`${output}/browser-${product.name}.png`);
    // The photographed side up close, side by side: the photo, the model's own colours, the photo's colours.
    const crop = async (key: string) => {
      const shot = result.shots[key];
      return shot
        ? sharp(Buffer.from(shot, 'base64')).flatten({ background: '#f4f4f0' }).resize(600, 600).toBuffer()
        : undefined;
    };
    const parts = [
      await sharp(product.photo)
        .flatten({ background: '#f4f4f0' })
        .resize(600, 600, { fit: 'contain', background: '#f4f4f0' })
        .toBuffer(),
      await crop('mixed-plain-0'),
      await crop('mixed-photo-0'),
    ].filter((p) => !!p) as Buffer[];
    await sharp({ create: { width: 600 * parts.length, height: 600, channels: 3, background: '#f4f4f0' } })
      .composite(parts.map((input, i) => ({ input, left: i * 600, top: 0 })))
      .png()
      .toFile(`${output}/front-${product.name}.png`);
    sheets.push({ name: product.name, image });
    metrics.push({ name: product.name, paintMs: result.paintMs, setupMs: result.setup, ...result.summary });
    console.log(
      product.name.padEnd(18),
      JSON.stringify({ paintMs: result.paintMs, ...result.summary, setupMs: result.setup }),
    );
  }
  assert.deepEqual(errors, [], errors.join('\n'));
} finally {
  await browser.close();
}
writeFileSync(`${output}/metrics-browser.json`, JSON.stringify(metrics, null, 2));
if (sheets.length > 1) {
  const metadata = await sharp(sheets[0].image).metadata();
  await sharp({
    create: {
      width: metadata.width!,
      height: metadata.height! * sheets.length,
      channels: 3,
      background: '#f4f4f0',
    },
  })
    .composite(sheets.map((sheet, i) => ({ input: sheet.image, left: 0, top: i * metadata.height! })))
    .png()
    .toFile(`${output}/browser-all.png`);
}
