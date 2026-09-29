/**
 * Real-WebGL check of the AI input's outside orbit view (no AI call). The terrazzo comparison room
 * is rendered from the front, right, back, left, straight above and one in-between direction with
 * the white backdrop. For each view it checks that the backdrop is one plain white, that the walls
 * facing the camera are cut away and no ceiling is drawn, that the face mask, the fixture boxes and
 * the fixture layer agree with the render (one camera), and that a fake wall painted into a mock
 * result's margin and open side is gone after the backdrop is put back. Captures, the restored mock
 * results and a contact sheet go to test-results/flux-orbit-view/.
 *
 * Usage: node tests/run-browser-test.mjs tests/flux-orbit-view-browser.ts [--gpu]
 */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const gpu = process.argv.includes('--gpu');
const output = 'test-results/flux-orbit-view';
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/room-viewer/renderer';export * from './src/lib/ai-export/view';export * from './src/lib/ai-export/backdrop';export {buildFluxRoomScene} from './tests/helpers/flux-room-scene';export {readPixels,pixelsToPng} from './src/lib/ai-export/client';export {fluxInputLayout} from './src/lib/ai-export/contract';export {visibleCeiling,visibleWalls} from './src/lib/ai-export/scene';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: 'Orbit',
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
      typeof import('../src/lib/ai-export/backdrop') &
      Pick<typeof import('./helpers/flux-room-scene'), 'buildFluxRoomScene'> &
      Pick<typeof import('../src/lib/ai-export/client'), 'readPixels' | 'pixelsToPng'> &
      Pick<typeof import('../src/lib/ai-export/contract'), 'fluxInputLayout'> &
      Pick<typeof import('../src/lib/ai-export/scene'), 'visibleCeiling' | 'visibleWalls'>;
    type RoomOrbit = import('../src/lib/room-viewer/view-state').RoomOrbit;
    type Pixels = import('../src/lib/ai-export/color').Pixels;
    const lib = (window as unknown as { Orbit: Lib }).Orbit;
    const gl = document.createElement('canvas').getContext('webgl2');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    const gpuName = gl && debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    const dataUrl = (blob: Blob) =>
      new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.readAsDataURL(blob);
      });
    const { assets, snapshot, imageWidth, imageHeight } = await lib.buildFluxRoomScene();
    const reader = async (id: string) => assets[id];
    const edge = Math.min(1024, Math.max(imageWidth, imageHeight));
    const views: [string, RoomOrbit][] = [
      ['front', { azimuth: 0, elevation: 0 }],
      ['right', { azimuth: 90, elevation: 0 }],
      ['back', { azimuth: 180, elevation: 0 }],
      ['left', { azimuth: -90, elevation: 0 }],
      ['top', { azimuth: 0, elevation: 90 }],
      ['right-45-up-30', { azimuth: 45, elevation: 30 }],
    ];
    const viewer = new lib.RoomViewerRenderer();
    const out = [];
    try {
      await viewer.setSnapshot(snapshot, reader, { background: lib.FLUX_BACKDROP });
      for (const [name, orbit] of views) {
        const view = lib.fluxOrbitView(orbit);
        const blob = await viewer.export(view, { format: 'png', mode: 'after', longEdge: edge });
        const pixels = await lib.readPixels(blob);
        const mask = viewer.regionMask(
          Math.min(edge, (edge * imageWidth) / imageHeight),
          Math.min(edge, (edge * imageHeight) / imageWidth),
          view,
        );
        const layers = viewer.exportLayers(view, { longEdge: edge });
        const boxes = Object.values(viewer.fixtureBounds(imageWidth, imageHeight, view));
        // The backdrop: every pixel 2+ pixels inside it is exactly white.
        const { width, height } = mask;
        const outside = mask.outside!;
        let backdrop = 0,
          notWhite = 0,
          maxOff = 0;
        for (let y = 2; y < height - 2; y++)
          for (let x = 2; x < width - 2; x++) {
            let deep = true;
            for (let dy = -2; dy <= 2 && deep; dy++)
              for (let dx = -2; dx <= 2 && deep; dx++) if (!outside[(y + dy) * width + x + dx]) deep = false;
            if (!deep) continue;
            backdrop++;
            const o = (y * width + x) * 4;
            const off = Math.max(...[0, 1, 2].map((c) => 255 - pixels.data[o + c]));
            maxOff = Math.max(maxOff, off);
            if (off > 0) notWhite++;
          }
        let outsideShare = 0;
        for (const value of outside) outsideShare += value;
        outsideShare /= outside.length;
        // One camera: the full layer is the export, and the mask's fixtures are the layer's.
        let fullDiff = 0;
        for (let i = 0; i < pixels.data.length; i++)
          fullDiff = Math.max(fullDiff, Math.abs(pixels.data[i] - layers.full[i]));
        let both = 0,
          either = 0,
          outsideBoxes = 0,
          fixturePixels = 0;
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            const i = y * width + x;
            const inMask = mask.data[i] === 255,
              inLayer = layers.coverage[i] > 127;
            if (inMask && inLayer) both++;
            if (inMask || inLayer) either++;
            if (!inMask) continue;
            fixturePixels++;
            if (
              !boxes.some(
                ([x0, y0, x1, y1]) =>
                  x >= x0 * width - 2 && x <= x1 * width + 2 && y >= y0 * height - 2 && y <= y1 * height + 2,
              )
            )
              outsideBoxes++;
          }
        // A mock result that changed nothing but drew a dark wall across the margin and the open
        // side: the input at result size, with a band painted over the top-left quarter.
        const layout = lib.fluxInputLayout(pixels.width, pixels.height);
        const canvas = document.createElement('canvas');
        canvas.width = layout.width * 2;
        canvas.height = layout.height * 2;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const bitmap = await createImageBitmap(blob);
        ctx.drawImage(bitmap, layout.x * 2, layout.y * 2, layout.contentWidth * 2, layout.contentHeight * 2);
        bitmap.close();
        ctx.fillStyle = '#5a4a3a';
        ctx.fillRect(0, 0, canvas.width, canvas.height * 0.18);
        ctx.fillRect(0, 0, canvas.width * 0.12, canvas.height);
        const faked = await lib.readPixels(
          await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/png')),
        );
        const restored = lib.restoreBackdrop({ result: faked, capture: pixels, mask, layout })!;
        const map = lib.backdropAtResult(mask, layout, restored)!;
        let fakeLeft = 0,
          roomChanged = 0,
          judged = 0;
        const rw = restored.width,
          rh = restored.height;
        for (let v = 2; v < rh - 2; v++)
          for (let u = 2; u < rw - 2; u++) {
            let same = true;
            for (let dv = -2; dv <= 2 && same; dv++)
              for (let du = -2; du <= 2 && same; du++)
                if (map[(v + dv) * rw + u + du] !== map[v * rw + u]) same = false;
            if (!same) continue;
            judged++;
            const o = (v * rw + u) * 4;
            if (map[v * rw + u]) {
              if (restored.data[o] < 250 || restored.data[o + 1] < 250 || restored.data[o + 2] < 250)
                fakeLeft++;
            } else if ([0, 1, 2].some((c) => restored.data[o + c] !== faked.data[o + c])) roomChanged++;
          }
        out.push({
          name,
          orbit,
          label: lib.fluxOrbitLabel(orbit),
          size: [pixels.width, pixels.height, mask.width, mask.height, layers.width, layers.height],
          outsideShare,
          backdrop,
          notWhite,
          maxOff,
          ceiling: lib.visibleCeiling(mask),
          walls: lib.visibleWalls(mask, snapshot.scene),
          fullDiff,
          fixturePixels,
          maskLayerIoU: either ? both / either : 1,
          outsideBoxes,
          fakeLeft,
          roomChanged,
          judged,
          url: await dataUrl(blob),
          faked: await dataUrl(await lib.pixelsToPng(faked as Pixels)),
          restored: await dataUrl(await lib.pixelsToPng(restored)),
        });
      }
      return { gpuName, views: out };
    } finally {
      viewer.dispose();
    }
  });
  const toPng = (url: string) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  for (const view of run.views) {
    await writeFile(`${output}/${view.name}.png`, toPng(view.url));
    await writeFile(`${output}/${view.name}-mock-fake-wall.png`, toPng(view.faked));
    await writeFile(`${output}/${view.name}-mock-restored.png`, toPng(view.restored));
  }
  // A contact sheet: every capture at 480 px with its name, label and backdrop share.
  const first = await sharp(toPng(run.views[0].url)).metadata();
  const tile = { width: 480, height: Math.round((480 * first.height!) / first.width!) };
  const label = 28,
    columns = 3,
    rows = Math.ceil(run.views.length / columns);
  const tiles = await Promise.all(
    run.views.map(async (view, i) => {
      const text = `${view.name} · ${view.label} · 여백 ${Math.round(view.outsideShare * 100)}%`;
      const caption = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${tile.width}" height="${label}"><rect width="100%" height="100%" fill="#eeeeee"/><text x="6" y="19" font-family="sans-serif" font-size="14" fill="#222">${text}</text></svg>`,
      );
      const left = (i % columns) * tile.width,
        top = Math.floor(i / columns) * (tile.height + label);
      return [
        {
          input: await sharp(toPng(view.url)).resize(tile.width, tile.height).png().toBuffer(),
          left,
          top: top + label,
        },
        { input: caption, left, top },
      ];
    }),
  );
  await sharp({
    create: {
      width: tile.width * columns,
      height: rows * (tile.height + label),
      channels: 3,
      background: '#cccccc',
    },
  })
    .composite(tiles.flat())
    .png()
    .toFile(`${output}/sheet${gpu ? '-gpu' : ''}.png`);
  const report = {
    gpu: run.gpuName,
    // The pictures are written as files; the summary keeps the numbers.
    views: run.views.map((view) =>
      Object.fromEntries(Object.entries(view).filter(([key]) => !['url', 'faked', 'restored'].includes(key))),
    ) as Omit<(typeof run.views)[number], 'url' | 'faked' | 'restored'>[],
    errors,
  };
  await writeFile(`${output}/summary${gpu ? '-gpu' : ''}.json`, JSON.stringify(report, null, 2));
  for (const v of report.views)
    console.log(
      `${v.name.padEnd(16)} ${v.label.padEnd(14)} 여백 ${(v.outsideShare * 100).toFixed(1)}% 흰색아님 ${v.notWhite}/${v.backdrop} 천장 ${v.ceiling} 벽 ${v.walls.join(',')} IoU ${v.maskLayerIoU.toFixed(3)} 상자밖 ${v.outsideBoxes} 가짜벽남음 ${v.fakeLeft} 방변경 ${v.roomChanged}`,
    );

  const cutAway: Record<string, string> = { right: 'right', back: 'back', left: 'left' };
  for (const v of report.views) {
    assert.ok(
      v.size.every((value, i) => value === v.size[i % 2]),
      `${v.name}: one pixel grid ${v.size}`,
    );
    assert.ok(v.backdrop > 1000, `${v.name}: a backdrop around the room`);
    assert.equal(v.notWhite, 0, `${v.name}: the backdrop is plain white (max off ${v.maxOff})`);
    // A cube-like room in the 3:2 input leaves side margins, and from behind the open front shows
    // the backdrop too; the fit itself (the outline touching the frame) is a unit test.
    assert.ok(v.outsideShare < 0.75, `${v.name}: the room fills the frame (${v.outsideShare})`);
    assert.equal(v.ceiling, false, `${v.name}: no ceiling drawn`);
    if (cutAway[v.name])
      assert.ok(!v.walls.includes(cutAway[v.name] as never), `${v.name}: near wall cut away`);
    assert.ok(v.fullDiff <= 2, `${v.name}: the full layer is the export (${v.fullDiff})`);
    if (v.fixturePixels > 500) {
      assert.ok(v.maskLayerIoU > 0.97, `${v.name}: mask and render agree (${v.maskLayerIoU})`);
      assert.equal(v.outsideBoxes, 0, `${v.name}: the fixture boxes hold every fixture pixel`);
    }
    assert.equal(v.fakeLeft, 0, `${v.name}: the fake wall in the margin is gone`);
    assert.equal(v.roomChanged, 0, `${v.name}: room pixels are the result's`);
  }
  assert.deepEqual(errors, []);
  console.log('flux-orbit-view-browser: ok');
} finally {
  await browser.close();
}
