/**
 * Real-WebGL and real-number check of fitting a one-photo model to its product (src/lib/product3d/fit.ts):
 * the real size, the mirror symmetry with the front, and the edge-keeping smoothing, on the saved
 * TripoSR meshes of real products (test-results/product3d-batch, no new AI run: the bear toilet
 * photographed from three sizes, and the eight products of the batch).
 *
 * For each mesh three rows of four directions (0°, 90°, 180°, 270° around the product; 0° is the front once
 * a fit has turned it, the photo's own side before) go side by side to test-results/product3d-fit/:
 *   before        the mesh as made (the pose stands it upright)
 *   fit           the fit the editor starts a new model with (real size when it agrees with the photo,
 *                 mirror evening-out for toilets, basins and baths)
 *   fit + edges   every part on (mirror evening-out whatever the product) and the edge-keeping smoothing
 * and the numbers to metrics.json: proportions against the typed size, the mirror error, the bumpiness
 * of the surface, the number of sharp-edged vertices, the volume, and the times.
 *
 * The sizes are typical catalogue sizes of such products (the real materials are not known here).
 *
 * Usage: node tests/run-browser-test.mjs tests/product3d-fit-browser.ts [--gpu]
 *   MESH=bear-a-original-500,07-stool   only these
 *   OUT=test-results/xx                 another output folder
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp, { type OverlayOptions } from 'sharp';

const gpu = process.argv.includes('--gpu');
const output = process.env.OUT ?? 'test-results/product3d-fit';
const meshRoot = 'test-results/product3d-batch';
type Size = { widthMm: number; depthMm: number; heightMm: number };
const products: Record<string, { size: Size; symmetricKind: boolean }> = {
  'bear-a-original-500': { size: { widthMm: 360, depthMm: 700, heightMm: 780 }, symmetricKind: true },
  'bear-b-upscaled-1000': { size: { widthMm: 360, depthMm: 700, heightMm: 780 }, symmetricKind: true },
  'bear-c-crop-1000': { size: { widthMm: 360, depthMm: 700, heightMm: 780 }, symmetricKind: true },
  '01-shelf': { size: { widthMm: 600, depthMm: 130, heightMm: 70 }, symmetricKind: false },
  '02-smart-toilet': { size: { widthMm: 400, depthMm: 650, heightMm: 500 }, symmetricKind: true },
  '03-bathtub-rect': { size: { widthMm: 1700, depthMm: 800, heightMm: 600 }, symmetricKind: true },
  '04-bathtub-scene': { size: { widthMm: 1700, depthMm: 800, heightMm: 600 }, symmetricKind: true },
  '05-bathtub-top': { size: { widthMm: 1600, depthMm: 750, heightMm: 580 }, symmetricKind: true },
  '06-paper-holder': { size: { widthMm: 280, depthMm: 200, heightMm: 750 }, symmetricKind: false },
  '07-stool': { size: { widthMm: 430, depthMm: 330, heightMm: 440 }, symmetricKind: false },
  '08-mirror': { size: { widthMm: 600, depthMm: 40, heightMm: 600 }, symmetricKind: false },
};
const names = (process.env.MESH ? process.env.MESH.split(',') : Object.keys(products)).filter((name) => {
  const found = existsSync(`${meshRoot}/${name}/mesh-positions.bin`) && name in products;
  if (!found) console.log(`${name}: no mesh in ${meshRoot}, skipped`);
  return found;
});
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    contents: `export {ProductRenderer} from './src/lib/product3d/renderer';
export {createDefaultPose} from './src/lib/product3d/pose';
export {estimateUprightQuaternion} from './src/lib/product3d/upright';
export {estimateProductFit, startingFit, buildFit, fitProductMesh, sizeMismatch} from './src/lib/product3d/fit';
export {estimateSymmetry} from './src/lib/product3d/symmetry';
export {bilateralSmooth, bumpiness, sharpVertexCount, meshVolume, surfaceRoughness} from './src/lib/product3d/mesh-cleanup';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'P',
  logLevel: 'error',
});
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: gpu
    ? ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu']
    : ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const rows = ['before', 'fit', 'fit + edges'];
const azimuths = [0, 90, 180, 270];
const tile = 300,
  label = 22;
const caption = (text: string) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${tile}" height="${label}"><rect width="100%" height="100%" fill="#e6e6e0"/><text x="6" y="16" font-family="sans-serif" font-size="13" fill="#222">${text}</text></svg>`,
  );
type Metrics = {
  ratio: number[];
  mirror: number | null;
  bump: number;
  rough: number;
  sharp35: number;
  sharp60: number;
  volume: number;
  ms?: number;
};
const report: Record<string, unknown> = {};
const sheets: Buffer[] = [];
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setContent('<body></body>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  for (const name of names) {
    const dir = `${meshRoot}/${name}/`;
    const b64 = (file: string) => readFileSync(dir + file).toString('base64');
    const { size, symmetricKind } = products[name];
    const result = await page.evaluate(
      async (data) => {
        type Mesh = { positions: Float32Array; colors: Float32Array; indices: Uint32Array };
        const lib = (window as unknown as { P: any }).P; // eslint-disable-line @typescript-eslint/no-explicit-any
        const decode = (s: string) => {
          const bin = atob(s);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return bytes.buffer;
        };
        const mesh: Mesh = {
          positions: new Float32Array(decode(data.p)),
          colors: new Float32Array(decode(data.c)),
          indices: new Uint32Array(decode(data.i)),
        };
        const upright: [number, number, number, number] = lib.estimateUprightQuaternion(mesh.positions);
        let started = performance.now();
        const estimate = lib.estimateProductFit(mesh, upright, { size: data.size, mirror: true });
        const searchMs = performance.now() - started;
        const start = lib.startingFit(mesh, estimate, { size: data.size, symmetricKind: data.symmetricKind });
        started = performance.now();
        const fitted: Mesh = start.fit ? lib.fitProductMesh(mesh, start.fit, data.size) : mesh;
        const fitMs = performance.now() - started;
        // Every part on, and the edge-keeping smoothing first (the order of the real pipeline).
        const all = lib.buildFit(estimate, {
          size: !!start.fit?.size || !start.ask,
          mirror: true,
          flip: false,
        });
        started = performance.now();
        const smooth: Mesh = {
          ...mesh,
          positions: lib.bilateralSmooth(mesh.positions, mesh.indices, { normalRounds: 6, fitRounds: 20 }),
        };
        const smoothMs = performance.now() - started;
        const full: Mesh = all ? lib.fitProductMesh(smooth, all, data.size) : smooth;
        const measure = (m: Mesh, base: Mesh, applied: boolean): Metrics => {
          // The mesh as the standing pose sees it: the trimmed size along the front, left-right and up.
          const q = upright;
          const [x, y, z, w] = q;
          const rot = (px: number, py: number, pz: number) => {
            const tx = 2 * (y * pz - z * py),
              ty = 2 * (z * px - x * pz),
              tz = 2 * (x * py - y * px);
            return [
              px + w * tx + (y * tz - z * ty),
              py + w * ty + (z * tx - x * tz),
              pz + w * tz + (x * ty - y * tx),
            ];
          };
          const axes: number[][] = [[], [], []];
          const standing = new Float32Array(m.positions.length);
          for (let i = 0; i < m.positions.length; i += 3) {
            const r = rot(m.positions[i], m.positions[i + 1], m.positions[i + 2]);
            standing.set(r, i);
            for (let k = 0; k < 3; k++) axes[k].push(r[k]);
          }
          void applied;
          const extent = axes.map((a) => {
            a.sort((p, q2) => p - q2);
            const trim = Math.floor(a.length * 0.001);
            return a[a.length - 1 - trim] - a[trim];
          });
          const turned = applied && start.fit ? 0 : 0;
          void turned;
          const relaxed = lib.estimateSymmetry(standing, { maxError: 1, minDominance: 0 });
          return {
            ratio: extent,
            mirror: relaxed ? relaxed.error : null,
            bump: lib.bumpiness(m.positions, m.indices),
            rough: lib.surfaceRoughness(m.positions, m.indices),
            sharp35: lib.sharpVertexCount(m.positions, m.indices, 35),
            sharp60: lib.sharpVertexCount(m.positions, m.indices, 60),
            volume: lib.meshVolume(m.positions, m.indices) / lib.meshVolume(base.positions, base.indices),
          };
        };
        const metrics = {
          before: measure(mesh, mesh, false),
          fit: measure(fitted, mesh, true),
          full: measure(full, mesh, true),
        };
        const toBase64 = (blob: Blob) =>
          new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1]);
            reader.readAsDataURL(blob);
          });
        const base = lib.createDefaultPose().cameraQuaternion as number[];
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
        for (const [label, m] of [
          ['before', mesh],
          ['fit', fitted],
          ['fit + edges', full],
        ] as [string, Mesh][]) {
          const canvas = document.createElement('canvas');
          document.body.append(canvas);
          const renderer = new lib.ProductRenderer(canvas, m);
          renderer.resize(512, 512, 1);
          renderer.setShading('mixed');
          for (const azimuth of data.azimuths) {
            renderer.setPose({
              ...lib.createDefaultPose(),
              objectQuaternion: upright,
              cameraQuaternion: turn(azimuth),
            });
            shots[`${label}-${azimuth}`] = await toBase64((await renderer.capture()).blob);
          }
          renderer.dispose?.();
          canvas.remove();
        }
        return {
          shots,
          metrics,
          estimate: {
            symmetric: estimate.symmetric,
            uncertainFront: estimate.uncertainFront,
            front: estimate.fit.front,
            mirrorError: estimate.mirrorError ?? null,
          },
          start: { size: !!start.fit?.size, mirror: start.fit?.mirror !== undefined, ask: start.ask ?? null },
          times: { searchMs, fitMs, smoothMs },
        };
      },
      {
        p: b64('mesh-positions.bin'),
        c: b64('mesh-colors.bin'),
        i: b64('mesh-indices.bin'),
        size,
        symmetricKind,
        azimuths,
      },
    );
    const composites: OverlayOptions[] = [];
    for (const [row, label_] of rows.entries())
      for (const [column, azimuth] of azimuths.entries()) {
        const left = column * tile,
          top = row * (tile + label);
        composites.push({
          input: await sharp(Buffer.from(result.shots[`${label_}-${azimuth}`], 'base64'))
            .flatten({ background: '#f4f4f0' })
            .resize(tile, tile)
            .toBuffer(),
          left,
          top: top + label,
        });
        composites.push({ input: caption(`${name} · ${label_} · ${azimuth}°`), left, top });
      }
    const image = await sharp({
      create: { width: tile * 4, height: (tile + label) * rows.length, channels: 3, background: '#f4f4f0' },
    })
      .composite(composites)
      .png()
      .toBuffer();
    await sharp(image).toFile(`${output}/sheet-${name}.png`);
    sheets.push(image);
    // Proportions in the standing frame against the typed size (the front axis is x only after a fit).
    const m = result.metrics;
    const wanted = [size.depthMm, size.widthMm, size.heightMm];
    const shape = (e: number[]) => e.map((value, i) => value / e[2] / (wanted[i] / wanted[2]));
    report[name] = { ...result, shapeVsSize: { before: shape(m.before.ratio), fit: shape(m.fit.ratio) } };
    const p = (n: number) => n.toFixed(3);
    console.log(
      `${name.padEnd(20)} ${result.estimate.symmetric ? `front ${result.estimate.front.toFixed(0).padStart(4)}°${result.estimate.uncertainFront ? '?' : ' '}` : 'no mirror plane  '}` +
        ` | d/w/h vs size before ${shape(m.before.ratio).map(p).join(' ')} → fit ${shape(m.fit.ratio).map(p).join(' ')}` +
        ` | mirror ${m.before.mirror === null ? '-' : (m.before.mirror * 100).toFixed(2)}% → ${m.full.mirror === null ? '-' : (m.full.mirror * 100).toFixed(2)}%` +
        ` | bump ${(m.full.bump / m.before.bump).toFixed(2)} rough ${(m.full.rough / m.before.rough).toFixed(2)} sharp60 ${(m.full.sharp60 / Math.max(1, m.before.sharp60)).toFixed(2)} vol ${m.full.volume.toFixed(3)}` +
        ` | ${Math.round(result.times.searchMs)}+${Math.round(result.times.fitMs)}+${Math.round(result.times.smoothMs)} ms`,
    );
    // After the fit the proportions are the typed size's to 2%, wherever a size was applied.
    if (result.start.size)
      for (const value of shape(m.fit.ratio))
        assert.ok(Math.abs(value - 1) < 0.02, `${name}: proportions ${shape(m.fit.ratio)}`);
    // Where the edge-keeping smoothing ran, the volume stays within 5%.
    assert.ok(Math.abs(m.full.volume - 1) < 0.05, `${name}: volume ${m.full.volume}`);
  }
  assert.deepEqual(errors, [], errors.join('\n'));
} finally {
  await browser.close();
}
await writeFile(`${output}/metrics.json`, JSON.stringify(report, null, 2));
if (sheets.length > 1) {
  const metadata = await sharp(sheets[0]).metadata();
  await sharp({
    create: {
      width: metadata.width!,
      height: metadata.height! * sheets.length,
      channels: 3,
      background: '#f4f4f0',
    },
  })
    .composite(sheets.map((input, i) => ({ input, left: 0, top: i * metadata.height! })))
    .png()
    .toFile(`${output}/sheet-all.png`);
  console.log('all products:', `${output}/sheet-all.png`);
}
