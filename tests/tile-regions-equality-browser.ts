/**
 * Scenes without wall regions must draw exactly as before the regions change: the 3D room
 * renderer (four views, its face mask) and the 2D compositor (after, its face mask) on plain faces,
 * height bands and wall features with bands. No AI call.
 *
 * node tests/run-browser-test.mjs tests/tile-regions-equality-browser.ts [label]
 * The label `baseline` (run on the code before the change) writes the reference hashes; any other
 * label compares with them and fails on a difference. Output: test-results/tile-regions/render-<label>/
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const label = process.argv[3] ?? 'current';
const root = 'test-results/tile-regions';
const output = `${root}/render-${label}`;
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/room-viewer/renderer'; export * from './src/lib/room-viewer/view-state'; export { createRoomSurfaces, DEFAULT_ROOM } from './src/lib/room-geometry'; export { applyRoomSurfaceBand } from './src/lib/room-surface-bands'; export { PhotoCompositor } from './src/lib/render/compositor';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'EqualityTest',
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
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error') errors.push(e.text());
  });
  await page.route('http://127.0.0.1:43211/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0"></body></html>' }),
  );
  await page.goto('http://127.0.0.1:43211/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    type Lib = typeof import('../src/lib/room-viewer/renderer') &
      typeof import('../src/lib/room-viewer/view-state') &
      typeof import('../src/lib/room-geometry') &
      typeof import('../src/lib/room-surface-bands') &
      typeof import('../src/lib/render/compositor');
    const lib = (window as unknown as { EqualityTest: Lib }).EqualityTest;
    type Scene = import('../src/lib/types').Scene;
    type Surface = import('../src/lib/types').Surface;
    const assets: Record<string, import('../src/lib/types').AssetRecord> = {};
    const image = async (
      id: string,
      width: number,
      height: number,
      draw: (c: CanvasRenderingContext2D) => void,
    ) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      draw(canvas.getContext('2d')!);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!)));
      assets[id] = {
        id,
        ownerId: 'test',
        name: id,
        mime: 'image/png',
        size: blob.size,
        width,
        height,
        kind: id === 'photo' ? 'original' : 'texture',
        blob,
        createdAt: '2026-10-22',
      };
    };
    // Two-tone tiles so a shifted grid or a wrong owner changes pixels.
    for (const [id, a, b] of [
      ['orange', '#de6520', '#f0a060'],
      ['blue', '#185bc6', '#6090e0'],
      ['green', '#2f8f4f', '#80c090'],
    ])
      await image(id, 64, 64, (c) => {
        c.fillStyle = a;
        c.fillRect(0, 0, 64, 64);
        c.fillStyle = b;
        c.fillRect(0, 0, 32, 32);
      });
    await image('photo', 1200, 800, (c) => {
      const g = c.createLinearGradient(0, 0, 1200, 800);
      g.addColorStop(0, '#a0a0a0');
      g.addColorStop(1, '#707070');
      c.fillStyle = g;
      c.fillRect(0, 0, 1200, 800);
    });
    const material = (
      id: string,
      widthMm: number,
      heightMm: number,
    ): import('../src/lib/types').MaterialVersion => ({
      id,
      materialId: id,
      version: 1,
      name: id,
      brand: '',
      code: '',
      category: 'tile',
      scope: 'personal',
      description: '',
      color: '#ffffff',
      finish: id === 'blue' ? 'glossy' : '',
      widthMm,
      heightMm,
      depthMm: 10,
      usage: 'both',
      installation: 'wall',
      textureAssetIds: [id],
      views: [],
      defaultGroutWidth: 3,
      defaultGroutColor: '#ffffff',
      defaultPattern: 'grid',
      createdAt: '2026-10-22',
    });
    const materials = {
      orange: material('orange', 300, 600),
      blue: material('blue', 200, 200),
      green: material('green', 600, 600),
    };
    const reader = async (id: string) => assets[id];
    const color = { exposure: 0, contrast: 1, saturation: 1, warmth: 0 };
    const room = { ...lib.DEFAULT_ROOM, widthMm: 2600, depthMm: 2200, heightMm: 2400 };
    const base = (): Scene => ({
      room: structuredClone(room),
      originalAssetId: 'photo',
      previewAssetId: 'photo',
      imageWidth: 1200,
      imageHeight: 800,
      surfaces: lib.createRoomSurfaces(room, 1.5).map((s, index) => ({
        ...s,
        id: '00000000-0000-4000-8000-00000000000' + index,
        materialVersionId: ['green', 'orange', 'blue', 'orange'][index],
        tile: {
          ...s.tile,
          shading: 0,
          groutWidth: 6,
          pattern: index === 1 ? 'brick' : 'grid',
          rotation: index === 3 ? 15 : 0,
          offsetX: 40,
          offsetY: -25,
          seed: 7 + index,
        },
      })),
      fixtures: [],
      protection: { polygon: [], strokes: [] },
      color: { ...color },
    });
    const banded = (): Scene => {
      const scene = base();
      const split = (face: string, cuts: number[], ids: (string | undefined)[]) => {
        const index = scene.surfaces.findIndex((s) => s.roomFace === face);
        const whole = scene.surfaces[index];
        const parts: Surface[] = ids.map((materialVersionId, i) => {
          const part = lib.applyRoomSurfaceBand(
            { ...structuredClone(whole), id: whole.id.slice(0, -2) + face.length + i, materialVersionId },
            { from: cuts[i], to: cuts[i + 1] },
          );
          if (!materialVersionId) delete part.materialVersionId;
          return part;
        });
        scene.surfaces.splice(index, 1, ...parts);
      };
      split('back', [0, 0.3, 0.7, 1], ['orange', 'blue', undefined]);
      split('left', [0, 0.5, 1], ['blue', 'green']);
      return scene;
    };
    const featured = (): Scene => {
      const scene = banded();
      scene.wallFeatures = [
        {
          version: 1,
          id: '10000000-0000-4000-8000-000000000001',
          kind: 'closed-niche',
          face: 'back',
          leftMm: 700,
          topMm: 600,
          widthMm: 600,
          heightMm: 600,
          depthMm: 150,
          source: 'user',
        },
        {
          version: 1,
          id: '10000000-0000-4000-8000-000000000002',
          kind: 'floor-alcove',
          face: 'left',
          leftMm: 900,
          topMm: 1300,
          widthMm: 700,
          depthMm: 400,
          source: 'user',
        },
        {
          version: 1,
          id: '10000000-0000-4000-8000-000000000003',
          kind: 'closed-niche',
          face: 'right',
          leftMm: 300,
          topMm: 1000,
          widthMm: 400,
          heightMm: 300,
          depthMm: 120,
          source: 'user',
        },
      ];
      return scene;
    };
    const digest = async (bytes: ArrayBufferView) =>
      [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    const readCanvas = (canvas: HTMLCanvasElement) => {
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const ctx = copy.getContext('2d')!;
      ctx.drawImage(canvas, 0, 0);
      return ctx.getImageData(0, 0, copy.width, copy.height).data;
    };
    const hashes: Record<string, string> = {},
      images: Record<string, string> = {};
    const scenes: [string, Scene][] = [
      ['plain', base()],
      ['bands', banded()],
      ['features', featured()],
    ];
    // 3D: the editor stage, the spatial viewer and the AI input all use this renderer.
    const engine = new lib.RoomViewerRenderer();
    document.body.append(engine.canvas);
    for (const [name, scene] of scenes) {
      await engine.setSnapshot({ scene, beforeScene: base(), materials }, reader);
      let view = lib.defaultRoomView();
      for (const direction of ['front', 'right', 'back', 'left']) {
        engine.render(900, 600, view, 'after');
        hashes[`3d-${name}-${direction}`] = await digest(readCanvas(engine.canvas));
        images[`3d-${name}-${direction}`] = engine.canvas.toDataURL();
        const mask = engine.regionMask(450, 300, view);
        hashes[`3d-${name}-${direction}-mask`] = await digest(mask.data);
        hashes[`3d-${name}-${direction}-regions`] = mask.regions.map((r) => r.key + ':' + r.kind).join(',');
        view = lib.rotateRoomView(view, 'right');
      }
      engine.render(1200, 400, lib.defaultRoomView(), 'compare');
      hashes[`3d-${name}-compare`] = await digest(readCanvas(engine.canvas));
      hashes[`3d-${name}-notices`] = JSON.stringify(engine.notices);
    }
    engine.dispose();
    // 2D: the editor stage, previews and downloads of a room without wall features.
    for (const [name, scene] of scenes.slice(0, 2)) {
      const compositor = new lib.PhotoCompositor();
      document.body.append(compositor.canvas);
      const snapshot = { scene, beforeScene: base(), materials };
      await compositor.setSnapshot(snapshot, reader);
      compositor.render(1200, 800, 'after');
      hashes[`2d-${name}-after`] = await digest(readCanvas(compositor.canvas));
      images[`2d-${name}-after`] = compositor.canvas.toDataURL();
      let mask: { data: Uint8Array; regions: { key: string }[] } | undefined;
      await compositor.exportImage(snapshot, 600, 400, 'image/png', false, (m) => (mask = m));
      hashes[`2d-${name}-mask`] = mask ? await digest(mask.data) : 'none';
      hashes[`2d-${name}-regions`] = mask ? mask.regions.map((r) => r.key).join(',') : 'none';
      compositor.dispose();
    }
    return { hashes, images };
  });
  if (errors.length) throw new Error(errors.join('\n'));
  for (const [name, url] of Object.entries(result.images))
    await writeFile(`${output}/${name}.png`, Buffer.from(url.split(',')[1], 'base64'));
  await writeFile(`${output}/hashes.json`, JSON.stringify(result.hashes, null, 2));
  const baselineFile = `${root}/render-baseline/hashes.json`;
  if (label !== 'baseline' && existsSync(baselineFile)) {
    const baseline = JSON.parse(await readFile(baselineFile, 'utf8')) as Record<string, string>;
    const different = Object.keys(baseline).filter((key) => baseline[key] !== result.hashes[key]);
    const added = Object.keys(result.hashes).filter((key) => !(key in baseline));
    console.log(JSON.stringify({ compared: Object.keys(baseline).length, different, added }, null, 2));
    if (different.length) throw new Error('기준과 다른 렌더: ' + different.join(', '));
  } else console.log(`기준 ${Object.keys(result.hashes).length}개를 ${output}에 저장했어요.`);
} finally {
  await browser.close();
}
