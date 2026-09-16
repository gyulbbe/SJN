/** Real property controls, model rendering and IndexedDB; synthetic fixture, no AI. */
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const output = 'test-results/reconstruction-toilet-lid-20260913';
const bundle = await build({
  stdin: {
    contents: `
export { default as Properties } from './src/components/reconstruction/reconstruction-properties';
export { createReconstructionFixture } from './src/lib/reconstruction';
export { getRepositories } from './src/lib/repositories';
export { useEditor } from './src/lib/editor-store';
export { DEFAULT_ROOM } from './src/lib/room-geometry';
export { DEFAULT_COLOR, EMPTY_MASK } from './src/lib/types';
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
  outfile: 'test-results/virtual-toilet-properties.js',
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'process.env.NEXT_PUBLIC_STORAGE_MODE': JSON.stringify('local'),
  },
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
        : '<html lang="ko"><head><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/bundle.css"></head><body style="font:16px sans-serif;max-width:560px;margin:20px"><h1>변기 보정 저장 검증</h1><p>수동 테스트 모형 · AI 인식 결과 아님</p><main></main></body></html>',
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
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  const errors: string[] = [],
    requests: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(origin);
  await page.evaluate(async (base) => {
    const m = await import(base + '/bundle.js'),
      repo = m.getRepositories();
    const original = await m.createReconstructionFixture({
      kind: 'toilet',
      version: 2,
      toiletLidState: undefined,
      room: m.DEFAULT_ROOM,
    });
    const assetId = (await repo.materials.list())[0].version.views[0].assetId;
    const blank = {
      originalAssetId: assetId,
      previewAssetId: assetId,
      room: m.DEFAULT_ROOM,
      imageWidth: 1200,
      imageHeight: 800,
      surfaces: [],
      fixtures: [],
      protection: m.EMPTY_MASK(),
      color: { ...m.DEFAULT_COLOR },
    };
    const stamp = new Date().toISOString();
    m.useEditor.getState().load({
      id: crypto.randomUUID(),
      ownerId: 'local',
      name: '변기 보정 검사',
      schemaVersion: 2,
      editRevision: 0,
      storageRevision: 0,
      createdAt: stamp,
      updatedAt: stamp,
      viewport: { zoom: 1, pan: { x: 0, y: 0 } },
      history: { past: [], future: [] },
      scene: blank,
      comparison: {
        before: { ...blank, fixtures: [original] },
        room: m.DEFAULT_ROOM,
        aspect: 1.5,
        cameraVersion: 1,
        status: 'draft',
        referenceOriginalAssetId: assetId,
        referencePreviewAssetId: assetId,
      },
    });
    m.useEditor.getState().setEditing('before');
    function Wrapper() {
      const p = m.useEditor((state: { project: unknown }) => state.project);
      const scene = p.shared.comparison.before,
        fixture = scene.fixtures[0];
      return m.createElement(m.Properties, {
        key: fixture.materialVersionId,
        scene,
        fixture,
        materials: {},
        onMaterialsChanged: async () => {},
      });
    }
    const root = m.createRoot(document.querySelector('main')!);
    root.render(m.createElement(Wrapper));
  }, origin);
  const select = page.getByLabel('변기 뚜껑 상태');
  await select.waitFor();
  assert.equal(await select.inputValue(), 'legacy');
  const apply = page.getByRole('button', { name: '재구성 설정 적용', exact: true });
  await page.getByLabel('재구성 대표 색상').fill('#c9d2d2');
  await apply.click();
  await expect
    .poll(async () =>
      page.evaluate(async (base) => {
        const m = await import(base + '/bundle.js');
        return m.useEditor.getState().project.shared.comparison.before.fixtures[0].reconstruction.color;
      }, origin),
    )
    .toBe('#c9d2d2');
  assert.equal(await select.inputValue(), 'legacy');
  await select.selectOption('open');
  await apply.click();
  await expect
    .poll(async () =>
      page.evaluate(async (base) => {
        const m = await import(base + '/bundle.js');
        return m.useEditor.getState().project.shared.comparison.before.fixtures[0].reconstruction
          .toiletLidState;
      }, origin),
    )
    .toBe('open');
  const report = await page.evaluate(async (base) => {
    const m = await import(base + '/bundle.js'),
      st = m.useEditor.getState(),
      repo = m.getRepositories();
    const current = () => m.useEditor.getState().project;
    const meta = () => current().shared.comparison.before.fixtures[0].reconstruction;
    const opened = structuredClone(meta());
    st.undo();
    const undone = structuredClone(meta());
    st.redo();
    const redone = structuredClone(meta()),
      saved = await repo.projects.create(current()),
      loaded = await repo.projects.load(saved.id);
    const immutableVersions = await repo.materials.list();
    return {
      opened,
      undone,
      redone,
      restored: loaded.shared.comparison.before.fixtures[0].reconstruction,
      emptyAfter: loaded.designs[0].scene.fixtures.length,
      versions: immutableVersions.length,
      historyLength: loaded.shared.beforeHistory.past.length,
      browser: navigator.userAgent,
    };
  }, origin);

  assert.equal(report.opened.toiletLidState, 'open');
  assert.equal(report.opened.provenance.toiletLidState, 'user');
  assert.equal(report.opened.provenance.width, 'default');
  assert.equal(report.opened.provenance.height, 'default');
  assert.equal(report.opened.provenance.depth, 'default');
  assert.equal(report.undone.toiletLidState, undefined);
  assert.deepEqual(report.opened, report.redone);
  assert.deepEqual(report.opened, report.restored);
  assert.equal(report.emptyAfter, 0);
  assert(report.versions >= 3);
  assert.deepEqual(errors, []);
  assert(requests.every((url) => url.startsWith(origin)));
  await page.screenshot({ path: `${output}/properties-saved.png`, fullPage: true });
  await writeFile(
    `${output}/properties-result.json`,
    JSON.stringify(
      { scope: 'Real UI apply and IndexedDB/undo; no model inference', ...report, requests },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
