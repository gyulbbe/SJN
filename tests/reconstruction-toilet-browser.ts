/** Standard geometry and PNG QA only. No fixture here is an AI detection. */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const output = 'test-results/reconstruction-toilet-lid-20260913';
const bundle = await build({
  stdin: {
    contents: `
export { renderReconstructionTemplate } from './src/lib/reconstruction/templates';
export { PhotoCompositor } from './src/lib/render/compositor';
export { projectReconstructionFixture } from './src/lib/reconstruction/projection';
export { DEFAULT_ROOM } from './src/lib/room-geometry';
export { DEFAULT_COLOR, EMPTY_MASK } from './src/lib/types';
export { default as Controls, fixtureForm } from './src/components/reconstruction/reconstruction-fixture-controls';
export { createRoot } from 'react-dom/client';
export { createElement } from 'react';
`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  outfile: 'test-results/virtual-toilet-bundle.js',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
});
const script = bundle.outputFiles.find((file) => file.path.endsWith('.js'))!.text;
const css = bundle.outputFiles.find((file) => file.path.endsWith('.css'))?.text ?? '';
const server = createServer((req, res) => {
  res.setHeader(
    'Content-Type',
    req.url === '/bundle.js' ? 'text/javascript' : req.url === '/bundle.css' ? 'text/css' : 'text/html',
  );
  res.end(
    req.url === '/bundle.js'
      ? script
      : req.url === '/bundle.css'
        ? css
        : '<html lang="ko"><head><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/bundle.css"></head><body style="margin:20px;font:16px sans-serif;background:#f1f3f3"><h1>변기 뚜껑 표준 모형 검증</h1><p>수동 지정한 검증 모형 · AI 인식 결과 아님</p><main style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px"></main></body></html>',
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
      { label: '이전 모형 · 상태 없음', toiletLidState: undefined },
      { label: '뚜껑 열림 · 규칙/사용자 선택용', toiletLidState: 'open' },
      { label: '뚜껑 닫힘 · 신규 기본값', toiletLidState: 'closed' },
    ];
    const images = [];
    for (const [i, config] of configs.entries()) {
      const render = await m.renderReconstructionTemplate({
        ...config,
        kind: 'toilet',
        face: 'floor',
        heightMm: 750,
        version: 2,
        color: '#d8ddd9',
        widthMm: 400,
        depthMm: 680,
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
        name: 'toilet-' + i,
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
      name: 'lid edit',
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
        widthMm: 400,
        heightMm: 750,
        imageAspect: 1,
        contentBounds: { left: 0, right: 1, top: 0, bottom: 1 },
      },
      reconstruction: {
        version: 2,
        kind: 'toilet',
        color: '#d8ddd9',
        widthMm: 400,
        heightMm: 750,
        depthMm: 680,
        toiletLidState: undefined as 'open' | 'closed' | undefined,
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
    fixture.reconstruction.toiletLidState = 'open';
    const two = await capture();
    fixture.reconstruction.toiletLidState = undefined;
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
    result.changed > 200,
    'same fixture changing legacy→open lid must invalidate the standard geometry cache',
  );
  assert(result.restoredDifference <= 1, 'undo to legacy state must restore identical rendered pixels');
  for (const item of result.images) {
    assert(item.transparent > 1000 && item.visible > 1000, 'PNG retains transparency and visible geometry');
    await writeFile(`${output}/${item.name}.png`, Buffer.from(item.url.split(',')[1], 'base64'));
  }
  await page.screenshot({ path: `${output}/gallery.png`, fullPage: true });
  await page.evaluate(async (base) => {
    const m = await import(base + '/bundle.js');
    const container = document.createElement('section');
    container.id = 'controls';
    document.body.append(container);
    const root = m.createRoot(container);
    let value = m.fixtureForm(
      { room: m.DEFAULT_ROOM },
      {
        reconstruction: { version: 2, kind: 'toilet' },
        roomPlacement: { face: 'floor', u: 0.5, v: 0.5, scale: 1 },
      },
    );
    const render = () =>
      root.render(
        m.createElement(m.Controls, {
          kind: 'toilet',
          value,
          disabled: false,
          onChange: (next: typeof value) => {
            value = next;
            container.dataset.lid = next.toiletLidState;
            render();
          },
          onBasinVariant: () => {},
        }),
      );
    render();
  }, origin);
  const selector = page.getByLabel('변기 뚜껑 상태');
  await selector.waitFor();
  assert.equal(await selector.inputValue(), 'legacy');
  await selector.selectOption('open');
  assert.equal(await page.locator('#controls').getAttribute('data-lid'), 'open');
  await selector.selectOption('closed');
  assert.equal(await page.locator('#controls').getAttribute('data-lid'), 'closed');
  await page.screenshot({ path: `${output}/controls.png`, fullPage: true });
  assert.deepEqual(errors, []);

  const report = {
    scope:
      'Actual standard-model PNG/cache and shared fixture-control UI; procedural inputs, not AI recognition quality',
    controls: 'Legacy absent state stays unchanged, user can select open or closed',
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
