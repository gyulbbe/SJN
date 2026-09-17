/** Frozen before/after five-photo observation replay; source engine metadata retained. No new model inference or user correction. */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const phase = process.env.SJN_PLACEMENT_PHASE ?? 'before-run-01';
const output = 'test-results/reconstruction-placement-quality-20260914/' + phase;
assert.match(phase, /^[a-z0-9-]+$/);
async function sourceSnapshot(directory = 'src'): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = directory + '/' + entry.name;
    if (entry.isDirectory()) Object.assign(result, await sourceSnapshot(path));
    else result[path] = sha(await readFile(path));
  }
  return result;
}
const source = 'test-results/reconstruction-product-color-20260914';
const manifest = JSON.parse(await readFile(source + '/manifest.json', 'utf8'));
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
await mkdir(output, { recursive: true });
assert(
  !(await readdir(output)).includes('summary.json'),
  'Completed results are immutable; use a new phase.',
);
const sourceHashes = await sourceSnapshot();
const startedAt = new Date().toISOString();
const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/reconstruction'; export {DEFAULT_ROOM} from './src/lib/room-geometry';export {createLegacyLocalRepositories} from './tests/helpers/legacy-local-repositories';export {PhotoCompositor} from './src/lib/render/compositor';export {reconstructionReviewSchema} from './src/lib/storage/validation';`,
    resolveDir: process.cwd(),
  },
  metafile: true,
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  define: { 'process.env.NEXT_PUBLIC_STORAGE_MODE': '"local"' },
});
assert.deepEqual(await sourceSnapshot(), sourceHashes, 'Source changed during bundle preparation');
const bundledSourceHashes = Object.fromEntries(
  Object.keys(bundle.metafile!.inputs)
    .filter((path) => path.startsWith('src/'))
    .map((path) => [path, sourceHashes[path]]),
);
await writeFile(output + '/frozen-bundle.js', bundle.outputFiles[0].text);
await writeFile(
  output + '/source-manifest.json',
  JSON.stringify(
    { startedAt, phase, sourceHashes: bundledSourceHashes, bundleSha256: sha(bundle.outputFiles[0].text) },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    stage: 'bundle-ready',
    phase,
    output,
    bundledSources: Object.keys(bundledSourceHashes).length,
  }),
);
const server = createServer((req, res) => {
  if (req.url === '/index.js')
    res.setHeader('Content-Type', 'text/javascript').end(bundle.outputFiles[0].text);
  else
    res
      .setHeader('Content-Type', 'text/html;charset=utf-8')
      .end('<html><link rel="icon" href="data:,"><body><main id="result"></main></body></html>');
});
await new Promise<void>((done, reject) => {
  server.once('error', reject);
  server.listen(43191, '127.0.0.1', () => {
    server.off('error', reject);
    done();
  });
});
const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors: string[] = [],
  external: string[] = [];
const results = [];
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const cdp = await page.context().newCDPSession(page);
  let workers = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('worker', () => workers++);
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    external.push(url);
    return route.abort();
  });
  await page.goto(origin);
  for (const item of manifest.cases) {
    const photo = await readFile(item.input.path),
      reportBytes = await readFile(source + '/actual-baseline/' + item.id + '/baseline.json'),
      report = JSON.parse(reportBytes.toString('utf8'));
    assert.equal(sha(photo), item.input.sha256);
    assert.equal(report.inputFingerprint, item.input.sha256);
    const heapBefore = await cdp.send('Runtime.getHeapUsage');
    const result = await page.evaluate(
      async ({ origin, photo, report, id }) => {
        const m = (await import(origin + '/index.js')) as typeof import('../src/lib/reconstruction') &
          typeof import('../src/lib/room-geometry') &
          typeof import('./helpers/legacy-local-repositories') &
          typeof import('../src/lib/render/compositor') &
          typeof import('../src/lib/storage/validation');
        const repositories = m.createLegacyLocalRepositories('strict-placement-' + id);
        const file = new File([Uint8Array.from(atob(photo), (c) => c.charCodeAt(0))], id + '.jpg', {
          type: 'image/jpeg',
        });
        const rawBefore = JSON.stringify(report.rawReview);
        let reused = false;
        let observedRaw = '';
        const start = performance.now();
        const project = await m.createReconstructionProject(file, report.room, {
          repositories,
          reuseAnalysis: report.rawReview,
          onRawReview: (review) => {
            observedRaw = JSON.stringify(review);
          },
          onBaselineAnalysis: (measurement) => {
            reused = measurement.reused;
          },
        });
        const creationMs = performance.now() - start;
        if (JSON.stringify(report.rawReview) !== rawBefore || observedRaw !== rawBefore)
          throw new Error('Original raw observation mutated');
        if (!reused) throw new Error('Analysis was not reused');
        m.reconstructionReviewSchema.parse(project.shared.comparison!.review);
        const beforeSave = JSON.stringify(project.shared.comparison!.review),
          fixtureBefore = JSON.stringify(project.shared.comparison!.before.fixtures);
        const saved = await repositories.projects.create(project);
        const loaded = await repositories.projects.load(saved.id);
        if (JSON.stringify(loaded.shared.comparison!.review) !== beforeSave)
          throw new Error('Review changed after save');
        if (JSON.stringify(loaded.shared.comparison!.before.fixtures) !== fixtureBefore)
          throw new Error('Geometry changed after save');
        const duplicate = await repositories.projects.duplicate(saved.id);
        if (
          duplicate.shared.comparison!.before.fixtures.length !==
          loaded.shared.comparison!.before.fixtures.length
        )
          throw new Error('Duplicate lost geometry');
        const after = loaded.designs.find((d) => d.id === loaded.activeDesignId)!.scene;
        if (after.fixtures.length || after.surfaces.some((s) => s.materialVersionId))
          throw new Error('After must stay empty');
        const materials = Object.fromEntries(
          (await repositories.materials.list()).map(({ version }) => [version.id, version]),
        );
        const compositor = new m.PhotoCompositor();
        const renderStart = performance.now();
        await compositor.setSnapshot(
          { scene: after, beforeScene: loaded.shared.comparison!.before, materials },
          (id) => repositories.assets.get(id),
        );
        const pngs: string[] = [];
        for (const mode of ['before', 'after'] as const) {
          const canvas = compositor.render(1200, 800, mode);
          const copy = document.createElement('canvas');
          copy.width = 1200;
          copy.height = 800;
          copy.getContext('2d')!.drawImage(canvas, 0, 0);
          pngs.push(copy.toDataURL('image/png'));
        }
        compositor.dispose();
        const renderMs = performance.now() - renderStart;
        const entries = loaded.shared.comparison!.review!.candidates.map((candidate) => {
          const old = report.review.candidates.find((c: { id: string }) => c.id === candidate.id);
          const oldFixture = report.fixtures.find((f: { id: string }) => f.id === old?.fixtureId);
          const fixture = loaded.shared.comparison!.before.fixtures.find((f) => f.id === candidate.fixtureId);
          const requested = candidate.placementReview?.requested;
          return {
            id: candidate.id,
            rawObservation: report.rawReview.candidates.find((c: { id: string }) => c.id === candidate.id),
            currentCandidate: candidate,
            kind: candidate.kind,
            oldStatus: old?.status,
            newStatus: candidate.status,
            held: candidate.placementReview?.status === 'held',
            oldPlacement: oldFixture?.roomPlacement,
            oldModel: oldFixture?.reconstruction,
            requested,
            placement: fixture?.roomPlacement,
            model: fixture?.reconstruction,
            review: candidate.placementReview,
            warning: candidate.warning,
          };
        });
        return {
          id,
          creationMs,
          renderMs,
          reused,
          rawUnchanged: true,
          saveReloadUnchanged: true,
          duplicatePreserved: true,
          afterEmpty: true,
          oldFixtureCount: report.fixtures.length,
          fixtureCount: loaded.shared.comparison!.before.fixtures.length,
          entries,
          originalPlanes: report.rawReview.planes,
          currentReview: loaded.shared.comparison!.review,
          originalRawCandidates: report.rawReview.candidates,
          rawSegmentationCandidates: report.rawSegmentationCandidates,
          project: loaded,
          pngs,
        };
      },
      { origin, photo: photo.toString('base64'), report, id: item.id },
    );
    const heapAfter = await cdp.send('Runtime.getHeapUsage');
    const directory = output + '/' + item.id;
    await mkdir(directory, { recursive: true });
    await writeFile(directory + '/original.jpg', photo);
    await writeFile(directory + '/original-report.json', reportBytes);
    for (let i = 0; i < 2; i++)
      await writeFile(
        directory + '/' + (i ? 'after' : 'before') + '.png',
        Buffer.from(result.pngs[i].split(',')[1], 'base64'),
      );
    const compact = {
      ...result,
      pngs: undefined,
      inputSha256: sha(photo),
      rawReportSha256: sha(reportBytes),
      rawObservationSha256: sha(JSON.stringify(report.rawReview)),
      originalEngine: {
        algorithm: report.algorithm,
        engine: report.engine,
        engineMetadata: report.engineMetadata,
      },
      originalAnalysisCache: report.reuse?.baseline?.cacheKey
        ? JSON.parse(report.reuse.baseline.cacheKey)
        : undefined,
      room: report.room,
      heap: {
        before: heapBefore,
        after: heapAfter,
        scope:
          'CDP Runtime.getHeapUsage main page only, before/after snapshots; excludes peak/process/GPU/model/native/WASM; not total user memory',
      },
    };
    await writeFile(directory + '/result.json', JSON.stringify(compact, null, 2));
    results.push(compact);
    console.log(
      JSON.stringify({
        id: item.id,
        old: result.oldFixtureCount,
        current: result.fixtureCount,
        held: result.entries
          .filter((e: { held: boolean }) => e.held)
          .map((e: { kind: string; review: unknown }) => ({ kind: e.kind, review: e.review })),
        creationMs: result.creationMs,
        renderMs: result.renderMs,
      }),
    );
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.equal(workers, 0);
  const summary = {
    scope:
      'Same actual saved DeepLab raw observations (original engine metadata retained) replayed through frozen production bundle. No new inference or user correction. Five inputs are known development regressions, not held-out evaluation. Room dimensions are existing test assumptions, not measurements. Original camera reprojection accuracy not evaluable.',
    phase,
    startedAt,
    completedAt: new Date().toISOString(),
    bundledSourceHashes,
    bundleSha256: sha(bundle.outputFiles[0].text),
    sourceHashesAtCompletion: await sourceSnapshot(),
    memoryScope:
      'Main page CDP JavaScript heap before/after snapshots only; not process/peak/GPU/model allocation',
    browser: browser.version(),
    gpu: 'ANGLE SwiftShader',
    workers,
    external,
    errors,
    cases: results,
  };
  await writeFile(output + '/summary.json', JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
