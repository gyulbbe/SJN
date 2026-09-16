/** Production UI/WebGL/IndexedDB, synthetic support contract. No model inference or photo claims. */
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const output = 'test-results/reconstruction-fifteen-rebuild/20260915-start/fixture-variants';
const bundle = await build({
  stdin: {
    contents: `
export {AppProvider} from './src/components/app-provider';
export {default as Properties} from './src/components/reconstruction/reconstruction-properties';
export {createReconstructionFixture,updateReconstructionFixture} from './src/lib/reconstruction';
export {partitionTopFixtureSupport} from './src/lib/reconstruction/candidate-bath-rim';
export {resolveBathRimFixture} from './src/lib/reconstruction/bath-rim';
export {PhotoCompositor} from './src/lib/render/compositor';
export {renderRoomBackground} from './src/lib/room-background';
export {makeAsset} from './src/lib/images';
export {duplicateProjectDocument} from './src/lib/designs';
export {getRepositories} from './src/lib/repositories';
export {useEditor} from './src/lib/editor-store';
export {DEFAULT_ROOM} from './src/lib/room-geometry';
export {DEFAULT_COLOR,EMPTY_MASK} from './src/lib/types';
export {createRoot} from 'react-dom/client';export {createElement} from 'react';
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
  const page = await browser.newPage({ viewport: { width: 1350, height: 1000 } }),
    errors: string[] = [],
    requests: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(origin);
  const initial = await page.evaluate(async (base) => {
    const m = await import(base + '/bundle.js'),
      repo = m.getRepositories(),
      room = m.DEFAULT_ROOM;
    const vanity = await m.createReconstructionFixture({
      kind: 'vanity',
      version: 2,
      room,
      face: 'floor',
      u: 0.5,
      v: 0.35,
      widthMm: 1000,
      heightMm: 850,
      depthMm: 550,
      color: '#bab3a8',
      yawDegrees: 0,
      aspect: 1.5,
    });
    const mirror = await m.createReconstructionFixture({
      kind: 'mirror',
      version: 2,
      room,
      face: 'back',
      u: 0.5,
      v: 0.47,
      baseHeightMm: 1272,
      widthMm: 600,
      heightMm: 850,
      depthMm: 25,
      color: '#a9b6b8',
      aspect: 1.5,
    });
    const originals = await Promise.all(
      [vanity, mirror].map((f) => repo.materials.getVersion(f.materialVersionId)),
    );
    const bg = await m.renderRoomBackground(room, { width: 1200, height: 800 }),
      asset = await m.makeAsset(bg.blob, 'fixture-variant-contract-room.png', 'original');
    await repo.assets.put(asset);
    const blank = {
        room,
        originalAssetId: asset.id,
        previewAssetId: asset.id,
        imageWidth: 1200,
        imageHeight: 800,
        surfaces: [],
        fixtures: [],
        protection: m.EMPTY_MASK(),
        color: { ...m.DEFAULT_COLOR },
      },
      stamp = new Date().toISOString();
    m.useEditor
      .getState()
      .load({
        id: crypto.randomUUID(),
        ownerId: 'local',
        name: '거울·상판 선택 모형 검증',
        schemaVersion: 2,
        scene: blank,
        comparison: {
          before: { ...blank, fixtures: [vanity, mirror] },
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
        history: { past: [], future: [] },
        viewport: { zoom: 1, pan: { x: 0, y: 0 } },
      });
    m.useEditor.getState().setEditing('before');
    m.useEditor.getState().select(mirror.id);
    function Wrapper() {
      const state = m.useEditor(),
        scene = state.project.shared.comparison.before,
        fixture = scene.fixtures.find((f: { id: string }) => f.id === state.selection);
      return m.createElement(m.Properties, {
        key: fixture.id + fixture.materialVersionId,
        scene,
        fixture,
        materials: {},
        onMaterialsChanged: async () => {},
      });
    }
    m.createRoot(document.querySelector('main')).render(
      m.createElement(m.AppProvider, null, m.createElement(Wrapper)),
    );
    return { vanity, mirror, originals };
  }, origin);
  const get = () =>
    page.evaluate(async (base) => {
      const m = await import(base + '/bundle.js');
      return m.useEditor.getState().project.shared.comparison.before.fixtures;
    }, origin);
  const select = async (id: string) =>
    page.evaluate(
      async ({ base, id }) => {
        const m = await import(base + '/bundle.js');
        m.useEditor.getState().select(id);
      },
      { base: origin, id },
    );
  const capture = async (name: string) => {
    const r = await page.evaluate(async (base) => {
      const m = await import(base + '/bundle.js'),
        repo = m.getRepositories(),
        scene = m.useEditor.getState().project.shared.comparison.before,
        materials = Object.fromEntries(
          (await repo.materials.list()).map(({ version }: { version: { id: string } }) => [
            version.id,
            version,
          ]),
        ),
        c = new m.PhotoCompositor(),
        snapshot = { scene, materials };
      try {
        await c.setSnapshot(snapshot, (id: string) => repo.assets.get(id));
        const preview = c.render(1200, 800).toDataURL(),
          png = await c.exportImage(snapshot, 1200, 800, 'image/png', false);
        document.querySelector('#render')!.innerHTML = '';
        const img = document.createElement('img');
        img.src = URL.createObjectURL(png);
        document.querySelector('#render')!.appendChild(img);
        return {
          preview,
          png: Array.from(new Uint8Array(await png.arrayBuffer())),
          fixtures: scene.fixtures,
        };
      } finally {
        c.dispose();
      }
    }, origin);
    await writeFile(output + '/' + name + '.png', Buffer.from(r.png));
    assert(Buffer.from(r.preview.split(',')[1], 'base64').equals(Buffer.from(r.png)));
    return r.fixtures;
  };
  await capture('old-preserved');
  await expect(page.getByLabel('거울 외곽 형태', { exact: true })).toHaveValue('');
  const apply = page.getByRole('button', { name: '재구성 설정 적용', exact: true });
  await page.getByLabel('거울 외곽 형태', { exact: true }).selectOption('oval');
  await apply.click();
  await expect.poll(async () => (await get())[1].reconstruction.mirrorShape).toBe('oval');
  await capture('oval');
  await page.getByLabel('거울 외곽 형태', { exact: true }).selectOption('arched');
  await apply.click();
  await expect.poll(async () => (await get())[1].reconstruction.mirrorShape).toBe('arched');
  await capture('arched');
  await select(initial.vanity.id);
  await page.getByLabel('상판·하부 구조', { exact: true }).selectOption('open-counter');
  await expect(page.getByLabel('재구성 높이 (mm)', { exact: true })).toHaveValue('330');
  await expect(page.getByLabel('모형 하단 설치 높이 (mm)', { exact: true })).toHaveValue('650');
  await page.getByLabel('상판 위 세면볼 형태', { exact: true }).selectOption('round');
  await apply.click();
  await expect.poll(async () => (await get())[0].reconstruction.vanityStyle).toBe('open-counter');
  assert.equal((await get())[0].reconstruction.heightMm, 330);
  assert.equal((await get())[0].reconstruction.baseHeightMm, 650);
  assert.equal((await get())[0].roomPlacement.face, 'back');
  assert.equal((await get())[0].reconstruction.provenance.height, 'default');
  await capture('open-wall');
  for (const support of ['left-panel', 'right-panel', 'both-panels']) {
    await page.getByLabel('상판 지지 구조', { exact: true }).selectOption(support);
    await expect(page.getByLabel('재구성 높이 (mm)', { exact: true })).toHaveValue('950');
    await apply.click();
    await expect.poll(async () => (await get())[0].reconstruction.counterSupport).toBe(support);
    assert.equal((await get())[0].reconstruction.baseHeightMm, 0);
    assert.equal((await get())[0].roomPlacement.face, 'floor');
    await capture(support);
  }
  await page.screenshot({ path: output + '/properties.png', fullPage: true });
  const result = await page.evaluate(
    async ({ base, ids }) => {
      const m = await import(base + '/bundle.js'),
        repo = m.getRepositories();
      m.useEditor.getState().undo();
      const undo = m.useEditor.getState().project.shared.comparison.before.fixtures[0].reconstruction;
      m.useEditor.getState().redo();
      const saved = await repo.projects.create(m.useEditor.getState().project),
        loaded = await repo.projects.load(saved.id),
        copy = m.duplicateProjectDocument(loaded),
        originals = await Promise.all(ids.map((id) => repo.materials.getVersion(id)));
      return { undo, loaded, copy, originals, browser: navigator.userAgent };
    },
    { base: origin, ids: initial.originals.map((v) => v.id) },
  );
  assert.equal(result.undo.counterSupport, 'right-panel');
  assert.equal(
    result.loaded.shared.comparison.before.fixtures[0].reconstruction.counterSupport,
    'both-panels',
  );
  assert.equal(result.copy.shared.comparison.before.fixtures[1].reconstruction.mirrorShape, 'arched');
  assert.deepEqual(result.originals, initial.originals);
  assert.equal(result.loaded.designs[0].scene.fixtures.length, 0);
  assert.deepEqual(errors, []);
  assert(requests.every((url) => url.startsWith(origin) || url.startsWith('blob:')));
  await writeFile(
    output + '/verification.json',
    JSON.stringify(
      {
        scope:
          'Synthetic model-selection contract, actual properties/WebGL/IndexedDB/copy/history/common output. No AI claim.',
        ...result,
        errors,
        requests,
        originalMaterialsUnchanged: true,
        previewExportExact: true,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ status: 'passed', output, errors }));
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
