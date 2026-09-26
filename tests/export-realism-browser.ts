/**
 * Export realism stage 1: the same authored bathroom as an orbit frame, in-room eye views,
 * accumulated exports and photo effects, side by side with metrics. No AI, no network.
 * Usage: node tests/run-browser-test.mjs tests/export-realism-browser.ts [label] [--gpu] [--headed]
 * Writes test-results/export-realism-stage-1/<label>/.
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const label = process.argv.slice(3).find((arg) => !arg.startsWith('--')) ?? 'stage-1';
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('label must be lowercase letters, digits or dashes');
const gpu = process.argv.includes('--gpu');
const headed = process.argv.includes('--headed');
const output = `test-results/export-realism-stage-1/${label}`;
await mkdir(output, { recursive: true });
const power = (() => {
  try {
    return execFileSync(
      'powershell',
      ['-NoProfile', '-Command', '(Get-CimInstance Win32_Battery | Select-Object -First 1).BatteryStatus'],
      { encoding: 'utf8' },
    ).trim();
  } catch {
    return 'unknown';
  }
})();

const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/room-viewer/renderer';export * from './src/lib/room-viewer/view-state';export {createRoomSurfaces,DEFAULT_ROOM} from './src/lib/room-geometry';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'Realism',
});
const browser = await chromium.launch({
  channel: 'chrome',
  headless: !headed,
  args: gpu
    ? ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu']
    : ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
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
      typeof import('../src/lib/room-geometry');
    type MaterialVersion = import('../src/lib/types').MaterialVersion;
    type Scene = import('../src/lib/types').Scene;
    type AssetRecord = import('../src/lib/types').AssetRecord;
    type FixtureInstance = import('../src/lib/types').FixtureInstance;
    type RoomViewState = import('../src/lib/room-viewer/view-state').RoomViewState;
    const lib = (window as unknown as { Realism: Lib }).Realism;
    const room = structuredClone(lib.DEFAULT_ROOM);
    const color = { exposure: 0, contrast: 1, saturation: 1, warmth: 0 };
    const empty = () => ({ polygon: [], strokes: [] });
    const assets: Record<string, AssetRecord> = {};
    const materials: Record<string, MaterialVersion> = {};
    const tiles = {
      wall: { fill: '#ecebe6', w: 300, h: 600, finish: '무광' },
      floor: { fill: '#8e8b85', w: 600, h: 600, finish: '무광' },
    } as const;
    for (const [id, tile] of Object.entries(tiles)) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = tile.fill;
      ctx.fillRect(0, 0, 64, 64);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!)));
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
        createdAt: '2026-09-26',
      };
      materials[id] = {
        id,
        materialId: id,
        version: 1,
        name: id,
        brand: '',
        code: '',
        category: 'tile',
        scope: 'personal',
        description: '',
        color: tile.fill,
        finish: tile.finish,
        widthMm: tile.w,
        heightMm: tile.h,
        depthMm: 9,
        usage: 'both',
        installation: 'wall',
        textureAssetIds: [id],
        views: [],
        defaultGroutWidth: 2,
        defaultGroutColor: '#dddddd',
        defaultPattern: 'grid',
        createdAt: '2026-09-26',
      };
    }
    materials.standard = { ...materials.wall, id: 'standard', materialId: 'standard', category: 'toilet' };
    const fixture = (
      id: string,
      kind: string,
      face: 'floor' | 'back',
      u: number,
      v: number,
      w: number,
      h: number,
      d: number,
      base = 0,
    ): FixtureInstance => ({
      id,
      name: id,
      materialVersionId: 'standard',
      viewIndex: 0,
      position: { x: 0.5, y: 0.5 },
      width: 0.2,
      height: 0.4,
      rotation: 0,
      anchor: { x: 0.5, y: 1 },
      locked: false,
      shadow: { x: 0, y: 0, opacity: 0, blur: 0.01, scale: 1 },
      occlusion: empty(),
      color: { ...color },
      roomPlacement: {
        face,
        u,
        v,
        scale: 1,
        widthMm: w,
        heightMm: h,
        imageAspect: w / h,
        contentBounds: { left: 0, right: 1, top: 0, bottom: 1 },
      },
      reconstruction: {
        version: 2,
        kind,
        color: '#f2f1ec',
        widthMm: w,
        heightMm: h,
        depthMm: d,
        baseHeightMm: base,
        yawDegrees: 0,
      },
    });
    const basin = fixture('basin', 'basin', 'back', 0.28, 0.62, 600, 220, 430, 800);
    basin.reconstruction!.basinVariant = 'wall';
    const scene: Scene = {
      room: structuredClone(room),
      originalAssetId: 'none',
      previewAssetId: 'none',
      imageWidth: 3600,
      imageHeight: 2400,
      surfaces: lib.createRoomSurfaces(room, 1.5).map((s) => ({
        ...s,
        materialVersionId: s.roomFace === 'floor' ? 'floor' : 'wall',
        tile: {
          ...s.tile,
          groutWidth: 2,
          groutColor: s.roomFace === 'floor' ? '#6f6c66' : '#d9d8d2',
          pattern: 'grid',
          seed: 11,
        },
      })),
      fixtures: [
        fixture('toilet', 'toilet', 'floor', 0.72, 0.28, 400, 750, 680),
        basin,
        fixture('mirror', 'mirror', 'back', 0.28, 0.25, 700, 550, 30, 1300),
        fixture('bath', 'bath', 'floor', 0.3, 0.3, 750, 520, 1500),
      ],
      protection: empty(),
      color: { ...color },
    };
    const snapshot = { scene, beforeScene: structuredClone(scene), materials };
    const viewer = new lib.RoomViewerRenderer();
    const images: Record<string, string> = {};
    const metrics: Record<string, unknown> = {};
    const toImage = async (blob: Blob) => {
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      return { canvas, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
    };
    // The viewer's clear colour outside the room (#e8e8e4); an in-room view must never show it.
    const backgroundRatio = (data: Uint8ClampedArray) => {
      let hits = 0;
      for (let i = 0; i < data.length; i += 4)
        if (
          Math.abs(data[i] - 232) <= 1 &&
          Math.abs(data[i + 1] - 232) <= 1 &&
          Math.abs(data[i + 2] - 228) <= 1
        )
          hits++;
      return hits / (data.length / 4);
    };
    try {
      await viewer.setSnapshot(snapshot, async (id) => assets[id]);
      const views: [string, RoomViewState][] = [
        ['orbit-front', lib.defaultRoomView()],
        ['eye-center', lib.roomEyeView(room, 'center')],
        ['eye-left-corner', lib.roomEyeView(room, 'left-corner')],
        ['eye-right-corner', lib.roomEyeView(room, 'right-corner')],
      ];
      for (const [name, view] of views) {
        const started = performance.now();
        const blob = await viewer.export(view, { format: 'png', mode: 'after', longEdge: 1536 });
        const ms = performance.now() - started;
        const { canvas, data } = await toImage(blob);
        images[name] = canvas.toDataURL('image/png');
        metrics[name] = {
          ms,
          width: canvas.width,
          height: canvas.height,
          backgroundRatio: backgroundRatio(data),
        };
        if (name.startsWith('eye')) {
          // fixtureBounds must follow the in-room camera: draw the boxes FLUX would receive.
          const boxes = viewer.fixtureBounds(canvas.width, canvas.height, view);
          const ctx = canvas.getContext('2d')!;
          ctx.strokeStyle = '#e0245e';
          ctx.lineWidth = 3;
          for (const [, [l, t, r, b]] of Object.entries(boxes))
            ctx.strokeRect(
              l * canvas.width,
              t * canvas.height,
              (r - l) * canvas.width,
              (b - t) * canvas.height,
            );
          images[`${name}-boxes`] = canvas.toDataURL('image/png');
          (metrics[name] as Record<string, unknown>).fixtureBoxes = Object.keys(boxes);
        }
      }
      // Probe: saturated walls, floor, fixtures and ceiling-free colours, so a pixel with the
      // background colour can only be background (white tiles and fixtures can match it by chance).
      const probeMaterials = structuredClone(materials);
      probeMaterials.wall.color = '#2050c0';
      probeMaterials.floor.color = '#20a040';
      for (const [id, fill] of [
        ['wall', '#2050c0'],
        ['floor', '#20a040'],
      ] as const) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 64;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = fill;
        ctx.fillRect(0, 0, 64, 64);
        assets[id + '-probe'] = {
          ...assets[id],
          id: id + '-probe',
          blob: await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!))),
        };
        probeMaterials[id].textureAssetIds = [id + '-probe'];
      }
      const probeScene = structuredClone(scene);
      for (const f of probeScene.fixtures) f.reconstruction!.color = '#c02020';
      const probe = new lib.RoomViewerRenderer();
      try {
        await probe.setSnapshot(
          { scene: probeScene, beforeScene: structuredClone(probeScene), materials: probeMaterials },
          async (id) => assets[id],
        );
        for (const [name, view] of views.filter(([name]) => name.startsWith('eye'))) {
          const { canvas, data } = await toImage(
            await probe.export(view, { format: 'png', mode: 'after', longEdge: 1024 }),
          );
          images[name + '-probe'] = canvas.toDataURL('image/png');
          (metrics[name] as Record<string, unknown>).probeBackgroundRatio = backgroundRatio(data);
        }
      } finally {
        probe.dispose();
      }
      const compare = await toImage(
        await viewer.export(lib.roomEyeView(room, 'center'), {
          format: 'png',
          mode: 'compare',
          longEdge: 2048,
        }),
      );
      images['eye-center-compare'] = compare.canvas.toDataURL('image/png');
      metrics['eye-center-compare'] = { backgroundRatio: backgroundRatio(compare.data) };
      const diagnostics = viewer.diagnostics();
      return { images, metrics, gpu: diagnostics.gpu };
    } finally {
      viewer.dispose();
    }
  });
  assert.deepEqual(errors, [], errors.join('\n'));
  for (const [name, url] of Object.entries(result.images))
    await writeFile(`${output}/${name}.png`, Buffer.from(url.split(',')[1], 'base64'));
  const report = { label, gpu: result.gpu, power, headed, metrics: result.metrics };
  await writeFile(`${output}/metrics.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  for (const [name, value] of Object.entries(result.metrics))
    if ('probeBackgroundRatio' in (value as object))
      assert.equal(
        (value as { probeBackgroundRatio: number }).probeBackgroundRatio,
        0,
        `${name} shows space outside the room`,
      );
} finally {
  await browser.close();
}
