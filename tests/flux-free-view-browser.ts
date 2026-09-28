/**
 * Real-WebGL check of the AI input's free direction (no AI call). The terrazzo comparison room is
 * rendered from the front-centre eye at the front and at each turn limit (left, right, up, down, and
 * up/down while turned) with the outside painted magenta, so any pixel past the open front would show;
 * one direction just past the right limit is the control that does show it. For tilted directions
 * the face mask, the fixture boxes and the fixture layer are compared with the render: one camera.
 * Captures and a contact sheet go to test-results/flux-free-view/.
 *
 * Usage: node tests/run-browser-test.mjs tests/flux-free-view-browser.ts [--gpu]
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const gpu = process.argv.includes('--gpu');
const output = 'test-results/flux-free-view';
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/room-viewer/renderer';export * from './src/lib/ai-export/view';export {buildFluxRoomScene} from './tests/helpers/flux-room-scene';export {readPixels} from './src/lib/ai-export/client';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'FreeView',
});
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
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
  await page.route('http://127.0.0.1:43219/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' }),
  );
  await page.goto('http://127.0.0.1:43219/');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const run = await page.evaluate(async () => {
    type Lib = typeof import('../src/lib/room-viewer/renderer') &
      typeof import('../src/lib/ai-export/view') &
      Pick<typeof import('./helpers/flux-room-scene'), 'buildFluxRoomScene'> &
      Pick<typeof import('../src/lib/ai-export/client'), 'readPixels'>;
    type FluxDirection = import('../src/lib/ai-export/view').FluxDirection;
    type Color = import('three').Color;
    const lib = (window as unknown as { FreeView: Lib }).FreeView;
    const gl = document.createElement('canvas').getContext('webgl2');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    const gpuName = gl && debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    const dataUrl = (blob: Blob) =>
      new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.readAsDataURL(blob);
      });
    const { room, assets, snapshot, imageWidth, imageHeight } = await lib.buildFluxRoomScene();
    const aspect = imageWidth / imageHeight;
    const reader = async (id: string) => assets[id];
    const edge = Math.min(1024, Math.max(imageWidth, imageHeight));
    const limits = lib.fluxDirectionLimits(room, aspect);
    // Turned first, then tilted as far as it goes there (a slanted drag slides along the limit).
    const tilted = (yaw: number, pitch: number) =>
      lib.clampFluxDirection(room, aspect, { yaw, pitch: 0 }, { yaw, pitch }).direction;
    const directions: [string, FluxDirection][] = [
      ['front', lib.FLUX_FRONT],
      ['left-limit', { yaw: limits.left, pitch: 0 }],
      ['right-limit', { yaw: limits.right, pitch: 0 }],
      ['up-limit', { yaw: 0, pitch: limits.up }],
      ['down-limit', { yaw: 0, pitch: limits.down }],
      ['up-limit-right-20', tilted(20, 80)],
      ['down-limit-left-25', tilted(-25, -80)],
      // Not reachable in the dialog: 3° past the right limit, where the outside must show.
      ['past-right-control', { yaw: limits.right + 3, pitch: 0 }],
    ];
    const viewer = new lib.RoomViewerRenderer();
    try {
      await viewer.setSnapshot(snapshot, reader);
      // The world background is what an eye sees past the open front: paint it magenta.
      const world = (viewer as unknown as { prepared: { after: { world: { background: Color } } } }).prepared
        .after.world;
      world.background.set('#ff00ff');
      const captures = [];
      for (const [name, direction] of directions) {
        const view = lib.fluxEyeView(room, direction);
        const blob = await viewer.export(view, { format: 'png', mode: 'after', longEdge: edge });
        const pixels = await lib.readPixels(blob);
        let magenta = 0;
        for (let i = 0; i < pixels.data.length; i += 4)
          if (pixels.data[i] > 200 && pixels.data[i + 1] < 90 && pixels.data[i + 2] > 200) magenta++;
        captures.push({
          name,
          direction,
          width: pixels.width,
          height: pixels.height,
          magenta,
          sampledOutside: lib.fluxDirectionOutside(room, aspect, direction),
          url: await dataUrl(blob),
        });
      }
      // One camera for everything a capture sends: with a tilt, the fixture layer (the render's own
      // pixels), the face mask and the fixture boxes must agree.
      const agreement = [];
      for (const direction of [
        { yaw: 20, pitch: 15 },
        { yaw: -15, pitch: -30 },
        { yaw: 0, pitch: 0 },
      ]) {
        const view = lib.fluxEyeView(room, direction);
        const exported = await lib.readPixels(
          await viewer.export(view, { format: 'png', mode: 'after', longEdge: edge }),
        );
        const layers = viewer.exportLayers(view, { longEdge: edge });
        const mask = viewer.regionMask(
          Math.min(edge, (edge * imageWidth) / imageHeight),
          Math.min(edge, (edge * imageHeight) / imageWidth),
          view,
        );
        const boxes = Object.values(viewer.fixtureBounds(imageWidth, imageHeight, view));
        let fullDiff = 0;
        for (let i = 0; i < exported.data.length; i++)
          fullDiff = Math.max(fullDiff, Math.abs(exported.data[i] - layers.full[i]));
        let both = 0,
          either = 0,
          outsideBoxes = 0,
          fixturePixels = 0;
        const slack = 2;
        for (let y = 0; y < mask.height; y++)
          for (let x = 0; x < mask.width; x++) {
            const i = y * mask.width + x;
            const inMask = mask.data[i] === 255,
              inLayer = layers.coverage[i] > 127;
            if (inMask && inLayer) both++;
            if (inMask || inLayer) either++;
            if (!inMask) continue;
            fixturePixels++;
            const inside = boxes.some(
              ([x0, y0, x1, y1]) =>
                x >= x0 * mask.width - slack &&
                x <= x1 * mask.width + slack &&
                y >= y0 * mask.height - slack &&
                y <= y1 * mask.height + slack,
            );
            if (!inside) outsideBoxes++;
          }
        agreement.push({
          direction,
          size: [exported.width, exported.height, layers.width, layers.height, mask.width, mask.height],
          fullDiff,
          fixturePixels,
          maskLayerIoU: either ? both / either : 1,
          maskOutsideBoxes: outsideBoxes,
          boxes: boxes.map((b) => b.map((v) => Math.round(v * 1000) / 1000)),
        });
      }
      return { gpuName, limits, captures, agreement };
    } finally {
      viewer.dispose();
    }
  });
  const toPng = (url: string) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  for (const capture of run.captures) await writeFile(`${output}/${capture.name}.png`, toPng(capture.url));
  // A contact sheet: every capture at 480 px with its name and direction.
  const tile = { width: 480, height: Math.round((480 * run.captures[0].height) / run.captures[0].width) };
  const label = 28;
  const columns = 3;
  const rows = Math.ceil(run.captures.length / columns);
  const tiles = await Promise.all(
    run.captures.map(async (capture, i) => {
      const text = `${capture.name} · 좌우 ${capture.direction.yaw.toFixed(2)}° · 위아래 ${capture.direction.pitch.toFixed(2)}° · 바깥 ${capture.magenta}px`;
      const caption = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${tile.width}" height="${label}"><rect width="100%" height="100%" fill="#ffffff"/><text x="6" y="19" font-family="sans-serif" font-size="14" fill="#222">${text}</text></svg>`,
      );
      return [
        {
          input: await sharp(toPng(capture.url)).resize(tile.width, tile.height).png().toBuffer(),
          left: (i % columns) * tile.width,
          top: Math.floor(i / columns) * (tile.height + label) + label,
        },
        {
          input: caption,
          left: (i % columns) * tile.width,
          top: Math.floor(i / columns) * (tile.height + label),
        },
      ];
    }),
  );
  await sharp({
    create: {
      width: tile.width * columns,
      height: rows * (tile.height + label),
      channels: 3,
      background: '#ffffff',
    },
  })
    .composite(tiles.flat())
    .png()
    .toFile(`${output}/sheet${gpu ? '-gpu' : ''}.png`);
  const report = {
    gpu: run.gpuName,
    limits: run.limits,
    captures: run.captures.map(({ name, direction, width, height, magenta, sampledOutside }) => ({
      name,
      direction,
      width,
      height,
      magenta,
      sampledOutside,
    })),
    agreement: run.agreement,
    errors,
  };
  await writeFile(`${output}/summary${gpu ? '-gpu' : ''}.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  for (const capture of run.captures) {
    const control = capture.name === 'past-right-control';
    assert.equal(capture.sampledOutside > 0, control, `${capture.name}: sampled rays`);
    if (control) assert.ok(capture.magenta > 1000, 'the control shows the outside');
    else assert.equal(capture.magenta, 0, `${capture.name}: no outside pixel`);
  }
  for (const a of run.agreement) {
    assert.ok(
      a.size.every((v, i) => v === a.size[i % 2]),
      `one pixel grid ${a.size}`,
    );
    assert.ok(a.fullDiff <= 2, `the fixture layers' full frame is the export (${a.fullDiff})`);
    assert.ok(a.fixturePixels > 1000, 'fixtures are in view');
    assert.ok(a.maskLayerIoU > 0.97, `mask and render agree (${a.maskLayerIoU})`);
    assert.equal(a.maskOutsideBoxes, 0, 'the fixture boxes hold every fixture pixel of the mask');
  }
  // The tilt really moves the picture: the same fixtures land elsewhere.
  assert.notDeepEqual(run.agreement[0].boxes, run.agreement[2].boxes);
  assert.deepEqual(errors, []);
  console.log('flux-free-view-browser: ok');
} finally {
  await browser.close();
}
