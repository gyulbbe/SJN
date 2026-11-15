/**
 * The photo-product trial's empty-room layers (no AI call, docs/photo-products-20261115.md): for each
 * scene, the same frame as its capture with the fixtures hidden and their shadows kept
 * (RoomViewerRenderer.exportLayers `shadowed`) and the region mask with the fixtures hidden, so the
 * walls and floor behind the render's fixtures are known.
 *
 * Usage: node tests/run-browser-test.mjs tests/photo-products/behind.ts [--holdout] [--gpu]
 * Also the composite export's layers (full, empty, coverage) and its model input (the empty room as
 * prepareFluxImage makes it), for the empty-room method (experiment A on these scenes).
 * Output: test-results/photo-products-20261115/behind/<scene>/{behind,mask-behind,full,empty,coverage,
 *   input-empty}.png, regions-behind.json
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import sharp from 'sharp';
import type { PublicRecord, SceneSpec } from '../export-photoreal/scene-builder';
import { SNAPSHOT } from '../tile-ai/paths.mjs';
import { OUT, PHOTOS_SCENE } from './paths.mjs';
import { resolveSpecs } from './specs';

const gpu = process.argv.includes('--gpu');
const holdout = process.argv.includes('--holdout');
const only = (() => {
  const i = process.argv.indexOf('--only');
  return i > 0 ? new Set(process.argv[i + 1].split(',')) : undefined;
})();

const catalog = JSON.parse(readFileSync(join(SNAPSHOT as string, 'catalog.json'), 'utf8')) as {
  placements: (PublicRecord & { materialId: string })[];
};
const records: Record<string, PublicRecord> = Object.fromEntries(
  catalog.placements.map((p) => [p.materialId, p]),
);
const PHOTOS = JSON.parse(readFileSync(join(PHOTOS_SCENE as string, 'spec.json'), 'utf8')) as SceneSpec;
const SPECS = [
  ...(holdout ? [] : [PHOTOS]),
  ...resolveSpecs(catalog.placements.map((p) => p.materialId)).filter((spec) => !!spec.holdout === holdout),
];
const imageFiles = Object.fromEntries(
  readdirSync(join(SNAPSHOT as string, 'images')).map((f) => [f.replace(/\.[a-z]+$/, ''), f]),
);
const bundle = await build({
  stdin: {
    contents: [
      "export * from './src/lib/room-viewer/renderer';",
      "export { buildSpecScene } from './tests/export-photoreal/scene-builder';",
      "export { buildFluxGrounding, visibleCeiling, visibleWalls } from './src/lib/ai-export/scene';",
      "export { fluxInputLayout } from './src/lib/ai-export/contract';",
      "export { prepareFluxImage, fluxCheckScene } from './src/lib/ai-export/client';",
      "export { buildFluxPrompt } from './src/lib/ai-export/prompt';",
      "export { fluxSceneSchema } from './src/lib/ai-export/scene-contract';",
      "export { fluxOrbitView, FLUX_BACKDROP } from './src/lib/ai-export/view';",
      "export { VIEWER_CEILING_COLOR } from './src/lib/room-viewer/ceiling';",
      "export { inputPxPerMm, widenedJointMm, widenJoints } from './src/lib/ai-export/joints';",
    ].join(''),
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'Lib',
});
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: gpu
    ? ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu']
    : ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const ORIGIN = 'http://127.0.0.1:43247';
const summary: Record<string, unknown> = {};
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/images/'))
      return route.fulfill({
        body: readFileSync(join(SNAPSHOT as string, 'images', decodeURIComponent(path.slice(8)))),
      });
    return route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' });
  });
  await page.goto(`${ORIGIN}/`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate((files) => {
    (window as unknown as { IMAGE_FILES: Record<string, string> }).IMAGE_FILES = files;
  }, imageFiles);
  for (const spec of SPECS) {
    if (only && !only.has(spec.id)) continue;
    const needed = new Set([
      spec.wall,
      spec.floor,
      ...(spec.regions ?? []).map((r) => r.materialId),
      ...(spec.products ?? []).map((p) => p.materialId),
    ]);
    const used = Object.fromEntries([...needed].map((m) => [m, records[m]]));
    const started = Date.now();
    const r = await page.evaluate(
      async ({ spec, used }) => {
        type Lib = typeof import('../../src/lib/room-viewer/renderer') &
          typeof import('../export-photoreal/scene-builder') &
          typeof import('../../src/lib/ai-export/scene') &
          typeof import('../../src/lib/ai-export/contract') &
          typeof import('../../src/lib/ai-export/client') &
          typeof import('../../src/lib/ai-export/prompt') &
          typeof import('../../src/lib/ai-export/scene-contract') &
          typeof import('../../src/lib/ai-export/view') &
          typeof import('../../src/lib/room-viewer/ceiling') &
          typeof import('../../src/lib/ai-export/joints');
        const lib = (window as unknown as { Lib: Lib }).Lib;
        const base64 = (bytes: Uint8Array) => {
          let text = '';
          for (let i = 0; i < bytes.length; i += 0x8000)
            text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return btoa(text);
        };
        const blob64 = async (blob: Blob) => base64(new Uint8Array(await blob.arrayBuffer()));
        const built = await lib.buildSpecScene(spec, used);
        const snapshot = built.snapshot;
        const reader = async (id: string) => built.assets[id];
        const { imageWidth: width, imageHeight: height } = snapshot.scene;
        const edge = Math.min(1024, Math.max(width, height));
        const view = lib.fluxOrbitView({ azimuth: spec.azimuth, elevation: 0 });
        const frame = {
          width: Math.min(edge, (edge * width) / height),
          height: Math.min(edge, (edge * height) / width),
        };
        const viewer = new lib.RoomViewerRenderer();
        try {
          await viewer.setSnapshot(snapshot, reader, { background: lib.FLUX_BACKDROP });
          const layers = viewer.exportLayers(view, { longEdge: edge });
          const canvas = document.createElement('canvas');
          canvas.width = layers.width;
          canvas.height = layers.height;
          const context = canvas.getContext('2d')!;
          context.putImageData(
            new ImageData(new Uint8ClampedArray(layers.shadowed), layers.width, layers.height),
            0,
            0,
          );
          const toPng = () => new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
          const behind = await toPng();
          const layerPng = async (data: Uint8ClampedArray) => {
            context.putImageData(
              new ImageData(new Uint8ClampedArray(data), layers.width, layers.height),
              0,
              0,
            );
            return toPng();
          };
          const full = await layerPng(layers.full);
          const empty = await layerPng(layers.empty);
          const coverageRgba = new Uint8ClampedArray(layers.width * layers.height * 4);
          for (let i = 0; i < layers.coverage.length; i++) {
            coverageRgba.set([layers.coverage[i], layers.coverage[i], layers.coverage[i], 255], i * 4);
          }
          const coverage = await layerPng(coverageRgba);
          // The trial hides the fixtures for the region mask (the app would ask the renderer for it).
          const prepared = (
            viewer as unknown as { prepared: { after: { fixtures: { group: { visible: boolean } } } } }
          ).prepared;
          prepared.after.fixtures.group.visible = false;
          const regions = viewer.regionMask(frame.width, frame.height, view);
          prepared.after.fixtures.group.visible = true;
          return {
            behind: await blob64(behind),
            full: await blob64(full),
            empty: await blob64(empty),
            coverage: await blob64(coverage),
            inputEmpty: await blob64(await lib.prepareFluxImage(empty)),
            size: { width: layers.width, height: layers.height },
            mask: { width: regions.width, height: regions.height, regions: regions.regions },
            maskData: base64(regions.data),
          };
        } finally {
          viewer.dispose();
        }
      },
      { spec, used },
    );
    if (errors.length) throw new Error(errors.join('\n'));
    const dir = join(OUT as string, 'behind', spec.id);
    mkdirSync(dir, { recursive: true });
    const buf = (b: string) => Buffer.from(b, 'base64');
    writeFileSync(join(dir, 'behind.png'), buf(r.behind));
    writeFileSync(join(dir, 'full.png'), buf(r.full));
    writeFileSync(join(dir, 'empty.png'), buf(r.empty));
    writeFileSync(join(dir, 'coverage.png'), buf(r.coverage));
    writeFileSync(join(dir, 'input-empty.png'), buf(r.inputEmpty));
    writeFileSync(join(dir, 'regions-behind.json'), JSON.stringify(r.mask));
    await sharp(buf(r.maskData), { raw: { width: r.mask.width, height: r.mask.height, channels: 1 } })
      .png()
      .toFile(join(dir, 'mask-behind.png'));
    summary[spec.id] = { size: r.size, regions: r.mask.regions.length, ms: Date.now() - started };
    console.log(spec.id, JSON.stringify(summary[spec.id]));
  }
} finally {
  await browser.close();
}
mkdirSync(OUT as string, { recursive: true });
writeFileSync(
  join(OUT as string, `behind-summary-${holdout ? 'holdout' : 'dev'}.json`),
  JSON.stringify({ gpu, summary }, null, 1),
);
