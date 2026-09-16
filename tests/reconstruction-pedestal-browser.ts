/** Synthetic model/UI regression. These are user-selected procedural models, not AI recognition. */
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const output = process.env.SJN_PEDESTAL_OUTPUT ?? 'test-results/reconstruction-pedestal-shape-20260914/run-01';
const sources = [
  'src/lib/reconstruction/templates.ts',
  'src/lib/reconstruction/types.ts',
  'src/lib/render/standard-model-render.ts',
  'src/components/reconstruction/reconstruction-fixture-controls.tsx',
];
const hashSources = async () =>
  Object.fromEntries(
    await Promise.all(
      sources.map(async (path) => [
        path,
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      ]),
    ),
  );
const sourceHashes = await hashSources();
const bundle = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'tsx',
    contents: `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import Controls,{fixtureForm} from './src/components/reconstruction/reconstruction-fixture-controls';
import {DEFAULT_ROOM} from './src/lib/room-geometry';
export {renderReconstructionTemplate} from './src/lib/reconstruction/templates';
export {PhotoCompositor} from './src/lib/render/compositor';
export {DEFAULT_ROOM} from './src/lib/room-geometry';
export {DEFAULT_COLOR,EMPTY_MASK} from './src/lib/types';
export {projectReconstructionFixture} from './src/lib/reconstruction/projection';
export function mount(){
 const source={reconstruction:{version:2,kind:'basin',basinVariant:'pedestal',basinShape:'rectangular',color:'#eeeeee',widthMm:600,heightMm:800,depthMm:480},roomPlacement:{face:'floor',u:.5,v:.5},anchor:{x:.5,y:1}};
 const snapshot=JSON.stringify(source),scene={room:DEFAULT_ROOM};
 function App(){
  const [value,setValue]=useState(fixtureForm(scene,source)),[disabled,setDisabled]=useState(false);
  window.pedestalForm=()=>({value,sourceUnchanged:JSON.stringify(source)===snapshot});
  return <main><h1>기둥 단면: 명시적 사용자 선택 검사</h1><p>볼 모양에서 받침을 추론하지 않아요. 아래 테스트 모형은 AI 결과가 아니에요.</p>
   <button onClick={()=>setDisabled(!disabled)}>입력 잠금 전환</button>
   <Controls kind="basin" dimensions={{widthMm:600,depthMm:480}} value={value} disabled={disabled} onChange={setValue} onBasinVariant={variant=>setValue(v=>({...v,basinVariant:variant}))}/>
   <output data-testid="shape">{value.pedestalShape??'unknown'}</output>
  </main>;
 }
 createRoot(document.getElementById('root')).render(<App/>);
}
`,
  },
  bundle: true,
  write: false,
  outfile: 'bundle.js',
  platform: 'browser',
  format: 'esm',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' },
});
const server = createServer((request, response) => {
  if (request.url === '/bundle.js') {
    response.setHeader('Content-Type', 'text/javascript');
    response.end(bundle.outputFiles.find((file) => file.path.endsWith('.js'))!.text);
  } else if (request.url === '/bundle.css') {
    response.setHeader('Content-Type', 'text/css');
    response.end(bundle.outputFiles.find((file) => file.path.endsWith('.css'))!.text);
  } else {
    response.setHeader('Content-Type', 'text/html');
    response.end(
      '<html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/bundle.css"><style>body{font:16px sans-serif;background:#f5f4ef;color:#25382f;margin:16px}main{max-width:740px;margin:auto}button,select,input{font:inherit}fieldset{max-width:100%}</style><div id="root"></div></html>',
    );
  }
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
  const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
  const errors: string[] = [],
    requests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => requests.push(request.url()));
  await page.addInitScript(() => {
    Object.assign(window, { pedestalWorkers: 0 });
    window.Worker = new Proxy(window.Worker, {
      construct() {
        (window as unknown as { pedestalWorkers: number }).pedestalWorkers++;
        throw Error('No worker or AI execution is expected in a shape edit');
      },
    });
  });
  await page.goto(origin);
  await page.evaluate(async (base) => (await import(base + '/bundle.js')).mount(), origin);
  const select = page.getByLabel('기둥 단면', { exact: true });
  await expect(select).toHaveValue('');
  await expect(page.getByLabel('세면볼 형태', { exact: true })).toHaveValue('rectangular');
  await select.selectOption('rectangular');
  await expect(page.getByTestId('shape')).toHaveText('rectangular');
  await page.getByLabel('세면볼 형태', { exact: true }).selectOption('round');
  await expect(select).toHaveValue('rectangular');
  await select.selectOption('round');
  await expect(page.getByTestId('shape')).toHaveText('round');
  await select.selectOption('');
  await expect(page.getByTestId('shape')).toHaveText('unknown');
  await page.getByLabel('세면대 설치 방식', { exact: true }).selectOption('wall');
  await expect(select).toHaveCount(0);
  await page.getByLabel('세면대 설치 방식', { exact: true }).selectOption('pedestal');
  await select.selectOption('rectangular');
  await page.getByRole('button', { name: '입력 잠금 전환' }).click();
  await expect(select).toBeDisabled();
  await page.getByRole('button', { name: '입력 잠금 전환' }).click();
  await select.focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(select).toHaveValue('round');
  await select.selectOption('rectangular');
  await page.screenshot({ path: output + '/controls-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 960 });
  await expect(select).toBeVisible();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: output + '/controls-mobile.png', fullPage: true });
  const state = await page.evaluate(() =>
    (
      window as unknown as {
        pedestalForm: () => { value: { pedestalShape?: string }; sourceUnchanged: boolean };
      }
    ).pedestalForm(),
  );
  assert.equal(state.sourceUnchanged, true);
  const result = await page.evaluate(async (base) => {
    const m = await import(base + '/bundle.js');
    const dataUrl = (blob: Blob) =>
      new Promise<string>((done) => {
        const reader = new FileReader();
        reader.onload = () => done(reader.result as string);
        reader.readAsDataURL(blob);
      });
    const gallery: { id: string; url: string; width: number; height: number; alphaCorner: number }[] = [];
    const started = performance.now();
    for (const bowl of ['rectangular', 'round'])
      for (const support of [undefined, 'round', 'rectangular']) {
        const model = await m.renderReconstructionTemplate({
          kind: 'basin',
          version: 2,
          basinVariant: 'pedestal',
          basinShape: bowl,
          pedestalShape: support,
          color: '#eeeeee',
          widthMm: 600,
          heightMm: 800,
          depthMm: 480,
          room: m.DEFAULT_ROOM,
          face: 'floor',
          u: 0.5,
          v: 0.5,
          aspect: 1.5,
          yawDegrees: 0,
        });
        const bitmap = await createImageBitmap(model.blob),
          canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        gallery.push({
          id: bowl + '-' + (support ?? 'legacy'),
          url: await dataUrl(model.blob),
          width: canvas.width,
          height: canvas.height,
          alphaCorner: ctx.getImageData(0, 0, 1, 1).data[3],
        });
      }
    const background = document.createElement('canvas');
    background.width = 900;
    background.height = 600;
    background.getContext('2d')!.fillStyle = '#909090';
    background.getContext('2d')!.fillRect(0, 0, 900, 600);
    const blob = await new Promise<Blob>((done) => background.toBlob((value) => done(value!)));
    const fixture = {
      id: 'same-fixture',
      name: '기둥 세면대',
      materialVersionId: 'same-material',
      viewIndex: 0,
      position: { x: 0.5, y: 0.5 },
      width: 0.2,
      height: 0.4,
      rotation: 0,
      anchor: { x: 0.5, y: 1 },
      locked: false,
      shadow: { x: 0, y: 0, opacity: 0, blur: 0, scale: 1 },
      occlusion: m.EMPTY_MASK(),
      color: { ...m.DEFAULT_COLOR },
      roomPlacement: {
        face: 'floor',
        u: 0.5,
        v: 0.5,
        scale: 1,
        widthMm: 600,
        heightMm: 800,
        imageAspect: 1,
        contentBounds: { left: 0, top: 0, right: 1, bottom: 1 },
      },
      reconstruction: {
        kind: 'basin',
        version: 2,
        basinVariant: 'pedestal',
        basinShape: 'rectangular',
        color: '#eeeeee',
        widthMm: 600,
        heightMm: 800,
        depthMm: 480,
        yawDegrees: 0,
        baseHeightMm: 0,
      },
    };
    m.projectReconstructionFixture(m.DEFAULT_ROOM, fixture, 1.5);
    const scene = {
      room: m.DEFAULT_ROOM,
      originalAssetId: 'background',
      previewAssetId: 'background',
      imageWidth: 900,
      imageHeight: 600,
      surfaces: [],
      protection: m.EMPTY_MASK(),
      fixtures: [fixture],
      color: { ...m.DEFAULT_COLOR },
    };
    const renderer = new m.PhotoCompositor();
    const capture = async (pedestalShape?: string) => {
      const next = structuredClone(scene);
      Object.assign(next.fixtures[0].reconstruction, { pedestalShape });
      await renderer.setSnapshot(
        {
          scene: next,
          materials: {
            'same-material': { id: 'same-material', views: [], textureAssetIds: [], imageAssetIds: [] },
          },
        },
        async (id: string) => ({ id, blob, kind: 'background', width: 900, height: 600 }),
      );
      const canvas = document.createElement('canvas');
      canvas.width = 900;
      canvas.height = 600;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(renderer.render(900, 600), 0, 0);
      return { pixels: ctx.getImageData(0, 0, 900, 600).data, url: canvas.toDataURL() };
    };
    const first = await capture(),
      rectangular = await capture('rectangular'),
      restored = await capture();
    renderer.dispose();
    let changed = 0,
      resetDifference = 0;
    for (let i = 0; i < first.pixels.length; i += 4) {
      if ([0, 1, 2].some((c) => Math.abs(first.pixels[i + c] - rectangular.pixels[i + c]) > 2)) changed++;
      resetDifference = Math.max(
        resetDifference,
        ...[0, 1, 2, 3].map((c) => Math.abs(first.pixels[i + c] - restored.pixels[i + c])),
      );
    }
    return {
      gallery,
      compositor: { before: first.url, after: rectangular.url, changed, resetDifference },
      elapsedMs: performance.now() - started,
      workers: (window as unknown as { pedestalWorkers: number }).pedestalWorkers,
    };
  }, origin);
  const gallerySummaries = [];
  for (const entry of result.gallery) {
    const bytes = Buffer.from(entry.url.split(',')[1], 'base64');
    await writeFile(output + '/' + entry.id + '.png', bytes);
    assert.equal(entry.alphaCorner, 0);
    const { url: _, ...summary } = entry;
    void _;
    gallerySummaries.push({ ...summary, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  for (const bowl of ['round', 'rectangular']) {
    assert.equal(
      gallerySummaries.find((r) => r.id === bowl + '-legacy')!.sha256,
      gallerySummaries.find((r) => r.id === bowl + '-round')!.sha256,
    );
    assert.notEqual(
      gallerySummaries.find((r) => r.id === bowl + '-legacy')!.sha256,
      gallerySummaries.find((r) => r.id === bowl + '-rectangular')!.sha256,
    );
  }
  for (const state of ['before', 'after'] as const)
    await writeFile(
      output + '/compositor-' + state + '.png',
      Buffer.from(result.compositor[state].split(',')[1], 'base64'),
    );
  assert.ok(result.compositor.changed > 50);
  assert.equal(result.compositor.resetDifference, 0);
  assert.equal(result.workers, 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    requests.filter((url) => !url.startsWith(origin) && !url.startsWith('blob:') && !url.startsWith('data:')),
    [],
  );
  assert.deepEqual(await hashSources(), sourceHashes);
  const verification = {
    completedAt: new Date().toISOString(),
    sourceHashes,
    browser: browser.version(),
    scope:
      'Synthetic production component/model/gallery/cache regression, not AI detection or real-photo quality',
    explicitShapeSelection: true,
    defaultAndClearPreserveLegacy: true,
    bowlShapeIndependent: true,
    wallFormHidesSupport: true,
    keyboard: true,
    disabled: true,
    mobile390NoOverflow: true,
    sourceUnchanged: state.sourceUnchanged,
    gallery: gallerySummaries,
    changedCompositorPixels: result.compositor.changed,
    resetDifference: result.compositor.resetDifference,
    totalGalleryAndCacheMs: result.elapsedMs,
    memoryMeasured: false,
    workers: result.workers,
    errors,
    requests,
  };
  await writeFile(output + '/verification.json', JSON.stringify(verification, null, 2));
  await writeFile(
    output + '/gallery.html',
    '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>기둥 단면 표준 모형 비교</title><style>body{font:16px system-ui;background:#f5f4ef;color:#25382f;padding:24px}section{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}figure{margin:0}img{width:100%;max-height:520px;object-fit:contain;background:repeating-conic-gradient(#ddd 0% 25%,#fff 0% 50%) 0/24px 24px}figcaption{padding:12px} @media(max-width:680px){section{grid-template-columns:1fr}}</style><h1>독립 기둥 단면</h1><p>같은 치수·설치·카메라에서 비교한 표준 모형입니다. 사진 AI 인식 결과가 아닙니다. legacy와 round는 동일하고 rectangular 선택만 받침을 바꿉니다.</p><section>' +
      gallerySummaries
        .map((r) => '<figure><img src="' + r.id + '.png"><figcaption>' + r.id + '</figcaption></figure>')
        .join('') +
      '</section>',
  );
  console.log(
    JSON.stringify({
      output,
      checks: 'passed',
      changedPixels: result.compositor.changed,
      gallery: gallerySummaries.length,
      workers: result.workers,
      errors,
    }),
  );
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
