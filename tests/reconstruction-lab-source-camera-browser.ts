/** Production UI/WebGL/IndexedDB, synthetic support contract. No model inference or photo claims. */
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
type Modules = typeof import('../src/lib/reconstruction/lab') &
  typeof import('../src/lib/reconstruction/lab-project') &
  typeof import('../src/lib/room-viewer/render-snapshot') &
  typeof import('../src/lib/repositories') &
  typeof import('../src/lib/room-geometry') &
  typeof import('../src/lib/types') &
  typeof import('./fixtures/room-source-inference-boundary') &
  typeof import('react') &
  typeof import('react-dom/client') & {
    RoomViewer: typeof import('../src/components/rooms/room-viewer').default;
  };
const output = 'test-results/reconstruction-fifteen-rebuild/20260915-start/lab-source-camera-contract';
const bundle = await build({
  stdin: {
    contents: `
export {runReconstructionLabCase} from './src/lib/reconstruction/lab';
export {saveLabResultAsProject,readLabProjectReport} from './src/lib/reconstruction/lab-project';
export {renderRoomSnapshotImage} from './src/lib/room-viewer/render-snapshot';
export {default as RoomViewer} from './src/components/rooms/room-viewer';
export {getRepositories} from './src/lib/repositories';
export {DEFAULT_ROOM} from './src/lib/room-geometry';
export {createRoot} from 'react-dom/client';export {createElement} from 'react';
export {boundaryCalls} from './tests/fixtures/room-source-inference-boundary';
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
      name: 'authored-inference-boundaries-only',
      setup(b) {
        b.onResolve(
          { filter: /(?:^|\/)(?:analysis-client|geometry-local-client|segmentation)$/ },
          () => ({ path: resolve('tests/fixtures/room-source-inference-boundary.ts') }),
        );
      },
    },
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
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } }),
    errors: string[] = [],
    requests: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(origin);
  const result = await page.evaluate(async (base) => {
    const m = (await import(base + '/bundle.js')) as Modules,
      repo = m.getRepositories();
    const input = document.createElement('canvas');
    input.width = 480;
    input.height = 640;
    const ctx = input.getContext('2d')!;
    ctx.fillStyle = '#dedbd5';
    ctx.fillRect(0, 0, 480, 640);
    ctx.fillStyle = '#b7b6ac';
    ctx.fillRect(0, 440, 480, 200);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(280, 320, 75, 150);
    const blob = await new Promise<Blob>((r) => input.toBlob((b) => r(b!), 'image/png'));
    const file = new File([blob], 'authored-inference-contract.png', { type: 'image/png' });
    const stages: string[] = [],
      lab = await m.runReconstructionLabCase(
        file,
        { ...m.DEFAULT_ROOM },
        {
          engine: 'candidate',
          candidateProfile: 'local-quality-v1',
          reconstructionPolicy: 'visible-relations',
          onStage: (s) => stages.push(s),
        },
      );
    if (!lab.projectBundle || !lab.report.renderView) throw Error('Lab omitted source camera');
    const check = (condition: unknown, note: string) => {
      if (!condition) throw Error(note);
    };
    check(lab.report.output.renderer === 'room-view', 'render path missing');
    check(lab.report.pipeline?.quality?.placementPolicy === 'visible-relation-estimate', 'wrong policy');
    check(
      JSON.stringify(lab.projectBundle.document.roomView) === JSON.stringify(lab.report.renderView),
      'report/bundle camera mismatch',
    );
    check(lab.projectBundle.document.designs[0].scene.fixtures.length === 0, 'After must be empty');
    check(
      lab.report.fixtures.length === 1,
      'expected authored observation should reach actual model generator',
    );
    const originalReport = JSON.stringify(lab.report),
      originalBundle = structuredClone(lab.projectBundle);
    const saved = await m.saveLabResultAsProject(lab, { name: 'Lab 사진 시점 계약', repositories: repo });
    check(JSON.stringify(lab.report) === originalReport, 'saving changed original report');
    check(
      JSON.stringify(lab.projectBundle.document) === JSON.stringify(originalBundle.document),
      'saving changed original result document',
    );
    const recovered = m.readLabProjectReport(saved)!;
    check(
      JSON.stringify(recovered.renderView) === JSON.stringify(saved.roomView),
      'saved report/camera diverged',
    );
    const materials: Record<string, import('../src/lib/types').MaterialVersion> = {};
    for (const version of lab.projectBundle.versions)
      materials[version.id] = await repo.materials.getVersion(version.id);
    const reader = async (id: string) => {
      const asset = await repo.assets.get(id);
      if (!asset) throw Error('Missing ' + id);
      return asset;
    };
    const snapshot = {
      scene: saved.designs[0].scene,
      beforeScene: saved.shared.comparison!.before,
      materials,
      roomView: saved.roomView,
    };
    const rerender = await m.renderRoomSnapshotImage(snapshot, reader, {
      renderer: 'room-view',
      mode: 'before',
      longEdge: Math.max(lab.report.output.width, lab.report.output.height),
    });
    async function data(b: Blob) {
      const bitmap = await createImageBitmap(b),
        c = document.createElement('canvas');
      c.width = bitmap.width;
      c.height = bitmap.height;
      const context = c.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      return {
        width: c.width,
        height: c.height,
        pixels: context.getImageData(0, 0, c.width, c.height).data,
        png: c.toDataURL('image/png'),
      };
    }
    const a = await data(lab.before),
      b = await data(rerender);
    check(a.width === b.width && a.height === b.height, 'reopen size mismatch');
    let pixelMismatch = 0,
      maxDifference = 0;
    for (let i = 0; i < a.pixels.length; i++) {
      const d = Math.abs(a.pixels[i] - b.pixels[i]);
      if (d) pixelMismatch++;
      maxDifference = Math.max(maxDifference, d);
    }
    check(pixelMismatch === 0, 'Lab/reopened export pixels differ');
    const damaged = structuredClone(lab);
    damaged.projectBundle!.document.roomView!.sourceCamera!.positionMm[0] += 10;
    let rejected = false;
    try {
      await m.saveLabResultAsProject(damaged, { repositories: repo });
    } catch {
      rejected = true;
    }
    check(rejected, 'changed result/camera must be rejected');
    const countBefore = (await repo.projects.list()).length;
    const controller = new AbortController();
    controller.abort();
    let cancelled = false;
    try {
      await m.runReconstructionLabCase(file, m.DEFAULT_ROOM, {
        engine: 'candidate',
        reconstructionPolicy: 'visible-relations',
        signal: controller.signal,
      });
    } catch {
      cancelled = true;
    }
    check(cancelled, 'pre-cancel must reject');
    check((await repo.projects.list()).length === countBefore, 'cancel created project');
    const baseline = await m.runReconstructionLabCase(file, m.DEFAULT_ROOM, { engine: 'baseline' });
    check(
      !baseline.report.renderView &&
        !baseline.projectBundle!.document.roomView &&
        baseline.report.output.renderer === 'legacy-front',
      'legacy baseline camera changed',
    );
    const root = m.createRoot(document.querySelector('main')!);
    root.render(
      m.createElement(m.RoomViewer, {
        project: saved,
        materials,
        assetReader: reader,
        writable: false,
        onView: () => {},
        saveStatus: 'saved',
        saveError: '',
        onSave: () => {},
        onDesign: () => {},
        onClose: () => {},
      }),
    );
    return {
      scope:
        'Authored inference boundaries, real Lab/quality/placement/model/renderer/IndexedDB; NOT real AI accuracy verification',
      report: lab.report,
      baselineReport: baseline.report,
      id: saved.id,
      view: saved.roomView,
      fixtureCount: lab.report.fixtures.length,
      pixelMismatch,
      maxDifference,
      png: a.png,
      reopenedPng: b.png,
      boundaryCalls: [...m.boundaryCalls],
      rejected,
      cancelled,
      stages,
    };
  }, origin);
  await expect(page.getByTestId('room-view-viewport')).toHaveAttribute('aria-busy', 'false', {
    timeout: 30000,
  });
  await expect(page.getByRole('button', { name: '사진 시점 보기', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Before', exact: true }).click();
  await page.screenshot({ path: output + '/saved-project-viewer.png' });
  await writeFile(output + '/lab-before.png', Buffer.from(result.png.split(',')[1], 'base64'));
  await writeFile(output + '/reopened-export.png', Buffer.from(result.reopenedPng.split(',')[1], 'base64'));
  await page.reload();
  const reopened = await page.evaluate(
    async ({ base, id }) => {
      const m = (await import(base + '/bundle.js')) as Modules,
        p = await m.getRepositories().projects.load(id);
      return {
        view: p.roomView,
        reportView: m.readLabProjectReport(p)?.renderView,
        after: p.designs[0].scene.fixtures.length,
        before: p.shared.comparison!.before.fixtures.length,
      };
    },
    { base: origin, id: result.id },
  );
  assert.equal(result.report.algorithm.roomViewerRendererRevision, 'room-view-v3-depth-and-target-viewport');
  assert.equal(result.baselineReport.algorithm.roomViewerRendererRevision, undefined);
  assert.deepEqual(reopened.view, result.view);
  assert.deepEqual(reopened.reportView, result.view);
  assert.equal(reopened.after, 0);
  assert.equal(reopened.before, 1);
  assert.deepEqual(errors, []);
  assert.ok(
    requests.every((url) => url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')),
  );
  const { png, reopenedPng, ...record } = result;
  void png;
  void reopenedPng;
  await writeFile(
    output + '/verification.json',
    JSON.stringify({ ...record, reopened, errors, requests, browser: await browser.version() }, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        pass: true,
        scope: result.scope,
        output,
        pixelMismatch: result.pixelMismatch,
        fixtureCount: result.fixtureCount,
        boundaryCalls: result.boundaryCalls,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}
