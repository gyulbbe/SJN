/**
 * AI conversion inputs for wall and floor regions (no AI call): the white comparison bathroom with
 * a full-height accent stripe on the back wall and a darker shower floor along the left wall, from
 * the AI dialog's front orbit view, as the app captures it. For the real comparison it writes the
 * capture, the 496 px model input, the face mask, the region boxes, and the scene and prompt twice:
 * "current" as the code before regions sends them (a region is one more line for its face) and
 * "new" (the region with where it is in image 0). Real calls go through a separate temporary Worker.
 *
 * Usage: node tests/run-browser-test.mjs tests/tile-regions-payload.ts [--gpu]
 * Output: test-results/tile-regions/payload/
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import sharp from 'sharp';

const gpu = process.argv.includes('--gpu');
const output = 'test-results/tile-regions/payload';
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/room-viewer/renderer';export * from './src/lib/room-viewer/view-state';export {buildFluxRoomScene} from './tests/helpers/flux-room-scene';export {buildFluxGrounding} from './src/lib/ai-export/scene';export {fluxInputLayout} from './src/lib/ai-export/contract';export {prepareFluxImage} from './src/lib/ai-export/client';export {buildFluxPrompt} from './src/lib/ai-export/prompt';export {fluxSceneSchema} from './src/lib/ai-export/scene-contract';export {fluxOrbitView,FLUX_FRONT,FLUX_BACKDROP} from './src/lib/ai-export/view';export {applyRoomSurfaceRegion} from './src/lib/room-surface-regions';export {createRoomSurfaces} from './src/lib/room-geometry';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'Payload',
});
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: gpu
    ? ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu']
    : ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('http://127.0.0.1:43219/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }),
  );
  await page.goto('http://127.0.0.1:43219/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const r = await page.evaluate(async () => {
    type Lib = typeof import('../src/lib/room-viewer/renderer') &
      typeof import('../src/lib/room-viewer/view-state') &
      typeof import('./helpers/flux-room-scene') &
      typeof import('../src/lib/ai-export/scene') &
      typeof import('../src/lib/ai-export/contract') &
      typeof import('../src/lib/ai-export/client') &
      typeof import('../src/lib/ai-export/prompt') &
      typeof import('../src/lib/ai-export/scene-contract') &
      typeof import('../src/lib/ai-export/view') &
      typeof import('../src/lib/room-surface-regions') &
      typeof import('../src/lib/room-geometry');
    const lib = (window as unknown as { Payload: Lib }).Payload;
    const dataUrl = (blob: Blob) =>
      new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(blob);
      });
    const { room, assets, snapshot } = await lib.buildFluxRoomScene({ walls: 'white' });
    // Two tiles of their own: a glossy navy accent and a matte charcoal shower floor.
    const texture = async (id: string, fill: string, joint: string) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const c = canvas.getContext('2d')!;
      c.fillStyle = fill;
      c.fillRect(0, 0, 64, 64);
      c.fillStyle = joint;
      c.fillRect(0, 0, 64, 1);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
      assets[id] = {
        id,
        ownerId: 'test',
        name: id,
        mime: 'image/png',
        size: blob.size,
        width: 64,
        height: 64,
        kind: 'texture',
        blob,
        createdAt: '2026-10-22',
      };
    };
    await texture('accent-texture', '#1f3a5f', '#223f66');
    await texture('shower-texture', '#4a4a47', '#4f4f4c');
    const tile = (id: string, finish: string, widthMm: number, heightMm: number, color: string) => ({
      id,
      materialId: id,
      version: 1,
      name: id,
      brand: '',
      code: '',
      category: 'tile' as const,
      scope: 'personal' as const,
      description: '',
      color,
      finish,
      widthMm,
      heightMm,
      depthMm: 8,
      usage: 'both' as const,
      installation: 'wall' as const,
      textureAssetIds: [id + '-texture'],
      views: [],
      defaultGroutWidth: 2,
      defaultGroutColor: '#e8e8e4',
      defaultPattern: 'grid' as const,
      createdAt: '2026-10-22',
    });
    snapshot.materials.accent = tile('accent', '유광', 300, 600, '#1f3a5f');
    snapshot.materials.shower = tile('shower', '무광', 300, 300, '#4a4a47');
    const scene = snapshot.scene;
    const face = (name: string) =>
      lib.createRoomSurfaces(room, scene.imageWidth / scene.imageHeight).find((s) => s.roomFace === name)!;
    const stripe = lib.applyRoomSurfaceRegion(
      {
        ...face('back'),
        id: '30000000-0000-4000-8000-000000000001',
        name: '정면 벽 · 부분 타일 1',
        materialVersionId: 'accent',
        tile: { ...face('back').tile, groutWidth: 2, groutColor: '#e8e8e4', shading: 0.35 },
      },
      { leftMm: 450, topMm: 0, widthMm: 900, heightMm: room.heightMm },
    );
    const showerFloor = lib.applyRoomSurfaceRegion(
      {
        ...face('floor'),
        id: '30000000-0000-4000-8000-000000000002',
        name: '바닥 · 부분 타일 1',
        materialVersionId: 'shower',
        tile: { ...face('floor').tile, groutWidth: 2, groutColor: '#8a8a86', shading: 0.25 },
      },
      { leftMm: 0, topMm: 300, widthMm: 900, heightMm: 1200 },
    );
    scene.surfaces.push(stripe, showerFloor);
    const reader = async (id: string) => assets[id];
    const viewer = new lib.RoomViewerRenderer();
    try {
      await viewer.setSnapshot(snapshot, reader, { background: lib.FLUX_BACKDROP });
      const view = lib.fluxOrbitView(lib.FLUX_FRONT);
      const blob = await viewer.export(view, { format: 'png', mode: 'after', longEdge: 1024 });
      const capture = await createImageBitmap(blob);
      const layout = lib.fluxInputLayout(capture.width, capture.height);
      const boxes = viewer.fixtureBounds(capture.width, capture.height, view);
      const surfaceBoxes = viewer.surfaceBounds(capture.width, capture.height, view, [
        stripe.id,
        showerFloor.id,
      ]);
      const mask = viewer.regionMask(capture.width, capture.height, view);
      const grounding = await lib.buildFluxGrounding({
        snapshot,
        reader,
        capture,
        layout,
        boxes,
        surfaceBoxes,
        cutaway: true,
        azimuth: 0,
      });
      capture.close();
      // Before regions, each region was one more line for its face: the same entries without a box.
      const current = {
        ...grounding.scene,
        surfaces: grounding.scene.surfaces.map((surface) => {
          const copy = { ...surface };
          delete copy.box;
          return copy;
        }),
      };
      const input = await lib.prepareFluxImage(blob);
      return {
        capture: await dataUrl(blob),
        input: await dataUrl(input),
        layout,
        surfaceBoxes,
        mask: { width: mask.width, height: mask.height, regions: mask.regions, data: Array.from(mask.data) },
        scenes: { current, new: grounding.scene },
        valid: {
          current: lib.fluxSceneSchema.safeParse(current).success,
          new: lib.fluxSceneSchema.safeParse(grounding.scene).success,
        },
        prompts: { current: lib.buildFluxPrompt(current), new: lib.buildFluxPrompt(grounding.scene) },
      };
    } finally {
      viewer.dispose();
    }
  });
  if (errors.length) throw new Error(errors.join('\n'));
  const png = (url: string) => Buffer.from(url.split(',')[1], 'base64');
  await writeFile(`${output}/capture.png`, png(r.capture));
  await writeFile(`${output}/input.png`, png(r.input));
  for (const name of ['current', 'new'] as const) {
    await writeFile(`${output}/prompt-${name}.txt`, r.prompts[name]);
    await writeFile(
      `${output}/scene-${name}.json`,
      JSON.stringify({ scene: r.scenes[name], layout: r.layout }, null, 2),
    );
  }
  const labels = Uint8Array.from(r.mask.data);
  await sharp(Buffer.from(labels), { raw: { width: r.mask.width, height: r.mask.height, channels: 1 } })
    .png()
    .toFile(`${output}/regions.png`);
  await writeFile(
    `${output}/regions.json`,
    JSON.stringify({ regions: r.mask.regions, surfaceBoxes: r.surfaceBoxes }, null, 2),
  );
  const summary = {
    gpu,
    valid: r.valid,
    input: [r.layout.width, r.layout.height],
    output: [r.layout.width * 2, r.layout.height * 2],
    regions: r.mask.regions.map((region, i) => ({
      ...region,
      share: +(labels.filter((label) => label === i + 1).length / labels.length).toFixed(3),
    })),
    promptLength: { current: r.prompts.current.length, new: r.prompts.new.length },
  };
  await writeFile(`${output}/summary.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
}
