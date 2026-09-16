/** Ten complete viewer lifetimes. Authored test assets, not AI output or total GPU-memory measurement. */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const isolateLut = process.env.SJN_RESOURCE_LUT_PROBE === '1';
const repetitions = isolateLut ? 3 : 10;
const output = `test-results/room-viewer-20260914/resource-cycles/${isolateLut ? 'lut-probe' : 'post-lut'}`;
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/room-viewer/renderer'; export * from './src/lib/room-viewer/view-state';export {createRoomSurfaces,DEFAULT_ROOM} from './src/lib/room-geometry'; export {WebGLRenderer,WebGLRenderTarget,BufferGeometry,Texture} from 'three';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'ResourceTest',
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
  const errors: string[] = [],
    externalRequests: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error') errors.push(e.text());
  });
  page.on('request', (r) => {
    if (!r.url().startsWith('http://127.0.0.1:43197/')) externalRequests.push(r.url());
  });
  await page.route('http://127.0.0.1:43197/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }),
  );
  await page.goto('http://127.0.0.1:43197/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const cdp = await page.context().newCDPSession(page);
  await page.evaluate(async (isolateLut) => {
    const lib = (
      window as unknown as {
        ResourceTest: typeof import('../src/lib/room-viewer/renderer') &
          typeof import('../src/lib/room-viewer/view-state') &
          typeof import('../src/lib/room-geometry');
      }
    ).ResourceTest;
    const color = { exposure: 0, contrast: 1, saturation: 1, warmth: 0 };
    const empty = () => ({ polygon: [], strokes: [] });
    const assets: Record<string, import('../src/lib/types').AssetRecord> = {};
    for (const [id, fill] of [
      ['tile', '#517b8b'],
      ['photo', '#8dce60'],
    ]) {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = fill;
      if (id === 'photo') {
        ctx.fillRect(60, 12, 136, 232);
        ctx.clearRect(74, 65, 108, 70);
      } else {
        ctx.fillRect(0, 0, 256, 256);
        ctx.fillStyle = '#597f86';
        ctx.fillRect(0, 0, 80, 256);
      }
      const blob = await new Promise<Blob>((resolve) => c.toBlob((b) => resolve(b!)));
      assets[id] = {
        id,
        ownerId: 'test',
        name: id,
        mime: 'image/png',
        size: blob.size,
        width: 256,
        height: 256,
        kind: id === 'photo' ? 'product' : 'texture',
        blob,
        createdAt: '2026-09-14',
      };
    }
    const tile: import('../src/lib/types').MaterialVersion = {
      id: 'tile',
      materialId: 'tile',
      version: 1,
      name: '테스트 타일',
      brand: '',
      code: '',
      category: 'tile',
      scope: 'personal',
      description: '',
      color: '#517b8b',
      finish: '',
      widthMm: 600,
      heightMm: 300,
      depthMm: 10,
      usage: 'both',
      installation: 'wall',
      textureAssetIds: ['tile'],
      views: [],
      defaultGroutWidth: 2,
      defaultGroutColor: '#dddddd',
      defaultPattern: 'grid',
      createdAt: '2026-09-14',
    };
    const material: import('../src/lib/types').MaterialVersion = {
      ...tile,
      id: 'photo',
      materialId: 'photo',
      name: '기능 검사 평면 제품',
      category: 'wallShelf',
      textureAssetIds: [],
      widthMm: 350,
      heightMm: 550,
      views: [{ assetId: 'photo', direction: '정면', anchor: { x: 0.5, y: 1 } }],
    };
    const fixture = (
      id: string,
      kind: string,
      u: number,
      v: number,
      w: number,
      h: number,
      d: number,
    ): import('../src/lib/types').FixtureInstance => ({
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
      shadow: { x: 0, y: 0, opacity: 0.3, blur: 0.01, scale: 1 },
      occlusion: empty(),
      color: { ...color },
      roomPlacement: {
        face: 'floor',
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
        color: '#eeeeea',
        widthMm: w,
        heightMm: h,
        depthMm: d,
        baseHeightMm: 0,
        yawDegrees: 0,
      },
    });
    const toilet = fixture('toilet', 'toilet', 0.25, 0.5, 400, 750, 680);
    const bath = fixture('bath', 'bath', 0.7, 0.35, 750, 500, 1400);
    const glass = fixture('glass', 'glassPartition', 0.65, 0.7, 950, 1500, 12);
    glass.reconstruction!.opacity = 0.18;
    const sink = fixture('wall-basin', 'basin', 0.25, 0.7, 600, 220, 430);
    sink.roomPlacement!.face = 'back';
    sink.reconstruction!.baseHeightMm = 800;
    sink.reconstruction!.basinVariant = 'wall';
    const mirror = fixture('mirror', 'mirror', 0.3, 0.2, 800, 550, 30);
    mirror.roomPlacement!.face = 'back';
    mirror.reconstruction!.baseHeightMm = 1350;
    const photo = fixture('photo-plane', '', 0.52, 0.72, 350, 550, 20);
    delete photo.reconstruction;
    photo.materialVersionId = 'photo';
    const after: import('../src/lib/types').Scene = {
      room: structuredClone(lib.DEFAULT_ROOM),
      originalAssetId: 'original',
      previewAssetId: 'preview',
      imageWidth: 1200,
      imageHeight: 800,
      surfaces: lib
        .createRoomSurfaces(lib.DEFAULT_ROOM)
        .map((s) => ({ ...s, materialVersionId: 'tile', tile: { ...s.tile, shading: 0 } })),
      fixtures: [toilet, photo, bath, glass, sink, mirror],
      protection: empty(),
      color: { ...color },
    };
    const before = structuredClone(after);
    before.fixtures = before.fixtures.filter((f) => f.id !== 'photo-plane');
    const snapshot = { scene: after, beforeScene: before, materials: { tile, photo: material } };
    let workerCalls = 0;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        workerCalls++;
        super(url, options);
      }
    };
    (window as unknown as { runViewerCycle: (i: number) => Promise<unknown> }).runViewerCycle = async (
      cycle: number,
    ) => {
      const beforeSource = JSON.stringify(snapshot),
        reads: string[] = [];
      const start = performance.now(),
        renderer = new lib.RoomViewerRenderer();
      document.body.append(renderer.canvas);
      await renderer.setSnapshot(snapshot, async (id) => {
        reads.push(id);
        return assets[id];
      });
      const prepareMs = performance.now() - start;
      const internal = renderer as unknown as {
        renderer: import('three').WebGLRenderer;
        prepared: { before: { world: import('three').Scene }; after: { world: import('three').Scene } };
      };
      let isolatedTexture: import('three').Texture | undefined;
      if (isolateLut) {
        for (const side of [internal.prepared.before, internal.prepared.after])
          side.world.traverse((object) => {
            const mesh = object as import('three').Mesh;
            if (!mesh.isMesh) return;
            for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
              if (!(material as import('three').MeshStandardMaterial).isMeshStandardMaterial) continue;
              const originalCompile = material.onBeforeCompile;
              material.onBeforeCompile = function (shader, glRenderer) {
                originalCompile.call(this, shader, glRenderer);
                if (!shader.uniforms.dfgLUT) return;
                shader.uniforms.dfgLUT = {
                  get value() {
                    return isolatedTexture ?? null;
                  },
                  set value(value: import('three').Texture | null) {
                    if (value && !isolatedTexture) isolatedTexture = value.clone();
                  },
                };
              };
            }
          });
      }
      const gl = renderer.canvas.getContext('webgl2')!;
      const sample = new Uint8Array(4);
      let view = lib.defaultRoomView();
      const transitions: number[] = [];
      for (const direction of ['right', 'up', 'left', 'down', 'right', 'right'] as const) {
        const t = performance.now();
        view = lib.rotateRoomView(view, direction);
        renderer.render(900, 600, view, 'compare');
        gl.readPixels(450, 300, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, sample);
        transitions.push(performance.now() - t);
      }
      let lutListenerCount = 0;
      for (const side of [internal.prepared.before, internal.prepared.after])
        side.world.traverse((object) => {
          const mesh = object as import('three').Mesh;
          if (!mesh.isMesh) return;
          for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            const properties = internal.renderer.properties.get(material) as {
              uniforms?: { dfgLUT?: { value?: { _listeners?: { dispose?: unknown[] } } } };
            };
            lutListenerCount = Math.max(
              lutListenerCount,
              properties.uniforms?.dfgLUT?.value?._listeners?.dispose?.length ?? 0,
            );
          }
        });
      const active = renderer.diagnostics(),
        noticeErrors = renderer.notices.filter((n) => n.severity === 'error');
      if (noticeErrors.length) throw new Error(JSON.stringify(noticeErrors));
      if (JSON.stringify(snapshot) !== beforeSource) throw new Error('Source scene mutated');
      isolatedTexture?.dispose();
      renderer.dispose();
      renderer.canvas.remove();
      await Promise.resolve();
      const closed = renderer.diagnostics();
      if (
        closed.contexts !== 0 ||
        !closed.contextLost ||
        closed.preparedScenes !== 0 ||
        closed.productCache.assets ||
        closed.productCache.meshes ||
        closed.productCache.textures ||
        closed.tileCache.tileAtlases
      )
        throw new Error('Viewer did not release context/cache ownership');
      return {
        cycle,
        prepareMs,
        transitions,
        reads,
        active,
        closed,
        canvasCount: document.querySelectorAll('canvas').length,
        workerCalls,
        lutListenerCount,
      };
    };
  }, isolateLut);
  await cdp.send('HeapProfiler.collectGarbage');
  const baseline = await cdp.send('Runtime.getHeapUsage');
  const prototypes: Record<string, string> = {};
  for (const name of [
    'RoomViewerRenderer',
    'WebGLRenderer',
    'WebGLRenderTarget',
    'BufferGeometry',
    'Texture',
  ]) {
    const response = await cdp.send('Runtime.evaluate', {
      expression: `ResourceTest.${name}.prototype`,
      objectGroup: 'room-view-prototypes',
    });
    prototypes[name] = response.result.objectId!;
  }
  const cycles: unknown[] = [];
  for (let cycle = 1; cycle <= repetitions; cycle++) {
    const result = await page.evaluate(
      (i) =>
        (
          window as unknown as { runViewerCycle: (i: number) => Promise<Record<string, unknown>> }
        ).runViewerCycle(i),
      cycle,
    );
    // Let context-loss/disposal events settle across two browser frames before the GC sample.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    await cdp.send('HeapProfiler.collectGarbage');
    const heap = await cdp.send('Runtime.getHeapUsage');
    const liveInstances: Record<string, number> = {};
    for (const [name, prototypeObjectId] of Object.entries(prototypes)) {
      const response = await cdp.send('Runtime.queryObjects', {
        prototypeObjectId,
        objectGroup: 'room-view-cycle-audit',
      });
      const count = await cdp.send('Runtime.callFunctionOn', {
        objectId: response.objects.objectId!,
        functionDeclaration: 'function(){return this.length;}',
        returnByValue: true,
      });
      liveInstances[name] = count.result.value as number;
    }
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'room-view-cycle-audit' });
    if (!isolateLut) {
      assert.equal(liveInstances.RoomViewerRenderer, 0);
      assert.equal(liveInstances.WebGLRenderer, 0);
    }
    cycles.push({ ...result, postGcHeap: heap, liveInstances });
    assert.equal(result.canvasCount, 0);
    assert.equal(result.workerCalls, 0);
  }
  await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'room-view-prototypes' });
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  const report = {
    conditions: {
      authoredFixtureCount: { before: 5, after: 6 },
      roomMm: [2400, 2400, 2400],
      viewport: '900x600 compare',
      repetitions,
      isolateLutTestOnly: isolateLut,
      turnsPerCycle: 6,
      userAgent: await page.evaluate(() => navigator.userAgent),
      measurement:
        'CDP main page JavaScript heap after explicit GC; not peak RAM, VRAM, or AI-model memory; shader counters after context loss may be stale',
    },
    baseline,
    cycles,
    errors,
    externalRequests,
  };
  await writeFile(`${output}/verification.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, cycles: report.cycles.map((row) => row), errors }, null, 2));
} finally {
  await browser.close();
}
