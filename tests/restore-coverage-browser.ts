/** Browser coverage and shared-edge regression; no fixture or semantic inference mocks are needed. */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const bundle = await build({
  stdin: {
    resolveDir: resolve('.'),
    contents: "export * from './src/lib/render/mask'; export * from './src/lib/restore-tile-coverage';",
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'Coverage',
});
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<body><canvas></canvas></body>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    type Api = typeof import('../src/lib/render/mask') & typeof import('../src/lib/restore-tile-coverage');
    const api = (window as unknown as { Coverage: Api }).Coverage;
    const rect = (l: number, t: number, r: number, b: number): import('../src/lib/types').Quad => [
      { x: l, y: t },
      { x: r, y: t },
      { x: r, y: b },
      { x: l, y: b },
    ];
    const unit = rect(0, 0, 1, 1);
    const canvas = (w: number, h: number) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    };
    const dimensions = [
      [97, 71],
      [333, 249],
      [4096, 3072],
    ];
    const checks = [];
    for (const [width, height] of dimensions)
      for (const erase of [false, true]) {
        const actual = canvas(width, height),
          ctx = actual.getContext('2d')!;
        api.paintMask(
          ctx,
          {
            polygon: erase ? unit : [],
            strokes: [
              { radius: 0, erase, points: rect(0.1, 0.2, 1 / 3, 0.8) },
              { radius: 0, erase, points: rect(1 / 3, 0.2, 0.6, 0.8) },
              { radius: 0, erase, points: rect(0.6, 0.2, 0.9, 0.8) },
            ],
          },
          width,
          height,
        );
        const expected = canvas(width, height),
          ref = expected.getContext('2d')!;
        ref.fillStyle = 'white';
        if (erase) ref.fillRect(0, 0, width, height);
        ref.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
        ref.beginPath();
        ref.moveTo(width * 0.1, height * 0.2);
        ref.lineTo(width * 0.9, height * 0.2);
        ref.lineTo(width * 0.9, height * 0.8);
        ref.lineTo(width * 0.1, height * 0.8);
        ref.closePath();
        ref.fill();
        const pixels = ctx.getImageData(0, 0, width, height).data,
          wanted = ref.getImageData(0, 0, width, height).data;
        let maxAlphaDifference = 0,
          interiorWrongPixels = 0,
          nonBoundaryDifferencePixels = 0;
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4 + 3;
            maxAlphaDifference = Math.max(maxAlphaDifference, Math.abs(pixels[p] - wanted[p]));
            // Chrome uses different AA quantization for a complex path and its single-rectangle
            // fast path. Differences are permitted only on the one-pixel exterior AA boundary.
            if (
              pixels[p] !== wanted[p] &&
              Math.abs(x - width * 0.1) > 1 &&
              Math.abs(x - width * 0.9) > 1 &&
              Math.abs(y - height * 0.2) > 1 &&
              Math.abs(y - height * 0.8) > 1
            )
              nonBoundaryDifferencePixels++;
            if (
              x > width * 0.1 + 1 &&
              x < width * 0.9 - 1 &&
              y > height * 0.2 + 1 &&
              y < height * 0.8 - 1 &&
              pixels[p] !== (erase ? 0 : 255)
            )
              interiorWrongPixels++;
          }
        checks.push({
          width,
          height,
          erase,
          maxAlphaDifference,
          interiorWrongPixels,
          nonBoundaryDifferencePixels,
        });
      }
    const selection = canvas(160, 120),
      selectionContext = selection.getContext('2d')!;
    selectionContext.fillStyle = 'white';
    selectionContext.fillRect(64, 36, 32, 72);
    const neutral = { exposure: 0, contrast: 1, saturation: 1, warmth: 0 };
    const tile = {
      rotation: 0,
      offsetX: 0,
      offsetY: 0,
      groutWidth: 2,
      groutColor: '#888888',
      pattern: 'grid' as const,
      seed: 12,
      shading: 0.25,
    };
    const scene: import('../src/lib/types').Scene = {
      originalAssetId: 'original',
      previewAssetId: 'preview',
      imageWidth: 160,
      imageHeight: 120,
      color: neutral,
      fixtures: [],
      protection: { polygon: unit, strokes: [] },
      surfaces: [
        {
          id: 'wall',
          name: '벽',
          kind: 'wall',
          quad: rect(0, 0, 1, 0.6),
          mask: { polygon: rect(0, 0, 1, 0.6), holes: [rect(0.35, 0.2, 0.65, 0.95)], strokes: [] },
          tile,
          color: neutral,
          widthMm: 2000,
          heightMm: 2000,
          calibrated: false,
        },
        {
          id: 'floor',
          name: '바닥',
          kind: 'floor',
          quad: rect(0, 0.6, 1, 1),
          mask: { polygon: rect(0, 0.6, 1, 1), holes: [rect(0.35, 0.2, 0.65, 0.95)], strokes: [] },
          tile,
          color: neutral,
          widthMm: 2000,
          heightMm: 2000,
          calibrated: false,
        },
      ],
    };
    const restored = await api.restoreTileCoverage(scene, selection, ['wall', 'floor']);
    const combined = canvas(333, 249),
      combinedContext = combined.getContext('2d')!;
    let outsideChangedPixels = 0;
    for (let i = 0; i < scene.surfaces.length; i++) {
      const before = api.maskCanvas(scene.surfaces[i].mask, 160, 120, scene.protection);
      const after = api.maskCanvas(restored.surfaces[i].mask, 160, 120, restored.protection);
      const a = before.getContext('2d')!.getImageData(0, 0, 160, 120).data,
        b = after.getContext('2d')!.getImageData(0, 0, 160, 120).data;
      for (let y = 0; y < 120; y++)
        for (let x = 0; x < 160; x++)
          if (x < 64 || x >= 96 || y < 36 || y >= 108) {
            const p = (y * 160 + x) * 4 + 3;
            if (a[p] !== b[p]) outsideChangedPixels++;
          }
      combinedContext.drawImage(
        api.maskCanvas(restored.surfaces[i].mask, 333, 249, restored.protection),
        0,
        0,
      );
    }
    return {
      checks,
      outsideChangedPixels,
      wallRestored: api.surfaceContains(restored.surfaces[0].mask, restored.protection, { x: 0.5, y: 0.4 }),
      floorRestored: api.surfaceContains(restored.surfaces[1].mask, restored.protection, { x: 0.5, y: 0.8 }),
      image: combined.toDataURL(),
    };
  });
  const { image, ...summary } = result;
  await mkdir('test-results/restore-coverage', { recursive: true });
  await writeFile('test-results/restore-coverage/mask.png', Buffer.from(image.split(',')[1], 'base64'));
  await writeFile(
    'test-results/restore-coverage/report.json',
    JSON.stringify({ browser: await browser.version(), ...summary }, null, 2),
  );
  for (const check of result.checks) {
    assert.equal(check.interiorWrongPixels, 0, 'Adjacent polygon patches must not show internal seams');
    assert.equal(check.nonBoundaryDifferencePixels, 0, 'Patch differences must be restricted to exterior AA');
  }
  assert.equal(result.outsideChangedPixels, 0);
  assert.equal(result.wallRestored, true);
  assert.equal(result.floorRestored, true);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
}
