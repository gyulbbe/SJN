/** Real property controls, model rendering and IndexedDB; synthetic fixture, no AI. */
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const output = 'test-results/reconstruction-shower-curb-20260913/before-properties';
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
        : '<html lang="ko"><head><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/bundle.css"></head><body style="font:16px sans-serif;max-width:560px;margin:20px"><h1>유리 지지면 보정 저장 검증</h1><p>수동 테스트 모형 · AI 인식 결과 아님</p><main></main></body></html>',
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
      kind: 'glassPartition',
      version: 2,
      u: 0.5,
      v: 0.5,
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
      name: '유리 지지면 보정 검사',
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
  const meta = () =>
    page.evaluate(async (base) => {
      const m = await import(base + '/bundle.js');
      return m.useEditor.getState().project.shared.comparison.before.fixtures[0].reconstruction;
    }, origin);
  const select = page.getByLabel('유리 지지면', { exact: true });
  const apply = page.getByRole('button', { name: '재구성 설정 적용', exact: true });
  await expect(select).toHaveValue('');
  await select.selectOption('bath-rim');
  await expect(page.getByLabel('유리 지지면 높이 (mm)', { exact: true })).toHaveValue('600');
  await apply.click();
  await expect.poll(async () => (await meta()).support?.heightMm).toBe(600);
  assert.deepEqual((await meta()).support, {
    kind: 'bath-rim',
    heightMm: 600,
    provenance: { kind: 'user', height: 'default' },
  });
  await page.getByLabel('유리 지지면 높이 (mm)', { exact: true }).fill('500');
  await apply.click();
  await expect.poll(async () => (await meta()).support?.heightMm).toBe(500);
  assert.equal((await meta()).baseHeightMm, 500);
  assert.equal((await meta()).support.provenance.height, 'user');
  await page.screenshot({ path: output + '/raised-form.png', fullPage: true });
  const report = await page.evaluate(async (base) => {
    const m = await import(base + '/bundle.js'),
      st = m.useEditor.getState(),
      repo = m.getRepositories();
    const current = () => m.useEditor.getState().project;
    const meta = () => current().shared.comparison.before.fixtures[0].reconstruction;
    const raised = structuredClone(meta());
    st.undo();
    const undone = structuredClone(meta());
    st.redo();
    const redone = structuredClone(meta());
    const saved = await repo.projects.create(current()),
      loaded = await repo.projects.load(saved.id);
    m.useEditor.getState().load(loaded);
    m.useEditor.getState().setEditing('before');
    return {
      raised,
      undone,
      redone,
      loaded: meta(),
      emptyAfter: loaded.designs[0].scene.fixtures.length,
      versions: (await repo.materials.list()).length,
      browser: navigator.userAgent,
    };
  }, origin);
  assert.equal(report.undone.support.heightMm, 600);
  assert.equal(report.undone.support.provenance.height, 'default');
  assert.deepEqual(report.raised, report.redone);
  assert.deepEqual(report.raised, report.loaded);
  assert.equal(report.emptyAfter, 0);
  await expect(select).toHaveValue('bath-rim');
  await expect(page.getByLabel('유리 지지면 높이 (mm)', { exact: true })).toHaveValue('500');
  await select.selectOption('');
  await apply.click();
  await expect.poll(async () => (await meta()).support).toBeUndefined();
  assert.equal((await meta()).baseHeightMm, 0);
  await select.selectOption('shower-curb');
  await apply.click();
  await expect.poll(async () => (await meta()).support?.kind).toBe('shower-curb');
  assert.equal((await meta()).baseHeightMm, 100);
  await expect(page.getByLabel('턱 폭 (mm)', { exact: true })).toHaveValue('840');
  await expect(page.getByLabel('턱 깊이 (mm)', { exact: true })).toHaveValue('120');
  await page.getByLabel('턱 폭 (mm)', { exact: true }).fill('790');
  await apply.click();
  await expect(page.getByRole('alert')).toContainText(
    '턱 폭과 깊이는 그 위에 놓는 유리의 폭과 깊이 이상이어야 해요.',
  );
  assert.equal((await meta()).support.curb.widthMm, 840);
  await page.getByLabel('턱 폭 (mm)', { exact: true }).fill('900');
  await page.getByLabel('턱 깊이 (mm)', { exact: true }).fill('160');
  await apply.click();
  await expect.poll(async () => (await meta()).support.curb.widthMm).toBe(900);
  const curbSaved = await page.evaluate(async (base) => {
    const m = await import(base + '/bundle.js'),
      repo = m.getRepositories(),
      project = m.useEditor.getState().project;
    const saved = await repo.projects.save(project, project.storageRevision),
      loaded = await repo.projects.load(saved.id);
    m.useEditor.getState().load(loaded);
    m.useEditor.getState().setEditing('before');
    const f = loaded.shared.comparison.before.fixtures[0],
      material = await repo.materials.getVersion(f.materialVersionId),
      asset = await repo.assets.get(material.views[0].assetId);
    return { meta: f.reconstruction, png: Array.from(new Uint8Array(await asset.blob.arrayBuffer())) };
  }, origin);
  assert.deepEqual(curbSaved.meta.support.curb, {
    widthMm: 900,
    depthMm: 160,
    provenance: { width: 'user', depth: 'user' },
  });
  await expect(page.getByLabel('턱 폭 (mm)', { exact: true })).toHaveValue('900');
  await expect(page.getByLabel('턱 깊이 (mm)', { exact: true })).toHaveValue('160');
  await writeFile(output + '/curb-template.png', Buffer.from(curbSaved.png));
  await writeFile(output + '/curb-persisted.json', JSON.stringify(curbSaved.meta, null, 2));
  await page.screenshot({ path: output + '/curb-form.png', fullPage: true });

  await page.getByLabel('재구성 모형 종류', { exact: true }).selectOption('toilet');
  await expect(select).toHaveCount(0);
  await apply.click();
  await expect.poll(async () => (await meta()).kind).toBe('toilet');
  const changed = await meta();
  assert.equal(changed.support, undefined);
  assert.equal(changed.baseHeightMm, 0);
  assert.deepEqual(errors, []);
  assert(requests.every((url) => url.startsWith(origin)));
  await page.screenshot({ path: output + '/kind-changed.png', fullPage: true });
  await writeFile(
    output + '/verification.json',
    JSON.stringify(
      {
        scope:
          'Actual Before properties, rendering and IndexedDB with a synthetic fixture; no AI recognition',
        ...report,
        changed,
        requests,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      scope: 'real Before UI and IndexedDB',
      raised: report.raised.support,
      undo: report.undone.support,
      restored: report.loaded.support,
      kindChanged: changed.kind,
      afterEmpty: report.emptyAfter,
      errors,
    }),
  );
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
