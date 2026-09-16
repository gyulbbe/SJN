/** Real property controls, model rendering and IndexedDB; synthetic fixture, no AI. */
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const output = 'test-results/reconstruction-bath-rim-20260913';
const historical = JSON.parse(
  await readFile('test-results/reconstruction-manual-ui-user01-02/user-01/corrected.json', 'utf8'),
);
const historicalBytes = JSON.stringify(historical);
const bundle = await build({
  stdin: {
    contents: `
export { AppProvider } from './src/components/app-provider';
export { default as Review } from './src/components/reconstruction/reconstruction-review';
export { PhotoCompositor } from './src/lib/render/compositor';
export { renderRoomBackground } from './src/lib/room-background';
export { makeAsset } from './src/lib/images';
export { resolveBathRimFixture } from './src/lib/reconstruction/bath-rim';
export { duplicateProjectDocument } from './src/lib/designs';
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
        : '<html lang="ko"><head><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/bundle.css"></head><body style="font:16px sans-serif;max-width:1500px;margin:20px"><h1>유리 지지면 보정 저장 검증</h1><p>수동 테스트 모형 · AI 인식 결과 아님</p><style>aside{position:static!important;width:320px!important;max-height:none!important}.harness{display:grid;grid-template-columns:330px 470px;gap:30px}canvas{max-width:100%}</style><p>사용자01의 보존된 실제 관측 보정 자료 재생. 새 AI 없음. 욕조 연결과 위치·규격은 사용자 역할 입력이며 실측 아님.</p><main></main><div id="render"></div></body></html>',
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
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  const errors: string[] = [],
    requests: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => requests.push(r.url()));
  await page.addInitScript(() => {
    window.Worker = new Proxy(window.Worker, {
      construct() {
        throw Error('No new AI/model worker permitted');
      },
    });
  });
  await page.goto(origin);
  const ids = await page.evaluate(
    async ({ base, source }) => {
      const m = await import(base + '/bundle.js'),
        repo = m.getRepositories(),
        room = source.room;
      const fixtures = [];
      for (const saved of source.fixtures) {
        const meta = saved.reconstruction,
          p = saved.roomPlacement;
        const next = await m.createReconstructionFixture({
          ...meta,
          room,
          face: p.face,
          u: p.u,
          v: p.v,
          aspect: 1.5,
        });
        next.id = saved.id;
        next.name = saved.name;
        fixtures.push(next);
      }
      const glass = await m.createReconstructionFixture({
        kind: 'glassPartition',
        version: 2,
        room,
        face: 'floor',
        u: 0.5,
        v: 0.5,
        widthMm: 800,
        heightMm: 1800,
        depthMm: 8,
        yawDegrees: 0,
        aspect: 1.5,
      });
      fixtures.push(glass);
      const back = await m.renderRoomBackground(room, { width: 1200, height: 800 }),
        asset = await m.makeAsset(back.blob, '공통 기본 공간.png', 'original');
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
      };
      const stamp = new Date().toISOString();
      m.useEditor.getState().load({
        id: crypto.randomUUID(),
        ownerId: 'local',
        name: '욕조 테두리 연결 · 사용자01 보정',
        schemaVersion: 2,
        scene: blank,
        comparison: {
          before: { ...blank, fixtures },
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
      m.useEditor.getState().select(glass.id);
      function Wrapper() {
        const state = m.useEditor(),
          scene = state.project.shared.comparison.before,
          fixture = scene.fixtures.find((f: { id: string }) => f.id === state.selection);
        return m.createElement(
          'div',
          { className: 'harness' },
          m.createElement(m.Review, {
            open: true,
            onClose: () => {},
            onMaterialsChanged: async () => {},
            onError: (e: string) => {
              throw Error(e);
            },
            onShowProperties: () => {},
          }),
          fixture
            ? m.createElement(m.Properties, {
                key: fixture.id + fixture.materialVersionId,
                scene,
                fixture,
                materials: {},
                onMaterialsChanged: async () => {},
              })
            : m.createElement('p', null, '목록에서 설비를 선택하세요.'),
        );
      }
      m.createRoot(document.querySelector('main')).render(
        m.createElement(m.AppProvider, null, m.createElement(Wrapper)),
      );
      return { glass: glass.id, bath: fixtures.find((f) => f.reconstruction.kind === 'bath').id };
    },
    { base: origin, source: historical.analysis },
  );
  const get = () =>
    page.evaluate(
      async ({ base, id }) => {
        const m = await import(base + '/bundle.js'),
          scene = m.useEditor.getState().project.shared.comparison.before,
          fixture = scene.fixtures.find((f: { id: string }) => f.id === id);
        return { fixture, status: m.resolveBathRimFixture(scene, fixture) };
      },
      { base: origin, id: ids.glass },
    );
  const apply = page.getByRole('button', { name: '재구성 설정 적용', exact: true });
  await page.getByLabel('유리 지지면', { exact: true }).selectOption('bath-rim');
  await page.getByLabel('유리 연결 욕조', { exact: true }).selectOption(ids.bath);
  await expect(page.getByLabel('유리 지지면 높이 (mm)', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('모형 방향 (°)', { exact: true })).toBeDisabled();
  await apply.click();
  await expect
    .poll(async () => (await get()).fixture.reconstruction.support?.bathRim?.parentFixtureId)
    .toBe(ids.bath);
  assert.equal((await get()).status.status, 'attached');
  await page.getByLabel('욕조 테두리 중앙 기준 거리 (mm)', { exact: true }).fill('900');
  await expect(page.getByRole('alert')).toContainText('테두리 끝');
  await apply.click();
  assert.equal((await get()).fixture.reconstruction.support.bathRim.offsetMm, 0);
  await page.getByLabel('욕조 테두리 중앙 기준 거리 (mm)', { exact: true }).fill('-250');
  await apply.click();
  await expect.poll(async () => (await get()).fixture.reconstruction.support.bathRim.offsetMm).toBe(-250);
  const capture = async (name: string) => {
    const result = await page.evaluate(async (base) => {
      const m = await import(base + '/bundle.js'),
        repo = m.getRepositories(),
        scene = m.useEditor.getState().project.shared.comparison.before,
        materials = Object.fromEntries(
          (await repo.materials.list()).map(({ version }: { version: { id: string } }) => [
            version.id,
            version,
          ]),
        );
      const c = new m.PhotoCompositor(),
        snapshot = { scene, materials };
      try {
        await c.setSnapshot(snapshot, (id: string) => repo.assets.get(id));
        const rendered = c.render(1200, 800),
          preview = rendered.toDataURL();
        const png = await c.exportImage(snapshot, 1200, 800, 'image/png', false);
        const blob = Array.from(new Uint8Array(await png.arrayBuffer()));
        document.querySelector('#render')!.innerHTML = '';
        const img = document.createElement('img');
        img.src = URL.createObjectURL(png);
        img.width = 1200;
        document.querySelector('#render')!.appendChild(img);
        return { preview, png: blob, fixtures: scene.fixtures };
      } finally {
        c.dispose();
      }
    }, origin);
    await writeFile(output + '/' + name + '.png', Buffer.from(result.png));
    await writeFile(
      output + '/' + name + '-preview.png',
      Buffer.from(result.preview.split(',')[1], 'base64'),
    );
    await writeFile(output + '/' + name + '.json', JSON.stringify(result.fixtures, null, 2));
    return result.fixtures;
  };
  const connected = await capture('connected');
  await page.screenshot({ path: output + '/connected-ui.png', fullPage: true });
  // Use the real Before property form to resize and rotate the existing parent.
  await page.evaluate(
    async ({ base, id }) => {
      const m = await import(base + '/bundle.js');
      m.useEditor.getState().select(id);
    },
    { base: origin, id: ids.bath },
  );
  await page.getByLabel('모형 방향 (°)', { exact: true }).fill('90');
  await page.getByLabel('설치면 가로 위치 (%)', { exact: true }).fill('65');
  await page.getByLabel('바닥 깊이 위치 (%)', { exact: true }).fill('40');
  await page.getByLabel('재구성 높이 (mm)', { exact: true }).fill('620');
  // Parent-derived rim height remains inside the room; the glass keeps its original 1800mm height.
  await apply.click();
  await expect.poll(async () => (await get()).fixture.reconstruction.yawDegrees).toBe(90);
  const moved = await capture('parent-moved');
  assert.notEqual(
    moved.find((f: { id: string }) => f.id === ids.glass).reconstruction.baseHeightMm,
    connected.find((f: { id: string }) => f.id === ids.glass).reconstruction.baseHeightMm,
  );
  await page.evaluate(
    async ({ base, id }) => {
      const m = await import(base + '/bundle.js');
      m.useEditor.getState().removeFixture(id);
    },
    { base: origin, id: ids.bath },
  );
  assert.equal((await get()).status.status, 'held');
  const retained = await capture('parent-missing');
  assert(retained.some((f: { id: string }) => f.id === ids.glass));
  const listed = page.getByRole('button').filter({ hasText: '연결한 표준 욕조가 없어요' });
  await expect(listed).toHaveCount(1);
  await listed.click();
  await expect(page.getByLabel('유리 연결 욕조', { exact: true })).toHaveValue(ids.bath);
  await expect(page.getByRole('alert')).toContainText('욕조가 없어요');
  await page.screenshot({ path: output + '/parent-missing-ui.png', fullPage: true });
  const persisted = await page.evaluate(
    async ({ base, id }) => {
      const m = await import(base + '/bundle.js'),
        repo = m.getRepositories();
      const state = m.useEditor.getState();
      const missingSaved = await repo.projects.create(state.project),
        missing = await repo.projects.load(missingSaved.id);
      m.useEditor.getState().load(missing);
      m.useEditor.getState().setEditing('before');
      m.useEditor.getState().undo();
      const restored = m.useEditor.getState().project,
        scene = restored.shared.comparison.before,
        child = scene.fixtures.find((f: { id: string }) => f.id === id);
      const result = m.resolveBathRimFixture(scene, child);
      const saved = await repo.projects.save(restored, restored.storageRevision),
        loaded = await repo.projects.load(saved.id);
      m.useEditor.getState().load(loaded);
      m.useEditor.getState().setEditing('before');
      m.useEditor.getState().select(id);
      const copy = m.duplicateProjectDocument(loaded),
        copied = copy.shared.comparison.before;
      return {
        status: result.status,
        loaded: loaded.shared.comparison.before.fixtures,
        copy: copied.fixtures,
        afterEmpty: loaded.designs[0].scene.fixtures.length,
        materials: (await repo.materials.list()).length,
        browser: navigator.userAgent,
      };
    },
    { base: origin, id: ids.glass },
  );
  assert.equal(persisted.status, 'attached');
  assert.equal(persisted.afterEmpty, 0);
  const copyGlass = persisted.copy.find(
    (f: { reconstruction: { kind: string } }) => f.reconstruction.kind === 'glassPartition',
  );
  assert(
    persisted.copy.some(
      (f: { id: string }) => f.id === copyGlass.reconstruction.support.bathRim.parentFixtureId,
    ),
  );
  assert.notEqual(copyGlass.reconstruction.support.bathRim.parentFixtureId, ids.bath);
  await expect(page.getByLabel('유리 연결 욕조', { exact: true })).toHaveValue(ids.bath);
  await capture('reloaded');
  await page.screenshot({ path: output + '/reloaded-ui.png', fullPage: true });
  assert.deepEqual(errors, []);
  assert(requests.every((url) => url.startsWith(origin) || url.startsWith('blob:')));
  assert.equal(JSON.stringify(historical), historicalBytes);
  await writeFile(
    output + '/verification.json',
    JSON.stringify(
      {
        scope:
          'Actual Before properties/list, production store/history/IndexedDB and common renderer. Initial five fixtures rehydrated from historical user01 corrected report. Glass creation and parent/side/offset edits are user-role functional inputs, not AI observations or measurements.',
        sourceRunId: historical.analysis.runId,
        ids,
        ...persisted,
        errors,
        requests,
        newInferenceCalls: 0,
        sourceObservationPreserved: true,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      status: 'passed',
      fixtureCount: persisted.loaded.length,
      afterEmpty: persisted.afterEmpty,
      errors,
      output,
    }),
  );
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
