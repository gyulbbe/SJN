/**
 * The niche-look trial's pictures (no AI call, docs/niche-look-20261115.md): scenes with a niche drawn
 * by the app's 3D renderer in the AI capture's outside orbit (0°, 30°) and the editor's 3D view, with
 * the niche look of one variant (look-shim.ts stands in for src/lib/room-viewer/niche-look.ts).
 *
 *   node tests/run-browser-test.mjs tests/niche-look/render.ts --variant cur [--gpu]
 * Output: test-results/niche-look-20261115/<variant>[-gpu]/<scene>-<view>.png and -ms.json
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { build, type Plugin } from 'esbuild';
import type { PublicRecord } from '../export-photoreal/scene-builder';
import { SPECS as LEDGE_SPECS } from '../ledge-ai/specs';
import { SNAPSHOT } from '../tile-ai/paths.mjs';
import { OUT } from './paths.mjs';

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const variant = arg('variant', 'cur');
const gpu = process.argv.includes('--gpu');
const dir = join(OUT as string, variant + (gpu ? '-gpu' : ''));
mkdirSync(dir, { recursive: true });

// The ledge trial's scenes with a niche, and the same back-wall niche alone.
const structure = LEDGE_SPECS.find((s) => s.id === 'structure')!;
const busy = LEDGE_SPECS.find((s) => s.id === 'busy')!;
const SPECS = [
  structure,
  { ...structure, id: 'niche-only', features: structure.features!.filter((f) => f.kind === 'closed-niche') },
  busy,
];

const catalog = JSON.parse(readFileSync(join(SNAPSHOT as string, 'catalog.json'), 'utf8')) as {
  placements: (PublicRecord & { materialId: string })[];
};
const records = Object.fromEntries(catalog.placements.map((p) => [p.materialId, p]));
const imageFiles = Object.fromEntries(
  readdirSync(join(SNAPSHOT as string, 'images')).map((f) => [f.replace(/\.[a-z]+$/, ''), f]),
);
const shim = resolve('tests/niche-look/look-shim.ts');
const redirect: Plugin = {
  name: 'niche-look',
  setup(b) {
    b.onResolve({ filter: /niche-look$/ }, (args) => (args.importer === shim ? undefined : { path: shim }));
  },
};
const bundle = await build({
  stdin: {
    contents: [
      "export * from './src/lib/room-viewer/renderer';",
      "export { defaultRoomView } from './src/lib/room-viewer/view-state';",
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
  // `app` draws the app's own niche look (no stand-in).
  plugins: variant === 'app' ? [] : [redirect],
  define: { SJN_NICHE_VARIANT: JSON.stringify(variant) },
});
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: gpu
    ? ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu']
    : ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const ORIGIN = 'http://127.0.0.1:43244';
const png = (url: string) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
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
    const used = Object.fromEntries([spec.wall, spec.floor].map((m) => [m, records[m]]));
    const out = await page.evaluate(
      async ({ spec, used }) => {
        type Lib = typeof import('../../src/lib/room-viewer/renderer') &
          typeof import('../../src/lib/room-viewer/view-state') &
          typeof import('../export-photoreal/scene-builder') &
          typeof import('../../src/lib/ai-export/view');
        const lib = (window as unknown as { Lib: Lib }).Lib;
        const toUrl = (source: HTMLCanvasElement) => {
          const copy = document.createElement('canvas');
          copy.width = source.width;
          copy.height = source.height;
          copy.getContext('2d')!.drawImage(source, 0, 0);
          return copy.toDataURL('image/png');
        };
        const built = await lib.buildSpecScene(spec, used);
        const images: Record<string, string> = {},
          ms: Record<string, number> = {};
        const viewer = new lib.RoomViewerRenderer();
        document.body.append(viewer.canvas);
        try {
          await viewer.setSnapshot(built.snapshot, async (id: string) => built.assets[id], {
            background: lib.FLUX_BACKDROP,
          });
          const views: [string, ReturnType<Lib['defaultRoomView']>, number, number][] = [
            ['orbit0', lib.fluxOrbitView({ azimuth: spec.azimuth ?? 0, elevation: 0 }), 1024, 683],
            ['orbit30', lib.fluxOrbitView({ azimuth: (spec.azimuth ?? 0) + 30, elevation: 0 }), 1024, 683],
            ['3d', lib.defaultRoomView(), 1200, 800],
          ];
          for (const [name, view, w, h] of views) {
            viewer.render(w, h, view, 'after');
            const t = performance.now();
            const frame = viewer.render(w, h, view, 'after');
            ms[name] = performance.now() - t;
            images[name] = toUrl(frame);
          }
        } finally {
          viewer.dispose();
          viewer.canvas.remove();
        }
        return { images, ms };
      },
      { spec, used },
    );
    for (const [name, url] of Object.entries(out.images))
      writeFileSync(join(dir, `${spec.id}-${name}.png`), png(url));
    writeFileSync(join(dir, `${spec.id}-ms.json`), JSON.stringify(out.ms));
    console.log(
      `${variant} ${spec.id}: ${Object.entries(out.ms)
        .map(([k, v]) => `${k} ${v.toFixed(1)} ms`)
        .join(', ')}`,
    );
  }
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await browser.close();
}
