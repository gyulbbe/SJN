/**
 * The side-tile AI trial's empty-room (composite, "실험 A · 빈 방 합성") inputs, no AI call: for each
 * scene (specs.ts) what editor.tsx `capture` and ai-export.tsx send and keep in composite mode, with
 * the renderer of one commit (revision.ts, default `after` = HEAD): the frame's layers (full, room with
 * the fixtures' shadows, empty room, fixture coverage), the empty room as the model gets it
 * (prepareFluxImage), the empty-room prompt (no fixtures, mode `empty-room`), the region mask, the
 * fixtures' boxes and the widened-joints frame. composite-replay.ts puts a saved answer back on them.
 * The step-1 scene folders are left alone: this writes beside them.
 *
 * Usage: node tests/run-browser-test.mjs tests/side-tile-ai/composite-capture.ts [--rev before|after] [--only olive-0,white-0]
 * Output: test-results/side-tile-ai-20261121/<rev>/composite/<scene>/
 *   input-empty.png prompt-empty.txt full.png shadowed.png empty.png coverage.png joints.png
 *   mask.png regions.json boxes.json layout.json spec.json
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import sharp from 'sharp';
import { trialCatalog } from './catalog';
import { OUT, REVISIONS } from './paths.mjs';
import { revisionPlugin } from './revision';
import { trialSpecs } from './specs';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const rev = (arg('rev') ?? 'after') as keyof typeof REVISIONS;
if (!(rev in REVISIONS)) throw new Error('--rev before|after');
const only = arg('only')?.split(',');
const { plugin, swapped } = revisionPlugin((REVISIONS as Record<string, string>)[rev]);
const { records, files, imageFiles } = trialCatalog();
const SPECS = trialSpecs(Object.keys(records)).filter((s) => !only || only.includes(s.id));
const bundle = await build({
  stdin: {
    contents: [
      "export * from './src/lib/room-viewer/renderer';",
      "export { buildSpecScene } from './tests/export-photoreal/scene-builder';",
      "export { buildFluxGrounding, visibleCeiling } from './src/lib/ai-export/scene';",
      "export { fluxInputLayout } from './src/lib/ai-export/contract';",
      "export { prepareFluxImage, pixelsToPng } from './src/lib/ai-export/client';",
      "export { buildFluxPrompt } from './src/lib/ai-export/prompt';",
      "export { fluxOrbitView, snapFluxOrbit, FLUX_BACKDROP } from './src/lib/ai-export/view';",
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
  plugins: [plugin],
});
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
});
const ORIGIN = 'http://127.0.0.1:43248';
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
  await page.evaluate((f) => {
    (window as unknown as { IMAGE_FILES: Record<string, string> }).IMAGE_FILES = f;
  }, imageFiles);
  for (const spec of SPECS) {
    const used = Object.fromEntries(
      [spec.wall, spec.floor, ...(spec.products ?? []).map((p) => p.materialId)].map((m) => [m, records[m]]),
    );
    const r = await page.evaluate(
      async ({ spec, used }) => {
        type Lib = typeof import('../../src/lib/room-viewer/renderer') &
          typeof import('../export-photoreal/scene-builder') &
          typeof import('../../src/lib/ai-export/scene') &
          typeof import('../../src/lib/ai-export/contract') &
          typeof import('../../src/lib/ai-export/client') &
          typeof import('../../src/lib/ai-export/prompt') &
          typeof import('../../src/lib/ai-export/view') &
          typeof import('../../src/lib/room-viewer/ceiling') &
          typeof import('../../src/lib/ai-export/joints');
        const lib = (window as unknown as { Lib: Lib }).Lib;
        const base64 = (bytes: Uint8Array | Uint8ClampedArray) => {
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
        const view = lib.fluxOrbitView(lib.snapFluxOrbit({ azimuth: spec.azimuth, elevation: 0 }));
        const frame = {
          width: Math.min(edge, (edge * width) / height),
          height: Math.min(edge, (edge * height) / width),
        };
        const viewer = new lib.RoomViewerRenderer();
        try {
          // As editor.tsx capture with `composite`: the frame, its regions and its layers.
          await viewer.setSnapshot(snapshot, reader, { background: lib.FLUX_BACKDROP });
          const blob = await viewer.export(view, { format: 'png', mode: 'after', longEdge: edge });
          const regions = viewer.regionMask(frame.width, frame.height, view);
          const layers = viewer.exportLayers(view, { longEdge: edge });
          const boxes = viewer.fixtureBounds(width, height, view);
          const surfaceBoxes = viewer.surfaceBounds(
            width,
            height,
            view,
            snapshot.scene.surfaces.filter((s) => s.region).map((s) => s.id),
          );
          viewer.render(frame.width, frame.height, view, 'after');
          const perMm = lib.inputPxPerMm(
            (face, u, v) => viewer.faceToFrame(face, u, v),
            snapshot.scene.room!,
            frame,
            lib.fluxInputLayout(frame.width, frame.height).scale,
          );
          const widened = new lib.RoomViewerRenderer();
          let joints: Blob;
          try {
            await widened.setSnapshot(lib.widenJoints(snapshot, lib.widenedJointMm(perMm)), reader, {
              background: lib.FLUX_BACKDROP,
            });
            joints = await widened.export(view, { format: 'png', mode: 'after', longEdge: edge });
          } finally {
            widened.dispose();
          }
          // As ai-export.tsx (mode 'empty-room'): the empty room goes out, its facts without fixtures.
          const empty = { width: layers.width, height: layers.height, data: layers.empty };
          const input = await lib.prepareFluxImage(await lib.pixelsToPng(empty));
          const bitmap = await createImageBitmap(blob);
          const grounding = await lib.buildFluxGrounding({
            snapshot,
            reader,
            capture: bitmap,
            layout: lib.fluxInputLayout(bitmap.width, bitmap.height),
            boxes,
            surfaceBoxes,
            ceiling: lib.visibleCeiling(regions) ? lib.VIEWER_CEILING_COLOR : undefined,
            cutaway: true,
            azimuth: view.orbit ? view.orbit.azimuth : undefined,
          });
          bitmap.close();
          const sentScene = { ...grounding.scene, fixtures: [], mode: 'empty-room' as const };
          return {
            input: await blob64(input),
            joints: await blob64(joints),
            prompt: lib.buildFluxPrompt(sentScene),
            layers: {
              width: layers.width,
              height: layers.height,
              full: base64(layers.full),
              shadowed: base64(layers.shadowed),
              empty: base64(layers.empty),
              coverage: base64(layers.coverage),
            },
            layout: lib.fluxInputLayout(layers.width, layers.height),
            boxes: Object.values(boxes),
            mask: { width: regions.width, height: regions.height, regions: regions.regions },
            maskData: base64(regions.data),
            outsideData: base64(regions.outside),
          };
        } finally {
          viewer.dispose();
        }
      },
      { spec, used },
    );
    if (errors.length) throw new Error(errors.join('\n'));
    const dir = join(OUT as string, rev, 'composite', spec.id);
    mkdirSync(dir, { recursive: true });
    const buf = (b: string) => Buffer.from(b, 'base64');
    writeFileSync(join(dir, 'input-empty.png'), buf(r.input));
    writeFileSync(join(dir, 'joints.png'), buf(r.joints));
    writeFileSync(join(dir, 'prompt-empty.txt'), r.prompt);
    const { width, height } = r.layers;
    for (const name of ['full', 'shadowed', 'empty'] as const)
      await sharp(buf(r.layers[name]), { raw: { width, height, channels: 4 } })
        .png()
        .toFile(join(dir, `${name}.png`));
    await sharp(buf(r.layers.coverage), { raw: { width, height, channels: 1 } })
      .png()
      .toFile(join(dir, 'coverage.png'));
    for (const [name, data] of [
      ['mask.png', r.maskData],
      ['mask-outside.png', r.outsideData],
    ] as const)
      await sharp(buf(data), { raw: { width: r.mask.width, height: r.mask.height, channels: 1 } })
        .png()
        .toFile(join(dir, name));
    writeFileSync(join(dir, 'regions.json'), JSON.stringify(r.mask));
    writeFileSync(join(dir, 'boxes.json'), JSON.stringify(r.boxes));
    writeFileSync(join(dir, 'layout.json'), JSON.stringify(r.layout));
    writeFileSync(join(dir, 'spec.json'), JSON.stringify({ ...spec, rev, swapped }, null, 1));
    console.log(rev, spec.id, 'composite', `${width}x${height}`, `prompt ${r.prompt.length}`);
  }
} finally {
  await browser.close();
}
