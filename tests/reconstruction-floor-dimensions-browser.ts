/** Replay four preserved real baseline observations through before/after production creation. No model execution. */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const output = 'test-results/reconstruction-baseline-floor-size-20260913';
const source = 'test-results/user-reconstruction-improvement-20260913';
const oldSource = await readFile(output + '/index-before.ts', 'utf8');
const currentSource = await readFile('src/lib/reconstruction/index.ts', 'utf8');
const bundles: Record<string, string> = {};
for (const phase of ['before', 'after']) {
  const result = await build({
    stdin: {
      contents:
        "export * from './src/lib/reconstruction';export {createLegacyLocalRepositories} from './tests/helpers/legacy-local-repositories';export {PhotoCompositor} from './src/lib/render/compositor';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    define: { 'process.env.NEXT_PUBLIC_STORAGE_MODE': '"local"' },
    plugins:
      phase === 'before'
        ? [
            {
              name: 'preserved-estimator-before',
              setup(b) {
                b.onLoad({ filter: /[\\/]reconstruction[\\/]index\.ts$/ }, () => ({
                  contents: oldSource,
                  loader: 'ts',
                }));
              },
            },
          ]
        : [],
  });
  bundles[phase] = result.outputFiles[0].text;
}
const server = createServer(async (req, res) => {
  try {
    const p = new URL(req.url!, 'http://localhost').pathname;
    if (p === '/before.js' || p === '/after.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(bundles[p.slice(1, -3)]);
      return;
    }
    const match = /^\/(user-0[1-4])\/(photo|report)$/.exec(p);
    if (match) {
      res.setHeader('Content-Type', match[2] === 'photo' ? 'image/jpeg' : 'application/json');
      res.end(
        await readFile(
          match[2] === 'photo'
            ? `${source}/inputs/${match[1]}.jpg`
            : `${source}/after-installation-shape-final/${match[1]}/baseline.json`,
        ),
      );
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<html><link rel="icon" href="data:,"><body>Preserved real baseline observation replay; no AI</body></html>',
    );
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e));
  }
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader'],
});
try {
  await mkdir(output, { recursive: true });
  const page = await browser.newPage(),
    errors: string[] = [],
    requests: { url: string; method: string }[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => requests.push({ url: r.url(), method: r.method() }));
  await page.addInitScript(() => {
    window.Worker = new Proxy(window.Worker, {
      construct() {
        throw Error('New AI forbidden in baseline replay');
      },
    });
  });
  await page.goto(origin);
  const results = [];
  for (const id of ['user-01', 'user-02', 'user-03', 'user-04']) {
    const result = await page.evaluate(
      async ({ origin, id }) => {
        type API = typeof import('../src/lib/reconstruction') &
          typeof import('./helpers/legacy-local-repositories') &
          typeof import('../src/lib/render/compositor');
        const api = (await import(origin + '/after.js')) as API;
        const report = await (await fetch('/' + id + '/report')).json(),
          photo = await (await fetch('/' + id + '/photo')).blob();
        const file = new File([photo], id + '.jpg', { type: 'image/jpeg' }),
          raw = report.rawReview ?? report.review,
          rawString = JSON.stringify(raw);
        const repos = api.createLegacyLocalRepositories('floor-size-' + id),
          runs = [];
        let immutable: string | undefined,
          oldProjectId: string | undefined,
          oldVersions: string | undefined,
          versions: Awaited<ReturnType<typeof repos.materials.list>> = [];
        for (const phase of ['before', 'after']) {
          const m = (await import(origin + '/' + phase + '.js')) as API,
            started = performance.now(),
            stages: string[] = [];
          const project = await m.createReconstructionProject(file, report.room, {
            repositories: repos,
            reuseAnalysis: raw,
            onStage: (s) => stages.push(s),
          });
          const scene = project.shared.comparison!.before;
          const mats = Object.fromEntries(
            (await repos.materials.list()).map((row) => [row.version.id, row.version]),
          );
          const renderer = new m.PhotoCompositor();
          try {
            await renderer.setSnapshot({ scene, materials: mats }, (assetId) => repos.assets.get(assetId));
            renderer.render(1200, 800, 'after');
            runs.push({
              phase,
              creationAndRenderMs: performance.now() - started,
              png: renderer.canvas.toDataURL('image/png'),
              project,
              stages,
            });
          } finally {
            renderer.dispose();
          }
          if (phase === 'before') {
            const saved = await repos.projects.create(project);
            oldProjectId = saved.id;
            immutable = JSON.stringify(saved);
            versions = await repos.materials.list();
            oldVersions = JSON.stringify(versions);
          }
        }
        const preservedProject = JSON.stringify(await repos.projects.load(oldProjectId!)) === immutable;
        const preservedVersions =
          JSON.stringify(
            await Promise.all(
              versions.map(async (row) => ({
                ...row,
                version: await repos.materials.getVersion(row.version.id),
              })),
            ),
          ) === oldVersions;
        return {
          id,
          sourceRunId: report.runId,
          sourceRevision: report.engineMetadata.revision,
          runs,
          rawUnchanged: JSON.stringify(raw) === rawString,
          preservedProject,
          preservedVersions,
        };
      },
      { origin, id },
    );
    assert(result.rawUnchanged && result.preservedProject && result.preservedVersions);
    const before = result.runs[0].project.shared.comparison!,
      after = result.runs[1].project.shared.comparison!;
    assert.deepEqual(
      before.review!.candidates.map((c) => [c.id, c.status, c.requiresReview]),
      after.review!.candidates.map((c) => [c.id, c.status, c.requiresReview]),
    );
    assert.deepEqual(
      before.before.surfaces.map((s) => [s.kind, s.roomFace, s.color]),
      after.before.surfaces.map((s) => [s.kind, s.roomFace, s.color]),
    );
    assert.equal(before.before.fixtures.length, after.before.fixtures.length);
    const mapping = (scene: typeof before) =>
      scene
        .review!.candidates.filter((c) => c.fixtureId)
        .map((c) => ({
          candidateId: c.id,
          fixture: scene.before.fixtures.find((f) => f.id === c.fixtureId)!,
        }));
    const old = mapping(before),
      updated = mapping(after);
    for (let n = 0; n < old.length; n++) {
      assert.equal(old[n].candidateId, updated[n].candidateId);
      assert.equal(old[n].fixture.reconstruction!.color, updated[n].fixture.reconstruction!.color);
      for (const key of ['basinShape', 'basinVariant', 'bowlCount', 'toiletLidState', 'orientation'] as const)
        assert.deepEqual(old[n].fixture.reconstruction![key], updated[n].fixture.reconstruction![key]);
    }
    await mkdir(output + '/' + id, { recursive: true });
    for (const run of result.runs) {
      await writeFile(
        output + '/' + id + '/' + run.phase + '.png',
        Buffer.from(run.png.split(',')[1], 'base64'),
      );
      await writeFile(
        output + '/' + id + '/' + run.phase + '.json',
        JSON.stringify({ ...run, png: undefined }, null, 2),
      );
    }
    const summary = {
      ...result,
      runs: result.runs.map((r) => ({ phase: r.phase, creationAndRenderMs: r.creationAndRenderMs })),
      fixtures: updated.map((item, n) => ({
        candidateId: item.candidateId,
        before: old[n].fixture.reconstruction,
        after: item.fixture.reconstruction,
        beforePlacement: old[n].fixture.roomPlacement,
        afterPlacement: item.fixture.roomPlacement,
      })),
      held: after
        .review!.candidates.filter((c) => !c.fixtureId)
        .map((c) => ({ id: c.id, kind: c.kind, requiresReview: c.requiresReview, trace: c.trace })),
    };
    results.push(summary);
    console.log(
      JSON.stringify({ id, placed: after.before.fixtures.length, rawUnchanged: result.rawUnchanged }),
    );
  }
  assert.deepEqual(errors, []);
  assert(
    requests.every(
      (r) =>
        r.method === 'GET' && (r.url.startsWith(origin + '/') || r.url.startsWith('blob:' + origin + '/')),
    ),
  );
  await writeFile(
    output + '/verification.json',
    JSON.stringify(
      {
        scope:
          'Same saved real baseline rawReview; preserved estimator before and current estimator after; no new analysis; production create, current common renderer and private IDB roundtrip',
        sourceIndexBeforeSha256: createHash('sha256').update(oldSource).digest('hex'),
        sourceIndexAfterSha256: createHash('sha256').update(currentSource).digest('hex'),
        results,
        errors,
        requests,
        newModelCalls: 0,
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS: four unchanged actual observations, before/after PNG, legacy project/material preservation',
  );
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
