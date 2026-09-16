/** Production UI/WebGL/IndexedDB, synthetic support contract. No model inference or photo claims. */
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
type Modules = typeof import('../src/lib/room-viewer/renderer') &
  typeof import('../src/lib/room-viewer/view-state') &
  typeof import('../src/lib/room-viewer/render-snapshot') &
  typeof import('../src/lib/reconstruction/source-camera') &
  typeof import('../src/lib/reconstruction') &
  typeof import('../src/lib/room-background') &
  typeof import('../src/lib/images') &
  typeof import('../src/lib/repositories') &
  typeof import('../src/lib/editor-store') &
  typeof import('../src/lib/room-geometry') &
  typeof import('../src/lib/types') &
  typeof import('three') &
  typeof import('react') &
  typeof import('react-dom/client') & {
    RoomViewer: typeof import('../src/components/rooms/room-viewer').default;
  };
type TestWindow = Window & {
  test: {
    m: Modules;
    repo: ReturnType<typeof import('../src/lib/repositories').getRepositories>;
    reader: import('../src/lib/render/compositor').AssetReader;
    materials: Record<string, import('../src/lib/types').MaterialVersion>;
    root: import('react-dom/client').Root;
    source: import('../src/lib/reconstruction/source-camera').SourceCamera;
  };
};
const output = 'test-results/reconstruction-fifteen-rebuild/20260915-start/source-room-view';
const bundle = await build({
  stdin: {
    contents: `
export {default as RoomViewer} from './src/components/rooms/room-viewer';
export {RoomViewerRenderer} from './src/lib/room-viewer/renderer';
export {renderRoomSnapshotImage} from './src/lib/room-viewer/render-snapshot';
export * from './src/lib/room-viewer/view-state';
export {createSourceCamera} from './src/lib/reconstruction/source-camera';
export {createReconstructionFixture} from './src/lib/reconstruction';
export {renderRoomBackground} from './src/lib/room-background';
export {makeAsset} from './src/lib/images';
export {getRepositories} from './src/lib/repositories';
export {useEditor} from './src/lib/editor-store';
export {DEFAULT_ROOM,createRoomSurfaces} from './src/lib/room-geometry';
export {DEFAULT_COLOR,EMPTY_MASK} from './src/lib/types';
export {createRoot} from 'react-dom/client';export {createElement} from 'react';
export {PerspectiveCamera,Vector3} from 'three';
`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  outfile: 'bundle.js',
  plugins: [
    {
      name: 'next-image-interop',
      setup(b) {
        b.onResolve({ filter: /^next\/image$/ }, () => ({ path: 'next-image', namespace: 'image' }));
        b.onLoad({ filter: /.*/, namespace: 'image' }, () => ({
          loader: 'js',
          resolveDir: process.cwd(),
          contents: "export {Image as default} from 'next/dist/client/image-component';",
        }));
      },
    },
  ],
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.NEXT_PUBLIC_STORAGE_MODE': '"local"',
    'process.env': '{}',
  },
});
const js = bundle.outputFiles.find((f) => f.path.endsWith('.js'))!.text,
  css = bundle.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '';
const server = createServer((req, res) => {
  res.setHeader(
    'Content-Type',
    req.url === '/bundle.js' ? 'text/javascript' : req.url === '/bundle.css' ? 'text/css' : 'text/html',
  );
  res.end(
    req.url === '/bundle.js'
      ? js
      : req.url === '/bundle.css'
        ? css
        : '<html lang="ko"><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/bundle.css"><style>body{font:16px sans-serif;margin:20px}main{max-width:450px}#render img{max-width:100%}</style><h1>거울 외곽·개방형 상판 모형 검증</h1><p>합성 계약 테스트 입력. 실제 AI 인식이나 실측 결과 아님.</p><main></main><div id="render"></div></html>',
  );
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  await mkdir(output, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } }),
    errors: string[] = [],
    requests: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(origin);
  const initial = await page.evaluate(async (base) => {
    const m = (await import(base + '/bundle.js')) as Modules,
      repo = m.getRepositories(),
      room = m.DEFAULT_ROOM;
    const toilet = await m.createReconstructionFixture({
      kind: 'toilet',
      version: 2,
      room,
      face: 'floor',
      u: 0.65,
      v: 0.2,
      widthMm: 390,
      heightMm: 780,
      depthMm: 650,
      color: '#e5e1d8',
      aspect: 1.5,
    });
    const basin = await m.createReconstructionFixture({
      kind: 'basin',
      version: 2,
      room,
      face: 'back',
      u: 0.28,
      v: 0.65,
      baseHeightMm: 700,
      widthMm: 600,
      heightMm: 210,
      depthMm: 450,
      color: '#eeeeeb',
      basinVariant: 'wall',
      aspect: 1.5,
    });
    const bg = await m.renderRoomBackground(room, { width: 1200, height: 800 }),
      asset = await m.makeAsset(bg.blob, 'source-view-contract.png', 'original');
    await repo.assets.put(asset);
    const materials: Record<string, import('../src/lib/types').MaterialVersion> = {};
    for (const f of [toilet, basin])
      materials[f.materialVersionId] = (await repo.materials.getVersion(f.materialVersionId))!;
    const blank = {
        room,
        originalAssetId: asset.id,
        previewAssetId: asset.id,
        imageWidth: 1200,
        imageHeight: 800,
        surfaces: m.createRoomSurfaces(room),
        fixtures: [toilet, basin],
        protection: m.EMPTY_MASK(),
        color: { ...m.DEFAULT_COLOR },
      },
      stamp = new Date().toISOString();
    m.useEditor.getState().load({
      id: crypto.randomUUID(),
      ownerId: 'local',
      name: '사진 시점 계약 검증',
      schemaVersion: 2,
      scene: blank,
      comparison: {
        before: structuredClone(blank),
        room,
        aspect: 1.5,
        cameraVersion: 1,
        status: 'draft',
        referenceOriginalAssetId: asset.id,
        referencePreviewAssetId: asset.id,
      },
      editRevision: 0,
      storageRevision: 0,
      createdAt: stamp,
      updatedAt: stamp,
      viewport: { zoom: 1, pan: { x: 0, y: 0 } },
      history: { past: [], future: [] },
    });
    const camera = new m.PerspectiveCamera(64, 960 / 1280, 0.1, 1e7);
    camera.position.set(250, 1550, 2900);
    camera.lookAt(0, 1000, 300);
    camera.updateMatrixWorld(true);
    const source: import('../src/lib/reconstruction/source-camera').SourceCamera = {
        version: 1,
        positionMm: camera.position.toArray() as [number, number, number],
        quaternion: camera.quaternion.toArray() as [number, number, number, number],
        verticalFovDegrees: 64,
        image: { width: 960, height: 1280 },
      },
      view = m.sourceRoomView(source, room);
    m.useEditor.getState().setRoomView(view);
    const project = await repo.projects.create(m.useEditor.getState().project!);
    m.useEditor.getState().load(project);
    const reader = async (id: string) => {
      const a = await repo.assets.get(id);
      if (!a) throw Error('Missing asset ' + id);
      return a;
    };
    function App() {
      const p = m.useEditor((s) => s.project!);
      return m.createElement(m.RoomViewer, {
        project: p,
        materials,
        assetReader: reader,
        writable: true,
        onView: (v: import('../src/lib/room-viewer/view-state').RoomViewState) =>
          m.useEditor.getState().setRoomView(v),
        saveStatus: m.useEditor((s) => s.saveStatus),
        saveError: '',
        onSave: async () => {
          const latest = m.useEditor.getState().project!;
          const saved = await repo.projects.save(latest, latest.storageRevision);
          m.useEditor.getState().saved(saved);
        },
        onDesign: (id: string) => m.useEditor.getState().selectDesign(id),
        onClose: () => m.useEditor.getState().load(m.useEditor.getState().project!),
      });
    }
    const root = m.createRoot(document.querySelector('main')!);
    root.render(m.createElement(App));
    Object.assign(window, { test: { m, repo, reader, materials, root, App, source, view, project } });
    return { view, source, id: project.id, editRevision: project.editRevision };
  }, origin);
  await expect(page.getByTestId('room-view-viewport')).toHaveAttribute('aria-busy', 'false', {
    timeout: 30000,
  });
  await expect(page.getByRole('button', { name: '사진 시점 보기', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.screenshot({ path: output + '/ui-source.png' });
  const pixels = await page.evaluate(async () => {
    const t = (window as unknown as TestWindow).test,
      m = t.m,
      p = m.useEditor.getState().project!,
      scene = p.designs[0].scene;
    const snapshot = {
      scene,
      beforeScene: p.shared.comparison!.before,
      materials: t.materials,
      roomView: p.roomView!,
    };
    const renderer = new m.RoomViewerRenderer();
    await renderer.setSnapshot(snapshot, t.reader);
    const png = (c: HTMLCanvasElement) => c.toDataURL('image/png');
    const read = (c: CanvasImageSource, w: number, h: number) => {
      const copy = document.createElement('canvas');
      copy.width = w;
      copy.height = h;
      const ctx = copy.getContext('2d')!;
      ctx.drawImage(c, 0, 0);
      return ctx.getImageData(0, 0, w, h).data;
    };
    const canvas = renderer.render(1200, 800, p.roomView!, 'before'),
      sourceImage = png(canvas),
      a = read(canvas, 1200, 800);
    const info = renderer.diagnostics(),
      preparations = info.preparations;
    const blob = await m.renderRoomSnapshotImage(snapshot, t.reader, {
      renderer: 'room-view',
      mode: 'before',
      longEdge: 1200,
    });
    const bitmap = await createImageBitmap(blob),
      b = read(bitmap, bitmap.width, bitmap.height);
    bitmap.close();
    let mismatches = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) mismatches++;
    const compare = renderer.render(1200, 400, p.roomView!, 'compare'),
      c = read(compare, 1200, 400);
    let halfDiff = 0,
      halfMaxError = 0;
    for (let y = 0; y < 400; y++)
      for (let x = 0; x < 600; x++)
        for (let k = 0; k < 4; k++) {
          const difference = Math.abs(c[(y * 1200 + x) * 4 + k] - c[(y * 1200 + x + 600) * 4 + k]);
          if (difference) halfDiff++;
          halfMaxError = Math.max(halfMaxError, difference);
        }
    const compareImage = png(compare),
      legacyImage = png(renderer.render(1200, 800, m.resetRoomView(p.roomView!, 'room-fit'), 'before'));
    let rotated = p.roomView!;
    for (let i = 0; i < 4; i++) {
      rotated = m.rotateRoomView(rotated, 'up');
      renderer.render(1200, 800, rotated, 'before');
    }
    const recovered = read(renderer.canvas, 1200, 800);
    let fourTurnDiff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== recovered[i]) fourTurnDiff++;
    const corners = [-1200, 1200].flatMap((x) =>
      [0, 2400].flatMap((y) => [0, 2400].map((z) => new m.Vector3(x, y, z))),
    );
    const expected = m.createSourceCamera(t.source),
      actual = m.createRoomViewCamera(scene.room!, 1.5, p.roomView!);
    const cornerErrors = corners.map((p) =>
      p.clone().project(actual).distanceTo(p.clone().project(expected)),
    );
    const after = renderer.diagnostics();
    renderer.dispose();
    const disposed = renderer.diagnostics();
    const firstPixel = Array.from(a.slice(0, 4)),
      centerPixel = Array.from(a.slice((400 * 1200 + 600) * 4, (400 * 1200 + 600) * 4 + 4));
    return {
      sourceImage,
      compareImage,
      legacyImage,
      mismatches,
      halfDiff,
      halfMaxError,
      fourTurnDiff,
      cornerErrors,
      firstPixel,
      centerPixel,
      info,
      after,
      disposed,
      preparations,
    };
  });
  for (const [key, name] of [
    ['sourceImage', 'source'],
    ['compareImage', 'compare'],
    ['legacyImage', 'whole-room'],
  ] as const)
    await writeFile(output + '/' + name + '.png', Buffer.from(pixels[key].split(',')[1], 'base64'));
  assert.equal(pixels.mismatches, 0, 'PNG helper must match the same current render');
  assert.ok(
    pixels.halfDiff <= 16 && pixels.halfMaxError <= 1,
    'identical comparison optics, only <=16 of 960000 one-byte shader-rounding differences permitted',
  );
  assert.equal(pixels.fourTurnDiff, 0, 'four turns recover every rendered pixel');
  assert.ok(pixels.cornerErrors.every((v) => v < 1e-12));
  assert.deepEqual(pixels.firstPixel, [232, 232, 228, 255]);
  assert.notDeepEqual(pixels.centerPixel, pixels.firstPixel);
  assert.equal(pixels.after.preparations, pixels.preparations);
  assert.equal(pixels.disposed.contexts, 0);
  const failureChecks = await page.evaluate(async () => {
    const t = (window as unknown as TestWindow).test,
      p = t.m.useEditor.getState().project!,
      original = JSON.stringify(p);
    const snapshot = {
      scene: p.designs[0].scene,
      beforeScene: p.shared.comparison!.before,
      materials: t.materials,
      roomView: p.roomView,
    };
    let missingBefore = '',
      webgl = '';
    try {
      await t.m.renderRoomSnapshotImage({ ...snapshot, beforeScene: undefined }, t.reader, {
        renderer: 'room-view',
        mode: 'before',
        longEdge: 800,
      });
    } catch (error) {
      missingBefore = String(error);
    }
    const getContext = HTMLCanvasElement.prototype.getContext;
    try {
      HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        id: string,
        settings?: unknown,
      ) {
        if (id === 'webgl2' || id === 'webgl' || id === 'experimental-webgl') return null;
        return Reflect.apply(getContext, this, [id, settings]);
      } as typeof getContext;
      try {
        await t.m.renderRoomSnapshotImage(snapshot, t.reader, {
          renderer: 'room-view',
          mode: 'before',
          longEdge: 800,
        });
      } catch (error) {
        webgl = String(error);
      }
    } finally {
      HTMLCanvasElement.prototype.getContext = getContext;
    }
    return { missingBefore, webgl, unchanged: original === JSON.stringify(t.m.useEditor.getState().project) };
  });
  assert.match(failureChecks.missingBefore, /Before/);
  assert.match(failureChecks.webgl, /WebGL/);
  assert.equal(failureChecks.unchanged, true);
  await page.getByRole('button', { name: '전체 공간 보기', exact: true }).click();
  await expect(page.getByRole('button', { name: '전체 공간 보기', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: '사진 시점 보기', exact: true }).click();
  await page.getByRole('button', { name: '오른쪽 90°', exact: true }).click();
  await page.getByRole('button', { name: '공간 확대', exact: true }).click();
  const viewport = page.getByTestId('room-view-viewport'),
    box = await viewport.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6 + 25, box.y + box.height * 0.6 + 30, { steps: 5 });
  await page.mouse.up();
  const saved = await page.evaluate(async () => {
    const t = (window as unknown as TestWindow).test,
      p = t.m.useEditor.getState().project!;
    await t.repo.projects.save(p, p.storageRevision);
    return { view: p.roomView!, scene: JSON.stringify(p.designs[0].scene), editRevision: p.editRevision };
  });
  assert.equal(saved.editRevision, initial.editRevision);
  const dragArea = await page.evaluate(() => {
    const t = (window as unknown as TestWindow).test;
    const rect = document
      .querySelector('[aria-label="현재 시점의 Before After 공간"]')!
      .getBoundingClientRect();
    return t.m.roomViewViewport(rect.width, rect.height, t.m.useEditor.getState().project!.roomView!);
  });
  assert.ok(
    Math.abs(saved.view!.pan.x * dragArea.width - 25) < 0.02,
    'pan follows horizontal mouse distance within letterbox',
  );
  assert.ok(
    Math.abs(saved.view!.pan.y * dragArea.height - 30) < 0.02,
    'pan follows vertical mouse distance within letterbox',
  );
  await page.reload();
  const reopened = await page.evaluate(
    async ({ base, id }) => {
      const m = (await import(base + '/bundle.js')) as Modules,
        repo = m.getRepositories(),
        p = await repo.projects.load(id);
      return { view: p.roomView!, scene: JSON.stringify(p.designs[0].scene) };
    },
    { base: origin, id: initial.id },
  );
  assert.deepEqual(reopened.view, saved.view);
  assert.equal(reopened.scene, saved.scene);
  // UI resize and restore use the real shared-store boundary, with fresh mount from IndexedDB.
  await page.evaluate(
    async ({ base, id }) => {
      const m = (await import(base + '/bundle.js')) as Modules,
        repo = m.getRepositories(),
        p = await repo.projects.load(id),
        materials: Record<string, import('../src/lib/types').MaterialVersion> = {};
      m.useEditor.getState().load(p);
      for (const f of p.designs[0].scene.fixtures)
        materials[f.materialVersionId] = (await repo.materials.getVersion(f.materialVersionId))!;
      const reader = async (id: string) => {
        const asset = await repo.assets.get(id);
        if (!asset) throw Error('Missing asset ' + id);
        return asset;
      };
      function App() {
        const project = m.useEditor((s) => s.project!);
        return m.createElement(m.RoomViewer, {
          project,
          materials,
          assetReader: reader,
          writable: true,
          onView: (v: import('../src/lib/room-viewer/view-state').RoomViewState) =>
            m.useEditor.getState().setRoomView(v),
          saveStatus: 'saved',
          saveError: '',
          onSave: () => {},
          onDesign: () => {},
          onClose: () => {},
        });
      }
      const root = m.createRoot(document.querySelector('main')!);
      root.render(m.createElement(App));
      Object.assign(window, { test: { m, repo, root, p } });
    },
    { base: origin, id: initial.id },
  );
  await expect(viewport).toHaveAttribute('aria-busy', 'false', { timeout: 30000 });
  await expect(page.getByRole('button', { name: '사진 시점 보기', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: '기본 시점', exact: true }).click();
  assert.deepEqual(JSON.parse((await viewport.getAttribute('data-view'))!), initial.view);
  await page.setViewportSize({ width: 420, height: 900 });
  await expect(page.getByRole('button', { name: '사진 시점 보기', exact: true })).toBeVisible();
  await page.screenshot({ path: output + '/mobile-source.png' });
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.getByRole('button', { name: '나란히 비교', exact: true }).click();
  const download = page.waitForEvent('download');
  await page
    .getByRole('button', { name: /다운로드/ })
    .last()
    .click();
  const file = await download;
  await file.saveAs(output + '/ui-download.png');
  await page.evaluate(() => {
    const t = (window as unknown as TestWindow).test,
      p = t.m.useEditor.getState().project!;
    t.m.useEditor.getState().resizeAll(
      { ...t.m.DEFAULT_ROOM, widthMm: 3000 },
      {
        originalAssetId: p.shared.baseline.originalAssetId,
        previewAssetId: p.shared.baseline.previewAssetId,
        imageWidth: 1200,
        imageHeight: 800,
      },
    );
  });
  await expect(page.getByRole('button', { name: '사진 시점 보기', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '전체 공간 보기', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.evaluate(() => {
    (window as unknown as TestWindow).test.m.useEditor.getState().restoreRoomChange();
  });
  await expect(page.getByRole('button', { name: '사진 시점 보기', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '사진 시점 보기', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.evaluate(() => {
    (window as unknown as TestWindow).test.m.useEditor.getState().redoRoomChange();
  });
  await expect(page.getByRole('button', { name: '전체 공간 보기', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // Dispose the UI, then independently verify checkpoint metadata.
  await page.evaluate(() => {
    const t = (window as unknown as TestWindow).test;
    t.root.unmount();
  });
  assert.deepEqual(
    await page.evaluate(() => {
      const t = (window as unknown as TestWindow).test;
      const resized = t.m.useEditor.getState().project!.roomView;
      t.m.useEditor.getState().restoreRoomChange();
      const restored = t.m.useEditor.getState().project!.roomView;
      t.m.useEditor.getState().redoRoomChange();
      return { resized, restored, redo: t.m.useEditor.getState().project!.roomView };
    }),
    {
      resized: { ...initial.view, projection: 'room-fit' },
      restored: initial.view,
      redo: { ...initial.view, projection: 'room-fit' },
    },
  );
  assert.deepEqual(errors, []);
  assert.ok(
    requests.every((url) => url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')),
  );
  const { sourceImage, compareImage, legacyImage, ...details } = pixels;
  void sourceImage;
  void compareImage;
  void legacyImage;
  await writeFile(
    output + '/verification.json',
    JSON.stringify(
      {
        source: 'authored functional scene, real UI/WebGL/IndexedDB; no AI inference',
        browser: await browser.version(),
        initial,
        saved,
        reopened,
        details,
        failureChecks,
        errors,
        requests,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      {
        pass: true,
        output,
        projectionError: Math.max(...pixels.cornerErrors),
        samePreviewPng: pixels.mismatches,
        sameBeforeAfter: pixels.halfDiff,
        fourTurnPixels: pixels.fourTurnDiff,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}
