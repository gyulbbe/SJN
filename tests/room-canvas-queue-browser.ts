/** Actual React/store/pointer events; only renderer and access context are stubs. No AI, geometry render or DB. */
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import type { ProjectDocument, Scene } from '../src/lib/types';
import type { Root } from 'react-dom/client';
type StubFrame = { label: string; instance: number; view?: unknown; mode?: string };
type StubControl = {
  calls: StubFrame[];
  renders: StubFrame[];
  picks: StubFrame[];
  errors: string[];
  disposals: number[];
  pending: { label: string; resolve(): void; reject(error: Error): void }[];
  held: Set<string>;
  instances: unknown[];
  failRender: boolean;
};
type BrowserModule = {
  control: StubControl;
  Workspace: typeof import('../src/components/rooms/room-canvas-workspace').default;
} & Pick<typeof import('../src/lib/editor-store'), 'useEditor'> &
  Pick<typeof import('../src/lib/room-geometry'), 'DEFAULT_ROOM' | 'createRoomSurfaces'> &
  Pick<typeof import('../src/lib/types'), 'DEFAULT_COLOR'> &
  Pick<typeof import('react-dom/client'), 'createRoot'> &
  Pick<typeof import('react-dom'), 'flushSync'> &
  Pick<typeof import('react'), 'createElement'>;
declare global {
  interface Window {
    QueueTest: BrowserModule;
    queueRoot: Root;
  }
}

const output = path.resolve(
  'test-results/reconstruction-fifteen-rebuild/20260915-start/room-canvas-queue-' +
    new Date().toISOString().replaceAll(':', '-'),
);
await mkdir(output, { recursive: true });
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const sources = new Map<string, string>();
const rendererStub = `
export const control = { calls: [], renders: [], picks: [], pending: [], disposals: [], errors: [], held: new Set(), instances: [], failRender: false };
const labelOf = (scene) => String.fromCharCode(65 + Math.round(scene.color.warmth * 10));
export class RoomViewerRenderer {
  canvas = document.createElement('canvas'); label = null; disposed = false;
  constructor() { this.id = control.instances.length; control.instances.push(this); }
  async setSnapshot(snapshot, reader, options) {
    const label = labelOf(snapshot.scene); control.calls.push({ label, instance: this.id, scene: structuredClone(snapshot.scene), fitCount: options?.fitScenes?.length });
    if (control.held.has(label)) await new Promise((resolve, reject) => control.pending.push({ label, resolve, reject, instance: this.id }));
    this.label = label;
  }
  render(w, h, view, mode) {
    if (this.disposed) throw Error('render-after-dispose');
    if (control.failRender) { control.failRender = false; throw Error('authored render failure'); }
    control.renders.push({ label: this.label, instance: this.id, view: structuredClone(view), mode });
    this.canvas.width = w; this.canvas.height = h; this.canvas.dataset.renderedLabel = this.label;
    return this.canvas;
  }
  pick(x, y) { control.picks.push({ label: this.label, instance: this.id, x, y }); return null; }
  facePosition() { throw Error('No fixture is selected in this queue-only harness'); }
  dispose() { if (this.disposed) throw Error('double-dispose'); this.disposed = true; control.disposals.push(this.id); }
}
`;
const accessStub = 'export const useAccess = () => ({ writable: true });';
await writeFile(path.join(output, 'renderer-stub.js'), rendererStub);
await writeFile(path.join(output, 'access-stub.js'), accessStub);
const bundle = await build({
  stdin: {
    contents: `export {default as Workspace} from './src/components/rooms/room-canvas-workspace'; export {useEditor} from './src/lib/editor-store'; export {DEFAULT_ROOM,createRoomSurfaces} from './src/lib/room-geometry'; export {DEFAULT_COLOR} from './src/lib/types'; export {createRoot} from 'react-dom/client'; export {flushSync} from 'react-dom'; export {createElement} from 'react'; export {control} from '@/lib/room-viewer/renderer';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'QueueTest',
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
  plugins: [
    {
      name: 'only-renderer-and-access-stubs',
      setup(b) {
        b.onResolve({ filter: /^@\/lib\/room-viewer\/renderer$/ }, () => ({
          path: 'renderer',
          namespace: 'authored-stub',
        }));
        b.onResolve({ filter: /(?:^|\/)app-provider$/ }, () => ({
          path: 'access',
          namespace: 'authored-stub',
        }));
        b.onLoad({ filter: /.*/, namespace: 'authored-stub' }, (args) => ({
          contents: args.path === 'renderer' ? rendererStub : accessStub,
          loader: 'js',
        }));
        b.onLoad({ filter: /\.[cm]?[jt]sx?$/, namespace: 'file' }, async (args) => {
          const bytes = await readFile(args.path);
          if (path.relative(process.cwd(), args.path).replaceAll('\\', '/').startsWith('src/'))
            sources.set(args.path, sha(bytes));
          return {
            contents: bytes,
            loader: args.path.endsWith('.tsx') ? 'tsx' : args.path.endsWith('.ts') ? 'ts' : 'js',
          };
        });
      },
    },
  ],
});
for (const [file, hash] of sources)
  assert.equal(sha(await readFile(file)), hash, 'Source changed during bundle');
const js = bundle.outputFiles[0].text;
await writeFile(path.join(output, 'bundle.js'), js);
await writeFile(
  path.join(output, 'source-before.json'),
  JSON.stringify(
    {
      bundleSHA: sha(js),
      files: [...sources].map(([file, hash]) => ({ file, sha256: hash })),
      rendererStubSHA: sha(rendererStub),
      accessStubSHA: sha(accessStub),
    },
    null,
    2,
  ),
);
const html =
  '<!doctype html><html lang="ko"><meta charset="utf-8"><link rel="icon" href="data:,"><title>Room canvas queue boundary</title><style>body{font:15px sans-serif}main{width:900px}.canvas-stage{position:relative;width:900px;height:600px}.canvas-frame{position:absolute;left:50%;top:50%;border:1px solid #777}.canvas-loading{position:absolute;top:0;left:0;background:#fff}button{padding:8px;margin:3px}</style><h1>렌더 실패·대기 큐 경계 시험</h1><p>실제 React와 편집 store / 시험용 renderer / 사진·AI·3D 품질 평가 아님</p><main></main><script src="/bundle.js"></script></html>';
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/bundle.js' ? js : html);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
const started = performance.now(),
  pageErrors: string[] = [],
  blocked: string[] = [],
  checks: Record<string, unknown> = {};
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let status = 'failed',
  failure: string | undefined;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(origin + '/') || url.startsWith('data:') || url.startsWith('blob:'))
      return route.continue();
    blocked.push(url);
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(origin);
  await page.evaluate(() => {
    const w = window;
    const m = w.QueueTest,
      now = new Date().toISOString();
    const scene: Scene = {
      originalAssetId: 'authored-original',
      previewAssetId: 'authored-preview',
      imageWidth: 1200,
      imageHeight: 800,
      room: { ...m.DEFAULT_ROOM },
      surfaces: m.createRoomSurfaces(m.DEFAULT_ROOM),
      fixtures: [],
      protection: { polygon: [], strokes: [] },
      color: { ...m.DEFAULT_COLOR },
    };
    const id = crypto.randomUUID();
    const project: ProjectDocument = {
      id: crypto.randomUUID(),
      ownerId: 'local',
      name: 'Authored queue only',
      schemaVersion: 3,
      editRevision: 0,
      storageRevision: 0,
      createdAt: now,
      updatedAt: now,
      roomHistory: {},
      shared: {
        baseline: {
          ...structuredClone(scene),
          wallFeatures: [
            {
              version: 1,
              id: crypto.randomUUID(),
              source: 'user',
              kind: 'closed-niche',
              face: 'back',
              leftMm: 500,
              topMm: 500,
              widthMm: 500,
              heightMm: 500,
              depthMm: 200,
            },
          ],
        },
        revision: 0,
        beforeHistory: { past: [], future: [] },
      },
      designs: [
        {
          id,
          name: 'A',
          scene,
          revision: 0,
          createdAt: now,
          updatedAt: now,
          history: { past: [], future: [] },
        },
      ],
      activeDesignId: id,
      comparisonDesignIds: [],
      viewport: { zoom: 1, pan: { x: 0, y: 0 } },
    };
    m.useEditor.getState().load(project);
    const root = m.createRoot(document.querySelector('main')!);
    w.queueRoot = root;
    root.render(
      m.createElement(m.Workspace, {
        materials: {},
        assetReader: async () => {
          throw Error('No asset reads allowed in stub-renderer test');
        },
        onError: (error: string) => m.control.errors.push(error),
        showCatalog: () => {},
        showInspector: () => {},
      }),
    );
  });
  const frame = page.getByTestId('room-editor-canvas');
  const data = () =>
    page.evaluate(() => {
      const c = window.QueueTest.control;
      return {
        calls: c.calls.map((v) => v.label),
        renders: c.renders,
        picks: c.picks,
        errors: c.errors,
        disposals: c.disposals,
        instances: c.instances.length,
      };
    });
  const pick = () =>
    frame.dispatchEvent('pointerdown', { button: 0, pointerId: 1, clientX: 350, clientY: 300 });
  const change = (label: string) =>
    page.evaluate((label) => {
      const m = window.QueueTest;
      m.control.held.add(label);
      m.flushSync(() =>
        m.useEditor.getState().change((scene: { color: { warmth: number } }) => {
          scene.color.warmth = (label.charCodeAt(0) - 65) / 10;
        }),
      );
    }, label);
  const pending = (label: string) =>
    expect
      .poll(() =>
        page.evaluate((label) => window.QueueTest.control.pending.some((p) => p.label === label), label),
      )
      .toBe(true);
  const settle = (label: string, fail = false) =>
    page.evaluate(
      ({ label, fail }) => {
        const c = window.QueueTest.control,
          i = c.pending.findIndex((p) => p.label === label);
        if (i < 0) throw Error('Missing pending label ' + label);
        const p = c.pending.splice(i, 1)[0];
        if (fail) p.reject(Error('authored ' + label + ' failure'));
        else p.resolve();
      },
      { label, fail },
    );

  await expect(frame).toHaveAttribute('data-render-state', 'ready');
  await pick();
  assert.equal((await data()).picks.at(-1)?.label, 'A');
  checks.initialReady = await data();
  await change('B');
  await pending('B');
  await expect(frame).toHaveAttribute('data-render-state', 'preparing');
  const blockedPickCount = (await data()).picks.length;
  await pick();
  assert.equal((await data()).picks.length, blockedPickCount);
  await change('C');
  await pick();
  assert.equal((await data()).picks.length, blockedPickCount);
  assert.ok(!(await data()).calls.includes('C'));
  checks.pendingOldKeyNoPick = await data();
  await settle('B', true);
  await pending('C');
  await pick();
  assert.equal((await data()).picks.length, blockedPickCount);
  await settle('C');
  await expect(frame).toHaveAttribute('data-render-state', 'ready');
  await pick();
  assert.equal((await data()).picks.at(-1)?.label, 'C');
  assert.ok(!(await data()).renders.some((r) => r.label === 'B'));
  assert.deepEqual((await data()).errors, []);
  checks.failedObsoleteContinuesNewest = await data();

  await change('D');
  await pending('D');
  await settle('D', true);
  await expect(frame).toHaveAttribute('data-render-state', 'error');
  await expect(page.getByRole('alert')).toContainText('authored D failure');
  const failedPickCount = (await data()).picks.length;
  await pick();
  assert.equal((await data()).picks.length, failedPickCount);
  checks.currentFailureNoPick = await data();
  await page.screenshot({ path: path.join(output, 'terminal-error.png') });
  await change('E');
  await pending('E');
  await settle('E');
  await expect(frame).toHaveAttribute('data-render-state', 'ready');
  await pick();
  assert.equal((await data()).picks.at(-1)?.label, 'E');
  checks.validChangeRecovers = await data();
  await page.evaluate(() => {
    window.QueueTest.control.failRender = true;
  });
  await page.getByRole('button', { name: '확대', exact: true }).click();
  await expect(frame).toHaveAttribute('data-render-state', 'error');
  const drawFailurePicks = (await data()).picks.length;
  await pick();
  assert.equal((await data()).picks.length, drawFailurePicks);
  checks.drawFailureNoPick = await data();
  await page.evaluate(() => {
    window.QueueTest.control.held.delete('E');
  });
  await page.getByRole('button', { name: '보기 새로고침' }).click();
  await expect(frame).toHaveAttribute('data-render-state', 'ready');
  assert.equal((await data()).disposals.length, 1);
  checks.explicitRetryRecovers = await data();
  await change('F');
  await pending('F');
  const rendersBeforeUnmount = (await data()).renders.length;
  await page.evaluate(() => {
    window.QueueTest.flushSync(() => window.queueRoot.unmount());
  });
  await settle('F');
  await page.waitForTimeout(30);
  const final = await data();
  assert.equal(final.renders.length, rendersBeforeUnmount);
  assert.equal(final.disposals.length, final.instances);
  checks.unmountLateCompletion = final;
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(blocked, []);
  checks.persistedDatabases = await page.evaluate(async () => (await indexedDB.databases()).length);
  assert.equal(checks.persistedDatabases, 0);
  status = 'passed';
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
} finally {
  await browser?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const sourceAfter = await Promise.all(
    [...sources].map(async ([file, hash]) => ({
      file,
      beforeSHA: hash,
      afterSHA: sha(await readFile(file)),
    })),
  );
  const sourceChanged = sourceAfter.filter((file) => file.beforeSHA !== file.afterSHA);
  if (sourceChanged.length) {
    status = 'failed';
    failure = (failure ?? '') + '\nSource changed during boundary test';
  }
  await writeFile(path.join(output, 'source-after.json'), JSON.stringify(sourceAfter, null, 2));
  await writeFile(
    path.join(output, 'report.json'),
    JSON.stringify(
      {
        status,
        failure,
        boundary:
          'actual React component and store; authored renderer/access stubs; not photo/AI/render quality',
        checks,
        pageErrors,
        blocked,
        sourceChanged,
        elapsedMs: performance.now() - started,
        realWebGLContexts: 0,
        aiCalls: 0,
        databaseWrites: 0,
        browserClosed: true,
        serverClosed: true,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      status,
      output,
      failure,
      checks: Object.keys(checks),
      elapsedMs: performance.now() - started,
    }),
  );
}
if (status !== 'passed') process.exitCode = 1;
