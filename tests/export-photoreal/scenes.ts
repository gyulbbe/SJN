/**
 * The trial's ten scenes (no AI call): built from the public catalogue snapshot with the app's own
 * placement functions (scene-builder.ts) and captured exactly as the export dialog captures them
 * (editor captureAiInput + ai-export.tsx): the After from the outside orbit on white at 1024 px, the
 * 496 px model input, the face mask, the fixture boxes, the scene facts and the app's prompt; the room
 * layers for experiments A and B and the product close-ups for C; and for the trial only, the no-AI
 * render (32 samples and the photo look), a 768 px input, the old in-room eye input and the tile
 * textures for the reference variant.
 *
 * The two held-out scenes go to holdout/ and are read only in round 6 (--holdout).
 *
 * Usage: node tests/run-browser-test.mjs tests/export-photoreal/scenes.ts [--gpu] [--only id,id]
 * Output: test-results/export-photoreal/scenes/<id>/ and holdout/<id>/
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import sharp from 'sharp';
import { pngBuffer, saveTyped } from './io';
import { HOLDOUT, SCENES, SNAPSHOT } from './paths.mjs';
import type { PublicRecord } from './scene-builder';
import { SPECS } from './specs';

const gpu = process.argv.includes('--gpu');
const only = (() => {
  const i = process.argv.indexOf('--only');
  return i > 0 ? new Set(process.argv[i + 1].split(',')) : undefined;
})();

// ---------- the page ----------
const catalog = JSON.parse(readFileSync(join(SNAPSHOT as string, 'catalog.json'), 'utf8')) as {
  placements: (PublicRecord & { materialId: string })[];
};
const records: Record<string, PublicRecord> = Object.fromEntries(
  catalog.placements.map((p) => [p.materialId, p]),
);
const imageFiles = Object.fromEntries(
  readdirSync(join(SNAPSHOT as string, 'images')).map((f) => [f.replace(/\.[a-z]+$/, ''), f]),
);
const bundle = await build({
  stdin: {
    contents: [
      "export * from './src/lib/room-viewer/renderer';",
      "export * from './src/lib/room-viewer/view-state';",
      "export { buildSpecScene } from './tests/export-photoreal/scene-builder';",
      "export { presetFluxView } from './tests/helpers/flux-room-scene';",
      "export { buildFluxGrounding, refineTargets, visibleCeiling, visibleWalls } from './src/lib/ai-export/scene';",
      "export { fluxInputLayout } from './src/lib/ai-export/contract';",
      "export { prepareFluxImage, readPixels, pixelsToPng } from './src/lib/ai-export/client';",
      "export { buildFluxPrompt } from './src/lib/ai-export/prompt';",
      "export { fluxSceneSchema } from './src/lib/ai-export/scene-contract';",
      "export { fluxOrbitView, FLUX_BACKDROP } from './src/lib/ai-export/view';",
      "export { placeholderRoom } from './src/lib/ai-export/composite';",
      "export { REFINE_CROP_EDGE, REFINE_MARGIN, REFINE_MAX_PRODUCTS } from './src/lib/ai-export/refine';",
      "export { productFact } from './src/lib/ai-export/refine-run';",
      "export { VIEWER_CEILING_COLOR } from './src/lib/room-viewer/ceiling';",
      "export { PHOTO_EFFECTS } from './src/lib/room-viewer/photo-effects';",
      "export { validateWallFeatures } from './src/lib/wall-features';",
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
const ORIGIN = 'http://127.0.0.1:43231';
const summary: Record<string, unknown> = {};
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/images/')) {
      const file = join(SNAPSHOT as string, 'images', decodeURIComponent(path.slice(8)));
      return route.fulfill({ body: readFileSync(file) });
    }
    return route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' });
  });
  await page.goto(`${ORIGIN}/`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate((files) => {
    (window as unknown as { IMAGE_FILES: Record<string, string> }).IMAGE_FILES = files;
  }, imageFiles);
  for (const spec of SPECS) {
    if (only && !only.has(spec.id)) continue;
    const needed = new Set([spec.wall, spec.floor, ...(spec.regions ?? []).map((r) => r.materialId)]);
    for (const p of spec.products ?? []) needed.add(p.materialId);
    const used = Object.fromEntries([...needed].map((m) => [m, records[m]]));
    const started = Date.now();
    const r = await page.evaluate(
      async ({ spec, used }) => {
        type Lib = typeof import('../../src/lib/room-viewer/renderer') &
          typeof import('../../src/lib/room-viewer/view-state') &
          typeof import('./scene-builder') &
          typeof import('../helpers/flux-room-scene') &
          typeof import('../../src/lib/ai-export/scene') &
          typeof import('../../src/lib/ai-export/contract') &
          typeof import('../../src/lib/ai-export/client') &
          typeof import('../../src/lib/ai-export/prompt') &
          typeof import('../../src/lib/ai-export/scene-contract') &
          typeof import('../../src/lib/ai-export/view') &
          typeof import('../../src/lib/ai-export/composite') &
          typeof import('../../src/lib/ai-export/refine') &
          typeof import('../../src/lib/ai-export/refine-run') &
          typeof import('../../src/lib/room-viewer/ceiling') &
          typeof import('../../src/lib/room-viewer/photo-effects') &
          typeof import('../../src/lib/wall-features');
        const lib = (window as unknown as { Lib: Lib }).Lib;
        const base64 = (bytes: Uint8Array) => {
          let text = '';
          for (let i = 0; i < bytes.length; i += 0x8000)
            text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return btoa(text);
        };
        const pack = (v: unknown): unknown => {
          if (v instanceof Float32Array)
            return { $typed: 'f32', base64: base64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
          if (v instanceof Uint8ClampedArray)
            return { $typed: 'u8c', base64: base64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
          if (v instanceof Uint8Array) return { $typed: 'u8', base64: base64(v) };
          if (Array.isArray(v)) return v.map(pack);
          if (v && typeof v === 'object')
            return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, pack(x)]));
          return v;
        };
        const blobBase64 = async (blob: Blob) => base64(new Uint8Array(await blob.arrayBuffer()));
        if (spec.features?.length) {
          const issues = lib.validateWallFeatures(spec.room as never, spec.features);
          if (issues.length) throw new Error(`wall features: ${JSON.stringify(issues)}`);
        }
        const { room, assets, snapshot } = await lib.buildSpecScene(spec, used);
        const reader = async (assetId: string) => assets[assetId];
        const { imageWidth: width, imageHeight: height } = snapshot.scene;
        const edge = Math.min(1024, Math.max(width, height));
        const capture = async (view: ReturnType<typeof lib.fluxOrbitView>, orbit: boolean) => {
          const viewer = new lib.RoomViewerRenderer();
          try {
            await viewer.setSnapshot(snapshot, reader, { background: lib.FLUX_BACKDROP });
            const blob = await viewer.export(view, { format: 'png', mode: 'after', longEdge: edge });
            const regions = viewer.regionMask(
              Math.min(edge, (edge * width) / height),
              Math.min(edge, (edge * height) / width),
              view,
            );
            const boxes = viewer.fixtureBounds(width, height, view);
            const surfaceBoxes = viewer.surfaceBounds(
              width,
              height,
              view,
              snapshot.scene.surfaces.filter((s) => s.region).map((s) => s.id),
            );
            const ceiling = lib.visibleCeiling(regions) ? lib.VIEWER_CEILING_COLOR : undefined;
            const bitmap = await createImageBitmap(blob);
            const layout = lib.fluxInputLayout(bitmap.width, bitmap.height);
            const grounding = await lib.buildFluxGrounding({
              snapshot,
              reader,
              capture: bitmap,
              layout,
              boxes,
              surfaceBoxes,
              ceiling,
              cutaway: orbit ? true : undefined,
              azimuth: orbit && view.orbit ? view.orbit.azimuth : undefined,
            });
            bitmap.close();
            const input = await lib.prepareFluxImage(blob);
            const walls = lib.visibleWalls(regions, snapshot.scene);
            let layers, crops, products, render32, inputEmpty, inputPlaceholders;
            if (orbit) {
              layers = viewer.exportLayers(view, { longEdge: edge });
              const targets = lib.refineTargets(snapshot).slice(0, lib.REFINE_MAX_PRODUCTS);
              crops = viewer.exportProductCrops(view, {
                frame: { width: layers.width, height: layers.height },
                longEdge: lib.REFINE_CROP_EDGE,
                margin: lib.REFINE_MARGIN,
                ids: targets.map((t) => t.id),
              });
              const cropIds = new Set(crops.map((c) => c.id));
              products = grounding.placed.flatMap((placed, index) => {
                const fixture = grounding.scene.fixtures[index];
                return cropIds.has(placed.id) && fixture
                  ? [{ id: placed.id, label: placed.label, fact: lib.productFact(fixture) }]
                  : [];
              });
              const empty = { width: layers.width, height: layers.height, data: layers.empty };
              inputEmpty = await lib.prepareFluxImage(await lib.pixelsToPng(empty));
              inputPlaceholders = await lib.prepareFluxImage(
                await lib.pixelsToPng(lib.placeholderRoom(layers)),
              );
              render32 = await viewer.export(view, {
                format: 'png',
                mode: 'after',
                longEdge: edge,
                quality: { samples: 32 },
                effects: lib.PHOTO_EFFECTS,
              });
            }
            const scene = grounding.scene;
            const prompts = {
              current: lib.buildFluxPrompt(scene),
              empty: lib.buildFluxPrompt({ ...scene, fixtures: [], mode: 'empty-room' }),
              placeholders: lib.buildFluxPrompt({ ...scene, fixtures: [], mode: 'placeholders' }),
            };
            return {
              capture: await blobBase64(blob),
              input: await blobBase64(input),
              inputEmpty: inputEmpty && (await blobBase64(inputEmpty)),
              inputPlaceholders: inputPlaceholders && (await blobBase64(inputPlaceholders)),
              render32: render32 && (await blobBase64(render32)),
              layout,
              mask: pack(regions),
              boxes,
              grounding: { scene, placed: grounding.placed },
              valid: lib.fluxSceneSchema.safeParse(scene).success,
              walls,
              prompts,
              layers: layers && pack(layers),
              crops: crops && pack(crops),
              products,
            };
          } finally {
            viewer.dispose();
          }
        };
        const orbit = await capture(lib.fluxOrbitView({ azimuth: spec.azimuth, elevation: 0 }), true);
        const inRoom = await capture(lib.presetFluxView(room, 'center'), false);
        const textures = [spec.wall, spec.floor].map((m) => snapshot.materials[m].textureAssetIds[0]);
        const tex = await Promise.all(textures.map(async (a) => blobBase64(assets[a].blob)));
        return { orbit, inRoom, textures: tex };
      },
      { spec, used },
    );
    if (errors.length) throw new Error(errors.join('\n'));
    const dir = join((spec.holdout ? HOLDOUT : SCENES) as string, spec.id);
    mkdirSync(dir, { recursive: true });
    const buf = (b: string) => Buffer.from(b, 'base64');
    const o = r.orbit;
    writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec, null, 1));
    writeFileSync(join(dir, 'capture.png'), buf(o.capture));
    writeFileSync(join(dir, 'input.png'), buf(o.input));
    writeFileSync(join(dir, 'input-empty.png'), buf(o.inputEmpty!));
    writeFileSync(join(dir, 'input-placeholders.png'), buf(o.inputPlaceholders!));
    // The photo download's frame keeps the room on a clear background; the comparison puts it on white.
    await sharp(buf(o.render32!)).flatten({ background: '#ffffff' }).png().toFile(join(dir, 'render32.png'));
    writeFileSync(join(dir, 'grounding.json'), JSON.stringify(o.grounding, null, 1));
    writeFileSync(
      join(dir, 'boxes.json'),
      JSON.stringify({ boxes: o.boxes, layout: o.layout, walls: o.walls }),
    );
    writeFileSync(join(dir, 'products.json'), JSON.stringify(o.products ?? [], null, 1));
    for (const [name, text] of Object.entries(o.prompts))
      writeFileSync(join(dir, `prompt-${name}.txt`), text);
    saveTyped(dir, 'mask', o.mask);
    saveTyped(dir, 'layers', o.layers);
    saveTyped(dir, 'crops', o.crops);
    // The variants' own inputs: the in-room eye (its own facts and prompt), 768 px, tile textures.
    const room = join(dir, 'inroom');
    mkdirSync(room, { recursive: true });
    writeFileSync(join(room, 'capture.png'), buf(r.inRoom.capture));
    writeFileSync(join(room, 'input.png'), buf(r.inRoom.input));
    writeFileSync(join(room, 'grounding.json'), JSON.stringify(r.inRoom.grounding, null, 1));
    writeFileSync(join(room, 'prompt-current.txt'), r.inRoom.prompts.current);
    writeFileSync(
      join(room, 'boxes.json'),
      JSON.stringify({ boxes: r.inRoom.boxes, layout: r.inRoom.layout, walls: r.inRoom.walls }),
    );
    saveTyped(room, 'mask', r.inRoom.mask);
    // 768 px on the long side in 16 px steps, padded with white like fluxInputLayout (outside its guide).
    const meta = await sharp(buf(o.capture)).metadata();
    const scale = 768 / Math.max(meta.width!, meta.height!);
    const w = Math.round((meta.width! * scale) / 16) * 16,
      h = Math.round((meta.height! * scale) / 16) * 16;
    await sharp(buf(o.capture))
      .resize(w, h, { fit: 'contain', background: '#ffffff' })
      .png()
      .toFile(join(dir, 'input-768.png'));
    for (const [i, name] of ['wall', 'floor'].entries())
      await sharp(buf(r.textures[i]))
        .resize(256, 256, { fit: 'cover' })
        .png()
        .toFile(join(dir, `ref-${name}.png`));
    const mask = await sharp(join(dir, 'capture.png')).metadata();
    summary[spec.id] = {
      holdout: !!spec.holdout,
      capture: [mask.width, mask.height],
      input: [o.layout.width, o.layout.height],
      valid: o.valid,
      fixtures: o.grounding.scene.fixtures.length,
      surfaces: o.grounding.scene.surfaces.length,
      ceiling: !!o.grounding.scene.ceiling,
      refine: (o.products ?? []).length,
      prompt: o.prompts.current.length,
      walls: o.walls,
      ms: Date.now() - started,
    };
    console.log(spec.id, JSON.stringify(summary[spec.id]));
    void pngBuffer;
  }
} finally {
  await browser.close();
}
mkdirSync(SCENES as string, { recursive: true });
writeFileSync(join(SCENES as string, '..', 'scenes-summary.json'), JSON.stringify({ gpu, summary }, null, 1));
