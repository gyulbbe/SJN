/** Standard geometry and PNG QA only. No fixture here is an AI detection. */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const output = 'test-results/reconstruction-basin-models-20260913';
const bundle = await build({
  stdin: {
    contents: `
export { renderReconstructionTemplate } from './src/lib/reconstruction/templates';
export { PhotoCompositor } from './src/lib/render/compositor';
export { projectReconstructionFixture } from './src/lib/reconstruction/projection';
export { DEFAULT_ROOM } from './src/lib/room-geometry';
export { DEFAULT_COLOR, EMPTY_MASK } from './src/lib/types';
`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
});
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html');
  res.end(
    req.url === '/bundle.js'
      ? bundle.outputFiles[0].text
      : '<html lang="ko"><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body style="margin:20px;font:16px sans-serif;background:#f1f3f3"><h1>세면대 표준 모형 검증</h1><p>수동 지정한 검증 모형 · AI 인식 결과 아님</p><main style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px"></main></body></html>',
  );
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
try {
  await mkdir(output, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors: string[] = [],
    requests: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(origin);
  const result = await page.evaluate(async (base) => {
    const m = await import(base + '/bundle.js');
    const configs = [
      {
        label: '사각 · 기둥형',
        basinVariant: 'pedestal',
        basinShape: 'rectangular',
        bowlCount: 1,
        face: 'floor',
        heightMm: 800,
        baseHeightMm: 0,
      },
      {
        label: '곡면 · 벽걸이',
        basinVariant: 'wall',
        basinShape: 'round',
        bowlCount: 1,
        face: 'back',
        heightMm: 320,
        baseHeightMm: 650,
      },
      {
        label: '사각 · 벽걸이',
        basinVariant: 'wall',
        basinShape: 'rectangular',
        bowlCount: 1,
        face: 'back',
        heightMm: 320,
        baseHeightMm: 650,
      },
      {
        label: '곡면 · 하부장 1볼',
        basinVariant: 'vanity',
        basinShape: 'round',
        bowlCount: 1,
        face: 'floor',
        heightMm: 850,
        baseHeightMm: 0,
      },
      {
        label: '사각 · 하부장 2볼',
        basinVariant: 'vanity',
        basinShape: 'rectangular',
        bowlCount: 2,
        face: 'floor',
        heightMm: 850,
        baseHeightMm: 0,
      },
      {
        label: '사각 · 벽걸이 하부장',
        basinVariant: 'vanity',
        basinShape: 'rectangular',
        bowlCount: 2,
        face: 'back',
        heightMm: 600,
        baseHeightMm: 350,
      },
    ];
    const images = [];
    for (const [i, config] of configs.entries()) {
      const render = await m.renderReconstructionTemplate({
        ...config,
        kind: 'basin',
        version: 2,
        color: '#d8ddd9',
        widthMm: config.basinVariant === 'vanity' ? 1200 : 600,
        depthMm: 450,
        room: m.DEFAULT_ROOM,
        u: 0.5,
        v: 0.25,
        aspect: 1.5,
      });
      const bitmap = await createImageBitmap(render.blob),
        canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      let transparent = 0,
        visible = 0;
      for (let p = 3; p < pixels.length; p += 4) {
        if (pixels[p] === 0) transparent++;
        if (pixels[p] > 240) visible++;
      }
      const image = document.createElement('img');
      image.src = canvas.toDataURL();
      image.alt = config.label;
      image.style.cssText =
        'width:100%;height:320px;object-fit:contain;background:repeating-conic-gradient(#fff 0% 25%,#e0e5e5 0% 50%) 50% / 20px 20px';
      const card = document.createElement('section'),
        label = document.createElement('h2');
      label.textContent = config.label;
      card.append(label, image);
      document.querySelector('main')!.append(card);
      images.push({
        label: config.label,
        name: 'basin-' + i,
        width: canvas.width,
        height: canvas.height,
        transparent,
        visible,
        url: canvas.toDataURL(),
      });
    }
    const bg = document.createElement('canvas');
    bg.width = 900;
    bg.height = 600;
    bg.getContext('2d')!.fillStyle = '#bfc8cd';
    bg.getContext('2d')!.fillRect(0, 0, 900, 600);
    const background = await new Promise<Blob>((done) => bg.toBlob((blob) => done(blob!)));
    const fixture = {
      id: 'same-model',
      materialVersionId: 'material',
      viewIndex: 0,
      name: 'count edit',
      position: { x: 0.5, y: 0.5 },
      width: 0.2,
      height: 0.2,
      rotation: 0,
      anchor: { x: 0.5, y: 1 },
      locked: false,
      shadow: { x: 0, y: 0, opacity: 0, blur: 0, scale: 1 },
      occlusion: m.EMPTY_MASK(),
      color: { ...m.DEFAULT_COLOR },
      roomPlacement: {
        face: 'floor',
        u: 0.5,
        v: 0.35,
        scale: 1,
        widthMm: 1200,
        heightMm: 850,
        imageAspect: 1,
        contentBounds: { left: 0, right: 1, top: 0, bottom: 1 },
      },
      reconstruction: {
        version: 2,
        kind: 'vanity',
        color: '#d8ddd9',
        widthMm: 1200,
        heightMm: 850,
        depthMm: 450,
        basinShape: 'rectangular',
        bowlCount: 1,
        baseHeightMm: 0,
      },
    };
    m.projectReconstructionFixture(m.DEFAULT_ROOM, fixture, 1.5);
    const compositor = new m.PhotoCompositor(),
      scene = {
        room: m.DEFAULT_ROOM,
        originalAssetId: 'bg',
        previewAssetId: 'bg',
        imageWidth: 900,
        imageHeight: 600,
        surfaces: [],
        fixtures: [fixture],
        protection: m.EMPTY_MASK(),
        color: { ...m.DEFAULT_COLOR },
      };
    const materials = { material: { id: 'material', views: [], imageAssetIds: [], textureAssetIds: [] } };
    const reader = async () => ({ id: 'bg', blob: background, kind: 'background', width: 900, height: 600 });
    const capture = async () => {
      await compositor.setSnapshot({ scene, materials }, reader);
      const canvas = document.createElement('canvas');
      canvas.width = 900;
      canvas.height = 600;
      canvas.getContext('2d')!.drawImage(compositor.render(900, 600), 0, 0);
      return canvas.getContext('2d')!.getImageData(0, 0, 900, 600).data;
    };
    const one = await capture();
    fixture.reconstruction.bowlCount = 2;
    const two = await capture();
    fixture.reconstruction.bowlCount = 1;
    const again = await capture();
    let changed = 0,
      restoredDifference = 0;
    for (let i = 0; i < one.length; i += 4) {
      if (Math.max(...[0, 1, 2].map((c) => Math.abs(one[i + c] - two[i + c]))) > 8) changed++;
      restoredDifference = Math.max(
        restoredDifference,
        ...[0, 1, 2].map((c) => Math.abs(one[i + c] - again[i + c])),
      );
    }
    compositor.dispose();
    return {
      images,
      changed,
      restoredDifference,
      browser: navigator.userAgent,
      renderer: 'SwiftShader software WebGL; no model inference',
    };
  }, origin);
  assert.deepEqual(errors, []);
  assert(requests.every((url) => url.startsWith(origin)));
  assert(
    result.changed > 1000,
    'same fixture changing 1→2 bowls must invalidate the standard geometry cache',
  );
  assert(result.restoredDifference <= 1, 'undo to one bowl must restore identical rendered pixels');
  for (const item of result.images) {
    assert(item.transparent > 1000 && item.visible > 1000, 'PNG retains transparency and visible geometry');
    await writeFile(`${output}/${item.name}.png`, Buffer.from(item.url.split(',')[1], 'base64'));
  }
  await page.screenshot({ path: `${output}/gallery.png`, fullPage: true });
  const report = {
    scope: 'Procedural geometry/PNG/cache regression, not AI recognition quality',
    browser: result.browser,
    renderer: result.renderer,
    changed: result.changed,
    restoredDifference: result.restoredDifference,
    requests,
    images: result.images.map((item) => ({
      label: item.label,
      name: item.name,
      width: item.width,
      height: item.height,
      transparent: item.transparent,
      visible: item.visible,
    })),
  };
  await writeFile(`${output}/result.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await new Promise<void>((done, fail) => server.close((e) => (e ? fail(e) : done())));
}
