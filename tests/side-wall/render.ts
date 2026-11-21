/**
 * The side-wall trial's pictures (no AI call, docs/side-wall-tiles-20261115.md): real catalogue tiles
 * (the 11-13 tile trial's scenes) drawn as the app draws them, in the editor's 2D and 3D views and the
 * AI capture's outside orbit at three angles, with one suspected cause changed per variant
 * (atlas-shim.ts). With --ref it also draws each view at 4× (the editor-size views at 3×) and
 * box-filters it in linear light: how the picture should look at its size (a 1 px joint there is a
 * quarter or third of a pixel here, near its real width).
 *
 *   node tests/run-browser-test.mjs tests/side-wall/render.ts --variant cur [--ref] [--gpu] [--only small,roman]
 * Output: test-results/side-wall-20261115/<variant>[-gpu]/<scene>-<view>.png, ref[-gpu]/…, masks/…json
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { build, type Plugin } from 'esbuild';
import type { PublicRecord } from '../export-photoreal/scene-builder';
import { SNAPSHOT } from '../tile-ai/paths.mjs';
import { SPECS } from '../tile-ai/specs';
import { OUT } from './paths.mjs';

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const variant = arg('variant', 'cur');
const gpu = process.argv.includes('--gpu');
const withRef = process.argv.includes('--ref');
const only = new Set(arg('only', 'small,roman,scored,marble,patchwork,subway,beige').split(','));
const suffix = gpu ? '-gpu' : '';
const dir = join(OUT as string, (arg('name') || variant) + suffix),
  refDir = join(OUT as string, 'ref' + suffix),
  maskDir = join(OUT as string, 'masks');
for (const d of [dir, refDir, maskDir]) mkdirSync(d, { recursive: true });

const catalog = JSON.parse(readFileSync(join(SNAPSHOT as string, 'catalog.json'), 'utf8')) as {
  placements: (PublicRecord & { materialId: string })[];
};
const records = Object.fromEntries(catalog.placements.map((p) => [p.materialId, p]));
const imageFiles = Object.fromEntries(
  readdirSync(join(SNAPSHOT as string, 'images')).map((f) => [f.replace(/\.[a-z]+$/, ''), f]),
);
const shim = resolve('tests/side-wall/atlas-shim.ts');
const redirect: Plugin = {
  name: 'side-wall-atlas',
  setup(b) {
    b.onResolve({ filter: /tile-atlas$/ }, (args) => (args.importer === shim ? undefined : { path: shim }));
    // SCENES_PATCH (side-tile trial, docs/side-tile-20261121.md): as tests/fixture-haze/scenes.ts.
    const patches = process.env.SCENES_PATCH
      ? (JSON.parse(process.env.SCENES_PATCH) as Record<string, [string, string][]>)
      : {};
    b.onLoad({ filter: /[.]ts$/ }, (args) => {
      const path = args.path.replace(/\\/g, '/');
      const swaps = Object.entries(patches).find(([name]) => path.endsWith(name))?.[1];
      if (!swaps) return undefined;
      let text = readFileSync(args.path, 'utf8').replace(/\r\n/g, '\n');
      for (const [from, to] of swaps) {
        if (!text.includes(from)) throw new Error(`SCENES_PATCH: no "${from}" in ${args.path}`);
        text = text.replace(from, to);
      }
      return { contents: text, loader: 'ts' };
    });
  },
};
const bundle = await build({
  stdin: {
    contents: [
      "export * from './src/lib/room-viewer/renderer';",
      "export { defaultRoomView } from './src/lib/room-viewer/view-state';",
      "export { PhotoCompositor } from './src/lib/render/compositor';",
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
  plugins: [redirect],
  define: { SJN_SIDE_VARIANT: JSON.stringify(variant) },
});
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: gpu
    ? ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu']
    : ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const ORIGIN = 'http://127.0.0.1:43243';
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
    if (!only.has(spec.id)) continue;
    const used = Object.fromEntries(
      [spec.wall, spec.floor].map((m) => [
        m,
        m === spec.wall && spec.wallPattern
          ? { ...records[m], defaultPattern: spec.wallPattern }
          : records[m],
      ]),
    );
    const started = Date.now();
    const out = await page.evaluate(
      async ({ spec, used, withRef }) => {
        type Lib = typeof import('../../src/lib/room-viewer/renderer') &
          typeof import('../../src/lib/room-viewer/view-state') &
          typeof import('../../src/lib/render/compositor') &
          typeof import('../export-photoreal/scene-builder') &
          typeof import('../../src/lib/ai-export/view');
        const lib = (window as unknown as { Lib: Lib }).Lib;
        const readPixels = (source: CanvasImageSource & { width: number; height: number }) => {
          const copy = document.createElement('canvas');
          copy.width = source.width;
          copy.height = source.height;
          const ctx = copy.getContext('2d', { willReadFrequently: true })!;
          ctx.drawImage(source, 0, 0);
          return ctx.getImageData(0, 0, copy.width, copy.height);
        };
        const toUrl = (image: ImageData) => {
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          canvas.getContext('2d')!.putImageData(image, 0, 0);
          return canvas.toDataURL('image/png');
        };
        const linear = Float32Array.from({ length: 256 }, (_, v) => {
          const c = v / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        const encode = (v: number) =>
          Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
        // 4× where the drawing allows it (the AI capture, 1,024 px); the editor-size views go up to
        // 3× (3,600 px), as the 11-05 mipmap test did, since a canvas side stops at 4,096.
        const reduce = (big: ImageData, F: number) => {
          const width = Math.floor(big.width / F),
            height = Math.floor(big.height / F);
          const out = new ImageData(width, height);
          for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++)
              for (let c = 0; c < 3; c++) {
                let sum = 0;
                for (let dy = 0; dy < F; dy++)
                  for (let dx = 0; dx < F; dx++)
                    sum += linear[big.data[((y * F + dy) * big.width + x * F + dx) * 4 + c]];
                out.data[(y * width + x) * 4 + c] = encode(sum / (F * F));
                out.data[(y * width + x) * 4 + 3] = 255;
              }
          return out;
        };
        const maskOf = (mask: {
          width: number;
          height: number;
          data: Uint8Array;
          regions: { kind: string }[];
        }) => {
          let binary = '';
          for (let i = 0; i < mask.data.length; i += 0x8000)
            binary += String.fromCharCode(...mask.data.subarray(i, i + 0x8000));
          return {
            width: mask.width,
            height: mask.height,
            kinds: mask.regions.map((r) => r.kind),
            data: btoa(binary),
          };
        };
        const built = await lib.buildSpecScene(spec, used);
        const reader = async (id: string) => built.assets[id];
        const images: Record<string, string> = {},
          refs: Record<string, string> = {},
          masks: Record<string, ReturnType<typeof maskOf>> = {},
          ms: Record<string, number> = {};
        // 2D: the editor stage of a plain room.
        {
          const compositor = new lib.PhotoCompositor();
          try {
            await compositor.setSnapshot(built.snapshot, reader);
            compositor.render(1200, 800, 'after');
            const t = performance.now();
            const stage = readPixels(compositor.render(1200, 800, 'after'));
            ms['2d'] = performance.now() - t;
            images['2d'] = toUrl(stage);
            let mask: Parameters<typeof maskOf>[0] | undefined;
            await compositor.exportImage(built.snapshot, 1200, 800, 'image/png', false, (m) => (mask = m));
            if (mask) masks['2d'] = maskOf(mask);
            // The export caps its long edge, so the reference is the stage itself drawn larger.
            if (withRef) refs['2d'] = toUrl(reduce(readPixels(compositor.render(3600, 2400, 'after')), 3));
          } finally {
            compositor.dispose();
          }
        }
        // 3D: the editor's view, and the AI capture's outside orbit at 0°, 30° and 60°.
        {
          const viewer = new lib.RoomViewerRenderer();
          document.body.append(viewer.canvas);
          try {
            await viewer.setSnapshot(built.snapshot, reader, { background: lib.FLUX_BACKDROP });
            const views: [string, ReturnType<Lib['defaultRoomView']>, number, number][] = [
              ['3d', lib.defaultRoomView(), 1200, 800],
              ['orbit0', lib.fluxOrbitView({ azimuth: 0, elevation: 0 }), 1024, 683],
              ['orbit30', lib.fluxOrbitView({ azimuth: 30, elevation: 0 }), 1024, 683],
              ['orbit60', lib.fluxOrbitView({ azimuth: 60, elevation: 0 }), 1024, 683],
            ];
            for (const [name, view, w, h] of views) {
              viewer.render(w, h, view, 'after');
              const t = performance.now();
              const frame = readPixels(viewer.render(w, h, view, 'after'));
              ms[name] = performance.now() - t;
              images[name] = toUrl(frame);
              masks[name] = maskOf(viewer.regionMask(w, h, view));
              const F = w * 4 <= 4096 ? 4 : 3;
              if (withRef)
                refs[name] = toUrl(reduce(readPixels(viewer.render(w * F, h * F, view, 'after')), F));
            }
          } finally {
            viewer.dispose();
            viewer.canvas.remove();
          }
        }
        return { images, refs, masks, ms };
      },
      { spec, used, withRef },
    );
    for (const [name, url] of Object.entries(out.images))
      writeFileSync(join(dir, `${spec.id}-${name}.png`), png(url));
    for (const [name, url] of Object.entries(out.refs))
      writeFileSync(join(refDir, `${spec.id}-${name}.png`), png(url));
    for (const [name, mask] of Object.entries(out.masks))
      writeFileSync(join(maskDir, `${spec.id}-${name}.json`), JSON.stringify(mask));
    writeFileSync(join(dir, `${spec.id}-ms.json`), JSON.stringify(out.ms));
    console.log(
      `${variant}${suffix} ${spec.id} ${Date.now() - started} ms; draw ${Object.entries(out.ms)
        .map(([k, v]) => `${k} ${v.toFixed(1)}`)
        .join(', ')}`,
    );
  }
  if (errors.length) throw new Error(errors.join('\n'));
} finally {
  await browser.close();
}
