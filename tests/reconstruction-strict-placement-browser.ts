/** Saved real five-photo observations, replayed through production generation. No AI or network model. */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const output = process.env.SJN_STRICT_OUTPUT ?? 'test-results/reconstruction-strict-placement-20260914';
const source = 'test-results/reconstruction-product-color-20260914';
const manifest = JSON.parse(await readFile(source + '/manifest.json', 'utf8'));
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    contents: `export * from './src/lib/reconstruction'; export {DEFAULT_ROOM} from './src/lib/room-geometry';export {createLocalRepositories} from './src/lib/repositories/local';export {PhotoCompositor} from './src/lib/render/compositor';export {reconstructionReviewSchema} from './src/lib/supabase/validation';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  define: { 'process.env.NEXT_PUBLIC_STORAGE_MODE': '"local"' },
});
const server = createServer((req, res) => {
  if (req.url === '/index.js')
    res.setHeader('Content-Type', 'text/javascript').end(bundle.outputFiles[0].text);
  else
    res
      .setHeader('Content-Type', 'text/html;charset=utf-8')
      .end('<html><link rel="icon" href="data:,"><body><main id="result"></main></body></html>');
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
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
    const result = await page.evaluate(
      async ({ origin, photo, report, id }) => {
        const m = (await import(origin + '/index.js')) as typeof import('../src/lib/reconstruction') &
          typeof import('../src/lib/room-geometry') &
          typeof import('../src/lib/repositories/local') &
          typeof import('../src/lib/render/compositor') &
          typeof import('../src/lib/supabase/validation');
        const repositories = m.createLocalRepositories('strict-placement-' + id);
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
          pngs,
        };
      },
      { origin, photo: photo.toString('base64'), report, id: item.id },
    );
    const directory = output + '/' + item.id;
    await mkdir(directory, { recursive: true });
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
      'Same saved actual DeepLab raw observations through current production generation. No new inference, manual correction or camera calibration. Historical baseline reports untouched.',
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
