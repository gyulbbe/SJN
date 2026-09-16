/** Real Properties/editor/history/IndexedDB paths; new ephemeral origin and authored input only. AI 0. */
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const out = path.resolve(
  'test-results/reconstruction-fifteen-rebuild/20260915-start/shower-properties-' +
    new Date().toISOString().replaceAll(':', '-'),
);
await mkdir(out, { recursive: true });
const sources = new Map<string, string>(),
  sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const bundle = await build({
  stdin: {
    contents: [
      "export {AppProvider} from './src/components/app-provider';",
      "export {default as Properties} from './src/components/reconstruction/reconstruction-properties';",
      "export {createReconstructionFixture,updateReconstructionFixture} from './src/lib/reconstruction';",
      "export {PhotoCompositor} from './src/lib/render/compositor';",
      "export {renderRoomBackground} from './src/lib/room-background';",
      "export {makeAsset} from './src/lib/images';",
      "export {getRepositories,initializeRepositories} from './src/lib/repositories';",
      "export {useEditor} from './src/lib/editor-store';",
      "export {DEFAULT_ROOM} from './src/lib/room-geometry';",
      "export {DEFAULT_COLOR,EMPTY_MASK} from './src/lib/types';",
      "export {createRoot} from 'react-dom/client';export {createElement} from 'react';",
    ].join('\n'),
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  outfile: 'bundle.js',
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.NEXT_PUBLIC_STORAGE_MODE': '"local"',
    'process.env': '{}',
  },
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
    {
      name: 'freeze-source',
      setup(b) {
        b.onLoad({ filter: /\.[cm]?[jt]sx?$/, namespace: 'file' }, async (a) => {
          const bytes = await readFile(a.path);
          sources.set(a.path, sha(bytes));
          return {
            contents: bytes,
            loader: a.path.endsWith('.tsx') ? 'tsx' : a.path.endsWith('.ts') ? 'ts' : 'js',
          };
        });
      },
    },
  ],
});
for (const [file, h] of sources) assert.equal(sha(await readFile(file)), h, 'Source changed during bundle');
const js = bundle.outputFiles.find((f) => f.path.endsWith('.js'))!.text,
  css = bundle.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '';
await writeFile(path.join(out, 'bundle.js'), js, { flag: 'wx' });
await writeFile(path.join(out, 'bundle.css'), css, { flag: 'wx' });
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
        : '<html lang="ko"><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/bundle.css"><style>body{font:15px Arial;padding:24px}main{width:430px}#render{position:absolute;left:500px;top:90px;width:680px}#render img{width:100%}</style><h1>격리 샤워 속성·저장 검증</h1><p>합성 모형, 새 로컬 저장소, 실제 AI 실행 없음</p><main></main><div id="render"></div></html>',
  );
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors: string[] = [],
  requests: string[] = [],
  blocked: string[] = [],
  steps: Record<string, unknown> = {};
try {
  const context = await browser.newContext({ viewport: { width: 1250, height: 1080 } });
  const page = await context.newPage();
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith('blob:') || url.startsWith('data:')) return route.continue();
    blocked.push(url);
    return route.abort();
  });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(origin);
  const initial = await page.evaluate(async (base) => {
    const m = await import(base + '/bundle.js'),
      repo = m.initializeRepositories('local'),
      room = m.DEFAULT_ROOM;
    const existingProjects = await repo.projects.list();
    if (existingProjects.length) throw new Error('Expected empty isolated origin');
    const fixture = await m.createReconstructionFixture({
      kind: 'shower',
      version: 2,
      room,
      face: 'left',
      u: 0.42,
      v: 1 - 533 / room.heightMm,
      baseHeightMm: 533,
      widthMm: 223,
      heightMm: 681,
      depthMm: 137,
      color: '#949c9e',
      aspect: 1.5,
      placementPolicy: 'preserve',
      provenance: {
        dimensions: 'user',
        width: 'user',
        height: 'user',
        depth: 'user',
        position: 'user',
        wall: 'user',
      },
    });
    if (fixture.reconstruction.showerVariant !== undefined)
      throw new Error('Legacy shape must remain unspecified');
    const originalMaterial = await repo.materials.getVersion(fixture.materialVersionId);
    const bg = await m.renderRoomBackground(room, { width: 1200, height: 800 }),
      asset = await m.makeAsset(bg.blob, 'isolated-shower-room.png', 'original');
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
    m.useEditor.getState().load({
      id: crypto.randomUUID(),
      ownerId: 'local',
      name: '격리 샤워 속성 회귀',
      schemaVersion: 2,
      scene: blank,
      comparison: {
        before: { ...blank, fixtures: [fixture] },
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
    const stored = await repo.projects.create(m.useEditor.getState().project);
    m.useEditor.getState().load(stored);
    m.useEditor.getState().setEditing('before');
    m.useEditor.getState().select(fixture.id);
    function Wrapper() {
      const state = m.useEditor(),
        scene = state.project.shared.comparison.before,
        selected = scene.fixtures.find((f: { id: string }) => f.id === state.selection);
      return selected
        ? m.createElement(m.Properties, {
            key: selected.id + selected.materialVersionId,
            scene,
            fixture: selected,
            materials: {},
            onMaterialsChanged: async () => {},
          })
        : null;
    }
    m.createRoot(document.querySelector('main')).render(
      m.createElement(m.AppProvider, null, m.createElement(Wrapper)),
    );
    return {
      fixture,
      originalMaterial,
      projectId: stored.id,
      originalAssetId: asset.id,
      repoMode: repo.mode,
      initialProjectCount: existingProjects.length,
    };
  }, origin);
  steps.initial = initial;
  const get = () =>
    page.evaluate(async (base) => {
      const m = await import(base + '/bundle.js');
      return m.useEditor.getState().project.shared.comparison.before.fixtures[0];
    }, origin);
  const physical = (f: {
    reconstruction: Record<string, unknown>;
    roomPlacement: Record<string, unknown>;
  }) => ({
    widthMm: f.reconstruction.widthMm,
    heightMm: f.reconstruction.heightMm,
    depthMm: f.reconstruction.depthMm,
    baseHeightMm: f.reconstruction.baseHeightMm,
    face: f.roomPlacement.face,
    u: f.roomPlacement.u,
    v: f.roomPlacement.v,
    scale: f.roomPlacement.scale,
  });
  const assertPhysical = (actual: ReturnType<typeof physical>, expected: ReturnType<typeof physical>) => {
    for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
      const a = actual[key],
        b = expected[key];
      if (typeof a === 'number' && typeof b === 'number') {
        const tolerance = ['u', 'v', 'scale'].includes(key) ? 1e-12 : 1e-6;
        assert.ok(Math.abs(a - b) <= tolerance, key + ' changed beyond numeric projection tolerance');
      } else assert.equal(a, b);
    }
  };
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
        const img = document.createElement('img');
        img.src = URL.createObjectURL(png);
        document.querySelector('#render')!.replaceChildren(img);
        await img.decode();
        return { png: Array.from(new Uint8Array(await png.arrayBuffer())), preview };
      } finally {
        c.dispose();
      }
    }, origin);
    assert.deepEqual(Buffer.from(r.preview.split(',')[1], 'base64'), Buffer.from(r.png));
    await writeFile(path.join(out, name + '.png'), Buffer.from(r.png), { flag: 'wx' });
  };
  const apply = page.getByRole('button', { name: '재구성 설정 적용', exact: true });
  await expect(page.getByLabel('샤워 형태', { exact: true })).toHaveValue('');
  await capture('legacy-before');
  await page.getByLabel('샤워 형태', { exact: true }).selectOption('hand-spray');
  await expect(page.getByLabel('재구성 가로 (mm)', { exact: true })).toHaveValue('223');
  await expect(page.getByLabel('재구성 높이 (mm)', { exact: true })).toHaveValue('681');
  await expect(page.getByLabel('모형 하단 설치 높이 (mm)', { exact: true })).toHaveValue('533');
  await apply.click();
  await expect.poll(async () => (await get()).reconstruction.showerVariant).toBe('hand-spray');
  await expect(page.locator('main')).not.toContainText('showerVariant:');
  const subtype = await get();
  steps.subtypeOnly = subtype;
  assertPhysical(physical(subtype), physical(initial.fixture));
  assert.equal(subtype.reconstruction.provenance.showerVariant, 'user');
  assert.equal(subtype.reconstruction.provenance.width, 'user');
  await capture('subtype-only');
  await page.evaluate(async (base) => {
    (await import(base + '/bundle.js')).useEditor.getState().undo();
  }, origin);
  await expect.poll(async () => (await get()).materialVersionId).toBe(initial.fixture.materialVersionId);
  assertPhysical(physical(await get()), physical(initial.fixture));
  await page.evaluate(async (base) => {
    (await import(base + '/bundle.js')).useEditor.getState().redo();
  }, origin);
  await expect.poll(async () => (await get()).materialVersionId).toBe(subtype.materialVersionId);
  await page.getByRole('button', { name: '이 형태의 기본 규격 적용', exact: true }).click();
  await expect(page.getByLabel('재구성 가로 (mm)', { exact: true })).toHaveValue('180');
  await expect(page.getByLabel('재구성 높이 (mm)', { exact: true })).toHaveValue('450');
  await expect(page.getByLabel('재구성 깊이 (mm)', { exact: true })).toHaveValue('120');
  await expect(page.getByLabel('모형 하단 설치 높이 (mm)', { exact: true })).toHaveValue('533');
  await apply.click();
  await expect.poll(async () => (await get()).reconstruction.heightMm).toBe(450);
  const defaults = await get();
  steps.explicitDefaults = defaults;
  assertPhysical(physical(defaults), {
    ...physical(initial.fixture),
    widthMm: 180,
    heightMm: 450,
    depthMm: 120,
  });
  for (const k of ['width', 'height', 'depth', 'dimensions'])
    assert.equal(defaults.reconstruction.provenance[k], 'default');
  assert.equal(defaults.reconstruction.provenance.showerVariant, 'user');
  await capture('explicit-defaults');
  await page.screenshot({ path: path.join(out, 'properties-defaults.png'), fullPage: true });
  const history = await page.evaluate(async (base) => {
    const m = await import(base + '/bundle.js'),
      st = m.useEditor.getState();
    st.undo();
    const undo = m.useEditor.getState().project.shared.comparison.before.fixtures[0];
    m.useEditor.getState().redo();
    return { undo, redo: m.useEditor.getState().project.shared.comparison.before.fixtures[0] };
  }, origin);
  steps.history = history;
  assert.equal(history.undo.materialVersionId, subtype.materialVersionId);
  assert.equal(history.redo.materialVersionId, defaults.materialVersionId);
  const saved = await page.evaluate(async (base) => {
    const m = await import(base + '/bundle.js'),
      p = m.useEditor.getState().project;
    return m.getRepositories().projects.save(p, p.storageRevision);
  }, origin);
  steps.saved = saved;
  assert.deepEqual(saved.shared.comparison.before.fixtures[0], defaults);
  await page.reload();
  const reopened = await page.evaluate(
    async ({ base, id, fixtureId }) => {
      const m = await import(base + '/bundle.js'),
        repo = m.initializeRepositories('local'),
        p = await repo.projects.load(id);
      m.useEditor.getState().load(p);
      m.useEditor.getState().setEditing('before');
      m.useEditor.getState().select(fixtureId);
      function Wrapper() {
        const st = m.useEditor(),
          scene = st.project.shared.comparison.before,
          f = scene.fixtures.find((x: { id: string }) => x.id === st.selection);
        return m.createElement(m.Properties, {
          key: f.id + f.materialVersionId,
          scene,
          fixture: f,
          materials: {},
          onMaterialsChanged: async () => {},
        });
      }
      m.createRoot(document.querySelector('main')).render(
        m.createElement(m.AppProvider, null, m.createElement(Wrapper)),
      );
      return p;
    },
    { base: origin, id: saved.id, fixtureId: initial.fixture.id },
  );
  steps.reopened = reopened;
  assert.deepEqual(reopened.shared.comparison.before.fixtures[0], defaults);
  assert.equal(reopened.designs[0].scene.fixtures.length, 0);
  await expect(page.getByLabel('샤워 형태', { exact: true })).toHaveValue('hand-spray');
  await expect(page.getByLabel('재구성 높이 (mm)', { exact: true })).toHaveValue('450');
  await page.getByLabel('재구성 모형 종류', { exact: true }).selectOption('wallShelf');
  await apply.click();
  await expect.poll(async () => (await get()).reconstruction.kind).toBe('wallShelf');
  await expect(page.locator('main')).not.toContainText('showerVariant:');
  await expect(page.getByLabel('샤워 형태', { exact: true })).toHaveCount(0);
  const shelf = await get();
  steps.changedKind = shelf;
  assert.equal(shelf.reconstruction.showerVariant, undefined);
  assert.equal(shelf.reconstruction.provenance.showerVariant, undefined);
  const final = await page.evaluate(
    async ({ base, materialId, assetId }) => {
      const m = await import(base + '/bundle.js'),
        repo = m.getRepositories(),
        current = m.useEditor.getState().project,
        saved = await repo.projects.save(current, current.storageRevision),
        reloaded = await repo.projects.load(saved.id);
      return {
        reloaded,
        originalMaterial: await repo.materials.getVersion(materialId),
        originalAssetExists: Boolean(await repo.assets.get(assetId)),
        projects: await repo.projects.list(),
        repoMode: repo.mode,
      };
    },
    { base: origin, materialId: initial.originalMaterial.id, assetId: initial.originalAssetId },
  );
  steps.final = final;
  assert.equal(final.reloaded.shared.comparison.before.fixtures[0].reconstruction.showerVariant, undefined);
  assert.equal(
    final.reloaded.shared.comparison.before.fixtures[0].reconstruction.provenance.showerVariant,
    undefined,
  );
  assert.deepEqual(final.originalMaterial, initial.originalMaterial);
  assert.equal(final.originalAssetExists, true);
  assert.equal(final.projects.length, 1);
  assert.equal(final.repoMode, 'local');
  await capture('changed-kind');
  await page.screenshot({ path: path.join(out, 'properties-changed-kind.png'), fullPage: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(blocked, []);
  await writeFile(
    path.join(out, 'verification.json'),
    JSON.stringify(
      {
        status: 'passed',
        origin,
        browser: await browser.version(),
        mode: 'fresh browser context + unique loopback origin / IndexedDB local',
        sourceFiles: [...sources].map(([file, sha256]) => ({ file, sha256 })),
        bundleSha256: sha(js),
        aiCalls: 0,
        externalRequests: 0,
        errors,
        requests,
        blocked,
        steps,
        checks: {
          subtypeOnlyPreservesDimensionsAndCoordinates: true,
          explicitDefaultsPreserveCoordinates: true,
          height450NotClampedByLegacyPhysicalRanges: true,
          undoRedo: true,
          projectSaveAndFullPageReopen: true,
          kindChangeClearsSubtypeAndProvenance: true,
          originalMaterialUnchanged: true,
          originalAssetPreserved: true,
          afterRemainsEmpty: true,
          previewExportExact: true,
        },
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
  console.log(JSON.stringify({ status: 'passed', out, aiCalls: 0, originalProjectsTouched: 0 }));
} catch (error) {
  await writeFile(
    path.join(out, 'failure.json'),
    JSON.stringify(
      {
        status: 'failed',
        error: String(error),
        stack: error instanceof Error ? error.stack : undefined,
        errors,
        requests,
        blocked,
        steps,
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
  throw error;
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}
