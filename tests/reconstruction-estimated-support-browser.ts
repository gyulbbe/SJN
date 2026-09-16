/** Production UI/WebGL/IndexedDB, synthetic support contract. No model inference or photo claims. */
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const output = 'test-results/reconstruction-fifteen-rebuild/20260915-start/estimated-support';
const bundle = await build({
  stdin: {
    contents: `
export {AppProvider} from './src/components/app-provider';
export {default as Properties} from './src/components/reconstruction/reconstruction-properties';
export {createReconstructionFixture} from './src/lib/reconstruction';
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
        : '<html lang="ko"><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/bundle.css"><style>body{font:16px sans-serif;margin:20px}main{max-width:450px}#render img{max-width:100%}</style><h1>낮은 칸막이 위 유리 · 추정 출처 보존 검증</h1><p>합성 계약 테스트 입력. 실제 AI 인식이나 실측 결과 아님.</p><main></main><div id="render"></div></html>',
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
  const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
  const errors: string[] = [],
    requests: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => requests.push(r.url()));
  await page.addInitScript(() => {
    window.Worker = new Proxy(window.Worker, {
      construct() {
        throw Error('AI worker forbidden in synthetic contract test');
      },
    });
  });
  await page.goto(origin);
  const ids = await page.evaluate(async (base) => {
    const m = await import(base + '/bundle.js'),
      repo = m.getRepositories(),
      room = m.DEFAULT_ROOM;
    const parent = await m.createReconstructionFixture({
      kind: 'lowPartition',
      version: 2,
      room,
      face: 'floor',
      u: 0.5,
      v: 0.5,
      widthMm: 1200,
      heightMm: 800,
      depthMm: 150,
      yawDegrees: 0,
      aspect: 1.5,
    });
    const support = m.partitionTopFixtureSupport(
      {
        parentCandidateId: 'synthetic-only',
        offsetMm: 0,
        provenance: { parent: 'inferred', offset: 'inferred' },
        evidence: ['Synthetic supportedBy relation for browser contract only.'],
      },
      parent.id,
      800,
    );
    const child = await m.createReconstructionFixture({
      kind: 'glassPartition',
      version: 2,
      room,
      face: 'floor',
      u: 0.5,
      v: 0.5,
      widthMm: 600,
      heightMm: 1000,
      depthMm: 8,
      baseHeightMm: 800,
      yawDegrees: 0,
      support,
      relatedFixtures: [parent],
      aspect: 1.5,
    });
    const bg = await m.renderRoomBackground(room, { width: 1200, height: 800 }),
      asset = await m.makeAsset(bg.blob, 'support-contract-room.png', 'original');
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
        name: '추정 지지 관계 계약 검사',
        schemaVersion: 2,
        scene: blank,
        comparison: {
          before: { ...blank, fixtures: [parent, child] },
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
    m.useEditor.getState().select(child.id);
    function Wrapper() {
      const state = m.useEditor(),
        scene = state.project.shared.comparison.before,
        fixture = scene.fixtures.find((f: { id: string }) => f.id === state.selection);
      return fixture
        ? m.createElement(m.Properties, {
            key: fixture.id + fixture.materialVersionId,
            scene,
            fixture,
            materials: {},
            onMaterialsChanged: async () => {},
          })
        : m.createElement('p', null, '선택 없음');
    }
    m.createRoot(document.querySelector('main')).render(
      m.createElement(m.AppProvider, null, m.createElement(Wrapper)),
    );
    return { parent: parent.id, child: child.id };
  }, origin);
  const get = () =>
    page.evaluate(
      async ({ base, id }) => {
        const m = await import(base + '/bundle.js'),
          scene = m.useEditor.getState().project.shared.comparison.before,
          child = scene.fixtures.find((f: { id: string }) => f.id === id);
        return { child, status: m.resolveBathRimFixture(scene, child) };
      },
      { base: origin, id: ids.child },
    );
  await expect(page.getByLabel('유리 연결 낮은 칸막이', { exact: true })).toHaveValue(ids.parent);
  await expect(page.getByText('사진의 관계를 바탕으로 추정한 연결이에요.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('모형 방향 (°)', { exact: true })).toBeDisabled();
  assert.equal((await get()).status.status, 'attached');
  const apply = page.getByRole('button', { name: '재구성 설정 적용', exact: true });
  await page.getByLabel('칸막이 상단 중앙 기준 거리 (mm)', { exact: true }).fill('800');
  await expect(page.getByRole('alert')).toContainText('상단 길이');
  await apply.click();
  assert.equal((await get()).child.reconstruction.support.partitionTop.offsetMm, 0);
  await page.getByLabel('칸막이 상단 중앙 기준 거리 (mm)', { exact: true }).fill('50');
  await apply.click();
  await expect.poll(async () => (await get()).child.reconstruction.support.partitionTop.offsetMm).toBe(50);
  assert.deepEqual((await get()).child.reconstruction.support.partitionTop.provenance, {
    parent: 'inferred',
    offset: 'user',
  });
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
    assert(
      Buffer.from(r.preview.split(',')[1], 'base64').equals(Buffer.from(r.png)),
      'preview/export exact PNG',
    );
    return r.fixtures;
  };
  await capture('connected');
  await page.screenshot({ path: output + '/connected-ui.png', fullPage: true });
  await page.evaluate(
    async ({ base, id }) => {
      const m = await import(base + '/bundle.js');
      m.useEditor.getState().select(id);
    },
    { base: origin, id: ids.parent },
  );
  await page.getByLabel('모형 방향 (°)', { exact: true }).fill('90');
  await page.getByLabel('재구성 높이 (mm)', { exact: true }).fill('900');
  await apply.click();
  await expect.poll(async () => (await get()).child.reconstruction.baseHeightMm).toBe(900);
  assert.equal((await get()).child.reconstruction.yawDegrees, 90);
  assert.equal((await get()).child.reconstruction.heightMm, 1000);
  await capture('parent-moved');
  const persisted = await page.evaluate(
    async ({ base, id, parentId }) => {
      const m = await import(base + '/bundle.js'),
        repo = m.getRepositories();
      m.useEditor.getState().removeFixture(parentId);
      const missing = m.useEditor.getState().project.shared.comparison.before,
        missingChild = missing.fixtures.find((f: { id: string }) => f.id === id),
        held = m.resolveBathRimFixture(missing, missingChild);
      const saved = await repo.projects.create(m.useEditor.getState().project),
        loaded = await repo.projects.load(saved.id);
      m.useEditor.getState().load(loaded);
      m.useEditor.getState().setEditing('before');
      m.useEditor.getState().undo();
      const restored = m.useEditor.getState().project,
        scene = restored.shared.comparison.before,
        child = scene.fixtures.find((f: { id: string }) => f.id === id),
        status = m.resolveBathRimFixture(scene, child);
      const stored = await repo.projects.save(restored, restored.storageRevision),
        again = await repo.projects.load(stored.id);
      m.useEditor.getState().load(again);
      m.useEditor.getState().setEditing('before');
      m.useEditor.getState().select(id);
      const copy = m.duplicateProjectDocument(again);
      return { held: held.status, status: status.status, saved: again, copy, browser: navigator.userAgent };
    },
    { base: origin, id: ids.child, parentId: ids.parent },
  );
  assert.equal(persisted.held, 'held');
  assert.equal(persisted.status, 'attached');
  assert.equal(persisted.saved.designs[0].scene.fixtures.length, 0);
  const cc = persisted.copy.shared.comparison.before.fixtures.find(
    (f: { reconstruction: { kind: string } }) => f.reconstruction.kind === 'glassPartition',
  );
  assert.notEqual(cc.reconstruction.support.partitionTop.parentFixtureId, ids.parent);
  assert(
    persisted.copy.shared.comparison.before.fixtures.some(
      (f: { id: string }) => f.id === cc.reconstruction.support.partitionTop.parentFixtureId,
    ),
  );
  await expect(page.getByLabel('유리 연결 낮은 칸막이', { exact: true })).toHaveValue(ids.parent);
  await capture('reloaded');
  assert.deepEqual(errors, []);
  assert(requests.every((url) => url.startsWith(origin) || url.startsWith('blob:')));
  await writeFile(
    output + '/verification.json',
    JSON.stringify(
      {
        scope:
          'Synthetic support contract only. Production WebGL, properties, IndexedDB, history and common output. No model inference; not a photo quality result.',
        ids,
        ...persisted,
        errors,
        requests,
        networkModelCalls: 0,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ status: 'passed', output, errors, aiCalls: 0, afterEmpty: true }));
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
