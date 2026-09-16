/** Actual reconstruction/Three output from frozen real observations. No new AI or manual placement. */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const root = resolve('test-results/reconstruction-floor-geometry-20260913');
const inputs = resolve('test-results/user-reconstruction-improvement-20260913/inputs');
const ids = ['user-01', 'user-02', 'user-03', 'user-04'];
const bundle = await build({
  stdin: {
    contents: `export {createReconstructionProject} from './src/lib/reconstruction'; export {PhotoCompositor} from './src/lib/render/compositor'; export {canvasBlob} from './src/lib/images';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
});
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/bundle.js')
      return void res.setHeader('Content-Type', 'text/javascript').end(bundle.outputFiles[0].text);
    const match = /^\/(user-0[1-4])\/(photo|report)$/.exec(req.url ?? '');
    if (match)
      return void res
        .setHeader('Content-Type', match[2] === 'photo' ? 'image/jpeg' : 'application/json')
        .end(
          await readFile(
            match[2] === 'photo'
              ? resolve(inputs, match[1] + '.jpg')
              : resolve(root, 'placement', match[1], 'report.json'),
          ),
        );
    res
      .setHeader('Content-Type', 'text/html')
      .end(
        '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><body>Local geometry render probe</body>',
      );
  } catch (error) {
    res.statusCode = 500;
    res.end(String(error));
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
  const page = await browser.newPage();
  const errors: string[] = [],
    external: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', async (route) => {
    if (route.request().url().startsWith(origin) || route.request().url().startsWith('blob:'))
      await route.continue();
    else {
      external.push(route.request().url());
      await route.abort();
    }
  });
  await page.goto(origin);
  const records = [];
  for (const id of ids) {
    const record = await page.evaluate(
      async ({ origin, id }) => {
        const m = await import(origin + '/bundle.js');
        const report = await (await fetch(`/${id}/report`)).json();
        const blob = await (await fetch(`/${id}/photo`)).blob();
        const file = new File([blob], id + '.jpg', { type: 'image/jpeg' });
        const outputs = [];
        let workers = 0;
        const OriginalWorker = window.Worker;
        window.Worker = class extends OriginalWorker {
          constructor(url: string | URL, opts?: WorkerOptions) {
            workers++;
            super(url, opts);
          }
        };
        try {
          for (const mode of ['baseline', 'experiment']) {
            const result = report.comparison[mode];
            const assets = new Map(),
              versions = new Map();
            const fail = async () => {
              throw Error('Unexpected repository operation');
            };
            const repositories = {
              mode: 'local',
              projects: { list: fail, load: fail, save: fail, create: fail, duplicate: fail, remove: fail },
              assets: {
                put: async (a: { id: string }) => assets.set(a.id, a),
                get: async (id: string) => {
                  if (!assets.has(id)) throw Error('Missing asset');
                  return assets.get(id);
                },
                removeUnused: fail,
              },
              materials: {
                create: async (v: object) => {
                  const value = {
                    ...v,
                    id: crypto.randomUUID(),
                    materialId: crypto.randomUUID(),
                    version: 1,
                    createdAt: new Date().toISOString(),
                  };
                  versions.set(value.id, value);
                  return value;
                },
                list: async () => [...versions.values()].map((version) => ({ version })),
                getVersion: async (id: string) => versions.get(id),
                update: fail,
                deactivate: fail,
              },
            };
            const started = performance.now();
            const project = await m.createReconstructionProject(
              file,
              { kind: 'parametric', version: 1, widthMm: 2400, depthMm: 2400, heightMm: 2400 },
              {
                repositories,
                reuseAnalysis: result.pipeline.baselineReview,
                transformAnalysis: async () => ({ review: result.review, plans: result.plans }),
              },
            );
            const before = project.shared.comparison.before;
            const renderer = new m.PhotoCompositor();
            try {
              await renderer.setSnapshot(
                {
                  scene: project.shared.baseline,
                  beforeScene: before,
                  materials: Object.fromEntries(versions),
                },
                (id: string) => repositories.assets.get(id),
              );
              const canvas = renderer.render(1200, 800, 'before');
              const png = await m.canvasBlob(canvas, 'image/png');
              const base64 = await new Promise<string>((done) => {
                const fr = new FileReader();
                fr.onload = () => done(String(fr.result).split(',')[1]);
                fr.readAsDataURL(png);
              });
              outputs.push({
                mode,
                base64,
                fixtureCount: before.fixtures.length,
                afterFixtureCount: project.shared.baseline.fixtures.length,
                totalMs: performance.now() - started,
                fixtures: before.fixtures,
              });
            } finally {
              renderer.dispose();
            }
          }
        } finally {
          window.Worker = OriginalWorker;
        }
        return { id, outputs, workers, browser: navigator.userAgent };
      },
      { origin, id },
    );
    const dir = resolve(root, 'renders', id);
    await mkdir(dir, { recursive: true });
    for (const o of record.outputs) {
      await writeFile(resolve(dir, o.mode + '.png'), Buffer.from(o.base64, 'base64'));
      o.base64 = '';
      assert.equal(o.afterFixtureCount, 0);
    }
    assert.equal(record.workers, 0);
    records.push(record);
    console.log(
      JSON.stringify({
        id,
        results: record.outputs.map(({ mode, fixtureCount, totalMs }) => ({ mode, fixtureCount, totalMs })),
      }),
    );
  }
  await writeFile(
    resolve(root, 'renders', 'verification.json'),
    JSON.stringify(
      {
        records,
        errors,
        external,
        scope:
          'Actual common reconstruction and compositor with frozen model observations; no UI or new inference. Shared blank After verified.',
      },
      null,
      2,
    ),
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  await writeFile(
    resolve(root, 'renders', 'comparison.html'),
    `<!doctype html><html lang="ko"><meta charset="utf-8"><title>기하 후보 비교</title><style>body{font:16px system-ui;background:#eee;margin:24px}.row{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:30px}img{width:100%;height:300px;object-fit:contain;background:white}</style><h1>기하 후보 비교 · 자동 관측 재생</h1><p>기존 Qwen 관측 + 실제 DeepLab·MoGe 결과. 사용자 위치 보정 없음. 원본 촬영과 표준 공간 구도는 다름. 모델 거리와 위치는 실측이 아님.</p>${ids.map((id) => `<h2>${id}</h2><div class="row"><figure><figcaption>원본</figcaption><img src="../../user-reconstruction-improvement-20260913/inputs/${id}.jpg"></figure><figure><figcaption>현재 배치 기준선</figcaption><img src="${id}/baseline.png"></figure><figure><figcaption>기하 후보</figcaption><img src="${id}/experiment.png"></figure></div>`).join('')}</html>`,
  );
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
