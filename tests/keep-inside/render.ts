/**
 * A floor photo toilet saved at the left wall, the front corner (user, 2026-11-16: it stood half
 * outside the room in the AI view), drawn as the AI input is at 0°, 90° and −90° (no AI call). Run it
 * before and after a change to compare.
 *
 * Usage: node tests/run-browser-test.mjs tests/keep-inside/render.ts <label> [--gpu]
 * Output: test-results/keep-inside-20261116/<label>/<scene>.png
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import sharp from 'sharp';
import type { SceneSpec } from '../export-photoreal/scene-builder';
import { ROOT } from '../export-photoreal/paths.mjs';
import { trialCatalog } from '../fixture-haze/catalog';

const gpu = process.argv.includes('--gpu');
const label = process.argv[3] ?? 'now';
const OUT = join(ROOT as string, 'test-results', 'keep-inside-20261116', label);
const { records, files, imageFiles } = trialCatalog();
const toilet = Object.keys(records).find((id) => id.startsWith('cc37e1a1-'))!; // LC-3500, direction photos
const SPECS: SceneSpec[] = [0, 90, -90].map((azimuth) => ({
  id: `corner-${azimuth}`,
  label: `corner ${azimuth}`,
  room: { widthMm: 2400, depthMm: 2400, heightMm: 2400 },
  wall: '9eae17d5-7c80-4f75-80d0-2f19e6bd189a',
  floor: '591b59df-0c9c-473b-bd86-4a78a8d67050',
  products: [{ id: 'toilet', materialId: toilet, face: 'floor', u: 0, v: 0.9 }],
  azimuth,
}));
const only = undefined as Set<string> | undefined;
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
const ORIGIN = 'http://127.0.0.1:43246';
const summary: Record<string, unknown> = {};
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/images/'))
      return route.fulfill({
        body: readFileSync(files[decodeURIComponent(path.slice(8))]),
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
        // As editor.tsx captureAiInput: one plain After frame, its regions, boxes and region boxes.
        const viewer = new lib.RoomViewerRenderer();
        try {
          await viewer.setSnapshot(snapshot, reader, { background: lib.FLUX_BACKDROP });
          const blob = await viewer.export(view, { format: 'png', mode: 'after', longEdge: edge });
          const regions = viewer.regionMask(frame.width, frame.height, view);
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
          const bitmap = await createImageBitmap(blob);
          const layout = lib.fluxInputLayout(bitmap.width, bitmap.height);
          const grounding = await lib.buildFluxGrounding({
            snapshot,
            reader,
            capture: bitmap,
            layout,
            boxes,
            surfaceBoxes,
            ceiling: lib.visibleCeiling(regions) ? lib.VIEWER_CEILING_COLOR : undefined,
            cutaway: true,
            azimuth: view.orbit ? view.orbit.azimuth : undefined,
          });
          const size = { width: bitmap.width, height: bitmap.height };
          bitmap.close();
          const walls = lib.visibleWalls(regions, snapshot.scene);
          return {
            capture: await blob64(blob),
            input: await blob64(await lib.prepareFluxImage(blob)),
            joints: await blob64(joints),
            layout,
            size,
            grounding: { scene: grounding.scene, placed: grounding.placed },
            valid: lib.fluxSceneSchema.safeParse(grounding.scene).success,
            prompt: lib.buildFluxPrompt(grounding.scene),
            check: lib.fluxCheckScene(grounding.scene, walls),
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
    const dir = join(OUT, 'scenes', spec.id);
    mkdirSync(dir, { recursive: true });
    const buf = (b: string) => Buffer.from(b, 'base64');
    writeFileSync(join(dir, 'capture.png'), buf(r.capture));
    writeFileSync(join(dir, 'input.png'), buf(r.input));
    writeFileSync(join(dir, 'joints.png'), buf(r.joints));
    writeFileSync(join(dir, 'grounding.json'), JSON.stringify(r.grounding, null, 1));
    writeFileSync(join(dir, 'layout.json'), JSON.stringify({ layout: r.layout, size: r.size }));
    writeFileSync(join(dir, 'prompt-current.txt'), r.prompt);
    writeFileSync(join(dir, 'check-scene.json'), JSON.stringify(r.check ?? null, null, 1));
    writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 1));
    writeFileSync(join(dir, 'regions.json'), JSON.stringify(r.mask));
    for (const [name, data] of [
      ['mask.png', r.maskData],
      ['mask-outside.png', r.outsideData],
    ] as const)
      await sharp(buf(data), { raw: { width: r.mask.width, height: r.mask.height, channels: 1 } })
        .png()
        .toFile(join(dir, name));
    summary[spec.id] = {
      input: [r.layout.width, r.layout.height],
      valid: r.valid,
      prompt: r.prompt.length,
      fixtures: r.grounding.scene.fixtures.map((f: { kind: string }) => f.kind),
      checked: !!r.check,
      ms: Date.now() - started,
    };
    console.log(spec.id, JSON.stringify(summary[spec.id]));
  }
} finally {
  await browser.close();
}
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ gpu, summary }, null, 1));
