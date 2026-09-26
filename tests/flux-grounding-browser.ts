/**
 * Real-WebGL check of the FLUX grounding: scene description and fixture boxes from the 2D
 * compositor and the 3D viewer, drawn over the actual 496px model input. No AI call.
 * Usage: node tests/run-browser-test.mjs tests/flux-grounding-browser.ts
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const output = 'test-results/flux-grounding';
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/room-viewer/renderer';export * from './src/lib/room-viewer/view-state';export {PhotoCompositor} from './src/lib/render/compositor';export {renderRoomBackground} from './src/lib/room-background';export {createRoomSurfaces,DEFAULT_ROOM} from './src/lib/room-geometry';export {projectRoomFixture} from './src/lib/room-fixtures';export {projectReconstructionFixture} from './src/lib/reconstruction/projection';export {buildFluxGrounding} from './src/lib/ai-export/scene';export {fluxInputLayout} from './src/lib/ai-export/contract';export {prepareFluxImage} from './src/lib/ai-export/client';export {buildFluxPrompt} from './src/lib/ai-export/prompt';export {fluxSceneSchema} from './src/lib/ai-export/scene-contract';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'Grounding',
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
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error') errors.push(e.text());
  });
  await page.route('http://127.0.0.1:43201/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }),
  );
  await page.goto('http://127.0.0.1:43201/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const results = await page.evaluate(async () => {
    type Lib = typeof import('../src/lib/room-viewer/renderer') &
      typeof import('../src/lib/room-viewer/view-state') &
      typeof import('../src/lib/render/compositor') &
      typeof import('../src/lib/room-background') &
      typeof import('../src/lib/room-geometry') &
      typeof import('../src/lib/room-fixtures') &
      typeof import('../src/lib/reconstruction/projection') &
      typeof import('../src/lib/ai-export/scene') &
      typeof import('../src/lib/ai-export/contract') &
      typeof import('../src/lib/ai-export/client') &
      typeof import('../src/lib/ai-export/prompt') &
      typeof import('../src/lib/ai-export/scene-contract');
    type AssetRecord = import('../src/lib/types').AssetRecord;
    type MaterialVersion = import('../src/lib/types').MaterialVersion;
    type FixtureInstance = import('../src/lib/types').FixtureInstance;
    type Scene = import('../src/lib/types').Scene;
    const lib = (window as unknown as { Grounding: Lib }).Grounding;
    const room = structuredClone(lib.DEFAULT_ROOM);
    const color = { exposure: 0, contrast: 1, saturation: 1, warmth: 0 };
    const empty = () => ({ polygon: [], strokes: [] });
    const assets: Record<string, AssetRecord> = {};
    const blobOf = (canvas: HTMLCanvasElement) =>
      new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
    const addAsset = async (
      id: string,
      canvas: HTMLCanvasElement,
      kind: 'texture' | 'product' | 'original',
    ) => {
      const blob = await blobOf(canvas);
      assets[id] = {
        id,
        ownerId: 'test',
        name: id,
        mime: 'image/png',
        size: blob.size,
        width: canvas.width,
        height: canvas.height,
        kind,
        blob,
        createdAt: '2026-09-25',
      };
    };
    const tile = document.createElement('canvas');
    tile.width = tile.height = 64;
    tile.getContext('2d')!.fillStyle = '#c9cbc6';
    tile.getContext('2d')!.fillRect(0, 0, 64, 64);
    await addAsset('stone', tile, 'texture');
    // A white one-piece toilet silhouette on transparency, as a background-removed product photo.
    const photo = document.createElement('canvas');
    photo.width = 256;
    photo.height = 400;
    const p = photo.getContext('2d')!;
    p.fillStyle = '#f4f3ef';
    p.fillRect(60, 20, 136, 150);
    p.beginPath();
    p.ellipse(128, 230, 100, 60, 0, 0, Math.PI * 2);
    p.fill();
    p.fillRect(88, 250, 80, 140);
    await addAsset('toilet-photo', photo, 'product');
    const background = await lib.renderRoomBackground(room, { width: 3600, height: 2400 });
    const bg = document.createElement('canvas');
    const bgBitmap = await createImageBitmap(background.blob);
    bg.width = bgBitmap.width;
    bg.height = bgBitmap.height;
    bg.getContext('2d')!.drawImage(bgBitmap, 0, 0);
    await addAsset('bg', bg, 'original');
    const material = (id: string, patch: Partial<MaterialVersion>): MaterialVersion => ({
      id,
      materialId: id,
      version: 1,
      name: id,
      brand: '',
      code: '',
      category: 'tile',
      scope: 'personal',
      description: '',
      color: '',
      finish: '',
      widthMm: 600,
      heightMm: 600,
      depthMm: 10,
      usage: 'both',
      installation: 'wall',
      textureAssetIds: [],
      views: [],
      defaultGroutWidth: 2,
      defaultGroutColor: '#ffffff',
      defaultPattern: 'grid',
      createdAt: '2026-09-25',
      ...patch,
    });
    const materials: Record<string, MaterialVersion> = {
      stone: material('stone', { textureAssetIds: ['stone'], finish: '무광' }),
      toilet: material('toilet', {
        category: 'toilet',
        installation: 'floor',
        widthMm: 380,
        heightMm: 720,
        depthMm: 690,
        finish: '유광',
        views: [{ assetId: 'toilet-photo', direction: '정면', anchor: { x: 0.5, y: 1 } }],
      }),
      standard: material('standard', { category: 'basin' }),
    };
    const fixture = (id: string, patch: Partial<FixtureInstance>): FixtureInstance => ({
      id,
      name: id,
      materialVersionId: 'standard',
      viewIndex: 0,
      position: { x: 0.5, y: 0.5 },
      width: 0.1,
      height: 0.1,
      rotation: 0,
      anchor: { x: 0.5, y: 1 },
      locked: false,
      shadow: { x: 0, y: 0, opacity: 0, blur: 0.01, scale: 1 },
      occlusion: empty(),
      color: { ...color },
      ...patch,
    });
    const placement = (
      face: 'floor' | 'back' | 'left',
      u: number,
      v: number,
      w: number,
      h: number,
      aspect: number,
    ) => ({
      face,
      u,
      v,
      scale: 1,
      widthMm: w,
      heightMm: h,
      imageAspect: aspect,
      contentBounds: { left: 0, right: 1, top: 0, bottom: 1 },
    });
    const fixtures = [
      fixture('toilet', {
        materialVersionId: 'toilet',
        roomPlacement: placement('floor', 0.78, 0.28, 380, 720, 256 / 400),
      }),
      fixture('basin', {
        roomPlacement: placement('left', 0.35, 0.62, 520, 200, 2.6),
        reconstruction: {
          version: 2,
          kind: 'basin',
          color: '#f2f1ec',
          widthMm: 520,
          heightMm: 200,
          depthMm: 420,
          baseHeightMm: 780,
          yawDegrees: 0,
          basinVariant: 'wall',
        },
      }),
      fixture('shower', {
        roomPlacement: placement('left', 0.8, 0.3, 200, 1100, 0.2),
        reconstruction: {
          version: 2,
          kind: 'shower',
          color: '#c8ccd0',
          widthMm: 200,
          heightMm: 1100,
          depthMm: 120,
          baseHeightMm: 900,
          yawDegrees: 0,
          showerVariant: 'handheld-rail',
        },
      }),
    ];
    const aspect = 1.5;
    for (const f of fixtures)
      if (f.reconstruction) lib.projectReconstructionFixture(room, f, aspect);
      else lib.projectRoomFixture(room, f, aspect);
    const makeScene = (wallFeatures?: Scene['wallFeatures']): Scene => ({
      room: structuredClone(room),
      originalAssetId: 'bg',
      previewAssetId: 'bg',
      imageWidth: 3600,
      imageHeight: 2400,
      surfaces: lib.createRoomSurfaces(room, aspect).map((s) => ({
        ...s,
        materialVersionId: 'stone',
        tile: { ...s.tile, groutWidth: 2, groutColor: '#d8d8d4' },
      })),
      fixtures: structuredClone(fixtures),
      ...(wallFeatures ? { wallFeatures } : {}),
      protection: empty(),
      color: { ...color },
    });
    const reader = async (id: string) => assets[id];
    async function ground(
      label: string,
      blob: Blob,
      snapshot: import('../src/lib/types').RenderSnapshot,
      boxes?: Record<string, [number, number, number, number]>,
    ) {
      const capture = await createImageBitmap(blob);
      const layout = lib.fluxInputLayout(capture.width, capture.height);
      const grounding = await lib.buildFluxGrounding({ snapshot, reader, capture, layout, boxes });
      capture.close();
      const input = await createImageBitmap(await lib.prepareFluxImage(blob));
      const canvas = document.createElement('canvas');
      canvas.width = input.width;
      canvas.height = input.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(input, 0, 0);
      ctx.lineWidth = 2;
      ctx.font = '12px sans-serif';
      for (const f of grounding.scene.fixtures) {
        const [l, t, r, b] = f.box;
        ctx.strokeStyle = '#e0245e';
        ctx.strokeRect(l * canvas.width, t * canvas.height, (r - l) * canvas.width, (b - t) * canvas.height);
        ctx.fillStyle = '#e0245e';
        ctx.fillText(f.kind, l * canvas.width, t * canvas.height - 3);
      }
      return {
        label,
        scene: grounding.scene,
        valid: lib.fluxSceneSchema.safeParse(grounding.scene).success,
        placed: grounding.placed,
        prompt: lib.buildFluxPrompt(grounding.scene),
        overlay: canvas.toDataURL('image/png'),
      };
    }
    const out = [];
    // 2D compositor path.
    {
      const snapshot = { scene: makeScene(), beforeScene: makeScene(), materials };
      const compositor = new lib.PhotoCompositor();
      try {
        await compositor.setSnapshot(snapshot, reader as never);
        const blob = await compositor.exportImage(snapshot, 1024, 1024, 'image/png', false);
        out.push(await ground('compositor', blob, snapshot));
      } finally {
        compositor.dispose();
      }
    }
    // 3D viewer path (a wall feature makes the editor use it), same view as the export.
    {
      const features = [
        {
          version: 1 as const,
          id: '6f1d2c3b-4a5e-4f60-8a71-92b3c4d5e6f7',
          kind: 'closed-niche' as const,
          face: 'back' as const,
          leftMm: 1300,
          topMm: 1000,
          widthMm: 600,
          heightMm: 400,
          depthMm: 150,
          source: 'user' as const,
        },
      ];
      const snapshot = { scene: makeScene(features), beforeScene: makeScene(features), materials };
      const viewer = new lib.RoomViewerRenderer();
      try {
        await viewer.setSnapshot(snapshot, reader);
        const view = lib.defaultRoomView();
        const blob = await viewer.export(view, { format: 'png', mode: 'after', longEdge: 1024 });
        const boxes = viewer.fixtureBounds(3600, 2400, view);
        out.push(await ground('viewer', blob, snapshot, boxes));
      } finally {
        viewer.dispose();
      }
    }
    return out;
  });
  assert.deepEqual(errors, [], errors.join('\n'));
  const summary = [];
  for (const result of results) {
    await writeFile(
      `${output}/${result.label}-boxes.png`,
      Buffer.from(result.overlay.split(',')[1], 'base64'),
    );
    await writeFile(`${output}/${result.label}-prompt.txt`, result.prompt);
    await writeFile(`${output}/${result.label}-scene.json`, JSON.stringify(result.scene, null, 2));
    assert.equal(result.valid, true, `${result.label} scene failed the server schema`);
    assert.deepEqual(
      result.scene.fixtures.map((f) => f.kind),
      ['toilet', 'basin', 'shower'],
      `${result.label} fixture order`,
    );
    assert.ok(
      result.scene.fixtures.every((f) => !('reference' in f)),
      `${result.label}: only text-able facts are sent, no product images`,
    );
    assert.doesNotMatch(
      result.prompt,
      /images? [1-9]/i,
      `${result.label}: the prompt refers to image 0 only`,
    );
    summary.push({
      label: result.label,
      fixtures: result.scene.fixtures.map((f) => ({
        kind: f.kind,
        box: f.box.map((v) => +v.toFixed(3)),
        color: f.color,
      })),
      surfaces: result.scene.surfaces,
      placed: result.placed,
      promptLength: result.prompt.length,
    });
  }
  await writeFile(`${output}/summary.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
}
