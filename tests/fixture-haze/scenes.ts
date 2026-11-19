/**
 * The fixture-haze trial's new scenes for the AI calls (no AI call here, docs/fixture-haze-20261116.md,
 * section 4): specs.ts drawn exactly as the export dialog captures them, as tests/photo-products/scenes.ts
 * does (its copy, with the trial's catalogue: the snapshot plus the locally registered basins).
 *
 * Usage: node tests/run-browser-test.mjs tests/fixture-haze/scenes.ts [--holdout] [--only id,id] [--gpu] [--group bath]
 *   (SCENES_OUT=<dir> to draw elsewhere, SCENES_SOFTEN='{"roughness":0.45}' to soften glossy reflections)
 * Output: test-results/fixture-haze-20261116/new/scenes/<scene>/
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import sharp from 'sharp';
import { trialCatalog } from './catalog';
import { OUT as TRIAL } from './paths.mjs';
import { groupArg, resolveSpecs } from './specs';

const gpu = process.argv.includes('--gpu');
const holdout = process.argv.includes('--holdout');
const only = (() => {
  const i = process.argv.indexOf('--only');
  return i > 0 ? new Set(process.argv[i + 1].split(',')) : undefined;
})();

const group = groupArg(process.argv);
// SCENES_OUT draws into another folder (to compare a renderer change with the scenes the model got).
const OUT = process.env.SCENES_OUT ?? join(TRIAL as string, group);
// SCENES_SOFTEN (fixture-glare trial, docs/fixture-glare-20261119.md section 7): the capture with every
// non-metal surface glossier than {"roughness"} made that rough, and the room's environment reflection
// times {"environment"} (both viewers: the capture and the widened-joints one).
const soften = process.env.SCENES_SOFTEN
  ? (JSON.parse(process.env.SCENES_SOFTEN) as { roughness?: number; environment?: number })
  : undefined;
const { records, files, imageFiles } = trialCatalog();
const SPECS = resolveSpecs(Object.keys(records), group).filter((spec) => !!spec.holdout === holdout);
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
      async ({ spec, used, soften }) => {
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
        type Soft = { roughness: number; metalness: number; needsUpdate: boolean };
        const softenViewer = (renderer: InstanceType<typeof lib.RoomViewerRenderer>) => {
          if (!soften) return;
          const world = (
            renderer as unknown as {
              prepared: {
                after: {
                  world: {
                    environmentIntensity: number;
                    traverse(f: (node: { material?: Soft | Soft[] }) => void): void;
                  };
                };
              };
            }
          ).prepared.after.world;
          if (soften.environment !== undefined) world.environmentIntensity *= soften.environment;
          const target = soften.roughness;
          if (target === undefined) return;
          world.traverse((node) => {
            for (const material of [node.material ?? []].flat())
              if ('roughness' in material && material.metalness < 0.5 && material.roughness < target) {
                material.roughness = target;
                material.needsUpdate = true;
              }
          });
        };
        const viewer = new lib.RoomViewerRenderer();
        try {
          await viewer.setSnapshot(snapshot, reader, { background: lib.FLUX_BACKDROP });
          softenViewer(viewer);
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
            softenViewer(widened);
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
      { spec, used, soften },
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
writeFileSync(
  join(OUT, `scenes-summary-${holdout ? 'holdout' : 'dev'}.json`),
  JSON.stringify({ gpu, summary }, null, 1),
);
