/** Real WebGL renderer checks on authored functional fixtures, not AI inference. */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const output = 'test-results/room-viewer-20260914/renderer/post-lut';
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/room-viewer/renderer';export * from './src/lib/room-viewer/view-state';export {createRoomSurfaces,DEFAULT_ROOM} from './src/lib/room-geometry';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'RoomTest',
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
  await page.route('http://127.0.0.1:43195/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body style="margin:0;background:#eee"></body></html>',
    }),
  );
  await page.goto('http://127.0.0.1:43195/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    const lib = (
      window as unknown as {
        RoomTest: typeof import('../src/lib/room-viewer/renderer') &
          typeof import('../src/lib/room-viewer/view-state') &
          typeof import('../src/lib/room-geometry');
      }
    ).RoomTest;
    const check = (condition: unknown, message: string) => {
      if (!condition) throw new Error(message);
    };
    const assets: Record<string, import('../src/lib/types').AssetRecord> = {};
    const color = { exposure: 0, contrast: 1, saturation: 1, warmth: 0 };
    for (const [id, hex] of [
      ['blue', '#185bc6'],
      ['orange', '#de6520'],
      ['white', '#f5f5f5'],
    ]) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = hex;
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
        createdAt: '2026-09-14',
      };
    }
    const material = (id: string): import('../src/lib/types').MaterialVersion => ({
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
      finish: '',
      widthMm: 300,
      heightMm: 600,
      depthMm: 10,
      usage: 'both',
      installation: 'wall',
      textureAssetIds: [id],
      views: [],
      defaultGroutWidth: 3,
      defaultGroutColor: '#ffffff',
      defaultPattern: 'grid',
      createdAt: '2026-09-14',
    });
    const materials = { blue: material('blue'), orange: material('orange') };
    const scene = (id: string): import('../src/lib/types').Scene => ({
      room: structuredClone(lib.DEFAULT_ROOM),
      originalAssetId: 'original',
      previewAssetId: 'preview',
      imageWidth: 1200,
      imageHeight: 800,
      surfaces: lib.createRoomSurfaces(lib.DEFAULT_ROOM).map((s) => ({
        ...s,
        materialVersionId: id,
        tile: { ...s.tile, shading: 0, groutWidth: 10, pattern: 'brick', rotation: 15, seed: 73 },
      })),
      fixtures: [],
      protection: { polygon: [], strokes: [] },
      color: { ...color },
    });
    const input = { scene: scene('orange'), beforeScene: scene('blue'), materials };
    const original = JSON.stringify(input),
      readerCalls: string[] = [];
    const reader = async (id: string) => {
      readerCalls.push(id);
      return assets[id];
    };
    const engine = new lib.RoomViewerRenderer();
    document.body.append(engine.canvas);
    const start = performance.now();
    await engine.setSnapshot(input, reader);
    const preparationMs = performance.now() - start;
    const read = () => {
      const c = document.createElement('canvas');
      c.width = engine.canvas.width;
      c.height = engine.canvas.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(engine.canvas, 0, 0);
      return ctx.getImageData(0, 0, c.width, c.height).data;
    };
    const views: Record<string, string> = {},
      base = lib.defaultRoomView();
    engine.render(900, 600, base, 'after');
    const baseline = engine.canvas.toDataURL();
    views.front = baseline;
    let view = base;
    const names = ['right', 'back', 'left', 'front-again'];
    for (let i = 0; i < 4; i++) {
      view = lib.rotateRoomView(view, 'right');
      engine.render(900, 600, view, 'after');
      views[names[i]] = engine.canvas.toDataURL();
    }
    check(views['front-again'] === baseline, 'Four rotations changed fixed tile/scene pixels');
    for (const direction of ['up', 'down'] as const) {
      engine.render(900, 600, lib.rotateRoomView(base, direction), 'after');
      views[direction] = engine.canvas.toDataURL();
    }
    check(views.up !== baseline && views.down !== baseline, 'Top/underside were flat image rotations');
    engine.render(900, 600, base, 'before');
    const before = read();
    engine.render(900, 600, base, 'after');
    const after = read();
    const index = (300 * 900 + 450) * 4;
    check(before[index + 2] > before[index] * 1.5, 'Blue tile shader did not render');
    check(after[index] > after[index + 2] * 1.5, 'Orange tile shader did not render');
    engine.render(900, 600, base, 'split', 0.5);
    const split = read();
    for (const x of [250, 650]) {
      const p = (300 * 900 + x) * 4,
        expected = x < 450 ? before : after;
      check(
        [0, 1, 2].every((c) => Math.abs(split[p + c] - expected[p + c]) <= 1),
        'Split camera alignment differs',
      );
    }
    const same = { ...input, beforeScene: structuredClone(input.scene) };
    await engine.setSnapshot(same, reader);
    engine.render(1200, 400, base, 'compare');
    const compare = read();
    let maximumPanelDifference = 0;
    for (let y = 0; y < 400; y++)
      for (let x = 0; x < 600; x++)
        for (let c = 0; c < 3; c++)
          maximumPanelDifference = Math.max(
            maximumPanelDifference,
            Math.abs(compare[(y * 1200 + x) * 4 + c] - compare[(y * 1200 + x + 600) * 4 + c]),
          );
    check(maximumPanelDifference <= 1, 'Side-by-side panels are not using same camera pixels');
    const first = engine.diagnostics();
    const priced = structuredClone(same);
    priced.materials.orange.pricing = {
      unit: 'box',
      unitPrice: 30000,
      boxCoverageM2: 1.44,
      piecesPerBox: 8,
      wastePercent: 0,
    };
    await engine.setSnapshot(priced, reader);
    check(engine.diagnostics().preparations === first.preparations, 'Price-only update rebuilt scene');
    const beforeExport = engine.canvas.toDataURL();
    const png = await engine.export(lib.rotateRoomView(base, 'up'), {
      format: 'png',
      mode: 'compare',
      longEdge: 4096,
    });
    check(engine.canvas.toDataURL() === beforeExport, 'Export changed preview dimensions/view');
    const bitmap = await createImageBitmap(png);
    check(bitmap.width === 1200 && bitmap.height === 400, 'Original/total comparison export limit failed');
    bitmap.close();
    const jpeg = await engine.export(base, { format: 'jpeg', mode: 'after', longEdge: 600 });
    check(jpeg.type === 'image/jpeg', 'JPG encoding failed');
    let state = base;
    const rotationMs: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t = performance.now();
      state = lib.rotateRoomView(state, 'right');
      engine.render(900, 600, state, 'compare');
      read();
      rotationMs.push(performance.now() - t);
    }
    const final = engine.diagnostics();
    check(
      final.preparations === first.preparations && final.textures === first.textures,
      'Rotation regenerated assets or leaked textures',
    );
    check(JSON.stringify(input) === original, 'Source mutated unexpectedly');
    check(readerCalls.length === 2, 'Unnecessary tile decode/download');
    const diagnostics = engine.diagnostics();
    // Variant selection and original mm offsets must remain stable across a full turn.
    const variants = structuredClone(input);
    variants.materials.orange.textureAssetIds = ['orange', 'white'];
    await engine.setSnapshot(variants, reader);
    engine.render(900, 600, base, 'after');
    const variantFront = engine.canvas.toDataURL();
    let variantView = base;
    for (let i = 0; i < 4; i++) variantView = lib.rotateRoomView(variantView, 'left');
    engine.render(900, 600, variantView, 'after');
    check(engine.canvas.toDataURL() === variantFront, 'Seeded variants shifted after full turn');
    // A late old design must not replace the latest active design.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = structuredClone(input);
    slow.materials.orange.textureAssetIds = ['slow'];
    const oldRequest = engine.setSnapshot(slow, async (id) => {
      if (id === 'slow') {
        await gate;
        return { ...assets.white, id: 'slow' };
      }
      return assets[id];
    });
    await engine.setSnapshot(input, reader);
    engine.render(900, 600, base, 'after');
    const newest = engine.canvas.toDataURL();
    release();
    await oldRequest;
    engine.render(900, 600, base, 'after');
    check(engine.canvas.toDataURL() === newest, 'Late old design replaced current rendering');
    // Asset failures are shown separately, and only the failed material becomes neutral.
    const missing = structuredClone(input);
    missing.materials.orange.textureAssetIds = ['missing'];
    await engine.setSnapshot(missing, reader);
    check(
      engine.notices.some(
        (n) => n.side === 'after' && n.severity === 'error' && n.message.includes('missing'),
      ),
      'Missing texture was silently hidden',
    );
    engine.render(900, 600, base, 'before');
    check(engine.canvas.toDataURL() !== '', 'Valid Before lost due to After failure');
    // Download locks pixels synchronously while a later view is allowed to change.
    await engine.setSnapshot(input, reader);
    engine.render(600, 400, base, 'after');
    const lockedExpected = engine.canvas.toDataURL();
    const lockedPng = engine.export(base, { format: 'png', mode: 'after', longEdge: 600 });
    engine.render(600, 400, lib.rotateRoomView(base, 'up'), 'after');
    const lockedBlob = await lockedPng,
      lockedImage = await createImageBitmap(lockedBlob);
    const copied = document.createElement('canvas');
    copied.width = 600;
    copied.height = 400;
    copied.getContext('2d')!.drawImage(lockedImage, 0, 0);
    lockedImage.close();
    check(copied.toDataURL() === lockedExpected, 'Download mixed with a later view');
    engine.dispose();
    await Promise.resolve();
    check(engine.diagnostics().contexts === 0, 'WebGL context not disposed');
    return {
      preparationMs,
      rotationMs,
      diagnostics,
      disposal: engine.diagnostics(),
      maximumPanelDifference,
      checks: 19,
      views,
      png: await png.arrayBuffer().then((b) => Array.from(new Uint8Array(b))),
      jpeg: await jpeg.arrayBuffer().then((b) => Array.from(new Uint8Array(b))),
    };
  });
  assert.equal(errors.length, 0, errors.join('\n'));
  for (const [name, url] of Object.entries(result.views))
    await writeFile(`${output}/${name}.png`, Buffer.from(url.split(',')[1], 'base64'));
  await writeFile(`${output}/compare.png`, Buffer.from(result.png));
  await writeFile(`${output}/after.jpg`, Buffer.from(result.jpeg));
  const { views, png, jpeg, ...report } = result;
  await writeFile(
    `${output}/verification.json`,
    JSON.stringify(
      { ...report, outputCount: Object.keys(views).length + (png.length && jpeg.length ? 2 : 0), errors },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
