/** Procedural renderer regression only: these fixtures are deliberate test geometry, not AI detections. */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const output = 'test-results/reconstruction-standard-render';
const bundle = await build({
  stdin: {
    contents: `
 export { PhotoCompositor } from './src/lib/render/compositor';
 export { projectReconstructionFixture } from './src/lib/reconstruction/projection';
 export { DEFAULT_ROOM, projectRoomPoint } from './src/lib/room-geometry';
 export { DEFAULT_COLOR, EMPTY_MASK } from './src/lib/types';
 export { Vector3, CanvasTexture } from 'three';
`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
});
const server = createServer((req, res) => {
  if (req.url === '/index.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(bundle.outputFiles[0].text);
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><link rel="icon" href="data:,"><body style="margin:0"></body></html>');
  }
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const hardwareGpu = process.env.RECONSTRUCTION_HARDWARE_GPU === '1';
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: hardwareGpu
    ? ['--enable-webgl']
    : ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  await mkdir(output, { recursive: true });
  const page = await browser.newPage();
  const errors: string[] = [],
    requests: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(origin);
  const result = await page.evaluate(async (base) => {
    const m = await import(base + '/index.js');
    const background = document.createElement('canvas');
    background.width = 900;
    background.height = 600;
    const bg = background.getContext('2d')!;
    bg.fillStyle = '#909090';
    bg.fillRect(0, 0, 900, 600);
    const blob = await new Promise<Blob>((done) => background.toBlob((b) => done(b!)));
    const fixtures = [
      {
        kind: 'glassPartition',
        color: '#bed0d1',
        widthMm: 1300,
        heightMm: 1700,
        depthMm: 8,
        v: 0.75,
        opacity: 0.2,
        baseHeightMm: 0,
      },
      {
        kind: 'bath',
        color: '#b46048',
        widthMm: 1000,
        heightMm: 600,
        depthMm: 800,
        v: 0.45,
        baseHeightMm: 0,
      },
      {
        kind: 'basin',
        color: '#eeeeee',
        widthMm: 600,
        heightMm: 320,
        depthMm: 450,
        v: 0.9,
        baseHeightMm: 700,
        basinVariant: 'wall',
        basinShape: 'rectangular',
      },
    ].map((config, i) => {
      const f = {
        id: 'fixture-' + i,
        name: config.kind,
        materialVersionId: 'material-' + i,
        viewIndex: 0,
        position: { x: 0.5, y: 0.5 },
        width: 0.1,
        height: 0.1,
        rotation: 0,
        anchor: { x: 0.5, y: 1 },
        locked: false,
        shadow: { x: 0, y: 0, opacity: 0, blur: 0, scale: 1 },
        occlusion: m.EMPTY_MASK(),
        color: { ...m.DEFAULT_COLOR },
        roomPlacement: {
          face: 'floor',
          u: 0.5,
          v: config.v,
          scale: 1,
          widthMm: config.widthMm,
          heightMm: config.heightMm,
          imageAspect: 1,
          contentBounds: { left: 0, top: 0, right: 1, bottom: 1 },
        },
        reconstruction: { ...config, version: 2, hasFrame: false, yawDegrees: 0 },
      };
      m.projectReconstructionFixture(m.DEFAULT_ROOM, f, 1.5);
      return f;
    });
    const material = (i: number) => ({
      id: 'material-' + i,
      views: [],
      imageAssetIds: [],
      textureAssetIds: [],
    });
    const materials = Object.fromEntries(fixtures.map((_, i) => ['material-' + i, material(i)]));
    const scene = {
      room: m.DEFAULT_ROOM,
      originalAssetId: 'background',
      previewAssetId: 'background',
      imageWidth: 900,
      imageHeight: 600,
      surfaces: [],
      protection: m.EMPTY_MASK(),
      fixtures,
      color: { ...m.DEFAULT_COLOR },
    };
    const compositor = new m.PhotoCompositor();
    const reads: string[] = [];
    const reader = async (id: string) => {
      reads.push(id);
      return { id, blob, kind: 'background', width: 900, height: 600 };
    };
    const capture = async (items: typeof fixtures) => {
      await compositor.setSnapshot({ scene: { ...scene, fixtures: items }, materials }, reader);
      const rendered = compositor.render(900, 600);
      const canvas = document.createElement('canvas');
      canvas.width = 900;
      canvas.height = 600;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(rendered, 0, 0);
      return { pixels: ctx.getImageData(0, 0, 900, 600).data, url: canvas.toDataURL() };
    };
    const glass = await capture(fixtures),
      reverse = await capture([...fixtures].reverse());
    const noGlass = await capture(fixtures.slice(1));
    const noBasin = await capture(fixtures.slice(0, 2));
    let orderDifference = 0,
      glassChanges = 0,
      basinPixels = 0,
      frontChanged = 0,
      edgeChanged = 0;
    const basinMask = new Uint8Array(900 * 600);
    for (let p = 0; p < basinMask.length; p++) {
      const i = p * 4;
      basinMask[p] = Number(
        Math.max(...[0, 1, 2].map((c) => Math.abs(glass.pixels[i + c] - noBasin.pixels[i + c]))) > 10 &&
          noGlass.pixels[i] > 170 &&
          noGlass.pixels[i + 1] > 170,
      );
    }
    for (let i = 0; i < glass.pixels.length; i += 4) {
      const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) =>
        Math.max(...[0, 1, 2].map((c) => Math.abs(a[i + c] - b[i + c])));
      orderDifference = Math.max(orderDifference, diff(glass.pixels, reverse.pixels));
      if (diff(glass.pixels, noGlass.pixels) > 2) glassChanges++;
      if (diff(glass.pixels, noBasin.pixels) > 10 && noGlass.pixels[i] > 170 && noGlass.pixels[i + 1] > 170) {
        basinPixels++;
        if (diff(glass.pixels, noGlass.pixels) > 2) {
          // Multisample edge pixels legitimately include glass behind the partial silhouette.
          const p = i / 4,
            interior = [-901, -900, -899, -1, 0, 1, 899, 900, 901].every((o) => basinMask[p + o] === 1);
          if (interior) frontChanged++;
          else edgeChanged++;
        }
      }
    }
    // Deliberate half-coverage mask: validate the rendering contract, not an AI output.
    const softMaskCanvas = document.createElement('canvas');
    softMaskCanvas.width = 8;
    softMaskCanvas.height = 8;
    const softCtx = softMaskCanvas.getContext('2d')!;
    softCtx.fillStyle = 'rgba(255,255,255,0.5)';
    softCtx.fillRect(0, 0, 8, 8);
    const softMask = new m.CanvasTexture(softMaskCanvas);
    const maskHost = compositor as unknown as { getMask: (...args: unknown[]) => unknown };
    const getMask = maskHost.getMask.bind(maskHost);
    maskHost.getMask = (...args) => (String(args[0]).endsWith(':fixture-2') ? softMask : getMask(...args));
    const partial = await capture(fixtures);
    maskHost.getMask = getMask;
    let partialPixels = 0,
      partialOther = 0,
      partialFull = 0,
      partialBackground = 0;
    const totals = [0, 0];
    for (let p = 901; p < basinMask.length - 901; p++) {
      if (![-901, -900, -899, -1, 0, 1, 899, 900, 901].every((o) => basinMask[p + o] === 1)) continue;
      const i = p * 4;
      partialPixels++;
      const delta = (a: Uint8ClampedArray) =>
        Math.max(...[0, 1, 2].map((c) => Math.abs(partial.pixels[i + c] - a[i + c])));
      if (delta(glass.pixels) <= 1) partialFull++;
      else if (delta(noBasin.pixels) <= 1) partialBackground++;
      else partialOther++;
      for (let c = 0; c < 3; c++) {
        totals[0] += partial.pixels[i + c];
        totals[1] += (glass.pixels[i + c] + noBasin.pixels[i + c]) * 0.5;
      }
    }
    const partialMeanError = Math.abs(totals[0] - totals[1]) / Math.max(1, partialPixels * 3);
    const masked = structuredClone(fixtures);
    masked[2].occlusion = {
      polygon: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
      strokes: [],
    };
    const hidden = await capture(masked);
    softMask.dispose();
    let maskedDifference = 0;
    for (let i = 0; i < hidden.pixels.length; i++)
      maskedDifference = Math.max(maskedDifference, Math.abs(hidden.pixels[i] - noBasin.pixels[i]));
    await compositor.setSnapshot({ scene, materials }, reader);
    const exported = await compositor.exportImage({ scene, materials }, 900, 600, 'image/png', false);
    const bitmap = await createImageBitmap(exported),
      canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const png = canvas.toDataURL();
    const pixels = ctx.getImageData(0, 0, 900, 600).data;
    let exportDifference = 0;
    for (let i = 0; i < pixels.length; i++)
      exportDifference = Math.max(exportDifference, Math.abs(pixels[i] - glass.pixels[i]));
    const times: number[] = [];
    const gl = compositor.canvas.getContext('webgl2')!;
    const syncPixel = new Uint8Array(4);
    const gpuInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const gpuRenderer = gpuInfo
      ? gl.getParameter(gpuInfo.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    compositor.render(1620, 1080);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncPixel);
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      compositor.render(1620, 1080);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncPixel);
      times.push(performance.now() - start);
    }
    const dragStart = performance.now(),
      dragUpdates: number[] = [],
      frameTimes: number[] = [];
    for (let frame = 0; frame < 120; frame++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame((time) => {
          frameTimes.push(time);
          resolve();
        }),
      );
      const start = performance.now();
      const moved = structuredClone(fixtures);
      moved[2].roomPlacement.u = 0.5 + Math.sin(frame * 0.08) * 0.12;
      m.projectReconstructionFixture(m.DEFAULT_ROOM, moved[2], 1.5);
      await compositor.setSnapshot({ scene: { ...scene, fixtures: moved }, materials }, reader);
      compositor.render(1620, 1080);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncPixel);
      dragUpdates.push(performance.now() - start);
    }
    const dragElapsedMs = performance.now() - dragStart;
    const dragFps = 119000 / (frameTimes[119] - frameTimes[0]);
    const dragSorted = dragUpdates.sort((a, b) => a - b);
    const dragMetrics = {
      frames: 120,
      elapsedMs: dragElapsedMs,
      observedFps: dragFps,
      updateMedianMs: dragSorted[60],
      updateP95Ms: dragSorted[114],
      scope:
        'cached standard fixture u movement + physical projection + setSnapshot + render + synchronous pixel read; excludes React and pointer events',
    };
    const memory = () => ({
      ...(
        compositor as unknown as { renderer: { info: { memory: { geometries: number; textures: number } } } }
      ).renderer.info.memory,
    });
    const resourcesWithModels = memory();
    await capture([]);
    const resourcesAfterRemoval = memory();
    compositor.dispose();
    const resourcesAfterDispose = memory();
    const contextReleased = gl.isContextLost();
    const repeatedClose: { geometries: number; textures: number; contextReleased: boolean }[] = [];
    for (let cycle = 0; cycle < 4; cycle++) {
      const reopened = new m.PhotoCompositor();
      await reopened.setSnapshot({ scene, materials }, reader);
      reopened.render(900, 600);
      const reopenedGl = reopened.canvas.getContext('webgl2')!;
      reopenedGl.readPixels(0, 0, 1, 1, reopenedGl.RGBA, reopenedGl.UNSIGNED_BYTE, new Uint8Array(4));
      reopened.dispose();
      const counts = (
        reopened as unknown as { renderer: { info: { memory: { geometries: number; textures: number } } } }
      ).renderer.info.memory;
      repeatedClose.push({ ...counts, contextReleased: reopenedGl.isContextLost() });
    }
    return {
      repeatedClose,
      dragMetrics,
      partialPixels,
      partialOther,
      partialFull,
      partialBackground,
      partialMeanError,
      resourcesWithModels,
      resourcesAfterRemoval,
      resourcesAfterDispose,
      contextReleased,
      orderDifference,
      glassChanges,
      basinPixels,
      frontChanged,
      edgeChanged,
      maskedDifference,
      exportDifference,
      reads,
      gpuRenderer,
      renderMedianMs: times.sort((a, b) => a - b)[10],
      images: { glass: glass.url, noGlass: noGlass.url, noBasin: noBasin.url, export: png },
    };
  }, origin);
  for (const [name, url] of Object.entries(result.images))
    await writeFile(`${output}/${name}.png`, Buffer.from(url.split(',')[1], 'base64'));
  const summary = {
    ...result,
    images: undefined,
    errors,
    external: requests.filter((url) => !url.startsWith(origin)),
    hardware: `Headless Chrome / ${hardwareGpu ? 'hardware GPU requested' : 'SwiftShader'} / 1620x1080 / 3 standard models / synchronous readPixels per sample`,
  };
  await writeFile(`${output}/result.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  assert.equal(errors.length, 0);
  assert.equal(summary.external.length, 0);
  assert.ok(
    result.resourcesWithModels.geometries > result.resourcesAfterRemoval.geometries,
    'removed models must release their GPU geometry',
  );
  assert.equal(result.resourcesAfterRemoval.geometries, 1, 'only the compositor fullscreen quad remains');
  assert.equal(result.resourcesAfterDispose.geometries, 0);
  assert.equal(
    result.contextReleased,
    true,
    'the owned WebGL context must release its remaining internal resources',
  );
  assert.equal(
    result.orderDifference,
    0,
    'standard fixtures must use geometry depth regardless of array order',
  );
  assert.ok(result.glassChanges > 1000, 'glass must be visible');
  assert.ok(result.basinPixels > 200, 'front basin must remain visible');
  assert.equal(result.frontChanged, 0, 'glass behind the basin must not tint the basin');
  assert.equal(result.maskedDifference, 0, 'occluded basin must reveal the geometry behind it');
  assert.equal(result.exportDifference, 0, 'preview and PNG must share the exact render snapshot');
  assert.deepEqual(
    [...new Set(result.reads)],
    ['background'],
    'v2 standard rendering must never read source reflection/sprite assets',
  );
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
