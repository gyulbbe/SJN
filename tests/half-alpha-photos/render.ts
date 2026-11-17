/**
 * Half-transparent product photos in the 3D room (docs/half-alpha-photos-20261117.md): LAUCHE LC-2100
 * (side photos 58% half transparent) and 반스 G71L (46%) drawn by the room viewer as the AI export
 * captures them, from the front (0°) and the right (90°). No AI call, no server: the 2026-11-02 public
 * catalogue snapshot only.
 *
 * Usage: node tests/run-browser-test.mjs tests/half-alpha-photos/render.ts <label> [--gpu]
 * Output: test-results/half-alpha-photos-20261117/<label>-<scene>.png (this checkout, git-ignored)
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import type { PublicRecord, SceneSpec } from '../export-photoreal/scene-builder';
import { SNAPSHOT } from '../tile-ai/paths.mjs';

// process.argv: node, run-browser-test.mjs, this file, then this script's own arguments.
const label = process.argv.slice(3).find((a) => !a.startsWith('--')) ?? 'now';
const gpu = process.argv.includes('--gpu');
const OUT = resolve('test-results', 'half-alpha-photos-20261117');
mkdirSync(OUT, { recursive: true });

type Record_ = PublicRecord & { materialId: string; name: string };
const catalog = JSON.parse(readFileSync(join(SNAPSHOT as string, 'catalog.json'), 'utf8')) as {
  placements: Record_[];
};
const files = Object.fromEntries(
  readdirSync(join(SNAPSHOT as string, 'images')).map((f) => [f, join(SNAPSHOT as string, 'images', f)]),
);
const imageFiles = Object.fromEntries(Object.keys(files).map((f) => [f.replace(/\.[a-z]+$/, ''), f]));
const byPrefix = (prefix: string) => {
  const found = catalog.placements.find((p) => p.materialId.startsWith(prefix));
  if (!found) throw new Error(`스냅샷에 ${prefix} 제품이 없어요.`);
  return found.materialId;
};

const toilet = byPrefix('d841bc75'); // LAUCHE 아크 투피스 LC-2100 양변기
const basin = byPrefix('16890f7c'); // LAUCHE 반스 G71L 세면대
const scene = (id: string, azimuth: number): SceneSpec => ({
  id,
  label: id,
  room: { widthMm: 2400, depthMm: 2400, heightMm: 2400 },
  wall: '630d6290-9ec9-4027-97d7-ce0001ba3c8d', // DWJ 9854, white 600 × 300
  floor: '591b59df-0c9c-473b-bd86-4a78a8d67050', // FOR-GRIGIO, grey stone 600 × 600
  products: [
    { id: 'photo-basin', materialId: basin, face: 'left', u: 0.4, v: 0.62 },
    { id: 'photo-toilet', materialId: toilet, face: 'floor', u: 0.72, v: 0.2 },
  ],
  azimuth,
});
const SPECS = [scene('front', 0), scene('right', 90)];

const bundle = await build({
  stdin: {
    contents: [
      "export * from './src/lib/room-viewer/renderer';",
      "export { buildSpecScene } from './tests/export-photoreal/scene-builder';",
      "export { fluxOrbitView, FLUX_BACKDROP } from './src/lib/ai-export/view';",
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
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/images/'))
      return route.fulfill({ body: readFileSync(files[decodeURIComponent(path.slice(8))]) });
    return route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' });
  });
  await page.goto(`${ORIGIN}/`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate((files) => {
    (window as unknown as { IMAGE_FILES: Record<string, string> }).IMAGE_FILES = files;
  }, imageFiles);
  for (const spec of SPECS) {
    const ids = [spec.wall, spec.floor, ...(spec.products ?? []).map((p) => p.materialId)];
    const used = Object.fromEntries(
      ids.map((m) => [m, catalog.placements.find((p) => p.materialId === m) as PublicRecord]),
    );
    const png = await page.evaluate(
      async ({ spec, used }) => {
        type Lib = typeof import('../../src/lib/room-viewer/renderer') &
          typeof import('../export-photoreal/scene-builder') &
          typeof import('../../src/lib/ai-export/view');
        const lib = (window as unknown as { Lib: Lib }).Lib;
        const built = await lib.buildSpecScene(spec, used);
        const viewer = new lib.RoomViewerRenderer();
        try {
          await viewer.setSnapshot(built.snapshot, async (id: string) => built.assets[id], {
            background: lib.FLUX_BACKDROP,
          });
          const view = lib.fluxOrbitView({ azimuth: spec.azimuth, elevation: 0 });
          const blob = await viewer.export(view, { format: 'png', mode: 'after', longEdge: 1024 });
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let text = '';
          for (let i = 0; i < bytes.length; i += 0x8000)
            text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return btoa(text);
        } finally {
          viewer.dispose();
        }
      },
      { spec, used },
    );
    if (errors.length) throw new Error(errors.join('\n'));
    const file = join(OUT, `${label}-${spec.id}.png`);
    writeFileSync(file, Buffer.from(png, 'base64'));
    console.log(file);
  }
} finally {
  await browser.close();
}
