/**
 * The photo light is one rule on every render path: with RenderSnapshot.lighting = m, the 2D
 * compositor and the 3D viewer (export; the live frame uses the same composite shader) show the unlit image multiplied by m in
 * linear RGB before the user's colour adjustment. Without it, nothing changes. No AI call.
 *
 * Usage: node tests/run-browser-test.mjs tests/photo-lighting-render-browser.ts
 */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/room-viewer/renderer';export * from './src/lib/room-viewer/view-state';export {PhotoCompositor} from './src/lib/render/compositor';export {buildRealismScene} from './tests/helpers/export-realism-scene';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'Paths',
});
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu'],
});
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('http://127.0.0.1:43216/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }),
  );
  await page.goto('http://127.0.0.1:43216/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    type Lib = typeof import('../src/lib/room-viewer/renderer') &
      typeof import('../src/lib/room-viewer/view-state') &
      typeof import('../src/lib/render/compositor') &
      typeof import('./helpers/export-realism-scene');
    const lib = (window as unknown as { Paths: Lib }).Paths;
    const { assets, snapshot } = await lib.buildRealismScene();
    const reader = async (id: string) => assets[id];
    const m: [number, number, number] = [0.62, 0.55, 0.47];
    const decode = (v: number) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const encode = (v: number) => {
      const c = Math.max(0, Math.min(1, v));
      return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
    };
    const pixels = async (blob: Blob) => {
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    // Largest difference between lit and the unlit image multiplied on the CPU (8-bit steps).
    const compare = (unlit: Uint8ClampedArray, lit: Uint8ClampedArray, skip?: (i: number) => boolean) => {
      let worst = 0,
        mean = 0,
        n = 0;
      for (let i = 0; i < unlit.length; i += 4) {
        if (skip?.(i)) continue;
        for (let c = 0; c < 3; c++) {
          const d = Math.abs(encode(decode(unlit[i + c]) * m[c]) - lit[i + c]);
          worst = Math.max(worst, d);
          mean += d;
          n++;
        }
      }
      return { worst: +worst.toFixed(1), mean: +(mean / n).toFixed(3) };
    };
    const same = (a: Uint8ClampedArray, b: Uint8ClampedArray) => a.every((v, i) => v === b[i]);
    const out: Record<string, unknown> = {};
    // 2D compositor (export).
    {
      const compositor = new lib.PhotoCompositor();
      try {
        // The 2D compositor draws over the room image: a mid-grey stand-in.
        const canvas = document.createElement('canvas');
        canvas.width = 900;
        canvas.height = 600;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#9a9690';
        ctx.fillRect(0, 0, 900, 600);
        const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!)));
        assets.room = {
          ...assets.wall,
          id: 'room',
          name: 'room',
          kind: 'original',
          blob,
          size: blob.size,
          width: 900,
          height: 600,
        };
        const scene = {
          ...snapshot.scene,
          originalAssetId: 'room',
          previewAssetId: 'room',
          imageWidth: 900,
          imageHeight: 600,
        };
        const base = { ...snapshot, scene, beforeScene: scene };
        await compositor.setSnapshot(base, reader);
        const unlit = await pixels(await compositor.exportImage(base, 1024, 1024, 'image/png', false));
        const lit = await pixels(
          await compositor.exportImage({ ...base, lighting: m }, 1024, 1024, 'image/png', false),
        );
        const again = await pixels(await compositor.exportImage(base, 1024, 1024, 'image/png', false));
        out.compositor = { ...compare(unlit, lit), unchangedWithout: same(unlit, again) };
      } finally {
        compositor.dispose();
      }
    }
    // 3D viewer export; the grey margin around the room is not lit.
    {
      const viewer = new lib.RoomViewerRenderer();
      try {
        const view = lib.defaultRoomView();
        await viewer.setSnapshot(snapshot, reader);
        const unlit = await pixels(
          await viewer.export(view, { format: 'png', mode: 'after', longEdge: 1024 }),
        );
        await viewer.setSnapshot({ ...snapshot, lighting: m }, reader);
        const lit = await pixels(await viewer.export(view, { format: 'png', mode: 'after', longEdge: 1024 }));
        const margin = (i: number) => unlit[i] === 232 && unlit[i + 1] === 232 && unlit[i + 2] === 228;
        out.viewerExport = compare(unlit, lit, margin);
        await viewer.setSnapshot(snapshot, reader);
        const again = await pixels(
          await viewer.export(view, { format: 'png', mode: 'after', longEdge: 1024 }),
        );
        out.viewerUnchangedWithout = same(unlit, again);
      } finally {
        viewer.dispose();
      }
    }
    return out;
  });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify(result, null, 2));
  const compositor = result.compositor as { worst: number; mean: number; unchangedWithout: boolean };
  const viewer = result.viewerExport as { worst: number; mean: number };
  // The shader multiplies before 8-bit rounding; the CPU copy after: one or two steps apart.
  assert.ok(compositor.worst <= 2.5 && compositor.mean < 0.8, JSON.stringify(compositor));
  assert.ok(viewer.worst <= 2.5 && viewer.mean < 0.8, JSON.stringify(viewer));
  assert.equal(compositor.unchangedWithout, true);
  assert.equal(result.viewerUnchangedWithout, true);
} finally {
  await browser.close();
}
