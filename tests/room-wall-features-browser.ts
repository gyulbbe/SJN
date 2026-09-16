/** Authored wall geometry integration. No photo observation, model inference or persistent database. */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const output =
  'test-results/reconstruction-fifteen-rebuild/20260915-start/wall-feature-integration-2026-09-15T12-46-53.127Z/browser/pick-regression-' +
  new Date().toISOString().replaceAll(':', '-');
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/room-viewer/renderer'; export * from './src/lib/room-viewer/view-state'; export * from './src/lib/room-viewer/surfaces'; export * from './src/lib/wall-features'; export { createRoomSurfaces, roomFacePoint } from './src/lib/room-geometry'; export { applyRoomSurfaceBand } from './src/lib/room-surface-bands'; export { Vector3, Raycaster, Mesh, Box3, PerspectiveCamera } from 'three';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'WallTest',
  metafile: true,
});
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const dependencies = Object.keys(bundle.metafile!.inputs).filter((p) => p.startsWith('src/'));
const sourceBefore = await Promise.all(
  dependencies.map(async (path) => ({ path, sha256: sha(await readFile(path)) })),
);
await writeFile(
  `${output}/source-before.json`,
  JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      bundleSHA: sha(bundle.outputFiles[0].contents),
      files: sourceBefore,
    },
    null,
    2,
  ),
);
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
const startedAt = new Date().toISOString();
const errors: string[] = [],
  blockedRequests: string[] = [];
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:43197') {
      blockedRequests.push(url.origin + url.pathname);
      return route.abort();
    }
    return route.fulfill({
      contentType: 'text/html',
      body: '<html><body style="margin:0;background:#eee"></body></html>',
    });
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => {
    if (e.type() === 'error') errors.push(e.text());
  });
  await page.goto('http://127.0.0.1:43197/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    type Lib = typeof import('../src/lib/room-viewer/renderer') &
      typeof import('../src/lib/room-viewer/view-state') &
      typeof import('../src/lib/room-viewer/surfaces') &
      typeof import('../src/lib/wall-features') &
      typeof import('../src/lib/room-geometry') &
      typeof import('../src/lib/room-surface-bands') &
      Pick<typeof import('three'), 'Vector3' | 'Raycaster' | 'Mesh' | 'Box3' | 'PerspectiveCamera'>;
    const lib = (window as unknown as { WallTest: Lib }).WallTest;
    const checks: string[] = [];
    const check = (condition: unknown, label: string) => {
      if (!condition) throw new Error(label);
      checks.push(label);
    };
    const room = {
      kind: 'parametric' as const,
      version: 1 as const,
      widthMm: 3000,
      depthMm: 3200,
      heightMm: 2600,
    };
    const color = { exposure: 0, contrast: 1, saturation: 1, warmth: 0 };
    const assets: Record<string, import('../src/lib/types').AssetRecord> = {};
    const materials: Record<string, import('../src/lib/types').MaterialVersion> = {};
    for (const [id, primary, secondary] of [
      ['upper', '#246bc1', '#5591da'],
      ['lower', '#cb6625', '#e49b55'],
      ['floor', '#dddcd4', '#7c837b'],
    ]) {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = primary;
      ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = secondary;
      ctx.fillRect(0, 0, 32, 32);
      ctx.fillRect(32, 32, 32, 32);
      const blob = await new Promise<Blob>((resolve) => c.toBlob((value) => resolve(value!)));
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
        createdAt: '2026-09-15',
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
        color: '#ffffff',
        finish: '',
        widthMm: 300,
        heightMm: 300,
        depthMm: 10,
        usage: 'both',
        installation: id === 'floor' ? 'floor' : 'wall',
        textureAssetIds: [id],
        views: [],
        defaultGroutWidth: 4,
        defaultGroutColor: '#ffffff',
        defaultPattern: 'grid',
        createdAt: '2026-09-15',
      };
    }
    const wallFeatures: import('../src/lib/wall-features').WallFeatureV1[] = [];
    for (const face of ['left', 'back', 'right'] as const) {
      wallFeatures.push({
        version: 1,
        id: crypto.randomUUID(),
        kind: 'closed-niche',
        face,
        leftMm: 400,
        topMm: 700,
        widthMm: 700,
        heightMm: 1200,
        depthMm: 350,
        source: 'user',
      });
      wallFeatures.push({
        version: 1,
        id: crypto.randomUUID(),
        kind: 'floor-alcove',
        face,
        leftMm: 1800,
        topMm: 800,
        widthMm: 700,
        depthMm: 350,
        source: 'user',
      });
    }
    const surfaces = lib.createRoomSurfaces(room, 1.5).flatMap((s) =>
      s.roomFace === 'floor'
        ? [{ ...s, materialVersionId: 'floor', tile: { ...s.tile, shading: 0, seed: 73, groutWidth: 5 } }]
        : [
            [0, 0.5, 'upper'],
            [0.5, 1, 'lower'],
          ].map(([from, to, material]) => ({
            ...lib.applyRoomSurfaceBand(
              { ...structuredClone(s), id: crypto.randomUUID() },
              { from: from as number, to: to as number },
            ),
            materialVersionId: material as string,
            tile: { ...s.tile, shading: 0, seed: 73, groutWidth: 5 },
          })),
    );
    const authored: import('../src/lib/types').Scene = {
      room,
      originalAssetId: 'test-original',
      previewAssetId: 'test-preview',
      imageWidth: 1200,
      imageHeight: 800,
      surfaces,
      fixtures: [],
      protection: { polygon: [], strokes: [] },
      color,
      wallFeatures,
    };
    const original = JSON.stringify(authored);
    const flat = structuredClone(authored);
    delete flat.wallFeatures;
    const deep = structuredClone(authored);
    deep.wallFeatures!.forEach((f) => {
      f.depthMm = 700;
    });
    const reader = async (id: string) => assets[id];
    const cache = new lib.ViewerTileCache(reader, 1024);
    const physical = await lib.buildViewerSurfaces(authored, materials, cache);
    check(physical.notices.length === 0, 'authored-materials-valid');
    physical.group.updateMatrixWorld(true);
    const meshes = physical.group.children as import('three').Mesh<
      import('three').BufferGeometry,
      import('three').MeshStandardMaterial
    >[];
    const raycasts: unknown[] = [];
    let maxFloorUvError = 0;
    for (const f of wallFeatures) {
      const resolved = lib.resolveWallFeature(room, f);
      const u = (resolved.opening.left + resolved.opening.right) / 2;
      const v = (resolved.opening.top + resolved.opening.bottom) / 2;
      const mouth = lib.roomFacePoint(room, f.face, u, v);
      const normal = new lib.Vector3(...resolved.inwardNormal);
      const ray = new lib.Raycaster(mouth.clone().addScaledVector(normal, 100), normal.clone().negate());
      const hit = ray.intersectObjects(meshes, false)[0];
      const info = (hit?.object as import('three').Mesh)?.geometry.userData.wallFeature;
      check(info?.featureId === f.id && info.role === 'rear', `${f.face}-${f.kind}-opening-ray-hits-rear`);
      check(Math.abs(hit.distance - (100 + f.depthMm)) < 1e-4, `${f.face}-${f.kind}-real-recess-depth`);
      const outside = lib.roomFacePoint(room, f.face, resolved.opening.left - 0.03, v);
      const outsideHit = new lib.Raycaster(
        outside.addScaledVector(normal, 100),
        normal.clone().negate(),
      ).intersectObjects(meshes, false)[0];
      check(Math.abs(outsideHit.distance - 100) < 1e-4, `${f.face}-${f.kind}-adjacent-wall-intact`);
      const pieces = meshes.filter((m) => m.geometry.userData.wallFeature?.featureId === f.id);
      for (const piece of pieces) {
        const metadata = piece.geometry.userData.wallFeature;
        const parent = authored.surfaces.find((s) => s.id === metadata.sourceSurfaceId);
        check(!!parent, `${f.face}-${f.kind}-${metadata.role}-parent-resolves`);
        const base = meshes.find(
          (m) =>
            m.geometry.userData.wallFeature?.role === 'base-wall' &&
            m.geometry.userData.wallFeature.sourceSurfaceId === parent!.id,
        );
        if (metadata.role !== 'floor-extension')
          check(
            base?.material === piece.material,
            `${f.face}-${f.kind}-${metadata.role}-parent-shader-shared`,
          );
        else {
          check(
            parent!.roomFace === 'floor' && metadata.uvChart === 'floor-global',
            `${f.face}-floor-extension-parent`,
          );
          const position = piece.geometry.getAttribute('position'),
            uv = piece.geometry.getAttribute('uv');
          for (let i = 0; i < position.count; i++) {
            const error = Math.max(
              Math.abs(uv.getX(i) - (position.getX(i) + room.widthMm / 2) / room.widthMm),
              Math.abs(uv.getY(i) - position.getZ(i) / room.depthMm),
            );
            maxFloorUvError = Math.max(maxFloorUvError, error);
            check(Math.abs(position.getY(i)) < 1e-6 && error < 1e-6, `${f.face}-floor-uv-${i}`);
          }
        }
      }
      const rearMaterials = new Set(
        pieces
          .filter((m) => m.geometry.userData.wallFeature.role === 'rear')
          .map(
            (m) =>
              authored.surfaces.find((s) => s.id === m.geometry.userData.wallFeature.sourceSurfaceId)!
                .materialVersionId,
          ),
      );
      check(
        rearMaterials.has('upper') && rearMaterials.has('lower'),
        `${f.face}-${f.kind}-crosses-two-material-bands`,
      );
      raycasts.push({
        face: f.face,
        kind: f.kind,
        rearDistance: hit.distance,
        expectedDistance: 100 + f.depthMm,
        pieceCount: pieces.length,
      });
    }
    let disposedGeometry = 0;
    const geometries = new Set(meshes.map((m) => m.geometry));
    for (const geometry of geometries)
      geometry.addEventListener('dispose', () => {
        disposedGeometry++;
      });
    const structureBounds = physical.structureBounds.clone();
    physical.dispose();
    physical.dispose();
    cache.dispose();
    check(
      disposedGeometry === geometries.size && physical.group.children.length === 0,
      'surface-disposal-exactly-once',
    );

    // Public editor ray/pick API: test physical parent selection separately from rendering.
    const pointerEngine = new lib.RoomViewerRenderer();
    await pointerEngine.setSnapshot({ scene: authored, beforeScene: authored, materials }, reader);
    const roomBounds = new lib.Box3(
      new lib.Vector3(-room.widthMm / 2, 0, 0),
      new lib.Vector3(room.widthMm / 2, room.heightMm, room.depthMm),
    );
    const pointerBase = lib.defaultRoomView();
    const pointerView = (view: import('../src/lib/room-viewer/view-state').RoomViewState) => {
      pointerEngine.render(900, 600, view, 'after');
      const camera = lib.createRoomViewCamera(room, 1.5, view, roomBounds, structureBounds);
      const rect = lib.roomViewViewport(900, 600, view);
      return (point: import('three').Vector3) => {
        const ndc = point.clone().project(camera);
        return {
          x: (rect.x + ((ndc.x + 1) * rect.width) / 2) / 900,
          y: 1 - (rect.y + ((ndc.y + 1) * rect.height) / 2) / 600,
        };
      };
    };
    let projectPoint = pointerView(pointerBase);
    const backNiche = wallFeatures.find((f) => f.face === 'back' && f.kind === 'closed-niche')!;
    const opening = lib.resolveWallFeature(room, backNiche).opening;
    const upperV = (opening.top + 0.5) / 2;
    const parentBack = authored.surfaces.find(
      (s) => s.roomFace === 'back' && s.reconstructionBand?.from === 0,
    )!;
    const rearPoint = lib
      .roomFacePoint(room, 'back', (opening.left + opening.right) / 2, upperV)
      .add(new lib.Vector3(0, 0, -backNiche.depthMm));
    for (const [label, world] of [
      ['rear', rearPoint],
      ['adjacent-mouth', lib.roomFacePoint(room, 'back', opening.left - 0.04, upperV)],
    ] as const) {
      const point = projectPoint(world);
      const picked = pointerEngine.pick(point.x, point.y);
      check(
        picked?.kind === 'surface' && picked.id === parentBack.id,
        'pick-' + label + '-resolves-actual-parent-surface',
      );
    }
    for (const mode of ['before', 'split', 'compare'] as const) {
      pointerEngine.render(900, 600, pointerBase, mode);
      check(
        pointerEngine.pick(0.5, 0.5) === null && pointerEngine.facePosition(0.5, 0.5, 'back') === null,
        mode + '-is-not-editable',
      );
    }
    const source = new lib.PerspectiveCamera(70, 600 / 900, 1, 20000);
    source.position.set(0, room.heightMm / 2, 7800);
    source.lookAt(0, room.heightMm / 2, room.depthMm / 2);
    source.updateMatrixWorld(true);
    const portrait = lib.sourceRoomView(
      {
        version: 1,
        positionMm: source.position.toArray(),
        quaternion: source.quaternion.toArray(),
        verticalFovDegrees: 70,
        image: { width: 600, height: 900 },
      },
      room,
      'user',
    );
    const roundTrips: unknown[] = [];
    let maxRoundTripError = 0;
    for (const [label, view] of [
      ['room-fit', pointerBase],
      ['room-fit-90', lib.rotateRoomView(pointerBase, 'right')],
      ['portrait-source', portrait],
      ['portrait-source-90', lib.rotateRoomView(portrait, 'right')],
    ] as const) {
      projectPoint = pointerView(view);
      for (const face of ['floor', 'back', 'left', 'right'] as const) {
        const u = 0.5,
          v = 0.6;
        const projected = projectPoint(lib.roomFacePoint(room, face, u, v));
        const result = pointerEngine.facePosition(projected.x, projected.y, face);
        const error = result ? Math.max(Math.abs(result.u - u), Math.abs(result.v - v)) : Infinity;
        maxRoundTripError = Math.max(error, maxRoundTripError);
        check(error < 1e-8, label + '-' + face + '-world-UV-ray-roundtrip');
        roundTrips.push({ label, face, error });
      }
      if (label === 'portrait-source')
        check(
          pointerEngine.pick(0.01, 0.5) === null && pointerEngine.facePosition(0.01, 0.5, 'back') === null,
          'portrait-letterbox-does-not-pick',
        );
    }
    const outsideBack = lib.rotateRoomView(lib.rotateRoomView(pointerBase, 'right'), 'right');
    projectPoint = pointerView(outsideBack);
    const hidden = projectPoint(lib.roomFacePoint(room, 'back', 0.5, 0.3));
    const hiddenHit = pointerEngine.pick(hidden.x, hidden.y);
    check(
      !authored.surfaces.some((s) => s.roomFace === 'back' && s.id === hiddenHit?.id),
      'hidden-back-wall-does-not-intercept-pick',
    );
    pointerEngine.dispose();

    const engine = new lib.RoomViewerRenderer();
    document.body.append(engine.canvas);
    const views: Record<string, string> = {};
    const base = lib.defaultRoomView();
    const fitScenes = [authored, flat, deep];
    const input = { scene: flat, beforeScene: authored, materials };
    await engine.setSnapshot(input, reader, { fitScenes });
    const render = (
      name: string,
      mode: 'before' | 'after' | 'compare',
      view = base,
      width = 900,
      height = 600,
    ) => {
      engine.render(width, height, view, mode);
      const png = engine.canvas.toDataURL();
      views[name] = png;
      return png;
    };
    const before = render('front-before', 'before');
    const after = render('front-after', 'after');
    check(before !== after, 'real-WebGL-openings-change-pixels');
    render('compare', 'compare', base, 1200, 400);
    let rotated = base;
    for (const name of ['right', 'back', 'left', 'front-again']) {
      rotated = lib.rotateRoomView(rotated, 'right');
      render(name, 'before', rotated);
    }
    check(views['front-again'] === before, 'four-quarter-turns-return-exact-pixels');
    render('tilted-up', 'before', lib.rotateRoomView(base, 'up'));
    await engine.setSnapshot({ scene: deep, beforeScene: authored, materials }, reader, { fitScenes });
    const otherBefore = render('deep-card-before', 'before');
    check(otherBefore === before, 'common-fit-preserves-Before-across-different-After-depths');
    await engine.setSnapshot({ scene: authored, beforeScene: authored, materials }, reader, { fitScenes });
    engine.render(1200, 400, base, 'compare');
    const capture = document.createElement('canvas');
    capture.width = 1200;
    capture.height = 400;
    capture.getContext('2d')!.drawImage(engine.canvas, 0, 0);
    const pixels = capture.getContext('2d')!.getImageData(0, 0, 1200, 400).data;
    let panelDifference = 0;
    for (let y = 0; y < 400; y++)
      for (let x = 0; x < 600; x++)
        for (let c = 0; c < 4; c++)
          panelDifference = Math.max(
            panelDifference,
            Math.abs(pixels[(y * 1200 + x) * 4 + c] - pixels[(y * 1200 + x + 600) * 4 + c]),
          );
    // Existing compare post-pass uses normalized panel UVs; its established tolerance is one RGBA level.
    check(
      panelDifference <= 1,
      'identical-Before-After-compare-panels-within-established-one-level-tolerance',
    );
    const expectedExport = render('export-expected', 'before', base, 900, 600);
    const exported = await engine.export(base, { mode: 'before', format: 'png', longEdge: 900 });
    const bitmap = await createImageBitmap(exported);
    const pngCanvas = document.createElement('canvas');
    pngCanvas.width = bitmap.width;
    pngCanvas.height = bitmap.height;
    pngCanvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    bitmap.close();
    check(pngCanvas.toDataURL() === expectedExport, 'PNG-export-equals-live-canvas');
    const geometryCounts: number[] = [];
    for (let i = 0; i < 9; i++) {
      const next = structuredClone(authored);
      next.wallFeatures!.forEach((f) => {
        f.depthMm = 200 + i * 40;
      });
      await engine.setSnapshot({ scene: next, beforeScene: authored, materials }, reader);
      engine.render(600, 400, base, 'after');
      await Promise.resolve();
      const info = engine.diagnostics();
      geometryCounts.push(info.geometries);
      check(info.preparedScenes <= 6, `bounded-render-cache-${i}`);
    }
    check(
      Math.max(...geometryCounts.slice(-4)) === Math.min(...geometryCounts.slice(-4)),
      'geometry-memory-stabilizes-after-cache-limit',
    );
    check(JSON.stringify(authored) === original, 'authored-input-is-immutable');
    const diagnostics = engine.diagnostics();
    engine.dispose();
    engine.dispose();
    await Promise.resolve();
    const disposal = engine.diagnostics();
    check(disposal.contexts === 0 && disposal.preparedScenes === 0, 'renderer-context-and-scenes-released');
    // No-feature scenes remain compatible when the optional list is explicitly empty.
    const emptyEngine = new lib.RoomViewerRenderer();
    await emptyEngine.setSnapshot({ scene: flat, beforeScene: flat, materials }, reader);
    emptyEngine.render(600, 400, base, 'after');
    const absent = emptyEngine.canvas.toDataURL();
    const empty = { ...structuredClone(flat), wallFeatures: [] };
    await emptyEngine.setSnapshot({ scene: empty, beforeScene: empty, materials }, reader);
    emptyEngine.render(600, 400, base, 'after');
    check(emptyEngine.canvas.toDataURL() === absent, 'absent-versus-empty-features-pixel-parity');
    emptyEngine.dispose();
    return {
      checks,
      raycasts,
      maxFloorUvError,
      maxRoundTripError,
      roundTrips,
      panelDifference,
      geometryCounts,
      diagnostics,
      disposal,
      views,
      authored,
      source: 'explicitly-authored-user-scene',
      aiCalls: 0,
    };
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(blockedRequests, []);
  for (const [name, value] of Object.entries(result.views))
    await writeFile(`${output}/${name}.png`, Buffer.from(value.split(',')[1], 'base64'));
  const sourceAfter = await Promise.all(
    dependencies.map(async (path) => ({ path, sha256: sha(await readFile(path)) })),
  );
  const sourceChanges = sourceBefore.filter((entry, i) => sourceAfter[i].sha256 !== entry.sha256);
  const { views, ...report } = result;
  await writeFile(
    `${output}/verification.json`,
    JSON.stringify(
      {
        ...report,
        startedAt,
        completedAt: new Date().toISOString(),
        browser: 'isolated installed Chrome, SwiftShader WebGL',
        loopbackRoute: 'intercepted 127.0.0.1:43197; no real server',
        errors,
        blockedRequests,
        sourceChanges,
        sourceAfter,
        outputCount: Object.keys(views).length,
      },
      null,
      2,
    ),
  );
  await page.evaluate((views) => {
    document.body.innerHTML =
      '<h1>벽 구조 렌더 검증 · 직접 작성한 장면</h1><p>사진 자동 인식 결과가 아닙니다. 파랑/주황: 부모 벽 타일 구간, 회색: 바닥</p>';
    document.body.style.cssText = 'margin:20px;font:16px sans-serif;background:#fff';
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:12px';
    for (const key of ['front-before', 'front-after', 'right', 'left', 'back', 'tilted-up']) {
      const cell = document.createElement('div');
      const caption = document.createElement('p');
      caption.textContent = key;
      const image = document.createElement('img');
      image.src = views[key];
      image.style.width = '100%';
      cell.append(caption, image);
      grid.append(cell);
    }
    document.body.append(grid);
  }, views);
  await page.screenshot({ path: `${output}/overview.png`, fullPage: true });
  assert.equal(
    sourceChanges.length,
    0,
    'Runtime source changed while the frozen browser bundle was tested; see receipt',
  );
  console.log(
    JSON.stringify({
      output,
      checks: report.checks.length,
      maximumPanelDifference: report.panelDifference,
      maxFloorUvError: report.maxFloorUvError,
      sourceChanges: sourceChanges.length,
      gpu: report.diagnostics.gpu,
    }),
  );
} catch (error) {
  await writeFile(
    `${output}/failure.json`,
    JSON.stringify(
      {
        startedAt,
        failedAt: new Date().toISOString(),
        error: error instanceof Error ? error.stack : String(error),
        errors,
        blockedRequests,
        aiCalls: 0,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
}
