/**
 * Before/after captures for product 3D quality: node tests/run-browser-test.mjs tests/product3d-quality-browser.ts
 * Renders the real TripoSR toilet fixture (and, if exported by the real-AI e2e, the new-pipeline mesh)
 * with the application's ProductRenderer at front/45°/90°. Before = original RGB, no upright; after =
 * lighting correction + automatic upright. Writes PNGs and summary.json to test-results/product3d-quality.
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { meshVolume, surfaceRoughness } from '../src/lib/product3d/mesh-cleanup';

type QualityExports = typeof import('./helpers/product3d-capture');
const output = path.resolve('test-results/product3d-quality');
mkdirSync(output, { recursive: true });
const meshes = [
  {
    name: 'old-pipeline',
    dir: process.env.SJN_PRODUCT3D_MESH ?? 'test-results/front-alignment-toilet/photograph',
  },
  { name: 'new-pipeline', dir: path.join(output, 'new-mesh') },
].filter(({ dir }) => existsSync(path.join(dir, 'mesh-positions.bin')));
if (!meshes.length) throw new Error('No product mesh fixture found; see docs/product3d-editor.md.');

const load = (dir: string) => {
  const read = (field: string) => readFileSync(path.join(dir, `mesh-${field}.bin`));
  const buffer = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return {
    positions: new Float32Array(buffer(read('positions'))),
    indices: new Uint32Array(buffer(read('indices'))),
    colors: new Float32Array(buffer(read('colors'))),
    base64: Object.fromEntries(
      ['positions', 'indices', 'colors'].map((f) => [f, read(f).toString('base64')]),
    ),
  };
};

const bundle = await build({
  stdin: {
    contents: `export { blobToBase64, captureComparison } from './tests/helpers/product3d-capture';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'Quality',
  platform: 'browser',
});
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist'],
});
const summary: Record<string, unknown> = {};
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<html><body></body></html>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  for (const { name, dir } of meshes) {
    const mesh = load(dir);
    summary[name] = {
      vertices: mesh.positions.length / 3,
      triangles: mesh.indices.length / 3,
      roughness: Number(surfaceRoughness(mesh.positions, mesh.indices).toFixed(4)),
      volume: Number(meshVolume(mesh.positions, mesh.indices).toFixed(5)),
    };
    const shots = await page.evaluate(async (data) => {
      const { blobToBase64, captureComparison } = (window as unknown as { Quality: QualityExports }).Quality;
      const decode = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0)).buffer;
      const result = await captureComparison({
        positions: new Float32Array(decode(data.positions)),
        indices: new Uint32Array(decode(data.indices)),
        colors: new Float32Array(decode(data.colors)),
      });
      return {
        upright: result.upright,
        uprightMs: result.uprightMs,
        shots: await Promise.all(
          result.shots.map(async (shot) => ({ ...shot, png: await blobToBase64(shot.png) })),
        ),
      };
    }, mesh.base64);
    const tiles: Buffer[] = [];
    const luminance: Record<string, { mean: number; spread: number }> = {};
    for (const shot of shots.shots) {
      const file = path.join(output, `${name}-${shot.key}.png`);
      writeFileSync(file, Buffer.from(shot.png, 'base64'));
      tiles.push(await sharp(file).resize(320, 320).flatten({ background: '#f4f4f1' }).png().toBuffer());
      luminance[shot.key] = {
        mean: Number(shot.luminance.mean.toFixed(1)),
        spread: Number(shot.luminance.spread.toFixed(1)),
      };
    }
    // Two rows (before, after) × three columns (front, 45°, 90°).
    await sharp({ create: { width: 960, height: 640, channels: 3, background: '#ffffff' } })
      .composite(tiles.map((input, i) => ({ input, left: (i % 3) * 320, top: Math.floor(i / 3) * 320 })))
      .png()
      .toFile(path.join(output, `${name}-comparison.png`));
    Object.assign(summary[name] as object, {
      upright: shots.upright.map((v: number) => Number(v.toFixed(5))),
      uprightMs: Number(shots.uprightMs.toFixed(1)),
      luminance,
    });
  }
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await browser.close();
}
writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
