/**
 * Real-WebGL comparison of the three view modes ("원본 색" baked / "조명 보정" lit / "혼합" mixed) on
 * the eight saved TripoSR meshes (test-results/product3d-batch, no new AI run): each product seen from
 * 0°, 90°, 180° and 270° around the photo's direction (0° is the photographed side), one row per
 * mode, one sheet per product and one with all of them, in test-results/product3d-mixed/.
 * The same renderer code the editor, the PNG capture and the room use draws all three.
 *
 * Usage: node tests/run-browser-test.mjs tests/product3d-mixed-browser.ts [--gpu]
 *   MESH=02-smart-toilet,07-stool   only these products
 *   OUT=test-results/xx             another output folder (tuning runs)
 *   MODES=mixed                     only these rows (baked, lit, mixed)
 *   MESH_ROOT=test-results/xx       the folder holding the mesh folders (default: the real-product batch)
 *   TUNE='{"detail":0.04}'          overrides of MIXED (src/lib/product3d/mixed-color.ts) for a trial
 */
import { chromium } from '@playwright/test';
import { build, type Plugin } from 'esbuild';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp, { type OverlayOptions } from 'sharp';

const gpu = process.argv.includes('--gpu');
const output = process.env.OUT ?? 'test-results/product3d-mixed';
const meshRoot = process.env.MESH_ROOT ?? 'test-results/product3d-batch';
const all = [
  '01-shelf',
  '02-smart-toilet',
  '03-bathtub-rect',
  '04-bathtub-scene',
  '05-bathtub-top',
  '06-paper-holder',
  '07-stool',
  '08-mirror',
];
const names = (process.env.MESH ? process.env.MESH.split(',') : all).filter((name) => {
  const found = existsSync(`${meshRoot}/${name}/mesh-positions.bin`);
  if (!found) console.log(`${name}: no mesh in ${meshRoot}, skipped`);
  return found;
});
await mkdir(output, { recursive: true });
const tune = (json: string): Plugin => ({
  name: 'mixed-tuning',
  setup(b) {
    b.onLoad({ filter: /product3d[\\/]mixed-color\.ts$/ }, async (args) => ({
      contents: `${await readFile(args.path, 'utf8')}\nObject.assign(MIXED, ${json});`,
      loader: 'ts',
    }));
  },
});
const bundle = await build({
  stdin: {
    contents: `export {ProductRenderer} from './src/lib/product3d/renderer';export {createDefaultPose} from './src/lib/product3d/pose';export {estimateUprightQuaternion} from './src/lib/product3d/upright';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'P',
  plugins: process.env.TUNE ? [tune(process.env.TUNE)] : [],
});
const modes = (process.env.MODES ?? 'baked,lit,mixed').split(',');
// The colour calculation as the page runs it: the surface Worker (src/lib/product3d/surface-worker.ts).
const worker = await build({
  entryPoints: ['src/lib/product3d/surface-worker.ts'],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  plugins: process.env.TUNE ? [tune(process.env.TUNE)] : [],
});
const azimuths = [0, 90, 180, 270];
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
const sheets: { name: string; image: Buffer; setupMs: Record<string, number> }[] = [];
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setContent('<body></body>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  for (const name of names) {
    const dir = `${meshRoot}/${name}/`;
    const b64 = (file: string) => readFileSync(dir + file).toString('base64');
    const { shots, setupMs, workerMs } = await page.evaluate(
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
        const P = (
          window as unknown as {
            P: {
              ProductRenderer: new (
                canvas: HTMLCanvasElement,
                mesh: { positions: Float32Array; colors: Float32Array; indices: Uint32Array },
              ) => {
                resize: (w: number, h: number, ratio: number) => void;
                setShading: (mode: string) => void;
                setPose: (pose: unknown) => void;
                capture: () => Promise<{ blob: Blob }>;
                dispose?: () => void;
              };
              createDefaultPose: () => { cameraQuaternion: number[] };
              estimateUprightQuaternion: (positions: Float32Array) => number[];
            };
          }
        ).P;
        const canvas = document.createElement('canvas');
        document.body.append(canvas);
        const renderer = new P.ProductRenderer(canvas, { positions, colors, indices });
        renderer.resize(512, 512, 1);
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
        const toBase64 = (blob: Blob) =>
          new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1]);
            reader.readAsDataURL(blob);
          });
        // Each lit mode in a real Web Worker, from the message to the colours (copy in, transfer out).
        const workerTimes: Record<string, number> = {};
        const workerUrl = URL.createObjectURL(new Blob([data.worker], { type: 'text/javascript' }));
        for (const mode of data.modes.filter((m) => m !== 'baked')) {
          const started = performance.now();
          await new Promise<void>((resolve, reject) => {
            const job = new Worker(workerUrl);
            job.onmessage = (event: MessageEvent<{ error?: string }>) => {
              job.terminate();
              if (event.data.error) reject(new Error(event.data.error));
              else resolve();
            };
            job.onerror = (event) => reject(new Error(event.message));
            job.postMessage({ id: 1, mode, mesh: { positions, colors, indices } });
          });
          workerTimes[mode] = Math.round(performance.now() - started);
        }
        URL.revokeObjectURL(workerUrl);
        const out: Record<string, string> = {};
        const times: Record<string, number> = {};
        for (const mode of data.modes) {
          const started = performance.now();
          renderer.setShading(mode);
          times[mode] = Math.round(performance.now() - started);
          for (const azimuth of data.azimuths) {
            renderer.setPose({
              ...P.createDefaultPose(),
              objectQuaternion: up,
              cameraQuaternion: turn(azimuth),
            });
            out[`${mode}-${azimuth}`] = await toBase64((await renderer.capture()).blob);
          }
        }
        return { shots: out, setupMs: times, workerMs: workerTimes };
      },
      {
        p: b64('mesh-positions.bin'),
        c: b64('mesh-colors.bin'),
        i: b64('mesh-indices.bin'),
        modes,
        azimuths,
        worker: worker.outputFiles[0].text,
      },
    );
    const composites: OverlayOptions[] = [];
    for (const [row, mode] of modes.entries())
      for (const [column, azimuth] of azimuths.entries()) {
        const left = column * tile,
          top = row * (tile + label);
        composites.push({
          input: await sharp(Buffer.from(shots[`${mode}-${azimuth}`], 'base64'))
            .flatten({ background: '#f4f4f0' })
            .resize(tile, tile)
            .toBuffer(),
          left,
          top: top + label,
        });
        composites.push({
          input: caption(
            `${name} · ${mode} · ${azimuth}°${mode === 'baked' ? '' : ` (set up ${setupMs[mode]} ms)`}`,
          ),
          left,
          top,
        });
      }
    const image = await sharp({
      create: {
        width: tile * azimuths.length,
        height: (tile + label) * modes.length,
        channels: 3,
        background: '#f4f4f0',
      },
    })
      .composite(composites)
      .png()
      .toBuffer();
    await sharp(image).toFile(`${output}/sheet-${name}.png`);
    sheets.push({ name, image, setupMs });
    const vertices = readFileSync(`${dir}mesh-positions.bin`).length / 12;
    console.log(
      `${name.padEnd(18)} ${String(vertices).padStart(7)} vertices; in the page (ms): ${JSON.stringify(setupMs)}; in a Worker (ms): ${JSON.stringify(workerMs)} → ${output}/sheet-${name}.png`,
    );
    // A few seconds at most, even for the biggest mesh (about 400k vertices).
    for (const [mode, ms] of Object.entries(workerMs))
      assert.ok(ms < 8000, `${name} ${mode}: ${ms} ms in a Worker`);
  }
  assert.deepEqual(errors, [], errors.join('\n'));
} finally {
  await browser.close();
}
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
    .toFile(`${output}/sheet-all.png`);
  console.log('all products:', `${output}/sheet-all.png`);
}
