/** Production UI/WebGL/IndexedDB, synthetic support contract. No model inference or photo claims. */
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const output = 'test-results/reconstruction-fifteen-rebuild/20260915-start/bath-lining';
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
        : '<html lang="ko"><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/bundle.css"><style>body{font:16px sans-serif;margin:20px}main{max-width:450px}#render img{max-width:100%}</style><h1>욕조 외장·안쪽 색상 분리 검증</h1><p>합성 계약 테스트 입력. 실제 AI 인식이나 실측 결과 아님.</p><main></main><div id="render"></div></html>',
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
  const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } }),
    errors: string[] = [],
    requests: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(origin);
  const initial = await page.evaluate(async (base) => {
    const m = await import(base + '/bundle.js'),
      repo = m.getRepositories(),
      room = m.DEFAULT_ROOM,
      opts = {
        kind: 'bath',
        version: 2,
        room,
        face: 'floor',
        u: 0.5,
        v: 0.4,
        widthMm: 1500,
        heightMm: 600,
        depthMm: 750,
        color: '#242323',
        yawDegrees: 0,
        aspect: 1.5,
      };
    const bath = await m.createReconstructionFixture(opts),
      edited = await m.updateReconstructionFixture(bath, room, { heightMm: 610 }),
      estimated = await m.createReconstructionFixture({
        ...opts,
        bathLiningColor: '#eeefeb',
        provenance: { bathLiningColor: 'default' },
      });
    const originalMaterial = await repo.materials.getVersion(bath.materialVersionId);
    const bg = await m.renderRoomBackground(room, { width: 1200, height: 800 }),
      asset = await m.makeAsset(bg.blob, 'bath-finish-contract-room.png', 'original');
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
        name: '욕조 안쪽 색상 계약 검사',
        schemaVersion: 2,
        scene: blank,
        comparison: {
          before: { ...blank, fixtures: [bath] },
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
    m.useEditor.getState().select(bath.id);
    function Wrapper() {
      const state = m.useEditor(),
        scene = state.project.shared.comparison.before,
        fixture = scene.fixtures[0];
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
    Object.assign(window, { contractCompositor: new m.PhotoCompositor() });
    return { bath, edited, estimated, originalMaterial };
  }, origin);
  assert.equal(initial.bath.reconstruction.bathLiningColor, undefined);
  assert.equal(initial.edited.reconstruction.bathLiningColor, undefined);
  assert.equal(initial.estimated.reconstruction.bathLiningColor, '#eeefeb');
  assert.equal(initial.estimated.reconstruction.provenance.bathLiningColor, 'default');
  const capture = async (name: string, override?: string) => {
    const r = await page.evaluate(
      async ({ base, override }) => {
        const m = await import(base + '/bundle.js'),
          repo = m.getRepositories(),
          scene = structuredClone(m.useEditor.getState().project.shared.comparison.before);
        if (override) scene.fixtures[0].reconstruction.bathLiningColor = override;
        const materials = Object.fromEntries(
            (await repo.materials.list()).map(({ version }: { version: { id: string } }) => [
              version.id,
              version,
            ]),
          ),
          c = Reflect.get(window, 'contractCompositor'),
          snapshot = { scene, materials };
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
          fixture: scene.fixtures[0],
        };
      },
      { base: origin, override },
    );
    const bytes = Buffer.from(r.png);
    await writeFile(output + '/' + name + '.png', bytes);
    assert(bytes.equals(Buffer.from(r.preview.split(',')[1], 'base64')));
    return bytes;
  };
  const oldPng = await capture('old-preserved');
  await expect(page.getByLabel('욕조 안쪽 색상 별도 설정', { exact: true })).not.toBeChecked();
  await page.getByLabel('욕조 안쪽 색상 별도 설정', { exact: true }).check();
  await expect(page.getByLabel('욕조 안쪽·테두리 색상', { exact: true })).toHaveValue('#eeefeb');
  await page.getByRole('button', { name: '재구성 설정 적용', exact: true }).click();
  const get = () =>
    page.evaluate(async (base) => {
      const m = await import(base + '/bundle.js');
      return m.useEditor.getState().project.shared.comparison.before.fixtures[0];
    }, origin);
  await expect.poll(async () => (await get()).reconstruction.bathLiningColor).toBe('#eeefeb');
  assert.equal((await get()).reconstruction.color, '#242323');
  assert.equal((await get()).reconstruction.provenance.bathLiningColor, 'user');
  const nextPng = await capture('separate-lining');
  assert(!oldPng.equals(nextPng));
  await page.screenshot({ path: output + '/properties.png', fullPage: true });
  const redPng = await capture('cache-option-change', '#b52828');
  assert(!redPng.equals(nextPng), 'same material key refreshes for finish-only metadata change');
  assert((await capture('cache-restored')).equals(nextPng));
  const result = await page.evaluate(
    async ({ base, originalId }) => {
      const m = await import(base + '/bundle.js'),
        repo = m.getRepositories();
      m.useEditor.getState().undo();
      const undo = m.useEditor.getState().project.shared.comparison.before.fixtures[0].reconstruction;
      m.useEditor.getState().redo();
      const saved = await repo.projects.create(m.useEditor.getState().project),
        loaded = await repo.projects.load(saved.id),
        originalMaterial = await repo.materials.getVersion(originalId);
      Reflect.get(window, 'contractCompositor').dispose();
      return { undo, loaded, originalMaterial, browser: navigator.userAgent };
    },
    { base: origin, originalId: initial.bath.materialVersionId },
  );
  assert.equal(result.undo.bathLiningColor, undefined);
  assert.equal(result.loaded.shared.comparison.before.fixtures[0].reconstruction.bathLiningColor, '#eeefeb');
  assert.deepEqual(result.originalMaterial, initial.originalMaterial);
  assert.deepEqual(errors, []);
  assert(requests.every((url) => url.startsWith(origin) || url.startsWith('blob:')));
  await writeFile(
    output + '/verification.json',
    JSON.stringify(
      {
        scope: 'Synthetic color contract, real UI/WebGL/IndexedDB. No AI recognition claim.',
        oldFixture: initial.bath,
        newEstimatedFixture: initial.estimated,
        ...result,
        errors,
        requests,
        previewExportExact: true,
        sameMaterialCacheRefresh: true,
        originalMaterialUnchanged: true,
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
