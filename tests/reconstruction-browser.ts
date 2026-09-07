/** Real local model + procedural templates + both-scene compositor. No inference mocks. */
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';

const output = 'test-results/reconstruction-engine';
const entry = await build({
  stdin: {
    contents: `export * from './src/lib/reconstruction';export { DEFAULT_ROOM } from './src/lib/room-geometry';export { createLocalRepositories } from './src/lib/repositories/local';export { PhotoCompositor } from './src/lib/render/compositor';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  define: { 'process.env.NEXT_PUBLIC_STORAGE_MODE': '"local"' },
});
const worker = await build({
  entryPoints: ['src/lib/segmentation/worker.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
});
const root = resolve('public');
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url!, 'http://localhost').pathname;
    if (path === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(
        '<html lang="ko"><head><link rel="icon" href="data:,"></head><body style="margin:0;background:#f4f3ef;font:16px sans-serif"><h1>사진으로 재구성한 Before / 동일한 빈 After</h1><main id="result" style="display:flex;flex-wrap:wrap;gap:8px"></main></body></html>',
      );
      return;
    }
    if (path === '/index.js' || path === '/worker.ts') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end((path === '/index.js' ? entry : worker).outputFiles[0].text);
      return;
    }
    const file = resolve(root, '.' + path);
    if (!file.startsWith(root + '\\')) {
      response.writeHead(403).end();
      return;
    }
    response.setHeader(
      'Content-Type',
      extname(file) === '.wasm'
        ? 'application/wasm'
        : extname(file) === '.json'
          ? 'application/json'
          : 'application/octet-stream',
    );
    response.end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
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
  const page = await browser.newPage({ viewport: { width: 1600, height: 1150 } });
  const errors: string[] = [],
    requests: { url: string; method: string }[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => requests.push({ url: r.url(), method: r.method() }));
  await page.goto(origin);
  const result = await page.evaluate(async (base) => {
    const m = (await import(base + '/index.js')) as typeof import('../src/lib/reconstruction') &
      typeof import('../src/lib/room-geometry') &
      typeof import('../src/lib/repositories/local') &
      typeof import('../src/lib/render/compositor');
    const repos = m.createLocalRepositories('reconstruction-engine-test');
    const blob = await (await fetch('/examples/bathroom.png')).blob();
    const file = new File([blob], '욕실 원본.png', { type: 'image/png' });
    const stages: string[] = [],
      start = performance.now();
    const project = await m.createReconstructionProject(file, m.DEFAULT_ROOM, {
      repositories: repos,
      onStage: (stage) => stages.push(stage),
    });
    const elapsed = performance.now() - start;
    const emptyBeforeCreate = await repos.projects.list();
    const saved = await repos.projects.create(project),
      loaded = await repos.projects.load(saved.id);
    const mats = await repos.materials.list();
    const materials = Object.fromEntries(mats.map(({ version }) => [version.id, version]));
    const compositor = new m.PhotoCompositor();
    const snapshot = { scene: ((value) => value.designs.find((item) => item.id === value.activeDesignId)!)(loaded).scene, beforeScene: loaded.shared.comparison!.before, materials };
    await compositor.setSnapshot(snapshot, (id) => repos.assets.get(id));
    const previews: string[] = [];
    for (const mode of ['before', 'after'] as const) {
      const canvas = compositor.render(780, 520, mode);
      const copy = document.createElement('canvas');
      copy.width = 780;
      copy.height = 520;
      copy.getContext('2d')!.drawImage(canvas, 0, 0);
      previews.push(copy.toDataURL());
      document.getElementById('result')!.appendChild(copy);
    }
    const cancellation = new AbortController();
    cancellation.abort();
    let abortName = '';
    try {
      await m.createReconstructionProject(file, m.DEFAULT_ROOM, {
        repositories: repos,
        signal: cancellation.signal,
      });
    } catch (e) {
      abortName = (e as Error).name;
    }
    const allKinds: string[] = [],
      templateSizes: number[] = [];
    const colors: { kind: string; input: string; median: number[]; clipped: number }[] = [];
    async function sampleColor(kind: string, input: string, blob: Blob) {
      const bitmap = await createImageBitmap(blob),
        canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const channels: number[][] = [[], [], []];
      let clipped = 0,
        count = 0;
      for (let i = 0; i < rgba.length; i += 4)
        if (rgba[i + 3] > 250) {
          count++;
          for (let c = 0; c < 3; c++) channels[c].push(rgba[i + c]);
          if (rgba[i] === 255 && rgba[i + 1] === 255 && rgba[i + 2] === 255) clipped++;
        }
      colors.push({
        kind,
        input,
        median: channels.map((c) => c.sort((a, b) => a - b)[Math.floor(c.length / 2)]),
        clipped: clipped / count,
      });
    }
    for (const f of loaded.shared.comparison!.before.fixtures) {
      const mat = await repos.materials.getVersion(f.materialVersionId),
        asset = await repos.assets.get(mat.coverAssetId);
      await sampleColor('photo-' + f.reconstruction!.kind, mat.color, asset.blob);
    }
    for (const kind of ['toilet', 'basin', 'bath', 'mirror', 'door', 'window'] as const) {
      const instance = await m.createReconstructionFixture({
        kind,
        room: m.DEFAULT_ROOM,
        repositories: repos,
      });
      const mat = await repos.materials.getVersion(instance.materialVersionId),
        asset = await repos.assets.get(mat.coverAssetId);
      await sampleColor(kind, mat.color, asset.blob);
      allKinds.push(kind);
      templateSizes.push(asset.size);
      const img = document.createElement('img');
      img.src = URL.createObjectURL(asset.blob);
      img.style.cssText = 'width:220px;height:200px;object-fit:contain;background:#ddd';
      img.alt = kind;
      document.getElementById('result')!.appendChild(img);
      if (mat.pricing) throw new Error('Internal template unexpectedly has pricing');
      if (kind === 'mirror' || kind === 'door' || kind === 'window') {
        if (!instance.projectedQuad) throw new Error('Missing projected wall quad');
      }
    }
    const once = await m.createReconstructionFixture({
      kind: 'mirror',
      room: m.DEFAULT_ROOM,
      repositories: repos,
    });
    const twice = await m.createReconstructionFixture({
      kind: 'mirror',
      room: m.DEFAULT_ROOM,
      repositories: repos,
    });
    const duplicate = await repos.projects.duplicate(saved.id);
    compositor.dispose();
    return {
      elapsed,
      stages,
      candidateKinds: loaded.shared.comparison!.review!.candidates.map((c) => ({
        kind: c.kind,
        status: c.status,
        bounds: c.bounds,
        margin: c.evidence.meanMargin,
      })),
      planes: loaded.shared.comparison!.review!.planes,
      beforeFixtures: loaded.shared.comparison!.before.fixtures.length,
      beforeTiles: loaded.shared.comparison!.before.surfaces.filter((s) => s.materialVersionId).length,
      afterFixtures: ((value) => value.designs.find((item) => item.id === value.activeDesignId)!)(loaded).scene.fixtures.length,
      afterTiles: ((value) => value.designs.find((item) => item.id === value.activeDesignId)!)(loaded).scene.surfaces.filter((s) => s.materialVersionId).length,
      status: loaded.shared.comparison!.status,
      emptyBeforeCreate: emptyBeforeCreate.length,
      abortName,
      allKinds,
      templateSizes,
      colors,
      cacheReused: once.materialVersionId === twice.materialVersionId,
      duplicateBefore: duplicate.shared.comparison!.before.fixtures.length,
      previews,
    };
  }, origin);
  await page.screenshot({ path: `${output}/comparison-and-models.png`, fullPage: true });
  for (let i = 0; i < result.previews.length; i++)
    await writeFile(
      `${output}/${i === 0 ? 'before' : 'after'}.png`,
      Buffer.from(result.previews[i].split(',')[1], 'base64'),
    );
  const compact = {
    ...result,
    previews: undefined,
    errors,
    requests: requests.length,
    externalRequests: requests.filter(
      (r) => !r.url.startsWith(origin) && !r.url.startsWith('blob:' + origin),
    ),
    writes: requests.filter((r) => r.method !== 'GET'),
  };
  await writeFile(`${output}/result.json`, JSON.stringify(compact, null, 2));
  console.log(JSON.stringify(compact, null, 2));
  assert.equal(result.emptyBeforeCreate, 0);
  assert.equal(result.afterFixtures, 0);
  assert.equal(result.afterTiles, 0);
  assert.equal(result.status, 'draft');
  assert.equal(result.abortName, 'AbortError');
  assert.ok(result.beforeTiles > 0);
  assert.ok(result.candidateKinds.length >= 3);
  assert.equal(result.duplicateBefore, result.beforeFixtures);
  assert.ok(result.cacheReused);
  assert.equal(result.allKinds.length, 6);
  assert.ok(result.templateSizes.every((size) => size > 100));
  assert.deepEqual(errors, []);
  assert.equal(compact.externalRequests.length, 0);
  assert.equal(compact.writes.length, 0);
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
}
